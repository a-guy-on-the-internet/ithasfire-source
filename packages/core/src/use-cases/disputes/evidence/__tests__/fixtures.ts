import { vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import type { AuthZPort } from "@th/ports/authz";
import type { DisputeRecord } from "@th/ports/repos/disputes";
import type { EarlyFraudWarningRecord } from "@th/ports/repos/early-fraud-warnings";
import type {
  DisputeEvidenceRecord,
  UpdateDisputeEvidenceInput,
  UpsertDisputeEvidenceDraftInput,
} from "@th/ports/repos/dispute-evidence";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord, OrderTaxLineRecord } from "@th/ports/repos/orders";
import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";
import type { TicketRecord, TicketScanRecord } from "@th/ports/repos/tickets";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { HumanRecord, HumanWithIdentity } from "@th/types/repos/humans";
import type { OrganizationRecord } from "@th/types/repos/organizations";
import type { PlaceRecord } from "@th/types/repos/places";

export const NOW = new Date("2026-05-15T12:00:00.000Z");
export const EVENT_STARTS_AT = new Date("2026-06-01T01:00:00.000Z"); // 8pm CDT May 31
export const ORDER_ID = "11111111-1111-4111-8111-111111111111";
export const EVENT_ID = "22222222-2222-4222-8222-222222222222";
export const BUYER_ID = "33333333-3333-4333-8333-333333333333";
export const ORG_ID = "44444444-4444-4444-8444-444444444444";
export const PLACE_ID = "55555555-5555-4555-8555-555555555555";
export const DISPUTE_ID = "dispute_1";
export const STAFF_ID = "staff_admin";

export function buildDispute(
  overrides: Partial<DisputeRecord> = {},
): DisputeRecord {
  return {
    id: DISPUTE_ID,
    stripeDisputeId: "dp_123",
    stripeChargeId: "ch_123",
    paymentIntentId: "pi_123",
    orderId: ORDER_ID,
    ownerSubjectType: "ORGANIZATION",
    ownerSubjectId: ORG_ID,
    ownerOrgId: ORG_ID,
    ownerHumanId: null,
    amountCents: 5_000,
    feeCents: 0,
    feeBorneBy: null,
    currency: "usd",
    reason: "fraudulent",
    status: "OPEN",
    triageReason: null,
    linkedAt: NOW,
    evidenceDueBy: new Date("2026-05-25T00:00:00.000Z"),
    evidenceHasEvidence: null,
    evidencePastDue: null,
    evidenceSubmissionCount: null,
    evidenceSubmittedAt: null,
    fundsWithdrawnAt: null,
    closedAt: null,
    outcome: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    kind: "TICKETING",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 5_000,
    feesPlatformCents: 150,
    taxAmountCents: 400,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    billingDescriptor: "IHF* ROCK SHOW",
    refundPolicyAckAt: new Date("2026-05-01T15:00:00.000Z"),
    refundPolicyAckIp: "203.0.113.7",
    refundPolicyVersion: "2026-04",
    refundPolicyText: "All sales are final. No refunds except event cancellation.",
    termsVersion: "2026-04",
    termsAcceptedAt: new Date("2026-05-01T15:00:00.000Z"),
    disputedAt: NOW,
    disputeStatus: "OPEN",
    checkoutIp: "203.0.113.7",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2026-05-01T15:00:00.000Z"),
    paymentMethodType: "card",
    paymentCardChecks: {
      addressLine1Check: "pass",
      addressPostalCodeCheck: "pass",
      cvcCheck: "pass",
    },
    paymentChannel: "WEB",
    paidOutAt: null,
    parentOrderId: null,
    items: [
      {
        id: "item_1",
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt_ga",
        qty: 2,
        unitPriceCents: 2_300,
        amountCents: 4_600,
        meta: null,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        resaleListingId: null,
        resaleFaceValueCents: null,
        resaleProcessingPassThroughCents: 0,
        resaleProcessingFeeConfigRef: null,
        resaleSaleCutoffAt: null,
        resalePayoutReleaseAt: null,
        resalePayoutStatus: null,
        resalePayoutHeldAt: null,
        resalePayoutHoldReason: null,
        resalePayoutNoticeSentAt: null,
        resalePayoutReminderSentAt: null,
        resalePayoutFinalNoticeSentAt: null,
        status: "active",
      } as OrderRecord["items"][number],
    ],
    billingAddressLine1: "100 Main St",
    billingAddressLine2: null,
    billingCity: "Nashville",
    billingState: "TN",
    billingPostalCode: "37201",
    billingCountry: "US",
    stripeTaxCalculationId: null,
    taxSitusCountry: "US",
    taxSitusState: "TN",
    taxSitusPostal: "37201",
    taxRateSource: "ziptax",
    ...overrides,
  };
}

