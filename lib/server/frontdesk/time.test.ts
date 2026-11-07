import { describe, expect, it } from "vitest";
import { parseRfc3339, toRfc3339 } from "./time";

describe("parseRfc3339", () => {
  it.each([
    ["2026-11-14T09:00:00-05:00", "2026-11-14T14:00:00.000Z"],
    ["2026-11-14T09:00-05:00", "2026-11-14T14:00:00.000Z"], // seconds optional
    ["2026-11-14T14:00:00Z", "2026-11-14T14:00:00.000Z"],
    ["2026-11-14t14:00:00z", "2026-11-14T14:00:00.000Z"], // RFC 3339 allows lowercase
    ["2026-11-14T14:00:00.123Z", "2026-11-14T14:00:00.123Z"],
    ["2026-11-14T09:00:00+23:59", "2026-11-13T09:01:00.000Z"],
  ])("accepts %s", (input, iso) => {
    expect(parseRfc3339(input)?.toISOString()).toBe(iso);
  });

  it.each([
    "2026-11-14", // no time
    "2026-11-14T09:00:00", // no offset
    "2026-11-14 09:00:00-05:00", // space instead of T
    "2026-11-14T09:00:00-0500", // offset without colon
    "2026-11-14T09:00:00+99:99", // offset out of range
    "2026-11-14T09:00:00+24:00",
    "2026-11-14T09:00:00+05:60",
    "2026-11-14T24:00:00Z", // hour 24
    "2026-11-14T09:60:00Z",
    "2026-11-14T09:00:60Z", // leap seconds aren't representable
    "2026-02-30T09:00:00Z", // no such date
    "2026-13-01T09:00:00Z",
    "next saturday",
    "",
  ])("rejects %s", (input) => {
    expect(parseRfc3339(input)).toBeNull();
  });
});

describe("toRfc3339", () => {
  it("formats in the given zone without milliseconds", () => {
    expect(toRfc3339(new Date("2026-11-14T14:30:00.000Z"), "America/New_York")).toBe("2026-11-14T09:30:00-05:00");
    expect(toRfc3339(new Date("2026-07-11T18:30:00.000Z"), "America/New_York")).toBe("2026-07-11T14:30:00-04:00");
  });
});
