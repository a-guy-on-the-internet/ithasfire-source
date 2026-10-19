import { describe, expect, it } from "vitest";

import { getResaleClause } from "../get-resale-clause";
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
  clock,
  makeRepos,
  standardStore,
} from "./deal-fakes";

/**
 * getResaleClause (organiser-resale-share C2): the resale clause on its own,
 * for the RC1 block and the Default agreement page. Pins that it reads where
 * `getTermsDeal` cannot (no PRIMARY deal yet, a group with no ticket-sales
 * default), who sees what, the not-editable reasons in the writer's order,
 * and the named recipients the worked example splits the share over.
 */

const EVENT_ID = "c0000000-0000-4000-8000-0000000000ee";
const RESALE_TERMS = "c0000000-0000-4000-8000-0000000000a1";
const OTHER_EVENT = "c0000000-0000-4000-8000-0000000000ff";

type Line = {
  id: string;
  payeeId: string;
  percent: number;
  capPercent: number | null;
  priority: number;
  rounding: "FLOOR" | "NEAREST";
  ticketTypeId: string | null;
};

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
  lines: Line[];
};

const line = (id: string, payeeId: string, percent: number): Line => ({
  id,
  payeeId,
  percent,
  capPercent: null,
  priority: 0,
  rounding: "FLOOR",
  ticketTypeId: null,
});

/**
 * An event with NO primary terms (payoutTermsId null) and RESALE terms split
 * 60/40 between the act and the place; the org has no ticket-sales default.
 */
function world(opts: { eventStatus?: string; eventResale?: string | null } = {}) {
  const s = standardStore();
  s.events.set(EVENT_ID, {
    id: EVENT_ID,
    orgId: VENUE_ORG,
    humanId: null,
    startsAt: SHOW_STARTS,
    endsAt: SHOW_ENDS,
    payoutTermsId: null,
    currency: "usd",
    status: opts.eventStatus ?? "DRAFT",
    publishedAt: null,
  } as never);

  const resale = new Map<string, ResaleRow>([
    [
      RESALE_TERMS,
      {
        id: RESALE_TERMS,
        kind: "RESALE",
        status: "PENDING",
        isDefault: false,
        version: 3,
        resaleShareType: "PERCENT",
        resaleShareBps: 1000,
        resaleShareCents: null,
        resaleSharePayer: "SELLER",
        lines: [line("line-act", s.actPayee, 60), line("line-venue", s.venuePayee, 40)],
      },
    ],
  ]);
  const eventResale = new Map<string, string>();
  if (opts.eventResale !== null) eventResale.set(EVENT_ID, opts.eventResale ?? RESALE_TERMS);
  const orgResale = new Map<string, string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repos = makeRepos(s) as any;
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
  repos.deals.linkOrgDefaultResaleTermsIfUnset = async (input: { orgId: string; payoutTermsId: string }) => {
    if (orgResale.has(input.orgId)) return false;
    orgResale.set(input.orgId, input.payoutTermsId);
    return true;
  };
  const getTerms = repos.payoutTerms.getById;
  repos.payoutTerms.getById = async (id: string) => {
    const r = resale.get(id);
    return r ? { ...r } : getTerms(id);
  };
  repos.payoutTerms.createDraft = async (input: Partial<ResaleRow>) => {
    const id = "c0000000-0000-4000-8000-0000000000b1";
    const row: ResaleRow = {
      id,
      kind: "RESALE",
      status: "PENDING",
      isDefault: false,
      version: 1,
      resaleShareType: input.resaleShareType ?? null,
      resaleShareBps: input.resaleShareBps ?? null,
      resaleShareCents: input.resaleShareCents ?? null,
      resaleSharePayer: input.resaleSharePayer ?? "SELLER",
      lines: [],
    };
    resale.set(id, row);
    return { ...row };
  };
  const listLines = repos.payoutTerms.listLines;
  repos.payoutTerms.listLines = async (id: string) => {
    const r = resale.get(id);
    return r ? r.lines.map((l) => ({ ...l, payoutTermsId: id })) : listLines(id);
  };
  const listRefs = repos.deals.listTermsReferences;
  repos.deals.listTermsReferences = async (id: string) => [
    ...(await listRefs(id)),
    ...[...eventResale].filter(([, t]) => t === id).map(([e]) => ({ kind: "EVENT_RESALE", id: e })),
    ...[...orgResale].filter(([, t]) => t === id).map(([o]) => ({ kind: "ORG_DEFAULT_RESALE", id: o })),
  ];

  const read = (actorHumanId: string, target: unknown) =>
    getResaleClause({ repos }, { actorHumanId, target });
  return { s, repos, resale, eventResale, orgResale, read };
}

