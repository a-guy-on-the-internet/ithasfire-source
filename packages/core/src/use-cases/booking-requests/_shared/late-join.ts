import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookingRequestActRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { EventRecord } from "@th/ports/repos/events";
import { toSafeExternalUrl } from "@th/types";

import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";

import { isLiveBookingEvent } from "../../booking-agreements/create-event-from-agreement";
import { findBookingEventForBill, lineupRowIsAct } from "./bill-event";
import { billIdentityOf, resolveBillIdentities } from "./bill-items";

// ─────────────────────────────────────────────────────────────────────────────
// LATE JOIN (lineup-booking-requests v3, FR-010 / L4): a tagged act that
// joins AFTER the request's bill flowed into an event lands on that event's
// lineup by itself — in its bill slot, in the join's own transaction, under
// the bill lock — while the event has not started and is not cancelled.
//
//   · the event: the one the bill flowed into (`findBookingEventForBill`).
//     Dead (CANCELLED / ARCHIVED — `isLiveBookingEvent`) or STARTED
//     (`startsAt <= now`) → nothing is attached (the pre-v3 behaviour: the
//     editor sees a joined suggestion).
//   · already on the lineup (its humanId, or a group's orgId — an editor
//     may have put it there by hand) → nothing.
//   · the slot: right AFTER the last lineup row that came from a joined act
//     with a lower bill position (`sortOrder`). With no such row — the act
//     sits above everything the bill put on the lineup, or the editor
//     rearranged it past recognition — it is APPENDED: a late joiner never
//     takes the headline slot of an event that already exists by itself.
//     Rows are matched to acts by identity: a tagged person by humanId, a
//     group by orgId, the sender's SELF row by the sender pair, a by-name act
//     by its exact free-text name on an unlinked row.
//   · the row: what the mint writes for that act (create-event-from-
//     agreement `planBookingLineup`): a person → `{ humanId }`, a group →
//     `{ orgId }` with its name and PUBLIC page as the fallback display.
//
// The person is TOLD through the lineup consent notice (`event.lineup-added`,
// owner ruling "option A") — the caller records it OWED before the
// transaction (keyed on `newRowId`) and dispatches it after commit, exactly
// as `attachEventHuman` does. A group gets no lineup notice (option A
// notices people); the ledger entry `booking_request.act_joined_lineup` is
// its record on the thread.
// ─────────────────────────────────────────────────────────────────────────────

/** attach-event-human's `externalName` / `externalUrl` bounds. */
const EXTERNAL_NAME_MAX = 120;
const EXTERNAL_URL_MAX = 500;

export type LateJoinTarget = { event: EventRecord; lineup: EventHumanRecord[] };

/**
 * The event a joining act should land on now, with its lineup — or null when
 * nothing attaches (no event yet, dead, started, or the act is already on
 * it). Read-only; pass the TX bag after `lockBill` when it gates the write.
 */
export async function findLateJoinTarget(
  repos: Pick<TxRepos, "agreements" | "events" | "eventHumans">,
  request: Pick<BookingRequestRecord, "agreementId" | "originEventId">,
  act: Pick<BookingRequestActRecord, "actOwnerType" | "actOwnerId">,
  now: Date,
): Promise<LateJoinTarget | null> {
  if (!act.actOwnerType || !act.actOwnerId) return null;
  const eventId = await findBookingEventForBill(repos, request);
  if (!eventId) return null;
  const event = await repos.events.getById(eventId);
  if (!isLiveBookingEvent(event)) return null;
  if (event.startsAt.getTime() <= now.getTime()) return null;
  const lineup = await repos.eventHumans.listByEvent(event.id);
  const owner = { ownerType: act.actOwnerType, ownerId: act.actOwnerId };
  if (lineup.some((row) => lineupRowIsAct(row, owner))) return null;
  return { event, lineup };
}

