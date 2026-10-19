import { publicRuntimeEnv } from "@/config/env.public";

/**
 * What the cookie banner is actually asking permission for.
 *
 * Each entry is gated on what actually wires the thing up, so the banner can
 * only ever name storage that really loads — the copy cannot drift out of sync
 * with the code the way hand-maintained cookie tables do.
 *
 * Returns i18n keys rather than resolved strings so callers translate with
 * their own `t`.
 */
export function optionalStorageKeys(): readonly string[] {
  const keys: string[] = [];
  // Sentry is absent on purpose: error capture rides legitimate interest
  // (Recital 49) with `sendDefaultPii: false` and stores nothing on the device.
  // Session replay, which *would* have needed consent, was removed — see the
  // note in `instrumentation-client.ts`.
  //
  // Plausible is absent for a different reason: it is cookieless, so there is
  // no device storage to consent to. See `PlausibleAnalytics`.
  //
  // Which leaves GA as the only thing that can ever put the banner back.
  if (publicRuntimeEnv.gaMeasurementId) {
    keys.push("common.cookieOptionalAnalytics");
  }
  return keys;
}

/**
 * True when at least one non-essential storage use is configured — i.e. when a
 * consent choice is meaningful at all.
 *
 * When false, everything left (session, theme, event unlock, Stripe's fraud
 * checks) is strictly necessary and exempt from consent under ePrivacy
 * Art. 5(3), so both the banner and the footer's "Manage cookies" control
 * hide themselves rather than collect a decision about nothing.
 */
export function hasOptionalStorage(): boolean {
  return optionalStorageKeys().length > 0;
}
