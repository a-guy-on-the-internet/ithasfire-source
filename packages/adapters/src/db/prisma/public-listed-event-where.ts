import { Prisma } from "@prisma/client";

import { notWithheldEventWhere } from "./banned-owner";
import type { PrismaClientOrTx } from "./types";

/**
 * The ONE definition of "an event a public category listing shows": PUBLISHED,
 * PUBLIC (a PRIVATE event is link-only and never listed), starting at or after
 * `startsAfter` when given, and not by a withheld (banned) owner.
 *
 * Gated events (PASSWORD / APPLICATION) are listed: viewers see them with the
 * gate on the card. They do not make a page worth indexing, though; that is
 * {@link indexableListedEventWhere}.
 *
 * Readers that must agree with what the category page lists build their
 * `where` from here:
 * - `EventsRepo.filterByCategory` — the category page's event listing;
 * - `CategoriesRepo.listActiveWithListedEvents` — which categories the
 *   homepage offers as browse entry points (hero chips, "Browse by
 *   category"), so an offered category never leads to an empty page;
 * - {@link indexableListedEventWhere}, which narrows it for the sitemap.
 *
 * The result carries an `AND` key when owners are withheld: spread it into a
 * `where` that has no `AND` of its own.
 */
export async function publicListedEventWhere(
  p: PrismaClientOrTx,
  { startsAfter }: { startsAfter?: Date } = {},
): Promise<Prisma.EventWhereInput> {
  return {
    status: "PUBLISHED",
    visibility: "PUBLIC",
    ...(startsAfter ? { startsAt: { gte: startsAfter } } : {}),
    ...(await notWithheldEventWhere(p)),
  };
}

/**
 * The ONE definition of "a listed event that makes a category page worth
 * indexing": {@link publicListedEventWhere} AND ungated (`gateType = NONE`).
 * Owner ruling 2026-10-13: a category whose only upcoming events are gated is
 * noindex and stays out of the sitemap. A gated event's own page is noindex,
 * so a landing page made only of them advertises nothing a crawler may read.
 *
 * Two readers must agree on it, so both build their `where` from here:
 * - `EventsRepo.countIndexableByCategory` — the category page's robots rule;
 * - `CategoriesRepo.listActiveWithUpcomingEvents` — which category pages the
 *   sitemap advertises.
 * A rule added to only one of them would put noindex pages into the sitemap
 * (or drop indexable ones), with every test green.
 *
 * Raw-SQL readers (the geo×category combos and page) use
 * {@link UNGATED_EVENT_SQL} for the same gate.
 */
export async function indexableListedEventWhere(
  p: PrismaClientOrTx,
  { startsAfter }: { startsAfter?: Date } = {},
): Promise<Prisma.EventWhereInput> {
  return {
    ...(await publicListedEventWhere(p, { startsAfter })),
    gateType: "NONE",
  };
}

/**
 * The ungated clause of {@link indexableListedEventWhere} for raw SQL over
 * `"Event" e` (the geo×category queries). `gateType` has no `@map`, so the
 * column is `"gateType"`; the enum compares against a text literal, as the
 * other raw queries do.
 */
export const UNGATED_EVENT_SQL = Prisma.sql`e."gateType" = 'NONE'`;
