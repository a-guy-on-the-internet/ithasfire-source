// ─────────────────────────────────────────────────────────────────────────────
// OLD SPELLINGS OF PLACE VALUES THAT ARE ALREADY IN THE DATABASE.
//
// The domain term is Place (CONTEXT.md "Places"). Some values written before
// 2026-10-18 carry the old word, and they sit in rows nobody rewrites:
// AuditLog (append-only), BookingRequestMessage (append-only; only `readAt`
// changes), Notification.templateVariables (re-rendered per locale, never
// rewritten), and TTL'd Idempotency keys.
//
// The rule for each value:
//   · writers write the NEW spelling;
//   · readers accept BOTH, normalising the old one to the new one at the read
//     boundary through the helpers below;
//   · this file is the ONE place an old spelling is written down. Every line
//     holding one ends with the `place-term-keep` marker, which the
//     vocabulary guard skips and the rename codemod leaves alone.
//
// Pure and dependency-free on purpose: the web renderer imports it too.
// ─────────────────────────────────────────────────────────────────────────────

/** The marker every old-spelling line in this file carries. */
export const PLACE_TERM_KEEP_MARKER = "place-term-keep";

// ── AuditLog.action ──────────────────────────────────────────────────────────

/** New action → the spelling rows written before 2026-10-18 carry. */
export const LEGACY_AUDIT_ACTIONS = {
  "event.place_confirmed": "event.venue_confirmed", // place-term-keep: stored before 2026-10-18
  "event.place_confirmed_by_grant": "event.venue_confirmed_by_grant", // place-term-keep: stored before 2026-10-18
  "event.place_confirmed_by_manager": "event.venue_confirmed_by_manager", // place-term-keep: stored before 2026-10-18
  "event.place_confirmation_withdrawn": "event.venue_confirmation_withdrawn", // place-term-keep: stored before 2026-10-18
  "booking_request.closed_by_place": "booking_request.closed_by_venue", // place-term-keep: stored before 2026-10-18
} as const;

export type PlaceAuditAction = keyof typeof LEGACY_AUDIT_ACTIONS;

const AUDIT_ACTION_FROM_LEGACY: ReadonlyMap<string, string> = new Map(
  Object.entries(LEGACY_AUDIT_ACTIONS).map(([next, old]) => [old, next]),
);

/** An audit action in its current spelling; an old spelling maps to its new one. */
export function normalizeAuditAction(action: string): string {
  return AUDIT_ACTION_FROM_LEGACY.get(action) ?? action;
}

/**
 * `actions` plus the old spelling of each one that has one, for an exact
 * `action IN (…)` filter that must match rows of both ages. Order kept,
 * no duplicates.
 */
export function auditActionsWithLegacy(
  actions: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const action of actions) {
    if (!out.includes(action)) out.push(action);
    const old = (LEGACY_AUDIT_ACTIONS as Record<string, string>)[action];
    if (old !== undefined && !out.includes(old)) out.push(old);
  }
  return out;
}

// ── BookingRequestMessage.systemKind ─────────────────────────────────────────

/** New ledger kind → the spelling rows written before 2026-10-18 carry. */
export const LEGACY_SYSTEM_ENTRY_KINDS = {
  "booking_request.closed_by_place": "booking_request.closed_by_venue", // place-term-keep: stored before 2026-10-18
  "booking_event.place_confirmed": "booking_event.venue_confirmed", // place-term-keep: stored before 2026-10-18
  "booking_event.place_confirmation_withdrawn": "booking_event.venue_confirmation_withdrawn", // place-term-keep: stored before 2026-10-18
} as const;

const SYSTEM_ENTRY_KIND_FROM_LEGACY: ReadonlyMap<string, string> = new Map(
  Object.entries(LEGACY_SYSTEM_ENTRY_KINDS).map(([next, old]) => [old, next]),
);

/** A ledger kind in its current spelling; null stays null (a human message). */
export function normalizeSystemEntryKind(kind: string | null): string | null {
  if (kind === null) return null;
  return SYSTEM_ENTRY_KIND_FROM_LEGACY.get(kind) ?? kind;
}

// ── Values inside BookingRequestMessage.systemData / AuditLog.data ──────────

/**
 * `ownerSide` (whose event it is) and `by` / `cancelledBy` (who cancelled a
 * booked night): the place side, lowercase. Also what an older web build
 * sends as `ownerOverride` for the length of a deploy.
 */
