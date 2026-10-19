import type { TxRepos } from "@th/ports/repos";
import type {
  BookingHoldRecord,
  BookingHoldReleaseReason,
  BookingHoldStatus,
  SetBookingHoldRespondByInput,
  UpdateBookingHoldStatusInput,
} from "@th/ports/repos/booking-holds";
import { fail } from "@th/errors";

import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";
import type { BookingHoldNotificationIntent } from "./booking-hold-intents";
import { recordFirstReadyIfReady } from "./night-readiness";

// ─────────────────────────────────────────────────────────────────────────────
// Line mechanics shared by every hold transition. Positions are NEVER
// computed by arithmetic (spec risk #3): a line is renumbered from ONE
// ordered read inside the caller's transaction, and "who moved" is the diff
// between that read and the renumbered result.
//
// LOCKING: every read that a write depends on happens under the line's
// transaction advisory lock (`lockLine`, the key the adapter's `create` /
// `renumberLine` also take; `pg_advisory_xact_lock` is re-entrant within a
// transaction, so a caller that already locked via `settleLine` pays
// nothing). When one transaction touches SEVERAL lines (a request closure,
// a confirm with sibling holds) the keys are locked in SORTED order —
// `sortLineKeys` — so two such transactions can never wait on each other in
// opposite orders (deadlock). Postgres still detects a cycle from any lock
// this code does not control; the adapter maps that (40P01 / P2034) to the
// same retryable shape as a stale line, which core surfaces as
// HOLD_LINE_CHANGED: "refresh and try again", never an adapter internal.
//
// GRANTS BEFORE LINES. The global order is:
//   1. the place lock (`placeBookingGrants.lockPlace`: give, a calendar
//      edit, and a PLACE placement that names a party, for its notice cap);
//   2. a booking grant's ROW lock;
//   3. line locks, in `sortLineKeys` order.
// Never the other way round: a transaction holding a line lock never waits
// on a grant or the place lock. Who takes the grant row:
//   - revoke and update WRITE it (`UPDATE`, a FOR NO KEY UPDATE row lock),
//     revoke before it locks its holds' lines;
//   - a BOOKER placement reads it `FOR SHARE` (`lockSharedAtPlace`) BEFORE
//     the line lock and re-checks active + accepted + in scope + holder on
//     the row it locked. FOR SHARE conflicts with the writers' lock, so a
//     revoke or a rescoping update and a placement serialise on the grant
//     row: the placement either commits first (and the revoke then sees its
//     hold) or reads the revoked / rescoped row and is refused. The hold's
//     FK check takes only KEY SHARE, which does NOT conflict with those
//     writes, so the FK alone would let a hold commit on a revoked grant.
// One grant row per placement transaction, so FOR SHARE readers never wait
// on each other in a cycle.
// ─────────────────────────────────────────────────────────────────────────────

export type HoldLineKey = { calendarId: string; date: string };

export function lineKeyOf(
  hold: Pick<BookingHoldRecord, "calendarId" | "date">,
): string {
  return `${hold.calendarId}|${hold.date}`;
}

/**
 * The position a new hold takes at the BACK of a live line: one past the
 * highest live position, never `line.length + 1`. A line can carry a gap
 * nobody renumbered (holds-without-a-request item f: deleting an org
 * CASCADEs its holds out of a line without a renumber), and a count would
 * then hand out a position some live hold already has.
 */
export function nextLinePosition(
  line: readonly Pick<BookingHoldRecord, "position">[],
): number {
  return line.reduce((max, hold) => Math.max(max, hold.position), 0) + 1;
}

/** Deterministic global lock order for a set of lines. */
export function sortLineKeys(keys: Iterable<HoldLineKey>): HoldLineKey[] {
  return [...keys].sort((a, b) =>
    a.calendarId < b.calendarId
      ? -1
      : a.calendarId > b.calendarId
        ? 1
        : a.date < b.date
          ? -1
          : a.date > b.date
            ? 1
            : 0,
  );
}

/** Distinct line keys of a set of holds, in lock order. */
export function lineKeysOf(
  holds: readonly Pick<BookingHoldRecord, "calendarId" | "date">[],
): HoldLineKey[] {
  const seen = new Map<string, HoldLineKey>();
  for (const hold of holds) {
    seen.set(lineKeyOf(hold), { calendarId: hold.calendarId, date: hold.date });
  }
  return sortLineKeys(seen.values());
}

/** Lock a set of lines in the global order. */
export async function lockLines(
  tx: TxRepos,
  keys: Iterable<HoldLineKey>,
): Promise<void> {
  for (const key of sortLineKeys(keys)) {
    await tx.bookingHolds.lockLine(key);
  }
}

