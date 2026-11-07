import type { ScheduleResponse, ScheduleSession } from "@/lib/types/schedule";

// PLACEHOLDER DATA. Replace with the real schedule (or a data source) once it's confirmed.
// Dates, speakers, and rooms below are invented for testing the pipeline.
const sessions: ScheduleSession[] = [
  {
    id: "keynote",
    title: "Opening keynote (placeholder)",
    speaker: "Speaker TBA",
    startsAt: "2027-03-06T10:00:00-05:00",
    endsAt: "2027-03-06T10:45:00-05:00",
    location: "Main hall (placeholder)",
  },
  {
    id: "founder-panel",
    title: "Founder panel: building in college (placeholder)",
    speaker: "Panelists TBA",
    startsAt: "2027-03-06T11:00:00-05:00",
    endsAt: "2027-03-06T12:00:00-05:00",
    location: "Main hall (placeholder)",
  },
  {
    id: "demo-hour",
    title: "Student demo hour (placeholder)",
    speaker: "Student teams",
    startsAt: "2027-03-06T13:30:00-05:00",
    endsAt: "2027-03-06T14:30:00-05:00",
    location: "Atrium (placeholder)",
  },
  {
    id: "closing",
    title: "Closing remarks (placeholder)",
    speaker: "Organizing team",
    startsAt: "2027-03-06T16:30:00-05:00",
    endsAt: "2027-03-06T17:00:00-05:00",
    location: "Main hall (placeholder)",
  },
];

export function getSchedule(): ScheduleResponse {
  const sorted = [...sessions].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
  return { placeholder: true, sessions: sorted };
}
