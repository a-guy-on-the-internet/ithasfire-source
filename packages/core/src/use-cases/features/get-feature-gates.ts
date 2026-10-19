import { z } from "zod";
import type { RoutingPort } from "@th/ports/routing.port";
import type { PlatformSettingsRepo } from "@th/ports/repos/platform-settings";
import type { ReporterPort } from "@th/ports/reporter";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getFeatureGatesInputSchema = z.void();

/**
 * Each key is a camelCase feature slug; the value signals whether the
 * backend has the feature configured and ready.
 *
 * Clients use this to conditionally render UI (e.g. travel-time widget
 * below the map) without hard-coding env awareness into the frontend.
 *
 * ── KEEP IN SYNC ─────────────────────────────────────────────────────
 * The slugs below must match `FEATURE_GATE_SLUGS` /
 * `FEATURE_GATE_SETTING_KEYS` in
 * `packages/types/src/repos/platform-settings.ts`. Those tuples drive
 * the Zod enums for the admin update/get use cases — if a slug here
 * isn't in those tuples, admins can't toggle it from the UI and the
 * "Invalid option: expected one of …" error gets thrown.
 */
export const featureGatesSchema = z.object({
  travelTime: z.boolean(),
  /** When false, event creation mutations are rejected and the UI hides "Create Event". */
  createEvents: z.boolean(),
  /** When false, checkout / ticket-purchase mutations are rejected and the "Get Tickets" CTA is hidden. */
  buyTickets: z.boolean(),
  /** When false, promo-code admin UI and mutations are hidden. */
  promos: z.boolean(),
  /**
   * When true, the entire public site is in maintenance mode.
   * All public routes redirect to a maintenance page. Admin/platform routes remain accessible.
   */
  maintenanceMode: z.boolean(),
  /** When false, venue seating layouts, the Seating tab, and Places nav are hidden. */
  seatingLayouts: z.boolean(),
  /**
   * When true, the admin web `/scan` surface uses the unified resolver flow
   * (single camera + manual search → `scan.resolvePayload`). When false the
   * legacy two-mode (lookup/camera, ticket-only) page is rendered. Default
   * is `false` until the resolver UX is rolled out.
   */
  unifiedScanResolver: z.boolean(),
  /**
   * When false, the per-event waiver / liability section in the event builder
   * is hidden, and the waiver-acceptance gate at checkout is bypassed. Default
   * is `false` until the legal copy + acceptance audit log are signed off.
   */
  waivers: z.boolean(),
  /**
   * When true, the freeform entity-page block editor (grid/stack canvas) is
   * unlocked for artist/venue/promoter pages. When false (the default),
   * pages use the app-controlled standard template. Default is `false` — the
   * editor is an opt-in unlock a platform admin flips on.
   */
  entityPageEditor: z.boolean(),
  /**
   * When false (the default), the org-level messaging CRM is hidden: the
   * audiences surface (lists + import) and the announcements surface. These
   * are a unit — announcements send to audiences — so one gate covers both.
   * Off by default until outbound email/SMS blasting is vetted for
   * compliance/deliverability.
   */
  broadcasts: z.boolean(),
  /**
   * When false (the default), the ticket-resale surfaces are hidden: the org
   * resale listings page and the resale-policy settings page. Off by default
   * until the resale flow is vetted.
   */
  resale: z.boolean(),
  /**
   * When false (the default), the PUBLIC human ("user account") entity-page
   * profiles are hidden: `/humans/[slug]` and the HUMAN variant of `/p/[slug]`
   * 404, and humans are dropped from public search. Org/place profiles and the
   * human's own admin/ownership surfaces are UNAFFECTED. This is a HIDE gate —
   * fail-closed to hidden — kept off until an editor exists.
   */
  humanProfilesPublic: z.boolean(),
  /**
   * When false (the default), the event waitlist ("notify me") surfaces are
   * hidden: the public join form on the event page and the organiser-side
   * waitlist configuration in the event builder. Off by default because only
   * the join half exists — nothing sets `NOTIFIED`, there's no release
   * trigger, job, or admin roster — so the capability stays dark until the
   * notify half ships.
   */
  waitlists: z.boolean(),
  /**
   * When false (the default), arrival areas (parking, accessible drop-off and
   * load-in drawn on place and event maps) are hidden everywhere: the map
   * shapes, the "Getting there" list and the editors
   * (`docs/specs/2026-10-16/arrival-areas.spec.yaml` FR-017). No env flag:
   * like `seatingLayouts`, it is turned on only from the /platform toggle.
   */
  arrivalAreas: z.boolean(),
});

