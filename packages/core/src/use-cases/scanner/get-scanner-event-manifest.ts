import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { VolunteerSignupStatus } from "@th/types";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { getScannerEventManifestInputSchema } from "./schemas";
import { fail } from "@th/errors";

export { getScannerEventManifestInputSchema };

/**
 * Hard cap on per-source manifest rows. The scanner client paginates client-side
 * via stable keys; truncation past this cap is logged at warn-level so we can
 * detect events that outgrow a single payload before they hit production.
 */
const MANIFEST_PAGE_LIMIT = 10_000;

export type ScannerManifestTicket = {
  ticketId: string;
  code: string;
  eventId: string;
  status: string;
  ownerHumanId: string;
  scannedAt: string | null;
  ticketTypeName: string | null;
  orderId: string | null;
};

export type ScannerManifestPerson = {
  /**
   * Stable per-row key. May be `signup:<signupId>` when a volunteer signup has
   * no associated registered human. Treat as an opaque stable key — do not parse.
   */
  humanId: string;
  displayName: string | null;
  email: string | null;
  kind: "attendee" | "volunteer";
  signupStatus?: VolunteerSignupStatus | null;
};

export type GetScannerEventManifestOutput = {
  eventId: string;
  tickets: ScannerManifestTicket[];
  people: ScannerManifestPerson[];
  syncedAt: string;
};

export type GetScannerEventManifestDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function getScannerEventManifest(
  deps: GetScannerEventManifestDeps,
  rawInput: unknown,
): Promise<GetScannerEventManifestOutput> {
  const input = parseInput(getScannerEventManifestInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event || !event.orgId) {
    throw fail("EVENT_NOT_FOUND");
  }

  await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
  });

  const [ticketsResult, signupsResult] = await Promise.all([
    deps.repos.tickets.listAll({
      eventId: input.eventId,
      limit: MANIFEST_PAGE_LIMIT,
      offset: 0,
    }),
    deps.repos.volunteering.listSignups(input.eventId, {
      limit: MANIFEST_PAGE_LIMIT,
      offset: 0,
    }),
  ]);

  if (ticketsResult.total > MANIFEST_PAGE_LIMIT) {
    deps.logger?.warn("scanner.manifest_truncated", {
      eventId: input.eventId,
      kind: "tickets",
      total: ticketsResult.total,
      returned: MANIFEST_PAGE_LIMIT,
    });
  }
  if (signupsResult.pageInfo.total > MANIFEST_PAGE_LIMIT) {
    deps.logger?.warn("scanner.manifest_truncated", {
      eventId: input.eventId,
      kind: "people",
      total: signupsResult.pageInfo.total,
      returned: MANIFEST_PAGE_LIMIT,
    });
  }

  const tickets: ScannerManifestTicket[] = ticketsResult.items.map((t) => ({
    ticketId: t.id,
    code: t.code,
    eventId: t.eventId,
    status: t.status,
    ownerHumanId: t.ownerHumanId,
    scannedAt: t.scannedAt?.toISOString() ?? null,
    ticketTypeName: t.ticketTypeName ?? null,
    orderId: t.orderId ?? null,
  }));

  // Attendees: derive from raw ticket rows (which carry ownerName + ownerEmail).
  // Dedupe by ownerHumanId — one human can hold multiple tickets but should
  // surface as a single attendee row per event. Rows sharing `ownerHumanId`
  // derive from the same `owner.authUser` join, so `ownerName` / `ownerEmail`
  // are guaranteed identical across rows for the same human — first-write-wins
  // is safe.
  const attendeesByHuman = new Map<string, ScannerManifestPerson>();
  for (const t of ticketsResult.items) {
    if (attendeesByHuman.has(t.ownerHumanId)) continue;
    attendeesByHuman.set(t.ownerHumanId, {
      humanId: t.ownerHumanId,
      displayName: t.ownerName ?? null,
      email: t.ownerEmail ?? null,
      kind: "attendee",
    });
  }

  // Volunteers: every signup, regardless of status, gets a row. `humanId` is
  // nullable on signups submitted by non-registered users — fall back to
  // `signup:<id>` so the row still has a stable client-side key for upsert.
  const volunteers: ScannerManifestPerson[] = signupsResult.items.map(
    (row) => ({
      humanId: row.humanId ?? `signup:${row.id}`,
      displayName: row.contactName ?? null,
      email: row.contactEmail,
      kind: "volunteer",
      signupStatus: row.status,
    }),
  );

  // FR-001: a human who is BOTH attendee and volunteer appears twice (once
  // per kind). We therefore concatenate without cross-kind dedup.
  const people: ScannerManifestPerson[] = [
    ...attendeesByHuman.values(),
    ...volunteers,
  ];

  deps.logger?.info("scanner.get_event_manifest", {
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
    ticketCount: tickets.length,
    peopleCount: people.length,
  });

  return {
    eventId: input.eventId,
    tickets,
    people,
    syncedAt: new Date().toISOString(),
  };
}
