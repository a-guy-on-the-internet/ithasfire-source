/**
 * A MIRROR of the tRPC `features.getFeatureGates` output — not a subset of the
 * gates this app happens to read.
 *
 * It must mirror, because it is passed as `initialData` to that query
 * (`src/hooks/useFeatureGates.ts`). Structural typing lets you assign a wider
 * object to a narrower type, so "the server returns extra keys, that's fine"
 * is true for a plain assignment — but `initialData` has to SATISFY the
 * query's own data type, and a key missing there is a hard TS2769. Dropping a
 * key here to reflect that the app stopped reading it turns this file red at
 * a call site three directories away.
 *
 * That is exactly what happened to `unifiedScanResolver`: FR-011 removed the
 * `/admin/[slug]/scan` fork (there is now one scan implementation, and the
 * confirm-less legacy camera admit is gone), the key was removed here to
 * match, and `useFeatureGates` stopped compiling. The gate is still returned
 * by the server and still enumerated by the platform-admin settings surface
 * via `packages/types/src/repos/platform-settings.ts`, so it belongs here —
 * no reader in this app consumes it any more, and that is fine.
 *
 * Retire a key from this type only when it is gone from the ROUTER OUTPUT.
 */
export type FeatureGatesSnapshot = {
  travelTime: boolean;
  createEvents: boolean;
  buyTickets: boolean;
  promos: boolean;
  maintenanceMode: boolean;
  /** No longer read by this app (FR-011). Present because the router returns it. */
  unifiedScanResolver: boolean;
  seatingLayouts: boolean;
  waivers: boolean;
  entityPageEditor: boolean;
  broadcasts: boolean;
  resale: boolean;
  humanProfilesPublic: boolean;
  waitlists: boolean;
  arrivalAreas: boolean;
  /**
   * Capability, not a gate: the API can send a text message (it holds SNS
   * credentials). Derived on the server, never a platform setting, so it has
   * no /platform toggle. When false, hide every SMS option.
   */
  sms: boolean;
};
