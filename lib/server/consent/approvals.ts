import type {
  ApprovalView,
  ApproveResponse,
  Booking,
  DeclineResponse,
  Policies,
  SendCodeResponse,
  Shop,
} from "../../types/frontdesk";
import { decide, type Decision } from "../engine/lifecycle";
import type { ApprovalRecord, ChallengeRecord } from "../frontdesk/booking-store";
import { FrontDeskError } from "../frontdesk/errors";
import { alertOwner, EVENT_FOR, policiesFor, type FrontDeskDeps } from "../frontdesk/service";
import { toRfc3339 } from "../frontdesk/time";
import {
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  SEND_WINDOW_MS,
  SENDS_PER_LINK_PER_HOUR,
  SENDS_PER_PHONE_PER_HOUR,
} from "./config";
import { isWellFormedToken, last4, newCode, normalizePhone, phoneHmac, sameDigest, sha256Hex } from "./crypto";

// The approval page's use cases, behind /api/approvals/[token]/*: what the person sees, sending them a
// code, and their answer. The token in the link is the only credential (no sign-in, no OAuth), so it
// works whatever MCP client the agent used. Transport-agnostic like service.ts; http.ts adds the
// Origin check and turns results and FrontDeskErrors into responses.
//
// Never logged or echoed in an error: the token, the code, the full phone number.

const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;

/** An approval request with its booking (after lazy expiry) and shop. */
type OpenApproval = { approval: ApprovalRecord; booking: Booking; shop: Shop };

function unknownLink(): FrontDeskError {
  return new FrontDeskError(
    "booking_not_found",
    "This approval link isn't valid.",
    "Check that the whole link was copied. If it still doesn't work, ask your agent to book again.",
  );
}

/**
 * The approval request for `token`, with its booking read after lazy expiry (a lapsed hold becomes
 * expired, with its event). A malformed or unknown token is booking_not_found; a malformed one isn't
 * even looked up.
 */
async function openApproval(deps: FrontDeskDeps, token: string): Promise<OpenApproval> {
  if (!isWellFormedToken(token)) throw unknownLink();
  const approval = await deps.store.findApproval(sha256Hex(token));
  if (!approval) throw unknownLink();
  const booking = await deps.store.refreshBooking(approval.bookingId, deps.clock.now());
  if (!booking) throw unknownLink();
  const shop = await deps.catalog.getShop(booking.shopSlug);
  if (!shop) throw new Error(`Booking ${booking.id} belongs to a shop that doesn't exist: ${booking.shopSlug}.`);
  return { approval, booking, shop };
}

/**
 * decide() the person's answer, or throw why they can't give it: approval_closed (already answered,
 * or the booking was cancelled), approval_expired (the hold lapsed).
 */
function decideAnswer(
  ctx: OpenApproval,
  type: "approve" | "decline",
  now: Date,
  policies: Policies,
): Decision {
  const { approval, booking } = ctx;
  if (approval.decision !== null) {
    throw new FrontDeskError(
      "approval_closed",
      approval.decision === "approved" ? "This booking was already approved." : "This booking was already declined.",
      "Nothing more to do with this link. Ask your agent if you need a new booking.",
      { status: booking.status, decision: approval.decision },
    );
  }
  const decision = decide({ ...booking, approveBy: approval.approveBy }, { type, actor: "customer" }, now, policies);
  if (decision instanceof FrontDeskError) throw decision;
  return decision;
}

/** After answerApproval found the booking no longer pending: why, from a fresh read. */
async function whyNotPending(deps: FrontDeskDeps, token: string, type: "approve" | "decline"): Promise<FrontDeskError> {
  const ctx = await openApproval(deps, token);
  try {
    decideAnswer(ctx, type, deps.clock.now(), await policiesFor(deps, ctx.shop.slug));
  } catch (err) {
    if (err instanceof FrontDeskError) return err;
    throw err;
  }
  return new FrontDeskError(
    "approval_closed",
    "This booking changed while you were answering.",
    "Reload the page to see where it stands.",
    { status: ctx.booking.status },
  );
}

/** The challenge can still be used to approve: unconsumed, unexpired, attempts left. */
function usable(challenge: ChallengeRecord, now: Date): boolean {
  return challenge.consumedAt === null && challenge.expiresAt.getTime() > now.getTime() && challenge.attempts < MAX_CODE_ATTEMPTS;
}

// ---- GET /api/approvals/[token] ----

