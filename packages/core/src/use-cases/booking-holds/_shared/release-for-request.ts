import type { TxRepos } from "@th/ports/repos";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";

import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";
import type { BookingHoldNotificationIntent } from "./booking-hold-intents";
import {
  assertLineSetCovered,
  lineKeysOf,
  lockLines,
  releaseHoldCas,
  renumberLinesOf,
  type MoverActor,
} from "./hold-line";

// ─────────────────────────────────────────────────────────────────────────────
// FR-009 — request closure releases holds. Called INSIDE the transaction that
// moves the request to DECLINED / WITHDRAWN / EXPIRED, so the request and
// its holds can never disagree about whether the booking is still alive.
//
// Every live (ACTIVE | CHALLENGED) hold the request owns → RELEASED
// (REQUEST_CLOSED); each line it left is renumbered and the movers get the
// usual `hold.position_changed`. The closing act itself is NOT notified
// about its own holds — it just declined/withdrew/expired, and the request-
// level notification already carries that news.
//
// Idempotent: a request with no live holds is a no-op, and a CAS loser is
// "already released by someone else".
//
// BACKSTOP: `settleLapsedHolds` ALSO releases live holds whose request is
// already terminal, so a hold this call missed is healed by the next
// read-settle on its line. (Since booking-the-night P2d-2 the expiry sweep
// flips and releases in ONE per-request tx; the backstop covers rows the
// earlier bulk-flip sweep left behind.)
// ─────────────────────────────────────────────────────────────────────────────

export async function releaseHoldsForClosedRequest(
  tx: TxRepos,
  args: {
    bookingRequestId: string;
    now: Date;
    /**
     * Who closed the request. `kind: "act"` (the sender withdrawing) is
     * stamped on the closing request's own ledger only — the movers in the
     * lines it left get `authorHumanId: null`, never a foreign act's id.
     */
    actor: MoverActor;
  },
): Promise<{
  released: BookingHoldRecord[];
  intents: BookingHoldNotificationIntent[];
}> {
  const isLive = (hold: BookingHoldRecord) =>
    (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(hold.status);
  // Every line the request is in, locked in the global order BEFORE any row
  // is touched (see hold-line.ts) — a concurrent placement or renumber on
  // one of those lines waits here instead of racing the CAS below. The lock
  // set comes from a pre-lock read, so re-read under the locks: a hold that
  // landed on a NEW line in between is outside the set → HOLD_LINE_CHANGED
  // (the caller's tx rolls back and retries). The CAS runs on the post-lock
  // rows.
  const lockedKeys = lineKeysOf(
    (await tx.bookingHolds.listForRequest(args.bookingRequestId)).filter(
      isLive,
    ),
  );
  await lockLines(tx, lockedKeys);
  const live = (
    await tx.bookingHolds.listForRequest(args.bookingRequestId)
  ).filter(isLive);
  assertLineSetCovered(lockedKeys, live);
  const released: BookingHoldRecord[] = [];
  for (const hold of live) {
    const row = await releaseHoldCas(tx, hold, {
      reason: "REQUEST_CLOSED",
      now: args.now,
    });
    if (!row) continue;
    released.push(row);
    await appendBookingSystemEntry(tx, {
      // The rows came from `listForRequest` (REQUEST holds of this request).
      bookingRequestId: args.bookingRequestId,
      kind: "booking_hold.released",
      data: { holdId: row.id, reason: "REQUEST_CLOSED" },
      // The closing request's OWN thread: the actor is always visible here.
      actorHumanId: args.actor.humanId,
    });
  }
  const intents =
    released.length > 0 ? await renumberLinesOf(tx, released, args.actor, args.now) : [];
  return { released, intents };
}
