import { z } from "zod";
import type {
  BlockResponse,
  BlocksResponse,
  BookingDetailResponse,
  CreateBlockRequest,
  CreateServiceRequest,
  HoursResponse,
  OwnerBookingActionResponse,
  Policies,
  PoliciesResponse,
  ServiceResponse,
  Shop,
  StaffWeeklyHours,
  UpdateHoursRequest,
  UpdateServiceRequest,
  WeeklyHours,
} from "../../types/frontdesk";
import type { ManageAction } from "../engine/lifecycle";
import { DepositExceedsPriceError, DuplicateServiceError } from "./catalog";
import { FrontDeskError } from "./errors";
import { POLICY_LIMITS } from "./policies";
import { NUL, policiesFor, requireBooking, requireShop, transitionBooking, type FrontDeskDeps } from "./service";
import { parseRfc3339 } from "./time";

// Owner use cases behind the /api/shops/[shop]/* owner routes (policies, hours, blocks, services,
// booking actions). Transport-agnostic like service.ts: http.ts checks the owner token and turns
// results and FrontDeskErrors into responses.
//
// Every request body is validated with zod (strict: unknown fields are rejected). A failure becomes
// invalid_request with the first problem as the message and details { field, issues }, where field
// is the dot path of the first problem ("body" for the body as a whole).

// ---- Validation ----

/** One validation problem, as details.issues lists it. */
export type ValidationIssue = { path: string; message: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A dot path ("weekly.0.open"), or "body" for the body itself. */
function dotPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "body" : path.map(String).join(".");
}

function describeIssue(issue: z.core.$ZodIssue): ValidationIssue {
  if (issue.code === "unrecognized_keys") {
    const paths = issue.keys.map((key) => dotPath([...issue.path, key]));
    const message =
      paths.length === 1
        ? `Unknown field "${paths[0]}".`
        : `Unknown fields: ${paths.map((p) => `"${p}"`).join(", ")}.`;
    return { path: paths[0], message };
  }
  return { path: dotPath(issue.path), message: issue.message };
}

/** invalid_request for one field, with the same details shape as a schema failure. */
function invalidField(field: string, message: string, nextAction: string): FrontDeskError {
  return new FrontDeskError("invalid_request", message, nextAction, {
    field,
    issues: [{ path: field, message }],
  });
}

/** `body` checked against `schema`, or invalid_request for the first problem. */
function parseBody<S extends z.ZodType>(schema: S, body: unknown, nextAction: string): z.output<S> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalidField("body", "The request body must be a JSON object.", nextAction);
  }
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issues = result.error.issues.map(describeIssue);
  throw new FrontDeskError("invalid_request", issues[0].message, nextAction, { field: issues[0].path, issues });
}

/** `patch` without its undefined fields, so spreading it never overwrites a value with undefined. */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const atLeastOneField = (body: object) => Object.keys(defined(body)).length > 0;

/** For .refine on every string that is stored or queried: Postgres text can't hold U+0000 (SQLSTATE 22021). */
const hasNoNul = (value: string) => !value.includes(NUL);
function noNul(field: string) {
  return { error: `${field} can't contain the NUL character (U+0000).`, abort: true };
}

/** A whole number in [min, max], with one message for every way it can be wrong. */
function wholeNumber(field: string, min: number, max: number, unit: string) {
  const message = `${field} must be a whole number of ${unit} from ${min} to ${max}.`;
  return z.int({ error: message }).min(min, { error: message }).max(max, { error: message });
}

/** A string that is 1–max characters after trimming. Returned trimmed. */
function requiredText(field: string, max: number) {
  const message = `${field} must be text of 1–${max} characters.`;
  return z
    .string({ error: message })
    .trim()
    .min(1, { error: message })
    .max(max, { error: message })
    .refine(hasNoNul, noNul(field));
}

const staffIdSchema = z
  .string({ error: 'staffId must be the id of one of the shop\'s staff members, e.g. "dana".' })
  .min(1, { error: 'staffId must be the id of one of the shop\'s staff members, e.g. "dana".' })
  .refine(hasNoNul, noNul("staffId"));

/**
 * The instants the owner API accepts (inclusive). Anything outside is surely a typo, and years like
 * 0001 or 9999 would be out of the database's reach once a range is built around them.
 */