export function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Rock Show",
    timezone: "America/Chicago",
    startsAt: EVENT_STARTS_AT,
    endsAt: null,
    placeId: PLACE_ID,
    savedLocationId: null,
    categoryId: null,
    categorySeoType: null,
    // EXPLICITLY EXACT: the venue line is gated like a ticket holder's
    // address and fails closed on a missing mode.
    locationMode: "EXACT",
    locationRadiusMeters: null,
    addressText: null,
    lat: null,
    lng: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    ...overrides,
  } as EventRecord;
}

export function buildTickets(): TicketRecord[] {
  return [
    {
      id: "ticket_1",
      eventId: EVENT_ID,
      ticketTypeId: "tt_ga",
      ownerHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: "item_1",
      seatId: null,
      code: "TKT-ABCD-1234",
      status: "USED",
      issuedAt: new Date("2026-05-01T15:00:05.000Z"),
      scannedAt: new Date("2026-06-01T00:45:00.000Z"),
    } as TicketRecord,
    {
      id: "ticket_2",
      eventId: EVENT_ID,
      ticketTypeId: "tt_ga",
      ownerHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: null,
      seatId: null,
      code: "TKT-EFGH-5678",
      status: "VALID",
      issuedAt: new Date("2026-05-01T15:00:05.000Z"),
      scannedAt: null,
    } as TicketRecord,
  ];
}

export function buildScans(): TicketScanRecord[] {
  return [
    {
      id: "scan_1",
      ticketId: "ticket_1",
      eventId: EVENT_ID,
      actorHumanId: "scanner_1",
      actorName: "Door Staff",
      outcome: "ACCEPTED",
      message: null,
      scannedAt: new Date("2026-06-01T00:45:00.000Z"),
      locationLat: null,
      locationLng: null,
    },
  ];
}

export type FakeDeskRepos = {
  repos: Repos;
  disputes: Map<string, DisputeRecord>;
  evidence: Map<string, DisputeEvidenceRecord>;
  audit: ReturnType<typeof vi.fn>;
  updateEvidenceDetails: ReturnType<typeof vi.fn>;
  upsertDraft: ReturnType<typeof vi.fn>;
  /** Names of the repo slices touched INSIDE `repos.tx` callbacks. */
  txTouched: Set<string>;
  idempotency: ReturnType<typeof createFakeIdempotencyPort>;
};

/**
 * In-memory repos for the evidence slice. Only the methods the use cases
 * touch are implemented; anything else throws loudly via the Proxy so a
 * new dependency shows up as a test failure, not `undefined is not a
 * function` three frames deep.
 */
