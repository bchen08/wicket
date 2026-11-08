import type { ApprovalView, ApproveResponse, Booking, DeclineResponse, Policies, Shop } from "../../types/frontdesk";
import { decide, type Decision } from "../engine/lifecycle";
import type { ApprovalRecord } from "../frontdesk/booking-store";
import { FrontDeskError } from "../frontdesk/errors";
import { alertOwner, EVENT_FOR, policiesFor, type FrontDeskDeps } from "../frontdesk/service";
import { toRfc3339 } from "../frontdesk/time";
import { isWellFormedToken, last4, normalizePhone, sha256Hex } from "./crypto";

// The approval page's use cases, behind /api/approvals/[token]/*: what the person sees, and their
// answer. The token in the link is the only credential (no sign-in, no OAuth), so it works whatever
// MCP client the agent used: opening the link and tapping Approve is the consent.
// TODO(ring-1c): a code texted to the person's phone comes back once real texting ships.
// Transport-agnostic like service.ts; http.ts turns results and FrontDeskErrors into responses.
//
// The token is never logged or echoed in an error.

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
function decideAnswer(ctx: OpenApproval, type: "approve" | "decline", now: Date, policies: Policies): Decision {
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

// ---- GET /api/approvals/[token] ----

/** What the approval page shows. See ApprovalView for each status. */
export async function getApprovalView(deps: FrontDeskDeps, token: string): Promise<ApprovalView> {
  const { approval, booking, shop } = await openApproval(deps, token);
  const [services, policies] = await Promise.all([deps.catalog.listServices(shop.slug), policiesFor(deps, shop.slug)]);
  const service = services.find((s) => s.id === booking.serviceId);
  if (!service) throw new Error(`Booking ${booking.id} has a service that doesn't exist: ${booking.serviceId}.`);

  const status: ApprovalView["status"] =
    approval.decision ?? (booking.status === "awaiting_approval" ? "pending" : "expired");
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
  };
}

// ---- POST /api/approvals/[token]/approve ----

/**
 * The approve body's phone number as E.164, or null when there is none. The body is optional: none,
 * an empty body or {} approve without a phone. A number that isn't E.164 (after removing spaces,
 * dashes, dots and parentheses) is invalid_request; it isn't echoed back.
 */
export function parseApproveBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new FrontDeskError("invalid_request", "The request body must be a JSON object.", "Send {} or { \"phone\": \"+14015550123\" }.", {
      field: "body",
    });
  }
  const { phone } = body as Record<string, unknown>;
  if (phone === undefined || phone === null || phone === "") return null;
  const e164 = typeof phone === "string" ? normalizePhone(phone) : null;
  if (!e164) {
    throw new FrontDeskError(
      "invalid_request",
      "phone must be a phone number in international format, starting with + and the country code.",
      'Enter the number with its country code, e.g. "+14015550123", or leave it out.',
      { field: "phone" },
    );
  }
  return e164;
}

/**
 * Approve (ApproveRequest → ApproveResponse): opening the link and approving is the consent. The
 * booking becomes confirmed (customer.verified true; phoneLast4 when a phone was given), and the owner
 * is alerted (once). Only while pending: already answered or cancelled → approval_closed; the hold
 * lapsed → approval_expired ("Ask your agent to book again."). In one transaction, only if the hold is
 * still on: the booking is confirmed with an "approved" event (actor customer) and the phone stored.
 * TODO(ring-1c): a service with a deposit goes to awaiting_deposit instead (see decide()).
 */
export async function approveBooking(deps: FrontDeskDeps, token: string, body?: unknown): Promise<ApproveResponse> {
  const phone = parseApproveBody(body);
  const ctx = await openApproval(deps, token);
  const now = deps.clock.now();
  const decision = decideAnswer(ctx, "approve", now, await policiesFor(deps, ctx.shop.slug));
  const answered = await deps.store.answerApproval({
    bookingId: ctx.booking.id,
    decision: "approved",
    nextStatus: decision.nextStatus,
    now,
    phone,
    event: {
      actor: "customer",
      type: EVENT_FOR.approve,
      data: {
        from: ctx.booking.status,
        to: decision.nextStatus,
        depositEffect: decision.depositEffect,
        depositCollected: false,
        ...(phone ? { phoneLast4: last4(phone) } : {}),
      },
    },
  });
  if (!answered.ok) throw await whyNotPending(deps, token, "approve");
  // The owner hears about a booking only once the person approved it, never about a hold.
  await alertOwner(deps.notifier, answered.booking);
  return { booking: answered.booking };
}

// ---- POST /api/approvals/[token]/decline ----

/**
 * Decline (→ DeclineResponse): the booking becomes cancelled (cancelled_by customer), freeing the slot.
 * Only while pending (approval_closed, approval_expired).
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
