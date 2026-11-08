import { randomInt } from "node:crypto";
import type { OwnerCodeResponse } from "../../types/texting";
import { maskPhone } from "../notify/texting";
import { ownerCodeText } from "../notify/texts";
import { getFrontDeskDeps } from "./deps";
import { FrontDeskError } from "./errors";
import { errorResponse, isFormPost, NO_STORE } from "./http";
import { policiesFor, requireShop, type FrontDeskDeps } from "./service";

// Owner sign-in by texted code (docs/texting.md). POST /api/owner/code texts a 6-digit code to the shop's
// ownerMobile; POST /api/owner/session { code } trades it for the fd_owner cookie (owner-session.ts), like
// the access code does. Only where texting is on (deps.texter) and the shop has an ownerMobile. The access
// code keeps working everywhere.
// Codes are stored as they are, with no attempt limit (MVP rule; see "Security not built" in docs/texting.md).

/** How long a texted code works. */
export const OWNER_CODE_MINUTES = 10;
const OWNER_CODE_MS = OWNER_CODE_MINUTES * 60_000;

/** The shop the owner signs in to: one shop for now, like the MCP tools (DEFAULT_SHOP_SLUG). TODO(ring-2): per-shop owners. */
export const OWNER_SHOP_SLUG = "harts";

/** Why POST /api/owner/code couldn't send a code: details.reason, and the unlock page's ?error=. */
export type OwnerCodeFailure = "texting_off" | "no_mobile" | "send_failed";

const ACCESS_CODE_INSTEAD = 'Sign in with the shop\'s access code instead: POST /api/owner/session with { "token": "<OWNER_API_TOKEN>" }.';

/** A new code: six random digits, e.g. "042917". */
export function newOwnerCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** RFC 3339 in UTC, without milliseconds: "2026-11-08T10:10:00Z". */
function rfc3339(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function failure(reason: OwnerCodeFailure, code: "invalid_request" | "internal", message: string, nextAction: string): FrontDeskError {
  return new FrontDeskError(code, message, nextAction, { reason });
}

/**
 * Text a new sign-in code to the shop's ownerMobile and store it (valid 10 minutes, once). Refuses with
 * invalid_request when texting is off (details.reason "texting_off") or the shop has no ownerMobile
 * ("no_mobile"), and with internal when the provider refused the text ("send_failed"; the provider's message
 * is logged, not returned, since it can name the number).
 */
export async function sendOwnerCode(deps: FrontDeskDeps, shopSlug: string = OWNER_SHOP_SLUG): Promise<OwnerCodeResponse> {
  const shop = await requireShop(deps, shopSlug);
  if (!deps.texter) {
    throw failure("texting_off", "invalid_request", "Texting isn't set up on this deployment, so Front Desk can't text a code.", ACCESS_CODE_INSTEAD);
  }
  const { ownerMobile } = await policiesFor(deps, shopSlug);
  if (!ownerMobile) {
    throw failure(
      "no_mobile",
      "invalid_request",
      `${shop.name} has no owner mobile number to text a code to.`,
      `Sign in with the shop's access code, then set ownerMobile with PUT /api/shops/${shopSlug}/policies.`,
    );
  }
  const code = newOwnerCode();
  const expiresAt = new Date(deps.clock.now().getTime() + OWNER_CODE_MS);
  // Stored first, so a code that arrives always works.
  await deps.store.saveOwnerCode({ shopSlug, code, sentTo: ownerMobile, expiresAt });
  try {
    await deps.texter.send(ownerMobile, ownerCodeText(code, shop.name));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "owner.code_text_failed",
        shop: shopSlug,
        provider: deps.texter.provider,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw failure(
      "send_failed",
      "internal",
      `The text to ${maskPhone(ownerMobile)} didn't go through.`,
      `Try again in a minute. If it keeps failing, check ownerMobile, or ${ACCESS_CODE_INSTEAD.charAt(0).toLowerCase()}${ACCESS_CODE_INSTEAD.slice(1)}`,
    );
  }
  return { sent: true, sentTo: maskPhone(ownerMobile), expiresAt: rfc3339(expiresAt) };
}

/**
 * Redeem a code the owner typed: true if it's the shop's, unused and not expired (then it's used up). Spaces in
 * it are ignored; anything that isn't six digits is simply wrong (no query).
 */
export async function redeemOwnerCode(deps: FrontDeskDeps, given: string, shopSlug: string = OWNER_SHOP_SLUG): Promise<boolean> {
  const code = given.replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(code)) return false;
  return deps.store.redeemOwnerCode(shopSlug, code, deps.clock.now());
}

/** Options for ownerCodePost. Tests pass these; the route uses the defaults. */
export type OwnerCodeOptions = {
  /** Defaults to getFrontDeskDeps. */
  getDeps?: () => FrontDeskDeps;
};

/** A 303 to `path` on the request's origin. */
function seeOther(request: Request, path: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: new URL(path, request.url).toString() } });
}

/**
 * POST /api/owner/code. No body needed.
 * - JSON (or no content type) → 200 OwnerCodeResponse; 400 invalid_request when texting is off or the shop
 *   has no ownerMobile; 500 internal when the text didn't go through. details.reason says which.
 * - A plain HTML form post (the unlock page's "Text me a code") → 303 /console/unlock?code=sent, or
 *   → /console/unlock?error=<reason> (texting_off, no_mobile, send_failed).
 */
export async function ownerCodePost(request: Request, options: OwnerCodeOptions = {}): Promise<Response> {
  const form = isFormPost(request);
  try {
    const sent = await sendOwnerCode((options.getDeps ?? getFrontDeskDeps)());
    return form ? seeOther(request, "/console/unlock?code=sent") : Response.json(sent, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (!form) return errorResponse(err);
    const reason = err instanceof FrontDeskError && typeof err.details?.reason === "string" ? err.details.reason : "send_failed";
    if (!(err instanceof FrontDeskError)) console.error("[frontdesk/owner-code] internal error", err);
    return seeOther(request, `/console/unlock?error=${reason}`);
  }
}
