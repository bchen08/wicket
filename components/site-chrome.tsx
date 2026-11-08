import Link from "next/link";
import { ArrowRight, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";

function Brand() {
  return (
    <a
      href="#top"
      aria-label="Front Desk home"
      className="flex items-center gap-2.5 text-xl font-semibold tracking-[-0.055em]"
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <BellRing
          className="size-[18px]"
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </span>
      front desk<span className="-ml-2 text-primary">.</span>
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="page-shell flex min-h-21 items-center justify-between gap-5">
        <Brand />
        <nav aria-label="Main navigation" className="flex items-center gap-8">
          <a className="nav-link hidden sm:flex" href="#how-it-works">
            How it works
          </a>
          <a className="nav-link hidden md:flex" href="#why-front-desk">
            Why Front Desk
          </a>
          <Button asChild>
            <Link href="/console">
              Get started{" "}
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="page-shell flex flex-col justify-between gap-6 py-8 sm:flex-row sm:items-center">
        <div>
          <Brand />
          <p className="mt-3 text-xs text-muted-foreground">
            A little less admin. A little more business.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <a
            href="#top"
            className="text-xs text-muted-foreground hover:text-primary"
          >
            Back to top ↑
          </a>
          <p className="text-[10px] text-muted-foreground">
            © 2026 Front Desk. Built for the independents.
          </p>
        </div>
      </div>
    </footer>
  );
}
