import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import { finalizeBookingAgreement } from "../finalize-booking-agreement";
import type { FinalizeBookingAgreementDeps } from "../finalize-booking-agreement";
import {
  AGREEMENT_ID,
  EVENT_ID,
  OUTSIDER_ID,
  PERFORMER_ID,
  TERMS_ID,
  THIRD_PARTY_HUMAN_ID,
  THIRD_PARTY_PAYEE_ID,
  VENUE_ADMIN_ID,
  VENUE_ORG_ID,
  VENUE_PAYEE_ID,
  buildAgreementRecord,
  buildLineRecord,
  buildPayeeRecord,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeAuthzFake,
  makeClock,
  makeFakeIdempotency,
  withTx,
  type AgreementsRepoFakeOptions,
} from "./helpers";

const OTHER_AGREEMENT_ID = "12121212-1212-4121-8121-121212121212";

type BuildOptions = AgreementsRepoFakeOptions & {
  agreement?: AgreementRecord | null;
  lines?: PayoutTermsLineRecord[];
  /**
   * Per-call `listLines` results (first call = pre-tx precheck, second call =
   * in-tx authoritative gate). The last entry repeats once exhausted.
   * Simulates lines changing between the precheck and the transaction.
   */
  linesSequence?: PayoutTermsLineRecord[][];
  payees?: PayeeRecord[];
  event?: {
    id: string;
    orgId: string | null;
    humanId: string | null;
    status: string;
  } | null;
  /** Status of the agreement's PayoutTerms row. Booking clones start PENDING. */
  termsStatus?: "PENDING" | "ACTIVE" | "ARCHIVED";
};

const CONFIRMED_LINE = buildLineRecord({
  payeeId: THIRD_PARTY_PAYEE_ID,
  confirmationStatus: "CONFIRMED",
  confirmedAt: new Date("2026-06-08T00:00:00.000Z"),
});
const PARTY_LINE = buildLineRecord({
  id: "11111111-2222-4333-8444-555555555555",
  payeeId: VENUE_PAYEE_ID,
  percent: 30,
  requiresConfirmation: false,
  confirmationStatus: null,
});

function buildDeps(options: BuildOptions = {}) {
  const agreements = makeAgreementsRepoFake(
    options.agreement === undefined
      ? buildAgreementRecord({ status: "ACCEPTED" })
      : options.agreement,
    options,
  );
  const audit = makeAuditFake();
  const idempotency = makeFakeIdempotency();

  const lines = options.lines ?? [CONFIRMED_LINE, PARTY_LINE];
  const linesQueue = options.linesSequence ? [...options.linesSequence] : null;
  // Booking clones are minted PENDING (respond-to-booking-request's
  // statusOverride), so that's the default here.
  const termsStatusRef = {
    current: options.termsStatus ?? ("PENDING" as string),
  };
  const payoutTerms = {
    listLines: vi.fn(async () => {
      if (!linesQueue) return lines;
      return linesQueue.length > 1 ? linesQueue.shift()! : linesQueue[0]!;
    }),
    // Mirrors the adapter's guarded CAS: 0-match (status not in expectedFrom)
    // returns null instead of throwing.
    activate: vi.fn(
      async ({ expectedFrom }: { expectedFrom: readonly string[] }) => {
        if (!expectedFrom.includes(termsStatusRef.current)) return null;
        termsStatusRef.current = "ACTIVE";
        return { id: TERMS_ID, status: "ACTIVE" };
      },
    ),
    getById: vi.fn(async (id: string) =>
      id === TERMS_ID ? { id: TERMS_ID, status: termsStatusRef.current } : null,
    ),
  };

  const payeeRecords = options.payees ?? [
    buildPayeeRecord({ id: THIRD_PARTY_PAYEE_ID }),
    buildPayeeRecord({
      id: VENUE_PAYEE_ID,
      subjectType: "ORGANIZATION",
      subjectId: VENUE_ORG_ID,
    }),
  ];
  const payees = {
    getByIds: vi.fn(async (ids: string[]) =>
      payeeRecords.filter((payee) => ids.includes(payee.id)),
    ),
  };

  const eventRecord =
    options.event === undefined
      ? // The performer's own (human-owned) event.
        { id: EVENT_ID, orgId: null, humanId: PERFORMER_ID, status: "DRAFT" }
      : options.event;
  const events = {
    getById: vi.fn(async () => eventRecord),
    linkPayoutTerms: vi.fn(async () => undefined),
    // Finalize takes the event row FIRST in its transaction (freeze-the-deal).
    lockRows: vi.fn(async () => undefined),
  };

  const deps = {
    repos: withTx({
      agreements: agreements.repo,
      payoutTerms,
      payees,
      events,
      authz: makeAuthzFake(),
      audit,
    }) as unknown as FinalizeBookingAgreementDeps["repos"],
    idempotency,
    clock: makeClock(),
  } satisfies FinalizeBookingAgreementDeps;

  return {
    deps,
    agreements,
    events,
    audit,
    idempotency,
    payoutTerms,
    termsStatus: () => termsStatusRef.current,
  };
}

const baseInput = {
  actorHumanId: PERFORMER_ID,
  agreementId: AGREEMENT_ID,
  eventId: EVENT_ID,
};

const SECOND_EVENT_ID = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
const DRAFT_EVENT_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";

