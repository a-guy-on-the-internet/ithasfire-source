import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayeeRecord, PayeeSubjectType } from "@th/ports/repos/payees";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import { upsertBookingAgreementLine } from "../upsert-booking-agreement-line";
import type { BookingAgreementLineDeps } from "../upsert-booking-agreement-line";
import {
  AGREEMENT_ID,
  EVENT_ID,
  LINE_ID,
  OUTSIDER_ID,
  PERFORMER_ID,
  PERFORMER_PAYEE_ID,
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
  withTx,
} from "./helpers";

type BuildOptions = {
  agreement?: AgreementRecord | null;
  existingLines?: PayoutTermsLineRecord[];
  /** Payees returned by upsertForSubject, keyed `SUBJECT_TYPE:subjectId`. */
  payeesBySubject?: Record<string, PayeeRecord>;
  knownHumanIds?: string[];
};

const DEFAULT_PAYEES: Record<string, PayeeRecord> = {
  [`HUMAN:${THIRD_PARTY_HUMAN_ID}`]: buildPayeeRecord({
    id: THIRD_PARTY_PAYEE_ID,
    subjectType: "HUMAN",
    subjectId: THIRD_PARTY_HUMAN_ID,
    // Fresh payees are PENDING pre-Connect — allowed while drafting.
    status: "PENDING",
    stripeAccountId: null,
    payoutsEnabled: false,
    chargesEnabled: false,
  }),
  [`HUMAN:${PERFORMER_ID}`]: buildPayeeRecord({
    id: PERFORMER_PAYEE_ID,
    subjectType: "HUMAN",
    subjectId: PERFORMER_ID,
  }),
  [`ORGANIZATION:${VENUE_ORG_ID}`]: buildPayeeRecord({
    id: VENUE_PAYEE_ID,
    subjectType: "ORGANIZATION",
    subjectId: VENUE_ORG_ID,
  }),
};

function buildDeps(options: BuildOptions = {}) {
  const agreements = makeAgreementsRepoFake(
    options.agreement === undefined
      ? buildAgreementRecord()
      : options.agreement,
  );
  const audit = makeAuditFake();
  const payeesBySubject = options.payeesBySubject ?? DEFAULT_PAYEES;

  let lines = options.existingLines ?? [];
  const payoutTerms = {
    listLines: vi.fn(async () => lines),
    replaceLines: vi.fn(async (_termsId: string, inputs: unknown[]) => {
      lines = inputs as PayoutTermsLineRecord[];
    }),
  };

  const payees = {
    upsertForSubject: vi.fn(
      async (input: { subjectType: PayeeSubjectType; subjectId: string }) => {
        const payee =
          payeesBySubject[`${input.subjectType}:${input.subjectId}`];
        if (!payee) throw new Error("unexpected subject in test");
        return payee;
      },
    ),
  };

  const knownHumanIds = options.knownHumanIds ?? [
    PERFORMER_ID,
    THIRD_PARTY_HUMAN_ID,
  ];
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => knownHumanIds.includes(id))
        .map((id) => ({ id, name: "Somebody" })),
    ),
  };
  const organizations = {
    getById: vi.fn(async (id: string) =>
      id === VENUE_ORG_ID ? { id, name: "Venue Org" } : null,
    ),
  };

  const deps = {
    repos: withTx({
      agreements: agreements.repo,
      payoutTerms,
      payees,
      humans,
      organizations,
      authz: makeAuthzFake(),
      audit,
    }) as unknown as BookingAgreementLineDeps["repos"],
    clock: makeClock(),
  } satisfies BookingAgreementLineDeps;

  return { deps, agreements, payoutTerms, payees, audit, lines: () => lines };
}

const baseInput = {
  actorHumanId: PERFORMER_ID,
  agreementId: AGREEMENT_ID,
};

