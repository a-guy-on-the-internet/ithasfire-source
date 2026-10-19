import { describe, expect, it } from "vitest";

import { getAgreementDeal } from "../get-agreement-deal";
import { getTermsDeal, projectTermsDeal } from "../get-terms-deal";
import { setTermsDeal } from "../set-terms-deal";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  EVENT_ID,
  OUTSIDER,
  SHOW_ENDS,
  SHOW_STARTS,
  SOUND_ADMIN,
  SOUND_ORG,
  SUPPORT_HUMAN,
  TERMS_ID,
  VENUE_ADMIN,
  VENUE_EDITOR,
  VENUE_FINANCE,
  VENUE_ORG,
  VENUE_SCANNER,
  VENUE_VIEWER,
  addFinalizedEvent,
  caught,
  clauseRecord,
  clock,
  currentFingerprint,
  makeRepos,
  standardStore,
  type FakeEvent,
} from "./deal-fakes";

/**
 * setTermsDeal / getTermsDeal / projectTermsDeal (FR-003): one deal write for
 * a booking agreement, an event with no booking, and an org's default terms.
 * The deal mechanics are pinned in set-agreement-deal.test.ts; these pin the
 * TARGETS — who may write each, against which org, and on which terms row.
 */

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };
const support = { kind: "human" as const, id: SUPPORT_HUMAN };
const sound = { kind: "org" as const, id: SOUND_ORG };

const EVENT_TERMS = "e0000000-0000-4000-8000-000000000001";
const OWN_EVENT = "e0000000-0000-4000-8000-0000000000ee";
const DELEGATE = "e0000000-0000-4000-8000-0000000000de";

/** The venue keeps the door; the act takes $500 guaranteed, settled directly. */
const guaranteeDeal = {
  source: "PRESET" as const,
  preset: { preset: "GUARANTEE" as const, act, guaranteeCents: 50_000 },
  remainder: venue,
  extraClauses: [{ payee: support, amountType: "PERCENT" as const, percent: 10, basis: "GROSS" as const }],
};

/** A venue-org event with its own (non-booking) terms: venue 100%. */
function eventStore(overrides: Partial<FakeEvent> = {}) {
  const s = standardStore();
  s.terms.set(EVENT_TERMS, {
    isDefault: false,
    deal: {
      payoutTermsId: EVENT_TERMS,
      remainderPayeeId: null,
      clauses: [clauseRecord({ id: "e1000000-0000-4000-8000-000000000001", payoutTermsId: EVENT_TERMS, payeeId: s.venuePayee, percent: 100 })],
      deductions: [],
    },
  });
  s.events.set(OWN_EVENT, {
    id: OWN_EVENT,
    orgId: VENUE_ORG,
    humanId: null,
    startsAt: SHOW_STARTS,
    endsAt: SHOW_ENDS,
    payoutTermsId: EVENT_TERMS,
    currency: "usd",
    status: "DRAFT",
    publishedAt: null,
    ...overrides,
  });
  return s;
}

type S = ReturnType<typeof standardStore>;
const eventTarget = { kind: "EVENT" as const, eventId: OWN_EVENT };
const orgTarget = (orgId: string = VENUE_ORG) => ({ kind: "ORG_DEFAULT" as const, orgId });

const write = (s: S, actorHumanId: string, target: unknown, deal: unknown = guaranteeDeal) =>
  setTermsDeal(
    { repos: makeRepos(s), clock },
    { actorHumanId, target, deal, expectedDealFingerprint: currentFingerprint(s, target) },
  );
/** Repos whose `tx()` runs `beforeTx` first — a write committed by someone else between the gate and the transaction. */
function reposWith(s: S, hooks: { beforeTx?: () => void; afterLock?: () => void }) {
  const repos = makeRepos(s) as unknown as {
    tx: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    deals: { lockTerms: (id: string) => Promise<boolean> };
  };
  const tx = repos.tx;
  repos.tx = async (fn) => {
    hooks.beforeTx?.();
    return tx(fn);
  };
  const lock = repos.deals.lockTerms;
  repos.deals.lockTerms = async (id) => {
    const ok = await lock(id);
    hooks.afterLock?.();
    return ok;
  };
  return repos as never;
}

