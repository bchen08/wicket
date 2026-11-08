import type { CSSProperties } from "react";
import { paperTheme } from "@/components/landing-sections";

// The landing page's paper and ink. Only the primary action on each screen uses the accent,
// so the default button takes the accent and hover surfaces stay neutral paper.
export const consoleTheme = {
  ...paperTheme,
  "--primary": "#b3361d",
  "--primary-foreground": "#f5f1e8",
  "--accent": "#e9e3d6",
  "--accent-foreground": "#1d1b18",
  "--ring": "#1d1b18",
} as CSSProperties;
