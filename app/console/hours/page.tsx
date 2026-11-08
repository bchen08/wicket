import { requireOwner } from "@/components/console/require-owner";
import type { Metadata } from "next";
import { Suspense } from "react";
import type {
  HoursResponse,
  BlocksResponse,
  StaffWeeklyHours,
} from "@/lib/types/frontdesk";
import { loadSettings } from "@/components/console/load-settings";
import { errorFeedback } from "@/components/console/api";
import { SettingsShell, SaveFeedback } from "@/components/console/form-parts";
import { HoursForm } from "@/components/console/hours-form";
import { BlockForm, BlockRow } from "@/components/console/blocks-form";
export const metadata: Metadata = {
  title: "Hours — Front Desk",
  description: "Set weekly working hours and time off for your staff.",
};
async function TimeOff({
  staff,
  timezone,
}: {
  staff: StaffWeeklyHours[];
  timezone: string;
}) {
  let data: BlocksResponse;
  try {
    data = await loadSettings<BlocksResponse>("blocks");
  } catch (error) {
    return <SaveFeedback feedback={errorFeedback(error)} />;
  }
  return (
    <section className="flex flex-col gap-6 border-t border-border pt-8">
      <div>
        <h2 className="font-serif text-3xl leading-tight">Time off</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          From the past 7 days through the next year.
        </p>
      </div>
      {data.blocks.length ? (
        <ul className="flex flex-col gap-5">
          {data.blocks.map((block) => (
            <BlockRow
              key={block.id}
              block={block}
              timezone={timezone}
              staffName={
                staff.find((person) => person.staffId === block.staffId)
                  ?.staffName ?? block.staffId
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No time off scheduled.</p>
      )}
      <BlockForm staff={staff} timezone={timezone} />
    </section>
  );
}
async function Hours() {
  let data: HoursResponse;
  try {
    data = await loadSettings<HoursResponse>("hours");
  } catch (error) {
    return <SaveFeedback feedback={errorFeedback(error)} />;
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {data.shop.name} · Times in {data.shop.timezone}
      </p>
      {data.staff.map((staff) => (
        <HoursForm key={staff.staffId} staff={staff} />
      ))}
      <Suspense fallback={<p role="status">Loading time off…</p>}>
        <TimeOff staff={data.staff} timezone={data.shop.timezone} />
      </Suspense>
    </>
  );
}
export const instant = false;

export default async function HoursPage() {
  await requireOwner();
  return (
    <SettingsShell
      title="Hours"
      description="Choose when your team is available. Agents only see times within these windows."
    >
      <Suspense fallback={<p role="status">Loading hours…</p>}>
        <Hours />
      </Suspense>
    </SettingsShell>
  );
}
