import { describe, expect, it } from "vitest";

import { dealFingerprint } from "../_shared/deal-fingerprint";
import { getTermsDeal, projectTermsDeal } from "../get-terms-deal";
import { setAgreementDeal } from "../set-agreement-deal";
import { setTermsDeal } from "../set-terms-deal";
import {
  AGREEMENT_ID,
  SHOW_ENDS,
  SHOW_STARTS,
  SUPPORT_HUMAN,
  VENUE_ADMIN,
  VENUE_ORG,
  ACT_HUMAN,
  caught,
  clauseRecord,
  clock,
  currentFingerprint,
  makeRepos,
  standardStore,
} from "./deal-fakes";

/**
 * The lost-update guard on whole-deal writes (A2 review item 7) and the
 * server-side "rest" total (item 8, NFR-002).
 */

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };
const support = { kind: "human" as const, id: SUPPORT_HUMAN };

const EVENT_TERMS = "f0000000-0000-4000-8000-000000000001";
const OWN_EVENT = "f0000000-0000-4000-8000-0000000000ee";
const eventTarget = { kind: "EVENT" as const, eventId: OWN_EVENT };
const bookingTarget = { kind: "BOOKING_AGREEMENT" as const, agreementId: AGREEMENT_ID };

const guaranteeDeal = {
  source: "PRESET" as const,
  preset: { preset: "GUARANTEE" as const, act, guaranteeCents: 50_000 },
  remainder: venue,
  extraClauses: [{ payee: support, amountType: "PERCENT" as const, percent: 10, basis: "GROSS" as const }],
};
const straightDeal = {
  source: "PRESET" as const,
  preset: { preset: "STRAIGHT_PERCENT" as const, act, percent: 30 },
  remainder: venue,
};

function eventStore(withTerms = true) {
  const s = standardStore();
  if (withTerms) {
    s.terms.set(EVENT_TERMS, {
      isDefault: false,
      deal: {
        payoutTermsId: EVENT_TERMS,
        remainderPayeeId: null,
        clauses: [clauseRecord({ id: "f1000000-0000-4000-8000-000000000001", payoutTermsId: EVENT_TERMS, payeeId: s.venuePayee, percent: 100 })],
        deductions: [],
      },
    });
  }
  s.events.set(OWN_EVENT, {
    id: OWN_EVENT,
    orgId: VENUE_ORG,
    humanId: null,
    startsAt: SHOW_STARTS,
    endsAt: SHOW_ENDS,
    payoutTermsId: withTerms ? EVENT_TERMS : null,
    currency: "usd",
    status: "DRAFT",
    publishedAt: null,
  });
  return s;
}

type S = ReturnType<typeof standardStore>;
const read = (s: S, target: unknown) =>
  getTermsDeal({ repos: makeRepos(s) }, { actorHumanId: VENUE_ADMIN, target });
const save = (s: S, target: unknown, deal: unknown, expectedDealFingerprint: string | null) =>
  setTermsDeal({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, target, deal, expectedDealFingerprint });

