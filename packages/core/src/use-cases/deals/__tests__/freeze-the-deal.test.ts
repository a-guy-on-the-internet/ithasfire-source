import { describe, expect, it, vi } from "vitest";

import { confirmDealClause } from "../answer-deal-clause";
import { freezeEventDeal } from "../freeze-event-deal";
import { listDealChanges } from "../list-deal-changes";
import { setAgreementDeal } from "../set-agreement-deal";
import { setTermsDeal } from "../set-terms-deal";
import { describeDealChange, sameDealSnapshot, type EventDealSnapshot } from "../_shared/deal-freeze";
import { dealFrozenChangeRenderer } from "../../comms/deal-change-renderers";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  NOW,
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
  caught,
  clauseRecord,
  clock,
  currentFingerprint,
  makeRepos,
  standardStore,
  type FakeEvent,
} from "./deal-fakes";

/**
 * Freeze the deal (docs/specs/2026-10-14/freeze-the-deal.spec.yaml):
 * FR-003 the manual freeze, FR-004 the fence on the deal writes, FR-005 the
 * change log, FR-006 the change notice, FR-007 who reads the history.
 */

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };
const support = { kind: "human" as const, id: SUPPORT_HUMAN };

const EVENT_TERMS = "f0000000-0000-4000-8000-000000000001";
const NIGHT = "f0000000-0000-4000-8000-0000000000ee";
const FROZEN_AT = new Date("2026-10-01T09:00:00.000Z");
const target = { kind: "EVENT" as const, eventId: NIGHT };

type S = ReturnType<typeof standardStore>;

/**
 * A venue night whose deal is venue 90%, the sound company 10% (per order).
 * Frozen unless `frozen: false`.
 */
function night(opts: { frozen?: boolean; event?: Partial<FakeEvent> } = {}): S {
  const s = standardStore();
  s.terms.set(EVENT_TERMS, {
    isDefault: false,
    deal: {
      payoutTermsId: EVENT_TERMS,
      remainderPayeeId: null,
      clauses: [
        clauseRecord({ id: "f1000000-0000-4000-8000-000000000001", payoutTermsId: EVENT_TERMS, payeeId: s.venuePayee, percent: 90 }),
        clauseRecord({ id: "f1000000-0000-4000-8000-000000000002", payoutTermsId: EVENT_TERMS, payeeId: s.soundPayee, percent: 10, priority: 1 }),
      ],
      deductions: [],
    },
  });
  s.events.set(NIGHT, {
    id: NIGHT,
    orgId: VENUE_ORG,
    humanId: null,
    startsAt: SHOW_STARTS,
    endsAt: SHOW_ENDS,
    payoutTermsId: EVENT_TERMS,
    currency: "usd",
    status: "PUBLISHED",
    publishedAt: FROZEN_AT,
    title: "Lowlight at Marrow Hall",
    timezone: "America/Chicago",
    dealFrozenAt: opts.frozen === false ? null : FROZEN_AT,
    dealFrozenByHumanId: null,
    ...opts.event,
  });
  return s;
}

/** The act $500 guaranteed, Paper Moth 10%, the venue the rest. The sound company is gone. */
const guaranteeDeal = {
  source: "PRESET" as const,
  preset: { preset: "GUARANTEE" as const, act, guaranteeCents: 50_000 },
  remainder: venue,
  extraClauses: [{ payee: support, amountType: "PERCENT" as const, percent: 10, basis: "GROSS" as const }],
};

