import { Prisma } from "@prisma/client";
import type { EventSavesRepo } from "@th/ports/repos/event-saves";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const saveSelect = {
  id: true,
  eventId: true,
  humanId: true,
  createdAt: true,
} as const;

const savedEventSummarySelect = {
  id: true,
  slug: true,
  title: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  status: true,
  visibility: true,
  heroImageId: true,
  // Hero URL resolution mirrors the events adapter (events.ts): join the
  // Image relation and surface its stored publicUrl — no runtime URL building.
  heroImage: {
    select: {
      publicUrl: true,
      key: true,
    },
  },
  addressText: true,
  locationLabel: true,
  placeId: true,
  // Location privacy + coarse fields: the saved list's location line goes
  // through `projectPublicEventLocation` like every other public card.
  locationMode: true,
  locationRadiusMeters: true,
  locality: true,
  region: true,
  // A gated event's saved-list line is label only, like every public card.
  gateType: true,
} as const;

function getSafeLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/**
 * Value-based keyset cursor for `listForHuman`: `<createdAt ISO>|<save id>`.
 * A Prisma row-cursor (`cursor: { id }`) returns an EMPTY page when the
 * cursor row has been deleted — and unsave is this list's primary quick
 * action, so unsave-then-scroll would truncate the list. Value-based
 * pagination keeps working regardless of the boundary row's fate. The cursor
 * remains an opaque string at the port boundary.
 */
export function encodeSavedEventsCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

/**
 * Defensive decode: a malformed cursor returns `null`, which `listForHuman`
 * treats as "no cursor" (restart from the first page). That choice never
 * 500s and never silently hides rows — worst case the client re-sees page 1.
 */
export function decodeSavedEventsCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const sep = cursor.indexOf("|");
  if (sep <= 0 || sep === cursor.length - 1) {
    return null;
  }

  const createdAt = new Date(cursor.slice(0, sep));
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return { createdAt, id: cursor.slice(sep + 1) };
}

export function makeEventSavesRepo(p: PrismaClientOrTx): EventSavesRepo {
  return {
    // create → catch P2002 → findUnique (instead of prisma upsert) so we can
    // report `created` for audit logs and the `alreadySaved` response flag —
    // same idempotent pattern as follows.upsertFollow.
    upsert: async ({ eventId, humanId }) => {
      try {
        const save = await p.eventSave.create({
          data: { eventId, humanId },
          select: saveSelect,
        });

        return { save, created: true };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const save = await p.eventSave.findUnique({
            where: { eventId_humanId: { eventId, humanId } },
            select: saveSelect,
          });

          if (!save) {
            throw error;
          }

          return { save, created: false };
        }

        throw error;
      }
    },

    delete: async ({ eventId, humanId }) => {
      const existing = await p.eventSave.findUnique({
        where: { eventId_humanId: { eventId, humanId } },
        select: { id: true },
      });

      if (!existing) {
        return { deleted: false, saveId: null };
      }

      const result = await p.eventSave.deleteMany({
        where: { eventId, humanId },
      });

      return {
        deleted: result.count > 0,
        saveId: result.count > 0 ? existing.id : null,
      };
    },

    existsForUser: async ({ eventId, humanId }) => {
      const existing = await p.eventSave.findUnique({
        where: { eventId_humanId: { eventId, humanId } },
        select: { id: true },
      });
      return existing !== null;
    },

    // Ordering: BOTH scopes are most-recently-saved first (save.createdAt
    // desc, id desc) so the list reads as "your watchlist, newest additions
    // on top" and one keyset scheme covers both tabs. The keyset is
    // value-based (see encodeSavedEventsCursor) so it survives the boundary
    // row being unsaved. The upcoming|past split is on event.startsAt
    // relative to `now`.
    listForHuman: async ({ humanId, scope, cursor, limit, now }) => {
      const safeLimit = getSafeLimit(limit);
      const boundary = now ?? new Date();
      const decoded = cursor ? decodeSavedEventsCursor(cursor) : null;
      const rows = await p.eventSave.findMany({
        where: {
          humanId,
          event: {
            startsAt:
              scope === "upcoming" ? { gte: boundary } : { lt: boundary },
          },
          // Strictly-after-the-boundary in (createdAt desc, id desc) order.
          ...(decoded
            ? {
                OR: [
                  { createdAt: { lt: decoded.createdAt } },
                  { createdAt: decoded.createdAt, id: { lt: decoded.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: safeLimit + 1,
        select: {
          ...saveSelect,
          event: { select: savedEventSummarySelect },
        },
      });

      const hasMore = rows.length > safeLimit;
      const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
      // Flatten the joined Image row into `heroImageUrl` on the summary —
      // same shape the events adapter emits on EventRecord.
      const items = pageRows.map(
        ({ event: { heroImage, ...event }, ...save }) => ({
          ...save,
          event: {
            ...event,
            heroImageUrl: heroImage?.publicUrl ?? null,
            heroImageKey: heroImage?.key ?? null,
          },
        }),
      );
      const last = items[items.length - 1];

      return {
        items,
        nextCursor:
          hasMore && last
            ? encodeSavedEventsCursor(last.createdAt, last.id)
            : null,
      };
    },

    getSavedStateForEvents: async ({ humanId, eventIds }) => {
      const state: Record<string, boolean> = {};
      for (const eventId of eventIds) {
        state[eventId] = false;
      }

      if (eventIds.length === 0) {
        return state;
      }

      const rows = await p.eventSave.findMany({
        where: { humanId, eventId: { in: eventIds } },
        select: { eventId: true },
      });

      for (const row of rows) {
        state[row.eventId] = true;
      }

      return state;
    },

    // Keyset on the compound unique's (eventId, humanId) leading column —
    // index-only scan, no standalone eventId index needed.
    listHumanIdsForEvent: async ({ eventId, cursor, limit }) => {
      const safeLimit = getSafeLimit(limit);
      const rows = await p.eventSave.findMany({
        where: {
          eventId,
          ...(cursor ? { humanId: { gt: cursor } } : {}),
        },
        orderBy: { humanId: "asc" },
        take: safeLimit + 1,
        select: { humanId: true },
      });

      const hasMore = rows.length > safeLimit;
      const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(
        (row) => row.humanId,
      );

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1] ?? null) : null,
      };
    },
  };
}
