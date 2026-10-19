import { describe, expect, it, vi } from "vitest";

import {
  ACT_HUMAN,
  NOW,
  OUTSIDER,
  SHOW_ENDS,
  SHOW_STARTS,
  SOUND_ADMIN,
  SUPPORT_HUMAN,
  VENUE_ADMIN,
  VENUE_EDITOR,
  VENUE_FINANCE,
  VENUE_ORG,
  clauseRecord,
  currentFingerprint,
  makeRepos,
  standardStore,
} from "@th/core/use-cases/deals/__tests__/deal-fakes";

import { dealsRouter } from "../deals";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// freeze-the-deal at the transport, through the real use cases on the deal
// fakes: a frozen change saved through `deals.setTermsDeal` tells every payee
// (FR-006) through ctx's mailer-bound notify, reports a failed notice through
// ctx.reportError, and links the deal; `deals.freezeEventDeal` (FR-003) and
// `deals.listDealChanges` (FR-007); the freeze on `deals.getTermsDeal`.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_TERMS = "f0000000-0000-4000-8000-000000000001";
const NIGHT = "f0000000-0000-4000-8000-0000000000ee";
const FROZEN_AT = new Date("2026-10-01T09:00:00.000Z");
const target = { kind: "EVENT" as const, eventId: NIGHT };
const APP = "https://app.example.test";

type S = ReturnType<typeof standardStore>;

/** A venue night: venue 90%, the sound company 10%. Frozen unless told not. */
function night(frozen = true): S {
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
    status: frozen ? "PUBLISHED" : "DRAFT",
    publishedAt: frozen ? FROZEN_AT : null,
    title: "Lowlight at Marrow Hall",
    timezone: "America/Chicago",
    dealFrozenAt: frozen ? FROZEN_AT : null,
    dealFrozenByHumanId: null,
  });
  return s;
}

/** The act $500 guaranteed, the support act 10%, the venue the rest. */
const guaranteeDeal = {
  source: "PRESET" as const,
  preset: { preset: "GUARANTEE" as const, act: { kind: "human" as const, id: ACT_HUMAN }, guaranteeCents: 50_000 },
  remainder: { kind: "org" as const, id: VENUE_ORG },
  extraClauses: [
    { payee: { kind: "human" as const, id: SUPPORT_HUMAN }, amountType: "PERCENT" as const, percent: 10, basis: "GROSS" as const },
  ],
};

function harness(s: S, actorHumanId: string | null, extra: Record<string, unknown> = {}) {
  const ctx = {
    repos: makeRepos(s),
    actorHumanId,
    clock: { now: () => NOW },
    notify: vi.fn(async () => ({ ok: true })),
    notifyWithEmail: vi.fn(async (_i: { humanId: string; variant: string; payload: Record<string, unknown> }) => ({ ok: true })),
    reportError: vi.fn(),
    publicAppUrl: APP,
    ...extra,
  };
  return { ctx, caller: createCaller(dealsRouter, ctx as never).caller };
}

const recipients = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map(([c]) => (c as { humanId: string }).humanId).sort();