/** A hold whose position changed in a renumber, with both ends. */
export type MovedHold = { hold: BookingHoldRecord; from: number; to: number };

/**
 * Read the live line, renumber it in `orderedIds` order (default: its current
 * order, i.e. close the gaps a release left), and return the movers.
 *
 * Takes the line lock FIRST (re-entrant for callers that already hold it), so
 * the read and the rewrite see the same membership. `orderedIds` MUST be a
 * permutation of the live set — a stale reorder surfaces as HOLD_LINE_CHANGED.
 * When the line is empty nothing is written.
 */
export async function renumberLine(
  tx: TxRepos,
  key: HoldLineKey,
  orderedIds?: readonly string[],
): Promise<{ line: BookingHoldRecord[]; moved: MovedHold[] }> {
  await tx.bookingHolds.lockLine(key);
  const before = await tx.bookingHolds.listLine(key);
  if (before.length === 0) {
    return { line: [], moved: [] };
  }
  const order = orderedIds ?? before.map((hold) => hold.id);
  let after: BookingHoldRecord[];
  try {
    after = await tx.bookingHolds.renumberLine({
      calendarId: key.calendarId,
      date: key.date,
      orderedIds: order,
    });
  } catch (error) {
    rethrowHoldLineConflict(error, key);
  }
  const previousPosition = new Map(before.map((h) => [h.id, h.position]));
  const moved: MovedHold[] = [];
  for (const hold of after) {
    const from = previousPosition.get(hold.id);
    if (from !== undefined && from !== hold.position) {
      moved.push({ hold, from, to: hold.position });
    }
  }
  return { line: after, moved };
}

/**
 * Who caused a line to move, for the movers' ledger entries.
 *
 * `humanId` is stamped as `authorHumanId` on `booking_hold.reordered` — which
 * the OTHER request's thread renders. An ACT must never learn who else is in
 * line (FR-013), so an act actor is stamped ONLY on its own request's thread
 * (`ownRequestId`); every foreign mover gets `null` (machine-caused, as far
 * as that thread can tell). Staff may keep their id everywhere — the venue
 * side sees every thread anyway. A BOOKER (holds-without-a-request H17) has
 * no thread of its own, so it is stamped on none; its id stays on the
 * request-less movers' audit rows (`by: "booker"`), which no act reads.
 */
export type MoverActor =
  | { humanId: string | null; kind: "staff" }
  | { humanId: string; kind: "booker" }
  | { humanId: string; kind: "act"; ownRequestId: string };

export function moverActorHumanId(
  actor: MoverActor,
  bookingRequestId: string,
): string | null {
  if (actor.kind === "staff") return actor.humanId;
  if (actor.kind === "booker") return null;
  return actor.ownRequestId === bookingRequestId ? actor.humanId : null;
}

/**
 * Ledger + intents for every mover — the ONE place "your position changed"
 * is recorded, so a reorder, a manual release, a lapse and a confirm all say
 * it the same way (`booking_hold.reordered {from, to}` on the mover's thread,
 * `hold.position_changed` to the mover's act).
 *
 * booking-the-night P2d-2 (N20 / FR-015): a mover that reached 1st hold with
 * terms ready for that night also gets the venue-only
 * `booking_hold.first_ready` cue ("Send terms") — see
 * `recordFirstReadyIfReady`.
 */
export async function recordMovers(
  tx: TxRepos,
  moved: readonly MovedHold[],
  actor: MoverActor,
  /** The use case's clock: stamps the request-less holds' audit rows. */
  now: Date,
): Promise<BookingHoldNotificationIntent[]> {
  const intents: BookingHoldNotificationIntent[] = [];
  for (const { hold, from, to } of moved) {
    // holds-without-a-request H20: a request-less hold has no thread and no
    // act to tell, and the "Send terms" cue is about a request's terms. Its
    // history is the audit log.
    if (hold.ownerKind !== "REQUEST") {
      await tx.audit.log({
        entity: "booking_hold",
        entityId: hold.id,
        action: "booking_hold.reordered",
        data: {
          ownerKind: hold.ownerKind,
          from,
          to,
          actorHumanId: actor.humanId,
          by: actor.kind,
        },
        at: now,
      });
      continue;
    }
    await appendBookingSystemEntry(tx, {
      bookingRequestId: hold.bookingRequestId,
      kind: "booking_hold.reordered",
      data: { holdId: hold.id, from, to },
      actorHumanId: moverActorHumanId(actor, hold.bookingRequestId),
    });
    intents.push({
      kind: "hold.position_changed",
      bookingRequestId: hold.bookingRequestId,
      holdId: hold.id,
      audience: "act",
      date: hold.date,
      position: to,
    });
    if (to === 1 && from > 1) {
      await recordFirstReadyIfReady(tx, hold);
    }
  }
  return intents;
}

