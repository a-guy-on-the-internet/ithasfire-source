import { describe, expect, it } from "vitest";

import { confirmDealClause, declineDealClause } from "../answer-deal-clause";
import { setTermsDeal } from "../set-terms-deal";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  NOW,
  OUTSIDER,
  SHOW_ENDS,
  SHOW_STARTS,
  SOUND_ADMIN,
  SOUND_ORG,
  TERMS_ID,
  VENUE_ADMIN,
  VENUE_ORG,
  addFinalizedEvent,
  caught,
  clauseRecord,
  clock,
  currentFingerprint,
  makeRepos,
  standardStore,
} from "./deal-fakes";

/**
 * confirmDealClause / declineDealClause: the consent path for a clause
 * SETTLED DIRECTLY that `setTermsDeal` stores PENDING on EVENT terms.
 */

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };
const sound = { kind: "org" as const, id: SOUND_ORG };

const EVENT_TERMS = "e0000000-0000-4000-8000-000000000001";
const OWN_EVENT = "e0000000-0000-4000-8000-0000000000ee";
const target = { kind: "EVENT" as const, eventId: OWN_EVENT };

type S = ReturnType<typeof standardStore>;

/** A venue event whose deal is: the act $500 guaranteed, sound $300 flat, the venue the rest. */
async function nightWithDeal(): Promise<S> {
  const s = standardStore();
  s.terms.set(EVENT_TERMS, {
    isDefault: false,
    deal: { payoutTermsId: EVENT_TERMS, remainderPayeeId: null, clauses: [], deductions: [] },
  });
  s.events.set(OWN_EVENT, {
    id: OWN_EVENT,
    orgId: VENUE_ORG,
    humanId: null,
    startsAt: SHOW_STARTS,
    endsAt: SHOW_ENDS,
    payoutTermsId: EVENT_TERMS,
    currency: "usd",
    status: "PUBLISHED",
    publishedAt: SHOW_STARTS,
  });
  await setTermsDeal(
    { repos: makeRepos(s), clock },
    {
      actorHumanId: VENUE_ADMIN,
      target,
      expectedDealFingerprint: currentFingerprint(s, target),
      deal: {
        source: "PRESET",
        preset: { preset: "GUARANTEE", act, guaranteeCents: 50_000 },
        remainder: venue,
        extraClauses: [
          { payee: sound, amountType: "FIXED", amountCents: 30_000, basis: "GROSS" },
          { payee: { kind: "human", id: OUTSIDER }, amountType: "PERCENT", percent: 10, basis: "GROSS" },
        ],
      },
    },
  );
  s.audit.length = 0;
  return s;
}

const clauseOf = (s: S, payeeId: string, amountType: string) =>
  s.terms.get(EVENT_TERMS)!.deal.clauses.find((c) => c.payeeId === payeeId && c.amountType === amountType)!;

type Shown = {
  amountType: "FIXED" | "PERCENT" | "FIXED_AND_PERCENT";
  amountCents: number | null;
  percent: number | null;
  basis: "GROSS" | "NET_POOL";
  resolution: "SUM" | "GREATER_OF" | null;
};

/** The economics a client would display for a clause: the deal read's fields. */
const shownOf = (c: Shown): Shown => ({
  amountType: c.amountType,
  amountCents: c.amountCents,
  percent: c.percent,
  basis: c.basis,
  resolution: c.resolution,
});

/** What the client displayed for `clauseId` right now (any shape for an unknown id). */
const shownNow = (s: S, clauseId: string): Shown => {
  const c = [...s.terms.values()].flatMap((t) => t.deal.clauses).find((x) => x.id === clauseId);
  return c
    ? shownOf(c)
    : { amountType: "FIXED", amountCents: 1, percent: null, basis: "GROSS", resolution: null };
};

const confirm = (s: S, actorHumanId: string, clauseId: string, t: unknown = target, answered?: Shown) =>
  confirmDealClause(
    { repos: makeRepos(s), clock },
    { actorHumanId, target: t, clauseId, answered: answered ?? shownNow(s, clauseId) },
  );
const decline = (s: S, actorHumanId: string, clauseId: string, t: unknown = target, answered?: Shown) =>
  declineDealClause(
    { repos: makeRepos(s), clock },
    { actorHumanId, target: t, clauseId, answered: answered ?? shownNow(s, clauseId) },
  );