/**
 * Capabilities: what the backend is wired to do, reported beside the gates.
 *
 * Unlike the gates above, a capability is DERIVED from the composition root
 * (which adapters exist), never stored. It has no `feature:<slug>` row, no
 * entry in `FEATURE_GATE_SLUGS`, and no /platform toggle — a DB row cannot
 * claim the API can do something it is not wired to do.
 */
export const featureCapabilitiesSchema = z.object({
  /**
   * True iff the API holds an SMS adapter (SNS credentials set). When false,
   * clients hide every SMS option; phone OTP refuses with 503 rather than
   * pretending a code was sent. Comes back on its own when the keys are set.
   */
  sms: z.boolean(),
});

export const getFeatureGatesOutputSchema = featureGatesSchema.extend(
  featureCapabilitiesSchema.shape,
);

export type FeatureGates = z.infer<typeof featureGatesSchema>;
export type GetFeatureGatesInput = z.infer<typeof getFeatureGatesInputSchema>;
export type GetFeatureGatesOutput = z.infer<typeof getFeatureGatesOutputSchema>;

export type GetFeatureGatesDeps = {
  routing?: RoutingPort | null;
  /** Env-driven flag: allow event creation. Defaults to true when omitted. */
  enableCreateEvents?: boolean;
  /** Env-driven flag: allow ticket purchasing. Defaults to true when omitted. */
  enableBuyTickets?: boolean;
  /** Env-driven flag: allow promo codes. Defaults to true when omitted. */
  enablePromos?: boolean;
  /** Env-driven flag: put the public site into maintenance mode. Defaults to false when omitted. */
  enableMaintenanceMode?: boolean;
  /** Env-driven flag: enable the unified scan resolver UI on admin web. Defaults to false when omitted. */
  enableUnifiedScanResolver?: boolean;
  /** Env-driven flag: surface waiver section in event builder + checkout gate. Defaults to false when omitted. */
  enableWaivers?: boolean;
  /** Env-driven flag: unlock the freeform entity-page block editor. Defaults to false when omitted. */
  enableEntityPageEditor?: boolean;
  /** Env-driven flag: surface the audiences + announcements messaging CRM. Defaults to false when omitted. */
  enableBroadcasts?: boolean;
  /** Env-driven flag: surface the ticket-resale admin surfaces. Defaults to false when omitted. */
  enableResale?: boolean;
  /** Env-driven flag: surface PUBLIC human entity-page profiles. Defaults to false when omitted. */
  enableHumanProfilesPublic?: boolean;
  /** Env-driven flag: surface the event waitlist ("notify me") surfaces. Defaults to false when omitted. */
  enableWaitlists?: boolean;
  /**
   * Capability: the API holds an SMS adapter. Never overridden by a DB row.
   * Defaults to false when omitted (fail closed: hide SMS options).
   */
  smsConfigured?: boolean;
  /**
   * Optional platform-settings repo. When provided, the use case reads
   * `feature:*` rows and lets DB values override env defaults.
   */
  platformSettings?: PlatformSettingsRepo | null;
  /**
   * Optional best-effort error reporter. Fired when the DB read of the
   * `feature:*` settings fails and the gates silently fall back to env
   * defaults. Never affects output. Important because gates like
   * `broadcasts`/`resale` are FAIL-CLOSED — a persistent settings outage would
   * otherwise silently hide admin surfaces with nothing reported (cf. the
   * 2026-06 silent-search outage).
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a DB value as a boolean override.
 * Returns `undefined` when the key is missing so the env default wins.
 */
function parseBoolOverride(
  value: string | undefined | null,
): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current set of optional feature gates.
 *
 * Resolution order (per gate):
 *   1. DB override (PlatformSetting `feature:<slug>` = "true"|"false")
 *   2. Env-driven dep flag (e.g. `enableCreateEvents`)
 *   3. Hardcoded default (usually `true`)
 *
 * Capabilities (`sms`) skip all three: they come only from the deps.
 */
export async function getFeatureGates(
  deps: GetFeatureGatesDeps,
): Promise<GetFeatureGatesOutput> {
  const gates = await resolveGates(deps);
  return { ...gates, sms: deps.smsConfigured ?? false };
}

async function resolveGates(deps: GetFeatureGatesDeps): Promise<FeatureGates> {
  // ── Env defaults ──────────────────────────────────────────────────────
  const envDefaults: FeatureGates = {
    travelTime: deps.routing != null,
    createEvents: deps.enableCreateEvents ?? true,
    buyTickets: deps.enableBuyTickets ?? true,
    promos: deps.enablePromos ?? true,
    maintenanceMode: deps.enableMaintenanceMode ?? false,
    seatingLayouts: false,
    unifiedScanResolver: deps.enableUnifiedScanResolver ?? false,
    waivers: deps.enableWaivers ?? false,
    entityPageEditor: deps.enableEntityPageEditor ?? false,
    broadcasts: deps.enableBroadcasts ?? false,
    resale: deps.enableResale ?? false,
    humanProfilesPublic: deps.enableHumanProfilesPublic ?? false,
    waitlists: deps.enableWaitlists ?? false,
    arrivalAreas: false,
  };

  // ── DB overrides (optional) ───────────────────────────────────────────
  if (!deps.platformSettings) return envDefaults;

  try {
    const allSettings = await deps.platformSettings.getAll();
    const featureMap = new Map<string, string>();
    for (const row of allSettings) {
      if (row.key.startsWith("feature:")) {
        featureMap.set(row.key.replace("feature:", ""), row.value);
      }
    }

    // If no feature keys exist in DB, return env defaults
    if (featureMap.size === 0) return envDefaults;

    return {
      travelTime:
        parseBoolOverride(featureMap.get("travelTime")) ??
        envDefaults.travelTime,
      createEvents:
        parseBoolOverride(featureMap.get("createEvents")) ??
        envDefaults.createEvents,
      buyTickets:
        parseBoolOverride(featureMap.get("buyTickets")) ??
        envDefaults.buyTickets,
      promos: parseBoolOverride(featureMap.get("promos")) ?? envDefaults.promos,
      maintenanceMode:
        parseBoolOverride(featureMap.get("maintenanceMode")) ??
        envDefaults.maintenanceMode,
      seatingLayouts:
        parseBoolOverride(featureMap.get("seatingLayouts")) ??
        envDefaults.seatingLayouts,
      unifiedScanResolver:
        parseBoolOverride(featureMap.get("unifiedScanResolver")) ??
        envDefaults.unifiedScanResolver,
      waivers:
        parseBoolOverride(featureMap.get("waivers")) ?? envDefaults.waivers,
      entityPageEditor:
        parseBoolOverride(featureMap.get("entityPageEditor")) ??
        envDefaults.entityPageEditor,
      broadcasts:
        parseBoolOverride(featureMap.get("broadcasts")) ??
        envDefaults.broadcasts,
      resale:
        parseBoolOverride(featureMap.get("resale")) ?? envDefaults.resale,
      humanProfilesPublic:
        parseBoolOverride(featureMap.get("humanProfilesPublic")) ??
        envDefaults.humanProfilesPublic,
      waitlists:
        parseBoolOverride(featureMap.get("waitlists")) ?? envDefaults.waitlists,
      arrivalAreas:
        parseBoolOverride(featureMap.get("arrivalAreas")) ??
        envDefaults.arrivalAreas,
    };
  } catch (err) {
    // If DB read fails, fall back to env defaults. This is a deliberate
    // catch-and-fallback, so report it — the gates are FAIL-CLOSED, so a
    // persistent settings outage would otherwise silently hide admin surfaces
    // (broadcasts/resale) with nothing surfaced to operators.
    try {
      deps.reportError?.(err, {
        tags: { useCase: "get-feature-gates" },
        extra: { stage: "platform-settings-read" },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful env-defaults fallback into a thrown error.
    }
    return envDefaults;
  }
}
