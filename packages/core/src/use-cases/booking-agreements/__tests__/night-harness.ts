import { vi } from "vitest";

import type { AgreementRecord, UpdateAgreementStatusInput } from "@th/ports/repos/agreements";

import { makeFakeIdempotency } from "../../booking-requests/__tests__/helpers";
import {
  ACT_A_ID,
  ASSIGNEE_ID,
  DATE,
  NOW,
  ORG_ID,
  REQUEST_A,
  STAFF_ID,
  buildHoldTestContext,
} from "../../booking-holds/__tests__/hold-test-context";
import { buildAgreementRecord } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared harness for the booking-the-night agreement suites (agree & book,
// the send's N6 check, "Send terms"): the hold harness (an org-owned venue,
// one calendar with a 20:00 default, three acts each with a request) plus
// request A ACCEPTED with PROPOSED terms for the night of DATE, the
// agreement CAS the transitions need, and the venue org's admins for pings.
// ─────────────────────────────────────────────────────────────────────────────

export const A_TERMS = "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a";
export const B_TERMS = "5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b";
export const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
export const B_EVENT_ID = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
/** 20:00 CDT on DATE — the night the terms name. */
export const NIGHT_AT = new Date("2026-06-21T01:00:00.000Z");

export function terms(id: string, act: string, over: Partial<AgreementRecord> = {}): AgreementRecord {
  return buildAgreementRecord({
    id,
    status: "PROPOSED",
    proposerType: "human",
    proposerId: act,
    counterpartyType: "organization",
    counterpartyId: ORG_ID,
    placeId: null,
    title: "Friday at the venue",
    proposedDate: NIGHT_AT,
    proposedAt: NOW,
    sentForReviewByHumanId: STAFF_ID,
    ...over,
  });
}

export function buildNightHarness() {
  const ctx = buildHoldTestContext();
  const agreements = ctx.agreements as unknown as Map<string, AgreementRecord>;
  agreements.set(A_TERMS, terms(A_TERMS, ACT_A_ID));
  ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, status: "ACCEPTED", agreementId: A_TERMS, preferredDates: [DATE] });

  // The CAS the agreement transitions need (the hold harness only knew the
  // header write): status-guarded, conflict on a loser, like the adapter.
  const casLosses = { next: 0 };
  Object.assign(ctx.repos.agreements, {
    updateStatus: vi.fn(async (input: UpdateAgreementStatusInput) => {
      const current = agreements.get(input.id);
      if (casLosses.next > 0 || !current || !input.expectedFrom.includes(current.status)) {
        if (casLosses.next > 0) casLosses.next -= 1;
        throw { code: "conflict", message: "agreement_status_changed" } as const;
      }
      const next: AgreementRecord = {
        ...current,
        status: input.status,
        ...(input.acceptedAt !== undefined ? { acceptedAt: input.acceptedAt } : {}),
        ...(input.proposedAt !== undefined ? { proposedAt: input.proposedAt } : {}),
        ...(input.sentForReviewByHumanId !== undefined
          ? { sentForReviewByHumanId: input.sentForReviewByHumanId }
          : {}),
      };
      agreements.set(next.id, next);
      return next;
    }),
  });
  // The venue party's in-app ping reads the org's admins (outside the tx).
  Object.assign(ctx.repos, {
    organizations: {
      listMembers: vi.fn(async () => ({
        items: [
          { humanId: STAFF_ID, role: "ADMIN" },
          { humanId: ASSIGNEE_ID, role: "OWNER" },
        ],
        total: 2,
      })),
    },
  });

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  const deps = {
    repos: ctx.repos,
    clock: ctx.deps.clock,
    idempotency: makeFakeIdempotency(),
    authz: { canManagePlace: vi.fn(async () => ({ allowed: true })) },
    notify: vi.fn(async () => ({ notificationId: null })) as never,
    logger: logger as never,
    reportError: vi.fn(),
  };
  return { ...ctx, agreements, deps, logger, casLosses };
}

export type NightHarness = ReturnType<typeof buildNightHarness>;