describe("setTermsDeal — the lost-update guard (expectedDealFingerprint)", () => {
  it("the read's fingerprint saves; the write returns the next one, which the next read agrees with", async () => {
    const s = eventStore();
    const loaded = await read(s, eventTarget);
    expect(loaded.dealFingerprint).toBe(currentFingerprint(s, eventTarget));

    const out = await save(s, eventTarget, guaranteeDeal, loaded.dealFingerprint);
    expect(out.dealFingerprint).not.toBe(loaded.dealFingerprint);
    expect((await read(s, eventTarget)).dealFingerprint).toBe(out.dealFingerprint);
    // And it chains: a second save with the returned fingerprint lands.
    await expect(save(s, eventTarget, straightDeal, out.dealFingerprint)).resolves.toBeTruthy();
  });

  it("admin A's stale save after admin B added a clause → conflict; B's deal is kept, no audit from A", async () => {
    const s = eventStore();
    const loadedByA = await read(s, eventTarget);
    const loadedByB = await read(s, eventTarget);
    await save(s, eventTarget, guaranteeDeal, loadedByB.dealFingerprint);
    const afterB = structuredClone(s.terms.get(EVENT_TERMS)!.deal);
    const auditAfterB = s.audit.length;

    expect(await caught(save(s, eventTarget, straightDeal, loadedByA.dealFingerprint))).toMatchObject({
      code: "conflict",
      message: "deal_terms_changed",
    });
    expect(s.terms.get(EVENT_TERMS)!.deal).toEqual(afterB);
    expect(s.audit.length).toBe(auditAfterB);
  });

  it("null (\"I saw no deal\") over existing terms → conflict", async () => {
    const s = eventStore();
    expect(await caught(save(s, eventTarget, guaranteeDeal, null))).toMatchObject({
      code: "conflict",
      message: "deal_terms_changed",
    });
  });

  it("an event with no terms yet: null saves (terms minted here); a fingerprint does not", async () => {
    const s1 = eventStore(false);
    expect(await caught(save(s1, eventTarget, guaranteeDeal, "0".repeat(32)))).toMatchObject({
      code: "conflict",
      message: "deal_terms_changed",
    });
    const s2 = eventStore(false);
    await expect(save(s2, eventTarget, guaranteeDeal, null)).resolves.toMatchObject({
      dealFingerprint: expect.any(String),
    });
  });

  it("a booking agreement: a stale fingerprint is refused the same way", async () => {
    const s = standardStore();
    const stale = currentFingerprint(s, bookingTarget);
    await save(s, bookingTarget, guaranteeDeal, stale);
    expect(await caught(save(s, bookingTarget, straightDeal, stale))).toMatchObject({
      code: "conflict",
      message: "deal_terms_changed",
    });
  });

  it("an org default: null saves when the default is provisioned by this write", async () => {
    const s = standardStore();
    const orgTarget = { kind: "ORG_DEFAULT" as const, orgId: VENUE_ORG };
    const out = await save(s, orgTarget, { ...guaranteeDeal, extraClauses: [] }, null);
    expect(out.dealFingerprint).toBe(currentFingerprint(s, orgTarget));
    expect(await caught(save(s, orgTarget, straightDeal, null))).toMatchObject({
      code: "conflict",
      message: "deal_terms_changed",
    });
  });

  it("a payee answering while the editor has the deal open is not a conflict (answers are not in the fingerprint)", async () => {
    const s = eventStore();
    await save(s, eventTarget, guaranteeDeal, currentFingerprint(s, eventTarget));
    const deal = s.terms.get(EVENT_TERMS)!.deal;
    const before = dealFingerprint(deal);
    for (const c of deal.clauses) {
      c.confirmationStatus = "CONFIRMED";
      c.confirmedAt = new Date();
    }
    expect(dealFingerprint(deal)).toBe(before);
    // A clause's economics are in it.
    deal.clauses[0]!.percent = (deal.clauses[0]!.percent ?? 0) + 1;
    expect(dealFingerprint(deal)).not.toBe(before);
  });

  it("the legacy setAgreementDeal output is unchanged (no fingerprint, no expectation)", async () => {
    const s = standardStore();
    const out = await setAgreementDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, deal: guaranteeDeal },
    );
    expect(out).not.toHaveProperty("dealFingerprint");
  });

  it("the input requires the field", async () => {
    const s = eventStore();
    expect(
      await caught(
        setTermsDeal({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, target: eventTarget, deal: guaranteeDeal }),
      ),
    ).toMatchObject({ code: "invalid_input" });
  });
});

describe("projectTermsDeal — the rest, summed on the server (NFR-002)", () => {
  it("restTotalCents = the remainder holder's pool share + its own per-order lines", async () => {
    const s = eventStore();
    await save(s, eventTarget, guaranteeDeal, currentFingerprint(s, eventTarget));
    const tiers = [{ tickets: 100, unitBasisCents: 2_000 }];
    const out = await projectTermsDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, target: eventTarget, tiers },
    );
    expect(out.remainder).not.toBeNull();
    if (out.projection.visibility !== "FULL" || !out.remainder) throw new Error("expected FULL");

    // What the browser used to add up (DealCalculator.howOf).
    const read = await getTermsDeal({ repos: makeRepos(s) }, { actorHumanId: VENUE_ADMIN, target: eventTarget });
    const restLineIds = new Set(read.clauses.filter((c) => c.role === "REMAINDER_PER_ORDER").map((c) => c.id));
    expect(restLineIds.size).toBeGreaterThan(0);
    const position = out.projection.result.payees.find((p) => p.payeeId === out.remainder!.payeeId)!;
    const browserSum =
      (position.remainderShareCents ?? 0) +
      out.projection.result.clauses
        .filter((c) => restLineIds.has(c.clauseId))
        .reduce((t, c) => t + c.entitlementCents, 0);
    expect(out.remainder.restTotalCents).toBe(browserSum);

    // $2,000 of tickets: support 10% ($200) per order, the act's $500
    // guarantee settled directly; the venue keeps the rest, $1,300.
    expect(out.remainder.restTotalCents).toBe(130_000);
  });
});
