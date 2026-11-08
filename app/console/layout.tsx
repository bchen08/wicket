import type { Metadata } from "next";
import { Suspense } from "react";
import { ConsoleNavigation } from "@/components/console/navigation";
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
    <>
      <Suspense fallback={<div className="h-16 border-b border-border" />}>
        <ConsoleNavigation />
      </Suspense>
      {children}
    </>
  );
}
