import type { DealPerson } from "@/components/deals";

// ─────────────────────────────────────────────────────────────────────────────
// "The deal" inside Revenue splits (board P1), as plain decisions: who the
// event's one party is (its owner, who takes the rest) and which lineup acts
// the payee picker offers first.
// ─────────────────────────────────────────────────────────────────────────────

type OwnerEntity =
  | { kind: "human"; humanId: string; humanName: string }
  | { kind: "org"; orgId: string; orgName: string };

/**
 * The event's owner as the deal's party. The name comes from the viewer's
 * own owner entities when the owner is one of them (it always is for the
 * people who can route payouts), else from the owner's payout line, else
 * `unnamed`. Null while the event's owner is not known yet.
 */
export function eventDealParty(
  owner: { orgId: string | null; humanId: string | null } | null | undefined,
  owners: readonly OwnerEntity[] | undefined,
  ownerLineName: string | null | undefined,
  unnamed: string,
): DealPerson | null {
  if (!owner) return null;
  if (owner.orgId) {
    const orgId = owner.orgId;
    const mine = owners?.find(
      (o): o is Extract<OwnerEntity, { kind: "org" }> =>
        o.kind === "org" && o.orgId === orgId,
    );
    return {
      ref: { kind: "org", id: orgId },
      name: mine?.orgName || ownerLineName || unnamed,
      source: "party",
    };
  }
  if (owner.humanId) {
    const humanId = owner.humanId;
    const mine = owners?.find(
      (o): o is Extract<OwnerEntity, { kind: "human" }> =>
        o.kind === "human" && o.humanId === humanId,
    );
    return {
      ref: { kind: "human", id: humanId },
      name: mine?.humanName || ownerLineName || unnamed,
      source: "party",
    };
  }
  return null;
}

/**
 * The lineup, as the payee picker's first suggestions ("From the lineup").
 * Each act is a person on the platform; the owner is never suggested to
 * themselves, and one person on the lineup twice is offered once.
 */
export function lineupSuggestionsOf(
  lineup: readonly { humanId: string; displayName: string | null }[],
  owner: DealPerson | null,
  unnamed: string,
): DealPerson[] {
  const out: DealPerson[] = [];
  for (const act of lineup) {
    if (owner?.ref.kind === "human" && owner.ref.id === act.humanId) continue;
    if (out.some((p) => p.ref.id === act.humanId)) continue;
    out.push({
      ref: { kind: "human", id: act.humanId },
      name: act.displayName ?? unnamed,
      source: "lineup",
    });
  }
  return out;
}
