import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";

import type { BookingSystemEntryData } from "../messages/_shared/system-entries";

// ─────────────────────────────────────────────────────────────────────────────
// The `booking_request.bill_changed` entry for ONE bill edit (lineup v3,
// FR-009) — pure. Compares the bill before and after the edit and writes
// only what the VENUE may learn (the entry is visible to both sides; the
// schema in system-entries.ts is the contract, this is its one emitter):
//
//   · VENUE-VISIBLE = live (not removed) and not passed (DECLINED). The venue
//     sees joined, invited and by-name acts (FR-004); it never sees a pass.
//   · added[]       — acts visible after the edit that were not on the live
//                     bill before it (new rows and restored ones), with their
//                     source and the state the venue sees: SELF → joined,
//                     TAGGED → invited (a restored act is asked again),
//                     EXTERNAL → by_name.
//   · removed[]     — acts the venue saw that are gone, NAMED only when they
//                     had joined or were by name;
//   · otherRemovedCount — removed acts that were still INVITED: counted,
//                     never named;
//   · a removed PASSED act is not recorded anywhere (the venue never saw it);
//   · reordered     — the relative order of the acts visible BOTH before and
//                     after changed (adds and removes alone are not a
//                     reorder, and a passed act's position never counts);
//   · roleChanged   — an act visible both before and after changed role or
//                     role label (an invited act's role is venue-visible; a
//                     passed act's never is).
// An edit that changes nothing the venue can see returns null: no entry.
// ─────────────────────────────────────────────────────────────────────────────

export type BillChangedEntryData =
  BookingSystemEntryData<"booking_request.bill_changed">;

type ActSnapshot = Pick<
  BookingRequestActRecord,
  | "id"
  | "source"
  | "confirmation"
  | "role"
  | "customRoleLabel"
  | "sortOrder"
  | "removedAt"
>;

/** On the bill the venue reads: live and not passed (FR-004). */
export function isVenueVisibleAct(
  act: Pick<BookingRequestActRecord, "removedAt" | "confirmation">,
): boolean {
  return !act.removedAt && act.confirmation !== "DECLINED";
}

function inBillOrder<T extends ActSnapshot>(acts: readonly T[]): T[] {
  return acts
    .map((act, index) => ({ act, index }))
    .sort((a, b) => a.act.sortOrder - b.act.sortOrder || a.index - b.index)
    .map(({ act }) => act);
}

function roleKey(act: ActSnapshot): string {
  return act.role === "OTHER"
    ? `OTHER:${act.customRoleLabel ?? ""}`
    : act.role;
}

/**
 * The entry for one edit, or null when the venue can see no change.
 *
 * `before` / `after` are the request's act rows read before and after the
 * edit (removed rows may be included; they are ignored). `nameOf` gives each
 * act's snapshot name (see `bill-act-names.ts`) — it is asked ONLY for the
 * acts the entry names.
 */
export function buildBillChangedEntry(args: {
  before: readonly ActSnapshot[];
  after: readonly ActSnapshot[];
  nameOf: (actId: string) => string;
}): BillChangedEntryData | null {
  const visibleBefore = inBillOrder(args.before.filter(isVenueVisibleAct));
  const visibleAfter = inBillOrder(args.after.filter(isVenueVisibleAct));
  const liveBeforeIds = new Set(
    args.before.filter((act) => !act.removedAt).map((act) => act.id),
  );
  const visibleAfterIds = new Set(visibleAfter.map((act) => act.id));
  const visibleBeforeIds = new Set(visibleBefore.map((act) => act.id));

  const added: BillChangedEntryData["added"] = visibleAfter
    .filter((act) => !liveBeforeIds.has(act.id))
    .map((act) => ({
      actId: act.id,
      name: args.nameOf(act.id),
      source: act.source,
      state:
        act.source === "SELF"
          ? ("joined" as const)
          : act.source === "TAGGED"
            ? ("invited" as const)
            : ("by_name" as const),
    }));

  const removed: BillChangedEntryData["removed"] = [];
  let otherRemovedCount = 0;
  for (const act of visibleBefore) {
    if (visibleAfterIds.has(act.id)) continue;
    // Gone from the venue's bill. It can only have LEFT the live bill here —
    // a visible act cannot turn DECLINED inside a bill edit (only the act's
    // own answer does that, and it takes the same lock).
    if (act.source === "EXTERNAL") {
      removed.push({ name: args.nameOf(act.id), wasState: "by_name" });
    } else if (act.confirmation === "CONFIRMED") {
      removed.push({ name: args.nameOf(act.id), wasState: "joined" });
    } else {
      // Still invited: the venue saw "invited", so a count says nothing new
      // and a name would.
      otherRemovedCount += 1;
    }
  }

  const commonBefore = visibleBefore.filter((act) =>
    visibleAfterIds.has(act.id),
  );
  const commonAfter = visibleAfter.filter((act) =>
    visibleBeforeIds.has(act.id),
  );
  const reordered = commonBefore.some(
    (act, index) => commonAfter[index]?.id !== act.id,
  );

  const afterById = new Map(visibleAfter.map((act) => [act.id, act]));
  const roleChanged = commonBefore.some((act) => {
    const next = afterById.get(act.id);
    return next !== undefined && roleKey(next) !== roleKey(act);
  });

  if (
    added.length === 0 &&
    removed.length === 0 &&
    otherRemovedCount === 0 &&
    !reordered &&
    !roleChanged
  ) {
    return null;
  }
  return { added, removed, otherRemovedCount, reordered, roleChanged };
}