export const INSTANT_LIMITS = { earliest: "2000-01-01T00:00:00Z", latest: "2999-12-31T23:59:59Z" } as const;

const EARLIEST_MS = Date.parse(INSTANT_LIMITS.earliest);
const LATEST_MS = Date.parse(INSTANT_LIMITS.latest);

function inInstantRange(instant: Date): boolean {
  return instant.getTime() >= EARLIEST_MS && instant.getTime() <= LATEST_MS;
}

function instantRangeMessage(field: string): string {
  return `${field} must be between ${INSTANT_LIMITS.earliest} and ${INSTANT_LIMITS.latest}.`;
}

/**
 * An RFC 3339 instant with an offset, from 2000 to 2999 (INSTANT_LIMITS), kept as the string.
 * Aborts, so the object's cross-field checks are skipped.
 */
function instant(field: string) {
  const message = `${field} must be an RFC 3339 date-time with an offset, e.g. "2026-12-24T00:00:00-05:00".`;
  return z
    .string({ error: message })
    .refine((v) => parseRfc3339(v) !== null, { error: message, abort: true })
    .refine((v) => inInstantRange(toDate(v)), { error: instantRangeMessage(field), abort: true });
}

/** A string that already passed instant(). */
function toDate(value: string): Date {
  const parsed = parseRfc3339(value);
  if (!parsed) throw new Error(`Expected a validated RFC 3339 instant, got "${value}"`);
  return parsed;
}

function parseQueryInstant(field: "from" | "to", value: string | null | undefined, fallback: Date): Date {
  if (value === null || value === undefined || value.trim() === "") return fallback;
  const parsed = parseRfc3339(value.trim());
  if (!parsed) {
    throw invalidField(
      field,
      `${field} is not an RFC 3339 date-time with an offset.`,
      `Send ${field} like 2026-11-01T00:00:00-05:00 (a time zone offset is required), or leave it out.`,
    );
  }
  if (!inInstantRange(parsed)) {
    throw invalidField(field, instantRangeMessage(field), `Send a ${field} in the years 2000–2999, or leave it out.`);
  }
  return parsed;
}

// ---- Policies ----

const { leadTimeMin, horizonDays, depositHorizonDays, cancelWindowHours, phoneMaxLength, ruleMaxLength } = POLICY_LIMITS;

function ruleText(field: string) {
  const message = `${field} must be text of at most ${ruleMaxLength} characters ("" to clear it).`;
  return z.string({ error: message }).trim().max(ruleMaxLength, { error: message }).refine(hasNoNul, noNul(field));
}

const phoneMessage = `phone must be text of 1–${phoneMaxLength} characters, or null to remove it.`;

const updatePoliciesSchema = z
  .strictObject({
    leadTimeMin: wholeNumber("leadTimeMin", leadTimeMin.min, leadTimeMin.max, "minutes").optional(),
    horizonDays: wholeNumber("horizonDays", horizonDays.min, horizonDays.max, "days").optional(),
    depositHorizonDays: wholeNumber("depositHorizonDays", depositHorizonDays.min, depositHorizonDays.max, "days").optional(),
    cancelWindowHours: wholeNumber("cancelWindowHours", cancelWindowHours.min, cancelWindowHours.max, "hours").optional(),
    paused: z.boolean({ error: "paused must be true or false." }).optional(),
    phone: z
      .string({ error: phoneMessage })
      .trim()
      .min(1, { error: phoneMessage })
      .max(phoneMaxLength, { error: phoneMessage })
      .refine(hasNoNul, noNul("phone"))
      .nullable()
      .optional(),
    depositRule: ruleText("depositRule").optional(),
    lateCancelRule: ruleText("lateCancelRule").optional(),
    noShowRule: ruleText("noShowRule").optional(),
  } satisfies Record<keyof Policies, z.ZodType>) // same keys as the contract, no more, no fewer
  .refine(atLeastOneField, { error: "Send at least one policy field to change." });

const POLICIES_NEXT_ACTION =
  "Fix the field named in details.field, then send the PUT again with only the fields to change.";

/** GET /api/shops/[shop]/policies: the shop and its policies (DEFAULT_POLICIES if it has no row). */
export async function getShopPolicies(deps: FrontDeskDeps, shopSlug: string): Promise<PoliciesResponse> {
  const shop = await requireShop(deps, shopSlug);
  return { shop, policies: await policiesFor(deps, shopSlug) };
}