const eventTarget = { kind: "EVENT" as const, eventId: EVENT_ID };
const bookingTarget = { kind: "BOOKING_AGREEMENT" as const, agreementId: AGREEMENT_ID };
const orgTarget = { kind: "ORG_DEFAULT" as const, orgId: VENUE_ORG };

describe("getResaleClause — EVENT", () => {
  it("reads the clause on an event with no ticket-sales deal yet, with its version and named recipients", async () => {
    const w = world();
    const out = await w.read(VENUE_EDITOR, eventTarget);
    expect(out).toMatchObject({
      payoutTermsId: RESALE_TERMS,
      version: 3,
      clause: { type: "PERCENT", bps: 1000, cents: null, payer: "SELLER" },
      mayEdit: true,
      notEditableReason: null,
      agreementId: null,
      resaleOnTicketTypes: 0,
    });
    expect(out.recipients).toEqual([
      expect.objectContaining({ lineId: "line-act", kind: "human", percent: 60, name: expect.stringMatching(/^Human /) }),
      expect.objectContaining({ lineId: "line-venue", kind: "org", percent: 40, name: expect.stringMatching(/^Org /) }),
    ]);
  });

  it("counts the ticket types that allow resale (clearing is refused while any does)", async () => {
    const w = world();
    w.s.ticketTypes.set(EVENT_ID, [
      { id: "tt-on", resaleAllowed: true },
      { id: "tt-off", resaleAllowed: false },
    ] as never);
    expect((await w.read(VENUE_EDITOR, eventTarget)).resaleOnTicketTypes).toBe(1);
  });

  it("no RESALE terms: nothing to save yet (no_recipients_yet; the write refuses AGREEMENT_MISSING_LINES)", async () => {
    const w = world({ eventResale: null });
    expect(await w.read(VENUE_EDITOR, eventTarget)).toMatchObject({
      payoutTermsId: null,
      version: null,
      clause: null,
      mayEdit: false,
      notEditableReason: "no_recipients_yet",
      recipients: [],
    });
  });

  it("RESALE terms with no lines: no_recipients_yet until someone receives it", async () => {
    const w = world();
    w.resale.get(RESALE_TERMS)!.lines = [];
    expect(await w.read(VENUE_EDITOR, eventTarget)).toMatchObject({
      version: 3,
      mayEdit: false,
      notEditableReason: "no_recipients_yet",
      recipients: [],
    });
  });

  it("archived beats no recipients: the reason names what really blocks the write", async () => {
    const w = world({ eventStatus: "ARCHIVED", eventResale: null });
    expect(await w.read(VENUE_EDITOR, eventTarget)).toMatchObject({
      mayEdit: false,
      notEditableReason: "event_archived",
    });
  });

  it("finance sees it all but may not change it (not_payout_editor)", async () => {
    const w = world();
    expect(await w.read(VENUE_FINANCE, eventTarget)).toMatchObject({
      version: 3,
      mayEdit: false,
      notEditableReason: "not_payout_editor",
    });
  });

  it("a payee on the resale lines sees the clause only: no row id, version, recipients or counts", async () => {
    const w = world();
    expect(await w.read(ACT_HUMAN, eventTarget)).toEqual({
      target: eventTarget,
      payoutTermsId: null,
      version: null,
      clause: { type: "PERCENT", bps: 1000, cents: null, payer: "SELLER" },
      mayEdit: false,
      notEditableReason: "not_payout_editor",
      agreementId: null,
      recipients: null,
      resaleOnTicketTypes: null,
    });
  });

  it.each([
    ["an outsider", OUTSIDER],
    ["a viewer", VENUE_VIEWER],
  ])("%s → INSUFFICIENT_ROLE", async (_label, actor) => {
    const w = world();
    expect(await caught(w.read(actor, eventTarget))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it.each(["DRAFT", "PROPOSED", "ACCEPTED"])(
    "a %s booking not yet finalized holds it: resale_owned_by_booking, with the agreement id",
    async (status) => {
      const w = world();
      const a = w.s.agreements.get(AGREEMENT_ID)!;
      w.s.agreements.set(AGREEMENT_ID, { ...a, status: status as typeof a.status, draftEventId: EVENT_ID, eventId: null });
      expect(await w.read(VENUE_EDITOR, eventTarget)).toMatchObject({
        mayEdit: false,
        notEditableReason: "resale_owned_by_booking",
        agreementId: AGREEMENT_ID,
      });
    },
  );

  it("after the booking is finalized the event's editors may change it again", async () => {
    const w = world();
    const a = w.s.agreements.get(AGREEMENT_ID)!;
    w.s.agreements.set(AGREEMENT_ID, { ...a, status: "ACCEPTED", draftEventId: EVENT_ID, eventId: EVENT_ID });
    expect(await w.read(VENUE_EDITOR, eventTarget)).toMatchObject({ mayEdit: true, agreementId: null });
  });

  it("a cancelled event, shared terms and a default row are each a reason", async () => {
    expect(await world({ eventStatus: "CANCELLED" }).read(VENUE_EDITOR, eventTarget)).toMatchObject({
      notEditableReason: "event_cancelled",
    });
    const shared = world();
    shared.eventResale.set(OTHER_EVENT, RESALE_TERMS);
    expect(await shared.read(VENUE_EDITOR, eventTarget)).toMatchObject({ notEditableReason: "terms_shared" });
    const locked = world();
    locked.resale.get(RESALE_TERMS)!.isDefault = true;
    expect(await locked.read(VENUE_EDITOR, eventTarget)).toMatchObject({ notEditableReason: "terms_locked" });
  });
});

describe("getResaleClause — BOOKING_AGREEMENT", () => {
  const withDraftEvent = (w: ReturnType<typeof world>) => {
    const a = w.s.agreements.get(AGREEMENT_ID)!;
    w.s.agreements.set(AGREEMENT_ID, { ...a, draftEventId: EVENT_ID });
  };

  it("the terms-editor side reads the draft event's clause and may change it", async () => {
    const w = world();
    withDraftEvent(w);
    expect(await w.read(VENUE_EDITOR, bookingTarget)).toMatchObject({
      payoutTermsId: RESALE_TERMS,
      version: 3,
      mayEdit: true,
      agreementId: AGREEMENT_ID,
    });
  });

  it("the act sees the clause before agreeing, read-only (booking_not_editable)", async () => {
    const w = world();
    withDraftEvent(w);
    expect(await w.read(ACT_HUMAN, bookingTarget)).toMatchObject({
      clause: { type: "PERCENT", bps: 1000 },
      mayEdit: false,
      notEditableReason: "booking_not_editable",
    });
  });

  it("no event yet → agreement_has_no_event_yet", async () => {
    const w = world();
    expect(await w.read(VENUE_EDITOR, bookingTarget)).toMatchObject({
      clause: null,
      mayEdit: false,
      notEditableReason: "agreement_has_no_event_yet",
    });
  });
});

describe("getResaleClause — ORG_DEFAULT", () => {
  it("a group with no ticket-sales default still reads (not set), and an admin may set it", async () => {
    const w = world();
    expect(await w.read(VENUE_ADMIN, orgTarget)).toMatchObject({
      payoutTermsId: null,
      version: null,
      clause: null,
      mayEdit: true,
      recipients: [],
      resaleOnTicketTypes: null,
    });
  });

  it("round trip: the clause an admin sets reads back with its version", async () => {
    const w = world();
    await setResaleClause(
      { repos: w.repos, clock },
      {
        actorHumanId: VENUE_ADMIN,
        target: orgTarget,
        clause: { type: "FLAT", cents: 300, payer: "BUYER" },
        expectedVersion: null,
      },
    );
    expect(await w.read(VENUE_ADMIN, orgTarget)).toMatchObject({
      version: 1,
      clause: { type: "FLAT", cents: 300, bps: null, payer: "BUYER" },
      mayEdit: true,
    });
  });

  it("an editor reads it but may not change it; an outsider is refused", async () => {
    const w = world();
    expect(await w.read(VENUE_EDITOR, orgTarget)).toMatchObject({
      mayEdit: false,
      notEditableReason: "not_payout_editor",
    });
    expect(await caught(w.read(OUTSIDER, orgTarget))).toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
