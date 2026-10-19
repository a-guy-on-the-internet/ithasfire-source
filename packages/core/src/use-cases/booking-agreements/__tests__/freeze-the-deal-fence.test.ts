import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import { removeBookingAgreementLine } from "../remove-booking-agreement-line";
import { updateBookingAgreementHeader } from "../update-booking-agreement-header";
import { upsertBookingAgreementLine } from "../upsert-booking-agreement-line";
import {
  AGREEMENT_ID,
  EVENT_ID,
  LINE_ID,
  PERFORMER_ID,
  PERFORMER_PAYEE_ID,
  TERMS_ID,
  THIRD_PARTY_HUMAN_ID,
  THIRD_PARTY_PAYEE_ID,
  VENUE_ADMIN_ID,
  VENUE_PAYEE_ID,
  buildAgreementRecord,
  buildLineRecord,
  buildPayeeRecord,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeAuthzFake,
  makeClock,
  withTx,
} from "./helpers";

/**
 * freeze-the-deal FR-004 on the booking agreement's own writers: a line
 * upsert, a line removal, and a header edit that changes the guarantee, on a
 * booking whose (draft) event's deal is frozen.
 */

const FROZEN_AT = new Date("2026-06-01T12:00:00.000Z");
const CHANGE_ID = "dc000000-0000-4000-8000-0000000000b1";

/** The deal the snapshot reads; `percent` lets a test move it between reads. */
const dealWith = (percent: number) => ({
  payoutTermsId: TERMS_ID,
  remainderPayeeId: null,
  clauses: [
    {
      id: LINE_ID,
      payeeId: PERFORMER_PAYEE_ID,
      amountType: "PERCENT",
      amountCents: null,
      percent,
      basis: "GROSS",
      resolution: null,
      displayLabel: null,
      ticketTypeId: null,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
    },
  ],
  deductions: [],
});

function build(opts: { frozen?: boolean; agreement?: Partial<AgreementRecord>; lines?: PayoutTermsLineRecord[] } = {}) {
  const agreements = makeAgreementsRepoFake(
    buildAgreementRecord({ draftEventId: EVENT_ID, ...opts.agreement }),
  );
  const audit = makeAuditFake();
  let lines = opts.lines ?? [buildLineRecord({ id: LINE_ID, payeeId: PERFORMER_PAYEE_ID, percent: 20 })];
  const payoutTerms = {
    getById: vi.fn(async (id: string) => ({ id, isDefault: false, payoutSchedule: null })),
    listLines: vi.fn(async () => lines),
    replaceLines: vi.fn(async (_id: string, inputs: unknown[]) => {
      lines = inputs as PayoutTermsLineRecord[];
    }),
  };
  /** Every row lock, in the order taken: "event:<id>" / "terms:<id>". */
  const lockOrder: string[] = [];
  const events = {
    lockRows: vi.fn(async ({ ids }: { ids: string[]; mode: string }) => {
      lockOrder.push(...ids.map((id) => `event:${id}`));
    }),
    getById: vi.fn(async (id: string) =>
      id === EVENT_ID
        ? { id, title: "Lowlight", timezone: null, payoutTermsId: null, resalePayoutTermsId: null, dealFrozenAt: opts.frozen === false ? null : FROZEN_AT }
        : null,
    ),
  };
  const createDealChange = vi.fn(async (input: { eventId: string; actorHumanId: string }) => ({
    id: CHANGE_ID,
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    createdAt: FROZEN_AT,
    before: {},
    after: {},
  }));
  const deals = {
    lockTerms: vi.fn(async (id: string) => {
      lockOrder.push(`terms:${id}`);
      return true;
    }),
    // Each snapshot reads the deal; two reads per write (before, after).
    getTermsDeal: vi.fn().mockResolvedValueOnce(dealWith(20)).mockResolvedValueOnce(dealWith(30)).mockResolvedValue(dealWith(30)),
    createDealChange,
  };
  const payees = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.includes(PERFORMER_PAYEE_ID)
        ? [buildPayeeRecord({ id: PERFORMER_PAYEE_ID, subjectType: "HUMAN", subjectId: PERFORMER_ID })]
        : [],
    ),
    upsertForSubject: vi.fn(async () =>
      buildPayeeRecord({ id: THIRD_PARTY_PAYEE_ID, subjectType: "HUMAN", subjectId: THIRD_PARTY_HUMAN_ID, status: "PENDING", stripeAccountId: null, payoutsEnabled: false, chargesEnabled: false }),
    ),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Somebody" }))),
  };
  const organizations = { getById: vi.fn(async () => null), getByIds: vi.fn(async () => []), listMembers: vi.fn() };
  const notify = vi.fn(async (_n: { humanId: string; idempotencyKey: string }) => undefined);
  const reportError = vi.fn();
  const repos = withTx({
    agreements: agreements.repo,
    payoutTerms,
    payees,
    humans,
    organizations,
    events,
    deals,
    authz: makeAuthzFake(),
    audit,
  });
  const deps = { repos, clock: makeClock(), notify, reportError } as never;
  return { deps, agreements, audit, payoutTerms, deals, events, lockOrder, notify, reportError, createDealChange, lines: () => lines };
}

