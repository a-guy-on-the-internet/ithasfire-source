import { describe, expect, it, vi } from "vitest";

import { getTermsDeal } from "../get-terms-deal";
import { setResaleClause } from "../set-resale-clause";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  OUTSIDER,
  SHOW_ENDS,
  SHOW_STARTS,
  VENUE_ADMIN,
  VENUE_EDITOR,
  VENUE_FINANCE,
  VENUE_ORG,
  VENUE_VIEWER,
  caught,
  clauseRecord,
  clock,
  makeRepos,
  standardStore,
} from "./deal-fakes";

/**
 * setResaleClause (organiser-resale-share FR-001, FR-002, FR-011): the clause
 * on the RESALE terms of an event, a booking's event, and an org's default.
 * Pins who may write each, the 10% limit and FLAT 0 refusals, "not set"
 * allowed, the lines requirement, and that the version moves only when the
 * clause does (a ticket keys its recorded clause by terms id + version).
 */

const EVENT_ID = "c0000000-0000-4000-8000-0000000000ee";
const EVENT_TERMS = "c0000000-0000-4000-8000-000000000001";
const RESALE_TERMS = "c0000000-0000-4000-8000-0000000000a1";
const ORG_TEMPLATE = "c0000000-0000-4000-8000-0000000000b1";
const OTHER_EVENT = "c0000000-0000-4000-8000-0000000000ff";
const PLACE_ID = "c0000000-0000-4000-8000-0000000000cc";

type ResaleRow = {
  id: string;
  kind: "RESALE";
  status: "PENDING" | "ACTIVE" | "ARCHIVED";
  isDefault: boolean;
  version: number;
  resaleShareType: "PERCENT" | "FLAT" | null;
  resaleShareBps: number | null;
  resaleShareCents: number | null;
  resaleSharePayer: "SELLER" | "BUYER";
  lines: number;
};

function resaleRow(id: string, overrides: Partial<ResaleRow> = {}): ResaleRow {
  return {
    id,
    kind: "RESALE",
    status: "PENDING",
    isDefault: false,
    version: 1,
    resaleShareType: null,
    resaleShareBps: null,
    resaleShareCents: null,
    resaleSharePayer: "SELLER",
    lines: 1,
    ...overrides,
  };
}

/**
 * The deal fakes, plus RESALE terms rows and the two pointers to them
 * (`Event.resalePayoutTermsId`, `Organization.defaultResalePayoutTermsId`).
 */
