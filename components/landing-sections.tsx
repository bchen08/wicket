import { ArrowDown, ArrowUpRight, AudioLines, Code2, MoveUpRight, Users } from "lucide-react";
import { ScheduleList } from "@/components/schedule-list";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="hero-grid border-b border-line">
      <div className="page-shell py-16 sm:py-24">
        <p className="eyebrow flex items-center gap-3"><span className="size-2 rounded-full bg-accent" /> Student-led. Future-focused.</p>
        <h1 id="hero-title" className="mt-9 text-[clamp(3.3rem,9.6vw,8.5rem)] leading-[1.02] font-medium tracking-[-0.075em]">What&apos;s next<br />starts <span className="text-accent">with us.</span></h1>
        <div className="mt-9 flex max-w-4xl flex-col justify-between gap-7 sm:flex-row sm:items-end">
          <div className="max-w-md"><p className="text-lg font-medium sm:text-xl">Big ideas. New connections. Real beginnings.</p><p className="mt-3 leading-relaxed text-muted">Emergent is a student-run tech and startup conference for the curious, the ambitious, and the ones ready to build.</p></div>
          <a className="primary-button shrink-0 self-start sm:self-auto" href="#get-involved">Get involved <ArrowUpRight size={18} aria-hidden="true" /></a>
        </div>
        <dl className="mt-14 flex flex-wrap gap-x-12 gap-y-5 border-t border-line pt-6 sm:mt-20">
          <div><dt className="eyebrow text-muted">When</dt><dd className="mt-2 text-sm">Date TBD <span className="text-muted">· Placeholder</span></dd></div>
          <div><dt className="eyebrow text-muted">Where</dt><dd className="mt-2 text-sm">Venue TBD <span className="text-muted">· Placeholder</span></dd></div>
          <div className="ml-auto hidden items-end sm:flex"><a href="#about" className="flex items-center gap-3 text-sm text-muted hover:text-foreground">Meet Emergent <ArrowDown size={16} aria-hidden="true" /></a></div>
        </dl>
      </div>
    </section>
  );
}

const pillars = [
  { number: "01", icon: AudioLines, title: "Ideas worth exploring.", description: "Get a fresh perspective on technology and startups through honest conversations about what comes next." },
  { number: "02", icon: Code2, title: "A builder mindset.", description: "Bring your questions and early ideas. Leave with new ways of thinking and the spark to make something real." },
  { number: "03", icon: Users, title: "Your kind of people.", description: "Meet other students who are figuring it out, dreaming a little bigger, and looking for people to build with." },
];

export function About() {
  return (
    <section id="about" aria-labelledby="about-title" className="page-shell section-space">
      <p className="eyebrow text-muted">01 / About Emergent</p>
      <div className="mt-5 flex flex-col justify-between gap-5 md:flex-row md:items-end"><h2 id="about-title" className="section-title">Curiosity is the<br />only prerequisite.</h2><p className="max-w-sm leading-relaxed text-muted">Built by students, for students. A space to exchange ideas, meet your next collaborator, and find your starting point.</p></div>
      <div className="mt-10 grid gap-4 md:grid-cols-3">{pillars.map(({ number, icon: Icon, title, description }) => <article key={number} className="rounded-lg border border-line bg-surface p-6"><div className="flex items-center justify-between"><Icon size={24} strokeWidth={1.5} aria-hidden="true" /><span className="font-mono text-xs text-muted">{number}</span></div><h3 className="mt-10 text-lg font-medium tracking-tight">{title}</h3><p className="mt-3 text-sm leading-7 text-muted">{description}</p></article>)}</div>
    </section>
  );
}

export function Schedule() {
  return (
    <section id="schedule" aria-labelledby="schedule-title" className="border-y border-line bg-surface"><div className="page-shell section-space">
      <p className="eyebrow text-muted">02 / The schedule</p>
      <h2 id="schedule-title" className="section-title mt-5">Good things in the making.</h2>
      <ScheduleList />
    </div></section>
  );
}

export function GetInvolved() {
  return (
    <section id="get-involved" aria-labelledby="involved-title" className="page-shell section-space">
      <div className="flex flex-col justify-between gap-8 rounded-xl bg-foreground p-8 text-background sm:p-12 md:flex-row md:items-center"><div className="max-w-lg"><p className="eyebrow text-background/65">03 / Get involved</p><h2 id="involved-title" className="section-title mt-6">Make something<br />happen with us.</h2><p className="mt-5 max-w-md leading-relaxed text-background/70">Want to attend, help organize, speak, or support Emergent? There&apos;s room for you here.</p></div><div className="shrink-0"><a href="mailto:?subject=Getting%20involved%20with%20Emergent" className="primary-button bg-background! text-foreground! hover:bg-white!">Let&apos;s talk <MoveUpRight size={18} aria-hidden="true" /></a><p className="mt-4 max-w-52 text-xs leading-5 text-background/65">Contact email TBD · Placeholder.<br />Opens an email draft; recipient to be confirmed.</p></div></div>
    </section>
  );
}