/**
 * PUT /api/shops/[shop]/policies: change the fields in UpdatePoliciesRequest (at least one) and return
 * the whole row. Text fields are stored trimmed. The store merges the patch atomically, so two
 * concurrent PUTs of different fields both take effect.
 */
export async function updateShopPolicies(deps: FrontDeskDeps, shopSlug: string, body: unknown): Promise<PoliciesResponse> {
  const shop = await requireShop(deps, shopSlug);
  const patch = parseBody(updatePoliciesSchema, body, POLICIES_NEXT_ACTION);
  const policies = await deps.catalog.savePolicies(shopSlug, defined(patch));
  return { shop, policies };
}

// ---- Hours ----

/** Most opening windows one staff member's week may have. */
export const MAX_WEEKLY_WINDOWS = 50;

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:mm" (24-hour) on the 15-minute grid. */
function localTime(field: "open" | "close") {
  const format = `${field} must be a 24-hour time "HH:mm", e.g. "09:00".`;
  return z
    .string({ error: format })
    .regex(HHMM, { error: format, abort: true })
    .refine((v) => Number(v.slice(3)) % 15 === 0, {
      error: `${field} must be on the 15-minute grid: minutes 00, 15, 30 or 45.`,
      abort: true,
    });
}

const weeklyWindowSchema = z
  .strictObject({
    weekday: z.literal([1, 2, 3, 4, 5, 6, 7], {
      error: "weekday must be a whole number from 1 (Monday) to 7 (Sunday).",
    }),
    open: localTime("open"),
    close: localTime("close"),
  } satisfies Record<keyof WeeklyHours, z.ZodType>)
  .refine((w) => w.open < w.close, { error: "close must be later than open.", path: ["close"] });

/** Windows on the same weekday may touch but not overlap. Reports the later window of the first overlap. */
function checkNoOverlap(weekly: WeeklyHours[], ctx: z.RefinementCtx): void {
  const sorted = weekly
    .map((window, index) => ({ window, index }))
    .sort((a, b) => a.window.weekday - b.window.weekday || (a.window.open < b.window.open ? -1 : a.window.open > b.window.open ? 1 : 0));
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1].window;
    const { window: cur, index } = sorted[k];
    if (cur.weekday === prev.weekday && cur.open < prev.close) {
      ctx.addIssue({
        code: "custom",
        path: [index],
        message: `Two windows on ${DAY_NAMES[cur.weekday]} overlap: ${prev.open}–${prev.close} and ${cur.open}–${cur.close}.`,
        input: weekly,
      });
      return;
    }
  }
}

const updateHoursSchema = z.strictObject({
  staffId: staffIdSchema,
  weekly: z
    .array(weeklyWindowSchema, {
      error: "weekly must be a list of { weekday, open, close } windows ([] if they never work).",
    })
    .max(MAX_WEEKLY_WINDOWS, { error: `weekly can have at most ${MAX_WEEKLY_WINDOWS} windows.` })
    .superRefine(checkNoOverlap),
} satisfies Record<keyof UpdateHoursRequest, z.ZodType>);

const HOURS_NEXT_ACTION = "Fix the entry named in details.field, then send the staff member's whole week again.";

function compareWindows(a: WeeklyHours, b: WeeklyHours): number {
  return a.weekday - b.weekday || (a.open < b.open ? -1 : a.open > b.open ? 1 : 0);
}

async function staffWeeks(deps: FrontDeskDeps, shopSlug: string): Promise<StaffWeeklyHours[]> {
  const staff = await deps.catalog.getStaffHours(shopSlug);
  return staff.map((s) => ({
    staffId: s.staffId,
    staffName: s.staffName || s.staffId,
    weekly: s.weekly.map((w) => ({ ...w })).sort(compareWindows),
  }));
}

/** GET /api/shops/[shop]/hours: every staff member's regular week, each sorted by weekday, then open. */
export async function getShopHours(deps: FrontDeskDeps, shopSlug: string): Promise<HoursResponse> {
  const shop = await requireShop(deps, shopSlug);
  return { shop, staff: await staffWeeks(deps, shopSlug) };
}

