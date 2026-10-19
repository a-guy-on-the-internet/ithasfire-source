import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  EntityReportRecord,
  EntityReportSubjectType,
} from "@th/ports/repos/entity-reports";
import { describeError, parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { arrivalAreaKindSchema } from "../../lib/arrival-areas/geometry";
import {
  ENTITY_REPORT_STATUSES,
  ENTITY_REPORT_SUBJECT_TYPES,
  PLATFORM_STAFF_ROLES,
  arrivalAreaReportSnapshotSchema,
  entityReportRecordSchema,
} from "./_shared/entity-report-validation";

/**
 * FR-007 (entity-report-intake spec v1.1): the /platform/reports queue read.
 * PLATFORM-staff-only (ADMIN/SUPPORT/DEVELOPER via `requirePlatformStaff` —
 * entity reports are platform-level T&S, so COMMUNITY_MODERATOR gets
 * STAFF_ONLY like any other non-staff actor). `status` omitted = the
 * adapter's PENDING default (queue-shaped list; the filter never silently
 * widens — port contract). `pendingCount` is the counting twin of the queue's
 * default row set (same WHERE incl. the optional subjectType narrowing) and
 * also serves the PlatformShell nav badge.
 *
 * Each item is hydrated with `subjectName` / `subjectSlug` / `reporterName`
 * (AFTER the staff gate) so queue rows show WHO/WHAT was reported — and by
 * whom — instead of raw UUIDs; an IMPERSONATION report with no details is
 * unjudgeable otherwise. Subjects are resolved REGARDLESS of status (a report
 * on a since-suspended listing still shows its name); only missing rows fall
 * back to null, and a hydration failure degrades to null names rather than
 * failing the queue (swallow branch below).
 *
 * ARRIVAL_AREA (arrival-areas FR-011): the name is the snapshot's label (the
 * area may since have been edited or deleted), `subjectKind` its kind, and
 * the link goes to the page it was reported from: the event
 * (`subjectParentType` EVENT, `subjectSlug` the event slug) when it was seen
 * on one or is event-only, else the place's page. The snapshot itself
 * (geometry included) rides on the item: this read is platform-staff only.
 */

export const listEntityReportsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    status: z.enum(ENTITY_REPORT_STATUSES).optional(),
    subjectType: z.enum(ENTITY_REPORT_SUBJECT_TYPES).optional(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const entityReportListItemSchema = entityReportRecordSchema.extend({
  /** Subject display name; null when the subject row no longer exists. */
  subjectName: z.string().nullable(),
  /** Subject public-page slug; null when unresolvable (row gone / no page). */
  subjectSlug: z.string().nullable(),
  /** Reporter display name; null when the human row is gone or unnamed. */
  reporterName: z.string().nullable(),
  /**
   * ARRIVAL_AREA only: which page `subjectSlug` is (`/places/…` or
   * `/events/…`); null for the listing subjects, whose type says it.
   */
  subjectParentType: z.enum(["PLACE", "EVENT"]).nullable(),
  /** ARRIVAL_AREA only: the reported area's kind, from the snapshot. */
  subjectKind: arrivalAreaKindSchema.nullable(),
});

export const listEntityReportsOutputSchema = z
  .object({
    items: z.array(entityReportListItemSchema),
    nextCursor: z.string().nullable(),
    pendingCount: z.number().int().min(0),
  })
  .strict();

export type EntityReportListItem = EntityReportRecord & {
  subjectName: string | null;
  subjectSlug: string | null;
  reporterName: string | null;
  subjectParentType: "PLACE" | "EVENT" | null;
  subjectKind: z.infer<typeof arrivalAreaKindSchema> | null;
};

export type ListEntityReportsInput = z.infer<
  typeof listEntityReportsInputSchema
>;
export type ListEntityReportsOutput = z.infer<
  typeof listEntityReportsOutputSchema
>;

export type ListEntityReportsDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
  /**
   * Sentry hook for the subject-hydration swallow branch (CLAUDE.md Sentry
   * convention: warn is not captured). Guarded — a throwing reporter never
   * fails the list.
   */
  reportError?: ReporterPort;
};

export async function listEntityReports(
  deps: ListEntityReportsDeps,
  rawInput: unknown,
): Promise<ListEntityReportsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listEntityReports" });

  const execute = async (): Promise<ListEntityReportsOutput> => {
    const input = parseInput(listEntityReportsInputSchema, rawInput);

    // Authz FIRST — nothing about the queue (not even its size) leaks to
    // non-platform-staff actors (throws STAFF_ONLY, the helper's default).
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: PLATFORM_STAFF_ROLES,
    });

    const page = await deps.repos.entityReports.listPaged({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.subjectType !== undefined
        ? { subjectType: input.subjectType }
        : {}),
      cursor: input.cursor ?? null,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });

    const pendingCount = await deps.repos.entityReports.countPending(
      input.subjectType !== undefined
        ? { subjectType: input.subjectType }
        : undefined,
    );

    const { subjects, reporterNames } = await resolveDisplays(
      { ...deps, logger: scopedLogger ?? deps.logger },
      page.items,
    );

    const items: EntityReportListItem[] = page.items.map((report) => {
      const subjectSnapshot = readSnapshot(
        { ...deps, logger: scopedLogger ?? deps.logger },
        report,
      );
      return {
        ...report,
        subjectSnapshot,
        subjectParentType: null,
        subjectKind: subjectSnapshot?.kind ?? null,
        ...(subjects.get(displayKey(report)) ?? {
          // An ARRIVAL_AREA name is the snapshot's even when the parent
          // page could not be hydrated.
          subjectName: subjectSnapshot?.label ?? null,
          subjectSlug: null,
        }),
        reporterName: reporterNames.get(report.reporterHumanId) ?? null,
      };
    });

    return listEntityReportsOutputSchema.parse({
      items,
      nextCursor: page.nextCursor,
      pendingCount,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listEntityReports", execute);
  }

  return execute();
}

