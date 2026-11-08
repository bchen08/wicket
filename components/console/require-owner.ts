import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { OwnerSessionResponse } from "@/lib/types/frontdesk";

export const requireOwner = cache(async () => {
  const incoming = await headers();
  const host = incoming.get("host");
  if (!host) throw new Error("Unable to determine the owner session API address.");
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  const response = await fetch(`${protocol}://${host}/api/owner/session`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: { cookie: incoming.get("cookie") ?? "" },
  });
  if (!response.ok) redirect("/console/unlock");
  const session: OwnerSessionResponse = await response.json();
  if (!session.signedIn) redirect("/console/unlock");
});