function world(opts: { eventStatus?: string; eventResale?: string | null } = {}) {
  const s = standardStore();
  s.terms.set(EVENT_TERMS, {
    isDefault: false,
    deal: {
      payoutTermsId: EVENT_TERMS,
      remainderPayeeId: null,
      clauses: [clauseRecord({ payoutTermsId: EVENT_TERMS, payeeId: s.venuePayee, percent: 100 })],
      deductions: [],
    },
  });
  s.events.set(EVENT_ID, {
    id: EVENT_ID,
    orgId: VENUE_ORG,
    humanId: null,
    startsAt: SHOW_STARTS,
    endsAt: SHOW_ENDS,
    payoutTermsId: EVENT_TERMS,
    currency: "usd",
    status: opts.eventStatus ?? "DRAFT",
    publishedAt: null,
  });

  const resale = new Map<string, ResaleRow>([[RESALE_TERMS, resaleRow(RESALE_TERMS)]]);
  const eventResale = new Map<string, string>();
  if (opts.eventResale !== null) eventResale.set(EVENT_ID, opts.eventResale ?? RESALE_TERMS);
  const orgResale = new Map<string, string>();
  const placeResale = new Map<string, string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repos = makeRepos(s) as any;
  const hooks: { afterLock?: (id: string) => void; beforeLink?: (orgId: string) => void } = {};

  const getEvent = repos.events.getById;
  repos.events.getById = async (id: string) => {
    const e = await getEvent(id);
    return e ? { ...e, resalePayoutTermsId: eventResale.get(id) ?? null } : null;
  };
  const getOrg = repos.organizations.getById;
  repos.organizations.getById = async (id: string) => {
    const o = await getOrg(id);
    return o ? { ...o, defaultResalePayoutTermsId: orgResale.get(id) ?? null } : null;
  };
  // The guarded first-mint link: only while the org has no template.
  const linkCalls: Array<{ orgId: string; payoutTermsId: string }> = [];
  repos.deals.linkOrgDefaultResaleTermsIfUnset = async (input: { orgId: string; payoutTermsId: string }) => {
    linkCalls.push(input);
    hooks.beforeLink?.(input.orgId);
    if (orgResale.has(input.orgId)) return false;
    orgResale.set(input.orgId, input.payoutTermsId);
    return true;
  };
  const getTerms = repos.payoutTerms.getById;
  repos.payoutTerms.getById = async (id: string) => {
    const r = resale.get(id);
    return r ? { ...r } : getTerms(id);
  };
  const createDraft = repos.payoutTerms.createDraft;
  repos.payoutTerms.createDraft = async (input: { kind: string } & Partial<ResaleRow>) => {
    if (input.kind !== "RESALE") return createDraft(input);
    const id = `c0000000-0000-4000-8000-00000000${String(resale.size).padStart(4, "0")}`;
    const row = resaleRow(id, {
      lines: 0,
      resaleShareType: input.resaleShareType ?? null,
      resaleShareBps: input.resaleShareBps ?? null,
      resaleShareCents: input.resaleShareCents ?? null,
      resaleSharePayer: input.resaleSharePayer ?? "SELLER",
    });
    resale.set(id, row);
    return { ...row };
  };
  repos.payoutTerms.updateDraft = async (
    input: { payoutTermsId: string; bumpVersion?: boolean } & Partial<ResaleRow>,
  ) => {
    const r = resale.get(input.payoutTermsId)!;
    for (const k of ["resaleShareType", "resaleShareBps", "resaleShareCents", "resaleSharePayer"] as const) {
      if (input[k] !== undefined) (r as Record<string, unknown>)[k] = input[k];
    }
    if (input.bumpVersion) r.version += 1;
    return { ...r };
  };
  const listLines = repos.payoutTerms.listLines;
  repos.payoutTerms.listLines = async (id: string) => {
    const r = resale.get(id);
    return r ? Array.from({ length: r.lines }, (_, i) => ({ id: `line-${i}` })) : listLines(id);
  };
  const lockTerms = repos.deals.lockTerms;
  repos.deals.lockTerms = async (id: string) => {
    const ok = resale.has(id) ? (s.locks.push(id), true) : await lockTerms(id);
    hooks.afterLock?.(id);
    return ok;
  };
  const listRefs = repos.deals.listTermsReferences;
  repos.deals.listTermsReferences = async (id: string) => [
    ...(await listRefs(id)),
    ...[...eventResale].filter(([, t]) => t === id).map(([e]) => ({ kind: "EVENT_RESALE", id: e })),
    ...[...orgResale].filter(([, t]) => t === id).map(([o]) => ({ kind: "ORG_DEFAULT_RESALE", id: o })),
    ...[...placeResale].filter(([, t]) => t === id).map(([p]) => ({ kind: "PLACE_DEFAULT_RESALE", id: p })),
  ];

  const set = (actorHumanId: string, target: unknown, clause: unknown, expectedVersion: number | null) =>
    setResaleClause({ repos, clock }, { actorHumanId, target, clause, expectedVersion });
  return { s, repos, resale, eventResale, orgResale, placeResale, hooks, linkCalls, set };
}

const eventTarget = { kind: "EVENT" as const, eventId: EVENT_ID };
const bookingTarget = { kind: "BOOKING_AGREEMENT" as const, agreementId: AGREEMENT_ID };
const orgTarget = { kind: "ORG_DEFAULT" as const, orgId: VENUE_ORG };
const tenPercent = { type: "PERCENT" as const, bps: 1000, payer: "SELLER" as const };
const flatFive = { type: "FLAT" as const, cents: 500, payer: "BUYER" as const };