describe("finalizeBookingAgreement", () => {
  // ── Draft-anchor hygiene (createEventFromAgreement interplay) ─────────────

  it("divergent finalize (hand-picked event ≠ minted draft) retires the draft anchor in the same guarded write", async () => {
    const { deps, agreements } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        draftEventId: DRAFT_EVENT_ID,
      }),
    });

    const result = await finalizeBookingAgreement(deps, baseInput);

    expect(result.eventId).toBe(EVENT_ID);
    expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, clearDraftEventId: true }),
    );
    // Anchor retired: a later eventId SetNull can't resurrect the stale draft
    // through createEventFromAgreement's anchor short-circuit.
    expect(agreements.record()?.draftEventId).toBeNull();
    expect(agreements.record()?.eventId).toBe(EVENT_ID);
  });

  // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). Stamping terms on a
  // human's event is the owner's alone — an OWNER-role delegate of the
  // event's owner is refused, and the delegation is never consulted.
  it("refuses a delegate of the human event's owner (payout routing)", async () => {
    const PRINCIPAL_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
    const { deps } = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED" }),
      event: {
        id: EVENT_ID,
        orgId: null,
        humanId: PRINCIPAL_ID,
        status: "DRAFT",
      },
    });
    const authz = (deps.repos as unknown as { authz: Record<string, unknown> })
      .authz;
    authz.getHumanDelegation = vi.fn(async () => ({
      orgId: PRINCIPAL_ID,
      humanId: PERFORMER_ID,
      role: "OWNER",
    }));

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(authz.getHumanDelegation).not.toHaveBeenCalled();
  });

  it("same-event finalize (the create flow) KEEPS the draft anchor", async () => {
    const { deps, agreements } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        draftEventId: EVENT_ID,
      }),
    });

    await finalizeBookingAgreement(deps, baseInput);

    expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
      expect.not.objectContaining({ clearDraftEventId: true }),
    );
    expect(agreements.record()?.draftEventId).toBe(EVENT_ID);
    expect(agreements.record()?.eventId).toBe(EVENT_ID);
  });

  // ── Stale retained records (finalized event later deleted) ────────────────

  it("retained record whose event was DELETED is not honored: re-finalize to a NEW event proceeds under a generation-scoped key", async () => {
    const { deps, agreements, events } = buildDeps();

    const first = await finalizeBookingAgreement(deps, baseInput);
    expect(first.eventId).toBe(EVENT_ID);

    // Venue deletes the finalized event: row gone, Agreement.eventId
    // SetNulled by the FK (status stays ACCEPTED).
    events.getById.mockImplementation(async (id: string) =>
      id === SECOND_EVENT_ID
        ? { id: SECOND_EVENT_ID, orgId: null, humanId: PERFORMER_ID, status: "DRAFT" }
        : null,
    );
    agreements.set({ ...agreements.record()!, eventId: null });

    // Pre-fix this died on IDEMPOTENCY_KEY_CONFLICT (payload-hash mismatch
    // against the dead record) for the record's 24h retention.
    const second = await finalizeBookingAgreement(deps, {
      ...baseInput,
      eventId: SECOND_EVENT_ID,
    });

    expect(second.eventId).toBe(SECOND_EVENT_ID);
    expect(agreements.record()?.eventId).toBe(SECOND_EVENT_ID);
    expect(events.linkPayoutTerms).toHaveBeenCalledTimes(2);
    expect(events.linkPayoutTerms).toHaveBeenLastCalledWith({
      eventId: SECOND_EVENT_ID,
      payoutTermsId: TERMS_ID,
      kind: "PRIMARY",
    });
  });
  it("links the event, stamps the payout terms, and audits — in one tx", async () => {
    const { deps, agreements, events, audit } = buildDeps();

    const result = await finalizeBookingAgreement(deps, baseInput);

    expect(result).toEqual({
      agreementId: AGREEMENT_ID,
      eventId: EVENT_ID,
      payoutTermsId: TERMS_ID,
    });
    expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ACCEPTED",
        expectedFrom: ["ACCEPTED"],
        eventId: EVENT_ID,
      }),
    );
    expect(agreements.record()?.eventId).toBe(EVENT_ID);
    expect(events.linkPayoutTerms).toHaveBeenCalledTimes(1);
    expect(events.linkPayoutTerms).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      payoutTermsId: TERMS_ID,
      kind: "PRIMARY",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.finalized" }),
    );
  });

  it("replays idempotently: same output, linkPayoutTerms runs exactly once", async () => {
    const { deps, events } = buildDeps();

    const first = await finalizeBookingAgreement(deps, baseInput);
    const second = await finalizeBookingAgreement(deps, baseInput);

    expect(second).toEqual(first);
    expect(events.linkPayoutTerms).toHaveBeenCalledTimes(1);
  });

  it("rejects a replay aimed at a DIFFERENT event (payload hash conflict)", async () => {
    const { deps } = buildDeps();

    await finalizeBookingAgreement(deps, baseInput);

    await expect(
      finalizeBookingAgreement(deps, {
        ...baseInput,
        eventId: "12121212-1212-4121-8121-121212121213",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("short-circuits when the agreement already links THIS event (no re-link)", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        eventId: EVENT_ID,
      }),
    });

    const result = await finalizeBookingAgreement(deps, baseInput);

    expect(result.eventId).toBe(EVENT_ID);
    expect(events.linkPayoutTerms).not.toHaveBeenCalled();
  });

  it("blocks while a requiresConfirmation line is still PENDING", async () => {
    const { deps, events } = buildDeps({
      lines: [
        buildLineRecord({
          payeeId: THIRD_PARTY_PAYEE_ID,
          confirmationStatus: "PENDING",
        }),
        PARTY_LINE,
      ],
    });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({
      code: "lines_unconfirmed",
      meta: expect.objectContaining({
        pendingPayeeIds: [THIRD_PARTY_PAYEE_ID],
      }),
    });
    expect(events.linkPayoutTerms).not.toHaveBeenCalled();
  });

  it("re-evaluates the confirmation gate INSIDE the tx — a line un-confirmed after the precheck blocks the link", async () => {
    // Pre-tx precheck sees a fully-confirmed set; by the time the tx opens,
    // an edit has reset the third-party line to PENDING. The authoritative
    // in-tx gate must catch it and nothing may link.
    const { deps, events, agreements } = buildDeps({
      linesSequence: [
        [CONFIRMED_LINE, PARTY_LINE],
        [
          buildLineRecord({
            payeeId: THIRD_PARTY_PAYEE_ID,
            confirmationStatus: "PENDING",
          }),
          PARTY_LINE,
        ],
      ],
    });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({
      code: "lines_unconfirmed",
      meta: expect.objectContaining({
        pendingPayeeIds: [THIRD_PARTY_PAYEE_ID],
      }),
    });
    expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    expect(events.linkPayoutTerms).not.toHaveBeenCalled();
  });

  it("blocks when a line payee isn't Connect-ready", async () => {
    const { deps } = buildDeps({
      payees: [
        buildPayeeRecord({
          id: THIRD_PARTY_PAYEE_ID,
          status: "PENDING",
          payoutsEnabled: false,
          chargesEnabled: false,
        }),
        buildPayeeRecord({
          id: VENUE_PAYEE_ID,
          subjectType: "ORGANIZATION",
          subjectId: VENUE_ORG_ID,
        }),
      ],
    });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({
      code: "payee_not_ready",
      meta: expect.objectContaining({ payeeIds: [THIRD_PARTY_PAYEE_ID] }),
    });
  });

  it("blocks agreements that aren't ACCEPTED", async () => {
    const { deps } = buildDeps({ agreement: buildAgreementRecord() });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_ACCEPTED" });
  });

  it("blocks when the event already belongs to a different agreement", async () => {
    const { deps } = buildDeps({
      getByEventId: buildAgreementRecord({
        id: OTHER_AGREEMENT_ID,
        status: "ACCEPTED",
        eventId: EVENT_ID,
      }),
    });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "event_already_has_agreement" });
  });

  it("blocks when this agreement is linked to a DIFFERENT event", async () => {
    const { deps } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        eventId: "12121212-1212-4121-8121-121212121214",
      }),
    });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_LINKED_TO_OTHER_EVENT" });
  });

  it("requires edit access to the EVENT, not just the agreement", async () => {
    // Org-owned event; the performer is an agreement party but not an org
    // member → forbidden.
    const { deps } = buildDeps({
      event: {
        id: EVENT_ID,
        orgId: "13131313-1313-4131-8131-131313131313",
        humanId: null,
        status: "DRAFT",
      },
    });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects non-party actors before touching the event", async () => {
    const { deps, events } = buildDeps();

    await expect(
      finalizeBookingAgreement(deps, {
        ...baseInput,
        actorHumanId: OUTSIDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    expect(events.getById).not.toHaveBeenCalled();
  });

  it("surfaces the CAS conflict (race loser) and releases the idempotency claim after the 1s deterministic retention", async () => {
    const { deps, idempotency } = buildDeps({ updateConflict: true });

    vi.useFakeTimers();
    try {
      await expect(
        finalizeBookingAgreement(deps, baseInput),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "agreement_status_changed",
      });

      // Deterministic failure → near-zero failed-marker retention (1s, the
      // smallest every adapter accepts) instead of the adapters' default
      // 15 minutes: a user retry re-runs the gates rather than hitting
      // IDEMPOTENCY_LOCK_IN_PROGRESS.
      expect(
        await idempotency.begin(
          "bookingAgreement:finalize:" + AGREEMENT_ID,
          60,
        ),
      ).toBe(false);
      vi.advanceTimersByTime(1_100);
      expect(
        await idempotency.begin(
          "bookingAgreement:finalize:" + AGREEMENT_ID,
          60,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocked gate (lines_unconfirmed) → retry after payout confirmation is NOT locked out for 15 minutes", async () => {
    // The confirm-then-retry flow is a NORMAL user path (FinalizeDialog, and
    // createEventFromAgreement's converging finalize attempt). First call
    // blocks on the unconfirmed line; once the retention lapses (~1s) the
    // same agreement finalizes with the (now-confirmed) lines.
    const { deps, payoutTerms } = buildDeps({
      // First read (attempt 1's precheck) sees the PENDING line; every read
      // after that (attempt 2's precheck + in-tx gate) sees it CONFIRMED.
      linesSequence: [
        [
          buildLineRecord({
            payeeId: THIRD_PARTY_PAYEE_ID,
            confirmationStatus: "PENDING",
          }),
          PARTY_LINE,
        ],
        [CONFIRMED_LINE, PARTY_LINE],
      ],
    });

    vi.useFakeTimers();
    try {
      await expect(
        finalizeBookingAgreement(deps, baseInput),
      ).rejects.toMatchObject({ code: "lines_unconfirmed" });

      vi.advanceTimersByTime(1_100);

      const result = await finalizeBookingAgreement(deps, baseInput);
      expect(result.eventId).toBe(EVENT_ID);
      expect(payoutTerms.activate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── PayoutTerms activation (payout-terms activation gap) ─────────────────

  it("CAS-activates the booking-cloned PENDING terms and writes an audit row", async () => {
    const { deps, payoutTerms, audit, termsStatus } = buildDeps();

    await finalizeBookingAgreement(deps, baseInput);

    expect(payoutTerms.activate).toHaveBeenCalledTimes(1);
    expect(payoutTerms.activate).toHaveBeenCalledWith({
      payoutTermsId: TERMS_ID,
      expectedFrom: ["PENDING"],
    });
    expect(termsStatus()).toBe("ACTIVE");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "payoutTerms",
        entityId: TERMS_ID,
        action: "activated",
        data: {
          reason: "activated_on_booking_finalize",
          agreementId: AGREEMENT_ID,
          eventId: EVENT_ID,
        },
      }),
    );
  });

  it("no-ops activation for already-ACTIVE terms (CAS 0-match): finalize succeeds, no activation audit row", async () => {
    const { deps, payoutTerms, audit, termsStatus } = buildDeps({
      termsStatus: "ACTIVE",
    });

    const result = await finalizeBookingAgreement(deps, baseInput);

    expect(result.payoutTermsId).toBe(TERMS_ID);
    expect(payoutTerms.activate).toHaveBeenCalledWith({
      payoutTermsId: TERMS_ID,
      expectedFrom: ["PENDING"],
    });
    expect(termsStatus()).toBe("ACTIVE");
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "activated" }),
    );
    // The finalize itself still audits.
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.finalized" }),
    );
  });

  it("does not activate terms when the confirmation gate blocks the finalize", async () => {
    const { deps, payoutTerms, termsStatus } = buildDeps({
      lines: [
        buildLineRecord({
          payeeId: THIRD_PARTY_PAYEE_ID,
          confirmationStatus: "PENDING",
        }),
        PARTY_LINE,
      ],
    });

    await expect(
      finalizeBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "lines_unconfirmed" });

    expect(payoutTerms.activate).not.toHaveBeenCalled();
    expect(termsStatus()).toBe("PENDING");
  });

  it("fails the finalize when the CAS misses and the terms re-read as not-ACTIVE (e.g. ARCHIVED)", async () => {
    // CAS misses (status ARCHIVED, not in expectedFrom) and the re-read
    // confirms the row is unusable: the finalize must fail HERE instead of
    // linking dead terms and deferring the failure to publish.
    const { deps, payoutTerms, audit, idempotency, termsStatus } = buildDeps({
      termsStatus: "ARCHIVED",
    });

    vi.useFakeTimers();
    try {
      await expect(
        finalizeBookingAgreement(deps, baseInput),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "payout_terms_status_changed",
        meta: { payoutTermsId: TERMS_ID, status: "ARCHIVED" },
      });

      expect(payoutTerms.getById).toHaveBeenCalledWith(TERMS_ID);
      expect(termsStatus()).toBe("ARCHIVED");
      // The tx aborted: neither audit row landed.
      expect(audit.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "activated" }),
      );
      expect(audit.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking_agreement.finalized" }),
      );
      // Deterministic failure → the key frees after the 1s retention rather
      // than poisoning retries for the adapters' default 15 minutes.
      vi.advanceTimersByTime(1_100);
      expect(
        await idempotency.begin(
          "bookingAgreement:finalize:" + AGREEMENT_ID,
          60,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night P2c, review rounds 1–3: a booked night's terms are
// finalized against THAT night's event only (else Cancel booking, or anything
// else reading the booking's event, would act on another show); an event-first
// request's terms against its ORIGIN event only (W3); the refusals follow the
// FINALIZER's side (W4: the sender's are meta-free, booking-holds FR-013);
// and the authoritative check runs under the event row, the request's
// booking lock and the booked line, in that order (W5 residual d).
// ─────────────────────────────────────────────────────────────────────────────

describe("finalizeBookingAgreement — a booked night's terms link only that night's event", () => {
  const REQUEST_ID = "44444444-4444-4444-8444-111111111111";
  const CAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const OTHER_CAL = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
  const ORIGIN_EVENT_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const NIGHT = "2026-10-17";
  /** 20:00 CDT on NIGHT. */
  const ON_NIGHT = new Date("2026-10-18T01:00:00.000Z");
  /** 20:00 CDT a week later. */
  const NEXT_WEEK = new Date("2026-10-25T01:00:00.000Z");

  type Side = "venue" | "sender";
  type EventRow = { id: string; orgId: string | null; humanId: string | null; status: string; startsAt: Date; calendarId: string | null };

  /**
   * Request REQUEST_ID (TO_VENUE, the human performer as its sender pair) with
   * its night BOOKED on CAL (a CONFIRMED hold) unless `booked: false`. The
   * finalizer is the VENUE (VENUE_ADMIN_ID, on the venue org's own event) or
   * the SENDER (PERFORMER_ID, on their own event). The transaction runs on the
   * SAME repo bag the test mutates, so the authoritative in-tx check (event
   * row → booking lock → line) is exercised, not just the pre-flight read.
   */
  function bookedNight(
    event: { startsAt: Date; calendarId: string | null },
    options: { booked?: boolean; side?: Side; originEventId?: string | null } = {},
  ) {
    const side = options.side ?? "venue";
    const eventRow: EventRow =
      side === "venue"
        ? { id: EVENT_ID, orgId: VENUE_ORG_ID, humanId: null, status: "PUBLISHED", ...event }
        : { id: EVENT_ID, orgId: null, humanId: PERFORMER_ID, status: "PUBLISHED", ...event };
    const built = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED" }),
      event: eventRow as never,
    });
    const repos = built.deps.repos as unknown as Record<string, unknown> & {
      bookingHolds: {
        seed: (row: Record<string, unknown>) => { id: string };
        lockRequestBooking: ReturnType<typeof vi.fn>;
        lockLine: ReturnType<typeof vi.fn>;
      };
      events: Record<string, unknown>;
      tx: unknown;
    };
    const lockRows = vi.fn(async () => undefined);
    Object.assign(repos.events, { lockRows });
    Object.assign(repos, {
      bookingRequests: {
        ...(repos.bookingRequests as object),
        findByAgreementId: vi.fn(async () => ({
          id: REQUEST_ID,
          direction: "TO_VENUE",
          placeId: "33333333-3333-4333-8333-333333333333",
          agreementId: AGREEMENT_ID,
          performerOwnerType: "human",
          performerOwnerId: PERFORMER_ID,
          originEventId: options.originEventId ?? null,
        })),
      },
      places: {
        getById: vi.fn(async () => ({
          id: "33333333-3333-4333-8333-333333333333",
          timezone: "America/Chicago",
          orgIdsWithAccess: [VENUE_ORG_ID],
          humanIdsWithAccess: [],
        })),
      },
      // `withTx` hands its ORIGINAL bag to the transaction; the mutations
      // above must be visible inside it too.
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos)),
    });
    const hold = options.booked === false
      ? null
      : repos.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CAL, date: NIGHT, status: "CONFIRMED" });
    const input = { ...baseInput, actorHumanId: side === "venue" ? VENUE_ADMIN_ID : PERFORMER_ID };
    return { ...built, eventRow, hold, lockRows, holds: repos.bookingHolds, input };
  }

  describe("the venue finalizes (its codes carry the event and the days / calendars)", () => {
    it("another NIGHT's event → HOLD_DATE_MISMATCHES_EVENT with the event and both days; nothing linked", async () => {
      const { deps, events, agreements, input } = bookedNight({ startsAt: NEXT_WEEK, calendarId: CAL });

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "HOLD_DATE_MISMATCHES_EVENT",
        meta: { eventId: EVENT_ID, holdDate: NIGHT, eventDate: "2026-10-24" },
      });
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
      expect(agreements.record()?.eventId).toBeNull();
    });

    it("the right night on ANOTHER calendar → EVENT_ON_ANOTHER_CALENDAR; nothing linked", async () => {
      const { deps, events, input } = bookedNight({ startsAt: ON_NIGHT, calendarId: OTHER_CAL });

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "EVENT_ON_ANOTHER_CALENDAR",
        meta: expect.objectContaining({ eventId: EVENT_ID }),
      });
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("the booked night's own event finalizes as before", async () => {
      const { deps, input } = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL });
      await expect(finalizeBookingAgreement(deps, input)).resolves.toMatchObject({ eventId: EVENT_ID });
    });

    it("no booked night yet: any event the finalizer can edit, as before", async () => {
      const { deps, input } = bookedNight({ startsAt: NEXT_WEEK, calendarId: CAL }, { booked: false });
      await expect(finalizeBookingAgreement(deps, input)).resolves.toMatchObject({ eventId: EVENT_ID });
    });
  });

  // Round 3, W4: the refusal follows the finalizer's side. The act never
  // learns the venue's event ids, days or calendars (booking-holds FR-013).
  describe("the sender (the act) finalizes — meta-free refusals (W4)", () => {
    it("another NIGHT's event → EVENT_ON_ANOTHER_NIGHT with NO meta and no message; nothing linked", async () => {
      const { deps, events, input } = bookedNight({ startsAt: NEXT_WEEK, calendarId: CAL }, { side: "sender" });

      const error = await finalizeBookingAgreement(deps, input).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "EVENT_ON_ANOTHER_NIGHT" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("the right night on ANOTHER calendar → EVENT_ON_ANOTHER_NIGHT too (never the venue's calendar code)", async () => {
      const { deps, events, input } = bookedNight({ startsAt: ON_NIGHT, calendarId: OTHER_CAL }, { side: "sender" });

      const error = await finalizeBookingAgreement(deps, input).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "EVENT_ON_ANOTHER_NIGHT" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("the booked night's own event finalizes for the sender as well", async () => {
      const { deps, input } = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL }, { side: "sender" });
      await expect(finalizeBookingAgreement(deps, input)).resolves.toMatchObject({ eventId: EVENT_ID });
    });
  });

  // Round 3, W3: an event-first request's terms link only to its origin.
  describe("an event-first request finalizes against its ORIGIN event only (W3)", () => {
    it("venue: another event → EVENT_FIRST_REQUIRES_ORIGIN_EVENT with the agreement, the event and the origin; nothing linked", async () => {
      const { deps, events, input } = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL }, { originEventId: ORIGIN_EVENT_ID });

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "EVENT_FIRST_REQUIRES_ORIGIN_EVENT",
        meta: { agreementId: AGREEMENT_ID, eventId: EVENT_ID, originEventId: ORIGIN_EVENT_ID },
      });
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("sender: the same, with NO meta", async () => {
      const { deps, events, input } = bookedNight(
        { startsAt: ON_NIGHT, calendarId: CAL },
        { side: "sender", originEventId: ORIGIN_EVENT_ID },
      );

      const error = await finalizeBookingAgreement(deps, input).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "EVENT_FIRST_REQUIRES_ORIGIN_EVENT" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("the origin itself finalizes (and must still sit on the booked night)", async () => {
      const own = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL }, { originEventId: EVENT_ID });
      await expect(finalizeBookingAgreement(own.deps, own.input)).resolves.toMatchObject({ eventId: EVENT_ID });

      const moved = bookedNight({ startsAt: NEXT_WEEK, calendarId: CAL }, { originEventId: EVENT_ID });
      await expect(finalizeBookingAgreement(moved.deps, moved.input)).rejects.toMatchObject({
        code: "HOLD_DATE_MISMATCHES_EVENT",
      });
    });

    it("refused BEFORE the night is looked at: an event-first request with no booked night is refused the same way", async () => {
      const { deps, events, input } = bookedNight(
        { startsAt: NEXT_WEEK, calendarId: CAL },
        { booked: false, originEventId: ORIGIN_EVENT_ID },
      );
      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({ code: "EVENT_FIRST_REQUIRES_ORIGIN_EVENT" });
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });
  });

  // Round 3, B2: a request-linked agreement whose minted draft is still LIVE
  // is never finalized to ANOTHER event — that would drop the anchor and leave
  // the booking pointing at two live events (Cancel booking would cancel one
  // and free the night under the other). Refused by name, both sides, in the
  // pre-flight and again under the locks on a RE-READ of the agreement.
  describe("a live draft anchor beside the link is refused, never dropped (B2)", () => {
    const DRAFT_ID = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
    type Row = { id: string; orgId: string | null; humanId: string | null; status: string; startsAt: Date; calendarId: string | null };

    /** `bookedNight` plus a draft anchor D in `draftStatus` on the same night. */
    function withAnchor(draftStatus: string, options: { side?: Side; anchored?: boolean } = {}) {
      const side = options.side ?? "venue";
      const built = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL }, { side });
      const draftRow: Row = {
        id: DRAFT_ID,
        orgId: side === "venue" ? VENUE_ORG_ID : null,
        humanId: side === "venue" ? null : PERFORMER_ID,
        status: draftStatus,
        startsAt: ON_NIGHT,
        calendarId: CAL,
      };
      built.events.getById.mockImplementation(async (id?: string) => (id === DRAFT_ID ? draftRow : built.eventRow) as never);
      if (options.anchored !== false) {
        const record = built.agreements.record()!;
        built.agreements.repo.getById.mockImplementation(async () => ({ ...record, draftEventId: DRAFT_ID }));
      }
      return { ...built, draftRow };
    }

    it("venue: a live DRAFT anchor D and a link to X → BOOKING_HAS_MULTIPLE_EVENTS with both ids, in the pre-flight (no lock taken); nothing linked, the anchor kept", async () => {
      const { deps, events, agreements, lockRows, input } = withAnchor("DRAFT");

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "BOOKING_HAS_MULTIPLE_EVENTS",
        meta: { bookingRequestId: REQUEST_ID, eventIds: [DRAFT_ID, EVENT_ID] },
      });
      expect(lockRows).not.toHaveBeenCalled();
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    });

    it("venue: a PUBLISHED anchor (the venue published D, then built X) is refused the same way", async () => {
      const { deps, events, input } = withAnchor("PUBLISHED");
      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({ code: "BOOKING_HAS_MULTIPLE_EVENTS" });
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("sender: the same with NO meta", async () => {
      const { deps, events, input } = withAnchor("DRAFT", { side: "sender" });
      const error = await finalizeBookingAgreement(deps, input).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "BOOKING_HAS_MULTIPLE_EVENTS" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("the anchor is SET between the pre-flight read and the locks (a mint lands): the agreement is re-read under the lock and the link refused there; nothing written", async () => {
      const { deps, events, agreements, lockRows, input } = withAnchor("DRAFT", { anchored: false });
      const record = agreements.record()!;
      // Pre-flight: no anchor. Granted the row lock: the anchor is there.
      lockRows.mockImplementationOnce(async () => {
        agreements.repo.getById.mockImplementation(async () => ({ ...record, draftEventId: DRAFT_ID }));
      });

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "BOOKING_HAS_MULTIPLE_EVENTS",
        meta: { bookingRequestId: REQUEST_ID, eventIds: [DRAFT_ID, EVENT_ID] },
      });
      expect(lockRows).toHaveBeenCalledTimes(1);
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    });

    // ── booking-the-night P2d-2 (carry b) ──
    // A mint's `setDraftEvent` takes neither the event row nor the booking
    // lock, so it can land AFTER the in-tx re-read above and BEFORE the link
    // write. The write is fenced on the anchor the checks saw: it matches
    // nothing, the finalize is refused as a conflict, nothing is linked.
    it("the anchor is SET after the in-tx re-read, before the link write (a mint lands): the write's anchor fence refuses it; nothing linked", async () => {
      const { deps, events, agreements, holds, input } = withAnchor("DRAFT", { anchored: false });
      const record = agreements.record()!;
      // The first line lock is taken AFTER the re-read: the mint lands there.
      holds.lockLine.mockImplementationOnce(async () => {
        agreements.repo.getById.mockImplementation(async () => ({ ...record, draftEventId: DRAFT_ID }));
      });

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "conflict",
        message: "agreement_status_changed",
      });
      expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: EVENT_ID, expectedDraftEventId: null }),
      );
      expect(agreements.record()?.eventId).toBeNull();
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("clearDraftEventId is decided from the in-tx re-read, not the pre-transaction read", async () => {
      // Pre-flight: no anchor. Under the locks: a DEAD anchor (cancelled
      // draft) is there — the write retires THAT one, fenced on it.
      const { deps, agreements, lockRows, input } = withAnchor("CANCELLED", { anchored: false });
      const record = agreements.record()!;
      lockRows.mockImplementationOnce(async () => {
        agreements.repo.getById.mockImplementation(async () => ({ ...record, draftEventId: DRAFT_ID }));
      });

      await expect(finalizeBookingAgreement(deps, input)).resolves.toMatchObject({ eventId: EVENT_ID });
      expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: EVENT_ID, expectedDraftEventId: DRAFT_ID, clearDraftEventId: true }),
      );
    });

    it("a DEAD anchor (D cancelled) is retired by the link write as before", async () => {
      const { deps, agreements, input } = withAnchor("CANCELLED");
      await expect(finalizeBookingAgreement(deps, input)).resolves.toMatchObject({ eventId: EVENT_ID });
      expect(agreements.repo.updateStatus).toHaveBeenCalledWith(expect.objectContaining({ eventId: EVENT_ID, clearDraftEventId: true }));
    });

    it("finalizing to the anchor ITSELF (the create flow) is not a second event", async () => {
      const built = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL });
      const record = built.agreements.record()!;
      built.agreements.repo.getById.mockImplementation(async () => ({ ...record, draftEventId: EVENT_ID }));
      await expect(finalizeBookingAgreement(built.deps, built.input)).resolves.toMatchObject({ eventId: EVENT_ID });
    });
  });

  // Round 3, W1a: a request's terms link only an event one PARTY owns — the
  // venue side (one of the place's owners) or the sender pair. A third
  // party's event (one the finalizer happens to edit elsewhere) is refused,
  // side-aware.
  describe("a third party's event is never linked (W1a)", () => {
    const THIRD_ORG = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

    /** The finalizer is an ADMIN of THIRD_ORG too, so the edit gate passes and the ownership rule is what refuses. */
    function thirdPartyEvent(side: Side) {
      const built = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL }, { side });
      built.eventRow.orgId = THIRD_ORG;
      built.eventRow.humanId = null;
      const actor = side === "venue" ? VENUE_ADMIN_ID : PERFORMER_ID;
      Object.assign(built.deps.repos, {
        authz: makeAuthzFake({
          [`${VENUE_ORG_ID}:${VENUE_ADMIN_ID}`]: "ADMIN",
          [`${THIRD_ORG}:${actor}`]: "ADMIN",
        }),
      });
      return built;
    }

    it("venue: EVENT_OWNER_NOT_BOOKING_PARTY with the agreement and the event; nothing linked", async () => {
      const { deps, events, input } = thirdPartyEvent("venue");
      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "EVENT_OWNER_NOT_BOOKING_PARTY",
        meta: { agreementId: AGREEMENT_ID, eventId: EVENT_ID },
      });
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("sender: the same with NO meta", async () => {
      const { deps, events, input } = thirdPartyEvent("sender");
      const error = await finalizeBookingAgreement(deps, input).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "EVENT_OWNER_NOT_BOOKING_PARTY" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });

    it("the sender pair's OWN org event is the sender's (an org act): linked as before", async () => {
      const built = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL }, { side: "sender" });
      const ACT_ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
      built.eventRow.orgId = ACT_ORG;
      built.eventRow.humanId = null;
      Object.assign(built.deps.repos, {
        authz: makeAuthzFake({ [`${ACT_ORG}:${PERFORMER_ID}`]: "ADMIN" }),
        bookingRequests: {
          ...(built.deps.repos as unknown as { bookingRequests: object }).bookingRequests,
          findByAgreementId: vi.fn(async () => ({
            id: REQUEST_ID,
            direction: "TO_VENUE",
            placeId: "33333333-3333-4333-8333-333333333333",
            agreementId: AGREEMENT_ID,
            performerOwnerType: "organization",
            performerOwnerId: ACT_ORG,
            originEventId: null,
          })),
        },
      });
      await expect(finalizeBookingAgreement(built.deps, built.input)).resolves.toMatchObject({ eventId: EVENT_ID });
    });

    it("no booked night yet: the ownership rule still applies (it is about the link, not the night)", async () => {
      const built = thirdPartyEvent("venue");
      (built.holds as unknown as { rows: Map<string, unknown> }).rows.clear();
      await expect(finalizeBookingAgreement(built.deps, built.input)).rejects.toMatchObject({ code: "EVENT_OWNER_NOT_BOOKING_PARTY" });
    });
  });

  // Round 3, W5 residual (d): the authoritative check runs under the locks,
  // in the order publish and Cancel booking take them (event row → booking
  // lock → lines), so finalize can never cycle with either.
  describe("the authoritative check runs under the locks (W5 residual d)", () => {
    it("in the transaction: the event row, then the request's booking lock, then the booked line — all BEFORE the link is written", async () => {
      const { deps, agreements, lockRows, holds, input } = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL });

      await finalizeBookingAgreement(deps, input);

      expect(lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
      expect(holds.lockRequestBooking).toHaveBeenCalledWith(REQUEST_ID);
      expect(holds.lockLine).toHaveBeenCalledWith({ calendarId: CAL, date: NIGHT });
      const row = lockRows.mock.invocationCallOrder[0]!;
      const booking = holds.lockRequestBooking.mock.invocationCallOrder[0]!;
      const line = holds.lockLine.mock.invocationCallOrder[0]!;
      const write = agreements.repo.updateStatus.mock.invocationCallOrder[0]!;
      expect(row).toBeLessThan(booking);
      expect(booking).toBeLessThan(line);
      expect(line).toBeLessThan(write);
    });

    it("an event moved off the night while finalize waited on its row lock is refused UNDER the lock; nothing linked", async () => {
      const { deps, events, agreements, lockRows, eventRow, input } = bookedNight({ startsAt: ON_NIGHT, calendarId: CAL });
      // The pre-flight saw the event on the night; by the time the row lock
      // is granted, a concurrent edit has moved it a week out.
      lockRows.mockImplementationOnce(async () => {
        eventRow.startsAt = NEXT_WEEK;
      });

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({
        code: "HOLD_DATE_MISMATCHES_EVENT",
        meta: { eventId: EVENT_ID, holdDate: NIGHT, eventDate: "2026-10-24" },
      });
      expect(lockRows).toHaveBeenCalledTimes(1);
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
      expect(agreements.record()?.eventId).toBeNull();
    });

    it("a night booked only AFTER the pre-flight read (a settle that beat finalize to the booking lock) is checked too: the off-night link is refused", async () => {
      const { deps, events, holds, input } = bookedNight({ startsAt: NEXT_WEEK, calendarId: CAL }, { booked: false });
      // The pre-flight found no booked night (nothing to check); the booking
      // lock is granted after a publish-time settle CONFIRMED the request's
      // hold on NIGHT.
      holds.lockRequestBooking.mockImplementationOnce(async () => {
        holds.seed({ bookingRequestId: REQUEST_ID, calendarId: CAL, date: NIGHT, status: "CONFIRMED" });
      });

      await expect(finalizeBookingAgreement(deps, input)).rejects.toMatchObject({ code: "HOLD_DATE_MISMATCHES_EVENT" });
      expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// freeze-the-deal FR-004 / FR-005 / FR-006: finalize re-points the event's
// PRIMARY terms, so on a frozen event it is a deal change like any other.
// ─────────────────────────────────────────────────────────────────────────────

describe("finalizeBookingAgreement — an event whose deal is frozen", () => {
  const OLD_TERMS_ID = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
  const REMOVED_PAYEE_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const REMOVED_HUMAN_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
  const CHANGE_ID = "dc000000-0000-4000-8000-0000000000f1";
  const FROZEN_AT = new Date("2026-06-01T00:00:00.000Z");

  const clause = (id: string, termsId: string, payeeId: string, percent: number) => ({
    id,
    payoutTermsId: termsId,
    payeeId,
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
  });
  /** The event's deal today: one payee the booking's deal does not name. */
  const OLD_DEAL = {
    payoutTermsId: OLD_TERMS_ID,
    remainderPayeeId: null,
    clauses: [clause("c0000000-0000-4000-8000-000000000001", OLD_TERMS_ID, REMOVED_PAYEE_ID, 100)],
    deductions: [],
  };
  /** The booking's deal (its lines). */
  const BOOKING_DEAL = {
    payoutTermsId: TERMS_ID,
    remainderPayeeId: null,
    clauses: [
      clause(CONFIRMED_LINE.id, TERMS_ID, THIRD_PARTY_PAYEE_ID, 70),
      clause(PARTY_LINE.id, TERMS_ID, VENUE_PAYEE_ID, 30),
    ],
    deductions: [],
  };

  function frozenNight(opts: { frozen?: boolean } = {}) {
    const built = buildDeps();
    const state = {
      payoutTermsId: OLD_TERMS_ID as string,
      dealFrozenAt: opts.frozen === false ? null : FROZEN_AT,
    };
    const lockOrder: string[] = [];
    const repos = built.deps.repos as unknown as Record<string, unknown> & {
      events: Record<string, unknown>;
      payees: Record<string, unknown>;
    };
    Object.assign(repos.events, {
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID
          ? {
              id: EVENT_ID,
              orgId: null,
              humanId: PERFORMER_ID,
              status: "DRAFT",
              title: "Lowlight",
              timezone: "America/Chicago",
              currency: "usd",
              payoutTermsId: state.payoutTermsId,
              resalePayoutTermsId: null,
              dealFrozenAt: state.dealFrozenAt,
              dealFrozenByHumanId: null,
            }
          : null,
      ),
      linkPayoutTerms: vi.fn(async ({ payoutTermsId }: { payoutTermsId: string }) => {
        state.payoutTermsId = payoutTermsId;
      }),
      lockRows: vi.fn(async ({ ids }: { ids: string[] }) => {
        lockOrder.push(...ids.map((id) => `event:${id}`));
      }),
    });
    const createDealChange = vi.fn(
      async (input: { eventId: string; actorHumanId: string; before: unknown; after: unknown }) => ({
        id: CHANGE_ID,
        eventId: input.eventId,
        actorHumanId: input.actorHumanId,
        createdAt: NOW_FOR_FREEZE,
        before: input.before,
        after: input.after,
      }),
    );
    const deals = {
      lockTerms: vi.fn(async (id: string) => {
        lockOrder.push(`terms:${id}`);
        return true;
      }),
      getTermsDeal: vi.fn(async (id: string) =>
        id === OLD_TERMS_ID ? structuredClone(OLD_DEAL) : id === TERMS_ID ? structuredClone(BOOKING_DEAL) : null,
      ),
      createDealChange,
    };
    const allPayees = [
      buildPayeeRecord({ id: THIRD_PARTY_PAYEE_ID }),
      buildPayeeRecord({ id: VENUE_PAYEE_ID, subjectType: "ORGANIZATION", subjectId: VENUE_ORG_ID }),
      buildPayeeRecord({ id: REMOVED_PAYEE_ID, subjectId: REMOVED_HUMAN_ID }),
    ];
    Object.assign(repos.payees, {
      getByIds: vi.fn(async (ids: string[]) => allPayees.filter((p) => ids.includes(p.id))),
    });
    const notify = vi.fn(async (_n: { humanId: string; idempotencyKey: string; payload: Record<string, unknown> }) => undefined);
    const reportError = vi.fn();
    Object.assign(repos, {
      deals,
      organizations: {
        getByIds: vi.fn(async () => [{ id: VENUE_ORG_ID, name: "Marrow Hall" }]),
        listMembers: vi.fn(async () => ({ items: [{ humanId: VENUE_ADMIN_ID, role: "ADMIN" }], total: 1 })),
      },
      humans: {
        getByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({ id, name: `Person ${id.slice(0, 4)}`, locale: id === REMOVED_HUMAN_ID ? "es-MX" : null })),
        ),
      },
      // `withTx` hands its ORIGINAL bag to the transaction; the repos set
      // above must be visible inside it too.
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos)),
    });
    const deps = { ...built.deps, notify, reportError };
    return { ...built, deps, state, lockOrder, deals, createDealChange, notify, reportError };
  }
  const NOW_FOR_FREEZE = new Date("2026-06-10T12:00:00.000Z");

  it("without frozenChange → DEAL_FROZEN under the locks; nothing linked, no DealChange, no notice", async () => {
    const w = frozenNight();
    await expect(finalizeBookingAgreement(w.deps, baseInput)).rejects.toMatchObject({ code: "DEAL_FROZEN" });
    expect(w.events.linkPayoutTerms).not.toHaveBeenCalled();
    expect(w.agreements.repo.updateStatus).not.toHaveBeenCalled();
    expect(w.payoutTerms.activate).not.toHaveBeenCalled();
    expect(w.createDealChange).not.toHaveBeenCalled();
    expect(w.notify).not.toHaveBeenCalled();
    expect(w.state.payoutTermsId).toBe(OLD_TERMS_ID);
    // Event row, then both terms rows (id order), before the refusal.
    expect(w.lockOrder).toEqual([`event:${EVENT_ID}`, `terms:${OLD_TERMS_ID}`, `terms:${TERMS_ID}`]);
  });

  it("DEAL_FROZEN releases the idempotency claim at once, so the retry with frozenChange runs", async () => {
    const w = frozenNight();
    vi.useFakeTimers();
    try {
      await expect(finalizeBookingAgreement(w.deps, baseInput)).rejects.toMatchObject({ code: "DEAL_FROZEN" });
      // The 1s deterministic retention, not the adapters' 15 minutes.
      vi.advanceTimersByTime(1_100);
      await expect(finalizeBookingAgreement(w.deps, { ...baseInput, frozenChange: true })).resolves.toMatchObject({
        eventId: EVENT_ID,
        payoutTermsId: TERMS_ID,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("with frozenChange → linked, one DealChange (before = the event's deal, after = the booking's), every payee told but the actor", async () => {
    const w = frozenNight();
    await expect(
      finalizeBookingAgreement(w.deps, { ...baseInput, frozenChange: true }),
    ).resolves.toMatchObject({ eventId: EVENT_ID, payoutTermsId: TERMS_ID });
    expect(w.state.payoutTermsId).toBe(TERMS_ID);
    expect(w.createDealChange).toHaveBeenCalledTimes(1);
    const [row] = w.createDealChange.mock.calls[0]! as unknown as [
      { before: { primary: { payoutTermsId: string } }; after: { primary: { payoutTermsId: string } } },
    ];
    expect(row.before.primary.payoutTermsId).toBe(OLD_TERMS_ID);
    expect(row.after.primary.payoutTermsId).toBe(TERMS_ID);
    expect(w.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event.deal_frozen_change", data: expect.objectContaining({ dealChangeId: CHANGE_ID }) }),
    );
    // The removed payee, the new third party and the venue's admin; the
    // actor (the performer) is on neither side and is not told anyway.
    const told = w.notify.mock.calls.map(([n]) => n.humanId).sort();
    expect(told).toEqual([REMOVED_HUMAN_ID, THIRD_PARTY_HUMAN_ID, VENUE_ADMIN_ID].sort());
    const removed = w.notify.mock.calls.find(([n]) => n.humanId === REMOVED_HUMAN_ID)![0];
    expect(removed.idempotencyKey).toBe(`deal-change:${CHANGE_ID}:${REMOVED_HUMAN_ID}`);
    expect(removed.payload).toMatchObject({ recipientRemoved: true, emailLocale: "es", currency: "usd" });
    const kept = w.notify.mock.calls.find(([n]) => n.humanId === THIRD_PARTY_HUMAN_ID)![0];
    expect(kept.payload).toMatchObject({ recipientRemoved: false, emailLocale: "en" });
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("an unfrozen event finalizes exactly as before: no DealChange, no notice", async () => {
    const w = frozenNight({ frozen: false });
    await expect(finalizeBookingAgreement(w.deps, baseInput)).resolves.toMatchObject({ payoutTermsId: TERMS_ID });
    expect(w.state.payoutTermsId).toBe(TERMS_ID);
    expect(w.payoutTerms.activate).toHaveBeenCalled();
    expect(w.createDealChange).not.toHaveBeenCalled();
    expect(w.deals.getTermsDeal).not.toHaveBeenCalled();
    expect(w.notify).not.toHaveBeenCalled();
  });
});
