// Shared contract for GET /api/schedule.
// The UI must import these types instead of describing the shape itself.

export type ScheduleSession = {
  id: string;
  title: string;
  speaker: string;
  /** ISO 8601 with timezone offset, e.g. "2027-03-06T10:00:00-05:00" */
  startsAt: string;
  /** ISO 8601 with timezone offset */
  endsAt: string;
  location: string;
};

export type ScheduleResponse = {
  /** true while the schedule is placeholder data; the UI should show a notice */
  placeholder: boolean;
  /** sorted by startsAt, earliest first */
  sessions: ScheduleSession[];
};