/** Event terms with the given per-order lines (payee id → [percent, cap, ticketTypeId?]). */
function setEventLines(s: S, lines: Array<[string, number, number | null, string?]>) {
  s.terms.get(EVENT_TERMS)!.deal.clauses = lines.map(([payeeId, percent, capPercent, ticketTypeId]) =>
    clauseRecord({ payoutTermsId: EVENT_TERMS, payeeId, percent, capPercent, ticketTypeId: ticketTypeId ?? null }),
  );
}

const read = (s: S, actorHumanId: string, target: unknown) =>
  getTermsDeal({ repos: makeRepos(s) }, { actorHumanId, target });

// ─────────────────────────────────────────────────────────────────────────────
// EVENT
// ─────────────────────────────────────────────────────────────────────────────

describe("setTermsDeal — an event without a booking", () => {
  it("an edit-level member of the event's org writes the deal onto the event's own terms, lock first", async () => {
    const s = eventStore();
    const out = await write(s, VENUE_EDITOR, eventTarget);
    expect(out).toMatchObject({ target: eventTarget, payoutTermsId: EVENT_TERMS, remainderPayeeId: s.venuePayee });
    expect(s.locks[0]).toBe(EVENT_TERMS);

    const stored = s.terms.get(EVENT_TERMS)!.deal;
    expect(stored.remainderPayeeId).toBe(s.venuePayee);
    // FR-005: the guarantee is settled directly; the support act's 10% GROSS
    // is paid per order and needs their confirmation; the venue keeps the rest.
    const byPayee = (id: string) => stored.clauses.filter((c) => c.payeeId === id);
    // Consent (owner's consent-based ruling): a guarantee for a named third
    // party, settled directly, waits for their confirmation too.
    expect(byPayee(s.actPayee)).toEqual([
      expect.objectContaining({ amountType: "FIXED", amountCents: 50_000, requiresConfirmation: true, confirmationStatus: "PENDING" }),
    ]);
    expect(byPayee(s.supportPayee)).toEqual([
      expect.objectContaining({ amountType: "PERCENT", basis: "GROSS", percent: 10, requiresConfirmation: true, confirmationStatus: "PENDING" }),
    ]);
    expect(byPayee(s.venuePayee)).toEqual([
      // The venue's existing per-order line keeps its id; the owner confirms nothing.
      expect.objectContaining({ id: "e1000000-0000-4000-8000-000000000001", percent: 90, requiresConfirmation: false, confirmationStatus: null }),
    ]);
    // The booking agreement's terms are untouched.
    expect(s.terms.get(TERMS_ID)!.deal.clauses.map((c) => c.percent)).toEqual([20, 80]);
    expect(s.audit.map((a) => a.action)).toContain("event.deal_set");
  });

  it("reads back what it wrote, with mayEdit for the editor and the stage-1 labels", async () => {
    const s = eventStore();
    await write(s, VENUE_EDITOR, eventTarget);
    const out = await read(s, VENUE_EDITOR, eventTarget);
    expect(out).toMatchObject({ target: eventTarget, agreementId: null, payoutTermsId: EVENT_TERMS, visibility: "FULL", mayEdit: true, perOrderPercentTotal: 100 });
    expect(out.remainder).toEqual({ payeeId: s.venuePayee, source: "STORED" });
    expect(out.clauses.find((c) => c.payeeId === s.actPayee)?.stage1).toBe("SETTLED_DIRECTLY");
    expect(out.clauses.find((c) => c.payeeId === s.supportPayee)?.stage1).toBe("PAID_PER_ORDER");

    // Finance reads the whole deal but may not edit it.
    await expect(read(s, VENUE_FINANCE, eventTarget)).resolves.toMatchObject({
      visibility: "FULL",
      mayEdit: false,
      notEditableReason: "not_payout_editor",
    });
    await expect(read(s, VENUE_EDITOR, eventTarget)).resolves.toMatchObject({ notEditableReason: null });
    // A payee who is not the owner sees their own line only.
    const own = await read(s, SUPPORT_HUMAN, eventTarget);
    expect(own).toMatchObject({ visibility: "OWN_LINE", mayEdit: false, remainder: null });
    expect(own.clauses.map((c) => c.payeeId)).toEqual([s.supportPayee]);

    const projected = await projectTermsDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_EDITOR, target: eventTarget, tiers: [{ tickets: 100, unitBasisCents: 2_000 }] },
    );
    expect(projected.target).toEqual(eventTarget);
    expect(projected.projection.visibility).toBe("FULL");
  });

  it("viewer, finance, scanner and an outsider may not write; nothing is stored", async () => {
    for (const actor of [VENUE_VIEWER, VENUE_FINANCE, VENUE_SCANNER, OUTSIDER, ACT_HUMAN]) {
      const s = eventStore();
      expect(await caught(write(s, actor, eventTarget))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(s.terms.get(EVENT_TERMS)!.deal.remainderPayeeId).toBeNull();
      expect(s.audit).toEqual([]);
    }
  });

  it("cross-org: another org's admin is refused on this event, to read and to write", async () => {
    const s = eventStore();
    expect(await caught(write(s, SOUND_ADMIN, eventTarget))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(await caught(read(s, SOUND_ADMIN, eventTarget))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // Naming their own org as remainder does not help: the owner comes from the event row.
    expect(
      await caught(write(s, VENUE_ADMIN, eventTarget, { ...guaranteeDeal, remainder: sound })),
    ).toMatchObject({ code: "invalid_input", message: "deal_remainder_not_the_event_owner" });
  });

  it("refuses terms owned by a booking agreement and points at the agreement", async () => {
    const s = standardStore();
    addFinalizedEvent(s); // EVENT_ID → TERMS_ID, the agreement's terms
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, eventId: null, status: "DRAFT" });
    const target = { kind: "EVENT" as const, eventId: EVENT_ID };
    const before = structuredClone(s.terms.get(TERMS_ID)!.deal);
    const err = (await caught(write(s, VENUE_ADMIN, target))) as { code?: string; meta?: Record<string, unknown> };
    expect(err).toMatchObject({ code: "AGREEMENT_FINALIZED", meta: { agreementId: AGREEMENT_ID } });
    expect(s.terms.get(TERMS_ID)!.deal).toEqual(before);
    expect(await caught(read(s, VENUE_ADMIN, target))).toMatchObject({ code: "AGREEMENT_FINALIZED" });
  });

  it("an event with no terms yet gets its own PRIMARY draft, linked, then the deal", async () => {
    const s = eventStore({ payoutTermsId: null });
    expect(await caught(read(s, VENUE_ADMIN, eventTarget))).toMatchObject({ code: "PAYOUT_TERMS_NOT_FOUND" });
    const out = await write(s, VENUE_ADMIN, eventTarget);
    const linked = s.events.get(OWN_EVENT)!.payoutTermsId;
    expect(linked).toBe(out.payoutTermsId);
    expect(linked).not.toBe(EVENT_TERMS);
    expect(s.locks).toContain(linked);
    expect(s.terms.get(linked!)!.deal.remainderPayeeId).toBe(s.venuePayee);
  });

  it("never writes through an event onto a default terms row", async () => {
    const s = eventStore();
    s.terms.get(EVENT_TERMS)!.isDefault = true;
    expect(await caught(write(s, VENUE_ADMIN, eventTarget))).toMatchObject({ code: "AGREEMENT_NOT_EDITABLE" });
  });

  it("a human-owned event: the owner writes; their edit-role delegate does not (payout routing is owner-only)", async () => {
    const s = eventStore({ orgId: null, humanId: ACT_HUMAN });
    s.humans.add(DELEGATE);
    s.delegations.push({ principalId: ACT_HUMAN, delegateId: DELEGATE, role: "EDITOR" });
    const ownerDeal = {
      source: "PRESET" as const,
      preset: { preset: "DOOR_SPLIT" as const, act: support, percent: 30 },
      remainder: act,
    };
    expect(await caught(write(s, DELEGATE, eventTarget, ownerDeal))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(await caught(write(s, VENUE_ADMIN, eventTarget, ownerDeal))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(write(s, ACT_HUMAN, eventTarget, ownerDeal)).resolves.toMatchObject({ remainderPayeeId: s.actPayee });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORG_DEFAULT
// ─────────────────────────────────────────────────────────────────────────────

describe("setTermsDeal — an organisation's default terms", () => {
  it("an org admin writes it; the default is provisioned when missing; reads back for edit and finance roles", async () => {
    const s = standardStore();
    const out = await write(s, VENUE_ADMIN, orgTarget());
    const defaultId = s.orgDefaults.get(VENUE_ORG);
    expect(defaultId).toBe(out.payoutTermsId);
    expect(s.terms.get(defaultId!)!.isDefault).toBe(true);
    expect(s.locks).toContain(defaultId);
    expect(s.terms.get(defaultId!)!.deal.remainderPayeeId).toBe(s.venuePayee);
    expect(s.audit.map((a) => a.action)).toContain("organization.default_deal_set");

    await expect(read(s, VENUE_ADMIN, orgTarget())).resolves.toMatchObject({ visibility: "FULL", mayEdit: true, notEditableReason: null, payoutTermsId: defaultId });
    await expect(read(s, VENUE_EDITOR, orgTarget())).resolves.toMatchObject({ visibility: "FULL", mayEdit: false, notEditableReason: "not_payout_editor" });
    await expect(read(s, VENUE_FINANCE, orgTarget())).resolves.toMatchObject({ visibility: "FULL", mayEdit: false });

    // No event: the projection asks for typed tiers — a result, not an error.
    expect(
      await projectTermsDeal({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, target: orgTarget() }),
    ).toEqual({
      target: orgTarget(),
      needsTiers: true,
      reason: "NO_EVENT",
      tiers: [],
      tiersSource: "EVENT_TICKET_TYPES",
      payees: [],
    });
    const projected = await projectTermsDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, target: orgTarget(), tiers: [{ tickets: 100, unitBasisCents: 2_000 }] },
    );
    expect(projected.projection.visibility).toBe("FULL");
  });

  it("ORG_ADMIN_ROLES only: editor, finance, viewer and an outsider may not write", async () => {
    for (const actor of [VENUE_EDITOR, VENUE_FINANCE, VENUE_VIEWER, OUTSIDER]) {
      const s = standardStore();
      expect(await caught(write(s, actor, orgTarget()))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(s.orgDefaults.size).toBe(0);
      expect(s.audit).toEqual([]);
    }
    const s = standardStore();
    expect(await caught(read(s, VENUE_VIEWER, orgTarget()))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // A payee on the venue's deals is not a reader of its template.
    expect(await caught(read(s, SUPPORT_HUMAN, orgTarget()))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("cross-org: another org's admin cannot read or write this org's default", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, orgTarget());
    const before = structuredClone(s.terms.get(s.orgDefaults.get(VENUE_ORG)!)!.deal);
    expect(
      await caught(write(s, SOUND_ADMIN, orgTarget(VENUE_ORG), { ...guaranteeDeal, remainder: sound })),
    ).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(await caught(read(s, SOUND_ADMIN, orgTarget(VENUE_ORG)))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(s.terms.get(s.orgDefaults.get(VENUE_ORG)!)!.deal).toEqual(before);
  });

  it("the remainder holder must be the org itself", async () => {
    const s = standardStore();
    expect(await caught(write(s, VENUE_ADMIN, orgTarget(), { ...guaranteeDeal, remainder: act }))).toMatchObject({
      code: "invalid_input",
      message: "deal_remainder_not_the_org",
    });
  });

  it("no payout-ready payee: PAYEE_NOT_READY and nothing provisioned", async () => {
    const s = standardStore();
    s.payees.set(s.venuePayee, { ...s.payees.get(s.venuePayee)!, payoutsEnabled: false });
    expect(await caught(write(s, VENUE_ADMIN, orgTarget()))).toMatchObject({ code: "PAYEE_NOT_READY" });
    expect(s.orgDefaults.size).toBe(0);
  });

  it("an inactive org is refused, and its read says why", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, orgTarget());
    s.orgStatus.set(VENUE_ORG, "SUSPENDED");
    expect(await caught(write(s, VENUE_ADMIN, orgTarget()))).toMatchObject({ code: "ORGANIZATION_INACTIVE" });
    await expect(read(s, VENUE_ADMIN, orgTarget())).resolves.toMatchObject({
      mayEdit: false,
      notEditableReason: "org_inactive",
    });
  });

  it("refuses a default row that an event points at (it would change live money)", async () => {
    const s = eventStore();
    s.terms.get(EVENT_TERMS)!.isDefault = true;
    s.orgDefaults.set(VENUE_ORG, EVENT_TERMS);
    expect(await caught(write(s, VENUE_ADMIN, orgTarget()))).toMatchObject({ code: "AGREEMENT_NOT_EDITABLE" });
    expect(s.terms.get(EVENT_TERMS)!.deal.remainderPayeeId).toBeNull();
  });

  it("an existing default is written in place, lock first", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, orgTarget());
    const id = s.orgDefaults.get(VENUE_ORG)!;
    s.locks.length = 0;
    await write(s, VENUE_ADMIN, orgTarget(), { ...guaranteeDeal, extraClauses: [] });
    expect(s.orgDefaults.get(VENUE_ORG)).toBe(id);
    expect(s.locks).toEqual([id]);
    expect(s.terms.get(id)!.deal.clauses.find((c) => c.payeeId === s.venuePayee)?.percent).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING_AGREEMENT — the same rules as setAgreementDeal
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1
// ─────────────────────────────────────────────────────────────────────────────

describe("setTermsDeal — caps, scoped lines, consent", () => {
  it("BLOCKING 1: the derived remainder line is stored UNCAPPED, so a narrower deal cannot strand cents", async () => {
    // Live terms: act 30% cap 30, sound 20% cap 20, owner 50% cap 50.
    const s = eventStore();
    setEventLines(s, [
      [s.actPayee, 30, 30],
      [s.soundPayee, 20, 20],
      [s.venuePayee, 50, 50],
    ]);
    await write(s, VENUE_ADMIN, eventTarget, {
      source: "PRESET",
      preset: { preset: "STRAIGHT_PERCENT", act, percent: 30 },
      remainder: venue,
    });
    const stored = s.terms.get(EVENT_TERMS)!.deal.clauses;
    // Without the fix the owner's line would be 70% cap 50: 20% of every order paid to nobody.
    expect(stored.find((c) => c.payeeId === s.venuePayee)).toMatchObject({ percent: 70, capPercent: null });
    expect(stored.find((c) => c.payeeId === s.actPayee)).toMatchObject({ percent: 30, capPercent: 30 });
  });

  it("BLOCKING 1: a complete all-capped per-order set whose caps cannot reach 100% is refused, nothing written", async () => {
    const s = eventStore();
    setEventLines(s, [
      [s.actPayee, 60, 50],
      [s.supportPayee, 40, 40],
    ]);
    const before = structuredClone(s.terms.get(EVENT_TERMS)!.deal);
    const err = await caught(
      write(s, VENUE_ADMIN, eventTarget, {
        source: "CLAUSES",
        clauses: [
          { payee: act, amountType: "PERCENT", percent: 60, basis: "GROSS" },
          { payee: support, amountType: "PERCENT", percent: 40, basis: "GROSS" },
        ],
        deductions: [],
        remainder: venue,
      }),
    );
    expect(err).toMatchObject({ code: "SPLITS_CAPS_UNSATISFIABLE" });
    expect(s.terms.get(EVENT_TERMS)!.deal).toEqual(before);
    expect(s.audit).toEqual([]);
  });

  it("WARNING 5: a single per-order line scoped to a ticket type is refused, not reused with its scope", async () => {
    const s = eventStore();
    setEventLines(s, [
      [s.actPayee, 30, null, "11111111-0000-4000-8000-000000000001"],
      [s.venuePayee, 70, null],
    ]);
    expect(
      await caught(write(s, VENUE_ADMIN, eventTarget, { source: "PRESET", preset: { preset: "STRAIGHT_PERCENT", act, percent: 30 }, remainder: venue })),
    ).toMatchObject({ code: "invalid_input", message: "deal_payee_has_scoped_per_order_line" });
  });

  it("WARNING 4: an unchanged guarantee keeps the act's decision; a lowered one resets to PENDING", async () => {
    const s = eventStore();
    await write(s, VENUE_ADMIN, eventTarget);
    // The act confirms.
    const actClause = s.terms.get(EVENT_TERMS)!.deal.clauses.find((c) => c.payeeId === s.actPayee)!;
    actClause.confirmationStatus = "CONFIRMED";
    actClause.confirmedAt = new Date("2026-10-01T00:00:00.000Z");

    // Re-saving the same preset (fresh clause ids) keeps CONFIRMED.
    await write(s, VENUE_ADMIN, eventTarget);
    expect(s.terms.get(EVENT_TERMS)!.deal.clauses.find((c) => c.payeeId === s.actPayee)).toMatchObject({
      requiresConfirmation: true,
      confirmationStatus: "CONFIRMED",
    });

    // Lowering the guarantee resets it.
    await write(s, VENUE_ADMIN, eventTarget, {
      ...guaranteeDeal,
      preset: { preset: "GUARANTEE", act, guaranteeCents: 40_000 },
    });
    expect(s.terms.get(EVENT_TERMS)!.deal.clauses.find((c) => c.payeeId === s.actPayee)).toMatchObject({
      amountCents: 40_000,
      requiresConfirmation: true,
      confirmationStatus: "PENDING",
      confirmedAt: null,
    });
  });

  it("WARNING 4: on an org default a third party's guarantee is PENDING; the org's own clauses need none", async () => {
    const s = standardStore();
    const out = await write(s, VENUE_ADMIN, orgTarget());
    const clauses = s.terms.get(out.payoutTermsId)!.deal.clauses;
    expect(clauses.find((c) => c.payeeId === s.actPayee)).toMatchObject({ requiresConfirmation: true, confirmationStatus: "PENDING" });
    expect(clauses.find((c) => c.payeeId === s.venuePayee)).toMatchObject({ requiresConfirmation: false, confirmationStatus: null });
  });
});

describe("setTermsDeal — re-checks under the lock and shared rows", () => {
  it("WARNING 6: the event's owner changed after the gate → conflict, no write, no audit", async () => {
    const s = eventStore();
    const repos = reposWith(s, {
      beforeTx: () => s.events.set(OWN_EVENT, { ...s.events.get(OWN_EVENT)!, orgId: SOUND_ORG }),
    });
    expect(
      await caught(setTermsDeal({ repos, clock }, { actorHumanId: VENUE_ADMIN, target: eventTarget, deal: guaranteeDeal, expectedDealFingerprint: currentFingerprint(s, eventTarget) })),
    ).toMatchObject({ code: "conflict", message: "deal_event_owner_changed" });
    expect(s.terms.get(EVENT_TERMS)!.deal.remainderPayeeId).toBeNull();
    expect(s.audit).toEqual([]);
  });

  it("WARNING 6: the event was re-pointed at other terms while it waited for the lock → conflict, no write, no audit", async () => {
    const s = eventStore();
    const repos = reposWith(s, {
      afterLock: () => s.events.set(OWN_EVENT, { ...s.events.get(OWN_EVENT)!, payoutTermsId: TERMS_ID }),
    });
    expect(
      await caught(setTermsDeal({ repos, clock }, { actorHumanId: VENUE_ADMIN, target: eventTarget, deal: guaranteeDeal, expectedDealFingerprint: currentFingerprint(s, eventTarget) })),
    ).toMatchObject({ code: "conflict", message: "deal_terms_changed" });
    expect(s.terms.get(EVENT_TERMS)!.deal.remainderPayeeId).toBeNull();
    expect(s.audit).toEqual([]);
  });

  it("WARNING 6: the org's default was re-pointed while it waited for the lock → conflict, no write, no audit", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, orgTarget());
    const original = s.orgDefaults.get(VENUE_ORG)!;
    const before = structuredClone(s.terms.get(original)!.deal);
    s.audit.length = 0;
    const repos = reposWith(s, { afterLock: () => s.orgDefaults.set(VENUE_ORG, EVENT_TERMS) });
    expect(
      await caught(setTermsDeal({ repos, clock }, { actorHumanId: VENUE_ADMIN, target: orgTarget(), deal: { ...guaranteeDeal, extraClauses: [] }, expectedDealFingerprint: currentFingerprint(s, orgTarget()) })),
    ).toMatchObject({ code: "conflict", message: "deal_terms_changed" });
    expect(s.terms.get(original)!.deal).toEqual(before);
    expect(s.audit).toEqual([]);
  });

  it("WARNING 3: an org default an agreement points at is refused, nothing written", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, orgTarget());
    const id = s.orgDefaults.get(VENUE_ORG)!;
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, payoutTermsId: id });
    const before = structuredClone(s.terms.get(id)!.deal);
    s.audit.length = 0;
    expect(await caught(write(s, VENUE_ADMIN, orgTarget(), { ...guaranteeDeal, extraClauses: [] }))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
      meta: { reason: "default_terms_shared" },
    });
    expect(s.terms.get(id)!.deal).toEqual(before);
    expect(s.audit).toEqual([]);
  });

  it("WARNING 3: an org default shared with a place's default (the dev seed's shape) is refused", async () => {
    const s = standardStore();
    await write(s, VENUE_ADMIN, orgTarget());
    const id = s.orgDefaults.get(VENUE_ORG)!;
    s.placeDefaults.set("bbbbbbbb-0000-4000-8000-0000000001ac", id);
    const before = structuredClone(s.terms.get(id)!.deal);
    s.audit.length = 0;
    expect(await caught(write(s, VENUE_ADMIN, orgTarget(), { ...guaranteeDeal, extraClauses: [] }))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
      meta: { reason: "default_terms_shared", references: [{ kind: "PLACE_DEFAULT_PRIMARY" }] },
    });
    await expect(read(s, VENUE_ADMIN, orgTarget())).resolves.toMatchObject({
      mayEdit: false,
      notEditableReason: "default_terms_shared",
    });
    expect(s.terms.get(id)!.deal).toEqual(before);
    expect(s.audit).toEqual([]);
  });

  it("WARNING 7c: event terms another event also points at are refused", async () => {
    const s = eventStore();
    s.events.set(EVENT_ID, { ...s.events.get(OWN_EVENT)!, id: EVENT_ID });
    expect(await caught(write(s, VENUE_ADMIN, eventTarget))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
      meta: { reason: "event_terms_shared", references: [{ kind: "EVENT_PRIMARY", id: EVENT_ID }] },
    });
    // The read says the same thing before the editor tries.
    await expect(read(s, VENUE_ADMIN, eventTarget)).resolves.toMatchObject({
      mayEdit: false,
      notEditableReason: "event_terms_shared",
    });
    expect(s.terms.get(EVENT_TERMS)!.deal.remainderPayeeId).toBeNull();
  });

  it("WARNING 7b: archived and cancelled events are refused", async () => {
    const archived = eventStore({ status: "ARCHIVED" });
    expect(await caught(write(archived, VENUE_ADMIN, eventTarget))).toMatchObject({ code: "EVENT_ARCHIVED" });
    const cancelled = eventStore({ status: "CANCELLED" });
    expect(await caught(write(cancelled, VENUE_ADMIN, eventTarget))).toMatchObject({ code: "EVENT_CANCELLED" });
    await expect(read(cancelled, VENUE_ADMIN, eventTarget)).resolves.toMatchObject({
      mayEdit: false,
      notEditableReason: "event_cancelled",
    });
    await expect(read(archived, VENUE_ADMIN, eventTarget)).resolves.toMatchObject({
      mayEdit: false,
      notEditableReason: "event_archived",
    });
  });

  it("WARNING 7a: when another writer links terms first, the guarded link conflicts and nothing is kept", async () => {
    const s = eventStore({ payoutTermsId: null });
    const repos = makeRepos(s) as unknown as {
      payoutTerms: { createDraft: (input: unknown) => Promise<{ id: string }> };
    };
    const create = repos.payoutTerms.createDraft;
    repos.payoutTerms.createDraft = async (input) => {
      const created = await create(input);
      // A concurrent writer's link lands first.
      s.events.set(OWN_EVENT, { ...s.events.get(OWN_EVENT)!, payoutTermsId: EVENT_TERMS });
      return created;
    };
    const termsBefore = s.terms.size;
    expect(
      await caught(setTermsDeal({ repos: repos as never, clock }, { actorHumanId: VENUE_ADMIN, target: eventTarget, deal: guaranteeDeal, expectedDealFingerprint: currentFingerprint(s, eventTarget) })),
    ).toMatchObject({ code: "conflict", message: "deal_terms_changed" });
    // The draft rolled back with the transaction: no orphan row.
    expect(s.terms.size).toBe(termsBefore);
    expect(s.audit).toEqual([]);
  });
});