/** What the approval page shows. See ApprovalView for each status. */
export async function getApprovalView(deps: FrontDeskDeps, token: string): Promise<ApprovalView> {
  const ctx = await openApproval(deps, token);
  const { approval, booking, shop } = ctx;
  const [services, policies, challenge] = await Promise.all([
    deps.catalog.listServices(shop.slug),
    policiesFor(deps, shop.slug),
    deps.store.latestChallenge(booking.id),
  ]);
  const service = services.find((s) => s.id === booking.serviceId);
  if (!service) throw new Error(`Booking ${booking.id} has a service that doesn't exist: ${booking.serviceId}.`);

  const status: ApprovalView["status"] =
    approval.decision ?? (booking.status === "awaiting_approval" ? "pending" : "expired");
  const codeSentTo = status === "pending" && challenge && usable(challenge, deps.clock.now()) ? challenge.phoneLast4 : null;
  return {
    status,
    shop,
    serviceName: booking.serviceName,
    display: booking.display,
    start: booking.start,
    end: booking.end,
    priceCents: service.priceCents,
    depositCents: booking.depositCents,
    policies: {
      cancelWindowHours: policies.cancelWindowHours,
      depositRule: policies.depositRule,
      lateCancelRule: policies.lateCancelRule,
      noShowRule: policies.noShowRule,
    },
    agentName: booking.agent.name,
    customerName: booking.customer.displayName,
    ...(approval.mandate ? { mandate: approval.mandate } : {}),
    expiresAt: toRfc3339(approval.approveBy, shop.timezone),
    ...(codeSentTo ? { codeSentTo } : {}),
  };
}

// ---- POST /api/approvals/[token]/code ----

function bodyFields(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new FrontDeskError("invalid_request", "The request body must be a JSON object.", "Send a JSON object as the request body.", {
      field: "body",
    });
  }
  return body as Record<string, unknown>;
}

/** The body's phone number as E.164. The number is never echoed back in an error. */
export function parseSendCodeBody(body: unknown): string {
  const { phone } = bodyFields(body);
  const e164 = typeof phone === "string" ? normalizePhone(phone) : null;
  if (!e164) {
    throw new FrontDeskError(
      "invalid_request",
      "phone must be a phone number in international format, starting with + and the country code.",
      'Enter the number with its country code, e.g. "+14015550123".',
      { field: "phone" },
    );
  }
  return e164;
}

/** rate_limited for a send limit, with details.retryAfter in whole seconds. */
function rateLimited(limit: "phone" | "booking", retryAfterMs: number): FrontDeskError {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.ceil(retryAfter / 60);
  const wait = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return new FrontDeskError(
    "rate_limited",
    limit === "phone"
      ? "Too many codes were sent to this phone number in the last hour."
      : "Too many codes were requested with this link in the last hour.",
    `Use the last code you received, or try again in ${wait}. If the hold runs out first, ask your agent to book again.`,
    { retryAfter, limit: limit === "phone" ? "phone" : "link" },
  );
}

/**
 * Send the person a 6-digit code (SendCodeRequest → SendCodeResponse), only while the approval is
 * pending. Limits: SENDS_PER_PHONE_PER_HOUR per phone number and SENDS_PER_LINK_PER_HOUR per link
 * (rate_limited). The code's SHA-256 is stored with the phone's HMAC; the code works for
 * CODE_TTL_MINUTES and replaces any earlier one. devCode is included only when deps.consent.devCodes.
 */
export async function sendApprovalCode(deps: FrontDeskDeps, token: string, body: unknown): Promise<SendCodeResponse> {
  const phone = parseSendCodeBody(body);
  const ctx = await openApproval(deps, token);
  const now = deps.clock.now();
  decideAnswer(ctx, "approve", now, await policiesFor(deps, ctx.shop.slug));

  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const created = await deps.store.createChallenge({
    bookingId: ctx.booking.id,
    phoneHmac: phoneHmac(deps.consent.phonePepper, phone),
    phoneLast4: last4(phone),
    codeHash: sha256Hex(code),
    expiresAt,
    now,
    limits: { perPhone: SENDS_PER_PHONE_PER_HOUR, perBooking: SENDS_PER_LINK_PER_HOUR, windowMs: SEND_WINDOW_MS },
  });
  if (!created.ok) throw rateLimited(created.limit, created.retryAfterMs);

  await deps.codeSender.send({ phoneE164: phone, code, shopName: ctx.shop.name, bookingId: ctx.booking.id });
  return {
    sentTo: last4(phone),
    expiresAt: toRfc3339(expiresAt, ctx.shop.timezone),
    ...(deps.consent.devCodes ? { devCode: code } : {}),
  };
}

// ---- POST /api/approvals/[token]/approve ----

/** The body's code: 6 digits (spaces ignored). Malformed isn't an attempt. Never echoed back. */
export function parseApproveBody(body: unknown): string {
  const { code } = bodyFields(body);
  const digits = typeof code === "string" ? code.replace(/\s/g, "") : "";
  if (!/^\d{6}$/.test(digits)) {
    throw new FrontDeskError("invalid_request", "code must be the 6 digits from the text message.", "Enter the 6-digit code you received.", {
      field: "code",
    });
  }
  return digits;
}

function codeInvalid(message: string, nextAction: string, details?: Record<string, unknown>): FrontDeskError {
  return new FrontDeskError("code_invalid", message, nextAction, details);
}

const NEW_CODE = "Request a new code and enter that one.";

