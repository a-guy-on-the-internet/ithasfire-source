import { vi } from "vitest";

import type {
  AgreementRecord,
  SetAgreementDraftEventInput,
  UpdateAgreementHeaderInput,
  UpdateAgreementStatusInput,
} from "@th/ports/repos/agreements";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type {
  PayoutTermsLineInput,
  PayoutTermsLineRecord,
} from "@th/ports/repos/payout-terms";
import type { Repos } from "@th/ports/repos";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import {
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  makeFakeIdempotency,
  withTx,
} from "../../booking-requests/__tests__/helpers";
import type { ReporterPort } from "@th/ports/reporter";

import type { RespondToBookingAgreementDeps } from "../respond-to-booking-agreement";
import type { BookingAgreementTransitionDeps } from "../send-booking-agreement-for-review";
import type { NotifyFn } from "../_shared/notify-party";

export { makeFakeIdempotency, withTx };

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Proposer side — performer human. */
export const PERFORMER_ID = "11111111-1111-4111-8111-111111111111";
/** Counterparty side — venue org + its members. */
export const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222222";
export const VENUE_ADMIN_ID = "23232323-2323-4323-8323-232323232323";
export const VENUE_VIEWER_ID = "24242424-2424-4424-8424-242424242424";
/** Not a party to anything. */
export const OUTSIDER_ID = "99999999-9999-4999-8999-999999999999";

export const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
export const TERMS_ID = "66666666-6666-4666-8666-666666666666";
export const PLACE_ID = "33333333-3333-4333-8333-333333333333";
export const EVENT_ID = "44444444-4444-4444-8444-444444444444";

export const THIRD_PARTY_HUMAN_ID = "77777777-7777-4777-8777-777777777777";
export const PERFORMER_PAYEE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const THIRD_PARTY_PAYEE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const VENUE_PAYEE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const LINE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export const NOW = new Date("2026-06-10T12:00:00.000Z");

export const LINKED_REQUEST_ID = "44444444-4444-4444-8444-111111111111";
/** Organizer org on the TO_PERFORMER shape — the fixture agreement's PROPOSER there. */
export const ORGANIZER_ORG_ID = "99999999-9999-4999-8999-999999999999";
export const ORGANIZER_ADMIN_ID = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";

/**
 * The booking request that `findByAgreementId` returns for the fixture
 * agreement, in either direction. The act is PERFORMER_ID (human) both ways —
 * the `performerOwner*` pair is what identifies the act, never the layout:
 *   - TO_VENUE     — performer pitched the venue; editor = VENUE_ORG_ID.
 *   - TO_PERFORMER — ORGANIZER_ORG_ID requested the act; editor = that org.
 */
export function buildLinkedBookingRequest(
  direction: "TO_VENUE" | "TO_PERFORMER" = "TO_VENUE",
): BookingRequestRecord {
  const common = {
    id: LINKED_REQUEST_ID,
    agreementId: AGREEMENT_ID,
    performerOwnerType: "human" as const,
    performerOwnerId: PERFORMER_ID,
    status: "ACCEPTED" as const,
  };
  return direction === "TO_VENUE"
    ? buildBookingRequestRecord({ ...common, placeId: PLACE_ID })
    : buildOrganizerBookingRequestRecord({
        ...common,
        organizerOrgId: ORGANIZER_ORG_ID,
      });
}

/** The fixture agreement as the TO_PERFORMER mint lays it out (mirrored). */
export function buildOrganizerAgreementRecord(
  overrides: Partial<AgreementRecord> = {},
): AgreementRecord {
  return buildAgreementRecord({
    proposerType: "organization",
    proposerId: ORGANIZER_ORG_ID,
    counterpartyType: "human",
    counterpartyId: PERFORMER_ID,
    placeId: null,
    ...overrides,
  });
}

export function buildAgreementRecord(
  overrides: Partial<AgreementRecord> = {},
): AgreementRecord {
  return {
    id: AGREEMENT_ID,
    type: "PERFORMANCE",
    status: "DRAFT",
    proposerType: "human",
    proposerId: PERFORMER_ID,
    counterpartyType: "organization",
    counterpartyId: VENUE_ORG_ID,
    placeId: PLACE_ID,
    eventId: null,
    draftEventId: null,
    payoutTermsId: TERMS_ID,
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
    ...overrides,
  } satisfies AgreementRecord;
}

export function buildLineRecord(
  overrides: Partial<PayoutTermsLineRecord> = {},
): PayoutTermsLineRecord {
  return {
    id: LINE_ID,
    payoutTermsId: TERMS_ID,
    payeeId: THIRD_PARTY_PAYEE_ID,
    ticketTypeId: null,
    percent: 10,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    rounding: "FLOOR",
    requiresConfirmation: true,
    confirmationStatus: "PENDING",
    confirmedAt: null,
    counterPercentBps: null,
    counterNote: null,
    ...overrides,
  } satisfies PayoutTermsLineRecord;
}

