export interface PlatformSettingRecord {
  key: string;
  value: string;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * All recognised feature gate slugs. Each maps to a `PlatformSetting` row
 * with key `feature:<slug>` and value `"true"` or `"false"`.
 *
 * Env-driven defaults live in the `getFeatureGates` use case; DB values
 * override them at runtime so platform admins can toggle without a redeploy.
 *
 * Source of truth for both the runtime Zod enums (admin update/get use
 * cases) and the compile-time `FeatureGateSlug` union — keep these in
 * sync with `featureGatesSchema` in
 * `packages/core/src/use-cases/features/get-feature-gates.ts`.
 */
export const FEATURE_GATE_SLUGS = [
  "travelTime",
  "createEvents",
  "buyTickets",
  "promos",
  "maintenanceMode",
  "seatingLayouts",
  /**
   * DEAD FOR THE SCAN PAGE. `/admin/[slug]/scan` no longer reads this gate:
   * spec `docs/specs/2026-08-04/completed/scan-ticket-redesign.spec.yaml` FR-011 deleted
   * the legacy/unified fork and `UnifiedScanView` is now the only
   * implementation, so toggling it changes nothing about scanning.
   *
   * The slug is kept because this list is shared with the platform-admin
   * settings surface and the env default in
   * `packages/core/src/use-cases/features/get-feature-gates.ts`; removing it is
   * a separate, cross-surface change (settings rows, the admin enum, apps/api/src/lib/env.ts).
   */
  "unifiedScanResolver",
  "waivers",
  "entityPageEditor",
  "broadcasts",
  "resale",
  "humanProfilesPublic",
  "waitlists",
  /**
   * Parking, accessible drop-off and load-in drawn on place and event maps
   * (`docs/specs/2026-10-16/arrival-areas.spec.yaml` FR-017). Off by default.
   */
  "arrivalAreas",
] as const;

export type FeatureGateSlug = (typeof FEATURE_GATE_SLUGS)[number];

/**
 * Fully-qualified `feature:<slug>` keys, ready to plug into a `z.enum()`
 * alongside the other top-level platform settings.
 */
export const FEATURE_GATE_SETTING_KEYS = [
  "feature:travelTime",
  "feature:createEvents",
  "feature:buyTickets",
  "feature:promos",
  "feature:maintenanceMode",
  "feature:seatingLayouts",
  "feature:unifiedScanResolver",
  "feature:waivers",
  "feature:entityPageEditor",
  "feature:broadcasts",
  "feature:resale",
  "feature:humanProfilesPublic",
  "feature:waitlists",
  "feature:arrivalAreas",
] as const;

/** Well-known platform setting keys. */
export type PlatformSettingKey =
  | "supportEmail"
  | "platformName"
  // Physical mailing address shown in email footers for CAN-SPAM compliance.
  | "email:physicalAddress"
  | "themePresets"
  | "activeThemePreset"
  | "resale:payoutReleaseOverrideAllowlist"
  // ── POS / Stripe Terminal ──
  | "pos:terminalLocationId"
  // ── Feature gates (boolean stored as "true" / "false") ──
  | `feature:${FeatureGateSlug}`
  // ── Homepage display settings ──
  | "homepage:heroStyle"
  // ── Moderation ──
  /**
   * Edge-trigger state for the hourly `moderation.report-queue-health` job:
   * JSON `{ fingerprint, sentAt }` describing the last problem picture that
   * was actually paged out. Written by the job and deliberately absent from
   * `UPDATABLE_PLATFORM_SETTING_KEYS` — it is operational state that happens
   * to live in a key/value table, not configuration, so no admin surface may
   * write it. An empty string means "no outstanding problem".
   */
  | "moderation:queueHealthAlertState"
  // ── Memberships ──
  /**
   * Edge-trigger state for the daily `memberships.report-health` job. Same
   * JSON `{ fingerprint, sentAt }` shape and same rules as the moderation key
   * above — one row per health gate, never shared, because two jobs writing
   * one fingerprint would suppress each other's incidents. Also deliberately
   * absent from `UPDATABLE_PLATFORM_SETTING_KEYS`: operational state, not
   * configuration.
   */
  | "memberships:healthAlertState";