/**
 * PUT /api/shops/[shop]/hours: replace one staff member's whole week (UpdateHoursRequest) and return
 * every staff member's week after the change. Unknown staff → not_found with the valid ids.
 */
export async function replaceShopHours(deps: FrontDeskDeps, shopSlug: string, body: unknown): Promise<HoursResponse> {
  const shop = await requireShop(deps, shopSlug);
  const { staffId, weekly } = parseBody(updateHoursSchema, body, HOURS_NEXT_ACTION);
  const replaced = await deps.catalog.replaceWeeklyHours(shopSlug, staffId, weekly);
  if (!replaced) throw await staffNotFound(deps, shop, staffId);
  return { shop, staff: await staffWeeks(deps, shopSlug) };
}

async function staffNotFound(deps: FrontDeskDeps, shop: Shop, staffId: string): Promise<FrontDeskError> {
  const staff = await deps.catalog.getStaffHours(shop.slug);
  return new FrontDeskError(
    "not_found",
    `No staff member with id "${staffId}" at ${shop.name}.`,
    "Use one of the staff ids in details.valid_staff_ids (GET /api/shops/[shop]/hours lists them).",
    { staffId, valid_staff_ids: staff.map((s) => s.staffId) },
  );
}

// ---- Blocked time ----

/** GET /api/shops/[shop]/blocks defaults: from this many days ago … */
export const BLOCKS_PAST_DAYS = 7;
/** … to this many days ahead. */
export const BLOCKS_FUTURE_DAYS = 366;
/** Longest blocked time accepted. */
export const MAX_BLOCK_DAYS = 366;
/** Longest reason accepted (the blocked_times.reason check). */
export const MAX_BLOCK_REASON = 200;

const reasonMessage = `reason must be text of at most ${MAX_BLOCK_REASON} characters.`;

const createBlockSchema = z
  .strictObject({
    staffId: staffIdSchema,
    start: instant("start"),
    end: instant("end"),
    reason: z
      .string({ error: reasonMessage })
      .trim()
      .max(MAX_BLOCK_REASON, { error: reasonMessage })
      .refine(hasNoNul, noNul("reason"))
      .optional(),
  } satisfies Record<keyof CreateBlockRequest, z.ZodType>)
  .superRefine((block, ctx) => {
    const start = parseRfc3339(block.start);
    const end = parseRfc3339(block.end);
    if (!start || !end) return; // already reported by instant()
    if (end <= start) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "end must be later than start.", input: block.end });
    } else if (end.getTime() - start.getTime() > MAX_BLOCK_DAYS * DAY_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: `A blocked time can be at most ${MAX_BLOCK_DAYS} days long.`,
        input: block.end,
      });
    }
  });

const BLOCK_NEXT_ACTION = "Fix the field named in details.field, then send the blocked time again.";

/**
 * GET /api/shops/[shop]/blocks?from=&to=: blocked times overlapping [from, to), sorted by start.
 * Both are optional RFC 3339 instants in the years 2000–2999 (INSTANT_LIMITS); the default is 7 days
 * ago to 366 days ahead of the clock.
 */
export async function listShopBlocks(
  deps: FrontDeskDeps,
  shopSlug: string,
  query: { from?: string | null; to?: string | null },
): Promise<BlocksResponse> {
  const shop = await requireShop(deps, shopSlug);
  const now = deps.clock.now().getTime();
  const from = parseQueryInstant("from", query.from, new Date(now - BLOCKS_PAST_DAYS * DAY_MS));
  const to = parseQueryInstant("to", query.to, new Date(now + BLOCKS_FUTURE_DAYS * DAY_MS));
  if (from >= to) {
    throw invalidField("to", "to must be later than from.", "Send a to that is after from, or leave both out.");
  }
  return { shop, blocks: await deps.catalog.listBlocks(shopSlug, { start: from, end: to }) };
}

/**
 * POST /api/shops/[shop]/blocks: store a blocked time (CreateBlockRequest). Existing bookings are
 * not touched. A staff member who isn't in the shop → not_found.
 */