/**
 * Renumber every distinct line in `holds` (after their membership changed)
 * and record the movers. Lines are locked and renumbered in the global lock
 * order. Returns the intents.
 */
export async function renumberLinesOf(
  tx: TxRepos,
  holds: readonly Pick<BookingHoldRecord, "calendarId" | "date">[],
  actor: MoverActor,
  now: Date,
): Promise<BookingHoldNotificationIntent[]> {
  const intents: BookingHoldNotificationIntent[] = [];
  for (const key of lineKeysOf(holds)) {
    const { moved } = await renumberLine(tx, key);
    intents.push(...(await recordMovers(tx, moved, actor, now)));
  }
  return intents;
}

/** The adapter's CAS-loser shape (`updateStatus` / `setRespondBy`). */
export function isHoldStatusConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_hold_status_changed"
  );
}

/**
 * The adapter's "line moved under you" shape: a stale `renumberLine` set, or
 * a Postgres deadlock / serialization failure the adapter folded into it.
 * Both mean the same thing to a caller — re-read and retry.
 */
export function isHoldLineChangedConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_hold_line_changed"
  );
}

/** Rethrow: typed, retryable HOLD_LINE_CHANGED for the adapter shape; anything else as-is. */
export function rethrowHoldLineConflict(
  error: unknown,
  key?: HoldLineKey,
): never {
  if (isHoldLineChangedConflict(error)) {
    throw fail("HOLD_LINE_CHANGED", {
      meta: key ? { calendarId: key.calendarId, date: key.date } : undefined,
    });
  }
  throw error;
}

/**
 * CAS a hold to RELEASED. Returns the released row, or null when the CAS
 * lost — "someone else already moved it", which every caller treats as
 * done-by-another, never as a failure (settlement is idempotent by design).
 * A deadlock/serialization failure (adapter → line_changed) is NOT a lost
 * CAS: it surfaces as HOLD_LINE_CHANGED so the caller's tx rolls back and
 * the client retries.
 */
export async function releaseHoldCas(
  tx: TxRepos,
  hold: Pick<BookingHoldRecord, "id" | "status">,
  args: { reason: BookingHoldReleaseReason; now: Date },
  expectedFrom: readonly BookingHoldStatus[] = [hold.status],
): Promise<BookingHoldRecord | null> {
  try {
    return await tx.bookingHolds.updateStatus({
      id: hold.id,
      status: "RELEASED",
      expectedFrom,
      releasedAt: args.now,
      releasedReason: args.reason,
    });
  } catch (error) {
    if (isHoldStatusConflict(error)) return null;
    rethrowHoldLineConflict(error);
  }
}

/**
 * Guarded status transition with the adapter's transport shapes mapped: a
 * deadlock/serialization failure folded into `booking_hold_line_changed`
 * surfaces as typed HOLD_LINE_CHANGED; the CAS-loser shape
 * (`booking_hold_status_changed`) and the line-confirmed shape pass through
 * for the caller to interpret. Use this, never `tx.bookingHolds.updateStatus`
 * directly, from a use case.
 */
export async function casHoldStatus(
  tx: TxRepos,
  input: UpdateBookingHoldStatusInput,
): Promise<BookingHoldRecord> {
  try {
    return await tx.bookingHolds.updateStatus(input);
  } catch (error) {
    rethrowHoldLineConflict(error);
  }
}

/** `setRespondBy` with the same mapping as {@link casHoldStatus}. */
export async function casHoldRespondBy(
  tx: TxRepos,
  input: SetBookingHoldRespondByInput,
): Promise<BookingHoldRecord> {
  try {
    return await tx.bookingHolds.setRespondBy(input);
  } catch (error) {
    rethrowHoldLineConflict(error);
  }
}

/**
 * "Did the set of lines grow between my pre-lock read and my post-lock
 * read?" — a hold placed on a NEW line in that window would sit outside the
 * locked set; the caller must give up (HOLD_LINE_CHANGED) and retry from a
 * fresh read rather than touch a line it does not hold.
 */
export function assertLineSetCovered(
  lockedKeys: readonly HoldLineKey[],
  holdsAfterLock: readonly Pick<BookingHoldRecord, "calendarId" | "date">[],
): void {
  const locked = new Set(lockedKeys.map(lineKeyOf));
  const grew = holdsAfterLock.find((hold) => !locked.has(lineKeyOf(hold)));
  if (grew) {
    throw fail("HOLD_LINE_CHANGED", {
      meta: {
        calendarId: grew.calendarId,
        date: grew.date,
        reason: "line_set_grew",
      },
    });
  }
}