const upsertInput = {
  actorHumanId: VENUE_ADMIN_ID,
  agreementId: AGREEMENT_ID,
  payeeRef: { kind: "human" as const, id: THIRD_PARTY_HUMAN_ID },
  percent: 10,
  floorCents: 0,
};

describe("upsertBookingAgreementLine — a frozen deal", () => {
  it("without frozenChange → DEAL_FROZEN, after the terms lock, nothing written", async () => {
    const w = build();
    await expect(upsertBookingAgreementLine(w.deps, upsertInput)).rejects.toMatchObject({ code: "DEAL_FROZEN" });
    expect(w.deals.lockTerms).toHaveBeenCalledWith(TERMS_ID);
    expect(w.payoutTerms.replaceLines).not.toHaveBeenCalled();
  });

  it("locks the booking's event row (share) BEFORE the terms row", async () => {
    const w = build();
    await upsertBookingAgreementLine(w.deps, { ...upsertInput, frozenChange: true });
    expect(w.lockOrder.slice(0, 2)).toEqual([`event:${EVENT_ID}`, `terms:${TERMS_ID}`]);
    expect(w.events.lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "share" });
  });

  it("an agreement re-pointed at another event while it waited is a conflict, nothing written", async () => {
    const w = build();
    // The pre-transaction read saw EVENT_ID; under the locks the agreement
    // names another draft event, so the row this write holds is the wrong one.
    const OTHER_EVENT = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    const original = w.agreements.repo.getById.getMockImplementation()!;
    let calls = 0;
    w.agreements.repo.getById.mockImplementation(async (id: string) => {
      const a = await original(id);
      calls += 1;
      return calls > 1 && a ? { ...a, draftEventId: OTHER_EVENT } : a;
    });
    await expect(upsertBookingAgreementLine(w.deps, { ...upsertInput, frozenChange: true })).rejects.toMatchObject({
      code: "conflict",
      message: "deal_scope_changed",
    });
    expect(w.payoutTerms.replaceLines).not.toHaveBeenCalled();
  });

  it("with frozenChange → saved, one DealChange, the payee told (not the actor)", async () => {
    const w = build();
    await expect(upsertBookingAgreementLine(w.deps, { ...upsertInput, frozenChange: true })).resolves.toBeTruthy();
    expect(w.payoutTerms.replaceLines).toHaveBeenCalled();
    expect(w.createDealChange).toHaveBeenCalledTimes(1);
    expect(w.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event.deal_frozen_change", data: expect.objectContaining({ via: "BOOKING_AGREEMENT", agreementId: AGREEMENT_ID }) }),
    );
    expect(w.notify.mock.calls.map(([n]) => n.humanId)).toEqual([PERFORMER_ID]);
    expect(w.notify.mock.calls[0]![0].idempotencyKey).toBe(`deal-change:${CHANGE_ID}:${PERFORMER_ID}`);
  });

  it("a booking with no event yet is never fenced", async () => {
    const w = build({ agreement: { draftEventId: null } });
    await expect(upsertBookingAgreementLine(w.deps, upsertInput)).resolves.toBeTruthy();
    expect(w.createDealChange).not.toHaveBeenCalled();
  });
});

