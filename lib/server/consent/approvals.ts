import type { ApprovalView, ApproveResponse, Booking, DeclineResponse, Policies, Shop } from "../../types/frontdesk";
import { closeCheckout, openCheckout, syncDeposit, type OpenCheckout } from "../deposits/deposits";
import { decide, needsDeposit, type Decision } from "../engine/lifecycle";
import type { ApprovalRecord, DepositPatch } from "../frontdesk/booking-store";
import { FrontDeskError } from "../frontdesk/errors";
import { alertOwner, EVENT_FOR, policiesFor, withApprovalOrigin, type FrontDeskDeps } from "../frontdesk/service";
import { toRfc3339 } from "../frontdesk/time";
import { isWellFormedToken, normalizePhone } from "./crypto";

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
 * expired, with its event) and, while it's awaiting its deposit, after asking Stripe (syncDeposit: paid →
 * confirmed; unpaid past pay_by → expired). A malformed or unknown token is booking_not_found; a malformed
 * one isn't even looked up.
 */
async function openApproval(deps: FrontDeskDeps, token: string): Promise<OpenApproval> {
  if (!isWellFormedToken(token)) throw unknownLink();
  const approval = await deps.store.findApproval(token);
  if (!approval) throw unknownLink();
  const refreshed = await deps.store.refreshBooking(approval.bookingId, deps.clock.now());
  if (!refreshed) throw unknownLink();
  const booking = await syncDeposit(deps, refreshed);
  const shop = await deps.catalog.getShop(booking.shopSlug);
  if (!shop) throw new Error(`Booking ${booking.id} belongs to a shop that doesn't exist: ${booking.shopSlug}.`);
  return { approval, booking, shop };
}

/**
 * decide() the person's answer, or throw why they can't give it: approval_closed (already answered,
 * or the booking was cancelled), approval_expired (the hold lapsed). `depositRequired` (approve only):
 * the booking waits for its deposit instead of being confirmed.
 */
function decideAnswer(
  ctx: OpenApproval,
  type: "approve" | "decline",
  now: Date,
  policies: Policies,
  depositRequired = false,
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
  const decision = decide(
    { ...booking, approveBy: approval.approveBy, depositRequired },
    { type, actor: "customer" },
    now,
    policies,
  );
  if (decision instanceof FrontDeskError) throw decision;
  return decision;
}

/**
 * ApprovalView.status: pending until the person answers (expired if the hold lapsed or the booking was
 * cancelled first); after approving, awaiting_deposit while the deposit is due, expired if it wasn't paid
 * in time or the booking was cancelled, otherwise approved.
 */
function viewStatus(approval: ApprovalRecord, booking: Booking): ApprovalView["status"] {
  if (approval.decision === "declined") return "declined";
  if (approval.decision === null) return booking.status === "awaiting_approval" ? "pending" : "expired";
  if (booking.status === "awaiting_deposit") return "awaiting_deposit";
  return booking.status === "expired" || booking.status === "cancelled" ? "expired" : "approved";
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

  // Everything but actionFailed: a capture or release Stripe refused is for the owner's list, not this page.
  const { amountCents, state, payUrl, payBy } = booking.deposit;
  const deposit: ApprovalView["deposit"] = { amountCents, state, ...(payUrl ? { payUrl } : {}), ...(payBy ? { payBy } : {}) };
  return {
    status: viewStatus(approval, booking),
    shop,
    serviceName: booking.serviceName,
    display: booking.display,
    start: booking.start,
    end: booking.end,
    priceCents: service.priceCents,
    depositCents: booking.depositCents,
    deposit,
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
 * an empty body or {} approve without a phone (a form post arrives here as { phone } too). A number that
 * isn't E.164 (after removing spaces, dashes, dots and parentheses) is invalid_request; it isn't echoed
 * back. E.164 is also what the bookings.customer_phone column accepts.
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
 * Approve (ApproveRequest → ApproveResponse): opening the link and approving is the consent
 * (customer.approved true; customer.phone when a phone was given). Only while pending: already answered
 * or cancelled → approval_closed; the hold lapsed → approval_expired ("Ask your agent to book again.").
 * - A booking that needs a deposit (needsDeposit), on a deployment that collects them: first a Stripe
 *   Checkout page is opened for the hold (if Stripe fails, nothing is stored and approve fails as internal,
 *   so the person can try again); then the booking becomes awaiting_deposit with the page's URL
 *   (booking.deposit.payUrl) and pay_by = now + 30 minutes. The owner is alerted (booking_confirmed) once
 *   it's paid (lib/server/deposits/deposits.ts).
 * - Otherwise it becomes confirmed, and the owner is alerted once (booking_confirmed), after the commit. A
 *   service with a deposit that isn't collected (deposits off, or the start is beyond the deposit horizon)
 *   shows it as not_collected.
 * In one transaction, only if the hold is still on: the new status with an "approved" event (actor
 * customer), the phone and the deposit columns stored.
 */
export async function approveBooking(deps: FrontDeskDeps, token: string, body?: unknown): Promise<ApproveResponse> {
  const phone = parseApproveBody(body);
  const ctx = await openApproval(deps, token);
  const now = deps.clock.now();
  const policies = await policiesFor(deps, ctx.shop.slug);
  const required = needsDeposit(ctx.booking, now, policies, ctx.shop.timezone);
  const payments = deps.payments;
  const decision = decideAnswer(ctx, "approve", now, policies, required && payments !== null);
  // Open the payment page before storing the answer, so a booking never waits for a deposit nobody can pay.
  const checkout: OpenCheckout | null =
    decision.nextStatus === "awaiting_deposit" && payments
      ? await openCheckout({ ...deps, payments }, { booking: ctx.booking, shop: ctx.shop, token, now })
      : null;
  // A service with a deposit confirmed without collecting it (deposits off, or beyond the deposit horizon): not_collected.
  const deposit: DepositPatch | undefined = checkout
    ? { state: "awaiting_payment", checkoutSessionId: checkout.id, checkoutUrl: checkout.url, payBy: checkout.payBy }
    : ctx.booking.depositCents > 0
      ? { state: "not_collected" }
      : undefined;
  const answered = await deps.store.answerApproval({
    bookingId: ctx.booking.id,
    decision: "approved",
    nextStatus: decision.nextStatus,
    now,
    phone,
    deposit,
    event: {
      actor: "customer",
      type: EVENT_FOR.approve,
      data: {
        from: ctx.booking.status,
        to: decision.nextStatus,
        depositEffect: decision.depositEffect,
        depositCollected: false,
      },
    },
  });
  if (!answered.ok) {
    if (checkout) await closeCheckout(deps, ctx.booking, checkout.id);
    throw await whyNotPending(deps, token, "approve");
  }
  // Committed: the owner hears about it once it's confirmed, never about a hold alone nor one awaiting its
  // deposit. A failed alert is recorded, not thrown.
  if (answered.booking.status === "confirmed") await alertOwner(deps, "booking_confirmed", answered.booking);
  return { booking: withApprovalOrigin(deps, answered.booking) };
}

// ---- POST /api/approvals/[token]/decline ----

/**
 * Decline (→ DeclineResponse): the booking becomes cancelled (cancelled_by customer), freeing the slot, and
 * the owner is alerted (booking_cancelled), after the commit. Only while pending (approval_closed,
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
  await alertOwner(deps, "booking_cancelled", answered.booking, "customer");
  return { booking: answered.booking };
}
