import { vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";
import type {
  EventRecord,
  WithdrawVenueConfirmationInput,
} from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import { LEGACY_AUDIT_ACTIONS } from "../../../lib/legacy-place-values";
import { buildStageEventRecord } from "../../booking-requests/__tests__/helpers";
import { createFakePlaceBookingGrantsRepo } from "../../booking-holds/__tests__/fakes";
import {
  ACT_A_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  FOREIGN_CALENDAR_ID,
  FOREIGN_PLACE_ID,
  NOW,
  ORG_ID,
  OTHER_CALENDAR_ID,
  OUTSIDER_ID,
  PLACE_ID,
  REQUEST_A,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "../../booking-holds/__tests__/hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// Harness for the booking grant lifecycle suites, on top of the hold
// harness (same place, calendars, request holds and line fakes):
//   - the place is owned by ORG_ID and by DIRECT_OWNER_ID directly;
//   - ORG_ID staff: OWNER_MEMBER (OWNER), ASSIGNEE_ID (ADMIN), STAFF_ID
//     (EDITOR), VIEWER_ID (VIEWER);
//   - the grantee org BOOKER_ORG: BOOKER_ADMIN, BOOKER_OWNER, BOOKER_EDITOR,
//     BOOKER_VIEWER; the grantee person PERSON_ID, whose ADMIN delegate is
//     DELEGATE_ID;
//   - public pages for each party, a PRIVATE person page, the place's page;
//   - a real-semantics grants fake (calendar-at-place check), an events fake
//     with the adapter's withdraw contract, and an audit fake whose
//     `listForEntity` reads back what `log` wrote;
//   - a tx that rolls back grant, hold and audit rows when it throws, and
//     `commitBeforeNextTx` for a racing writer that committed first.
// ─────────────────────────────────────────────────────────────────────────────

export {
  ACT_A_ID,
  ASSIGNEE_ID as ADMIN_MEMBER,
  CALENDAR_ID,
  DATE,
  FOREIGN_CALENDAR_ID,
  FOREIGN_PLACE_ID,
  NOW,
  ORG_ID,
  OTHER_CALENDAR_ID,
  OUTSIDER_ID as STRANGER_ID,
  PLACE_ID,
  REQUEST_A,
  STAFF_ID as EDITOR_MEMBER,
  VIEWER_ID as VIEWER_MEMBER,
};

export const OWNER_MEMBER = "15151515-1515-4151-8151-151515151515";
export const DIRECT_OWNER_ID = "16161616-1616-4161-8161-161616161616";
export const BOOKER_ORG = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
export const OTHER_ORG = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
export const BOOKER_ADMIN = "b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3";
export const BOOKER_OWNER = "b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4";
export const BOOKER_EDITOR = "b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5";
export const BOOKER_VIEWER = "b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b6b6";
export const PERSON_ID = "b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7";
export const DELEGATE_ID = "b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8";

export const BOOKER_ORG_PAGE = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
export const PERSON_PAGE = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
export const PRIVATE_PAGE = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
export const PLACE_PAGE = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
export const OWNING_ORG_PAGE = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
export const DIRECT_OWNER_PAGE = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5";
export const ADMIN_SELF_PAGE = "d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6";
export const OTHER_ORG_PAGE = "d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7";
/** An UNLISTED person page: reachable by link, not public (NFR-002). */
export const UNLISTED_PAGE = "d8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8";
export const UNLISTED_PERSON_ID = "b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9";
/** A PUBLIC person page whose owner is BANNED (`bans.findBannedOwners`). */
export const BANNED_PAGE = "d9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9";
export const BANNED_PERSON_ID = "babababa-baba-4bab-8bab-babababababa";
/** A PUBLIC org page whose every OWNER is banned. */
export const BANNED_ORG_PAGE = "dadadada-dada-4dad-8dad-dadadadadada";
export const BANNED_ORG = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";

export const EVENT_GRANT = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
export const EVENT_MANAGER = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
export const EVENT_OTHER_GRANT = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
export const EVENT_PAST = "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3";

const page = (
  id: string,
  ownerType: EntityPageRecord["ownerType"],
  ownerId: string,
  displayName: string,
  visibility: EntityPageRecord["visibility"] = "PUBLIC",
): EntityPageRecord => ({
  id,
  ownerType,
  ownerId,
  slug: displayName.toLowerCase().replace(/\s+/g, "-"),
  displayName,
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility,
  allowFollows: true,
  showFollowerCount: false,
  category: null,
  templateAppliedCategories: [],
  createdAt: NOW,
  updatedAt: NOW,
});

type AuditRow = {
  id: string;
  entity: string;
  entityId: string | null;
  action: string;
  data: unknown;
  at: Date;
};

export function buildGrantTestContext(
  options: {
    clock?: () => Date;
    place?: Partial<PlaceRecord>;
    /** Added to the default memberships below. */
    extraMemberships?: OrgMembership[];
    /** Added to the default delegation (DELEGATE_ID for PERSON_ID, ADMIN). */
    extraDelegations?: {
      principalId: string;
      delegateId: string;
      role: OrgMembership["role"];
    }[];
  } = {},
) {
  const memberships: OrgMembership[] = [
    { orgId: ORG_ID, humanId: OWNER_MEMBER, role: "OWNER" },
    { orgId: ORG_ID, humanId: ASSIGNEE_ID, role: "ADMIN" },
    { orgId: ORG_ID, humanId: STAFF_ID, role: "EDITOR" },
    { orgId: ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
    { orgId: BOOKER_ORG, humanId: BOOKER_ADMIN, role: "ADMIN" },
    { orgId: BOOKER_ORG, humanId: BOOKER_OWNER, role: "OWNER" },
    { orgId: BOOKER_ORG, humanId: BOOKER_EDITOR, role: "EDITOR" },
    { orgId: BOOKER_ORG, humanId: BOOKER_VIEWER, role: "VIEWER" },
    ...(options.extraMemberships ?? []),
  ];

  const pages = new Map<string, EntityPageRecord>(
    [
      page(BOOKER_ORG_PAGE, "ORGANIZATION", BOOKER_ORG, "Night Shift Promotions"),
      page(OTHER_ORG_PAGE, "ORGANIZATION", OTHER_ORG, "Other Promoters"),
      page(PERSON_PAGE, "HUMAN", PERSON_ID, "Dana Regular"),
      page(PRIVATE_PAGE, "HUMAN", OUTSIDER_ID, "Hidden Person", "PRIVATE"),
      page(PLACE_PAGE, "PLACE", PLACE_ID, "The Back Room"),
      page(OWNING_ORG_PAGE, "ORGANIZATION", ORG_ID, "Back Room LLC"),
      page(DIRECT_OWNER_PAGE, "HUMAN", DIRECT_OWNER_ID, "Owner Person"),
      page(ADMIN_SELF_PAGE, "HUMAN", ASSIGNEE_ID, "Admin Person"),
      page(UNLISTED_PAGE, "HUMAN", UNLISTED_PERSON_ID, "Unlisted Person", "UNLISTED"),
      page(BANNED_PAGE, "HUMAN", BANNED_PERSON_ID, "Banned Person"),
      page(BANNED_ORG_PAGE, "ORGANIZATION", BANNED_ORG, "Banned Org"),
    ].map((p) => [p.id, p]),
  );
  // Ban-that-sticks, as the adapter derives it: a BANNED human, an org whose
  // every OWNER is banned.
  const bannedHumans = new Set<string>([BANNED_PERSON_ID]);
  const bannedOrgs = new Set<string>([BANNED_ORG]);
  const bans = {
    findBannedOwners: vi.fn(async (input: { humanIds: string[]; orgIds: string[] }) => ({
      humanIds: input.humanIds.filter((id) => bannedHumans.has(id)),
      orgIds: input.orgIds.filter((id) => bannedOrgs.has(id)),
    })),
  };
  const entityPages = {
    getById: vi.fn(async (id: string) => pages.get(id) ?? null),
    getByOwners: vi.fn(
      async (ownerType: EntityPageRecord["ownerType"], ownerIds: string[]) =>
        [...pages.values()].filter(
          (p) => p.ownerType === ownerType && ownerIds.includes(p.ownerId),
        ),
    ),
  };

  const orgRows = new Map([
    [BOOKER_ORG, { id: BOOKER_ORG, name: "Night Shift LLC", slug: "night-shift" }],
    [OTHER_ORG, { id: OTHER_ORG, name: "Other LLC", slug: "other" }],
    [ORG_ID, { id: ORG_ID, name: "Back Room LLC", slug: "back-room" }],
  ]);
  const organizations = {
    getById: vi.fn(async (id: string) => orgRows.get(id) ?? { id }),
    getByIds: vi.fn(async (ids: string[]) =>
      ids.flatMap((id) => (orgRows.has(id) ? [orgRows.get(id)!] : [])),
    ),
  };

  const placeBookingGrants = createFakePlaceBookingGrantsRepo({
    calendarPlace: (calendarId) =>
      calendarId === CALENDAR_ID || calendarId === OTHER_CALENDAR_ID
        ? PLACE_ID
        : calendarId === FOREIGN_CALENDAR_ID
          ? FOREIGN_PLACE_ID
          : null,
  });

  // ── audit: what `log` writes, `listForEntity` reads back ──
  const auditRows: AuditRow[] = [];
  let auditSeq = 0;
  const audit = {
    log: vi.fn(async (entry: Omit<AuditRow, "id">) => {
      auditSeq += 1;
      auditRows.push({ ...entry, entityId: entry.entityId ?? null, id: `audit-${auditSeq}` });
    }),
    listForEntity: vi.fn(
      async (input: {
        entity: string;
        entityId: string;
        actions: readonly string[];
        after?: Date | null;
        limit: number;
      }) =>
        auditRows
          .filter(
            (r) =>
              r.entity === input.entity &&
              r.entityId === input.entityId &&
              input.actions.includes(r.action) &&
              (!input.after || r.at.getTime() > input.after.getTime()),
          )
          .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id))
          .slice(0, input.limit)
          .map((r) => ({ ...r, actorHumanId: null })),
    ),
  };

  // ── events: the window read and the adapter's withdraw contract ──
  const events = new Map<string, EventRecord>();
  let withdrawFailures = 0;
  const eventsRepo = {
    getById: vi.fn(async (id: string) => events.get(id) ?? null),
    listAllByPlace: vi.fn(async (input: { placeId: string; from: Date; to: Date }) =>
      [...events.values()].filter(
        (e) =>
          e.placeId === input.placeId &&
          e.startsAt.getTime() >= input.from.getTime() &&
          e.startsAt.getTime() <= input.to.getTime() &&
          e.status !== "ARCHIVED",
      ),
    ),
    withdrawVenueConfirmation: vi.fn(async (input: WithdrawVenueConfirmationInput) => {
      if (withdrawFailures > 0) {
        withdrawFailures -= 1;
        throw new Error("events adapter down");
      }
      const current = events.get(input.eventId);
      if (!current || current.placeId !== input.placeId) {
        throw { code: "event_place_mismatch", message: "event_place_mismatch" } as const;
      }
      const next: EventRecord = {
        ...current,
        venueConfirmationWithdrawnAt: input.at,
        venueConfirmationWithdrawnReason: input.reason,
        venueConfirmedStartsAt: null,
      };
      events.set(next.id, next);
      return next;
    }),
  };

  const hold = buildHoldTestContext({
    place: {
      humanIdsWithAccess: [DIRECT_OWNER_ID],
      ...options.place,
    },
    memberships,
    delegations: [
      { principalId: PERSON_ID, delegateId: DELEGATE_ID, role: "ADMIN" },
      ...(options.extraDelegations ?? []),
    ],
    clock: options.clock,
    extraRepos: {
      placeBookingGrants,
      entityPages,
      bans,
      organizations,
      audit,
      events: eventsRepo,
    },
  });
  // The harness's tx is a passthrough; here a throw inside it ROLLS BACK
  // the grant rows, the hold rows and the audit rows it wrote, as Postgres
  // would (update.ts writes the grant, then refuses and throws).
  const passthroughTx = hold.repos.tx;
  const beforeTx: Array<() => void> = [];
  (hold.repos as { tx: unknown }).tx = vi.fn(
    async <R>(fn: (t: unknown) => Promise<R>): Promise<R> => {
      // Another transaction committing just before this one starts: its
      // writes are NOT this transaction's, so a rollback keeps them.
      beforeTx.shift()?.();
      const grantRows = new Map(placeBookingGrants.rows);
      const holdRows = new Map(hold.bookingHolds.rows);
      const auditCount = auditRows.length;
      try {
        return await passthroughTx(fn as never);
      } catch (error) {
        placeBookingGrants.rows.clear();
        for (const [id, row] of grantRows) placeBookingGrants.rows.set(id, row);
        hold.bookingHolds.rows.clear();
        for (const [id, row] of holdRows) hold.bookingHolds.rows.set(id, row);
        auditRows.length = auditCount;
        throw error;
      }
    },
  );

  // Place reads by id and in batch, off the harness's place.
  const placesRepo = hold.repos.places as unknown as {
    getByIds?: (ids: readonly string[]) => Promise<Map<string, PlaceRecord>>;
  };
  placesRepo.getByIds = vi.fn(async (ids: readonly string[]) =>
    new Map(ids.includes(PLACE_ID) ? [[PLACE_ID, hold.place]] : []),
  );

  /**
   * Seed an event of the grantee at the place, stamped (as the save does)
   * with an audit row naming how: by `grantId`, or by a manager's save.
   * `spelling: "legacy"` writes the row's action the way builds before
   * 2026-10-18 did (`lib/legacy-place-values`).
   */
  const seedConfirmedEvent = (args: {
    id: string;
    owner: { orgId: string } | { humanId: string };
    stampedBy: { grantId: string } | "manager";
    startsAt?: Date;
    status?: EventRecord["status"];
    spelling?: "current" | "legacy";
  }) => {
    const startsAt = args.startsAt ?? new Date("2026-06-21T01:00:00.000Z");
    const row = buildStageEventRecord({
      id: args.id,
      orgId: "orgId" in args.owner ? args.owner.orgId : null,
      humanId: "humanId" in args.owner ? args.owner.humanId : null,
      placeId: PLACE_ID,
      calendarId: CALENDAR_ID,
      title: `Show ${args.id.slice(0, 4)}`,
      status: args.status ?? "DRAFT",
      startsAt,
      venueConfirmedAt: new Date("2026-06-01T00:00:00.000Z"),
      venueConfirmedByHumanId: BOOKER_EDITOR,
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmedStartsAt: startsAt,
      venueConfirmationRequestId: null,
      venueConfirmationWithdrawnAt: null,
      venueConfirmationWithdrawnReason: null,
    });
    events.set(row.id, row);
    const action =
      args.stampedBy === "manager"
        ? ("event.place_confirmed_by_manager" as const)
        : ("event.place_confirmed_by_grant" as const);
    auditRows.push({
      id: `seed-${row.id}`,
      entity: "event",
      entityId: row.id,
      action:
        args.spelling === "legacy" ? LEGACY_AUDIT_ACTIONS[action] : action,
      data:
        args.stampedBy === "manager"
          ? { placeId: PLACE_ID }
          : { placeId: PLACE_ID, grantId: args.stampedBy.grantId },
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    return row;
  };

  const actions = (action: string) => auditRows.filter((r) => r.action === action);

  return {
    ...hold,
    deps: hold.deps,
    placeBookingGrants,
    entityPages,
    bans,
    organizations,
    audit,
    auditRows,
    actions,
    events,
    eventsRepo,
    seedConfirmedEvent,
    /**
     * Run `commit` as a concurrent transaction that commits right before the
     * use case's next `repos.tx` begins (after its own pre-tx reads). Its
     * writes survive that transaction's rollback.
     */
    commitBeforeNextTx: (commit: () => void) => {
      beforeTx.push(commit);
    },
    /** The next `withdrawVenueConfirmation` write(s) throw. */
    failNextWithdraw: (times = 1) => {
      withdrawFailures = times;
    },
  };
}