export async function createShopBlock(deps: FrontDeskDeps, shopSlug: string, body: unknown): Promise<BlockResponse> {
  const shop = await requireShop(deps, shopSlug);
  const input = parseBody(createBlockSchema, body, BLOCK_NEXT_ACTION);
  const block = await deps.catalog.createBlock(shopSlug, {
    staffId: input.staffId,
    start: toDate(input.start),
    end: toDate(input.end),
    reason: input.reason ?? "",
  });
  if (!block) throw await staffNotFound(deps, shop, input.staffId);
  return { block };
}

/** DELETE /api/shops/[shop]/blocks?id=<uuid>: delete one blocked time and return it. */
export async function deleteShopBlock(deps: FrontDeskDeps, shopSlug: string, id: string | null): Promise<BlockResponse> {
  const shop = await requireShop(deps, shopSlug);
  const blockId = id?.trim() ?? "";
  if (blockId === "") {
    throw invalidField(
      "id",
      "id is required: the id of the blocked time to delete.",
      "Send DELETE /api/shops/[shop]/blocks?id=<id>, with an id from GET /api/shops/[shop]/blocks.",
    );
  }
  const block = await deps.catalog.deleteBlock(shopSlug, blockId);
  if (!block) {
    throw new FrontDeskError(
      "not_found",
      `No blocked time with id "${blockId}" at ${shop.name}.`,
      "List the blocked times with GET /api/shops/[shop]/blocks and use one of their ids. It may already be deleted.",
      { id: blockId },
    );
  }
  return { block };
}

// ---- Services ----

/** Allowed values for a service's fields (inclusive). */
export const SERVICE_LIMITS = {
  idPattern: /^[a-z0-9][a-z0-9-]{0,39}$/,
  nameMaxLength: 80,
  durationMin: { min: 5, max: 480 },
  priceCents: { min: 0, max: 1_000_000 },
} as const;

const serviceFields = {
  name: requiredText("name", SERVICE_LIMITS.nameMaxLength),
  durationMin: wholeNumber("durationMin", SERVICE_LIMITS.durationMin.min, SERVICE_LIMITS.durationMin.max, "minutes"),
  priceCents: wholeNumber("priceCents", SERVICE_LIMITS.priceCents.min, SERVICE_LIMITS.priceCents.max, "cents"),
  depositCents: wholeNumber("depositCents", SERVICE_LIMITS.priceCents.min, SERVICE_LIMITS.priceCents.max, "cents"),
};

const serviceIdMessage =
  'id must be 1–40 lowercase letters, digits and hyphens, starting with a letter or digit, e.g. "kids-cut".';

function depositOverPrice(depositCents: number, priceCents: number): string {
  return `depositCents (${depositCents}) can't be more than priceCents (${priceCents}).`;
}

const DEPOSIT_NEXT_ACTION = "Lower depositCents or raise priceCents so the deposit is at most the price.";

/**
 * The store refused a deposit over the price (DepositExceedsPriceError): the services check
 * constraint, judged on the row as it was when the write applied. Reached when another change to the
 * same service landed between the friendly pre-check and the write.
 */
function depositRefused(serviceId: string, field: "depositCents" | "priceCents"): FrontDeskError {
  return invalidField(
    field,
    `The deposit can't be more than the price: another change to service "${serviceId}" landed first.`,
    `Read the service again (GET /api/shops/[shop]/services), then send it again. ${DEPOSIT_NEXT_ACTION}`,
  );
}

const createServiceSchema = z
  .strictObject({
    id: z.string({ error: serviceIdMessage }).regex(SERVICE_LIMITS.idPattern, { error: serviceIdMessage }),
    ...serviceFields,
  } satisfies Record<keyof CreateServiceRequest, z.ZodType>)
  .superRefine((s, ctx) => {
    if (s.depositCents > s.priceCents) {
      ctx.addIssue({
        code: "custom",
        path: ["depositCents"],
        message: depositOverPrice(s.depositCents, s.priceCents),
        input: s.depositCents,
      });
    }
  });

const updateServiceSchema = z
  .strictObject({
    name: serviceFields.name.optional(),
    durationMin: serviceFields.durationMin.optional(),
    priceCents: serviceFields.priceCents.optional(),
    depositCents: serviceFields.depositCents.optional(),
  } satisfies Record<keyof UpdateServiceRequest, z.ZodType>)
  .refine(atLeastOneField, { error: "Send at least one field to change: name, durationMin, priceCents or depositCents." });

