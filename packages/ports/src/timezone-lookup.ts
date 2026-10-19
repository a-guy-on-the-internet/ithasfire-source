/**
 * Timezone-lookup port.
 *
 * Resolves geographic coordinates to an IANA timezone identifier
 * ("America/Chicago"). Consumed by the place upsert path to derive
 * `Place.timezone` from the address coordinates (venue-hierarchy FR-004),
 * and recomputed whenever the address changes.
 *
 * `null` = unknown — the caller keeps its existing/default timezone rather
 * than guessing. The adapter is a LOCAL library over packed timezone-boundary
 * data, NOT a network call, which is why the port is synchronous; keep it
 * that way so place upserts never gain a network dependency through it.
 */
export type TimezoneLookupPort = (lat: number, lng: number) => string | null;
