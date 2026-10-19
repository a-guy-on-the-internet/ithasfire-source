import { describe, expect, it, vi } from "vitest";

import { upsertAgreementLine } from "../upsert-agreement-lines";
import { makeUpsertAgreementTestContext } from "@th/test-utils";
import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type { PayeeRecord } from "@th/ports/repos/payees";

vi.mock("@th/adapters/decorators/with-dependency-guard", () => ({
  withGuardedRepos: <T>(repos: T) => repos,
}));

const AGREEMENT_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_PAYEE_ID = "eeee0000-0000-4000-8000-000000000005";

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Showcase",
  status: "DRAFT",
  visibility: "PRIVATE",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2024-06-01T19:00:00.000Z"),
  endsAt: null,
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  publishedAt: null,
  slug: null,
  shortId: null,
  regionCode: null,
  defaultLocale: null,
  agreementPrimaryId: AGREEMENT_ID,
  agreementResaleId: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: AGREEMENT_ID,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
};

const baseOrganization: OrganizationRecord = {
  id: ORG_ID,
  name: "Harmony Org",
  slug: "harmony-org",
  status: "ACTIVE",
  defaultLocale: null,
  trustTier: "NEW",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
};

const basePayee: PayeeRecord = {
  id: DEFAULT_PAYEE_ID,
  subjectType: "ORGANIZATION",
  subjectId: ORG_ID,
  stripeAccountId: null,
  status: "ACTIVE",
  payoutsEnabled: true,
  chargesEnabled: true,
  defaultCurrency: "usd",
};

function buildAgreement(
  overrides: Partial<PayoutTermsRecord> = {},
): PayoutTermsRecord {
  const now = new Date("2024-05-01T00:00:00.000Z");
  return {
    id: AGREEMENT_ID,
    kind: "PRIMARY_SPLIT",
    status: "PENDING",
    feeMode: null,
    feePolicyId: null,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } satisfies PayoutTermsRecord;
}

function makeContext(
  options: {
    agreementOverrides?: Partial<PayoutTermsRecord>;
    existingLines?: PayoutTermsLineRecord[];
    payees?: Record<string, PayeeRecord | null>;
    idempotencyBeginSequence?: boolean[];
    bookingAgreement?: Parameters<
      typeof makeUpsertAgreementTestContext
    >[0]["bookingAgreement"];
  } = {},
) {
  const agreement = buildAgreement(options.agreementOverrides);
  return makeUpsertAgreementTestContext({
    agreementId: agreement.id,
    existingAgreement: agreement,
    existingLines: options.existingLines,
    event: baseEvent,
    organization: baseOrganization,
    payees: {
      [basePayee.id]: basePayee,
      ...(options.payees ?? {}),
    },
    idempotencyBeginSequence: options.idempotencyBeginSequence,
    bookingAgreement: options.bookingAgreement,
  });
}