function noticeDeps() {
  return {
    notify: vi.fn(async (_input: { humanId: string; idempotencyKey: string; variant: string; payload: unknown }) => undefined),
    reportError: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function writeEventDeal(
  s: S,
  actorHumanId: string,
  extra: { frozenChange?: boolean; deal?: unknown } = {},
  deps: Partial<ReturnType<typeof noticeDeps>> = {},
) {
  return setTermsDeal(
    { repos: makeRepos(s), clock, ...deps } as never,
    {
      actorHumanId,
      target,
      deal: extra.deal ?? guaranteeDeal,
      expectedDealFingerprint: currentFingerprint(s, target),
      ...(extra.frozenChange !== undefined ? { frozenChange: extra.frozenChange } : {}),
    },
  );
}

const recipientsOf = (n: ReturnType<typeof noticeDeps>["notify"]) =>
  n.mock.calls.map(([c]) => c.humanId).sort();

// ─────────────────────────────────────────────────────────────────────────────
// FR-004 the fence
// ─────────────────────────────────────────────────────────────────────────────

describe("the fence on a frozen deal", () => {
  it("setTermsDeal (EVENT) without frozenChange is refused DEAL_FROZEN; nothing stored, nothing logged", async () => {
    const s = night();
    const before = structuredClone(s.terms.get(EVENT_TERMS)!.deal);
    expect(await caught(writeEventDeal(s, VENUE_ADMIN))).toMatchObject({ code: "DEAL_FROZEN" });
    expect(s.terms.get(EVENT_TERMS)!.deal).toEqual(before);
    expect(s.dealChanges).toEqual([]);
    expect(s.audit).toEqual([]);
  });

  it("frozenChange: false is the same refusal", async () => {
    const s = night();
    expect(await caught(writeEventDeal(s, VENUE_ADMIN, { frozenChange: false }))).toMatchObject({ code: "DEAL_FROZEN" });
  });

  it("the freeze is read AFTER the terms lock (a freeze landing while the write waited is seen)", async () => {
    const s = night({ frozen: false });
    const repos = makeRepos(s) as unknown as { deals: { lockTerms: (id: string) => Promise<boolean> } };
    const lock = repos.deals.lockTerms;
    repos.deals.lockTerms = async (id) => {
      const ok = await lock(id);
      // A publish commits its freeze while this write waited on the lock.
      s.events.set(NIGHT, { ...s.events.get(NIGHT)!, dealFrozenAt: FROZEN_AT });
      return ok;
    };
    expect(
      await caught(
        setTermsDeal({ repos: repos as never, clock }, {
          actorHumanId: VENUE_ADMIN,
          target,
          deal: guaranteeDeal,
          expectedDealFingerprint: currentFingerprint(s, target),
        }),
      ),
    ).toMatchObject({ code: "DEAL_FROZEN" });
  });

  it("the event row is locked BEFORE the terms row (event → terms, deal-freeze.ts)", async () => {
    const s = night();
    const order: string[] = [];
    const repos = makeRepos(s) as unknown as {
      events: { lockRows: (a: { ids: string[]; mode: string }) => Promise<void> };
      deals: { lockTerms: (id: string) => Promise<boolean> };
    };
    const lockRows = repos.events.lockRows;
    const lockTerms = repos.deals.lockTerms;
    repos.events.lockRows = async (a) => {
      order.push(`event:${a.ids.join(",")}:${a.mode}`);
      return lockRows(a);
    };
    repos.deals.lockTerms = async (id) => {
      order.push(`terms:${id}`);
      return lockTerms(id);
    };
    await setTermsDeal({ repos: repos as never, clock }, {
      actorHumanId: VENUE_ADMIN,
      target,
      deal: guaranteeDeal,
      expectedDealFingerprint: currentFingerprint(s, target),
      frozenChange: true,
    });
    // "update": a first write mints and links the event's terms (an UPDATE).
    expect(order.slice(0, 2)).toEqual([`event:${NIGHT}:update`, `terms:${EVENT_TERMS}`]);
  });

  it("an unfrozen deal saves as before: no DealChange, no notice", async () => {
    const s = night({ frozen: false });
    const d = noticeDeps();
    await writeEventDeal(s, VENUE_ADMIN, {}, d);
    expect(s.dealChanges).toEqual([]);
    expect(d.notify).not.toHaveBeenCalled();
    expect(s.audit.map((a) => a.action)).not.toContain("event.deal_frozen_change");
  });

  it("an org default (ORG_DEFAULT target) is never fenced", async () => {
    const s = night();
    await expect(
      setTermsDeal({ repos: makeRepos(s), clock }, {
        actorHumanId: VENUE_ADMIN,
        target: { kind: "ORG_DEFAULT", orgId: VENUE_ORG },
        deal: { source: "PRESET", preset: { preset: "GUARANTEE", act, guaranteeCents: 50_000 }, remainder: venue },
        expectedDealFingerprint: null,
      }),
    ).resolves.toBeTruthy();
  });

  it("setAgreementDeal on a booking whose draft event is frozen is refused; with frozenChange it saves and logs", async () => {
    const s = night();
    s.agreements.set(AGREEMENT_ID, { ...s.agreements.get(AGREEMENT_ID)!, draftEventId: NIGHT });
    const versus = {
      source: "PRESET" as const,
      preset: { preset: "VERSUS" as const, act, guaranteeCents: 80_000, percent: 70 },
      remainder: venue,
    };
    expect(
      await caught(setAgreementDeal({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, deal: versus })),
    ).toMatchObject({ code: "DEAL_FROZEN" });
    expect(s.dealChanges).toEqual([]);

    const d = noticeDeps();
    const out = await setAgreementDeal(
      { repos: makeRepos(s), clock, ...d } as never,
      { actorHumanId: VENUE_ADMIN, agreementId: AGREEMENT_ID, deal: versus, frozenChange: true },
    );
    expect(out).not.toHaveProperty("change");
    expect(s.dealChanges).toHaveLength(1);
    const change = s.dealChanges[0]!;
    expect(change.eventId).toBe(NIGHT);
    // The booking's terms are the primary deal in a BOOKING scope.
    expect((change.before as EventDealSnapshot).primary?.payoutTermsId).toBe(TERMS_ID);
    expect(s.audit.find((a) => a.action === "event.deal_frozen_change")?.data).toMatchObject({
      dealChangeId: change.id,
      via: "BOOKING_AGREEMENT",
      agreementId: AGREEMENT_ID,
    });
    // The act (a HUMAN payee) hears; the actor does not.
    expect(recipientsOf(d.notify)).toContain(ACT_HUMAN);
    expect(recipientsOf(d.notify)).not.toContain(VENUE_ADMIN);
  });

  it("an agreement with no event yet is never fenced", async () => {
    const s = night();
    await expect(
      setAgreementDeal({ repos: makeRepos(s), clock }, {
        actorHumanId: VENUE_ADMIN,
        agreementId: AGREEMENT_ID,
        deal: { source: "PRESET", preset: { preset: "VERSUS", act, guaranteeCents: 80_000, percent: 70 }, remainder: venue },
      }),
    ).resolves.toBeTruthy();
  });

  it("answering a clause (confirm) still works on a frozen deal (F6: not a deal write)", async () => {
    const s = night({ frozen: false });
    await writeEventDeal(s, VENUE_ADMIN);
    s.events.set(NIGHT, { ...s.events.get(NIGHT)!, dealFrozenAt: FROZEN_AT });
    const guarantee = s.terms.get(EVENT_TERMS)!.deal.clauses.find((c) => c.payeeId === s.actPayee)!;
    await expect(
      confirmDealClause({ repos: makeRepos(s), clock }, {
        actorHumanId: ACT_HUMAN,
        target,
        clauseId: guarantee.id,
        answered: {
          amountType: guarantee.amountType,
          amountCents: guarantee.amountCents,
          percent: guarantee.percent,
          basis: guarantee.basis,
          resolution: guarantee.resolution,
        },
      }),
    ).resolves.toMatchObject({ confirmationStatus: "CONFIRMED" });
    expect(s.dealChanges).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-005 / FR-006 a frozen change
// ─────────────────────────────────────────────────────────────────────────────

describe("a frozen change", () => {
  it("appends one DealChange with the deal before and after, audits it, and tells every payee but the actor", async () => {
    const s = night();
    const d = noticeDeps();
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true }, d);

    expect(s.dealChanges).toHaveLength(1);
    const change = s.dealChanges[0]!;
    expect(change).toMatchObject({ eventId: NIGHT, actorHumanId: VENUE_ADMIN, createdAt: NOW });
    const before = change.before as EventDealSnapshot;
    const after = change.after as EventDealSnapshot;
    expect(before.version).toBe(1);
    expect(before.primary?.clauses.map((c) => c.payeeId).sort()).toEqual([s.soundPayee, s.venuePayee].sort());
    expect(after.primary?.clauses.map((c) => c.payeeId)).toEqual(
      expect.arrayContaining([s.actPayee, s.supportPayee, s.venuePayee]),
    );
    // The freeze itself is untouched.
    expect(s.events.get(NIGHT)!.dealFrozenAt).toEqual(FROZEN_AT);

    expect(s.audit.filter((a) => a.action === "event.deal_frozen_change")).toEqual([
      { action: "event.deal_frozen_change", data: expect.objectContaining({ dealChangeId: change.id, actorHumanId: VENUE_ADMIN, via: "EVENT" }) },
    ]);

    // Recipients: the act + Paper Moth (added), the sound company's ADMIN
    // (removed), the venue's FINANCE. Not the actor (the venue's ADMIN, so a
    // payee's member themselves); not the venue's
    // EDITOR, VIEWER or SCANNER.
    expect(recipientsOf(d.notify)).toEqual([ACT_HUMAN, SOUND_ADMIN, SUPPORT_HUMAN, VENUE_FINANCE].sort());
    for (const humanId of [VENUE_ADMIN, VENUE_EDITOR, VENUE_VIEWER, VENUE_SCANNER, OUTSIDER]) {
      expect(recipientsOf(d.notify)).not.toContain(humanId);
    }
    for (const [call] of d.notify.mock.calls) {
      expect(call.variant).toBe("deal.frozen-change");
      expect(call.idempotencyKey).toBe(`deal-change:${change.id}:${call.humanId}`);
      expect(call.payload).toMatchObject({
        dealChangeId: change.id,
        eventId: NIGHT,
        eventTitle: "Lowlight at Marrow Hall",
        timezone: "America/Chicago",
        changedAtIso: NOW.toISOString(),
      });
    }
    expect(d.reportError).not.toHaveBeenCalled();
  });

  it("a frozen event with no terms yet: refused before anything is minted; with frozenChange, 'before' records the PRIMARY terms as absent", async () => {
    const refused = night({ event: { payoutTermsId: null } });
    const termsBefore = refused.terms.size;
    expect(await caught(writeEventDeal(refused, VENUE_ADMIN))).toMatchObject({ code: "DEAL_FROZEN" });
    expect(refused.terms.size).toBe(termsBefore);
    expect(refused.events.get(NIGHT)!.payoutTermsId).toBeNull();

    const s = night({ event: { payoutTermsId: null } });
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true }, noticeDeps());
    expect(s.dealChanges).toHaveLength(1);
    const change = s.dealChanges[0]!;
    expect((change.before as EventDealSnapshot).primary).toBeNull();
    expect((change.after as EventDealSnapshot).primary?.clauses.length).toBeGreaterThan(0);
  });

  it("a save that changes nothing appends no row and sends no notice", async () => {
    const s = night();
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true });
    expect(s.dealChanges).toHaveLength(1);
    const d = noticeDeps();
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true }, d);
    expect(s.dealChanges).toHaveLength(1);
    expect(d.notify).not.toHaveBeenCalled();
    expect(s.audit.filter((a) => a.action === "event.deal_frozen_change")).toHaveLength(1);
  });

  it("a throwing notify and a throwing reportError never fail the save", async () => {
    const s = night();
    const d = noticeDeps();
    d.notify.mockRejectedValue(new Error("mail down"));
    d.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(writeEventDeal(s, VENUE_ADMIN, { frozenChange: true }, d)).resolves.toBeTruthy();
    expect(s.dealChanges).toHaveLength(1);
    // Every recipient was still tried, each failure logged and reported.
    expect(d.notify).toHaveBeenCalledTimes(4);
    expect(d.reportError).toHaveBeenCalledTimes(4);
    expect(d.logger.error).toHaveBeenCalledWith("deal_change.notice_failed", expect.anything());
  });

  it("a notice with no notify wired is logged and reported, and the save stands", async () => {
    const s = night();
    const d = noticeDeps();
    await expect(
      writeEventDeal(s, VENUE_ADMIN, { frozenChange: true }, { reportError: d.reportError, logger: d.logger }),
    ).resolves.toBeTruthy();
    expect(s.dealChanges).toHaveLength(1);
    expect(d.reportError).toHaveBeenCalledTimes(1);
    expect(d.logger.error).toHaveBeenCalledWith("deal_change.notice_not_wired", expect.anything());
  });

  it("a write that fails INSIDE the transaction, past the fence, leaves no DealChange, no audit, no notice", async () => {
    const s = night();
    const repos = makeRepos(s) as unknown as {
      events: { getById: (id: string) => Promise<unknown> };
      deals: { replaceTermsDeal: (...a: unknown[]) => Promise<unknown> };
    };
    // Prove the fence ran and PASSED: the event was read for its freeze, and
    // the write itself was reached (a frozen change, so no DEAL_FROZEN).
    let fencePassed = false;
    repos.deals.replaceTermsDeal = async () => {
      fencePassed = true;
      throw new Error("replace failed mid-transaction");
    };
    const d = noticeDeps();
    const err = await caught(
      setTermsDeal({ repos: repos as never, clock, ...d } as never, {
        actorHumanId: VENUE_ADMIN,
        target,
        deal: guaranteeDeal,
        expectedDealFingerprint: currentFingerprint(s, target),
        frozenChange: true,
      }),
    );
    expect(fencePassed).toBe(true);
    expect(err.code).not.toBe("DEAL_FROZEN");
    expect(s.dealChanges).toEqual([]);
    expect(s.audit.filter((a) => a.action === "event.deal_frozen_change")).toEqual([]);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("a transaction that fails AFTER the DealChange was written rolls it and its audit row back; nobody is told", async () => {
    const s = night();
    const repos = makeRepos(s) as unknown as { tx: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> };
    const realTx = repos.tx.bind(repos);
    let writtenInTx = 0;
    // The commit itself fails after every write in the transaction landed.
    repos.tx = (fn) =>
      realTx(async (tx) => {
        await fn(tx);
        writtenInTx = s.dealChanges.length;
        throw new Error("commit failed");
      });
    const d = noticeDeps();
    await caught(
      setTermsDeal({ repos: repos as never, clock, ...d } as never, {
        actorHumanId: VENUE_ADMIN,
        target,
        deal: guaranteeDeal,
        expectedDealFingerprint: currentFingerprint(s, target),
        frozenChange: true,
      }),
    );
    // Inside the transaction the row existed…
    expect(writtenInTx).toBe(1);
    // …and the rollback took it, and its audit row, away.
    expect(s.dealChanges).toEqual([]);
    expect(s.audit.filter((a) => a.action === "event.deal_frozen_change")).toEqual([]);
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe("describeDealChange", () => {
  it("names the share that moved, the payee added and the payee removed", async () => {
    const s = night();
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true });
    const c = s.dealChanges[0]!;
    const lines = describeDealChange(c.before as EventDealSnapshot, c.after as EventDealSnapshot);
    const byPayee = (id: string) => lines.filter((l) => l.payeeId === id);
    expect(byPayee(s.soundPayee)).toEqual([expect.objectContaining({ section: "TICKETS", before: expect.anything(), after: null })]);
    expect(byPayee(s.supportPayee)).toEqual([expect.objectContaining({ section: "TICKETS", before: null, after: expect.anything() })]);
    expect(byPayee(s.actPayee).length).toBeGreaterThan(0);
  });

  it("the same snapshot twice describes nothing", async () => {
    const s = night();
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true });
    const after = s.dealChanges[0]!.after as EventDealSnapshot;
    expect(describeDealChange(after, structuredClone(after))).toEqual([]);
  });

  it("fresh clause / deduction ids on an unchanged deal are not a change", async () => {
    const s = night();
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true });
    const after = s.dealChanges[0]!.after as EventDealSnapshot;
    const churned = structuredClone(after);
    churned.primary!.clauses = churned.primary!.clauses
      .map((c, i) => ({ ...c, id: `f9000000-0000-4000-8000-00000000000${i}` }))
      .reverse();
    expect(sameDealSnapshot(after, churned)).toBe(true);
    expect(describeDealChange(after, churned)).toEqual([]);
    // A real difference still is one.
    churned.primary!.clauses[0]!.percent = (churned.primary!.clauses[0]!.percent ?? 0) + 1;
    expect(sameDealSnapshot(after, churned)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-003 the manual freeze
// ─────────────────────────────────────────────────────────────────────────────

describe("freezeEventDeal", () => {
  const freeze = (s: S, actorHumanId: string) =>
    freezeEventDeal({ repos: makeRepos(s), clock }, { actorHumanId, eventId: NIGHT });

  it("an editor freezes a DRAFT event's deal: stamped, audited MANUAL, event row locked before the terms", async () => {
    const s = night({ frozen: false, event: { status: "DRAFT", publishedAt: null } });
    const out = await freeze(s, VENUE_EDITOR);
    expect(out).toEqual({ eventId: NIGHT, dealFrozenAt: NOW, dealFrozenByHumanId: VENUE_EDITOR, changed: true });
    expect(s.events.get(NIGHT)).toMatchObject({ dealFrozenAt: NOW, dealFrozenByHumanId: VENUE_EDITOR });
    expect(s.eventRowLocks).toEqual([[NIGHT]]);
    expect(s.locks).toContain(EVENT_TERMS);
    expect(s.audit).toEqual([
      { action: "event.deal_frozen", data: expect.objectContaining({ source: "MANUAL", actorHumanId: VENUE_EDITOR, frozenByHumanId: VENUE_EDITOR }) },
    ]);
  });

  it("freezing also locks the terms of a DRAFT booking agreement on this event (its writes are fenced on this freeze)", async () => {
    const s = night({ frozen: false, event: { status: "DRAFT", publishedAt: null } });
    const BOOKING_TERMS = "f0000000-0000-4000-8000-0000000000b7";
    const draft = s.agreements.get(AGREEMENT_ID)!;
    s.agreements.set(AGREEMENT_ID, { ...draft, status: "DRAFT", eventId: null, draftEventId: NIGHT, payoutTermsId: BOOKING_TERMS });
    await freeze(s, VENUE_EDITOR);
    expect(s.locks).toEqual([EVENT_TERMS, BOOKING_TERMS].sort());
    // …and not the terms of a booking anchored on ANOTHER event.
    const t = night({ frozen: false, event: { status: "DRAFT", publishedAt: null } });
    const other = t.agreements.get(AGREEMENT_ID)!;
    t.agreements.set(AGREEMENT_ID, { ...other, status: "DRAFT", eventId: null, draftEventId: "f0000000-0000-4000-8000-0000000000aa", payoutTermsId: BOOKING_TERMS });
    await freeze(t, VENUE_EDITOR);
    expect(t.locks).toEqual([EVENT_TERMS]);
  });

  it("freezing a frozen deal is a no-op that returns the original freeze", async () => {
    const s = night();
    const out = await freeze(s, VENUE_ADMIN);
    expect(out).toEqual({ eventId: NIGHT, dealFrozenAt: FROZEN_AT, dealFrozenByHumanId: null, changed: false });
    expect(s.audit).toEqual([]);
  });

  it("viewer, finance, scanner and an outsider may not freeze", async () => {
    for (const who of [VENUE_VIEWER, VENUE_FINANCE, VENUE_SCANNER, OUTSIDER]) {
      const s = night({ frozen: false });
      expect(await caught(freeze(s, who))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(s.events.get(NIGHT)!.dealFrozenAt).toBeNull();
    }
  });

  it("a missing event is EVENT_NOT_FOUND", async () => {
    const s = night();
    expect(
      await caught(freezeEventDeal({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: "f0000000-0000-4000-8000-00000000dead" })),
    ).toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-007 who reads the history
// ─────────────────────────────────────────────────────────────────────────────

describe("listDealChanges", () => {
  const list = (s: S, actorHumanId: string, extra: Record<string, unknown> = {}) =>
    listDealChanges({ repos: makeRepos(s) }, { actorHumanId, eventId: NIGHT, ...extra });

  async function withTwoChanges(): Promise<S> {
    const s = night();
    await writeEventDeal(s, VENUE_ADMIN, { frozenChange: true });
    // A second change, a minute later: Paper Moth 10% → 15%.
    const later = { now: () => new Date(NOW.getTime() + 60_000) };
    await setTermsDeal({ repos: makeRepos(s), clock: later }, {
      actorHumanId: VENUE_EDITOR,
      target,
      deal: { ...guaranteeDeal, extraClauses: [{ ...guaranteeDeal.extraClauses[0]!, percent: 15 }] },
      expectedDealFingerprint: currentFingerprint(s, target),
      frozenChange: true,
    });
    expect(s.dealChanges).toHaveLength(2);
    return s;
  }

  it("an editor reads them newest first, actor named, lines described", async () => {
    const s = await withTwoChanges();
    const out = await list(s, VENUE_EDITOR);
    expect(out.items.map((i) => i.actor?.humanId)).toEqual([VENUE_EDITOR, VENUE_ADMIN]);
    expect(out.items[0]!.actor?.name).toBeTruthy();
    expect(out.items[0]!.lines.length).toBeGreaterThan(0);
    expect(out.nextCursor).toBeNull();
  });

  it("pages with a cursor", async () => {
    const s = await withTwoChanges();
    const first = await list(s, VENUE_ADMIN, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0]!.id);
    const second = await list(s, VENUE_ADMIN, { limit: 1, cursor: first.nextCursor });
    expect(second.items.map((i) => i.actor?.humanId)).toEqual([VENUE_ADMIN]);
    expect(second.nextCursor).toBeNull();
  });

  it("carries the event header and the freeze, the person who froze it named", async () => {
    const s = await withTwoChanges();
    const auto = await list(s, VENUE_EDITOR);
    expect(auto.event).toEqual({
      title: "Lowlight at Marrow Hall",
      startsAt: SHOW_STARTS,
      timezone: "America/Chicago",
      dealFrozenAt: FROZEN_AT,
      frozenBy: null,
    });
    s.events.set(NIGHT, { ...s.events.get(NIGHT)!, dealFrozenByHumanId: VENUE_ADMIN });
    const manual = await list(s, VENUE_EDITOR);
    expect(manual.event.frozenBy?.humanId).toBe(VENUE_ADMIN);
    expect(manual.event.frozenBy?.name).toBeTruthy();
  });

  it("words each line the way the notice does, in the reader's language", async () => {
    const s = await withTwoChanges();
    // The newest change: Paper Moth 10% → 15% of ticket money.
    const en = await list(s, VENUE_EDITOR);
    const line = en.items[0]!.lines.find((l) => l.before?.kind === "SHARE" && l.after?.kind === "SHARE")!;
    expect(line.text.before).toBe("10% of ticket money");
    expect(line.text.after).toBe("15% of ticket money");
    expect(line.text.subject).toMatch(/^Ticket sales, /);
    const es = await list(s, VENUE_EDITOR, { locale: "es" });
    const esLine = es.items[0]!.lines.find((l) => l.before?.kind === "SHARE" && l.after?.kind === "SHARE")!;
    expect(esLine.text.after).toBe("15% del dinero de las entradas");
    expect(esLine.text.subject).toMatch(/^Venta de entradas, /);
  });

  it("a payee the change REMOVED still reads it (the sound company's admin)", async () => {
    const s = await withTwoChanges();
    // The sound company is on no current terms…
    expect(s.terms.get(EVENT_TERMS)!.deal.clauses.map((c) => c.payeeId)).not.toContain(s.soundPayee);
    // …but was on the deal before the first change.
    await expect(list(s, SOUND_ADMIN)).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it("a human payee on the current terms reads it", async () => {
    const s = await withTwoChanges();
    await expect(list(s, SUPPORT_HUMAN)).resolves.toMatchObject({ eventId: NIGHT });
  });

  it("a stranger, and a venue VIEWER (not a payee reader role), are refused", async () => {
    const s = await withTwoChanges();
    expect(await caught(list(s, OUTSIDER))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(await caught(list(s, VENUE_VIEWER))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // A sound-company member below ADMIN/FINANCE/OWNER is not "on the deal".
    s.humans.add(OUTSIDER);
    s.memberships.push({ orgId: SOUND_ORG, humanId: OUTSIDER, role: "EDITOR" });
    expect(await caught(list(s, OUTSIDER))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("a stranger is refused the same way on an event with no changes", async () => {
    const s = night();
    expect(await caught(list(s, OUTSIDER))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-006 the notice email: currency, the recipient's language, the footer
// ─────────────────────────────────────────────────────────────────────────────

describe("the deal-change email", () => {
  const base = {
    dealChangeId: "d1000000-0000-4000-8000-000000000001",
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Night Market Sessions",
    actorName: "Sam Rivera",
    changedAtIso: "2026-11-02T18:30:00.000Z",
    timezone: "America/Chicago",
    dealUrl: null,
    lines: [
      {
        section: "BOOKING" as const,
        payeeName: null,
        label: null,
        before: { kind: "GUARANTEE" as const, cents: 50_000 },
        after: { kind: "GUARANTEE" as const, cents: 70_000 },
      },
    ],
    moreLines: 0,
  };
  const email = (extra: Record<string, unknown>) =>
    dealFrozenChangeRenderer.render(
      dealFrozenChangeRenderer.schema.parse({ ...base, ...extra }),
      { now: NOW, locale: "en" },
    ).email!;

  it("formats amounts in the deal's settlement currency, not always USD", () => {
    const usd = email({}).text;
    const eur = email({ currency: "eur" }).text;
    expect(usd).toContain("$500.00");
    expect(eur).not.toContain("$500.00");
    expect(eur).toMatch(/€\s?500|500[.,]00\s?€/u);
  });

  it("writes the email in the recipient's language", () => {
    const es = email({ emailLocale: "es" });
    expect(es.subject).toBe("Cambió el acuerdo de Night Market Sessions");
    expect(es.text).toContain("Cambio hecho por Sam Rivera");
    expect(email({}).subject).toBe("The deal for Night Market Sessions changed");
  });

  it("tells a removed payee they WERE on the deal, and never claims the email reaches 'everyone' in a way that is false", () => {
    const kept = email({ recipientRemoved: false }).text;
    const removed = email({ recipientRemoved: true }).text;
    expect(kept).toContain("You get this because you are on this deal.");
    expect(removed).toContain("You get this because you were on this deal before this change.");
    expect(removed).not.toContain("you are on this deal");
  });

  it("a stored payload from before these fields still renders (USD, English, on the deal)", () => {
    const out = email({});
    expect(out.text).toContain("$700.00");
    expect(out.text).toContain("You get this because you are on this deal.");
  });
});
