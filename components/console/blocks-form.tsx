"use client";
import { DateTime } from "luxon";
import type { FormEvent } from "react";
import type {
  BlockedTime,
  StaffWeeklyHours,
  CreateBlockRequest,
  BlockResponse,
} from "@/lib/types/frontdesk";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormInput, SaveFeedback } from "@/components/console/form-parts";
import { useSave } from "@/components/console/use-save";
import { writeSettings } from "@/components/console/api";
export function BlockForm({
  staff,
  timezone,
}: {
  staff: StaffWeeklyHours[];
  timezone: string;
}) {
  const state = useSave();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void state.save(async () => {
      const instant = (name: string) => {
        const value = String(data.get(name));
        const date = DateTime.fromISO(value, { zone: timezone });
        if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm") !== value)
          throw new Error(`Choose a valid ${name} time in ${timezone}.`);
        return date.toISO()!;
      };
      const body: CreateBlockRequest = {
        staffId: String(data.get("staffId")),
        start: instant("start"),
        end: instant("end"),
        reason: String(data.get("reason")),
      };
      await writeSettings<BlockResponse, CreateBlockRequest>(
        "blocks",
        "POST",
        body,
      );
      form.reset();
    });
  }
  return (
    <form
      onSubmit={submit}
      onChange={state.clear}
      className="flex flex-col gap-5"
    >
      <h3 className="font-serif text-xl">Add time off</h3>
      <p className="text-sm text-muted-foreground">
        Times are in {timezone}, not your device&apos;s timezone. Existing
        bookings are not changed.
      </p>
      <fieldset disabled={state.pending || !staff.length} className="min-w-0">
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="block-staff">Staff member</FieldLabel>
            <select
              id="block-staff"
              name="staffId"
              className="min-h-11 rounded-md border border-input bg-background px-3 text-sm"
              required
            >
              {staff.map((person) => (
                <option key={person.staffId} value={person.staffId}>
                  {person.staffName}
                </option>
              ))}
            </select>
          </Field>
          <FormInput
            label="Start"
            name="start"
            type="datetime-local"
            required
          />
          <FormInput label="End" name="end" type="datetime-local" required />
          <FormInput
            label="Reason (optional)"
            name="reason"
            maxLength={200}
            placeholder="e.g. Saturday afternoon off"
          />
        </FieldGroup>
      </fieldset>
      <Button
        type="submit"
        className="min-h-11 self-start"
        disabled={state.pending || !staff.length}
      >
        {state.pending ? "Saving…" : "Add time off"}
      </Button>
      <SaveFeedback feedback={state.feedback} />
    </form>
  );
}
export function BlockRow({
  block,
  staffName,
  timezone,
}: {
  block: BlockedTime;
  staffName: string;
  timezone: string;
}) {
  const state = useSave();
  const format = (value: string) =>
    DateTime.fromISO(value)
      .setZone(timezone)
      .toFormat("ccc, LLL d, yyyy · h:mm a ZZZZ");
  return (
    <li className="flex flex-col gap-3 border-b border-border pb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1 text-sm wrap-anywhere">
          <p className="font-medium">
            {staffName} · {block.reason || "Time off"}
          </p>
          <p className="font-mono">{format(block.start)}</p>
          <p className="text-muted-foreground">to <span className="font-mono">{format(block.end)}</span></p>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={state.pending}
          aria-label={`Remove time off: ${block.reason || format(block.start)}`}
          onClick={() =>
            void state.save(async () => {
              await writeSettings<BlockResponse, never>(
                `blocks?id=${encodeURIComponent(block.id)}`,
                "DELETE",
              );
            })
          }
        >
          {state.pending ? "Removing…" : "Remove"}
        </Button>
      </div>
      <SaveFeedback feedback={state.feedback} />
    </li>
  );
}