export function buildPayeeRecord(
  overrides: Partial<PayeeRecord> = {},
): PayeeRecord {
  return {
    id: THIRD_PARTY_PAYEE_ID,
    subjectType: "HUMAN",
    subjectId: THIRD_PARTY_HUMAN_ID,
    stripeAccountId: "acct_test",
    status: "ACTIVE",
    payoutsEnabled: true,
    chargesEnabled: true,
    defaultCurrency: "usd",
    resaleNegativeBalanceCents: 0,
    resaleNegativeBalanceOpenedAt: null,
    resaleNegativeBalanceAgingStartsAt: null,
    resalePayoutBlockReason: null,
    resalePayoutBlockedAt: null,
    ...overrides,
  } satisfies PayeeRecord;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS_CONFLICT = {
  code: "conflict",
  message: "agreement_status_changed",
} as const;

export type AgreementsRepoFakeOptions = {
  /** Force the write-time CAS to lose (simulates a concurrent transition). */
  updateConflict?: boolean;
  getByEventId?: AgreementRecord | null;
};

/**
 * What `bookingRequests.findByAgreementId` answers. `undefined` (the default)
 * = an agreement minted outside the inbox — no request, no act, either party
 * edits. Pass {@link buildLinkedBookingRequest} to make PERFORMER_ID the act.
 */
export type LinkedRequestOption = {
  bookingRequest?: BookingRequestRecord | null;
};

/** `bookingRequests` fake for the terms-editor gate (see {@link LinkedRequestOption}). */
export function makeBookingRequestsFake(options: LinkedRequestOption = {}) {
  return {
    findByAgreementId: vi.fn(async () => options.bookingRequest ?? null),
  };
}

/**
 * Stateful AgreementsRepo fake mirroring the adapter contract: header/status
 * writes are status-guarded CAS ops that throw `agreement_status_changed`
 * when the row already left `expectedFrom` (and refuse to stamp an eventId
 * over an existing one).
 */
export function makeAgreementsRepoFake(
  initial: AgreementRecord | null,
  options: AgreementsRepoFakeOptions = {},
) {
  let current = initial;
  const getById = vi.fn(async (_id?: string): Promise<AgreementRecord | null> => current);

  const repo = {
    getById,
    getByEventId: vi.fn(async () => options.getByEventId ?? null),
    create: vi.fn(),
    updateHeader: vi.fn(async (input: UpdateAgreementHeaderInput) => {
      if (
        options.updateConflict ||
        !current ||
        !input.expectedFrom.includes(current.status)
      ) {
        throw STATUS_CONFLICT;
      }
      current = {
        ...current,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.proposedDate !== undefined
          ? { proposedDate: input.proposedDate }
          : {}),
        ...(input.proposedEndDate !== undefined
          ? { proposedEndDate: input.proposedEndDate }
          : {}),
        ...(input.guaranteeCents !== undefined
          ? { guaranteeCents: input.guaranteeCents }
          : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt }
          : {}),
        updatedAt: NOW,
      };
      return current;
    }),
    updateStatus: vi.fn(async (input: UpdateAgreementStatusInput) => {
      if (
        options.updateConflict ||
        !current ||
        !input.expectedFrom.includes(current.status) ||
        ((input.eventId !== undefined || input.expectEventIdNull) &&
          current.eventId !== null)
      ) {
        throw STATUS_CONFLICT;
      }
      // booking-the-night P2d-2 (carry b): the anchor fence. The row's anchor
      // is what a read of it says now — `getById`, which a test may stage to
      // land a concurrent mint's `setDraftEvent`.
      if (input.expectedDraftEventId !== undefined) {
        const seen = (await getById(input.id)) ?? current;
        if ((seen.draftEventId ?? null) !== input.expectedDraftEventId) {
          throw STATUS_CONFLICT;
        }
      }
      current = {
        ...current,
        status: input.status,
        ...(input.proposedAt !== undefined
          ? { proposedAt: input.proposedAt }
          : {}),
        ...(input.acceptedAt !== undefined
          ? { acceptedAt: input.acceptedAt }
          : {}),
        ...(input.declinedAt !== undefined
          ? { declinedAt: input.declinedAt }
          : {}),
        ...(input.declinedReason !== undefined
          ? { declinedReason: input.declinedReason }
          : {}),
        ...(input.fulfilledAt !== undefined
          ? { fulfilledAt: input.fulfilledAt }
          : {}),
        ...(input.sentForReviewByHumanId !== undefined
          ? { sentForReviewByHumanId: input.sentForReviewByHumanId }
          : {}),
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
        ...(input.clearDraftEventId ? { draftEventId: null } : {}),
        updatedAt: NOW,
      };
      return current;
    }),
    listByParty: vi.fn(async () => [] as AgreementRecord[]),
    setDraftEvent: vi.fn(async (input: SetAgreementDraftEventInput) => {
      // Mirrors the adapter CAS: status ∈ expectedFrom AND draftEventId IS
      // NULL (or = replacingDraftEventId) AND eventId IS NULL, else the
      // shared conflict shape.
      if (
        options.updateConflict ||
        !current ||
        !input.expectedFrom.includes(current.status) ||
        current.draftEventId !== (input.replacingDraftEventId ?? null) ||
        current.eventId !== null
      ) {
        throw STATUS_CONFLICT;
      }
      current = {
        ...current,
        draftEventId: input.draftEventId,
        updatedAt: NOW,
      };
      return current;
    }),
  };

  return {
    repo,
    record: () => current,
    /** Out-of-band mutation (e.g. simulate the FK SetNull after an event deletion). */
    set: (next: AgreementRecord | null) => {
      current = next;
    },
  };
}