describe("setResaleClause — EVENT", () => {
  it("an editor sets 10% SELLER: the clause is stored, the version goes up once, under the lock, audited", async () => {
    const w = world();
    const out = await w.set(VENUE_EDITOR, eventTarget, tenPercent, 1);
    expect(out).toMatchObject({
      payoutTermsId: RESALE_TERMS,
      version: 2,
      changed: true,
      clause: { type: "PERCENT", bps: 1000, cents: null, payer: "SELLER" },
    });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({
      resaleShareType: "PERCENT",
      resaleShareBps: 1000,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 2,
    });
    expect(w.s.locks).toContain(RESALE_TERMS);
    expect(w.s.audit.map((a) => a.action)).toEqual(["resale_clause_set"]);
    expect(w.s.audit[0]!.data).toMatchObject({ before: null, after: tenPercent, version: 2, eventId: EVENT_ID });
  });

  it("the version moves only when the clause changes: same clause → nothing written; a new one → +1; cleared → +1", async () => {
    const w = world();
    await w.set(VENUE_EDITOR, eventTarget, tenPercent, 1);
    const same = await w.set(VENUE_EDITOR, eventTarget, tenPercent, 2);
    expect(same).toMatchObject({ version: 2, changed: false });
    expect(w.s.audit).toHaveLength(1);

    const flat = await w.set(VENUE_EDITOR, eventTarget, flatFive, 2);
    expect(flat).toMatchObject({ version: 3, changed: true });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 500,
      resaleSharePayer: "BUYER",
    });

    // Payer alone is a change.
    const payer = await w.set(VENUE_EDITOR, eventTarget, { ...flatFive, payer: "SELLER" }, 3);
    expect(payer).toMatchObject({ version: 4, changed: true });

    const cleared = await w.set(VENUE_EDITOR, eventTarget, null, 4);
    expect(cleared).toMatchObject({ version: 5, changed: true, clause: null });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({ resaleShareType: null, resaleShareCents: null });
  });

  it("zero is a set clause (PERCENT 0), distinct from not set", async () => {
    const w = world();
    const out = await w.set(VENUE_EDITOR, eventTarget, { type: "PERCENT", bps: 0, payer: "SELLER" }, 1);
    expect(out).toMatchObject({ version: 2, changed: true });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({ resaleShareType: "PERCENT", resaleShareBps: 0 });
  });

  it("a stale expectedVersion → conflict, nothing written", async () => {
    const w = world();
    await w.set(VENUE_EDITOR, eventTarget, tenPercent, 1);
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, flatFive, 1))).toMatchObject({
      code: "conflict",
      message: "resale_clause_changed",
    });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({ resaleShareType: "PERCENT", version: 2 });
  });

  it("a set clause needs a RESALE payout line; clearing does not", async () => {
    const w = world();
    w.resale.get(RESALE_TERMS)!.lines = 0;
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({
      code: "AGREEMENT_MISSING_LINES",
    });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({ resaleShareType: null, version: 1 });
    expect(w.s.audit).toEqual([]);
    w.resale.get(RESALE_TERMS)!.resaleShareType = "PERCENT";
    w.resale.get(RESALE_TERMS)!.resaleShareBps = 500;
    await expect(w.set(VENUE_EDITOR, eventTarget, null, 1)).resolves.toMatchObject({ changed: true, version: 2 });
  });

  it("an event with no RESALE terms: clearing is a no-op; setting is refused for want of lines", async () => {
    const w = world({ eventResale: null });
    await expect(w.set(VENUE_EDITOR, eventTarget, null, null)).resolves.toMatchObject({
      payoutTermsId: null,
      version: null,
      changed: false,
    });
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, null))).toMatchObject({
      code: "AGREEMENT_MISSING_LINES",
    });
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, null, 1))).toMatchObject({
      code: "conflict",
      message: "resale_clause_changed",
    });
  });

  it.each([
    ["a viewer", VENUE_VIEWER],
    ["finance", VENUE_FINANCE],
    ["an outsider", OUTSIDER],
    ["the act", ACT_HUMAN],
  ])("%s may not write it → INSUFFICIENT_ROLE", async (_label, actor) => {
    const w = world();
    expect(await caught(w.set(actor, eventTarget, tenPercent, 1))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
  });

  it("refuses a cancelled event and terms shared with another event", async () => {
    const cancelled = world({ eventStatus: "CANCELLED" });
    expect(await caught(cancelled.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({
      code: "EVENT_CANCELLED",
    });
    const shared = world();
    shared.eventResale.set(OTHER_EVENT, RESALE_TERMS);
    expect(await caught(shared.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
    });
    expect(shared.resale.get(RESALE_TERMS)!.version).toBe(1);
  });

  it.each([
    ["cancelled", "CANCELLED", "EVENT_CANCELLED"],
    ["archived", "ARCHIVED", "EVENT_ARCHIVED"],
  ])("the event %s while the write waited for the locks → refused under them, nothing written", async (_label, status, code) => {
    for (const [target, actor] of [
      [eventTarget, VENUE_EDITOR],
      [bookingTarget, VENUE_EDITOR],
    ] as const) {
      const w = world();
      if (target === bookingTarget) {
        // The DRAFT booking anchored on this event (the BOOKING target's path).
        const a = w.s.agreements.get(AGREEMENT_ID)!;
        w.s.agreements.set(AGREEMENT_ID, { ...a, draftEventId: EVENT_ID });
      }
      w.hooks.afterLock = () => {
        w.s.events.set(EVENT_ID, { ...w.s.events.get(EVENT_ID)!, status });
      };
      expect(await caught(w.set(actor, target, tenPercent, 1))).toMatchObject({ code });
      expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
      expect(w.resale.get(RESALE_TERMS)!.resaleShareBps).not.toBe(1000);
    }
  });

  it("the event re-pointed at other RESALE terms while it waited for the lock → conflict", async () => {
    const w = world();
    w.resale.set("c0000000-0000-4000-8000-0000000000a2", resaleRow("c0000000-0000-4000-8000-0000000000a2"));
    w.hooks.afterLock = () => w.eventResale.set(EVENT_ID, "c0000000-0000-4000-8000-0000000000a2");
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({
      code: "conflict",
      message: "deal_terms_changed",
    });
    expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
  });
});

describe("setResaleClause — the 10% limit and FLAT 0 (FR-002), at the boundary", () => {
  it.each([
    ["bps above 1000", { type: "PERCENT", bps: 1001, payer: "SELLER" }],
    ["FLAT 0", { type: "FLAT", cents: 0, payer: "SELLER" }],
    ["FLAT negative", { type: "FLAT", cents: -1, payer: "SELLER" }],
    ["PERCENT carrying cents", { type: "PERCENT", bps: 500, cents: 100, payer: "SELLER" }],
    ["an unknown payer", { type: "PERCENT", bps: 500, payer: "PLATFORM" }],
    ["fractional bps", { type: "PERCENT", bps: 10.5, payer: "SELLER" }],
  ])("%s → invalid_input, nothing written", async (_label, clause) => {
    const w = world();
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, clause, 1))).toMatchObject({ code: "invalid_input" });
    expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
  });

  it("10% exactly is allowed", async () => {
    const w = world();
    await expect(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1)).resolves.toMatchObject({ changed: true });
  });
});