export function makeFakeRepos(
  options: {
    dispute?: DisputeRecord | null;
    order?: OrderRecord | null;
    event?: EventRecord | null;
    buyer?: HumanWithIdentity | null;
    org?: OrganizationRecord | null;
    place?: PlaceRecord | null;
    tickets?: TicketRecord[];
    scans?: TicketScanRecord[];
    ledgerEntries?: PayeeLedgerEntryRecord[];
    /** Persisted `OrderTaxLine` rows for the order. Default: none (legacy order). */
    taxLines?: OrderTaxLineRecord[];
    evidence?: DisputeEvidenceRecord | null;
    /** Newest EFW on the order (desk detail + row). Default: none. */
    earlyFraudWarning?: EarlyFraudWarningRecord | null;
    failingSources?: Set<"venue" | "scanLog" | "tickets">;
    /** Runs between a fake `update` read and its write — race hook. */
    onEvidenceUpdate?: (input: UpdateDisputeEvidenceInput) => void;
  } = {},
): FakeDeskRepos {
  const idempotency = createFakeIdempotencyPort();
  const txTouched = new Set<string>();
  const disputes = new Map<string, DisputeRecord>();
  const dispute =
    options.dispute === undefined ? buildDispute() : options.dispute;
  if (dispute) disputes.set(dispute.id, dispute);
  const order = options.order === undefined ? buildOrder() : options.order;
  const event = options.event === undefined ? buildEvent() : options.event;
  const buyer: HumanWithIdentity | null =
    options.buyer === undefined
      ? {
          human: { id: BUYER_ID, name: "Buyer Person" } as HumanRecord,
          identity: {
            authUserId: "auth_1",
            email: "buyer@example.com",
            emailVerified: true,
            phone: null,
            phoneVerified: false,
            username: null,
            displayUsername: null,
            image: null,
          },
        }
      : options.buyer;
  const org: OrganizationRecord | null =
    options.org === undefined
      ? ({ id: ORG_ID, name: "Drkmttr Collective" } as OrganizationRecord)
      : options.org;
  const place: PlaceRecord | null =
    options.place === undefined
      ? ({
          id: PLACE_ID,
          name: "Drkmttr",
          // A venue that publishes its address (explicit: the floor fails
          // closed on a missing mode).
          locationMode: "EXACT",
          locationRadiusMeters: null,
          formattedAddress: "1111 Test Ave, Nashville, TN 37201",
          addressLine1: null,
          addressLine2: null,
          city: null,
          region: null,
          postalCode: null,
          countryCode: null,
          timezone: "America/Chicago",
        } as PlaceRecord)
      : options.place;
  const tickets = options.tickets ?? buildTickets();
  const scans = options.scans ?? buildScans();
  const ledgerEntries = options.ledgerEntries ?? [];
  const evidence = new Map<string, DisputeEvidenceRecord>();
  if (options.evidence) evidence.set(options.evidence.disputeId, options.evidence);
  const failing = options.failingSources ?? new Set();
  let nextEvidenceId = 1;

  const audit = vi.fn(async () => undefined);
  const updateEvidenceDetails = vi.fn(async (input) => {
    const row = [...disputes.values()].find(
      (d) => d.stripeDisputeId === input.stripeDisputeId,
    );
    if (!row) return null;
    const next: DisputeRecord = {
      ...row,
      evidenceHasEvidence: input.evidenceHasEvidence,
      evidencePastDue: input.evidencePastDue,
      evidenceSubmissionCount: input.evidenceSubmissionCount,
      ...(input.evidenceDueBy !== undefined
        ? { evidenceDueBy: input.evidenceDueBy }
        : {}),
      ...(input.evidenceSubmittedAt !== undefined
        ? { evidenceSubmittedAt: input.evidenceSubmittedAt }
        : {}),
    };
    disputes.set(row.id, next);
    return next;
  });
  const upsertDraft = vi.fn(async (input: UpsertDisputeEvidenceDraftInput) => {
    const existing = evidence.get(input.disputeId);
    const record: DisputeEvidenceRecord = {
      id: existing?.id ?? `evidence_${nextEvidenceId++}`,
      disputeId: input.disputeId,
      status: "DRAFT",
      fields: { ...input.fields },
      sources: { ...input.sources },
      assembledAt: input.assembledAt,
      assembledVersion: (existing?.assembledVersion ?? 0) + 1,
      reviewedByHumanId: null,
      reviewedAt: null,
      submittedByHumanId: null,
      submittedAt: null,
      submitError: null,
      processorSubmissionCount: null,
      reconciledFromProcessor: null,
      createdAt: existing?.createdAt ?? input.assembledAt,
      updatedAt: input.assembledAt,
    };
    evidence.set(record.disputeId, record);
    return record;
  });

  const partial = {
    disputes: {
      getById: vi.fn(async (id: string) => disputes.get(id) ?? null),
      findByStripeDisputeId: vi.fn(
        async (stripeDisputeId: string) =>
          [...disputes.values()].find(
            (d) => d.stripeDisputeId === stripeDisputeId,
          ) ?? null,
      ),
      updateEvidenceDetails,
    },
    disputeEvidence: {
      getByDisputeId: vi.fn(
        async (disputeId: string) => evidence.get(disputeId) ?? null,
      ),
      upsertDraft,
      update: vi.fn(async (input: UpdateDisputeEvidenceInput) => {
        options.onEvidenceUpdate?.(input);
        const existing = evidence.get(input.disputeId);
        if (!existing) {
          throw Object.assign(new Error("not found"), {
            code: "DISPUTE_EVIDENCE_NOT_FOUND",
          });
        }
        // Compare-and-set, mirroring the adapter's updateMany where-clause.
        if (
          (input.expect?.status !== undefined &&
            existing.status !== input.expect.status) ||
          (input.expect?.assembledVersion !== undefined &&
            existing.assembledVersion !== input.expect.assembledVersion)
        ) {
          throw Object.assign(new Error("cas miss"), {
            code: "DISPUTE_EVIDENCE_STATE_INVALID",
            meta: {
              expected: input.expect,
              actual: {
                status: existing.status,
                assembledVersion: existing.assembledVersion,
              },
            },
          });
        }
        const next: DisputeEvidenceRecord = {
          ...existing,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.fields !== undefined ? { fields: { ...input.fields } } : {}),
          ...(input.sources !== undefined ? { sources: { ...input.sources } } : {}),
          ...(input.reconciledFromProcessor !== undefined
            ? { reconciledFromProcessor: input.reconciledFromProcessor }
            : {}),
          ...(input.reviewedByHumanId !== undefined
            ? { reviewedByHumanId: input.reviewedByHumanId }
            : {}),
          ...(input.reviewedAt !== undefined
            ? { reviewedAt: input.reviewedAt }
            : {}),
          ...(input.submittedByHumanId !== undefined
            ? { submittedByHumanId: input.submittedByHumanId }
            : {}),
          ...(input.submittedAt !== undefined
            ? { submittedAt: input.submittedAt }
            : {}),
          ...(input.submitError !== undefined
            ? { submitError: input.submitError }
            : {}),
          ...(input.processorSubmissionCount !== undefined
            ? { processorSubmissionCount: input.processorSubmissionCount }
            : {}),
          updatedAt: NOW,
        };
        evidence.set(next.disputeId, next);
        return next;
      }),
    },
    orders: {
      getById: vi.fn(async (id: string) =>
        order && order.id === id ? order : null,
      ),
      listTaxLines: vi.fn(async () => options.taxLines ?? []),
    },
    events: {
      getById: vi.fn(async (id: string) =>
        event && event.id === id ? event : null,
      ),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) =>
        buyer && buyer.human.id === id ? buyer : null,
      ),
      getById: vi.fn(async (id: string) =>
        buyer && buyer.human.id === id ? buyer.human : null,
      ),
    },
    organizations: {
      getById: vi.fn(async (id: string) => (org && org.id === id ? org : null)),
    },
    places: {
      getById: vi.fn(async (id: string) => {
        if (failing.has("venue")) throw new Error("places down");
        return place && place.id === id ? place : null;
      }),
    },
    savedLocations: {
      getById: vi.fn(async () => null),
    },
    tickets: {
      listByOrderId: vi.fn(async (orderId: string) => {
        if (failing.has("tickets")) throw new Error("tickets down");
        return tickets.filter((t) => t.orderId === orderId);
      }),
      // Mirrors the adapter's active set (VALID | SCANNED | LISTED): the
      // venue address in the evidence goes only to a buyer still holding one.
      hasActiveTicketForEvent: vi.fn(async (eventId: string, humanId: string) => {
        if (failing.has("tickets")) throw new Error("tickets down");
        return tickets.some(
          (t) =>
            t.eventId === eventId &&
            t.ownerHumanId === humanId &&
            ["VALID", "SCANNED", "LISTED"].includes(t.status as string),
        );
      }),
      getTicketTypeById: vi.fn(async (id: string) =>
        id === "tt_ga" ? { id, name: "General Admission" } : null,
      ),
      listScansByTicketIds: vi.fn(async (ticketIds: string[]) => {
        if (failing.has("scanLog")) throw new Error("scans down");
        return scans.filter((s) => ticketIds.includes(s.ticketId));
      }),
    },
    payeeLedger: {
      listOrderEntries: vi.fn(async (orderId: string) =>
        ledgerEntries.filter((e) => e.orderId === orderId),
      ),
      listActiveHoldsByDispute: vi.fn(async (disputeId: string) =>
        ledgerEntries.filter(
          (e) => e.type === "DISPUTE_HOLD" && e.disputeId === disputeId,
        ),
      ),
      listDebitsForDispute: vi.fn(async (disputeId: string) =>
        ledgerEntries.filter(
          (e) => e.type === "DISPUTE_DEBIT" && e.disputeId === disputeId,
        ),
      ),
    },
    earlyFraudWarnings: {
      findLatestForOrder: vi.fn(async (orderId: string) =>
        options.earlyFraudWarning && options.earlyFraudWarning.orderId === orderId
          ? options.earlyFraudWarning
          : null,
      ),
      findActiveForOrder: vi.fn(async (orderId: string) =>
        options.earlyFraudWarning &&
        options.earlyFraudWarning.orderId === orderId &&
        options.earlyFraudWarning.resolvedAt === null
          ? options.earlyFraudWarning
          : null,
      ),
    },
    audit: { log: audit },
  };

  // Inside a tx callback every slice access is recorded so tests can assert
  // that reads stay OUT of the transaction; unknown slices throw loudly.
  const guarded = new Proxy(partial as unknown as TxRepos, {
    get(target, prop) {
      if (prop in target) {
        txTouched.add(String(prop));
        return (target as Record<PropertyKey, unknown>)[prop];
      }
      throw new Error(`fake repos: unexpected repo access "${String(prop)}"`);
    },
  });

  const repos = {
    ...partial,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(guarded),
  } as unknown as Repos;

  return {
    repos,
    disputes,
    evidence,
    audit,
    updateEvidenceDetails,
    upsertDraft,
    txTouched,
    idempotency,
  };
}

