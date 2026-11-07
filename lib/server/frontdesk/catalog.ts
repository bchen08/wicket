import type { Service, Shop } from "../../types/frontdesk";

// Data access for shops. Callers depend only on this interface, so the hard-coded
// implementation can be swapped for Postgres without touching them.

/** A half-open span of time [start, end). */
export type TimeRange = {
  start: Date;
  end: Date;
};

/** One opening window in a staff member's regular week, in the shop's local time. */
export type WeeklyHours = {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Local opening time, "HH:mm" (24-hour). */
  open: string;
  /** Local closing time, "HH:mm" (24-hour). Appointments must end by this time. */
  close: string;
};

/** When a staff member normally works. */
export type StaffHours = {
  staffId: string;
  weekly: WeeklyHours[];
};

/** Time a staff member can't be booked (an existing booking, lunch, …). Half-open [start, end). */
export type BusyInterval = TimeRange & {
  staffId: string;
  /** Why it's busy. For debugging only; never shown to agents. */
  reason?: string;
};

export interface ShopCatalog {
  /** The shop, or null if no shop has this slug. */
  getShop(slug: string): Promise<Shop | null>;
  /** The shop's services in display order. Empty if the shop doesn't exist. */
  listServices(slug: string): Promise<Service[]>;
  /** Regular weekly hours for each staff member. Empty if the shop doesn't exist. */
  getStaffHours(slug: string): Promise<StaffHours[]>;
  /** Busy intervals that overlap `range` (half-open on both sides). */
  getBusyIntervals(slug: string, range: TimeRange): Promise<BusyInterval[]>;
}
