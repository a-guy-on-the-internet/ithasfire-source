import { vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { createFakeSavedSnippets } from "@th/test-utils/fakes/saved-snippets";

import { createFakePlaceBookingGrantsRepo } from "../../booking-holds/__tests__/fakes";
import { buildPlaceRecord } from "../../booking-requests/__tests__/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Harness for the saved-snippets suites (core + the tRPC router): an
// ORG-OWNED place with an EDITOR, a VIEWER and an outsider; a grantee with no
// grant until a suite seeds one; the real-semantics saved-snippets fake; and
// a tx that marks when it opened and committed, so "inside the transaction"
// is assertable (see memory: fake repos with no non-tx surface).
// ─────────────────────────────────────────────────────────────────────────────

export const EDITOR_ID = "5e5e5e5e-0000-4000-8000-000000000001";
export const VIEWER_ID = "5e5e5e5e-0000-4000-8000-000000000002";
export const OUTSIDER_ID = "5e5e5e5e-0000-4000-8000-000000000003";
export const GRANTEE_ID = "5e5e5e5e-0000-4000-8000-000000000004";
export const HUMAN_OWNER_ID = "5e5e5e5e-0000-4000-8000-000000000005";
export const ORG_ID = "5e5e5e5e-0000-4000-8000-0000000000a1";
export const OTHER_ORG_ID = "5e5e5e5e-0000-4000-8000-0000000000a2";
export const PLACE_ID = "5e5e5e5e-0000-4000-8000-0000000000f1";
export const MISSING_PLACE_ID = "5e5e5e5e-0000-4000-8000-0000000000f9";
export const NOW = new Date("2026-10-02T12:00:00.000Z");

export function buildSavedSnippetsTestContext(
  options: {
    place?: Partial<PlaceRecord>;
    memberships?: OrgMembership[];
    /** Person delegations (the booker gate reads them, FR-002). */
    delegations?: { principalId: string; delegateId: string; role: OrgMembership["role"] }[];
    /** Stored `Human.locale` per human id (absent → null). */
    humanLocales?: Record<string, string | null>;
  } = {},
) {
  const place = buildPlaceRecord({
    id: PLACE_ID,
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    ...options.place,
  });
  const memberships: OrgMembership[] = options.memberships ?? [
    { orgId: ORG_ID, humanId: EDITOR_ID, role: "EDITOR" },
    { orgId: ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
  ];
  const humanLocales = options.humanLocales ?? {};

  const savedSnippets = createFakeSavedSnippets({ now: () => NOW });
  const placeBookingGrants = createFakePlaceBookingGrantsRepo();
  const authz = {
    getOrgMemberships: vi.fn(async (input: { orgIds: string[]; humanId: string }) =>
      memberships.filter(
        (m) => m.humanId === input.humanId && input.orgIds.includes(m.orgId),
      ),
    ),
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) =>
        memberships.find(
          (m) => m.humanId === input.humanId && m.orgId === input.orgId,
        ) ?? null,
    ),
    // The booker gate's read (holds-without-a-request FR-002).
    listOrgMembershipsByHumanId: vi.fn(
      async (input: { humanId: string; roles?: string[] }) =>
        memberships.filter(
          (m) =>
            m.humanId === input.humanId &&
            (!input.roles || input.roles.includes(m.role)),
        ),
    ),
  };
  const delegations = options.delegations ?? [];
  const humanDelegates = {
    // The booker gate's reverse read (place-access `resolveBookerParties`).
    listPrincipalsForDelegate: vi.fn(
      async (input: {
        delegateId: string;
        roles: readonly string[];
        principalIds?: readonly string[];
      }) =>
        delegations
          .filter(
            (d) =>
              d.delegateId === input.delegateId &&
              input.roles.includes(d.role) &&
              (!input.principalIds || input.principalIds.includes(d.principalId)),
          )
          .map((d) => d.principalId)
          .sort(),
    ),
    getDelegation: vi.fn(
      async (input: { principalId: string; delegateId: string }) => {
        const row = delegations.find(
          (d) =>
            d.principalId === input.principalId &&
            d.delegateId === input.delegateId,
        );
        return row
          ? { id: `${row.principalId}:${row.delegateId}`, ...row, createdAt: NOW }
          : null;
      },
    ),
  };
  const places = {
    getById: vi.fn(async (id: string) => (id === place.id ? place : null)),
  };
  const humans = {
    getById: vi.fn(async (id: string) => ({
      id,
      locale: humanLocales[id] ?? null,
    })),
  };
  const audit = { log: vi.fn(async () => {}) };

  const bag = {
    savedSnippets,
    placeBookingGrants,
    humanDelegates,
    authz,
    places,
    humans,
    audit,
  };
  const txOpened = vi.fn();
  const txCommitted = vi.fn();
  const tx = vi.fn(async <R>(fn: (t: unknown) => Promise<R>): Promise<R> => {
    txOpened();
    const result = await fn(bag);
    txCommitted();
    return result;
  });
  // Every repo on BOTH surfaces, like the real adapter's `{ ...base, tx }`.
  const repos = { ...bag, tx } as unknown as Repos;
  const logger = createTestLogger();
  const reportError = vi.fn();

  return {
    deps: { repos, clock: { now: () => NOW }, logger, reportError },
    repos,
    place,
    savedSnippets,
    placeBookingGrants,
    humans,
    audit,
    tx,
    txOpened,
    txCommitted,
    logger,
    reportError,
  };
}