/** Does this lineup row come from this bill act? (see the module header) */
function rowIsBillAct(
  row: EventHumanRecord,
  act: BookingRequestActRecord,
  sender: { ownerType: "human" | "organization"; ownerId: string } | null,
): boolean {
  switch (act.source) {
    case "TAGGED":
      return act.actOwnerType && act.actOwnerId
        ? lineupRowIsAct(row, {
            ownerType: act.actOwnerType,
            ownerId: act.actOwnerId,
          })
        : false;
    case "SELF":
      return sender !== null && lineupRowIsAct(row, sender);
    case "EXTERNAL":
      return (
        row.humanId === null &&
        (row.orgId ?? null) === null &&
        row.externalName !== null &&
        act.externalName !== null &&
        row.externalName.trim() === act.externalName.trim()
      );
  }
}

/**
 * The 0-based lineup index the joining act takes (see the module header):
 * after the last row from a joined act above it on the bill, else the end.
 */
export function lateJoinSlot(args: {
  lineup: readonly EventHumanRecord[];
  bill: readonly BookingRequestActRecord[];
  act: BookingRequestActRecord;
  sender: { ownerType: "human" | "organization"; ownerId: string } | null;
}): number {
  const above = args.bill.filter(
    (other) =>
      other.id !== args.act.id &&
      !other.removedAt &&
      other.confirmation === "CONFIRMED" &&
      other.sortOrder < args.act.sortOrder,
  );
  let last = -1;
  args.lineup.forEach((row, index) => {
    if (above.some((other) => rowIsBillAct(row, other, args.sender))) {
      last = index;
    }
  });
  return last >= 0 ? last + 1 : args.lineup.length;
}

/**
 * Attach the joining act to `target.event` in its bill slot and renumber the
 * lineup densely. Call inside the join's transaction, after `lockBill` and
 * after the act's row turned CONFIRMED. `rowId` is the id the caller
 * recorded the lineup notice OWED under (a person only). Returns the new row.
 */
export async function attachLateJoiner(
  tx: TxRepos,
  args: {
    request: BookingRequestRecord;
    act: BookingRequestActRecord;
    target: LateJoinTarget;
    rowId: string;
    /** Web origin, for a group row's fallback page link. */
    publicAppUrl?: string | null;
  },
): Promise<EventHumanRecord> {
  const { request, act, target } = args;
  const bill = await tx.bookingRequests.listActsForRequests([request.id]);
  const sender =
    isUnclaimedBookingInquiry(request) ||
    getBookingRequestSender(request).kind !== "owned"
      ? null
      : {
          ownerType: request.performerOwnerType as "human" | "organization",
          ownerId: request.performerOwnerId as string,
        };
  const slot = lateJoinSlot({ lineup: target.lineup, bill, act, sender });

  const roleFields = {
    role: act.role,
    customRoleLabel: act.role === "OTHER" ? (act.customRoleLabel ?? null) : null,
  };
  const identity =
    act.actOwnerType === "organization"
      ? await groupDisplay(tx, act, args.publicAppUrl)
      : null;
  const row = await tx.eventHumans.attach({
    id: args.rowId,
    eventId: target.event.id,
    ...(act.actOwnerType === "organization"
      ? {
          humanId: null,
          orgId: act.actOwnerId,
          externalName: identity?.externalName ?? null,
          externalUrl: identity?.externalUrl ?? null,
        }
      : { humanId: act.actOwnerId, orgId: null }),
    ...roleFields,
    sortOrder: slot,
  });

  const ordered = target.lineup.map((existing) => existing.id);
  ordered.splice(slot, 0, row.id);
  await tx.eventHumans.reorder(target.event.id, ordered);
  return row;
}

/** A group row's fallback display: its name and PUBLIC page (as the mint). */
async function groupDisplay(
  repos: Pick<Repos, "humans" | "organizations" | "entityPages">,
  act: BookingRequestActRecord,
  publicAppUrl: string | null | undefined,
): Promise<{ externalName: string | null; externalUrl: string | null }> {
  const identity = billIdentityOf(act, await resolveBillIdentities(repos, [act]));
  const name = identity.displayName?.trim().slice(0, EXTERNAL_NAME_MAX).trim();
  const base = publicAppUrl?.trim().replace(/\/+$/, "");
  const url = base && identity.href ? `${base}${identity.href}` : null;
  return {
    externalName: name ? name : null,
    externalUrl:
      url && url.length <= EXTERNAL_URL_MAX && toSafeExternalUrl(url) ? url : null,
  };
}