export const LEGACY_OWNER_SIDE = "venue" as const; // place-term-keep: stored before 2026-10-18
export type LegacyOwnerSide = typeof LEGACY_OWNER_SIDE;

/** `actorSide` / `side` in JSON: the place side of a booking thread, uppercase. */
export const LEGACY_THREAD_SIDE = "VENUE" as const; // place-term-keep: stored before 2026-10-18
export type LegacyThreadSide = typeof LEGACY_THREAD_SIDE;

/** `direction` in `booking_request.opened` params: a request sent to a place. */
export const LEGACY_REQUEST_DIRECTION = "TO_VENUE" as const; // place-term-keep: stored before 2026-10-18
export type LegacyRequestDirection = typeof LEGACY_REQUEST_DIRECTION;

/** `ownerSide`: the old spelling becomes `"place"`; anything else is returned as is. */
export function normalizeOwnerSide<T>(value: T | LegacyOwnerSide): T | "place" {
  return value === LEGACY_OWNER_SIDE ? "place" : (value as T);
}

/** `by` / `cancelledBy`: the old spelling becomes `"place"`; anything else as is. */
export function normalizeCancellerSide<T>(
  value: T | LegacyOwnerSide,
): T | "place" {
  return value === LEGACY_OWNER_SIDE ? "place" : (value as T);
}

/** `actorSide` / `side`: the old spelling becomes `"PLACE"`; anything else as is. */
export function normalizeThreadSide<T>(value: T | LegacyThreadSide): T | "PLACE" {
  return value === LEGACY_THREAD_SIDE ? "PLACE" : (value as T);
}

/** `direction`: the old spelling becomes `"TO_PLACE"`; anything else as is. */
export function normalizeRequestDirection<T>(
  value: T | LegacyRequestDirection,
): T | "TO_PLACE" {
  return value === LEGACY_REQUEST_DIRECTION ? "TO_PLACE" : (value as T);
}

/** Which systemData keys carry which value, and how each is normalised. */
const SYSTEM_DATA_NORMALISERS: Readonly<
  Record<string, (value: unknown) => unknown>
> = {
  ownerSide: normalizeOwnerSide,
  by: normalizeCancellerSide,
  actorSide: normalizeThreadSide,
  direction: normalizeRequestDirection,
};

type LedgerRowShape = {
  systemKind: string | null;
  systemData: Record<string, unknown> | null;
};

/**
 * A ledger row as the current build spells it: the kind and every known
 * place-valued param in their new spelling. Rows that need nothing come back
 * as the SAME object, so a caller can compare by reference.
 */
export function normalizeLegacySystemEntry<T extends LedgerRowShape>(row: T): T {
  const systemKind = normalizeSystemEntryKind(row.systemKind);
  let systemData = row.systemData;
  if (systemData !== null) {
    let copied = false;
    for (const [key, normalise] of Object.entries(SYSTEM_DATA_NORMALISERS)) {
      if (!Object.prototype.hasOwnProperty.call(systemData, key)) continue;
      const before = systemData[key];
      const after = normalise(before);
      if (after === before) continue;
      if (!copied) {
        systemData = { ...systemData };
        copied = true;
      }
      systemData[key] = after;
    }
  }
  if (systemKind === row.systemKind && systemData === row.systemData) {
    return row;
  }
  return { ...row, systemKind, systemData };
}

// ── Idempotency.key for place-confirmation notifications ────────────────────

/**
 * The notification key `{prefix}:{eventId}:{kind}:{at}:{humanId}` stays
 * byte-identical to the keys claimed before 2026-10-18, so a confirmation
 * dispatched on either side of a deploy claims the same key and is sent once.
 * The intent kinds are spelled the new way in code; the key spells them the
 * old way, from here.
 */
export const LEGACY_PLACE_CONFIRMATION_KEY_PREFIX = "venue-confirmation"; // place-term-keep: Idempotency.key format kept byte-identical
export const LEGACY_PLACE_CONFIRMATION_KEY_KINDS = {
  "event.place_confirmed": "event.venue_confirmed", // place-term-keep: Idempotency.key format kept byte-identical
  "event.place_confirmation_withdrawn": "event.venue_confirmation_withdrawn", // place-term-keep: Idempotency.key format kept byte-identical
} as const;