describe("upsertAgreementLine", () => {
  it("fences off PayoutTerms owned by a booking Agreement", async () => {
    const ctx = makeContext({
      bookingAgreement: {
        id: "ab0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
        type: "PERFORMANCE",
        status: "DRAFT",
        proposerType: "human",
        proposerId: "77777777-7777-4777-8777-777777777777",
        counterpartyType: "organization",
        counterpartyId: ORG_ID,
        placeId: null,
        eventId: null,
        payoutTermsId: AGREEMENT_ID,
        title: "Booking — Test Venue",
        description: null,
        proposedDate: null,
        proposedEndDate: null,
        guaranteeCents: null,
        proposedAt: null,
        acceptedAt: null,
        declinedAt: null,
        declinedReason: null,
        expiresAt: null,
        fulfilledAt: null,
        sentForReviewByHumanId: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-fence-123456",
        payeeId: ctx.defaults.payeeId,
        percent: 40,
        floorCents: 0,
        capPercent: null,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(ctx.mocks.agreements.replaceLines).not.toHaveBeenCalled();
  });

  // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). Agreement lines on a
  // human's event are the owner's alone: an OWNER-role delegate of the event's
  // owner is refused, nothing is written, and the delegation is never read.
  it("refuses a delegate of a human event's owner, without consulting the delegation", async () => {
    const PRINCIPAL_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
    const ctx = makeContext();
    ctx.mocks.events.getById.mockResolvedValue({
      ...baseEvent,
      orgId: null,
      humanId: PRINCIPAL_ID,
    });
    ctx.mocks.authz.getHumanDelegation.mockResolvedValue({
      orgId: PRINCIPAL_ID,
      humanId: ctx.defaults.actorHumanId,
      role: "OWNER",
    } as never);

    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-delegate-123456",
        payeeId: ctx.defaults.payeeId,
        percent: 40,
        floorCents: 0,
        capPercent: null,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.mocks.authz.getHumanDelegation).not.toHaveBeenCalled();
    expect(ctx.mocks.agreements.replaceLines).not.toHaveBeenCalled();
  });

  it("creates a new line for a pending agreement", async () => {
    const ctx = makeContext();

    const result = await upsertAgreementLine(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      agreementId: ctx.defaults.agreementId,
      clientKey: "line-create-123456",
      payeeId: ctx.defaults.payeeId,
      percent: 40,
      floorCents: 0,
      capPercent: null,
      rounding: "FLOOR",
    });

    expect(result).toEqual({
      lineId: expect.any(String),
      agreementId: ctx.defaults.agreementId,
      normalized: {
        percent: 40,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    });

    expect(ctx.mocks.agreements.replaceLines).toHaveBeenCalledWith(
      ctx.defaults.agreementId,
      [
        expect.objectContaining({
          payeeId: ctx.defaults.payeeId,
          percent: 40,
          priority: 0,
        }),
      ],
    );
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "agreement_line", action: "created" }),
    );
  });

  it("rejects when total percent would exceed 100", async () => {
    const newPayeeId = "44444444-4444-4444-8444-444444444444";
    const existingLines: PayoutTermsLineRecord[] = [
      {
        id: "cccc0000-0000-4000-8000-cccccccccccc",
        agreementId: AGREEMENT_ID,
        payeeId: DEFAULT_PAYEE_ID,
        percent: 80,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ];
    const ctx = makeContext({
      existingLines,
      payees: {
        [newPayeeId]: {
          id: newPayeeId,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          status: "ACTIVE",
          stripeAccountId: null,
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
        },
      },
    });

    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-overflow-123456",
        payeeId: newPayeeId,
        percent: 30,
        floorCents: 0,
        capPercent: null,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "AGREEMENT_PERCENT_TOTAL_EXCEEDED",
    });
  });

  // ── Cap satisfiability ────────────────────────────────────────────────────
  // This engine rewrites the lines of terms that may already be ACTIVE on a
  // selling event, so the predicate `publishEvent`'s Gate 1b runs has to run
  // at the write too — otherwise a cap lowered here takes effect on the very
  // next order and quietly leaves cents unallocated.
  const NEW_PAYEE_ID = "44444444-4444-4444-8444-444444444444";
  const newPayee: PayeeRecord = {
    id: NEW_PAYEE_ID,
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    status: "ACTIVE",
    stripeAccountId: null,
    payoutsEnabled: true,
    chargesEnabled: true,
    defaultCurrency: "usd",
  };
  const existingLine = (
    percent: number,
    capPercent: number | null,
  ): PayoutTermsLineRecord => ({
    id: "cccc0000-0000-4000-8000-cccccccccccc",
    agreementId: AGREEMENT_ID,
    payeeId: DEFAULT_PAYEE_ID,
    percent,
    floorCents: 0,
    capPercent,
    priority: 0,
    rounding: "FLOOR",
  });

  it("refuses a line that completes an all-capped set falling short of 100%", async () => {
    const ctx = makeContext({
      existingLines: [existingLine(60, 10)],
      payees: { [NEW_PAYEE_ID]: newPayee },
    });

    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-caps-short-1234",
        payeeId: NEW_PAYEE_ID,
        percent: 40,
        floorCents: 0,
        capPercent: 40,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({
      code: "SPLITS_CAPS_UNSATISFIABLE",
      meta: { totalCapPct: 50, targetPct: 100 },
    });
  });

  it("accepts an uncapped line completing a set that holds a capped one", async () => {
    // "Venue takes 20%, capped at 5%" + an uncapped 80%: the shape the first
    // cut of this gate refused. One uncapped line absorbs every withheld cent.
    const ctx = makeContext({
      existingLines: [existingLine(20, 5)],
      payees: { [NEW_PAYEE_ID]: newPayee },
    });

    const result = await upsertAgreementLine(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      agreementId: ctx.defaults.agreementId,
      clientKey: "line-caps-ok-12345678",
      payeeId: NEW_PAYEE_ID,
      percent: 80,
      floorCents: 0,
      capPercent: null,
      rounding: "FLOOR",
    });

    expect(result.normalized).toMatchObject({ percent: 80, capPercent: null });
  });

  it("still accepts a capped line on a half-composed agreement", async () => {
    // First line of a deal: all-capped and far short of 100%, but incomplete.
    // Refusing here would make every capped deal uncomposable.
    const ctx = makeContext({ payees: { [NEW_PAYEE_ID]: newPayee } });

    const result = await upsertAgreementLine(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      agreementId: ctx.defaults.agreementId,
      clientKey: "line-caps-draft-1234",
      payeeId: NEW_PAYEE_ID,
      percent: 20,
      floorCents: 0,
      capPercent: 5,
      rounding: "FLOOR",
    });

    expect(result.normalized).toMatchObject({ percent: 20, capPercent: 5 });
  });

  it("updates an existing line within the remaining percent", async () => {
    const targetLine: PayoutTermsLineRecord = {
      id: "88888888-8888-4888-8888-888888888888",
      agreementId: AGREEMENT_ID,
      payeeId: ctxPayeeId(),
      percent: 40,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
    };
    const otherPayeeId = "55555555-5555-4555-8555-555555555555";
    const otherLine: PayoutTermsLineRecord = {
      id: "99999999-9999-4999-8999-999999999999",
      agreementId: AGREEMENT_ID,
      payeeId: otherPayeeId,
      percent: 50,
      floorCents: 0,
      capPercent: null,
      priority: 1,
      rounding: "FLOOR",
    };

    const ctx = makeContext({
      existingLines: [targetLine, otherLine],
      payees: {
        [otherPayeeId]: {
          id: otherPayeeId,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          status: "ACTIVE",
          stripeAccountId: null,
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
        },
      },
    });

    const result = await upsertAgreementLine(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      agreementId: ctx.defaults.agreementId,
      lineId: targetLine.id,
      payeeId: targetLine.payeeId,
      percent: 45,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
      clientKey: "line-update-123456",
    });

    expect(result).toEqual({
      lineId: targetLine.id,
      agreementId: ctx.defaults.agreementId,
      normalized: {
        percent: 45,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    });

    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "agreement_line", action: "updated" }),
    );
  });

  it("throws when agreement is not pending", async () => {
    const ctx = makeContext({ agreementOverrides: { status: "ACTIVE" } });

    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-nondraft-123456",
        payeeId: ctx.defaults.payeeId,
        percent: 30,
        floorCents: 0,
        capPercent: null,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_EDITABLE" });
  });

  it("rejects creating a duplicate payee on the same agreement", async () => {
    const existingLine: PayoutTermsLineRecord = {
      id: "aaaa0000-0000-4000-8000-aaaaaaaaaaaa",
      agreementId: AGREEMENT_ID,
      payeeId: ctxPayeeId(),
      percent: 60,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
    };

    const ctx = makeContext({ existingLines: [existingLine] });

    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-dup-123456",
        payeeId: ctx.defaults.payeeId,
        percent: 20,
        floorCents: 0,
        capPercent: null,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({ code: "PAYEE_ALREADY_ASSIGNED" });
  });

  it("replays the identical payload via idempotency", async () => {
    const ctx = makeContext();

    const input = {
      actorHumanId: ctx.defaults.actorHumanId,
      agreementId: ctx.defaults.agreementId,
      clientKey: "line-idem-123456",
      payeeId: ctx.defaults.payeeId,
      percent: 25,
      floorCents: 0,
      capPercent: null,
      rounding: "FLOOR",
    } as const;

    const first = await upsertAgreementLine(ctx.deps, input);
    const second = await upsertAgreementLine(ctx.deps, input);

    expect(second).toEqual(first);
    expect(ctx.mocks.agreements.replaceLines).toHaveBeenCalledTimes(1);
  });

  it("throws when idempotency key reused with different payload", async () => {
    const ctx = makeContext();

    const baseInput = {
      actorHumanId: ctx.defaults.actorHumanId,
      agreementId: ctx.defaults.agreementId,
      clientKey: "line-idem-conflict-123456",
      payeeId: ctx.defaults.payeeId,
      floorCents: 0,
      capPercent: null,
      rounding: "FLOOR",
    } as const;

    await upsertAgreementLine(ctx.deps, { ...baseInput, percent: 30 });

    await expect(
      upsertAgreementLine(ctx.deps, { ...baseInput, percent: 35 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("rejects changing the payee on update", async () => {
    const originalPayeeId = ctxPayeeId();
    const newPayeeId = "77777777-7777-4777-8777-777777777777";
    const existingLine: PayoutTermsLineRecord = {
      id: "bbbb0000-0000-4000-8000-bbbbbbbbbbbb",
      agreementId: AGREEMENT_ID,
      payeeId: originalPayeeId,
      percent: 30,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
    };

    const ctx = makeContext({
      existingLines: [existingLine],
      payees: {
        [newPayeeId]: {
          id: newPayeeId,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          status: "ACTIVE",
          stripeAccountId: null,
          payoutsEnabled: true,
          chargesEnabled: true,
          defaultCurrency: "usd",
        },
      },
    });

    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-payee-change-123456",
        lineId: existingLine.id,
        payeeId: newPayeeId,
        percent: 30,
        floorCents: 0,
        capPercent: null,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({ code: "PAYEE_CHANGE_NOT_ALLOWED" });
  });
});

function ctxPayeeId() {
  return DEFAULT_PAYEE_ID;
}

// freeze-the-deal FR-004: these terms are an event's, so the event's freeze
// fences this (legacy) line writer too.
describe("upsertAgreementLine — a frozen deal", () => {
  const frozenContext = () =>
    makeUpsertAgreementTestContext({
      agreementId: AGREEMENT_ID,
      existingAgreement: buildAgreement(),
      // The terms are this event's PRIMARY terms (`findByPayoutTermsId`).
      event: {
        ...baseEvent,
        payoutTermsId: AGREEMENT_ID,
        dealFrozenAt: new Date("2024-05-20T00:00:00.000Z"),
      },
      organization: baseOrganization,
      payees: { [basePayee.id]: basePayee },
    });

  it("without frozenChange → DEAL_FROZEN, nothing written", async () => {
    const ctx = frozenContext();
    await expect(
      upsertAgreementLine(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        agreementId: ctx.defaults.agreementId,
        clientKey: "line-frozen-123456",
        payeeId: ctx.defaults.payeeId,
        percent: 40,
        floorCents: 0,
        capPercent: null,
        rounding: "FLOOR",
      }),
    ).rejects.toMatchObject({ code: "DEAL_FROZEN" });
    expect(ctx.mocks.agreements.replaceLines).not.toHaveBeenCalled();
    // The event row was locked before the terms row (deal-freeze.ts order).
    expect(ctx.mocks.events.lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "share" });
  });
});
