"use client";
import { useState, type FormEvent } from "react";
import type {
  Policies,
  PoliciesResponse,
  UpdatePoliciesRequest,
} from "@/lib/types/frontdesk";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormInput, SaveFeedback } from "@/components/console/form-parts";
import { useSave } from "@/components/console/use-save";
import { writeSettings } from "@/components/console/api";
export function PauseBookings({ initialPaused }: { initialPaused: boolean }) {
  const [paused, setPaused] = useState(initialPaused);
  const state = useSave();
  return (
    <section className="flex flex-col gap-4 rounded-xl border-2 border-primary bg-accent/40 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="pause-bookings" className="text-xl font-medium">
            Pause bookings
          </label>
          <p id="pause-help" className="text-sm text-muted-foreground">
            Agents can&apos;t book while paused
          </p>
        </div>
        <Switch
          id="pause-bookings"
          checked={paused}
          disabled={state.pending}
          aria-describedby="pause-help"
          onCheckedChange={(next) =>
            void state.save(async () => {
              const body: UpdatePoliciesRequest = { paused: next };
              const result = await writeSettings<
                PoliciesResponse,
                UpdatePoliciesRequest
              >("policies", "PUT", body);
              setPaused(result.policies.paused);
            })
          }
        />
      </div>
      <p className="text-sm font-medium">
        {state.pending
          ? "Saving…"
          : paused
            ? "Bookings are paused"
            : "Bookings are open"}
      </p>
      <SaveFeedback feedback={state.feedback} />
    </section>
  );
}
export function RulesForm({ policies }: { policies: Policies }) {
  const state = useSave();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: UpdatePoliciesRequest = {
      leadTimeMin: Math.round(Number(data.get("notice")) * 60),
      horizonDays: Number(data.get("horizonDays")),
      depositHorizonDays: Number(data.get("depositHorizonDays")),
      cancelWindowHours: Number(data.get("cancelWindowHours")),
      phone: String(data.get("phone")).trim() || null,
      depositRule: String(data.get("depositRule")),
      lateCancelRule: String(data.get("lateCancelRule")),
      noShowRule: String(data.get("noShowRule")),
    };
    void state.save(async () => {
      await writeSettings<PoliciesResponse, UpdatePoliciesRequest>(
        "policies",
        "PUT",
        body,
      );
    });
  }
  return (
    <form
      onSubmit={submit}
      onChange={state.clear}
      className="flex flex-col gap-6 rounded-xl border border-border bg-card p-5 sm:p-6"
    >
      <h2 className="text-lg font-medium">Booking rules</h2>
      <fieldset disabled={state.pending} className="min-w-0">
        <FieldGroup>
          <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FormInput
              name="notice"
              label="Minimum notice (hours)"
              type="number"
              min={0}
              max={168}
              step="any"
              defaultValue={policies.leadTimeMin / 60}
              required
            />
            <FormInput
              name="horizonDays"
              label="How far ahead (days)"
              type="number"
              min={1}
              max={365}
              defaultValue={policies.horizonDays}
              required
            />
            <FormInput
              name="depositHorizonDays"
              label="Deposit booking window (days)"
              type="number"
              min={1}
              max={365}
              defaultValue={policies.depositHorizonDays}
              required
            />
            <FormInput
              name="cancelWindowHours"
              label="Cancellation window (hours)"
              type="number"
              min={0}
              max={720}
              defaultValue={policies.cancelWindowHours}
              required
            />
          </FieldGroup>
          <FormInput
            name="phone"
            label="Shop phone"
            type="tel"
            maxLength={40}
            defaultValue={policies.phone ?? ""}
            hint="Agents share this number when bookings are paused."
          />
          {(
            [
              ["depositRule", "Deposit rule"],
              ["lateCancelRule", "Late cancellation rule"],
              ["noShowRule", "No-show rule"],
            ] as const
          ).map(([name, label]) => (
            <Field key={name}>
              <FieldLabel htmlFor={name}>{label}</FieldLabel>
              <textarea
                id={name}
                name={name}
                defaultValue={policies[name]}
                maxLength={1000}
                rows={3}
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
              />
            </Field>
          ))}
        </FieldGroup>
      </fieldset>
      <Button
        type="submit"
        className="min-h-11 self-start"
        disabled={state.pending}
      >
        {state.pending ? "Saving…" : "Save rules"}
      </Button>
      <SaveFeedback feedback={state.feedback} />
    </form>
  );
}