describe("setResaleClause — EVENT while a booking holds the event (review B1)", () => {
  const anchorBooking = (w: ReturnType<typeof world>, status: string, finalized = false) => {
    const a = w.s.agreements.get(AGREEMENT_ID)!;
    w.s.agreements.set(AGREEMENT_ID, {
      ...a,
      status: status as typeof a.status,
      draftEventId: EVENT_ID,
      eventId: finalized ? EVENT_ID : null,
    });
  };

  it.each(["DRAFT", "PROPOSED", "COUNTERED", "ACCEPTED"])(
    "a %s booking not yet finalized owns the clause: an EVENT write is refused, version unchanged",
    async (status) => {
      const w = world();
      anchorBooking(w, status);
      expect(await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({
        code: "AGREEMENT_NOT_EDITABLE",
        meta: { reason: "event_resale_owned_by_booking", agreementId: AGREEMENT_ID },
      });
      expect(w.resale.get(RESALE_TERMS)).toMatchObject({ resaleShareType: null, version: 1 });
      expect(w.s.audit).toEqual([]);
      // Read under the lock, so a booking linked while the write waited is seen.
      expect(w.s.locks).toEqual([RESALE_TERMS]);
    },
  );

  it("the DRAFT booking itself may still write it (BOOKING target)", async () => {
    const w = world();
    anchorBooking(w, "DRAFT");
    await expect(w.set(VENUE_EDITOR, bookingTarget, tenPercent, 1)).resolves.toMatchObject({ version: 2 });
  });

  it.each([
    ["finalized", "ACCEPTED", true],
    ["cancelled", "CANCELLED", false],
    ["declined", "DECLINED", false],
  ] as const)("after the booking is %s, an EVENT write is allowed", async (_label, status, finalized) => {
    const w = world();
    anchorBooking(w, status, finalized);
    await expect(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1)).resolves.toMatchObject({
      version: 2,
      changed: true,
    });
  });
});

