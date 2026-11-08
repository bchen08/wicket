"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyApprovalLink({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={copy}
        >
          {state === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {state === "copied" ? "Copied" : "Copy link"}
        </Button>
        <a
          href={url}
          className="text-sm text-primary underline underline-offset-4"
        >
          Open approval link
        </a>
      </div>
      <p
        role="status"
        className={
          state === "error" ? "text-sm text-muted-foreground" : "sr-only"
        }
      >
        {state === "copied"
          ? "Approval link copied."
          : state === "error"
            ? "Could not copy automatically. Copy the link below instead."
            : ""}
      </p>
      {state === "error" && (
        <input
          aria-label="Approval link"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
        />
      )}
      <noscript>
        <p className="text-xs text-muted-foreground">
          Use the approval link above. Copying with the button requires
          JavaScript.
        </p>
      </noscript>
    </div>
  );
}
