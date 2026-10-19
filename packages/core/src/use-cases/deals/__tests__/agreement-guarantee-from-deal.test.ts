import { describe, expect, it } from "vitest";

import { updateBookingAgreementHeader } from "../../booking-agreements/update-booking-agreement-header";
import { projectAgreementDeal } from "../project-agreement-deal";
import { setAgreementDeal } from "../set-agreement-deal";
import { projectTermsDeal } from "../get-terms-deal";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  EVENT_ID,
  SHOW_ENDS,
  SHOW_STARTS,
  SUPPORT_HUMAN,
  TERMS_ID,
  VENUE_ADMIN,
  VENUE_ORG,
  caught,
  clock,
  makeRepos,
  standardStore,
} from "./deal-fakes";

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };
const support = { kind: "human" as const, id: SUPPORT_HUMAN };

const guarantee = (cents: number) => ({
  source: "PRESET" as const,
  preset: { preset: "GUARANTEE" as const, act, guaranteeCents: cents },
  remainder: venue,
});
const versus = (cents: number) => ({
  source: "PRESET" as const,
  preset: { preset: "VERSUS" as const, act, guaranteeCents: cents, percent: 70 },
  remainder: venue,
});
const doorSplit = {
  source: "PRESET" as const,
  preset: { preset: "DOOR_SPLIT" as const, act, percent: 70 },
  remainder: venue,
};

type S = ReturnType<typeof standardStore>;
const write = (s: S, deal: unknown) =>
  setAgreementDeal({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, deal });
const header = (s: S) => s.agreements.get(AGREEMENT_ID)!.guaranteeCents;

/**
 * FR-001: `Agreement.guaranteeCents` is derived from the sender's clause — the
 * act side's fixed part — on every deal save, in the deal write's transaction.
 */
describe("the header guarantee follows The deal", () => {
  it("is set from the act's guarantee on save, over a pitched header", async () => {
    const s = standardStore();
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, guaranteeCents: 50_000 });

    await write(s, guarantee(40_000));

    expect(header(s)).toBe(40_000);
  });

  it("changes when the deal's guarantee changes (a versus' fixed part counts)", async () => {
    const s = standardStore();
    await write(s, guarantee(40_000));
    await write(s, versus(80_000));
    expect(header(s)).toBe(80_000);
  });

  it("is cleared when the deal no longer gives the act a fixed amount", async () => {
    const s = standardStore();
    await write(s, guarantee(40_000));
    await write(s, doorSplit);
    expect(header(s)).toBeNull();
  });

  it("ignores fixed amounts paid to anyone but the act (a support act's flat fee, a room rental)", async () => {
    const s = standardStore();
    await write(s, {
      source: "CLAUSES",
      clauses: [
        { payee: act, amountType: "PERCENT", percent: 60, basis: "NET_POOL" },
        { payee: support, amountType: "FIXED", amountCents: 15_000, basis: "GROSS" },
      ],
      deductions: [],
      remainder: venue,
    });
    expect(header(s)).toBeNull();
  });

  it("sums the act's fixed parts when the deal pays them more than one", async () => {
    const s = standardStore();
    await write(s, {
      source: "CLAUSES",
      clauses: [
        { payee: act, amountType: "FIXED", amountCents: 40_000, basis: "GROSS" },
        { payee: act, amountType: "FIXED", amountCents: 5_000, basis: "GROSS", displayLabel: "Travel" },
      ],
      deductions: [],
      remainder: venue,
    });
    expect(header(s)).toBe(45_000);
  });

  it("leaves the header of an agreement with no originating request alone", async () => {
    const s = standardStore();
    s.requests.delete(AGREEMENT_ID);
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, guaranteeCents: 50_000 });
    await write(s, guarantee(40_000));
    expect(header(s)).toBe(50_000);
  });

  it("after a deal save the header refuses a typed change and takes the same value", async () => {
    const s = standardStore();
    await write(s, guarantee(40_000));
    const deps = { repos: makeRepos(s), clock };

    expect(
      await caught(
        updateBookingAgreementHeader(deps, { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, guaranteeCents: 50_000 }),
      ),
    ).toMatchObject({ code: "AGREEMENT_NOT_EDITABLE" });
    await expect(
      updateBookingAgreementHeader(deps, {
        actorHumanId: VENUE_ADMIN,
        agreementId: AGREEMENT_ID,
        title: "Friday headline",
        guaranteeCents: 40_000,
      }),
    ).resolves.toMatchObject({ title: "Friday headline", guaranteeCents: 40_000 });
  });
});

/**
 * Right after "Create event" from an agreement the draft has no ticket types:
 * the projection says so instead of failing (no 400, no console error).
 */
describe("the projection with no tiers to read", () => {
  function withDraftEvent(s: S) {
    s.events.set(EVENT_ID, {
      id: EVENT_ID,
      orgId: VENUE_ORG,
      humanId: null,
      startsAt: SHOW_STARTS,
      endsAt: SHOW_ENDS,
      payoutTermsId: TERMS_ID,
      currency: "usd",
      status: "DRAFT",
      publishedAt: null,
    });
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, draftEventId: EVENT_ID });
  }

  it("a draft event with no ACTIVE ticket types: needsTiers, nothing projected", async () => {
    const s = standardStore();
    withDraftEvent(s);
    s.ticketTypes.set(EVENT_ID, [{ id: "t1", status: "ARCHIVED", capacity: 100, priceCents: 2_000 }]);

    const out = await projectAgreementDeal({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID });

    expect(out).toEqual({
      agreementId: AGREEMENT_ID,
      needsTiers: true,
      reason: "NO_TICKET_TYPES",
      tiers: [],
      tiersSource: "EVENT_TICKET_TYPES",
      payees: [],
    });
  });

  it("no event yet: needsTiers with reason NO_EVENT (target BOOKING_AGREEMENT too)", async () => {
    const s = standardStore();
    const out = await projectTermsDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, target: { kind: "BOOKING_AGREEMENT", agreementId: AGREEMENT_ID } },
    );
    expect(out).toMatchObject({ needsTiers: true, reason: "NO_EVENT", payees: [] });
  });

  it("typed rows project exactly as before", async () => {
    const s = standardStore();
    withDraftEvent(s);
    const out = await projectAgreementDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, tiers: [{ tickets: 100, unitBasisCents: 2_000 }] },
    );
    if (out.needsTiers) throw new Error("expected a projection");
    expect(out.tiersSource).toBe("INPUT");
    expect(out.tiers).toEqual([{ tickets: 100, unitBasisCents: 2_000 }]);
    expect(out.projection.visibility).toBe("FULL");
    expect(out.payees.length).toBeGreaterThan(0);
  });
});
