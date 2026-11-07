import { About, GetInvolved, Hero, Schedule } from "@/components/landing-sections";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export default function Home() {
  return (
    <div id="top">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <SiteHeader />
      <main id="main-content">
        <Hero />
        <About />
        <Schedule />
        <GetInvolved />
      </main>
      <SiteFooter />
    </div>
  );
}