/**
 * Stateful PayoutTerms lines fake — only the surface the editor touches
 * (`listLines` + delete-and-recreate `replaceLines`).
 */
export function makeLinesRepoFake(initial: PayoutTermsLineRecord[]) {
  let lines = initial;

  const repo = {
    listLines: vi.fn(async () => lines),
    replaceLines: vi.fn(
      async (payoutTermsId: string, inputs: PayoutTermsLineInput[]) => {
        lines = inputs.map((input, index) => ({
          id: input.id ?? `generated-${index}`,
          payoutTermsId,
          payeeId: input.payeeId,
          ticketTypeId: input.ticketTypeId ?? null,
          percent: input.percent,
          floorCents: input.floorCents,
          capPercent: input.capPercent ?? null,
          priority: input.priority,
          rounding: input.rounding,
          requiresConfirmation: input.requiresConfirmation ?? false,
          confirmationStatus: input.confirmationStatus ?? null,
          confirmedAt: input.confirmedAt ?? null,
          counterPercentBps: input.counterPercentBps ?? null,
          counterNote: input.counterNote ?? null,
        }));
      },
    ),
  };

  return { repo, lines: () => lines };
}

/** Membership-map-backed AuthZ fake. Key: `${orgId}:${humanId}` → role. */
export function makeAuthzFake(
  memberships: Record<string, OrgRole> = {
    [`${VENUE_ORG_ID}:${VENUE_ADMIN_ID}`]: "ADMIN",
    [`${VENUE_ORG_ID}:${VENUE_VIEWER_ID}`]: "VIEWER",
    [`${ORGANIZER_ORG_ID}:${ORGANIZER_ADMIN_ID}`]: "ADMIN",
  },
) {
  return {
    getOrgMembership: vi.fn(
      async ({
        orgId,
        humanId,
      }: {
        orgId: string;
        humanId: string;
      }): Promise<OrgMembership | null> => {
        const role = memberships[`${orgId}:${humanId}`];
        return role ? { orgId, humanId, role } : null;
      },
    ),
    listOrgMembershipsByHumanId: vi.fn(
      async ({ humanId }: { humanId: string }): Promise<OrgMembership[]> =>
        Object.entries(memberships)
          .filter(([key]) => key.endsWith(`:${humanId}`))
          .map(([key, role]) => ({
            orgId: key.split(":")[0]!,
            humanId,
            role,
          })),
    ),
  };
}

export function makeAuditFake() {
  return { log: vi.fn(async () => undefined) };
}

/**
 * Deps bag for the status-transition use cases (send-for-review / pull-back /
 * respond). Lives here (not in a .test.ts) so multiple suites can share it
 * without re-running each other.
 */
export function buildTransitionDeps(
  agreement: AgreementRecord | null,
  options: AgreementsRepoFakeOptions &
    LinkedRequestOption & { notify?: NotifyFn; reportError?: ReporterPort } = {},
) {
  const agreements = makeAgreementsRepoFake(agreement, options);
  const audit = makeAuditFake();
  const organizations = {
    listMembers: vi.fn(async () => ({
      items: [
        {
          humanId: VENUE_ADMIN_ID,
          name: "Venue Admin",
          email: null,
          role: "ADMIN" as const,
          joinedAt: NOW,
        },
        {
          humanId: VENUE_VIEWER_ID,
          name: "Venue Viewer",
          email: null,
          role: "VIEWER" as const,
          joinedAt: NOW,
        },
      ],
      total: 2,
    })),
  };

  // `Repos` (not the transition Pick) so the same bag also fits
  // `RespondToBookingAgreementDeps`; the agree-and-book path's repos
  // (holds, places, calendars) are not wired here — its suite builds its own
  // harness (agree-and-book.test.ts). These fixtures never reach it: their
  // agreements carry no `proposedDate`, which keeps today's accept.
  const repos = withTx({
    agreements: agreements.repo,
    authz: makeAuthzFake(),
    audit,
    organizations,
    bookingRequests: makeBookingRequestsFake(options),
  }) as unknown as Repos;
  const deps = {
    repos,
    clock: makeClock(),
    idempotency: makeFakeIdempotency(),
    authz: { canManagePlace: vi.fn(async () => ({ allowed: true })) },
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.reportError ? { reportError: options.reportError } : {}),
  };
  // Both deps shapes, checked here rather than at every call site.
  deps satisfies BookingAgreementTransitionDeps;
  deps satisfies RespondToBookingAgreementDeps;

  return { deps, agreements, audit, organizations };
}

export function makeClock() {
  return { now: () => NOW };
}

/** Cast a partial fake bag to the repos slice a deps type expects. */
export function asRepos<T>(mocks: Record<string, unknown>): T {
  return mocks as unknown as T;
}

export type AnyRepos = Repos;
