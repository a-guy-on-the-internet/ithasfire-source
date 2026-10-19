import { Prisma } from "@prisma/client";
import type {
  EventHumansRepo,
  AttachEventHumanInput,
  EventHumanRecord,
  HumanPerformanceSummary,
  ListPerformancesByHumanInput,
  ActsAtPlacePage,
  ListActsByPlaceInput,
  HumanLineupRow,
  ListLineupsByHumanInput,
} from "@th/ports/repos/event-humans";

import { TRACK_RECORD_EVENT_STATUSES } from "@th/types/repos/events";

import { venueConfirmedSqlArms } from "./events";
import type { PrismaClientOrTx } from "./types";

const EVENT_HUMAN_SELECT = {
  id: true,
  eventId: true,
  humanId: true,
  orgId: true,
  externalName: true,
  externalUrl: true,
  role: true,
  customRoleLabel: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

const mapRecord = (row: any): EventHumanRecord => ({
  id: row.id,
  eventId: row.eventId,
  humanId: row.humanId,
  orgId: row.orgId ?? null,
  externalName: row.externalName,
  externalUrl: row.externalUrl,
  role: row.role,
  customRoleLabel: row.customRoleLabel ?? null,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  profileSlug: null,
  humanDisplayName: null,
});

export function makeEventHumansRepo(p: PrismaClientOrTx): EventHumansRepo {
  return {
    async attach(input: AttachEventHumanInput) {
      // A row is a person OR a group (lineup v3 FR-015). Refused up front:
      // the human upsert below would otherwise return an EXISTING (event,
      // human) row via `update: {}` and silently drop the orgId — the SQL
      // CHECK "EventHuman_identity_check" only fires on the insert path.
      if (input.humanId && input.orgId) {
        throw {
          code: "invalid_input",
          message: "event_human_person_and_group",
        } as const;
      }
      const data = {
        ...(input.id ? { id: input.id } : {}),
        eventId: input.eventId,
        humanId: input.humanId ?? null,
        orgId: input.orgId ?? null,
        externalName: input.externalName ?? null,
        externalUrl: input.externalUrl ?? null,
        role: input.role,
        customRoleLabel: input.customRoleLabel ?? null,
        sortOrder: input.sortOrder ?? 0,
      };
      const row = input.humanId
        ? await p.eventHuman.upsert({
            where: {
              eventId_humanId: {
                eventId: input.eventId,
                humanId: input.humanId,
              },
            },
            create: data,
            update: {},
            select: EVENT_HUMAN_SELECT,
          })
        : input.orgId
          ? // A group row (lineup v3 FR-015): the same idempotent upsert, on
            // the (event, org) key. humanId + orgId together never gets here
            // (refused at the top).
            await p.eventHuman.upsert({
              where: {
                eventId_orgId: { eventId: input.eventId, orgId: input.orgId },
              },
              create: data,
              update: {},
              select: EVENT_HUMAN_SELECT,
            })
          : await p.eventHuman.create({
              data,
              select: EVENT_HUMAN_SELECT,
            });
      return mapRecord(row);
    },

    async detach(id: string) {
      await p.eventHuman.delete({ where: { id } });
    },

    async listByEvent(eventId: string) {
      const rows = await p.eventHuman.findMany({
        where: { eventId },
        orderBy: { sortOrder: "asc" },
        select: EVENT_HUMAN_SELECT,
      });

      // Batch-fetch EntityPage slugs and display names for linked humans
      const humanIds = rows
        .map((r) => r.humanId)
        .filter((id): id is string => id !== null);
      const pageMap = new Map<
        string,
        { slug: string; displayName: string | null }
      >();
      if (humanIds.length > 0) {
        const pages = await p.entityPage.findMany({
          where: { ownerType: "HUMAN", ownerId: { in: humanIds } },
          select: { ownerId: true, slug: true, displayName: true },
        });
        for (const pg of pages) {
          pageMap.set(pg.ownerId, {
            slug: pg.slug,
            displayName: pg.displayName,
          });
        }
      }

      // Group rows (lineup v3 FR-015): the org's name and its PUBLIC page —
      // two batched reads, none when the lineup has no group. Additive: only
      // a group row carries the two keys; person and free-text rows are
      // byte-identical to before.
      const orgIds = [
        ...new Set(
          rows
            .map((r) => r.orgId)
            .filter((id): id is string => id !== null && id !== undefined),
        ),
      ];
      const orgMap = new Map<
        string,
        { name: string | null; pageSlug: string | null }
      >();
      if (orgIds.length > 0) {
        const [orgs, orgPages] = await Promise.all([
          p.organization.findMany({
            where: { id: { in: orgIds } },
            select: { id: true, name: true },
          }),
          p.entityPage.findMany({
            where: {
              ownerType: "ORGANIZATION",
              ownerId: { in: orgIds },
              visibility: "PUBLIC",
            },
            select: { ownerId: true, slug: true, displayName: true },
          }),
        ]);
        const publicPageByOrg = new Map(
          orgPages.map((pg) => [pg.ownerId, pg] as const),
        );
        for (const org of orgs) {
          const pg = publicPageByOrg.get(org.id);
          orgMap.set(org.id, {
            name: pg?.displayName?.trim() || org.name?.trim() || null,
            pageSlug: pg?.slug?.trim() || null,
          });
        }
      }

      return rows.map((row) => {
        const pg = row.humanId ? pageMap.get(row.humanId) : undefined;
        const org = row.orgId ? orgMap.get(row.orgId) : undefined;
        return {
          ...mapRecord(row),
          profileSlug: pg?.slug ?? null,
          humanDisplayName: pg?.displayName ?? null,
          ...(row.orgId
            ? { orgName: org?.name ?? null, orgPageSlug: org?.pageSlug ?? null }
            : {}),
        };
      });
    },

    async reorder(eventId: string, orderedIds: string[]) {
      await Promise.all(
        orderedIds.map(async (id, index) => {
          const result = await p.eventHuman.updateMany({
            where: { id, eventId },
            data: { sortOrder: index },
          });

          // Guard against cross-event ids in orderedIds.
          if (result.count !== 1) {
            throw new Error("event_human_reorder_scope_mismatch");
          }
        }),
      );
    },

    async getById(id: string) {
      const row = await p.eventHuman.findUnique({
        where: { id },
        select: EVENT_HUMAN_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async getByEventAndHuman({
      eventId,
      humanId,
    }: {
      eventId: string;
      humanId: string;
    }) {
      const row = await p.eventHuman.findUnique({
        where: { eventId_humanId: { eventId, humanId } },
        select: EVENT_HUMAN_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async listLineupsByHuman({
      humanId,
      when,
      now,
      after,
      limit,
      eventStatuses,
    }: ListLineupsByHumanInput): Promise<HumanLineupRow[]> {
      // The person's OWN view: every status and visibility (drafts included —
      // they must be able to leave a lineup before it goes public). Keyset
      // over (Event.startsAt, EventHuman.id) in the direction of `when`; the
      // id tiebreak makes the order total so a page boundary never drops or
      // repeats a row.
      const upcoming = when === "upcoming";
      const cmp = upcoming ? "gt" : "lt";
      const keyset = after
        ? {
            OR: [
              { event: { startsAt: { [cmp]: after.startsAt } } },
              {
                event: { startsAt: after.startsAt },
                id: { [cmp]: after.eventHumanId },
              },
            ],
          }
        : {};
      const direction = upcoming ? ("asc" as const) : ("desc" as const);
      const rows = await p.eventHuman.findMany({
        where: {
          humanId,
          event: {
            ...(upcoming ? { endsAt: { gt: now } } : { endsAt: { lte: now } }),
            // Optional narrowing (the navbar's next-night read); absent =
            // every status, the /my-lineups self-view.
            ...(eventStatuses ? { status: { in: [...eventStatuses] } } : {}),
          },
          ...keyset,
        },
        orderBy: [{ event: { startsAt: direction } }, { id: direction }],
        take: limit,
        select: {
          id: true,
          eventId: true,
          role: true,
          customRoleLabel: true,
          event: {
            select: {
              title: true,
              startsAt: true,
              endsAt: true,
              timezone: true,
              status: true,
              visibility: true,
              stewardship: true,
              slug: true,
              orgId: true,
              humanId: true,
              org: { select: { name: true } },
              human: { select: { name: true } },
            },
          },
        },
      });
      return rows.map((row) => ({
        eventHumanId: row.id,
        eventId: row.eventId,
        role: row.role,
        customRoleLabel: row.customRoleLabel ?? null,
        eventTitle: row.event.title,
        startsAt: row.event.startsAt,
        endsAt: row.event.endsAt,
        timezone: row.event.timezone,
        status: row.event.status,
        visibility: row.event.visibility,
        stewardship: row.event.stewardship,
        slug: row.event.slug ?? null,
        orgName: row.event.org?.name ?? null,
        ownerHumanName: row.event.human?.name ?? null,
        ownerOrgId: row.event.orgId ?? null,
        ownerHumanId: row.event.humanId ?? null,
      }));
    },

    async linkHuman({ id, humanId }: { id: string; humanId: string }) {
      const row = await p.eventHuman.update({
        where: { id },
        data: { humanId },
        select: EVENT_HUMAN_SELECT,
      });
      return mapRecord(row);
    },

    async listPerformancesByHuman({
      humanId,
      roles,
      when,
      now,
      limit,
    }: ListPerformancesByHumanInput): Promise<HumanPerformanceSummary[]> {
      // Reuse the public-event visibility predicate: PUBLISHED (+ COMPLETED for
      // past shows, since complete-event.ts flips ended events off PUBLISHED)
      // AND visibility PUBLIC — never drafts, cancelled, or archived. Mirrors
      // EventsRepo.listPublishedByPlace rather than re-deriving.
      const statusFilter =
        when === "past" ? ["PUBLISHED", "COMPLETED"] : ["PUBLISHED"];

      const rows = await p.eventHuman.findMany({
        where: {
          humanId,
          role: { in: [...roles] as any },
          event: {
            status: { in: statusFilter as any },
            visibility: "PUBLIC",
            startsAt: when === "upcoming" ? { gt: now } : { lte: now },
          },
        },
        select: {
          event: {
            select: {
              id: true,
              title: true,
              startsAt: true,
              slug: true,
              locationLabel: true,
              place: { select: { name: true } },
              // Raw inputs for the venue-confirmation derivation (core gates
              // whether the place may be NAMED on a public performer page).
              placeId: true,
              orgId: true,
              humanId: true,
              stewardship: true,
              venueConfirmedAt: true,
              venueConfirmationWithdrawnAt: true,
              venueConfirmedPlaceId: true,
            },
          },
        },
        orderBy: { event: { startsAt: when === "past" ? "desc" : "asc" } },
      });

      // Dedupe by eventId — defensive/redundant belt-and-braces: EventHuman is
      // @@unique([eventId, humanId]), so a registered human already holds at
      // most one row per event (a PERFORMER+DJ double-credit on one event is
      // impossible for the same human). Kept in case that constraint ever
      // changes or a raw duplicate slips in. Preserves query order.
      const seen = new Set<string>();
      const out: HumanPerformanceSummary[] = [];
      for (const row of rows) {
        const ev = row.event;
        if (!ev || seen.has(ev.id)) continue;
        seen.add(ev.id);
        out.push({
          eventId: ev.id,
          title: ev.title,
          startsAt: ev.startsAt,
          // UNGATED (see the DTO doc) — kept for existing consumers.
          venueName: ev.place?.name ?? ev.locationLabel ?? null,
          slug: ev.slug ?? null,
          placeId: ev.placeId ?? null,
          placeName: ev.place?.name ?? null,
          locationLabel: ev.locationLabel ?? null,
          orgId: ev.orgId ?? null,
          humanId: ev.humanId ?? null,
          stewardship: ev.stewardship,
          venueConfirmedAt: ev.venueConfirmedAt ?? null,
          venueConfirmationWithdrawnAt: ev.venueConfirmationWithdrawnAt ?? null,
          venueConfirmedPlaceId: ev.venueConfirmedPlaceId ?? null,
        });
        if (limit !== undefined && out.length >= limit) break;
      }
      return out;
    },

    async listActsByPlace({
      placeId,
      now,
      venueConfirmedFor,
      limit,
    }: ListActsByPlaceInput): Promise<ActsAtPlacePage> {
      // The venue-confirmed predicate is the SAME arm set
      // `listPublishedByPlace` applies (stamp / owner / community), rendered
      // by the shared SQL twin of `venueConfirmedFragment` — reused, not
      // re-derived, so this read can never admit an event the venue page's
      // own calendar would not. REQUIRED on the input: an unconfirmed
      // third-party event pointed at the place is not this venue's history.
      // A filter always yields at least the stamp arm, so `arms` is never
      // empty here; the guard only keeps the SQL well-formed if that changes.
      const arms = venueConfirmedSqlArms(
        venueConfirmedFor,
        Prisma.sql`${placeId}`,
      ).map((arm) => arm.sql);
      const confirmedSql =
        arms.length > 0
          ? Prisma.sql`AND (${Prisma.join(arms, " OR ")})`
          : Prisma.empty;
      const limitSql =
        limit === null ? Prisma.empty : Prisma.sql`LIMIT ${limit}`;
      // JS `String.prototype.trim` strips more than Postgres `btrim`'s default
      // (spaces only); bind the common whitespace set so a tab or newline in a
      // stage name folds the same way the core grouping used to.
      const ws = " \t\n\r\f\v";

      // One row per ACT, grouped here rather than in core (spec FU-006): a
      // public venue page render reads its recent line + a count, never every
      // credit the venue ever had.
      //   · `credits` resolves each PERFORMER credit's display name exactly as
      //     `listPublicEventHumans` does (the linked human's name, else the
      //     stage name, trimmed) and its act key: the humanId, else the
      //     trimmed, case-folded stage name. The key is a PAIR, not a
      //     COALESCE, so a stage name that happens to equal some human's id
      //     can never merge with that human.
      //   · The display name is the one from the act's most recent credit
      //     (ties broken by eventId then sortOrder, the order the old
      //     per-credit read returned).
      //   · `timesPlayed` counts DISTINCT events: two credits on one show are
      //     one; two stages at the same instant are two.
      //   · `COUNT(*) OVER ()` is evaluated over the whole grouped set BEFORE
      //     `LIMIT`, so `totalActs` is the all-time act count on every row.
      //   · The status list is bound as an enum array (`"EventStatus"[]`), not
      //     a text comparison, so the column keeps its native type.
      // Group rows (lineup v3 FR-015): a lineup row with `orgId` is its own
      // act — keyed by the org, named by Organization.name (else the stage
      // name it carries) — and never merges with a person or a free-text
      // name. Additive: rows without `orgId` group exactly as before.
      const rows = await p.$queryRaw<
        Array<{
          humanId: string | null;
          orgId: string | null;
          externalName: string | null;
          name: string;
          timesPlayed: number;
          lastPlayedAt: Date;
          totalActs: number;
        }>
      >(Prisma.sql`
        WITH credits AS (
          SELECT
            eh."eventId" AS "eventId",
            eh."humanId" AS "humanId",
            eh."orgId" AS "orgId",
            NULLIF(btrim(eh."externalName", ${ws}), '') AS "externalName",
            eh."sortOrder" AS "sortOrder",
            e."startsAt" AS "startsAt",
            CASE
              WHEN eh."humanId" IS NOT NULL THEN COALESCE(
                NULLIF(btrim(h."name", ${ws}), ''),
                NULLIF(btrim(eh."externalName", ${ws}), '')
              )
              WHEN eh."orgId" IS NOT NULL THEN COALESCE(
                NULLIF(btrim(o."name", ${ws}), ''),
                NULLIF(btrim(eh."externalName", ${ws}), '')
              )
              ELSE NULLIF(btrim(eh."externalName", ${ws}), '')
            END AS "displayName",
            CASE
              WHEN eh."humanId" IS NULL AND eh."orgId" IS NULL
                THEN lower(btrim(eh."externalName", ${ws}))
            END AS "nameKey"
          FROM "EventHuman" eh
          JOIN "Event" e ON e.id = eh."eventId"
          LEFT JOIN "Human" h ON h.id = eh."humanId"
          LEFT JOIN "Organization" o ON o.id = eh."orgId"
          WHERE eh.role = 'PERFORMER'
            AND e."placeId" = ${placeId}
            AND e.status = ANY(${[...TRACK_RECORD_EVENT_STATUSES]}::"EventStatus"[])
            AND e.visibility = 'PUBLIC'
            AND e."endsAt" <= ${now}
            -- A show that has not even STARTED can only be a bad row (endsAt
            -- before startsAt); it is not history either.
            AND e."startsAt" <= ${now}
            ${confirmedSql}
        )
        SELECT
          "humanId",
          "orgId",
          CASE WHEN "humanId" IS NULL AND "orgId" IS NULL THEN
            (array_agg("externalName" ORDER BY "startsAt" DESC, "eventId" ASC, "sortOrder" ASC))[1]
          END AS "externalName",
          (array_agg("displayName" ORDER BY "startsAt" DESC, "eventId" ASC, "sortOrder" ASC))[1] AS "name",
          COUNT(DISTINCT "eventId")::int AS "timesPlayed",
          MAX("startsAt") AS "lastPlayedAt",
          (COUNT(*) OVER ())::int AS "totalActs"
        FROM credits
        WHERE "displayName" IS NOT NULL
        GROUP BY "humanId", "orgId", "nameKey"
        ORDER BY "lastPlayedAt" DESC, "name" ASC, "humanId" ASC NULLS LAST, "orgId" ASC NULLS LAST, "nameKey" ASC
        ${limitSql}
      `);

      // Profile slugs ONLY from PUBLIC pages — the filter
      // list-public-event-humans.ts applies. `listByEvent`'s lookup returns a
      // slug for any page and is deliberately not reused: a PRIVATE or
      // UNLISTED profile must not be linked from a venue page. Bounded by the
      // acts returned above (≤ `limit`), not by the venue's history.
      const humanIds = rows
        .map((r) => r.humanId)
        .filter((id): id is string => id !== null);
      const publicSlugByHuman = new Map<string, string>();
      if (humanIds.length > 0) {
        const pages = await p.entityPage.findMany({
          where: {
            ownerType: "HUMAN",
            ownerId: { in: humanIds },
            visibility: "PUBLIC",
          },
          select: { ownerId: true, slug: true },
        });
        for (const pg of pages) publicSlugByHuman.set(pg.ownerId, pg.slug);
      }
      // Same PUBLIC-only rule for a group's page (v3 FR-015).
      const orgIds = rows
        .map((r) => r.orgId)
        .filter((id): id is string => id !== null && id !== undefined);
      const publicSlugByOrg = new Map<string, string>();
      if (orgIds.length > 0) {
        const pages = await p.entityPage.findMany({
          where: {
            ownerType: "ORGANIZATION",
            ownerId: { in: orgIds },
            visibility: "PUBLIC",
          },
          select: { ownerId: true, slug: true },
        });
        for (const pg of pages) publicSlugByOrg.set(pg.ownerId, pg.slug);
      }

      return {
        acts: rows.map((row) => ({
          humanId: row.humanId,
          externalName: row.humanId || row.orgId ? null : row.externalName,
          name: row.name,
          profileSlug: row.humanId
            ? (publicSlugByHuman.get(row.humanId) ?? null)
            : null,
          // Only a group act carries these (additive: every other row is
          // unchanged).
          ...(row.orgId
            ? {
                orgId: row.orgId,
                orgPageSlug: publicSlugByOrg.get(row.orgId) ?? null,
              }
            : {}),
          timesPlayed: Number(row.timesPlayed),
          lastPlayedAt: row.lastPlayedAt,
        })),
        totalActs: rows.length > 0 ? Number(rows[0]!.totalActs) : 0,
      };
    },
  };
}
