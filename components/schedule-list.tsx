"use client";

import { useSyncExternalStore } from "react";
import type { ScheduleResponse, ScheduleSession } from "@/lib/types/schedule";

const loading = { status: "loading" } as const;
type ScheduleState =
  | typeof loading
  | { status: "error" }
  | { status: "ready"; data: ScheduleResponse };

let state: ScheduleState = loading;
let requested = false;
const listeners = new Set<() => void>();

async function loadSchedule() {
  state = loading;
  listeners.forEach((notify) => notify());
  try {
    const response = await fetch("/api/schedule");
    if (!response.ok) throw new Error("Schedule request failed");
    const data: ScheduleResponse = await response.json();
    state = { status: "ready", data };
  } catch {
    state = { status: "error" };
  }
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (!requested) {
    requested = true;
    void loadSchedule();
  }
  return () => { listeners.delete(notify); };
}

const getSnapshot = () => state;
const getServerSnapshot = () => loading;
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function SessionRow({ session }: { session: ScheduleSession }) {
  return (
    <li className="flex min-w-0 flex-col gap-3 p-5 sm:flex-row sm:gap-8 sm:p-7">
      <p className="shrink-0 text-sm tabular-nums sm:w-52">
        <time dateTime={session.startsAt}>{timeFormatter.format(new Date(session.startsAt))}</time>
        {" to "}
        <time dateTime={session.endsAt}>{timeFormatter.format(new Date(session.endsAt))}</time>
      </p>
      <div className="min-w-0 flex-1 break-words">
        <h3 className="text-lg font-medium tracking-tight">{session.title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted">{session.speaker}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{session.location}</p>
      </div>
    </li>
  );
}

export function ScheduleList() {
  const schedule = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div className="mt-9">
      {schedule.status === "loading" ? (
        <p role="status" className="rounded-lg border border-line bg-background p-7 text-sm text-muted">Loading schedule…</p>
      ) : schedule.status === "error" ? (
        <div className="rounded-lg border border-line bg-background p-7">
          <p role="alert" className="text-sm text-muted">We couldn&apos;t load the schedule. Please try again.</p>
          <button type="button" onClick={() => void loadSchedule()} className="mt-4 text-sm font-medium underline underline-offset-4 hover:text-accent">Try again</button>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
            <p>All times Eastern (America/New_York)</p>
            {schedule.data.placeholder && <p className="rounded-full border border-line px-3 py-2">Placeholder schedule</p>}
          </div>
          {schedule.data.sessions.length > 0 ? (
            <ol className="divide-y divide-line rounded-lg border border-line bg-background">
              {schedule.data.sessions.map((session) => <SessionRow key={session.id} session={session} />)}
            </ol>
          ) : (
            <p className="rounded-lg border border-line bg-background p-7 text-sm text-muted">No sessions have been announced yet. Check back soon.</p>
          )}
        </>
      )}
    </div>
  );
}