/** Why a challenge can't be used (it isn't usable()). */
function unusable(challenge: ChallengeRecord, now: Date): FrontDeskError {
  if (challenge.consumedAt !== null) return codeInvalid("That code was already used.", NEW_CODE);
  if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
    return new FrontDeskError("too_many_attempts", "Too many wrong codes.", NEW_CODE, { maxAttempts: MAX_CODE_ATTEMPTS });
  }
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    return new FrontDeskError("code_expired", `That code has expired: codes work for ${CODE_TTL_MINUTES} minutes.`, NEW_CODE);
  }
  return codeInvalid("That code can't be used.", NEW_CODE);
}

/**
 * Approve with the latest code (ApproveRequest → ApproveResponse): the booking becomes confirmed with a
 * verified customer, and the owner is alerted (once).
 * 1. The approval must be pending (approval_closed, approval_expired).
 * 2. The latest code must be usable: none sent → code_invalid; used → code_invalid; expired →
 *    code_expired; 5 attempts used → too_many_attempts.
 * 3. Count the attempt, then compare the code's SHA-256 with the stored one in constant time. Wrong:
 *    code_invalid with details.attemptsLeft, or too_many_attempts on the 5th wrong try.
 * 4. In one transaction: consume the code, upsert the customer by phone HMAC (display name from the
 *    booking's customer name), link it, confirm the booking and write the "approved" event, only if
 *    the hold is still on. A hold that lapsed meanwhile → approval_expired.
 * TODO(ring-1c): a service with a deposit goes to awaiting_deposit instead (see decide()).
 */
export async function approveBooking(deps: FrontDeskDeps, token: string, body: unknown): Promise<ApproveResponse> {
  const code = parseApproveBody(body);
  const ctx = await openApproval(deps, token);
  const now = deps.clock.now();
  const decision = decideAnswer(ctx, "approve", now, await policiesFor(deps, ctx.shop.slug));
  const { booking } = ctx;

  const challenge = await deps.store.latestChallenge(booking.id);
  if (!challenge) {
    throw codeInvalid("No code has been sent for this booking yet.", "Enter your phone number to get a code first.");
  }
  if (!usable(challenge, now)) throw unusable(challenge, now);

  const attempts = await deps.store.recordCodeAttempt(challenge.id, now, MAX_CODE_ATTEMPTS);
  if (attempts === null) {
    // Used, expired or out of attempts since it was read: say which.
    const fresh = await deps.store.latestChallenge(booking.id);
    throw unusable(fresh && fresh.id === challenge.id ? fresh : { ...challenge, consumedAt: now }, now);
  }
  if (!sameDigest(sha256Hex(code), challenge.codeHash)) {
    const attemptsLeft = MAX_CODE_ATTEMPTS - attempts;
    if (attemptsLeft <= 0) throw unusable({ ...challenge, attempts }, now);
    throw codeInvalid(
      "That code isn't right.",
      `Check the code and try again (${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left), or request a new code.`,
      { attemptsLeft },
    );
  }

  const answered = await deps.store.answerApproval({
    bookingId: booking.id,
    decision: "approved",
    nextStatus: decision.nextStatus,
    now,
    challengeId: challenge.id,
    customer: { phoneHmac: challenge.phoneHmac, phoneLast4: challenge.phoneLast4, displayName: booking.customer.displayName },
    event: {
      actor: "customer",
      type: EVENT_FOR.approve,
      data: {
        from: booking.status,
        to: decision.nextStatus,
        depositEffect: decision.depositEffect,
        depositCollected: false,
        phoneLast4: challenge.phoneLast4,
      },
    },
  });
  if (!answered.ok) {
    throw answered.reason === "code_used"
      ? codeInvalid("That code was already used.", NEW_CODE)
      : await whyNotPending(deps, token, "approve");
  }
  // The owner hears about a booking only once the person approved it, never about a hold.
  await alertOwner(deps.notifier, answered.booking);
  return { booking: answered.booking };
}

// ---- POST /api/approvals/[token]/decline ----

/**
 * Decline (→ DeclineResponse): the booking becomes cancelled (cancelled_by customer), freeing the slot.
 * No code needed: holding the link is enough to say no. Only while pending (approval_closed,
 * approval_expired).
 */
export async function declineBooking(deps: FrontDeskDeps, token: string): Promise<DeclineResponse> {
  const ctx = await openApproval(deps, token);
  const now = deps.clock.now();
  const decision = decideAnswer(ctx, "decline", now, await policiesFor(deps, ctx.shop.slug));
  const answered = await deps.store.answerApproval({
    bookingId: ctx.booking.id,
    decision: "declined",
    nextStatus: decision.nextStatus,
    now,
    event: {
      actor: "customer",
      type: EVENT_FOR.decline,
      data: { from: ctx.booking.status, to: decision.nextStatus, depositEffect: decision.depositEffect, depositCollected: false },
    },
  });
  if (!answered.ok) throw await whyNotPending(deps, token, "decline");
  return { booking: answered.booking };
}
