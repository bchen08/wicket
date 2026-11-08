import { DateTime } from "luxon";
import type {
  AgentPolicies,
  AvailabilityDay,
  Booking,
  BookingPageResponse,
  FrontDeskDiscovery,
  Service,
  Shop,
  Slot,
  WebAvailabilityResponse,
  WebBookResponse,
} from "../../types/frontdesk";
import { MAX_LIMIT, MAX_WINDOW_DAYS } from "../engine/availability";
import { APPROVAL_HOLD_MINUTES } from "../engine/lifecycle";
import { FrontDeskError } from "./errors";
import { DEFAULT_SHOP_SLUG, formatUsd, policiesText } from "./mcp";
import {
  book,
  getAvailability,
  getPolicies,
  listServices,
  minutesInWords,
  parseBookArgs,
  pluralize,
  type BookOutcome,
  type FrontDeskDeps,
} from "./service";
import { toRfc3339 } from "./time";

// The web booking API's use cases: plain HTTP booking for agents without MCP, and the data behind the
// web booking page. They call the same service-layer functions as the MCP tools (getAvailability, book),
// so the rules, errors and approval link are the same. web-http.ts turns them into responses.
// See docs/web-booking.md.

/** Days the availability route returns when `days` is left out, and the booking page shows. */
export const DEFAULT_DAYS = 7;

/** The paths of the shop's web API, relative to the origin. */
export function webPaths(shopSlug: string) {
  const base = `/api/shops/${encodeURIComponent(shopSlug)}`;
  return {
    base,
    services: `${base}/services`,
    availability: `${base}/availability`,
    book: `${base}/book`,
    bookingPage: `${base}/booking-page`,
    agentsMd: `${base}/agents.md`,
  };
}

// ---- Errors in the web API's words ----

/** MCP argument names → the web API's field names. */
const WEB_FIELD: Record<string, string> = { service_id: "service", customer_name: "name", customer_phone: "phone" };

/**
 * A service-layer error as a web caller should read it: the same code and details, but field names and
 * MCP tool names in the message and next_action replaced with the web API's (service, name, and the
 * GET routes), and details.field renamed. Anything that isn't a FrontDeskError passes through.
 */
export function forWeb(err: unknown, shopSlug: string): unknown {
  if (!(err instanceof FrontDeskError)) return err;
  const paths = webPaths(shopSlug);
  const words = (text: string) =>
    text
      .replace(/get_availability from details\.earliest/g, `GET ${paths.availability} with from set to the date of details.earliest`)
      .replace(/\bget_availability\b/g, `GET ${paths.availability}`)
      .replace(/\blist_services\b/g, `GET ${paths.services}`)
      .replace(/\bservice_id\b/g, "service")
      .replace(/\bcustomer_name\b/g, "name")
      .replace(/\bcustomer_phone\b/g, "phone");
  const field = err.details?.field;
  const details =
    typeof field === "string" && Object.hasOwn(WEB_FIELD, field) ? { ...err.details, field: WEB_FIELD[field] } : err.details;
  return new FrontDeskError(err.code, words(err.message), words(err.nextAction), details);
}

function invalidField(field: string, message: string, nextAction: string, value: unknown): FrontDeskError {
  return new FrontDeskError("invalid_request", message, nextAction, { field, value: value ?? null });
}

// ---- Availability ----

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS = /^\d{1,2}$/;

/** The availability route's query, as strings (null when absent). */
export type WebAvailabilityQuery = { service: string | null; from: string | null; days: string | null };

/** Check the query before anything is read: service is required, from is a date, days is 1–14. */
function parseAvailabilityQuery(query: WebAvailabilityQuery, shopSlug: string) {
  const service = query.service?.trim() ?? "";
  if (service === "") {
    throw invalidField(
      "service",
      "service is required: the id of the service to look up.",
      `Add ?service=<id> to the URL, e.g. ?service=haircut. GET ${webPaths(shopSlug).services} lists the ids.`,
      query.service,
    );
  }
  const from = query.from?.trim() || null;
  if (from !== null) {
    const day = DateTime.fromISO(from, { zone: "utc" });
    if (!DATE.test(from) || !day.isValid || day.year < 2000 || day.year > 2999) {
      throw invalidField(
        "from",
        "from must be a date like 2026-11-14 (YYYY-MM-DD), in the shop's time zone.",
        "Send from as YYYY-MM-DD, e.g. from=2026-11-14, or leave it out for today.",
        query.from,
      );
    }
  }
  const daysText = query.days?.trim() || null;
  const days = daysText === null ? DEFAULT_DAYS : Number(daysText);
  if (daysText !== null && (!DAYS.test(daysText) || days < 1 || days > MAX_WINDOW_DAYS)) {
    throw invalidField(
      "days",
      `days must be a whole number from 1 to ${MAX_WINDOW_DAYS}.`,
      `Send days=1 to days=${MAX_WINDOW_DAYS}, or leave it out for ${DEFAULT_DAYS}.`,
      query.days,
    );
  }
  return { service, from, days };
}