describe("removeBookingAgreementLine — a frozen deal", () => {
  const lines = () => [
    buildLineRecord({ id: LINE_ID, payeeId: THIRD_PARTY_PAYEE_ID, percent: 10 }),
    buildLineRecord({ id: "11111111-2222-4333-8444-555555555555", payeeId: VENUE_PAYEE_ID, percent: 30 }),
  ];
  const input = { actorHumanId: VENUE_ADMIN_ID, agreementId: AGREEMENT_ID, lineId: LINE_ID };

  it("without frozenChange → DEAL_FROZEN, nothing removed", async () => {
    const w = build({ lines: lines() });
    await expect(removeBookingAgreementLine(w.deps, input)).rejects.toMatchObject({ code: "DEAL_FROZEN" });
    expect(w.payoutTerms.replaceLines).not.toHaveBeenCalled();
  });

  it("with frozenChange → removed and logged", async () => {
    const w = build({ lines: lines() });
    await expect(removeBookingAgreementLine(w.deps, { ...input, frozenChange: true })).resolves.toBeTruthy();
    expect(w.payoutTerms.replaceLines).toHaveBeenCalled();
    expect(w.createDealChange).toHaveBeenCalledTimes(1);
  });
});

describe("updateBookingAgreementHeader — a frozen deal", () => {
  const input = { actorHumanId: VENUE_ADMIN_ID, agreementId: AGREEMENT_ID };

  it("changing the guarantee without frozenChange → DEAL_FROZEN, header untouched", async () => {
    const w = build();
    await expect(updateBookingAgreementHeader(w.deps, { ...input, guaranteeCents: 70_000 })).rejects.toMatchObject({
      code: "DEAL_FROZEN",
    });
    expect(w.agreements.repo.updateHeader).not.toHaveBeenCalled();
  });

  it("a title edit is not the deal: saved, no DealChange", async () => {
    const w = build();
    await expect(updateBookingAgreementHeader(w.deps, { ...input, title: "Friday late show" })).resolves.toMatchObject({
      title: "Friday late show",
    });
    expect(w.createDealChange).not.toHaveBeenCalled();
    // Not the deal: no event row lock, no terms lock.
    expect(w.lockOrder).toEqual([]);
  });

  it("the same guarantee again is not a change: not fenced", async () => {
    const w = build({ agreement: { guaranteeCents: 50_000 } });
    await expect(updateBookingAgreementHeader(w.deps, { ...input, guaranteeCents: 50_000 })).resolves.toBeTruthy();
    expect(w.createDealChange).not.toHaveBeenCalled();
  });

  it("changing the guarantee with frozenChange → saved, one DealChange with the guarantee before/after", async () => {
    const w = build({ agreement: { guaranteeCents: 50_000 } });
    // The deal's lines stay put; only the guarantee moves.
    w.deals.getTermsDeal.mockReset();
    w.deals.getTermsDeal.mockResolvedValue(dealWith(20));
    await expect(
      updateBookingAgreementHeader(w.deps, { ...input, guaranteeCents: 70_000, frozenChange: true }),
    ).resolves.toMatchObject({ guaranteeCents: 70_000 });
    expect(w.createDealChange).toHaveBeenCalledTimes(1);
    expect(w.lockOrder[0]).toBe(`event:${EVENT_ID}`);
    const [arg] = w.createDealChange.mock.calls[0]! as unknown as [
      { before: { booking: { guaranteeCents: number } }; after: { booking: { guaranteeCents: number } } },
    ];
    expect(arg.before.booking.guaranteeCents).toBe(50_000);
    expect(arg.after.booking.guaranteeCents).toBe(70_000);
    expect(w.notify.mock.calls.map(([n]) => n.humanId)).toEqual([PERFORMER_ID]);
  });
});
