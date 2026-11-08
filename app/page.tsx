import {
  Footer,
  ForAgents,
  ForTheShop,
  Hero,
  Masthead,
  WhatHappens,
  paperTheme,
} from "@/components/landing-sections";

export default function Home() {
  return (
    <div style={paperTheme} className="flex min-h-full flex-1 flex-col bg-background text-foreground">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <Masthead />
      <main id="main-content" className="flex-1">
        <Hero />
        <WhatHappens />
        <ForTheShop />
        <ForAgents />
      </main>
      <Footer />
    </div>
  );
}
