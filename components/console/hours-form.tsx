"use client";
import { useState } from "react";
import type {
  StaffWeeklyHours,
  WeeklyHours,
  UpdateHoursRequest,
  HoursResponse,
} from "@/lib/types/frontdesk";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field";
import { FormInput, SaveFeedback } from "@/components/console/form-parts";
import { useSave } from "@/components/console/use-save";
import { writeSettings } from "@/components/console/api";
const days = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export function HoursForm({ staff }: { staff: StaffWeeklyHours }) {
  const [weekly, setWeekly] = useState(staff.weekly);
  const state = useSave();
  function update(index: number, field: "open" | "close", value: string) {
    state.clear();
    setWeekly(
      weekly.map((window, i) =>
        i === index ? { ...window, [field]: value } : window,
      ),
    );
  }
  return (
    <form
      className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        void state.save(async () => {
          const body: UpdateHoursRequest = { staffId: staff.staffId, weekly };
          const result = await writeSettings<HoursResponse, UpdateHoursRequest>(
            "hours",
            "PUT",
            body,
          );
          const saved = result.staff.find(
            (person) => person.staffId === staff.staffId,
          );
          if (saved) setWeekly(saved.weekly);
        });
      }}
    >
      <h2 className="text-lg font-medium">{staff.staffName} · Weekly hours</h2>
      <p className="text-sm text-muted-foreground">
        Add separate windows for breaks. A day with no windows is closed. Times
        use 15-minute intervals.
      </p>
      <fieldset
        disabled={state.pending}
        className="flex min-w-0 flex-col gap-6"
      >
        {days.map((day, dayIndex) => (
          <FieldSet key={day} className="gap-3 border-t border-border pt-5">
            <FieldLegend>{day}</FieldLegend>
            <FieldGroup className="gap-3">
              {weekly.map(
                (window, index) =>
                  window.weekday === dayIndex + 1 && (
                    <div key={index} className="flex flex-wrap items-end gap-3">
                      <div className="min-w-0 flex-1">
                        <FormInput
                          label={`${day} start`}
                          type="time"
                          step={900}
                          required
                          value={window.open}
                          onChange={(event) =>
                            update(index, "open", event.target.value)
                          }
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <FormInput
                          label={`${day} end`}
                          type="time"
                          step={900}
                          required
                          value={window.close}
                          onChange={(event) =>
                            update(index, "close", event.target.value)
                          }
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
                        aria-label={`Remove ${day} window ${window.open}–${window.close}`}
                        onClick={() => {
                          state.clear();
                          setWeekly(weekly.filter((_, i) => i !== index));
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ),
              )}
              {!weekly.some((window) => window.weekday === dayIndex + 1) && (
                <p className="text-sm text-muted-foreground">Closed</p>
              )}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                aria-label={`Add ${day} window`}
                onClick={() => {
                  state.clear();
                  setWeekly([
                    ...weekly,
                    {
                      weekday: (dayIndex + 1) as WeeklyHours["weekday"],
                      open: "09:00",
                      close: "17:00",
                    },
                  ]);
                }}
              >
                Add window
              </Button>
            </FieldGroup>
          </FieldSet>
        ))}
      </fieldset>
      <Button
        type="submit"
        className="min-h-11 self-start"
        disabled={state.pending}
      >
        {state.pending ? "Saving…" : "Save weekly hours"}
      </Button>
      <SaveFeedback feedback={state.feedback} />
    </form>
  );
}