export function staffAuthz(allowed = true): Pick<AuthZPort, "hasStaffRole"> {
  return {
    hasStaffRole: vi.fn(async () => ({ allowed })),
  } as unknown as Pick<AuthZPort, "hasStaffRole">;
}

export function buildEvidence(
  overrides: Partial<DisputeEvidenceRecord> = {},
): DisputeEvidenceRecord {
  return {
    id: "evidence_1",
    disputeId: DISPUTE_ID,
    status: "DRAFT",
    fields: {
      productDescription: "2 tickets to Rock Show",
      customerName: "Buyer Person",
      uncategorizedText: "ORDER SUMMARY",
    },
    sources: {
      order: "found",
      buyer: "found",
      buyerEmail: "found",
      checkoutIp: "found",
      billingAddress: "found",
      event: "found",
      venue: "found",
      organizer: "found",
      refundPolicy: "found",
      termsAcceptance: "found",
      tickets: "found",
      scanLog: "found",
      refundHistory: "missing",
      cardChecks: "found",
      ticketEmail: "missing",
      statementDescriptor: "found",
      truncated: false,
    },
    assembledAt: NOW,
    assembledVersion: 1,
    reviewedByHumanId: null,
    reviewedAt: null,
    submittedByHumanId: null,
    submittedAt: null,
    submitError: null,
    processorSubmissionCount: null,
    reconciledFromProcessor: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export const clock = { now: () => NOW };

export function buildTaxLine(
  overrides: Partial<OrderTaxLineRecord> = {},
): OrderTaxLineRecord {
  return {
    id: "taxline_1",
    orderId: ORDER_ID,
    createdAt: NOW,
    code: "SALES",
    label: "Sales tax",
    jurisdiction: "US/MN",
    rateBps: 800,
    base: "TICKET_FACE",
    collector: "PLATFORM",
    taxableAmountCents: 5_000,
    amountCents: 400,
    ...overrides,
  };
}