describe("confirmDealClause / declineDealClause", () => {
  it("the payee confirms; a second answer is a conflict", async () => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    expect(guarantee).toMatchObject({ requiresConfirmation: true, confirmationStatus: "PENDING" });

    await expect(confirm(s, ACT_HUMAN, guarantee.id)).resolves.toMatchObject({
      clauseId: guarantee.id,
      payoutTermsId: EVENT_TERMS,
      confirmationStatus: "CONFIRMED",
      confirmedAt: NOW,
    });
    expect(clauseOf(s, s.actPayee, "FIXED")).toMatchObject({ confirmationStatus: "CONFIRMED", confirmedAt: NOW });
    expect(s.audit.map((a) => a.action)).toEqual(["deal_clause_confirmed"]);

    expect(await caught(confirm(s, ACT_HUMAN, guarantee.id))).toMatchObject({
      code: "conflict",
      message: "deal_clause_already_answered",
    });
    expect(await caught(decline(s, ACT_HUMAN, guarantee.id))).toMatchObject({
      code: "conflict",
      message: "deal_clause_already_answered",
    });
    expect(clauseOf(s, s.actPayee, "FIXED").confirmationStatus).toBe("CONFIRMED");
    expect(s.audit).toHaveLength(1);
  });

  it("the payee declines", async () => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    await expect(decline(s, ACT_HUMAN, guarantee.id)).resolves.toMatchObject({
      confirmationStatus: "DECLINED",
      confirmedAt: null,
    });
    expect(clauseOf(s, s.actPayee, "FIXED").confirmationStatus).toBe("DECLINED");
    expect(s.audit.map((a) => a.action)).toEqual(["deal_clause_declined"]);
  });

  it("nobody but the payee answers: not the event's admin, not an outsider", async () => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    expect(await caught(confirm(s, VENUE_ADMIN, guarantee.id))).toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(await caught(confirm(s, OUTSIDER, guarantee.id))).toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(clauseOf(s, s.actPayee, "FIXED").confirmationStatus).toBe("PENDING");
    expect(s.audit).toEqual([]);
  });

  it("an org payee answers through its own OWNER/ADMIN; another org's admin is refused", async () => {
    const s = await nightWithDeal();
    const soundFee = clauseOf(s, s.soundPayee, "FIXED");
    expect(soundFee).toMatchObject({ requiresConfirmation: true, confirmationStatus: "PENDING" });
    // The venue's admin runs the event but does not answer for the sound company.
    expect(await caught(confirm(s, VENUE_ADMIN, soundFee.id))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(clauseOf(s, s.soundPayee, "FIXED").confirmationStatus).toBe("PENDING");
    await expect(confirm(s, SOUND_ADMIN, soundFee.id)).resolves.toMatchObject({ confirmationStatus: "CONFIRMED" });
  });

  it("a per-order line answers through confirmPayoutLine, not here", async () => {
    const s = await nightWithDeal();
    const perOrder = clauseOf(s, [...s.payees.values()].find((p) => p.subjectId === OUTSIDER)!.id, "PERCENT");
    expect(await caught(confirm(s, OUTSIDER, perOrder.id))).toMatchObject({
      code: "invalid_input",
      message: "deal_clause_is_paid_per_order",
    });
  });

  it("a default row is a template: refused by target, and refused when an event's terms are a default", async () => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    expect(await caught(confirm(s, ACT_HUMAN, guarantee.id, { kind: "ORG_DEFAULT", orgId: VENUE_ORG }))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
      meta: { reason: "default_terms_are_a_template" },
    });
    s.terms.get(EVENT_TERMS)!.isDefault = true;
    expect(await caught(confirm(s, ACT_HUMAN, guarantee.id))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
      meta: { reason: "default_terms_are_a_template" },
    });
    expect(clauseOf(s, s.actPayee, "FIXED").confirmationStatus).toBe("PENDING");
    expect(s.audit).toEqual([]);
  });

  it("a booking agreement's terms are refused: the booking's accept flow is the consent", async () => {
    const s = standardStore();
    const event = addFinalizedEvent(s); // the event runs on the agreement's terms
    const guarantee = clauseRecord({
      id: "f0000000-0000-4000-8000-000000000001",
      payeeId: s.actPayee,
      amountType: "FIXED",
      amountCents: 50_000,
      percent: null,
      requiresConfirmation: true,
      confirmationStatus: "PENDING",
    });
    s.terms.get(TERMS_ID)!.deal.clauses.push(guarantee);

    expect(
      await caught(confirm(s, ACT_HUMAN, guarantee.id, { kind: "BOOKING_AGREEMENT", agreementId: AGREEMENT_ID })),
    ).toMatchObject({ code: "AGREEMENT_NOT_EDITABLE", meta: { reason: "booking_terms_answered_by_accept" } });
    expect(
      await caught(confirm(s, ACT_HUMAN, guarantee.id, { kind: "EVENT", eventId: event.id })),
    ).toMatchObject({ code: "AGREEMENT_FINALIZED", meta: { agreementId: AGREEMENT_ID } });
    expect(guarantee.confirmationStatus).toBe("PENDING");
    expect(s.audit).toEqual([]);
  });

  it("the clause changed after the payee saw it (a re-save lowered it) → conflict, nothing recorded", async () => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    const shown = shownOf(guarantee);
    const repos = makeRepos(s) as unknown as { deals: { lockTerms: (id: string) => Promise<boolean> } };
    const lock = repos.deals.lockTerms;
    repos.deals.lockTerms = async (id) => {
      const ok = await lock(id);
      // An organiser's re-save committed first: same clause id, new amount.
      clauseOf(s, s.actPayee, "FIXED").amountCents = 40_000;
      return ok;
    };
    expect(
      await caught(
        confirmDealClause(
          { repos: repos as never, clock },
          { actorHumanId: ACT_HUMAN, target, clauseId: guarantee.id, answered: shown },
        ),
      ),
    ).toMatchObject({ code: "CONFLICT", meta: { reason: "answered_terms_changed" } });
    expect(clauseOf(s, s.actPayee, "FIXED").confirmationStatus).toBe("PENDING");
    expect(s.audit).toEqual([]);
  });

  it("stale view: the act saw $500; the organiser re-saved keeping the clause id at $50; Confirm conflicts", async () => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    const shown = shownOf(guarantee); // $500, rendered on the act's screen
    expect(shown.amountCents).toBe(50_000);

    // The organiser re-saves the deal with the guarantee at $50, keeping the
    // clause id (a deal write keeps a requested id that is the deal's own —
    // `toStoredDeal`), so it lands PENDING at the new amount. Stored state
    // after that write, before the act's click:
    const stored = clauseOf(s, s.actPayee, "FIXED");
    stored.amountCents = 5_000;
    stored.confirmationStatus = "PENDING";
    const resaved = clauseOf(s, s.actPayee, "FIXED");
    expect(resaved).toMatchObject({ id: guarantee.id, amountCents: 5_000, confirmationStatus: "PENDING" });

    // The act clicks Confirm on the $500 they were shown.
    for (const answer of [confirm, decline]) {
      expect(await caught(answer(s, ACT_HUMAN, guarantee.id, target, shown))).toMatchObject({
        code: "CONFLICT",
        meta: { reason: "answered_terms_changed" },
      });
    }
    expect(clauseOf(s, s.actPayee, "FIXED")).toMatchObject({ confirmationStatus: "PENDING", confirmedAt: null });
    expect(s.audit).toEqual([]);

    // Once they see $50, their yes is to $50.
    await expect(confirm(s, ACT_HUMAN, guarantee.id, target, shownOf(resaved))).resolves.toMatchObject({
      confirmationStatus: "CONFIRMED",
    });
  });

  it.each<[string, (x: Shown) => Shown]>([
    ["amount", (x) => ({ ...x, amountCents: (x.amountCents ?? 0) + 1 })],
    ["amountType", (x) => ({ ...x, amountType: "FIXED_AND_PERCENT", percent: 10, resolution: "GREATER_OF" })],
    ["percent", (x) => ({ ...x, percent: 5 })],
    ["basis", (x) => ({ ...x, basis: "NET_POOL" })],
    ["resolution", (x) => ({ ...x, resolution: "SUM" })],
  ])("a different %s than stored conflicts for confirm and decline, nothing written", async (_f, change) => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    const shown = change(shownOf(guarantee));
    for (const answer of [confirm, decline]) {
      expect(await caught(answer(s, ACT_HUMAN, guarantee.id, target, shown))).toMatchObject({
        code: "CONFLICT",
        meta: { reason: "answered_terms_changed" },
      });
    }
    expect(clauseOf(s, s.actPayee, "FIXED").confirmationStatus).toBe("PENDING");
    expect(s.audit).toEqual([]);
  });

  it("the displayed economics are required", async () => {
    const s = await nightWithDeal();
    const guarantee = clauseOf(s, s.actPayee, "FIXED");
    expect(
      await caught(
        confirmDealClause({ repos: makeRepos(s), clock }, { actorHumanId: ACT_HUMAN, target, clauseId: guarantee.id }),
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(clauseOf(s, s.actPayee, "FIXED").confirmationStatus).toBe("PENDING");
  });

  it("an unknown clause id is not found", async () => {
    const s = await nightWithDeal();
    expect(await caught(confirm(s, ACT_HUMAN, "f0000000-0000-4000-8000-0000000000ff"))).toMatchObject({
      code: "PAYOUT_LINE_NOT_FOUND",
    });
  });
});
