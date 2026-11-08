import { Check } from "lucide-react";
import type { BookingAgent } from "@/lib/types/agents";
import { Badge } from "@/components/ui/badge";

export function AgentBadge({ agent, showClientId = false }: { agent: BookingAgent; showClientId?: boolean }) {
  return <div className="flex min-w-0 flex-col gap-2">
    <Badge variant={agent.confirmed ? "outline" : "secondary"} className="max-w-full rounded-sm whitespace-normal wrap-anywhere">
      {agent.confirmed && <Check aria-hidden="true" data-icon="inline-start" className="shrink-0" />}
      <span>{agent.name} · {agent.confirmed ? "verified agent" : "unconfirmed"}</span>
    </Badge>
    {showClientId && agent.clientId && <p className="text-xs text-muted-foreground wrap-anywhere"><span className="font-medium">Client ID: </span><span className="font-mono">{agent.clientId}</span></p>}
  </div>;
}