/** Today's date in `timezone`, YYYY-MM-DD. */
export function todayIn(deps: FrontDeskDeps, timezone: string): string {
  return DateTime.fromJSDate(deps.clock.now(), { zone: timezone }).toISODate() as string;
}

/** Most pages slotsBetween reads for one day before giving up (one day holds at most 96 starts per staff member). */
const MAX_PAGES = 100;

/**
 * Every open start for `service` in [from, to): getAvailability (the MCP tool's use case) at its largest
 * limit, paging while it says truncated. A truncated page may stop between two staff members' slots at
 * the same start, so the next page starts at the last start again and that start is taken from it.
 */
async function slotsBetween(
  deps: FrontDeskDeps,
  shop: Shop,
  serviceId: string,
  from: DateTime,
  to: DateTime,
): Promise<Slot[]> {
  const slots: Slot[] = [];
  let cursor = from.toJSDate();
  const end = toRfc3339(to.toJSDate(), shop.timezone);
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await getAvailability(deps, shop.slug, {
      service_id: serviceId,
      from: toRfc3339(cursor, shop.timezone),
      to: end,
      limit: MAX_LIMIT,
    });
    if (!result.truncated || result.slots.length === 0) return [...slots, ...result.slots];
    const lastMs = Date.parse(result.slots[result.slots.length - 1].start);
    const before = result.slots.filter((s) => Date.parse(s.start) < lastMs);
    if (before.length === 0) {
      // Every slot on this page starts at the same time: keep them all and move one minute on.
      slots.push(...result.slots);
      cursor = new Date(lastMs + 60_000);
    } else {
      slots.push(...before);
      cursor = new Date(lastMs);
    }
  }
  throw new Error(`Availability for ${serviceId} from ${from.toISO()} kept going past ${MAX_PAGES} pages.`);
}

/** `days` days of open starts for `service` from `firstDay` (a local date in the shop's zone), one entry per day. */
async function availabilityDays(
  deps: FrontDeskDeps,
  shop: Shop,
  service: Service,
  firstDay: string,
  days: number,
): Promise<AvailabilityDay[]> {
  const start = DateTime.fromISO(firstDay, { zone: shop.timezone }).startOf("day");
  return Promise.all(
    Array.from({ length: days }, async (_, i) => {
      const day = start.plus({ days: i }).startOf("day");
      const next = start.plus({ days: i + 1 }).startOf("day");
      return {
        date: day.toISODate() as string,
        display: day.setLocale("en-US").toFormat("ccc d LLL"),
        slots: await slotsBetween(deps, shop, service.id, day, next),
      };
    }),
  );
}

function unknownService(shop: Shop, serviceId: string, services: Service[]): FrontDeskError {
  return new FrontDeskError(
    "not_found",
    `No service with id "${serviceId}" at ${shop.name}.`,
    "Use one of the ids in details.valid_service_ids as service.",
    { service: serviceId, valid_service_ids: services.map((s) => s.id) },
  );
}

/**
 * GET /api/shops/[shop]/availability: open starts for one service, day by day in the shop's time zone,
 * from `from` (default today) for `days` days (default 7). Each day's slots are exactly what the MCP
 * get_availability tool returns for that day, so the rules (lead time, horizon, pause) are the same.
 */
export async function webAvailability(
  deps: FrontDeskDeps,
  shopSlug: string,
  query: WebAvailabilityQuery,
): Promise<WebAvailabilityResponse> {
  const q = parseAvailabilityQuery(query, shopSlug);
  const [{ shop, services }, { policies }] = await Promise.all([listServices(deps, shopSlug), getPolicies(deps, shopSlug)]);
  const service = services.find((s) => s.id === q.service);
  if (!service) throw unknownService(shop, q.service, services);
  const from = q.from ?? todayIn(deps, shop.timezone);
  const days = await availabilityDays(deps, shop, service, from, q.days);
  const to = DateTime.fromISO(from, { zone: shop.timezone }).plus({ days: q.days }).toISODate() as string;
  return { shop, service, from, to, days, paused: policies.paused, phone: policies.phone?.trim() || null };
}

// ---- Booking ----

