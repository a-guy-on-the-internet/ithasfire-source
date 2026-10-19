import type { FeatureGatesSnapshot } from "./types";

/**
 * Build a fully-typed `FeatureGatesSnapshot` for tests, with all flags off
 * by default. Pass an `overrides` object to flip individual gates.
 *
 * Defining defaults in one place means adding a new gate to
 * `FeatureGatesSnapshot` immediately fails the type checker here — which is
 * the point: tests that previously mocked a Partial-shaped object no longer
 * silently rot when the snapshot grows.
 */
export function makeFeatureGates(
  overrides: Partial<FeatureGatesSnapshot> = {},
): FeatureGatesSnapshot {
  const defaults: FeatureGatesSnapshot = {
    travelTime: false,
    createEvents: false,
    buyTickets: false,
    promos: false,
    maintenanceMode: false,
    unifiedScanResolver: false,
    seatingLayouts: false,
    waivers: false,
    entityPageEditor: false,
    broadcasts: false,
    resale: false,
    humanProfilesPublic: false,
    waitlists: false,
    arrivalAreas: false,
    sms: false,
  };
  return { ...defaults, ...overrides };
}
