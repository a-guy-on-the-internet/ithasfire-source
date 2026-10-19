import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { EventStatus } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import {
  projectPublicEventLocation,
  unreadablePlaceLocation,
} from "../../lib/location/project-public-event-location";
import { resolvePlaceLocations } from "../../lib/location/resolve-place-locations";
import { fail } from "@th/errors";
import {
  listScannerAccessibleEventsInputSchema,
  SCANNER_OPERATOR_ROLES,
} from "./schemas";

export type ListScannerAccessibleEventsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter (ReporterPort convention): a venue whose row
   * cannot be read projects its events as fully hidden (no coordinates) for
   * this call instead of failing the whole picker — and that degradation must
   * be visible in Sentry.
   */
  reportError?: ReporterPort;
};

export type ScannerAccessibleEvent = {
  eventId: string;
  orgId: string;
  orgName: string;
  eventName: string;
  startAt: Date | null;
  endAt: Date | null;
  status: string;
  role: OrgRole;
  /**
   * The event's PUBLIC position (`projectPublicEventLocation`) — the true pin
   * for an EXACT event, the keyed circle centre for a withheld one, null when
   * fully hidden. Never the stored point of a withheld location, whatever the
   * operator's role: the picker's only use is distance telemetry, which may
   * degrade to the public centre (2026-09-25 ruling).
   */
  lat: number | null;
  lng: number | null;
};

export type ListScannerAccessibleEventsOutput = {
  events: ScannerAccessibleEvent[];
  /** True when the listing was produced via the platform-admin override. */
  viaPlatformAdmin: boolean;
};

// Statuses the scanner shell can land on. ARCHIVED and CANCELLED are filtered
// out per the spec. DRAFT remains visible so admins/owners can pre-stage
// scanners against an unpublished event during dress rehearsals; non-eligible
// drafts will already be hidden by the org-membership filter upstream.
const ELIGIBLE_STATUSES: ReadonlySet<EventStatus> = new Set<EventStatus>([
  "DRAFT",
  "PUBLISHED",
  "COMPLETED",
]);

/**
 * List events the operator may scan for, scoped by org role and event status.
 *
 * Read-only. No `repos.tx()`, no money. Throws `forbidden` when the actor has
 * zero qualifying memberships so the scanner shell can route to a "no events
 * available" gate without leaking org IDs.
 */
export async function listScannerAccessibleEvents(
  deps: ListScannerAccessibleEventsDeps,
  rawInput: unknown,
): Promise<ListScannerAccessibleEventsOutput> {
  const input = parseInput(listScannerAccessibleEventsInputSchema, rawInput);

  const memberships = await deps.repos.authz.listOrgMembershipsByHumanId({
    humanId: input.actorHumanId,
    roles: [...SCANNER_OPERATOR_ROLES],
  });

  // Platform-admin override: see notes in get-scanner-session-context. We
  // synthesize OWNER on every active org so the picker UI renders the full
  // catalog when a platform admin is on-call.
  let viaPlatformAdmin = false;
  if (memberships.length === 0) {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    // A platform ADMIN with no second factor enrolled has no override; the
    // code says why, so a client can tell it from "not an operator".
    if (staff.secondFactorRequired) {
      throw fail("SECOND_FACTOR_REQUIRED");
    }
    if (!staff.allowed) {
      throw fail("INSUFFICIENT_ROLE");
    }
    viaPlatformAdmin = true;
  }

  // Pick the highest-privilege role per org if duplicates exist (defensive).
  const roleByOrg = new Map<string, OrgRole>();
  const rolePriority: Record<OrgRole, number> = {
    OWNER: 4,
    ADMIN: 3,
    EDITOR: 2,
    FINANCE: 2,
    SCANNER: 1,
    VIEWER: 0,
  };
  for (const m of memberships) {
    const current = roleByOrg.get(m.orgId);
    if (!current || rolePriority[m.role] > rolePriority[current]) {
      roleByOrg.set(m.orgId, m.role);
    }
  }

  let orgIds: string[];
  let orgs: { id: string; name: string }[];
  if (viaPlatformAdmin) {
    const { items } = await deps.repos.organizations.listActive({
      limit: 200,
      offset: 0,
    });
    orgs = items.map((o) => ({ id: o.id, name: o.name }));
    orgIds = orgs.map((o) => o.id);
    for (const id of orgIds) roleByOrg.set(id, "OWNER");
  } else {
    orgIds = [...roleByOrg.keys()];
    orgs = await deps.repos.organizations.getByIds(orgIds);
  }

  const eventsByOrg = await Promise.all(
    orgIds.map((orgId) =>
      deps.repos.events.listByOwner({
        ownerType: "ORGANIZATION",
        ownerId: orgId,
        status: [...ELIGIBLE_STATUSES],
        limit: 200,
      }),
    ),
  );

  const orgNameById = new Map(orgs.map((o) => [o.id, o.name] as const));

  // One read per distinct venue across every org's page, for the projection.
  // Fails closed per venue (gone / unreadable → fully hidden) and reports.
  const placeLocations = await resolvePlaceLocations(
    {
      repos: deps.repos,
      reportError: deps.reportError,
      logger: deps.logger,
    },
    eventsByOrg.flatMap((page) => page.items.map((ev) => ev.placeId)),
    { useCase: "listScannerAccessibleEvents" },
  );

  const events: ScannerAccessibleEvent[] = [];
  orgIds.forEach((orgId, idx) => {
    const role = roleByOrg.get(orgId);
    const orgName = orgNameById.get(orgId);
    if (!role || !orgName) return;

    const page = eventsByOrg[idx];
    if (!page) return;

    for (const ev of page.items) {
      if (!ELIGIBLE_STATUSES.has(ev.status)) continue;
      const location = projectPublicEventLocation(ev, {
        place: ev.placeId
          ? (placeLocations.get(ev.placeId) ??
            unreadablePlaceLocation(ev.placeId))
          : undefined,
      });
      events.push({
        eventId: ev.id,
        orgId,
        orgName,
        eventName: ev.title,
        startAt: ev.startsAt ?? null,
        endAt: ev.endsAt ?? null,
        status: ev.status,
        role,
        lat: location.lat,
        lng: location.lng,
      });
    }
  });

  events.sort((a, b) => {
    const aStart = a.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bStart = b.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return aStart - bStart;
  });

  deps.logger?.info("scanner.list_accessible_events", {
    actorHumanId: input.actorHumanId,
    orgCount: orgIds.length,
    eventCount: events.length,
    viaPlatformAdmin,
  });

  return { events, viaPlatformAdmin };
}