/** How much of the User-Agent goes into the agent name when there's no bookedBy. */
const USER_AGENT_CHARS = 60;
/** C0 control characters: no use in a label. */
const CONTROL_CHARACTERS = /[\u0000-\u001F]/g;

/**
 * The booking's agent name: bookedBy when it has text, otherwise "web" plus the first 60 characters of
 * the User-Agent, e.g. "web (curl/8.7.1)", or just "web" without one. book() then removes control
 * characters and cuts it to 80 characters.
 */
export function webAgentName(bookedBy: string | undefined, userAgent: string | null): string {
  if (bookedBy !== undefined && bookedBy.trim() !== "") return bookedBy;
  const ua = (userAgent ?? "").replace(CONTROL_CHARACTERS, "").trim().slice(0, USER_AGENT_CHARS).trim();
  return ua === "" ? "web" : `web (${ua})`;
}

/** The fields of a book request: a JSON object's, or a form's (as strings). */
export type WebBookFields = Record<string, unknown>;

/** What webBook() hands back: the response body, the approval link (where a form post redirects), and book's outcome. */
export type WebBookOutcome = { response: WebBookResponse; approvalUrl: string; outcome: BookOutcome };

/**
 * POST /api/shops/[shop]/book: hold a start until the person approves it, exactly like the MCP book tool
 * (the same function), from web fields: service, start, name, optional bookedBy, mandate and phone (texted
 * the approval link where texting is on). Errors are the same codes, in the web API's words (forWeb).
 */
export async function webBook(
  deps: FrontDeskDeps,
  shopSlug: string,
  fields: WebBookFields,
  userAgent: string | null,
): Promise<WebBookOutcome> {
  const { bookedBy } = fields;
  if (bookedBy !== undefined && bookedBy !== null && typeof bookedBy !== "string") {
    throw invalidField(
      "bookedBy",
      "bookedBy must be a string: your name as the booking agent.",
      "Send bookedBy as text, e.g. \"bookedBy\": \"Maya's assistant\", or leave it out.",
      bookedBy,
    );
  }
  let outcome: BookOutcome;
  try {
    // The web field names, mapped onto book's input; parseBookArgs checks each one like the MCP tool does.
    const input = parseBookArgs({
      service_id: fields.service,
      start: fields.start,
      customer_name: fields.name,
      mandate: fields.mandate,
      customer_phone: fields.phone,
    });
    outcome = await book(deps, shopSlug, input, webAgentName(bookedBy ?? undefined, userAgent));
  } catch (err) {
    throw forWeb(err, shopSlug);
  }
  const approval = outcome.booking.approval;
  if (!approval) throw new Error(`book returned booking ${outcome.booking.id} without an approval link.`);
  return { response: bookResponse(deps, outcome, approval), approvalUrl: approval.url, outcome };
}

function bookResponse(
  deps: FrontDeskDeps,
  { booking, texted, staffName, holdDisplay }: BookOutcome,
  approval: NonNullable<Booking["approval"]>,
): WebBookResponse {
  // The approval link is <origin>/approve/<token>; its API is /api/approvals/<token>.
  const statusUrl = `${deps.baseUrl}/api/approvals/${approval.url.slice(approval.url.lastIndexOf("/") + 1)}`;
  const name = booking.customer.displayName;
  const send = texted
    ? `Front Desk texted ${name} the link to approve or decline at ${booking.customer.phone}, so don't send it again ` +
      `(it's ${approval.url} if they ask). `
    : `Send ${name} this link right away to approve or decline: ${approval.url}. `;
  const next_action =
    `Held ${booking.serviceName} with ${staffName}, ${booking.display}, for ${name}. It is not confirmed yet. ` +
    send +
    `The hold lapses at ${holdDisplay ?? approval.expiresAt}. ` +
    `Then GET ${statusUrl} to see what they did: status pending, awaiting_deposit (approved, deposit not paid yet: ` +
    "send the same link again), approved, declined or expired. " +
    "Don't book this time again while the hold is on.";
  return { booking, statusUrl, texted, next_action };
}

// ---- Booking page ----

/** The shop's rules for the person, one sentence per line. */
export function policiesForPeople(shop: Shop, p: AgentPolicies): string {
  const phone = p.phone?.trim() || null;
  const lines = [
    ...(p.paused ? [`${shop.name} isn't taking bookings right now.${phone ? ` Call ${phone}.` : ""}`] : []),
    `Book at least ${minutesInWords(p.leadTimeMin)} ahead.`,
    `Services without a deposit can be booked up to ${pluralize(p.horizonDays, "day")} ahead; ` +
      `services with a deposit up to ${pluralize(p.depositHorizonDays, "day")} ahead.`,
    `Cancel at least ${pluralize(p.cancelWindowHours, "hour")} before your appointment and the deposit is released; ` +
      "cancel later and the shop keeps it.",
  ];
  for (const [label, text] of [
    ["Deposit", p.depositRule],
    ["Late cancellation", p.lateCancelRule],
    ["No-show", p.noShowRule],
  ] as const) {
    if (text.trim() !== "") lines.push(`${label}: ${text.trim()}`);
  }
  if (phone && !p.paused) lines.push(`Phone: ${phone}.`);
  return lines.join("\n");
}

