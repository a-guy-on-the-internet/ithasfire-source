import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import type { UpdateEventSplitsDeps } from "../update-event-splits";
import { updateEventSplits } from "../update-event-splits";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const RESALE_TERMS_ID = "55555555-5555-4555-8555-555555555555";
const PAYEE_SUBJECT_ID = "66666666-6666-4666-8666-666666666666";
const PAYEE_ID = "77777777-7777-4777-8777-777777777777";
const NEW_DRAFT_ID = "88888888-8888-4888-8888-888888888888";
const ENTITY_DEFAULT_TERMS_ID = "99999999-9999-4999-8999-999999999990";
const NOW = new Date("2026-06-10T12:00:00.000Z");

const makeEvent = (overrides: Partial<EventRecord> = {}): EventRecord =>
  ({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Split Show",
    status: "DRAFT",
    payoutTermsId: TERMS_ID,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    ...overrides,
  }) as unknown as EventRecord;

const makeBookingAgreement = (
  overrides: Partial<AgreementRecord> = {},
): AgreementRecord =>
  ({
    id: "ab0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
    type: "PERFORMANCE",
    status: "ACCEPTED",
    proposerType: "human",
    proposerId: "99999999-9999-4999-8999-999999999999",
    counterpartyType: "organization",
    counterpartyId: ORG_ID,
    placeId: null,
    eventId: EVENT_ID,
    draftEventId: null,
    payoutTermsId: TERMS_ID,
    title: "Booking — Split Show",
    description: null,
    proposedDate: null,
    proposedEndDate: null,
    guaranteeCents: null,
    proposedAt: null,
    acceptedAt: NOW,
    declinedAt: null,
    declinedReason: null,
    expiresAt: null,
    fulfilledAt: null,
    sentForReviewByHumanId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as AgreementRecord;

const buildInput = (overrides: Record<string, unknown> = {}) => ({
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  kind: "PRIMARY",
  clientKey: "splits-idem-12345678",
  lines: [
    {
      payeeRef: { kind: "org", id: PAYEE_SUBJECT_ID },
      ticketTypeId: null,
      percentBps: 5000,
      floorCents: 0,
      priority: 1,
    },
  ],
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type BuildDepsOptions = {
  /** Pre-tx events.getById result. Defaults to `txEvent`. */
  preTxEvent?: EventRecord | null;
  /** In-tx events.getById result (authoritative). */
  txEvent?: EventRecord | null;
  /** Booking Agreement matched by payoutTermsId, if any. */
  bookingAgreement?: AgreementRecord | null;
  /**
   * Payout schedule on the org's entity default PRIMARY terms. `null`
   * (default) = the org has no entity default configured.
   */
  entityDefaultSchedule?: string | null;
  /** The resale clause stored on RESALE_TERMS_ID. Default: not set. */
  resaleClause?: { resaleShareType: "PERCENT" | "FLAT"; resaleShareBps?: number; resaleShareCents?: number };
  /** The event's ticket types' `resaleAllowed`. Default: none. */
  ticketTypesResaleAllowed?: boolean[];
};

function buildDeps(options: BuildDepsOptions = {}) {
  const txEvent =
    options.txEvent !== undefined ? options.txEvent : makeEvent();
  const preTxEvent =
    options.preTxEvent !== undefined ? options.preTxEvent : txEvent;
  const bookingAgreement = options.bookingAgreement ?? null;
  const entityDefaultSchedule = options.entityDefaultSchedule ?? null;

  const getByPayoutTermsId = vi.fn(async (payoutTermsId: string) =>
    bookingAgreement && bookingAgreement.payoutTermsId === payoutTermsId
      ? { ...bookingAgreement }
      : null,
  );
  const createDraft = vi.fn(async (input: { kind: string }) => ({
    id: NEW_DRAFT_ID,
    kind: input.kind,
    status: "PENDING",
  }));
  const linkPayoutTerms = vi.fn(async () => {});
  const replaceLines = vi.fn(async () => {});
  const listLines = vi.fn(async () => []);
  const txEventsGetById = vi.fn(async (id: string) =>
    txEvent && txEvent.id === id ? { ...txEvent } : null,
  );

  // Entity default lookup used by the fresh-draft schedule inheritance path.
  const payoutTermsGetById = vi.fn(async (id: string) => {
    if (id === RESALE_TERMS_ID) {
      return {
        id,
        kind: "RESALE",
        status: "PENDING",
        resaleShareType: null,
        resaleShareBps: null,
        resaleShareCents: null,
        resaleSharePayer: "SELLER",
        ...options.resaleClause,
      };
    }
    return entityDefaultSchedule && id === ENTITY_DEFAULT_TERMS_ID
      ? {
          id,
          kind: "PRIMARY",
          status: "ACTIVE",
          payoutSchedule: entityDefaultSchedule,
        }
      : null;
  });
  const orgGetById = vi.fn(async (id: string) => ({
    id,
    defaultPrimaryPayoutTermsId: entityDefaultSchedule
      ? ENTITY_DEFAULT_TERMS_ID
      : null,
  }));
  const humanGetById = vi.fn(async (id: string) => ({
    id,
    defaultPrimaryPayoutTermsId: entityDefaultSchedule
      ? ENTITY_DEFAULT_TERMS_ID
      : null,
  }));

  const tx = {
    events: {
      getById: txEventsGetById,
      linkPayoutTerms,
      // freeze-the-deal: the event row is locked before any terms row.
      lockRows: vi.fn(async () => undefined),
      listTicketTypes: vi.fn(async () =>
        (options.ticketTypesResaleAllowed ?? []).map((resaleAllowed, i) => ({
          id: `tt-${i}`,
          resaleAllowed,
        })),
      ),
    },
    payoutTerms: {
      createDraft,
      listLines,
      replaceLines,
      getById: payoutTermsGetById,
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: PAYEE_ID })),
      upsertForSubject: vi.fn(async () => ({ id: PAYEE_ID })),
    },
    organizations: {
      getById: orgGetById,
    },
    humans: {
      getById: humanGetById,
    },
    agreements: {
      getByPayoutTermsId,
    },
    // ── P4b (deal terms) ── the terms row lock every line writer takes.
    deals: {
      lockTerms: vi.fn(async () => true),
    },
  } as any;

  const auditLog = vi.fn(async () => {});
  const repos = {
    tx: vi.fn((fn: (txRepos: typeof tx) => Promise<unknown>) => fn(tx)),
    events: {
      getById: vi.fn(async (id: string) =>
        preTxEvent && preTxEvent.id === id ? { ...preTxEvent } : null,
      ),
    },
    audit: { log: auditLog },
  } as unknown as UpdateEventSplitsDeps["repos"];

  const idempotency = createFakeIdempotencyPort();
  const deps: UpdateEventSplitsDeps = {
    repos,
    authz: {
      canEditEvent: vi.fn(async () => ({ allowed: true })),
    } as unknown as UpdateEventSplitsDeps["authz"],
    idempotency,
    clock: { now: () => NOW },
  };

  return {
    deps,
    mocks: {
      getByPayoutTermsId,
      createDraft,
      linkPayoutTerms,
      replaceLines,
      listLines,
      txEventsGetById,
      auditLog,
      idempotency,
      // freeze-the-deal tests reach the transaction's repos.
      tx,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("updateEventSplits", () => {
  // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). `canEditEvent`
  // admits a human owner's edit-role delegates; splits must not.
  describe("payout routing on a human-owned event", () => {
    const PRINCIPAL_ID = "aaaaaaaa-0000-4000-8000-000000000001";
    const humanEvent = makeEvent({ orgId: null, humanId: PRINCIPAL_ID });

    it("refuses a delegate that canEditEvent admits, and writes nothing", async () => {
      const { deps, mocks } = buildDeps({ txEvent: humanEvent });

      await expect(
        updateEventSplits(deps, buildInput()),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(deps.authz.canEditEvent).toHaveBeenCalled();
      expect(mocks.replaceLines).not.toHaveBeenCalled();
      expect(mocks.createDraft).not.toHaveBeenCalled();
    });

    it("still admits the owner", async () => {
      const { deps } = buildDeps({ txEvent: humanEvent });

      await expect(
        updateEventSplits(deps, buildInput({ actorHumanId: PRINCIPAL_ID })),
      ).resolves.toBeDefined();
    });
  });

  it("replaces lines on non-booking PRIMARY terms (happy path)", async () => {
    const { deps, mocks } = buildDeps();

    const result = await updateEventSplits(deps, buildInput());

    expect(result).toEqual({
      payoutTermsId: TERMS_ID,
      lineCount: 1,
      totalAllocatedBps: 5000,
    });
    expect(mocks.getByPayoutTermsId).toHaveBeenCalledWith(TERMS_ID);
    expect(mocks.replaceLines).toHaveBeenCalledTimes(1);
    expect(mocks.replaceLines).toHaveBeenCalledWith(
      TERMS_ID,
      expect.arrayContaining([
        expect.objectContaining({ payeeId: PAYEE_ID, percent: 50 }),
      ]),
    );
    // Terms already linked — no fresh draft, no re-link.
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.linkPayoutTerms).not.toHaveBeenCalled();
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event_splits_updated" }),
    );
  });

  it.each([[1250], [3333], [1], [9999]])(
    "refuses a fractional %i bps rather than silently rounding it into the store",
    async (percentBps) => {
      // `PayoutTermsLine.percent` is an Int of WHOLE percent, and the write
      // does `Math.round(percentBps / 100)`. Without the schema constraint,
      // 1250 persists as 13 — the payee is paid 13%, not 12.5%, and the audit
      // log records the POST-rounding value, so nothing downstream can reveal
      // the discrepancy. On a $10k net that is $50 an event moved off the
      // owner's remainder. Refuse at the wire; never let a client reach the
      // rounder.
      const { deps, mocks } = buildDeps();

      await expect(
        updateEventSplits(
          deps,
          buildInput({
            lines: [
              {
                payeeRef: { kind: "org", id: PAYEE_SUBJECT_ID },
                ticketTypeId: null,
                percentBps,
                floorCents: 0,
                priority: 1,
              },
            ],
          }),
        ),
        // Asserted precisely so this can never pass for an unrelated reason
        // (an RBAC or fence rejection would look identical to `toThrow()`).
      ).rejects.toMatchObject({
        code: "invalid_input",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.arrayContaining(["percentBps"]),
          }),
        ]),
      });

      expect(mocks.replaceLines).not.toHaveBeenCalled();
    },
  );

  it("still accepts every whole percent, including the 0 and 10000 edges", async () => {
    for (const [percentBps, percent] of [
      [0, 0],
      [100, 1],
      [5000, 50],
      [10000, 100],
    ] as const) {
      const { deps, mocks } = buildDeps();
      await updateEventSplits(
        deps,
        buildInput({
          lines: [
            {
              payeeRef: { kind: "org", id: PAYEE_SUBJECT_ID },
              ticketTypeId: null,
              percentBps,
              floorCents: 0,
              priority: 1,
            },
          ],
        }),
      );
      expect(mocks.replaceLines).toHaveBeenCalledWith(
        TERMS_ID,
        expect.arrayContaining([expect.objectContaining({ percent })]),
      );
    }
  });

  // ── Cap satisfiability ────────────────────────────────────────────────────
  // This use case has NO event-status guard: it will rewrite the lines of
  // terms already ACTIVE on a selling event. So the same predicate
  // `publishEvent`'s Gate 1b runs has to run at the write, or a cap lowered
  // mid-sale silently under-pays every subsequent order.
  const cappedLine = (
    percentBps: number,
    capPercent: number | null,
    priority = 1,
  ) => ({
    payeeRef: { kind: "org", id: PAYEE_SUBJECT_ID },
    ticketTypeId: null,
    percentBps,
    floorCents: 0,
    ...(capPercent === null ? {} : { capPercent }),
    priority,
  });

  it("refuses to store a complete all-capped set whose caps fall short", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      updateEventSplits(
        deps,
        buildInput({ lines: [cappedLine(6000, 10), cappedLine(4000, 40, 2)] }),
      ),
    ).rejects.toMatchObject({
      code: "SPLITS_CAPS_UNSATISFIABLE",
      meta: { totalCapPct: 50, totalAllocatedPct: 100, targetPct: 100 },
    });

    expect(mocks.replaceLines).not.toHaveBeenCalled();
  });

  it("stores a capped line beside an uncapped one", async () => {
    // The canonical "venue takes 20%, capped at 5%" deal. One uncapped line
    // absorbs every withheld cent, so the basis is fully distributed.
    const { deps, mocks } = buildDeps();

    await updateEventSplits(
      deps,
      buildInput({ lines: [cappedLine(2000, 5), cappedLine(8000, null, 2)] }),
    );

    expect(mocks.replaceLines).toHaveBeenCalledWith(
      TERMS_ID,
      expect.arrayContaining([
        expect.objectContaining({ percent: 20, capPercent: 5 }),
        expect.objectContaining({ percent: 80, capPercent: null }),
      ]),
    );
  });

  it("still stores a half-composed capped draft — the editor must stay usable", async () => {
    // 20% capped at 5% and nothing else: all-capped and nowhere near 100%,
    // but it is a DRAFT. Publish refuses an incomplete set; this must not.
    const { deps, mocks } = buildDeps();

    await updateEventSplits(deps, buildInput({ lines: [cappedLine(2000, 5)] }));

    expect(mocks.replaceLines).toHaveBeenCalledWith(
      TERMS_ID,
      expect.arrayContaining([
        expect.objectContaining({ percent: 20, capPercent: 5 }),
      ]),
    );
  });

  // `capPercent` is persisted verbatim as WHOLE PERCENT. The schema used to
  // accept up to 10000 (bps-shaped), so "50%" sent as 5000 stored a ceiling of
  // 5000% — 50x the basis, a cap that can never bind.
  it("refuses a bps-shaped capPercent instead of storing a cap that never binds", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      updateEventSplits(deps, buildInput({ lines: [cappedLine(10000, 5000)] })),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(mocks.replaceLines).not.toHaveBeenCalled();
  });

  it("fences off booking-owned terms with agreement_finalized", async () => {
    const { deps, mocks } = buildDeps({
      bookingAgreement: makeBookingAgreement(),
    });

    await expect(updateEventSplits(deps, buildInput())).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });

    expect(mocks.getByPayoutTermsId).toHaveBeenCalledWith(TERMS_ID);
    expect(mocks.replaceLines).not.toHaveBeenCalled();
    expect(mocks.linkPayoutTerms).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.idempotency.__mocks.fail).toHaveBeenCalledTimes(1);
  });

  it("re-reads the event in-tx: a concurrently finalized booking linkage trips the fence instead of being clobbered", async () => {
    // Pre-tx snapshot has no PRIMARY terms (would mint a draft + link);
    // by the time the tx runs, finalizeBookingAgreement has stamped
    // booking-owned terms onto the event. The in-tx re-read must win.
    const { deps, mocks } = buildDeps({
      preTxEvent: makeEvent({ payoutTermsId: null }),
      txEvent: makeEvent({ payoutTermsId: TERMS_ID }),
      bookingAgreement: makeBookingAgreement(),
    });

    await expect(updateEventSplits(deps, buildInput())).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });

    expect(mocks.txEventsGetById).toHaveBeenCalledWith(EVENT_ID);
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.linkPayoutTerms).not.toHaveBeenCalled();
    expect(mocks.replaceLines).not.toHaveBeenCalled();
  });

  it("still mints and links a fresh draft when the event truly has no terms", async () => {
    const { deps, mocks } = buildDeps({
      txEvent: makeEvent({ payoutTermsId: null }),
    });

    const result = await updateEventSplits(deps, buildInput());

    expect(result.payoutTermsId).toBe(NEW_DRAFT_ID);
    // No entity default configured → no payoutSchedule key, so the schema
    // default applies.
    expect(mocks.createDraft).toHaveBeenCalledWith({
      kind: "PRIMARY",
      settlementCurrency: "usd",
    });
    expect(mocks.linkPayoutTerms).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      payoutTermsId: NEW_DRAFT_ID,
      kind: "PRIMARY",
    });
    expect(mocks.replaceLines).toHaveBeenCalledWith(
      NEW_DRAFT_ID,
      expect.any(Array),
    );
  });

  it("seeds a fresh PRIMARY draft with the owner entity's default payout schedule when one exists", async () => {
    const { deps, mocks } = buildDeps({
      txEvent: makeEvent({ payoutTermsId: null }),
      entityDefaultSchedule: "ASAP",
    });

    const result = await updateEventSplits(deps, buildInput());

    expect(result.payoutTermsId).toBe(NEW_DRAFT_ID);
    expect(mocks.createDraft).toHaveBeenCalledWith({
      kind: "PRIMARY",
      settlementCurrency: "usd",
      payoutSchedule: "ASAP",
    });
  });

  it("does NOT seed a schedule on fresh RESALE drafts (resale has its own default pointer)", async () => {
    const { deps, mocks } = buildDeps({
      txEvent: makeEvent({
        payoutTermsId: TERMS_ID,
        resalePayoutTermsId: null,
      }),
      entityDefaultSchedule: "ASAP",
    });

    await updateEventSplits(deps, buildInput({ kind: "RESALE" }));

    expect(mocks.createDraft).toHaveBeenCalledWith({
      kind: "RESALE",
      settlementCurrency: "usd",
    });
  });

  it("leaves the RESALE path unaffected: booking agreements reference PRIMARY terms only", async () => {
    // Booking agreement owns the PRIMARY terms; the resale terms id is
    // distinct, so the fence lookup misses and the write proceeds.
    const { deps, mocks } = buildDeps({
      txEvent: makeEvent({
        payoutTermsId: TERMS_ID,
        resalePayoutTermsId: RESALE_TERMS_ID,
      }),
      bookingAgreement: makeBookingAgreement(),
    });

    const result = await updateEventSplits(
      deps,
      buildInput({ kind: "RESALE" }),
    );

    expect(result.payoutTermsId).toBe(RESALE_TERMS_ID);
    expect(mocks.getByPayoutTermsId).toHaveBeenCalledWith(RESALE_TERMS_ID);
    expect(mocks.replaceLines).toHaveBeenCalledWith(
      RESALE_TERMS_ID,
      expect.any(Array),
    );
  });

  describe("the last RESALE line while the resale share is in use (review W4)", () => {
    const resaleEvent = makeEvent({ resalePayoutTermsId: RESALE_TERMS_ID });
    const tenPercent = { resaleShareType: "PERCENT" as const, resaleShareBps: 1000 };

    it("removing every RESALE line while a clause is set and a type allows resale → AGREEMENT_MISSING_LINES", async () => {
      const { deps, mocks } = buildDeps({
        txEvent: resaleEvent,
        resaleClause: tenPercent,
        ticketTypesResaleAllowed: [false, true],
      });
      await expect(
        updateEventSplits(deps, buildInput({ kind: "RESALE", lines: [] })),
      ).rejects.toMatchObject({
        code: "AGREEMENT_MISSING_LINES",
        meta: { reason: "resale_share_needs_lines", payoutTermsId: RESALE_TERMS_ID },
      });
      expect(mocks.replaceLines).not.toHaveBeenCalled();
    });

    it.each([
      ["no clause is set", undefined, [true]],
      ["no type allows resale", tenPercent, [false]],
    ] as const)("removing every RESALE line is allowed when %s", async (_label, resaleClause, types) => {
      const { deps, mocks } = buildDeps({
        txEvent: resaleEvent,
        resaleClause,
        ticketTypesResaleAllowed: [...types],
      });
      await updateEventSplits(deps, buildInput({ kind: "RESALE", lines: [] }));
      expect(mocks.replaceLines).toHaveBeenCalledWith(RESALE_TERMS_ID, []);
    });
  });
  // ── RESALE total ──────────────────────────────────────────────────────────
  // Finalize splits the resale share over the RESALE lines alone; over 100%
  // the remainder pass takes the excess back a cent at a time, last line
  // first (A=80 + B=60 paid A 60%, after A had confirmed 80%). So the write
  // refuses it.
  describe("the RESALE total", () => {
    const resaleEvent = makeEvent({ resalePayoutTermsId: RESALE_TERMS_ID });
    const line = (percentBps: number) => ({
      payeeRef: { kind: "org", id: PAYEE_SUBJECT_ID },
      ticketTypeId: null,
      percentBps,
      floorCents: 0,
      priority: 0,
    });

    it("refuses RESALE lines adding up to more than 100%", async () => {
      const { deps, mocks } = buildDeps({ txEvent: resaleEvent });

      await expect(
        updateEventSplits(
          deps,
          buildInput({ kind: "RESALE", lines: [line(8000), line(6000)] }),
        ),
      ).rejects.toMatchObject({
        code: "RESALE_SPLITS_OVER_TOTAL",
        meta: { payoutTermsId: RESALE_TERMS_ID, totalAllocatedPct: 140, targetPct: 100 },
      });
      expect(mocks.replaceLines).not.toHaveBeenCalled();
    });

    it("counts a DECLINED line too: finalize pays every RESALE line", async () => {
      // The stored line was declined and is resent unchanged, so it stays
      // DECLINED. Counting only active lines (as the caps check does) would
      // see 60% and pass; finalize would split over 140%.
      const { deps, mocks } = buildDeps({ txEvent: resaleEvent });
      const DECLINED_LINE_ID = "abababab-abab-4bab-8bab-abababababab";
      mocks.listLines.mockResolvedValueOnce([
        {
          id: DECLINED_LINE_ID,
          payoutTermsId: RESALE_TERMS_ID,
          payeeId: PAYEE_ID,
          ticketTypeId: null,
          percent: 80,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
          requiresConfirmation: true,
          confirmationStatus: "DECLINED",
          confirmedAt: null,
          counterPercentBps: null,
          counterNote: null,
        },
      ] as never);

      await expect(
        updateEventSplits(
          deps,
          buildInput({
            kind: "RESALE",
            lines: [{ ...line(8000), id: DECLINED_LINE_ID }, line(6000)],
          }),
        ),
      ).rejects.toMatchObject({
        code: "RESALE_SPLITS_OVER_TOTAL",
        meta: { totalAllocatedPct: 140 },
      });
      expect(mocks.replaceLines).not.toHaveBeenCalled();
    });

    it("stores RESALE lines adding up to exactly 100%, or less", async () => {
      for (const lines of [[line(8000), line(2000)], [line(4000)]]) {
        const { deps, mocks } = buildDeps({ txEvent: resaleEvent });
        await updateEventSplits(deps, buildInput({ kind: "RESALE", lines }));
        expect(mocks.replaceLines).toHaveBeenCalledWith(
          RESALE_TERMS_ID,
          expect.any(Array),
        );
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// freeze-the-deal FR-004: the splits editor is a deal write
// ─────────────────────────────────────────────────────────────────────────────

describe("updateEventSplits — a frozen deal", () => {
  const FROZEN_AT = new Date("2026-06-01T12:00:00.000Z");
  const frozenEvent = makeEvent({ dealFrozenAt: FROZEN_AT } as Partial<EventRecord>);
  const dealWith = (percent: number) => ({
    payoutTermsId: TERMS_ID,
    remainderPayeeId: null,
    clauses: [
      {
        id: "c1000000-0000-4000-8000-000000000001",
        payeeId: PAYEE_ID,
        amountType: "PERCENT",
        amountCents: null,
        percent,
        basis: "GROSS",
        resolution: null,
        displayLabel: null,
        ticketTypeId: null,
        floorCents: 0,
        capPercent: null,
        priority: 1,
        rounding: "FLOOR",
      },
    ],
    deductions: [],
  });

  it("without frozenChange → DEAL_FROZEN, after the terms lock, and no line is written", async () => {
    const { deps, mocks } = buildDeps({ txEvent: frozenEvent });
    await expect(updateEventSplits(deps, buildInput())).rejects.toMatchObject({ code: "DEAL_FROZEN" });
    expect(mocks.tx.deals.lockTerms).toHaveBeenCalledWith(TERMS_ID);
    expect(mocks.replaceLines).not.toHaveBeenCalled();
  });

  it("with frozenChange → saved, one DealChange appended and audited, payees told after the commit", async () => {
    const { deps, mocks } = buildDeps({ txEvent: frozenEvent });
    const createDealChange = vi.fn(async (input: { eventId: string }) => ({
      id: "dc000000-0000-4000-8000-000000000001",
      eventId: input.eventId,
      actorHumanId: ACTOR_ID,
      createdAt: NOW,
      before: {},
      after: {},
    }));
    const txAudit = vi.fn(async () => {});
    Object.assign(mocks.tx.deals, {
      getTermsDeal: vi.fn().mockResolvedValueOnce(dealWith(40)).mockResolvedValueOnce(dealWith(50)),
      createDealChange,
    });
    mocks.tx.audit = { log: txAudit };
    const notify = vi.fn(async () => undefined);
    const repos = deps.repos as unknown as Record<string, unknown>;
    repos.payees = {
      getByIds: vi.fn(async () => [{ id: PAYEE_ID, subjectType: "HUMAN", subjectId: PAYEE_SUBJECT_ID }]),
    };
    repos.humans = { getByIds: vi.fn(async () => []) };
    repos.organizations = { getByIds: vi.fn(async () => []), listMembers: vi.fn() };

    await expect(
      updateEventSplits({ ...deps, notify } as never, buildInput({ frozenChange: true })),
    ).resolves.toMatchObject({ payoutTermsId: TERMS_ID });
    expect(mocks.replaceLines).toHaveBeenCalled();
    expect(createDealChange).toHaveBeenCalledTimes(1);
    expect(txAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event.deal_frozen_change", entityId: EVENT_ID }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: PAYEE_SUBJECT_ID,
        variant: "deal.frozen-change",
        idempotencyKey: "deal-change:dc000000-0000-4000-8000-000000000001:" + PAYEE_SUBJECT_ID,
      }),
    );
  });

  it("locks the event row (update) BEFORE the terms row", async () => {
    const { deps, mocks } = buildDeps({ txEvent: frozenEvent });
    await expect(updateEventSplits(deps, buildInput())).rejects.toMatchObject({ code: "DEAL_FROZEN" });
    expect(mocks.tx.events.lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
    const eventLock = mocks.tx.events.lockRows.mock.invocationCallOrder[0]!;
    const termsLock = mocks.tx.deals.lockTerms.mock.invocationCallOrder[0]!;
    expect(eventLock).toBeLessThan(termsLock);
  });

  it("a frozen change that MINTS the RESALE terms records them as absent before (null), not as an empty row", async () => {
    const { deps, mocks } = buildDeps({ txEvent: frozenEvent });
    const state = { ...frozenEvent, resalePayoutTermsId: null as string | null };
    mocks.tx.events.getById = vi.fn(async (id: string) => (id === EVENT_ID ? { ...state } : null));
    mocks.tx.events.linkPayoutTerms = vi.fn(
      async ({ payoutTermsId, kind }: { payoutTermsId: string; kind: string }) => {
        if (kind === "RESALE") state.resalePayoutTermsId = payoutTermsId;
      },
    );
    const createDealChange = vi.fn(
      async (input: { eventId: string; before: unknown; after: unknown }) => ({
        id: "dc000000-0000-4000-8000-000000000002",
        eventId: input.eventId,
        actorHumanId: ACTOR_ID,
        createdAt: NOW,
        before: input.before,
        after: input.after,
      }),
    );
    Object.assign(mocks.tx.deals, {
      getTermsDeal: vi.fn(async (id: string) =>
        id === TERMS_ID
          ? dealWith(40)
          : id === NEW_DRAFT_ID
            ? { ...dealWith(50), payoutTermsId: NEW_DRAFT_ID }
            : null,
      ),
      createDealChange,
    });
    mocks.tx.audit = { log: vi.fn(async () => {}) };

    await updateEventSplits(deps, buildInput({ kind: "RESALE", frozenChange: true }));

    expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({ kind: "RESALE" }));
    expect(createDealChange).toHaveBeenCalledTimes(1);
    const [row] = createDealChange.mock.calls[0]! as unknown as [
      { before: { resale: unknown }; after: { resale: { payoutTermsId: string } | null } },
    ];
    expect(row.before.resale).toBeNull();
    expect(row.after.resale?.payoutTermsId).toBe(NEW_DRAFT_ID);
  });

  it("with frozenChange and nothing different → no DealChange, no notice", async () => {
    const { deps, mocks } = buildDeps({ txEvent: frozenEvent });
    const createDealChange = vi.fn();
    Object.assign(mocks.tx.deals, {
      getTermsDeal: vi.fn(async () => dealWith(50)),
      createDealChange,
    });
    const notify = vi.fn();
    await updateEventSplits({ ...deps, notify } as never, buildInput({ frozenChange: true }));
    expect(createDealChange).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