type SubjectDisplay = {
  subjectName: string | null;
  subjectSlug: string | null;
  /** ARRIVAL_AREA only (see the item schema). */
  subjectParentType?: "PLACE" | "EVENT" | null;
};

/**
 * Listing subjects key by subject (every report on one listing shows the
 * same name); an ARRIVAL_AREA keys by report, since each report keeps its
 * own snapshot and the page it was seen on.
 */
function displayKey(report: {
  id: string;
  subjectType: EntityReportSubjectType;
  subjectId: string;
}): string {
  return report.subjectType === "ARRIVAL_AREA"
    ? `ARRIVAL_AREA:report:${report.id}`
    : subjectKey(report.subjectType, report.subjectId);
}

function subjectKey(subjectType: EntityReportSubjectType, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

type ArrivalAreaPage = { type: "EVENT"; id: string } | { type: "PLACE"; id: string };

/**
 * Where an ARRIVAL_AREA report links: the event it was seen on, else the
 * area's parent. The parent is the area row as it is NOW when it still
 * exists (a place merge moves a place's areas to the surviving place, so the
 * snapshot's `placeId` can name a deleted place), and the snapshot's only
 * once the row is gone. The snapshot itself is never rewritten. An event id
 * survives a merge (the events are repointed, not replaced), so
 * `seenOnEventId` stays first.
 */
function arrivalAreaPage(
  snapshot: z.infer<typeof arrivalAreaReportSnapshotSchema>,
  current: { placeId: string | null; eventId: string | null } | null,
): ArrivalAreaPage | null {
  if (snapshot.seenOnEventId) return { type: "EVENT", id: snapshot.seenOnEventId };
  const parent = current ?? snapshot;
  if (parent.eventId) return { type: "EVENT", id: parent.eventId };
  if (parent.placeId) return { type: "PLACE", id: parent.placeId };
  return null;
}

/**
 * The stored snapshot, re-validated: a row whose JSON no longer parses (it
 * was not written by `submitEntityReport`) shows as no snapshot rather than
 * failing the whole queue. A deliberate fallback, so it is reported.
 */
function readSnapshot(
  deps: ListEntityReportsDeps,
  report: EntityReportRecord,
): z.infer<typeof arrivalAreaReportSnapshotSchema> | null {
  if (report.subjectSnapshot === null || report.subjectSnapshot === undefined) {
    return null;
  }
  const parsed = arrivalAreaReportSnapshotSchema.safeParse(report.subjectSnapshot);
  if (parsed.success) return parsed.data;
  // Ids only: never the snapshot itself (it carries geometry, NFR-002).
  deps.logger?.error("entity_report.snapshot_unreadable", {
    reportId: report.id,
    subjectType: report.subjectType,
  });
  try {
    deps.reportError?.(new Error("entity_report.snapshot_unreadable"), {
      tags: { useCase: "list-entity-reports", area: "entity_report_snapshot" },
      extra: { reportId: report.id, subjectType: report.subjectType },
    });
  } catch {
    // A throwing reporter must never fail the queue.
  }
  return null;
}

type ResolvedDisplays = {
  subjects: Map<string, SubjectDisplay>;
  /** reporterHumanId → display name (missing/unnamed humans stay unmapped). */
  reporterNames: Map<string, string | null>;
};

const EMPTY_DISPLAYS: ResolvedDisplays = {
  subjects: new Map(),
  reporterNames: new Map(),
};

/**
 * Batch-resolve subject + reporter display data for one queue page. Field
 * sources:
 *  - PLACE subject → `places.getById` (no batch accessor on PlacesRepo; the
 *                    page is ≤100 rows, so Promise.all over DISTINCT ids —
 *                    deliberately no new port method): `name` + `slug`.
 *  - HUMAN subject → `humans.getByIds` for `name` (HumanRecord has NO slug —
 *                    the human public-page slug lives on EntityPage), plus one
 *                    batched `entityPages.getByOwners("HUMAN", ids)` for
 *                    `slug` (and `displayName` as a name fallback when the
 *                    human never set one).
 *  - ORGANIZATION  → `organizations.getByIds`: `name` + `slug`.
 *  - REPORTER      → `human.name ?? null`, resolved by MERGING the reporter
 *                    ids into the SAME `humans.getByIds` batch as the HUMAN
 *                    subjects (one call total). Deliberately NO entity-page
 *                    displayName fallback for reporters: `getByOwners` is
 *                    only fetched when the page has HUMAN subjects, so
 *                    extending it to reporters would add a query solely for
 *                    them on the common all-PLACE page — and reporters are
 *                    account holders, who normally have `name` set.
 *
 * Resolution is deliberately status-blind (a since-SUSPENDED subject still
 * shows its name to the reviewer); only missing rows stay unmapped (→ null).
 *
 * BEST-EFFORT: any failure here degrades the whole page to null display data
 * (the queue still renders with uuid-chip fallbacks) — new catch-and-fallback
 * branch, so per the CLAUDE.md Sentry convention it logs at `logger.error` AND
 * reports via the guarded `reportError?`.
 */
async function resolveDisplays(
  deps: ListEntityReportsDeps,
  reports: EntityReportRecord[],
): Promise<ResolvedDisplays> {
  if (reports.length === 0) return EMPTY_DISPLAYS;

  const idsByType: Record<EntityReportSubjectType, Set<string>> = {
    PLACE: new Set(),
    HUMAN: new Set(),
    ORGANIZATION: new Set(),
    ARRIVAL_AREA: new Set(),
  };
  const reporterIdSet = new Set<string>();
  // ARRIVAL_AREA: each report's readable snapshot; its page is decided
  // inside the try below, once the areas' current rows are read.
  const areaSnapshots = new Map<
    string,
    z.infer<typeof arrivalAreaReportSnapshotSchema>
  >();
  const areaPages = new Map<string, ArrivalAreaPage>();
  const areaPlaceIds = new Set<string>();
  const areaEventIds = new Set<string>();
  for (const report of reports) {
    idsByType[report.subjectType].add(report.subjectId);
    reporterIdSet.add(report.reporterHumanId);
    if (report.subjectType !== "ARRIVAL_AREA") continue;
    const parsed = arrivalAreaReportSnapshotSchema.safeParse(
      report.subjectSnapshot,
    );
    if (parsed.success) areaSnapshots.set(report.id, parsed.data);
  }
  const placeIds = [...idsByType.PLACE];
  const areaIds = [...idsByType.ARRIVAL_AREA];
  const humanSubjectIds = [...idsByType.HUMAN];
  const orgIds = [...idsByType.ORGANIZATION];
  // One humans batch for subjects AND reporters (distinct union, subjects
  // first — the two sets may overlap when a human reports a human).
  const humanIds = [...new Set([...humanSubjectIds, ...reporterIdSet])];

  const subjects = new Map<string, SubjectDisplay>();
  const reporterNames = new Map<string, string | null>();

  try {
    // ARRIVAL_AREA: the areas as they are now (one batch read), so a
    // report on an area a merge moved links the surviving place.
    const areaRows =
      areaIds.length > 0 ? await deps.repos.arrivalAreas.getByIds(areaIds) : [];
    const currentAreaById = new Map(areaRows.map((row) => [row.id, row] as const));
    for (const report of reports) {
      const snapshot = areaSnapshots.get(report.id);
      if (!snapshot) continue;
      const target = arrivalAreaPage(
        snapshot,
        currentAreaById.get(report.subjectId) ?? null,
      );
      if (!target) continue;
      areaPages.set(report.id, target);
      (target.type === "EVENT" ? areaEventIds : areaPlaceIds).add(target.id);
    }
    // Entity pages for listed places AND the places of reported areas.
    const placePageIds = [...new Set([...placeIds, ...areaPlaceIds])];
    const eventIds = [...areaEventIds];

    const [places, placePages, humans, humanPages, organizations, events] =
      await Promise.all([
        placeIds.length > 0
          ? Promise.all(placeIds.map((id) => deps.repos.places.getById(id)))
          : Promise.resolve([]),
        // `subjectSlug` is the subject's PUBLIC-PAGE slug — the queue links
        // `/places/{subjectSlug}`, and that route resolves `EntityPage.slug`.
        // This used to carry `Place.slug`, the deprecated multi-segment
        // directory key, so every venue row in the queue linked to a 404.
        // Hydrated the same way the HUMAN branch below already does.
        placePageIds.length > 0
          ? deps.repos.entityPages.getByOwners("PLACE", placePageIds)
          : Promise.resolve([]),
        humanIds.length > 0
          ? deps.repos.humans.getByIds(humanIds)
          : Promise.resolve([]),
        humanSubjectIds.length > 0
          ? deps.repos.entityPages.getByOwners("HUMAN", humanSubjectIds)
          : Promise.resolve([]),
        orgIds.length > 0
          ? deps.repos.organizations.getByIds(orgIds)
          : Promise.resolve([]),
        // ARRIVAL_AREA: the event pages areas were reported from (one batch
        // read, missing ids omitted).
        eventIds.length > 0
          ? deps.repos.events.findManyByIds(eventIds)
          : Promise.resolve([]),
      ]);

    const placePageByOwnerId = new Map(
      placePages.map((placePage) => [placePage.ownerId, placePage]),
    );
    for (const place of places) {
      if (!place) continue;
      subjects.set(subjectKey("PLACE", place.id), {
        subjectName: place.name,
        subjectSlug: placePageByOwnerId.get(place.id)?.slug ?? null,
      });
    }

    const pageByOwnerId = new Map(
      humanPages.map((humanPage) => [humanPage.ownerId, humanPage]),
    );
    for (const human of humans) {
      if (reporterIdSet.has(human.id)) {
        reporterNames.set(human.id, human.name ?? null);
      }
      if (!idsByType.HUMAN.has(human.id)) continue;
      const humanPage = pageByOwnerId.get(human.id);
      subjects.set(subjectKey("HUMAN", human.id), {
        subjectName: human.name ?? humanPage?.displayName ?? null,
        subjectSlug: humanPage?.slug ?? null,
      });
    }

    for (const organization of organizations) {
      subjects.set(subjectKey("ORGANIZATION", organization.id), {
        subjectName: organization.name,
        subjectSlug: organization.slug,
      });
    }

    const eventSlugById = new Map(
      events.map((event) => [event.id, event.slug] as const),
    );
    for (const report of reports) {
      const target = areaPages.get(report.id);
      if (!target) continue;
      const snapshot = areaSnapshots.get(report.id);
      const slug =
        target.type === "EVENT"
          ? (eventSlugById.get(target.id) ?? null)
          : (placePageByOwnerId.get(target.id)?.slug ?? null);
      subjects.set(displayKey(report), {
        subjectName: snapshot?.label ?? null,
        subjectSlug: slug,
        subjectParentType: slug ? target.type : null,
      });
    }
  } catch (error) {
    deps.logger?.error("entity_report.subject_hydration_failed", {
      placeIds: placeIds.length,
      humanIds: humanSubjectIds.length,
      orgIds: orgIds.length,
      areaIds: areaIds.length,
      eventIds: areaEventIds.size,
      reporterIds: reporterIdSet.size,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: "list-entity-reports",
          area: "entity_report_subject_hydration",
        },
        extra: {
          placeIds: placeIds.length,
          humanIds: humanSubjectIds.length,
          orgIds: orgIds.length,
          areaIds: areaIds.length,
          eventIds: areaEventIds.size,
          reporterIds: reporterIdSet.size,
        },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never fail the
      // (already-degraded) queue read.
    }
    // Degraded result: every subject AND reporter falls back to null display
    // data — the queue still renders (uuid chip fallback in the UI).
    return EMPTY_DISPLAYS;
  }

  return { subjects, reporterNames };
}
