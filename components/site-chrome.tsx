import { ArrowUp, ArrowUpRight } from "lucide-react";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-background/95 backdrop-blur-md">
      <div className="page-shell flex min-h-20 flex-wrap items-center justify-between gap-x-5 gap-y-2 py-3">
        <a href="#top" aria-label="Emergent — back to top" className="text-2xl font-semibold tracking-[-0.06em]">emergent<span className="text-accent">.</span></a>
        <nav aria-label="Main navigation" className="flex items-center gap-5 text-xs sm:gap-8 sm:text-sm"><a className="nav-link" href="#about">About</a><a className="nav-link" href="#schedule">Schedule</a><a className="nav-link flex items-center gap-1.5" href="#get-involved">Get involved <ArrowUpRight size={14} aria-hidden="true" /></a></nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line"><div className="page-shell flex flex-col justify-between gap-6 py-8 sm:flex-row sm:items-center"><div><a href="#top" className="text-xl font-semibold tracking-[-0.06em]">emergent<span className="text-accent">.</span></a><p className="mt-2 text-xs text-muted">Student-run. Built for what&apos;s next.</p></div><a href="#top" className="flex items-center gap-2 self-start text-xs text-muted hover:text-foreground sm:self-auto">Back to top <ArrowUp size={14} aria-hidden="true" /></a></div></footer>
  );
}
