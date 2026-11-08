import type { Policies } from "../../types/frontdesk";

/**
 * A shop's policies when it has no policies row. Keep in step with the column defaults in
 * supabase/migrations/0002_rules.sql (and owner_email in 0004_alerts.sql).
 */
export const DEFAULT_POLICIES: Readonly<Policies> = Object.freeze({
  leadTimeMin: 120,
  horizonDays: 30,
  depositHorizonDays: 6,
  cancelWindowHours: 24,
  paused: false,
  phone: null,
  depositRule: "",
  lateCancelRule: "",
  noShowRule: "",
  ownerEmail: null,
});

/**
 * Allowed ranges for each policy field (inclusive). The owner API validates against these; the
 * policies table has matching check constraints.
 */
export const POLICY_LIMITS = {
  leadTimeMin: { min: 0, max: 10_080 }, // up to 7 days
  horizonDays: { min: 1, max: 365 },
  depositHorizonDays: { min: 1, max: 365 },
  cancelWindowHours: { min: 0, max: 720 }, // up to 30 days
  phoneMaxLength: 40,
  ruleMaxLength: 1000,
  ownerEmailMaxLength: 254, // the longest email address SMTP allows
} as const;
