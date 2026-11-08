import { requireOwner } from "@/components/console/require-owner";
import type { Metadata } from "next";
import { Suspense } from "react";
import type { PoliciesResponse } from "@/lib/types/frontdesk";
import { loadSettings } from "@/components/console/load-settings";
import { errorFeedback } from "@/components/console/api";
import { SettingsShell, SaveFeedback } from "@/components/console/form-parts";
import { PauseBookings, RulesForm } from "@/components/console/rules-form";
export const metadata: Metadata = {
  title: "Rules — Front Desk",
  description: "Pause bookings and manage the booking rules agents follow.",
};
async function Rules() {
  let data: PoliciesResponse;
  try {
    data = await loadSettings<PoliciesResponse>("policies");
  } catch (error) {
    return <SaveFeedback feedback={errorFeedback(error)} />;
  }
  return (
    <>
      <PauseBookings initialPaused={data.policies.paused} />
      <RulesForm policies={data.policies} />
    </>
  );
}
export const instant = false;

export default async function RulesPage() {
  await requireOwner();
  return (
    <SettingsShell
      title="Rules"
      description="Control how agents book your shop. Changes apply as soon as you save."
    >
      <Suspense fallback={<p role="status">Loading rules…</p>}>
        <Rules />
      </Suspense>
    </SettingsShell>
  );
}
