import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { sameRef, type DealPayeeRef, type DealPerson } from "./deal-model";

// ─────────────────────────────────────────────────────────────────────────────
// THE BILL beside the deal (board A1): the acts on the originating request,
// read-only, so it is clear why an act is offered as a payee. Pure decisions
// only; `BillSection` draws them.
// ─────────────────────────────────────────────────────────────────────────────

export type BillItem =
  inferRouterOutputs<AppRouter>["bookingAgreements"]["get"]["bill"][number];

export type BillTag = "joined" | "invited" | "byName" | "passed";

/**
 * The status an act carries on the bill. A by-name act is never "invited"
 * (it has no platform identity to invite), and an invite still open never
 * reads as joined (lineup v3 NFR-002).
 */
export function billTagOf(
  item: Pick<BillItem, "source" | "confirmation">,
): BillTag {
  if (item.source === "EXTERNAL") return "byName";
  if (item.confirmation === "CONFIRMED") return "joined";
  if (item.confirmation === "PENDING") return "invited";
  return "passed";
}

/** The bill in its running order (0 = headlining). */
export function billInOrder(bill: readonly BillItem[]): BillItem[] {
  return [...bill].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** "01", "02" … the board's running number. */
export function billIndexLabel(position: number): string {
  return String(position + 1).padStart(2, "0");
}

/**
 * The acts the deal's payee picker offers first ("From the bill"): only acts
 * that have JOINED carry a platform identity (`joinedAs`); invited and
 * by-name acts are not payees anyone can name yet. A party to the terms is
 * left out, since it is already one of the deal's parties.
 */
export function billSuggestionsOf(
  bill: readonly BillItem[],
  parties: readonly Pick<DealPerson, "ref">[],
  unnamed: string,
): DealPerson[] {
  const out: DealPerson[] = [];
  for (const item of billInOrder(bill)) {
    if (!item.joinedAs) continue;
    const ref: DealPayeeRef = {
      kind: item.joinedAs.ownerType === "organization" ? "org" : "human",
      id: item.joinedAs.ownerId,
    };
    if (parties.some((p) => sameRef(p.ref, ref))) continue;
    if (out.some((p) => sameRef(p.ref, ref))) continue;
    out.push({ ref, name: item.displayName ?? unnamed, source: "bill" });
  }
  return out;
}
