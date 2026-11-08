import "server-only";
import { headers } from "next/headers";
import { readResponse } from "@/components/console/api";
export async function loadSettings<T>(path: string): Promise<T> {
  const incoming = await headers();
  const host = incoming.get("host");
  if (!host) throw new Error("Unable to determine the shop API address.");
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
    ? "http"
    : "https";
  return readResponse<T>(
    await fetch(`${protocol}://${host}/api/shops/harts/${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: { cookie: incoming.get("cookie") ?? "" },
    }),
  );
}