describe("deals.setTermsDeal on a frozen deal", () => {
  it("without frozenChange: CONFLICT (DEAL_FROZEN), nothing written, nobody told", async () => {
    const s = night();
    const { ctx, caller } = harness(s, VENUE_ADMIN);
    await expect(
      caller.setTermsDeal({ target, deal: guaranteeDeal, expectedDealFingerprint: currentFingerprint(s, target) }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DEAL_FROZEN" });
    expect(s.dealChanges).toEqual([]);
    expect(ctx.notifyWithEmail).not.toHaveBeenCalled();
  });

  it("with frozenChange: saved, one DealChange, every payee but the actor told by the mailer-bound notify, with the deal link", async () => {
    const s = night();
    const { ctx, caller } = harness(s, VENUE_ADMIN);
    await caller.setTermsDeal({
      target,
      deal: guaranteeDeal,
      expectedDealFingerprint: currentFingerprint(s, target),
      frozenChange: true,
    });
    expect(s.dealChanges).toHaveLength(1);
    expect(recipients(ctx.notifyWithEmail)).toEqual([ACT_HUMAN, SOUND_ADMIN, SUPPORT_HUMAN, VENUE_FINANCE].sort());
    expect(ctx.notify).not.toHaveBeenCalled();
    for (const [call] of ctx.notifyWithEmail.mock.calls) {
      expect(call.variant).toBe("deal.frozen-change");
      expect(call.payload).toMatchObject({ dealUrl: `${APP}/deals/${NIGHT}`, eventId: NIGHT });
    }
    expect(ctx.reportError).not.toHaveBeenCalled();
  });

  it("a failing notice is reported through ctx.reportError and the save still succeeds", async () => {
    const s = night();
    const { ctx, caller } = harness(s, VENUE_ADMIN, {
      notifyWithEmail: vi.fn(async () => {
        throw new Error("mailer down");
      }),
    });
    await expect(
      caller.setTermsDeal({
        target,
        deal: guaranteeDeal,
        expectedDealFingerprint: currentFingerprint(s, target),
        frozenChange: true,
      }),
    ).resolves.toBeTruthy();
    expect(s.dealChanges).toHaveLength(1);
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "mailer down" }),
      expect.objectContaining({ tags: expect.objectContaining({ step: "recipient_notify" }) }),
    );
  });
});

describe("deals.freezeEventDeal", () => {
  it("an editor freezes an unfrozen deal; getTermsDeal then carries the freeze", async () => {
    const s = night(false);
    const { caller } = harness(s, VENUE_EDITOR);
    const before = await caller.getTermsDeal({ target });
    expect(before.dealFreeze).toEqual({ eventId: NIGHT, dealFrozenAt: null, dealFrozenByHumanId: null });

    const out = await caller.freezeEventDeal({ eventId: NIGHT });
    expect(out).toEqual({ eventId: NIGHT, dealFrozenAt: NOW, dealFrozenByHumanId: VENUE_EDITOR, changed: true });

    const after = await caller.getTermsDeal({ target });
    expect(after.dealFreeze).toEqual({ eventId: NIGHT, dealFrozenAt: NOW, dealFrozenByHumanId: VENUE_EDITOR });
  });

  it("a frozen deal is a no-op returning the first freeze", async () => {
    const s = night();
    const out = await harness(s, VENUE_ADMIN).caller.freezeEventDeal({ eventId: NIGHT });
    expect(out).toEqual({ eventId: NIGHT, dealFrozenAt: FROZEN_AT, dealFrozenByHumanId: null, changed: false });
  });

  it("an outsider is FORBIDDEN, no actor is UNAUTHORIZED, a stray field is BAD_REQUEST", async () => {
    const s = night(false);
    await expect(harness(s, OUTSIDER).caller.freezeEventDeal({ eventId: NIGHT })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(harness(s, null).caller.freezeEventDeal({ eventId: NIGHT })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      harness(s, VENUE_ADMIN).caller.freezeEventDeal({ eventId: NIGHT, actorHumanId: VENUE_ADMIN } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(s.events.get(NIGHT)!.dealFrozenAt).toBeNull();
  });
});

describe("deals.listDealChanges", () => {
  async function changed(): Promise<S> {
    const s = night();
    await harness(s, VENUE_ADMIN).caller.setTermsDeal({
      target,
      deal: guaranteeDeal,
      expectedDealFingerprint: currentFingerprint(s, target),
      frozenChange: true,
    });
    return s;
  }

  it("an editor and a payee read the change; the sound company, removed by it, still reads it", async () => {
    const s = await changed();
    for (const who of [VENUE_EDITOR, ACT_HUMAN, SOUND_ADMIN]) {
      const out = await harness(s, who).caller.listDealChanges({ eventId: NIGHT });
      expect(out.items).toHaveLength(1);
      expect(out.items[0]!.actor?.humanId).toBe(VENUE_ADMIN);
      expect(out.items[0]!.lines.length).toBeGreaterThan(0);
    }
  });

  it("a stranger is FORBIDDEN", async () => {
    const s = await changed();
    await expect(harness(s, OUTSIDER).caller.listDealChanges({ eventId: NIGHT })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