const SERVICE_NEXT_ACTION = "Fix the field named in details.field, then send the service again.";

/**
 * POST /api/shops/[shop]/services: add a service (CreateServiceRequest) at the end of the list.
 * A taken id → invalid_request (field "id"); a deposit over the price → invalid_request (field
 * "depositCents"), whether the schema or the store catches it.
 */
export async function createShopService(deps: FrontDeskDeps, shopSlug: string, body: unknown): Promise<ServiceResponse> {
  await requireShop(deps, shopSlug);
  const input = parseBody(createServiceSchema, body, SERVICE_NEXT_ACTION);
  try {
    return { service: await deps.catalog.createService(shopSlug, input) };
  } catch (err) {
    if (err instanceof DuplicateServiceError) {
      throw invalidField(
        "id",
        `The shop already has a service with id "${input.id}".`,
        "Pick a different id, or change the existing service with PATCH /api/shops/[shop]/services/[id].",
      );
    }
    if (err instanceof DepositExceedsPriceError) {
      // The schema already rejects deposit > price, so this is the store's check as a backstop.
      throw invalidField("depositCents", "The deposit can't be more than the price.", DEPOSIT_NEXT_ACTION);
    }
    throw err;
  }
}

/**
 * PATCH /api/shops/[shop]/services/[id]: change some fields of a service (UpdateServiceRequest, at
 * least one). depositCents <= priceCents is checked on the merged values first, for a friendly
 * message; the store checks it again on the row as it is when the write applies (so two concurrent
 * PATCHes can't combine into a deposit over the price), and that refusal is the same invalid_request
 * (field "depositCents"). Unknown id → not_found; the id is only compared with the listed services,
 * never sent in a query of its own. Existing bookings keep their own depositCents snapshot.
 */
export async function updateShopService(
  deps: FrontDeskDeps,
  shopSlug: string,
  serviceId: string,
  body: unknown,
): Promise<ServiceResponse> {
  const shop = await requireShop(deps, shopSlug);
  const patch = defined(parseBody(updateServiceSchema, body, SERVICE_NEXT_ACTION));
  const services = await deps.catalog.listServices(shopSlug);
  const current = services.find((s) => s.id === serviceId);
  const notFound = () =>
    new FrontDeskError(
      "not_found",
      `No service with id "${serviceId}" at ${shop.name}.`,
      "Use one of the service ids in details.valid_service_ids (GET /api/shops/[shop]/services lists them).",
      { service_id: serviceId, valid_service_ids: services.map((s) => s.id) },
    );
  if (!current) throw notFound();

  const merged = { ...current, ...patch };
  if (merged.depositCents > merged.priceCents) {
    throw invalidField(
      patch.depositCents !== undefined ? "depositCents" : "priceCents",
      depositOverPrice(merged.depositCents, merged.priceCents),
      DEPOSIT_NEXT_ACTION,
    );
  }
  let service;
  try {
    service = await deps.catalog.updateService(shopSlug, serviceId, patch);
  } catch (err) {
    if (err instanceof DepositExceedsPriceError) {
      // Name the field this request changed, like the pre-check above.
      throw depositRefused(serviceId, patch.depositCents !== undefined ? "depositCents" : "priceCents");
    }
    throw err;
  }
  if (!service) throw notFound();
  return { service };
}

// ---- Bookings ----

/**
 * POST /api/shops/[shop]/bookings/[id]/cancel, /complete and /no-show: decide() with actor "owner",
 * then the conditional store transition (see transitionBooking). A state that doesn't allow the
 * action → invalid_request.
 */
export function ownerBookingAction(
  deps: FrontDeskDeps,
  shopSlug: string,
  bookingId: string,
  action: ManageAction,
): Promise<OwnerBookingActionResponse> {
  return transitionBooking(deps, shopSlug, bookingId, action, "owner");
}

/** GET /api/shops/[shop]/bookings/[id]: the booking and its events, oldest first. */
export async function getBookingDetail(
  deps: FrontDeskDeps,
  shopSlug: string,
  bookingId: string,
): Promise<BookingDetailResponse> {
  await requireShop(deps, shopSlug);
  const booking = await requireBooking(deps, shopSlug, bookingId);
  return { booking, events: await deps.store.listEvents(booking.id) };
}
