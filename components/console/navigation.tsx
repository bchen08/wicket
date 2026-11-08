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
      <div className="mx-auto flex max-w-3xl gap-1 px-4 pt-4 sm:px-8">
        {links.map(([label, href]) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
            className={cn(
              "flex min-h-12 flex-1 items-center justify-center rounded-t-lg border-b-2 px-2 text-sm font-medium transition-colors",
              pathname === href
                ? "border-primary bg-accent text-primary"
                : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