describe("setResaleClause — clearing while resale is on (review B2)", () => {
  it("clearing is refused while a ticket type allows resale: RESALE_SHARE_IN_USE, nothing written", async () => {
    const w = world();
    await w.set(VENUE_EDITOR, eventTarget, tenPercent, 1);
    w.s.ticketTypes.set(EVENT_ID, [
      { id: "tt-off", resaleAllowed: false },
      { id: "tt-on", resaleAllowed: true },
    ]);
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, null, 2))).toMatchObject({
      code: "RESALE_SHARE_IN_USE",
      meta: { reason: "resale_on_for_ticket_types", payoutTermsId: RESALE_TERMS, ticketTypeIds: ["tt-on"] },
    });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({ resaleShareType: "PERCENT", version: 2 });
    expect(w.s.audit).toHaveLength(1);
  });

  it("changing the clause (not clearing it) while resale is on is allowed", async () => {
    const w = world();
    await w.set(VENUE_EDITOR, eventTarget, tenPercent, 1);
    w.s.ticketTypes.set(EVENT_ID, [{ id: "tt-on", resaleAllowed: true }]);
    await expect(w.set(VENUE_EDITOR, eventTarget, flatFive, 2)).resolves.toMatchObject({ version: 3 });
  });

  it("with resale off on every type, clearing goes through", async () => {
    const w = world();
    await w.set(VENUE_EDITOR, eventTarget, tenPercent, 1);
    w.s.ticketTypes.set(EVENT_ID, [{ id: "tt-off", resaleAllowed: false }]);
    await expect(w.set(VENUE_EDITOR, eventTarget, null, 2)).resolves.toMatchObject({ version: 3, clause: null });
  });
});

describe("setResaleClause — refusals on the terms row (review W6)", () => {
  it.each([
    ["ARCHIVED terms", { status: "ARCHIVED" as const }, "terms_archived"],
    ["a default row", { isDefault: true }, undefined],
  ])("%s → AGREEMENT_NOT_EDITABLE, version unchanged", async (_label, overrides, reason) => {
    const w = world();
    Object.assign(w.resale.get(RESALE_TERMS)!, overrides);
    const err = await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1));
    expect(err).toMatchObject({ code: "AGREEMENT_NOT_EDITABLE" });
    if (reason) expect(err).toMatchObject({ meta: { reason } });
    expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
  });

  it("terms that are not RESALE → AGREEMENT_NOT_EDITABLE (not_resale_terms)", async () => {
    const w = world();
    (w.resale.get(RESALE_TERMS) as unknown as { kind: string }).kind = "PRIMARY";
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
      meta: { reason: "not_resale_terms" },
    });
    expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
  });

  it("a human-owned event: the owner writes it; a delegate (not the owner) is refused", async () => {
    const w = world();
    const e = w.s.events.get(EVENT_ID)!;
    w.s.events.set(EVENT_ID, { ...e, orgId: null, humanId: ACT_HUMAN });
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    w.s.delegations.push({ principalId: ACT_HUMAN, delegateId: VENUE_VIEWER, role: "ADMIN" });
    expect(await caught(w.set(VENUE_VIEWER, eventTarget, tenPercent, 1))).toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
    await expect(w.set(ACT_HUMAN, eventTarget, tenPercent, 1)).resolves.toMatchObject({ version: 2 });
  });
});