/** GET /api/shops/[shop]/booking-page: the shop, its rules, and every service with the next 7 days of open starts. */
export async function bookingPage(deps: FrontDeskDeps, shopSlug: string): Promise<BookingPageResponse> {
  const [{ shop, services }, { policies }] = await Promise.all([listServices(deps, shopSlug), getPolicies(deps, shopSlug)]);
  const from = todayIn(deps, shop.timezone);
  const withDays = await Promise.all(
    services.map(async (service) => ({ ...service, days: await availabilityDays(deps, shop, service, from, DEFAULT_DAYS) })),
  );
  return {
    shop,
    services: withDays,
    policies,
    policiesText: policiesForPeople(shop, policies),
    from,
    bookUrl: `${deps.baseUrl}${webPaths(shopSlug).book}`,
  };
}

// ---- Guidance for agents ----

/** GET /.well-known/front-desk.json: where agents find the MCP endpoint, the web API and agents.md. */
export function discovery(origin: string, shopSlug: string = DEFAULT_SHOP_SLUG): FrontDeskDiscovery {
  const paths = webPaths(shopSlug);
  return {
    name: "Front Desk",
    description:
      "Book appointments at small businesses. Use the MCP endpoint if you can; otherwise the web API. " +
      "No booking is final until the person approves it with the link booking returns. agentsMd explains it all.",
    shop: shopSlug,
    mcp: `${origin}/api/mcp`,
    webApi: `${origin}${paths.base}`,
    agentsMd: `${origin}${paths.agentsMd}`,
    endpoints: {
      availability: `${origin}${paths.availability}`,
      book: `${origin}${paths.book}`,
      bookingPage: `${origin}${paths.bookingPage}`,
    },
  };
}

/**
 * GET /api/shops/[shop]/agents.md: how an agent books at this shop, in plain text, with nothing else to
 * read: MCP first, then the web API step by step, the approval link, the errors, and the shop's rules.
 */