describe("upsertBookingAgreementLine", () => {
  it("adds a third-party line as requiresConfirmation + PENDING", async () => {
    const { deps, payoutTerms } = buildDeps();

    const result = await upsertBookingAgreementLine(deps, {
      ...baseInput,
      payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
      percent: 15,
      floorCents: 5_000,
    });

    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationStatus).toBe("PENDING");
    expect(result.percent).toBe(15);
    expect(result.floorCents).toBe(5_000);

    const persisted = payoutTerms.replaceLines.mock.calls[0]![1] as Array<{
      payeeId: string;
      requiresConfirmation?: boolean;
      confirmationStatus?: string | null;
    }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      payeeId: THIRD_PARTY_PAYEE_ID,
      requiresConfirmation: true,
      confirmationStatus: "PENDING",
    });
  });

  it("adds an agreement-party payee line WITHOUT confirmation (implied by acceptance)", async () => {
    const { deps } = buildDeps();

    // The venue counterparty org paying itself a cut.
    const result = await upsertBookingAgreementLine(deps, {
      ...baseInput,
      actorHumanId: VENUE_ADMIN_ID,
      payeeRef: { kind: "org", id: VENUE_ORG_ID },
      percent: 30,
    });

    expect(result.requiresConfirmation).toBe(false);
    expect(result.confirmationStatus).toBeNull();
  });

  it("treats the proposer-human payee as a party payee too", async () => {
    const { deps } = buildDeps();

    const result = await upsertBookingAgreementLine(deps, {
      ...baseInput,
      payeeRef: { kind: "human", id: PERFORMER_ID },
      percent: 40,
    });

    expect(result.requiresConfirmation).toBe(false);
  });

  it("rejects when the percent total would exceed 100", async () => {
    const { deps } = buildDeps({
      existingLines: [
        buildLineRecord({
          id: "11111111-2222-4333-8444-555555555555",
          payeeId: VENUE_PAYEE_ID,
          percent: 90,
        }),
      ],
    });

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 20,
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "AGREEMENT_PERCENT_TOTAL_EXCEEDED",
    });
  });

  it("rejects a second line for an already-assigned payee", async () => {
    const { deps } = buildDeps({
      existingLines: [buildLineRecord({ payeeId: THIRD_PARTY_PAYEE_ID })],
    });

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 5,
      }),
    ).rejects.toMatchObject({ code: "PAYEE_ALREADY_ASSIGNED" });
  });

  it("resets a CONFIRMED line to PENDING when its economics change", async () => {
    const { deps, lines } = buildDeps({
      existingLines: [
        buildLineRecord({
          id: LINE_ID,
          payeeId: THIRD_PARTY_PAYEE_ID,
          percent: 10,
          confirmationStatus: "CONFIRMED",
          confirmedAt: new Date("2026-06-05T00:00:00.000Z"),
        }),
      ],
    });

    const result = await upsertBookingAgreementLine(deps, {
      ...baseInput,
      lineId: LINE_ID,
      payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
      percent: 12,
    });

    expect(result.confirmationStatus).toBe("PENDING");
    const persisted = lines().find((line) => line.id === LINE_ID)!;
    expect(persisted.confirmationStatus).toBe("PENDING");
    expect(persisted.confirmedAt).toBeNull();
  });

  it("preserves a CONFIRMED state when only priority changes", async () => {
    const confirmedAt = new Date("2026-06-05T00:00:00.000Z");
    const { deps } = buildDeps({
      existingLines: [
        buildLineRecord({
          id: LINE_ID,
          payeeId: THIRD_PARTY_PAYEE_ID,
          percent: 10,
          confirmationStatus: "CONFIRMED",
          confirmedAt,
        }),
      ],
    });

    const result = await upsertBookingAgreementLine(deps, {
      ...baseInput,
      lineId: LINE_ID,
      payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
      percent: 10,
      priority: 5,
    });

    expect(result.confirmationStatus).toBe("CONFIRMED");
  });

  it("carries untouched lines' confirmation state through the rewrite", async () => {
    const confirmedAt = new Date("2026-06-05T00:00:00.000Z");
    const { deps, lines } = buildDeps({
      existingLines: [
        buildLineRecord({
          id: "11111111-2222-4333-8444-555555555555",
          payeeId: THIRD_PARTY_PAYEE_ID,
          percent: 10,
          confirmationStatus: "CONFIRMED",
          confirmedAt,
        }),
      ],
    });

    await upsertBookingAgreementLine(deps, {
      ...baseInput,
      payeeRef: { kind: "org", id: VENUE_ORG_ID },
      percent: 30,
    });

    const untouched = lines().find(
      (line) => line.payeeId === THIRD_PARTY_PAYEE_ID,
    )!;
    expect(untouched.confirmationStatus).toBe("CONFIRMED");
    expect(untouched.confirmedAt).toEqual(confirmedAt);
  });

  it("rejects payee changes on an existing line", async () => {
    const { deps } = buildDeps({
      existingLines: [
        buildLineRecord({ id: LINE_ID, payeeId: VENUE_PAYEE_ID }),
      ],
    });

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        lineId: LINE_ID,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 10,
      }),
    ).rejects.toMatchObject({ code: "PAYEE_CHANGE_NOT_ALLOWED" });
  });

  it("rejects line edits outside DRAFT", async () => {
    const { deps } = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED" }),
    });

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 10,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_DRAFT" });
  });

  it("rejects line edits on a FINALIZED agreement (eventId stamped) even if status reads DRAFT", async () => {
    // Defense in depth: finalize stamps eventId from ACCEPTED, so DRAFT +
    // eventId shouldn't exist — but if it ever did, the linked event settles
    // on these terms and they must stay immutable.
    const { deps, payoutTerms } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT", eventId: EVENT_ID }),
    });

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 10,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });
    expect(payoutTerms.replaceLines).not.toHaveBeenCalled();
  });

  it("rejects non-party actors", async () => {
    const { deps } = buildDeps();

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        actorHumanId: OUTSIDER_ID,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 10,
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });

  it("rejects payee refs pointing at unknown humans (no phantom Payee rows)", async () => {
    const { deps, payees } = buildDeps({ knownHumanIds: [PERFORMER_ID] });

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 10,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
    expect(payees.upsertForSubject).not.toHaveBeenCalled();
  });

  it("rejects float percents at the boundary", async () => {
    const { deps } = buildDeps();

    await expect(
      upsertBookingAgreementLine(deps, {
        ...baseInput,
        payeeRef: { kind: "human", id: THIRD_PARTY_HUMAN_ID },
        percent: 12.5,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