describe("setResaleClause — BOOKING_AGREEMENT", () => {
  const withDraftEvent = (w: ReturnType<typeof world>) => {
    const a = w.s.agreements.get(AGREEMENT_ID)!;
    w.s.agreements.set(AGREEMENT_ID, { ...a, draftEventId: EVENT_ID });
  };

  it("the terms-editor side writes the clause on the agreement's event's RESALE terms", async () => {
    const w = world();
    withDraftEvent(w);
    const out = await w.set(VENUE_EDITOR, bookingTarget, tenPercent, 1);
    expect(out).toMatchObject({ payoutTermsId: RESALE_TERMS, version: 2, changed: true });
    expect(w.s.audit[0]!.data).toMatchObject({ agreementId: AGREEMENT_ID, eventId: EVENT_ID });
  });

  it("the act is not the terms editor → TERMS_EDITOR_ONLY", async () => {
    const w = world();
    withDraftEvent(w);
    expect(await caught(w.set(ACT_HUMAN, bookingTarget, tenPercent, 1))).toMatchObject({
      code: "TERMS_EDITOR_ONLY",
    });
  });

  it("a venue viewer is not an edit-level party → refused", async () => {
    const w = world();
    withDraftEvent(w);
    const err = await caught(w.set(VENUE_VIEWER, bookingTarget, tenPercent, 1));
    expect(err.code).toBeDefined();
    expect(w.resale.get(RESALE_TERMS)!.version).toBe(1);
  });

  it("no event yet → AGREEMENT_NOT_EDITABLE (agreement_has_no_event_yet)", async () => {
    const w = world();
    expect(await caught(w.set(VENUE_EDITOR, bookingTarget, tenPercent, 1))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
    });
  });

  it("a proposed (no longer DRAFT) agreement → AGREEMENT_NOT_DRAFT", async () => {
    const w = world();
    withDraftEvent(w);
    const a = w.s.agreements.get(AGREEMENT_ID)!;
    w.s.agreements.set(AGREEMENT_ID, { ...a, status: "PROPOSED" });
    expect(await caught(w.set(VENUE_EDITOR, bookingTarget, tenPercent, 1))).toMatchObject({
      code: "AGREEMENT_NOT_DRAFT",
    });
  });
});

describe("setResaleClause — ORG_DEFAULT", () => {
  it("an admin's first clause mints the template, pins it to the org, version 1, no lines needed", async () => {
    const w = world();
    const out = await w.set(VENUE_ADMIN, orgTarget, tenPercent, null);
    expect(out).toMatchObject({ version: 1, changed: true });
    const id = w.orgResale.get(VENUE_ORG)!;
    expect(out.payoutTermsId).toBe(id);
    expect(w.resale.get(id)).toMatchObject({ resaleShareType: "PERCENT", resaleShareBps: 1000, lines: 0 });
  });

  it("changing an existing template bumps its version; clearing with none set is a no-op", async () => {
    const w = world();
    w.resale.set(ORG_TEMPLATE, resaleRow(ORG_TEMPLATE, { lines: 0 }));
    w.orgResale.set(VENUE_ORG, ORG_TEMPLATE);
    await expect(w.set(VENUE_ADMIN, orgTarget, flatFive, 1)).resolves.toMatchObject({ version: 2, changed: true });
    await expect(w.set(VENUE_ADMIN, orgTarget, flatFive, 2)).resolves.toMatchObject({ version: 2, changed: false });

    const none = world();
    await expect(none.set(VENUE_ADMIN, orgTarget, null, null)).resolves.toMatchObject({
      payoutTermsId: null,
      changed: false,
    });
    expect(none.orgResale.size).toBe(0);
  });

  it.each([
    ["an editor", VENUE_EDITOR],
    ["finance", VENUE_FINANCE],
    ["an outsider", OUTSIDER],
  ])("%s may not write the default → INSUFFICIENT_ROLE", async (_label, actor) => {
    const w = world();
    expect(await caught(w.set(actor, orgTarget, tenPercent, null))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(w.orgResale.size).toBe(0);
  });

  it("an inactive org → ORGANIZATION_INACTIVE, nothing minted", async () => {
    const w = world();
    w.s.orgStatus.set(VENUE_ORG, "SUSPENDED");
    expect(await caught(w.set(VENUE_ADMIN, orgTarget, tenPercent, null))).toMatchObject({
      code: "ORGANIZATION_INACTIVE",
    });
    expect(w.orgResale.size).toBe(0);
    expect(w.linkCalls).toEqual([]);
  });

  it("a concurrent first save linked a template first → conflict, this mint is not linked (review W3)", async () => {
    const w = world();
    w.hooks.beforeLink = (orgId) => w.orgResale.set(orgId, ORG_TEMPLATE);
    expect(await caught(w.set(VENUE_ADMIN, orgTarget, tenPercent, null))).toMatchObject({
      code: "conflict",
      message: "deal_terms_changed",
    });
    expect(w.orgResale.get(VENUE_ORG)).toBe(ORG_TEMPLATE);
    expect(w.linkCalls).toHaveLength(1);
    expect(w.s.audit).toEqual([]);
  });

  it("a template shared with a place's default → AGREEMENT_NOT_EDITABLE", async () => {
    const w = world();
    w.resale.set(ORG_TEMPLATE, resaleRow(ORG_TEMPLATE, { lines: 0 }));
    w.orgResale.set(VENUE_ORG, ORG_TEMPLATE);
    w.placeResale.set(PLACE_ID, ORG_TEMPLATE);
    expect(await caught(w.set(VENUE_ADMIN, orgTarget, tenPercent, 1))).toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
    });
    expect(w.resale.get(ORG_TEMPLATE)!.version).toBe(1);
  });
});

