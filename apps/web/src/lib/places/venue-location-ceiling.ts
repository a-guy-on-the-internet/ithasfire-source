/**
 * THE CEILING: an event can never be more precise in public than the venue it
 * is at.
 *
 * The guarantee lives on the server — `save-event-shared` clamps inside the
 * save transaction against the place row it reads in that same transaction,
 * and `buildEventSeo` re-clamps on READ so flipping a venue to withheld hides
 * events that were already published there. Both use core's
 * `applyPlaceLocationFloor`.
 *
 * This module is the UI half, and it is a COURTESY, not the guarantee: it
 * exists so an organizer is told why the exact-address option is unavailable
 * instead of submitting a choice the server silently overrules. Nothing here
 * protects anyone from a direct API call, a template, a series generator, or a
 * third party creating a community listing at somebody's house — that is what
 * the transaction is for.
 *
 * FAIL-CLOSED: `checking` is the state while the venue's setting is unknown,
 * and it locks the exact option just like a confirmed withhold does. A query
 * that never resolves therefore leaves the option off rather than on.
 */

export type VenueLocationCeiling =
  /** No venue selected, or a venue that publishes its address. Nothing to inherit. */
  | { state: "none" }
  /** The venue's setting has not been read yet (or the read failed). */
  | { state: "checking" }
  /** The venue publishes an obfuscated circle — events cannot be tighter than it. */
  | { state: "area"; venueName: string; radiusMeters: number }
  /** The venue publishes no map at all — neither may anything hosted in it. */
  | { state: "hidden"; venueName: string };

/** Does this ceiling forbid the exact-address option? */
export function ceilingLocksExact(ceiling: VenueLocationCeiling): boolean {
  return ceiling.state !== "none";
}

/**
 * The floor this ceiling imposes on an event's obfuscation radius, in metres.
 * `null` when there is none. A `hidden` venue has no radius floor because it
 * removes the circle entirely — the radius is forced to null instead.
 */
export function ceilingRadiusFloor(
  ceiling: VenueLocationCeiling,
): number | null {
  return ceiling.state === "area" ? ceiling.radiusMeters : null;
}

/**
 * Clamp an event's requested privacy to the ceiling. Mirrors core's
 * `applyPlaceLocationFloor` exactly — including that a null (fully hidden)
 * event radius survives a circle ceiling, because null is MORE private than
 * any circle, not less.
 *
 * `checking` deliberately does NOT clamp. Locking the control is enough while
 * the answer is unknown; rewriting an organizer's saved choice on the strength
 * of a read that has not come back would be the UI inventing a policy.
 */
export function clampToCeiling(
  requested: { mode: "EXACT" | "OBSCURED"; radiusMeters: number | null },
  ceiling: VenueLocationCeiling,
): { mode: "EXACT" | "OBSCURED"; radiusMeters: number | null } {
  if (ceiling.state === "none" || ceiling.state === "checking") return requested;
  if (ceiling.state === "hidden") {
    return { mode: "OBSCURED", radiusMeters: null };
  }
  if (requested.mode !== "EXACT" && requested.radiusMeters === null) {
    return { mode: "OBSCURED", radiusMeters: null };
  }
  const requestedRadius =
    requested.mode === "EXACT" ? null : requested.radiusMeters;
  return {
    mode: "OBSCURED",
    radiusMeters:
      requestedRadius === null
        ? ceiling.radiusMeters
        : Math.max(requestedRadius, ceiling.radiusMeters),
  };
}

// ── Reads of the selected place (`places.getPlacePublic`, …) ───────────────
//
// Both helpers below keep the fail-closed rule: whatever the read does, a
// place with no answer stays `checking`, which locks the exact option.

export type PlacePrivacyReadError =
  | {
      data?: { code?: string; appCode?: string } | null;
      shape?: { data?: { code?: string; appCode?: string } | null } | null;
    }
  | null
  | undefined;

function readCodes(error: PlacePrivacyReadError): {
  code: string | undefined;
  appCode: string | undefined;
} {
  const data = error?.data ?? error?.shape?.data ?? undefined;
  return { code: data?.code, appCode: data?.appCode };
}

/** tRPC codes a second attempt can plausibly turn into an answer. */
const TRANSIENT_TRPC_CODES: ReadonlySet<string> = new Set([
  "INTERNAL_SERVER_ERROR",
  "TIMEOUT",
  "BAD_GATEWAY",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
]);

/**
 * Retry a read of the selected place (its privacy projection, its booking
 * options) once, and only when asking again could change the answer: no response at all (no tRPC code) or a server-side fault. A
 * refusal the server decided — the place is archived or gone (NOT_FOUND), the
 * input is bad — is the answer, and a retry only doubles the logged failure.
 * TOO_MANY_REQUESTS (429) is deliberately not retried either: an immediate
 * second request only adds to the limit it just hit, and the read fails
 * closed (`checking` locks the exact option) until the next fetch.
 */
export function shouldRetryPlacePrivacyRead(
  failureCount: number,
  error: PlacePrivacyReadError,
): boolean {
  if (failureCount >= 1) return false;
  const { code } = readCodes(error);
  return code === undefined || TRANSIENT_TRPC_CODES.has(code);
}

/**
 * An archived place answers the privacy read with NOT_FOUND / PLACE_ARCHIVED.
 * The event builder turns this answer into its own inline "… is archived.
 * Pick another place." notice (location field and the address-visibility
 * lock), so the failure is a handled state, not an incident: the global
 * query logger (console, Sentry, toast) skips it via `meta.silentWhen`. Any
 * other failure of the same read is still reported. A caller that silences
 * with this MUST show the archived state itself; silencing alone leaves the
 * organizer with no signal.
 */
export function isArchivedPlacePrivacyRead(
  error: PlacePrivacyReadError,
): boolean {
  const { code, appCode } = readCodes(error);
  return code === "NOT_FOUND" && appCode === "PLACE_ARCHIVED";
}
