import { DateTime } from "luxon";
import type { AgentSummary, AgentsResponse } from "@/lib/types/agents";
import { loadSettings } from "@/components/console/load-settings";
import { errorFeedback } from "@/components/console/api";
import { SaveFeedback } from "@/components/console/form-parts";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function SeenTime({ value, zone }: { value: string | null; zone: string }) {
  if (!value) return <span className="text-muted-foreground">Never</span>;
  return <time dateTime={value} className="font-mono">{DateTime.fromISO(value).setZone(zone).toFormat("d LLL yyyy, h:mm a")}</time>;
}

function AgentRow({ agent, zone }: { agent: AgentSummary; zone: string }) {
  return <TableRow>
    <TableCell className="max-w-48 whitespace-normal wrap-anywhere">{agent.name}</TableCell>
    <TableCell className="font-mono">{agent.bookings}</TableCell>
    <TableCell><SeenTime value={agent.firstSeen} zone={zone} /></TableCell>
    <TableCell><SeenTime value={agent.lastSeen} zone={zone} /></TableCell>
    <TableCell><SeenTime value={agent.lastBookedAt} zone={zone} /></TableCell>
  </TableRow>;
}

export async function AgentsList() {
  let data: AgentsResponse;
  try {
    data = await loadSettings<AgentsResponse>("agents");
  } catch (error) {
    return <SaveFeedback feedback={errorFeedback(error)} />;
  }
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Agent activity">
    <div className="border-t border-border">
      <Table>
        <TableCaption>Verified agents seen by Front Desk · Times in {data.shop.timezone}</TableCaption>
        <TableHeader><TableRow>
          {["Name", "Bookings", "First seen", "Last seen", "Last booked"].map(label => <TableHead scope="col" key={label}>{label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>
          {data.agents.map(agent => <AgentRow key={agent.clientId} agent={agent} zone={data.shop.timezone} />)}
          {!data.agents.length && <TableRow><TableCell colSpan={5} className="py-8 text-center">No verified agents yet.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
    <p className="text-sm text-muted-foreground">{data.unconfirmedBookings} bookings from agents that didn&apos;t identify themselves</p>
  </section>;
}