describe("getTermsDeal — reads the resale clause back (for C2)", () => {
  it("EVENT: the clause, its version and the line count", async () => {
    const w = world();
    await w.set(VENUE_EDITOR, eventTarget, flatFive, 1);
    const read = await getTermsDeal({ repos: w.repos }, { actorHumanId: VENUE_ADMIN, target: eventTarget });
    expect(read.resaleTerms).toEqual({
      payoutTermsId: RESALE_TERMS,
      version: 2,
      clause: { type: "FLAT", bps: null, cents: 500, payer: "BUYER" },
      resaleLineCount: 1,
    });
  });

  it("an OWN_LINE viewer sees the clause, not the row id, version or line count (review NIT)", async () => {
    const w = world();
    await w.set(VENUE_EDITOR, eventTarget, flatFive, 1);
    w.s.terms
      .get(EVENT_TERMS)!
      .deal.clauses.push(clauseRecord({ payoutTermsId: EVENT_TERMS, payeeId: w.s.actPayee, percent: 0 }));
    const read = await getTermsDeal({ repos: w.repos }, { actorHumanId: ACT_HUMAN, target: eventTarget });
    expect(read.visibility).toBe("OWN_LINE");
    expect(read.resaleTerms).toEqual({
      payoutTermsId: null,
      version: null,
      clause: { type: "FLAT", bps: null, cents: 500, payer: "BUYER" },
      resaleLineCount: null,
    });
  });

  it("no RESALE terms: FULL reads a line count of 0, OWN_LINE reads null", async () => {
    const w = world({ eventResale: null });
    w.s.terms
      .get(EVENT_TERMS)!
      .deal.clauses.push(clauseRecord({ payoutTermsId: EVENT_TERMS, payeeId: w.s.actPayee, percent: 0 }));
    const full = await getTermsDeal({ repos: w.repos }, { actorHumanId: VENUE_ADMIN, target: eventTarget });
    expect(full.resaleTerms).toEqual({ payoutTermsId: null, version: null, clause: null, resaleLineCount: 0 });
    const own = await getTermsDeal({ repos: w.repos }, { actorHumanId: ACT_HUMAN, target: eventTarget });
    expect(own.resaleTerms).toEqual({ payoutTermsId: null, version: null, clause: null, resaleLineCount: null });
  });

  it("not set reads as clause null", async () => {
    const w = world();
    const read = await getTermsDeal({ repos: w.repos }, { actorHumanId: VENUE_ADMIN, target: eventTarget });
    expect(read.resaleTerms).toMatchObject({ payoutTermsId: RESALE_TERMS, version: 1, clause: null });
  });
});

