import "server-only";

import { cache } from "react";
import { notFound } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { getServerTrpcClient } from "@/server/trpc-client";
import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";

/**
 * Public discovery defaults used as the render fail-OPEN fallback: show
 * discovery, no maintenance. Kept in sync with `FeatureGatesSnapshot` — adding
 * a gate to the type forces an update here.
 */
const PUBLIC_FALLBACK_GATES: FeatureGatesSnapshot = {
  travelTime: false,
  createEvents: false,
  buyTickets: false,
  promos: false,
  maintenanceMode: false,
  // Unread since FR-011 (one scan implementation, no fork). Kept because the
  // snapshot must mirror the router output — see the note in
  // `lib/feature-gates/types.ts`.
  unifiedScanResolver: false,
  seatingLayouts: false,
  waivers: false,
  entityPageEditor: false,
  broadcasts: false,
  resale: false,
  // Fail to HIDDEN — the safe direction for a hide-gate. A tRPC/API outage
  // hides public human profiles rather than surfacing links that 404.
  humanProfilesPublic: false,
  // Fail to HIDDEN — the waitlist "notify me" half doesn't exist yet, so an
  // API outage must not surface a join form that promises a notification.
  waitlists: false,
  // Fail to HIDDEN — arrival areas are gated off until the feature ships.
  arrivalAreas: false,
  // Fail to HIDDEN — an SMS option offered while the API's state is unknown
  // could promise a text that never arrives.
  sms: false,
};

type FeatureGatesFetch =
  | { ok: true; gates: FeatureGatesSnapshot }
  | { ok: false };

/**
 * Single request-cached fetch of the feature gates. `getFeatureGatesServer()`
 * (render fail-OPEN) reads from this, so multiple components reading gates in
 * the same RSC tree incur only ONE network round-trip per request. The `ok`
 * discriminant lets the caller distinguish a real fetch from the fallback.
 */
const fetchFeatureGates = cache(async (): Promise<FeatureGatesFetch> => {
  try {
    const client = getServerTrpcClient();
    return { ok: true, gates: await client.features.getFeatureGates.query() };
  } catch (err) {
    // The fallback (PUBLIC_FALLBACK_GATES) is fail-CLOSED for admin surfaces
    // (broadcasts/resale = false), so a persistent tRPC/API outage would
    // silently hide those surfaces with nothing surfaced to operators. Report
    // it, matching the RSC-helper convention in `moderator-access.ts` and the
    // Jun 2026 silent-search-outage postmortem in CLAUDE.md.
    Sentry.captureException(err, {
      tags: { area: "feature-gates", source: "rsc-fetch" },
    });
    return { ok: false };
  }
});

/**
 * Fetch feature gates server-side via tRPC so the first HTML paint already
 * reflects the correct gate state. The result is request-scoped via `cache()`
 * so multiple components reading it in the same RSC tree won't duplicate the
 * fetch.
 *
 * Falls back to public discovery defaults if the API call fails, so a network
 * hiccup never crashes the page.
 */
export const getFeatureGatesServer = cache(
  async (): Promise<FeatureGatesSnapshot> => {
    const result = await fetchFeatureGates();
    // Fail OPEN for rendering — a network hiccup shows discovery, never crashes.
    return result.ok ? result.gates : PUBLIC_FALLBACK_GATES;
  },
);

/**
 * Server-side gate: 404s the calling route when the named feature flag is
 * off. Use at the top of any public server component you want to dark-mode
 * via the platform settings page. Admin/platform editing surfaces aren't
 * affected (they don't call this).
 *
 * Generic by design — adding the next page-level gate is just `await
 * assertFeatureEnabled("newGate")` at the route's top, no new helper
 * function needed.
 */
export async function assertFeatureEnabled(
  gate: keyof FeatureGatesSnapshot,
): Promise<void> {
  const gates = await getFeatureGatesServer();
  if (!gates[gate]) notFound();
}
