import type {
  AvailabilityDay,
  BookingPageResponse,
  BookingPageService,
  WebBookRequest,
} from "@/lib/types/web-booking";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const fields = {
  service: "service",
  start: "start",
  name: "name",
  bookedBy: "bookedBy",
} as const satisfies Record<string, keyof WebBookRequest>;

export function ShopPhone({ phone }: { phone: string | null }) {
  return phone ? (
    <a
      className="inline-flex min-h-11 items-center underline underline-offset-4"
      href={`tel:${phone}`}
    >
      {phone}
    </a>
  ) : (
    <span>the shop directly</span>
  );
}

function DayTimes({ day }: { day: AvailabilityDay }) {
  return (
    <FieldSet className="gap-3">
      <FieldLegend>{day.display}</FieldLegend>
      {day.slots.length ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {day.slots.map((slot, index) => {
            const id = `start-${day.date}-${index}`;
            const time = slot.display.includes(",")
              ? slot.display.slice(slot.display.indexOf(",") + 1).trim()
              : slot.display;
            return (
              <label
                key={`${slot.start}-${slot.staffId}`}
                htmlFor={id}
                className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:text-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
              >
                <input
                  className="size-4 shrink-0 accent-primary"
                  id={id}
                  name={fields.start}
                  type="radio"
                  value={slot.start}
                  required
                />
                <span>{time}</span>
              </label>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No times this day.</p>
      )}
    </FieldSet>
  );
}

export function BookingForm({
  data,
  service,
  error,
}: {
  data: BookingPageResponse;
  service: BookingPageService;
  error?: string;
}) {
  const hasTimes = service.days.some((day) => day.slots.length > 0);
  return (
    <form
      method="post"
      action={data.bookUrl}
      className="flex flex-col gap-8"
      aria-label={`Book ${service.name}`}
    >
      <input type="hidden" name={fields.service} value={service.id} />
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive bg-card p-4 text-sm leading-relaxed"
        >
          {error}
        </p>
      )}
      <section aria-labelledby="choose-time" className="flex flex-col gap-6">
        <div>
          <h2 id="choose-time" className="text-xl font-medium">
            2. Choose a time
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Next 7 days · All times in {data.shop.timezone}
          </p>
        </div>
        {service.days.map((day) => (
          <DayTimes key={day.date} day={day} />
        ))}
        {!hasTimes && (
          <p
            role="status"
            className="rounded-lg border border-border bg-card p-4 text-sm"
          >
            No times are available for this service in the next 7 days. Try
            another service or call <ShopPhone phone={data.policies.phone} />.
          </p>
        )}
      </section>
      <section
        aria-labelledby="booking-details"
        className="flex flex-col gap-5"
      >
        <h2 id="booking-details" className="text-xl font-medium">
          3. Booking details
        </h2>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="booking-name">Name for the booking</FieldLabel>
            <Input
              id="booking-name"
              name={fields.name}
              type="text"
              autoComplete="name"
              required
              maxLength={80}
              className="min-h-12"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="booked-by">
              Booked by (agent or app name, optional)
            </FieldLabel>
            <Input
              id="booked-by"
              name={fields.bookedBy}
              type="text"
              maxLength={80}
              className="min-h-12"
            />
          </Field>
        </FieldGroup>
      </section>
      <section
        aria-labelledby="booking-rules"
        className="rounded-xl bg-surface p-5"
      >
        <h2 id="booking-rules" className="mb-3 text-sm font-medium">
          Before you hold a time
        </h2>
        <div className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
          {data.policiesText
            .split("\n")
            .filter(Boolean)
            .map((line, index) => (
              <p key={index}>{line}</p>
            ))}
        </div>
      </section>
      <Button
        type="submit"
        disabled={!hasTimes}
        className="h-auto min-h-12 w-full whitespace-normal px-4 py-3"
      >
        Hold this time and get the approval link
      </Button>
      <p className="-mt-4 text-center text-xs leading-relaxed text-muted-foreground">
        A hold is not a confirmed booking. You review and approve next.
      </p>
    </form>
  );
}
