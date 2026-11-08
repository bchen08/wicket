"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/utils";
const links = [
  ["Bookings", "/console"],
  ["Services", "/console/services"],
  ["Hours", "/console/hours"],
  ["Rules", "/console/rules"],
  ["Agents", "/console/agents"],
] as const;
export function ConsoleNavigation() {
  const pathname = usePathname();
  if (pathname === "/console/unlock") return null;
  return (
    <nav
      aria-label="Owner console"
      className="border-b border-border bg-background"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-x-6 px-6 sm:gap-x-8 sm:px-10">
        {links.map(([label, href]) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
            className={cn(
              "flex min-h-14 items-center text-sm underline-offset-4 transition-colors",
              pathname === href
                ? "text-foreground underline"
                : "text-muted-foreground hover:text-foreground hover:underline",
            )}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