describe("setTermsDeal — a booking agreement", () => {
  const target = { kind: "BOOKING_AGREEMENT" as const, agreementId: AGREEMENT_ID };
  const versus = {
    source: "PRESET" as const,
    preset: { preset: "VERSUS" as const, act, guaranteeCents: 80_000, percent: 70 },
    remainder: venue,
  };

  it("the agreement's edit rules: the act and a viewer refused, a non-DRAFT agreement refused, the editor writes", async () => {
    const s = standardStore();
    expect(await caught(write(s, ACT_HUMAN, target, versus))).toMatchObject({ code: "TERMS_EDITOR_ONLY" });
    expect(await caught(write(s, VENUE_VIEWER, target, versus))).toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    expect(await caught(write(s, SOUND_ADMIN, target, versus))).toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    const proposed = standardStore();
    proposed.agreements.set(AGREEMENT_ID, { ...proposed.agreements.get(AGREEMENT_ID)!, status: "PROPOSED" });
    expect(await caught(write(proposed, VENUE_ADMIN, target, versus))).toMatchObject({ code: "AGREEMENT_NOT_DRAFT" });

    await expect(write(s, VENUE_EDITOR, target, versus)).resolves.toMatchObject({ target, payoutTermsId: TERMS_ID });
    // Unchanged for bookings: the two parties agree to the whole agreement,
    // so the act's settled-directly versus clause carries no confirmation.
    expect(s.terms.get(TERMS_ID)!.deal.clauses.find((c) => c.payeeId === s.actPayee)).toMatchObject({
      amountType: "FIXED_AND_PERCENT",
      requiresConfirmation: false,
      confirmationStatus: null,
    });
    expect(s.locks[0]).toBe(TERMS_ID);
    expect(s.audit.map((a) => a.action)).toContain("booking_agreement.deal_set");
  });

  it("reads back exactly as getAgreementDeal does", async () => {
    const s = standardStore();
    await write(s, VENUE_EDITOR, target, versus);
    const viaTarget = await read(s, VENUE_ADMIN, target);
    const viaAgreement = await getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID });
    // The target read adds the target, the reason, the lost-update
    // fingerprint and the resale terms; the deal itself is the same.
    const { target: _t, notEditableReason: _r, dealFingerprint: _f, resaleTerms: _rt, ...rest } = viaTarget;
    expect(rest).toEqual(viaAgreement);
  });
});
