import {
  BusinessStrip,
  Features,
  Hero,
  HowItWorks,
} from "@/components/landing-sections";
import { GetStarted } from "@/components/get-started";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export default function Home() {
  return (
    <div id="top">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main-content">
        <Hero />
        <BusinessStrip />
        <Features />
        <HowItWorks />
        <GetStarted />
      </main>
      <SiteFooter />
    </div>
  );
}