export async function agentsMd(deps: FrontDeskDeps, shopSlug: string): Promise<string> {
  const [{ shop, services }, rules] = await Promise.all([listServices(deps, shopSlug), getPolicies(deps, shopSlug)]);
  const origin = deps.baseUrl;
  const paths = webPaths(shopSlug);
  const url = (path: string) => `${origin}${path}`;
  const today = todayIn(deps, shop.timezone);
  const example = services[0]?.id ?? "haircut";
  const phone = rules.policies.phone?.trim() || null;
  const callShop = phone ? `tell the person to call the shop at ${phone}` : "tell the person to contact the shop";
  const serviceLines = services.map((s) => {
    const deposit = s.depositCents > 0 ? `${formatUsd(s.depositCents)} deposit` : "no deposit";
    return `- ${s.name}: service=${s.id}, ${s.durationMin} min, ${formatUsd(s.priceCents)}, ${deposit}`;
  });

  return `# Book an appointment at ${shop.name} (for AI agents)

${shop.name} takes appointments through Front Desk. This page is everything an AI agent needs to book one
for a person. All times are in ${shop.timezone}. Today is ${today} there.

No booking is final until the person approves it. Booking holds the time for ${APPROVAL_HOLD_MINUTES} minutes and
gives you an approval link. Send the person the link; they open it and tap Approve or Decline. If nobody
answers within ${APPROVAL_HOLD_MINUTES} minutes, the hold lapses and the time is free again.

## Option 1: MCP (use it if you can)

MCP endpoint: ${url("/api/mcp")}
Streamable HTTP, stateless, no sign-in. Tools: list_services, get_policies, get_availability, book,
get_booking, cancel. The server's instructions describe the flow.

## Option 2: plain web requests

No sign-in and no API key. Requests and responses are JSON.

### Services

${serviceLines.join("\n")}

### Step 1: find open times

GET ${url(paths.availability)}?service=${example}&from=${today}&days=${DEFAULT_DAYS}

- service: a service id from the list above. Required.
- from: the first day, YYYY-MM-DD in ${shop.timezone}. Optional; today if left out.
- days: how many days, 1 to ${MAX_WINDOW_DAYS}. Optional; ${DEFAULT_DAYS} if left out.

The answer has days, one entry per day, each with date, display (e.g. "Sat 14 Nov") and slots. Each slot
has start (RFC 3339, e.g. 2026-11-14T14:30:00-05:00) and display (e.g. "Sat 14 Nov, 2:30 pm EST"). Offer
the person the display strings; book with the start, copied exactly. A day with no slots is closed, fully
booked, or further ahead than the shop takes bookings. paused: true means the shop isn't taking bookings.

### Step 2: book

Once the person has chosen a time and heard the rules below:

POST ${url(paths.book)}
Content-Type: application/json

{"service": "${example}", "start": "<a slot start from step 1>", "name": "<the person's name>", "bookedBy": "<your name>"}

- service: the service id. Required.
- start: a slot start from step 1 for that service, copied exactly. Required.
- name: the name the booking is under, 1 to 80 characters. Required. Ask the person if you don't know it.
- bookedBy: your name as an agent; the person and the shop see it. Optional.
- phone: the person's mobile number with its country code, e.g. "+14015550123". Optional; only if they gave
  it to you. Where the shop can text, Front Desk texts them the approval link and the answer has
  "texted": true, so you don't send it again.
- mandate: optional, the person's limits, e.g. {"priceCapCents": 5000, "depositCapCents": 1000,
  "window": {"from": "2026-11-14T12:00:00-05:00", "to": "2026-11-14T18:00:00-05:00"}}. Money is in cents.
  The booking is refused if it breaks them.

Success is HTTP 201: {"booking": {...}, "statusUrl": "...", "texted": false, "next_action": "..."}. booking.status is
awaiting_approval, booking.approval.url is the approval link, booking.approval.expiresAt is when the hold
lapses, and booking.id is the booking's id. Follow next_action.

With curl:

curl -s -X POST ${url(paths.book)} -H "Content-Type: application/json" \\
  -d '{"service":"${example}","start":"<a slot start>","name":"Maya","bookedBy":"my-agent"}'

In a browser you can submit a plain HTML form instead: POST the same fields (service, start, name,
bookedBy, phone) as application/x-www-form-urlencoded to ${url(paths.book)}. Success redirects (303) to the
approval page. A refusal redirects back to the page the form was on, with ?error=<code>&message=<text>.

Book once per booking: booking the same time again while the hold is on gets slot_taken.

### Step 3: send the approval link

Send the person booking.approval.url right away (if you posted a form in a browser, it's the page you
landed on), unless the answer says "texted": true: then Front Desk already texted it to them. The page shows the shop, the service, the time, the price, the deposit, the rules, your name
and the name booked under. The person approves, not you: opening the link and tapping Approve is their
consent. If the service has a deposit, approving takes them to a payment page to place it as a hold on
their card (charged only for a no-show or a late cancellation), and the booking is confirmed once it's
paid; otherwise it's confirmed when they approve. They can also decline there.

### Step 4: check what they did

GET statusUrl (${url("/api/approvals/<token>")}, where <token> is the end of the approval link). Its
status is pending (not answered yet), awaiting_deposit (approved, but the deposit isn't paid yet: send
the same link again, its page has the Pay button), approved (the booking is confirmed), declined, or
expired (the hold ran out, or the deposit wasn't paid in time: book again if they still want it).

### Errors

Every error is JSON: {"error": {"code": "...", "message": "...", "next_action": "...", "details": {...}}}.
Tell the person what happened and follow next_action.

- slot_taken (409): someone else holds that time. details.alternatives has up to 3 nearby open starts.
- outside_hours (422): not a bookable start for that service. Use a start from step 1.
- too_soon (422): inside the shop's lead time. details.earliest is the earliest start allowed.
- too_far (422): further ahead than the shop books that service. Starts must be before details.latest.
- paused (409): the shop isn't taking bookings; ${callShop}.
- outside_mandate (422): the service or time breaks the person's limits (details.field says which).
- invalid_request (400): a missing or bad field; details.field names it.
- not_found (404): no such shop or service; details.valid_service_ids lists the services.
- internal (500): our fault. Retry once; if it fails again, tell the person Front Desk is unavailable.

### Cancelling

The web API can't cancel yet. While the hold is on, the person can decline on the approval page. To
cancel any booking, use the MCP cancel tool, or ${callShop}.

## Rules at ${shop.name}

${policiesText(rules)}

## More

- Discovery (JSON): ${url("/.well-known/front-desk.json")}
- Services, rules and the next ${DEFAULT_DAYS} days of open times in one call: GET ${url(paths.bookingPage)}
`;
}
