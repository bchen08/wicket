import { requireOwner } from "@/components/console/require-owner";
import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsShell } from "@/components/console/form-parts";
import { AgentsList } from "@/components/console/agents-list";

export const metadata: Metadata = {
  title: "Agents — Front Desk",
  description: "See the agents that book with your shop and their recent activity.",
};

export const instant = false;

export default async function AgentsPage() {
  await requireOwner();
  return <SettingsShell title="Agents" description="Meet the agents booking with your shop. Verified identities appear here; other bookings are counted below.">
    <Suspense fallback={<p role="status">Loading agents…</p>}><AgentsList /></Suspense>
  </SettingsShell>;
}
