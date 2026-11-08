import type { Metadata } from "next";
import { Suspense } from "react";
import { ConsoleNavigation } from "@/components/console/navigation";
import { consoleTheme } from "@/components/console/console-theme";
export const metadata: Metadata = {
  title: "Shop settings — Front Desk",
  robots: { index: false, follow: false },
};
export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={consoleTheme}
      className="flex min-h-full flex-1 flex-col bg-background font-sans text-foreground"
    >
      <Suspense fallback={<div className="h-14 border-b border-border" />}>
        <ConsoleNavigation />
      </Suspense>
      {children}
    </div>
  );
}