// freeze-the-deal FR-004: the resale clause is part of the deal.
describe("setResaleClause — a frozen deal", () => {
  const FROZEN_AT = new Date("2026-10-01T09:00:00.000Z");
  /** world(), frozen, with the RESALE terms' lines readable for the snapshot. */
  const frozenWorld = () => {
    const w = world();
    w.s.events.set(EVENT_ID, { ...w.s.events.get(EVENT_ID)!, dealFrozenAt: FROZEN_AT });
    w.s.terms.set(RESALE_TERMS, {
      isDefault: false,
      deal: {
        payoutTermsId: RESALE_TERMS,
        remainderPayeeId: null,
        clauses: [clauseRecord({ payoutTermsId: RESALE_TERMS, payeeId: w.s.venuePayee, percent: 100 })],
        deductions: [],
      },
    });
    return w;
  };
  const notice = () => ({ notify: vi.fn(async (_n: { humanId: string }) => undefined), reportError: vi.fn() });

  it("EVENT: without frozenChange → DEAL_FROZEN, the clause and version untouched", async () => {
    const w = frozenWorld();
    expect(await caught(w.set(VENUE_EDITOR, eventTarget, tenPercent, 1))).toMatchObject({ code: "DEAL_FROZEN" });
    expect(w.resale.get(RESALE_TERMS)).toMatchObject({ resaleShareType: null, version: 1 });
    expect(w.s.dealChanges).toEqual([]);
  });

  it("EVENT: with frozenChange → saved, one DealChange (resale share before/after), payees told", async () => {
    const w = frozenWorld();
    const n = notice();
    const out = await setResaleClause(
      { repos: w.repos, clock, ...n } as never,
      { actorHumanId: VENUE_EDITOR, target: eventTarget, clause: tenPercent, expectedVersion: 1, frozenChange: true },
    );
    expect(out).toMatchObject({ version: 2, changed: true });
    expect(w.s.dealChanges).toHaveLength(1);
    const c = w.s.dealChanges[0]! as { before: { resale: { resaleShare: unknown } }; after: { resale: { resaleShare: unknown } } };
    expect(c.before.resale.resaleShare).toBeNull();
    expect(c.after.resale.resaleShare).toEqual({ type: "PERCENT", bps: 1000, cents: null, payer: "SELLER" });
    expect(n.notify.mock.calls.map(([x]) => x.humanId).sort()).toEqual([VENUE_ADMIN, VENUE_FINANCE].sort());
  });

  it("EVENT: the same clause again with frozenChange → no DealChange, no notice", async () => {
    const w = frozenWorld();
    await setResaleClause({ repos: w.repos, clock } as never, { actorHumanId: VENUE_EDITOR, target: eventTarget, clause: tenPercent, expectedVersion: 1, frozenChange: true });
    const n = notice();
    await setResaleClause({ repos: w.repos, clock, ...n } as never, { actorHumanId: VENUE_EDITOR, target: eventTarget, clause: tenPercent, expectedVersion: 2, frozenChange: true });
    expect(w.s.dealChanges).toHaveLength(1);
    expect(n.notify).not.toHaveBeenCalled();
  });

  it("BOOKING_AGREEMENT on a frozen draft event → DEAL_FROZEN; with frozenChange → logged via the booking", async () => {
    const w = frozenWorld();
    const a = w.s.agreements.get(AGREEMENT_ID)!;
    w.s.agreements.set(AGREEMENT_ID, { ...a, draftEventId: EVENT_ID });
    expect(await caught(w.set(VENUE_EDITOR, bookingTarget, tenPercent, 1))).toMatchObject({ code: "DEAL_FROZEN" });
    await setResaleClause(
      { repos: w.repos, clock } as never,
      { actorHumanId: VENUE_EDITOR, target: bookingTarget, clause: tenPercent, expectedVersion: 1, frozenChange: true },
    );
    expect(w.s.dealChanges).toHaveLength(1);
    expect(w.s.audit.find((x) => x.action === "event.deal_frozen_change")?.data).toMatchObject({
      via: "BOOKING_AGREEMENT",
      agreementId: AGREEMENT_ID,
    });
  });

  it("ORG_DEFAULT is never fenced", async () => {
    const w = frozenWorld();
    await expect(w.set(VENUE_ADMIN, orgTarget, tenPercent, null)).resolves.toMatchObject({ changed: true });
  });
});
