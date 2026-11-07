"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RefreshBookings() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="shrink-0">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        <RefreshCw aria-hidden="true" data-icon="inline-start" />
        {pending ? "Refreshing…" : "Refresh"}
      </Button>
      <span role="status" className="sr-only">
        {pending ? "Refreshing bookings" : ""}
      </span>
    </div>
  );
}
