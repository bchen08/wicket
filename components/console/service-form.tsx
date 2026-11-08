"use client";
import type { FormEvent } from "react";
import type {
  Service,
  CreateServiceRequest,
  UpdateServiceRequest,
  ServiceResponse,
} from "@/lib/types/frontdesk";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { FormInput, SaveFeedback } from "@/components/console/form-parts";
import { useSave } from "@/components/console/use-save";
import { writeSettings } from "@/components/console/api";
export function ServiceForm({ service }: { service?: Service }) {
  const state = useSave();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const fields: UpdateServiceRequest = {
      name: String(data.get("name")),
      durationMin: Number(data.get("durationMin")),
      priceCents: Math.round(Number(data.get("price")) * 100),
      depositCents: Math.round(Number(data.get("deposit")) * 100),
    };
    void state.save(async () => {
      if (service)
        await writeSettings<ServiceResponse, UpdateServiceRequest>(
          `services/${encodeURIComponent(service.id)}`,
          "PATCH",
          fields,
        );
      else {
        const body: CreateServiceRequest = {
          id: String(data.get("id")),
          name: fields.name!,
          durationMin: fields.durationMin!,
          priceCents: fields.priceCents!,
          depositCents: fields.depositCents!,
        };
        await writeSettings<ServiceResponse, CreateServiceRequest>(
          "services",
          "POST",
          body,
        );
        form.reset();
      }
    });
  }
  return (
    <section className="border-t border-border pt-8">
      <form
        onSubmit={submit}
        onChange={state.clear}
        className="flex flex-col gap-5"
      >
        <div>
          <h2 className="font-serif text-2xl leading-tight">
            {service?.name ?? "Add a service"}
          </h2>
          {service && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              ID: {service.id}
            </p>
          )}
        </div>
        <fieldset disabled={state.pending} className="min-w-0">
          <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {!service && (
              <FormInput
                name="id"
                label="Service ID"
                placeholder="e.g. haircut"
                required
                maxLength={40}
              />
            )}
            <FormInput
              name="name"
              label="Name"
              defaultValue={service?.name}
              required
              maxLength={80}
            />
            <FormInput
              name="durationMin"
              label="Duration (minutes)"
              type="number"
              min={5}
              max={480}
              step={1}
              defaultValue={service?.durationMin ?? 30}
              required
            />
            <FormInput
              name="price"
              label="Price ($)"
              type="number"
              min={0}
              max={10000}
              step="0.01"
              defaultValue={
                service ? (service.priceCents / 100).toFixed(2) : undefined
              }
              required
            />
            <FormInput
              name="deposit"
              label="Deposit ($)"
              type="number"
              min={0}
              max={10000}
              step="0.01"
              defaultValue={
                service ? (service.depositCents / 100).toFixed(2) : "0.00"
              }
              required
            />
          </FieldGroup>
        </fieldset>
        <Button
          type="submit"
          className="min-h-11 self-start"
          disabled={state.pending}
        >
          {state.pending ? "Saving…" : service ? "Save service" : "Add service"}
        </Button>
        <SaveFeedback feedback={state.feedback} />
      </form>
    </section>
  );
}
