import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { isEventPubliclyReadable } from "./_shared/event-public-readability";

/**
 * Owner ruling (ban-that-sticks, 2026-09-29): people who ALREADY hold a
 * ticket to an event keep seeing it while its owner is banned — on the web
 * too.
 *
 * The web event page is edge-cached and rendered for nobody in particular, so
 * a banned owner's event 404s there for everyone. The 404 page makes ONE
 * uncached, authenticated re-check (`POST /api/events/holder-view`), and this
 * is what it asks: "is THIS viewer a holder of this event, and is the owner
 * ban the ONLY reason it is hidden?" Returns the event's id and current slug
 * when (and only when) all of these hold, else null:
 *
 *  - a signed-in viewer;
 *  - the slug resolves (current or history slug);
 *  - the owner is withheld because of a ban (`ownerBanned`, derived at read
 *    time with the opt-in owner standing);
 *  - with the ban set aside the event is publicly readable — a DRAFT, or an
 *    event cancelled/archived without ever going live, never qualifies, so an
 *    editor-only read cannot ride this path;
 *  - the viewer holds an ACTIVE ticket (VALID | SCANNED | LISTED).
 *
 * Every "no" is the same null, so the answer says nothing to a non-holder.
 */
export const getBannedOwnerHolderAccessInputSchema = z
  .object({
    slug: z.string().trim().min(1).max(255),
    // Injected by the transport from the session, never from the client.
    viewerHumanId: z.string().uuid().nullish(),
  })
  .strict();

export const getBannedOwnerHolderAccessOutputSchema = z
  .object({ eventId: z.string(), currentSlug: z.string() })
  .strict()
  .nullable();

export type GetBannedOwnerHolderAccessOutput = z.infer<
  typeof getBannedOwnerHolderAccessOutputSchema
>;

export type GetBannedOwnerHolderAccessDeps = {
  repos: Pick<Repos, "events" | "tickets">;
  logger?: LoggerPort;
};

export async function getBannedOwnerHolderAccess(
  deps: GetBannedOwnerHolderAccessDeps,
  rawInput: unknown,
): Promise<GetBannedOwnerHolderAccessOutput> {
  const input = parseInput(getBannedOwnerHolderAccessInputSchema, rawInput);
  const viewerHumanId = input.viewerHumanId ?? null;
  if (!viewerHumanId) return null;

  const resolution = await deps.repos.events.resolveBySlug(input.slug);
  if (!resolution) return null;

  const event = await deps.repos.events.getById(resolution.eventId, {
    withOwnerStanding: true,
  });
  if (!event || event.ownerBanned !== true) return null;
  if (!isEventPubliclyReadable({ ...event, ownerBanned: false })) return null;

  const holds = await deps.repos.tickets.viewerHoldsActiveTicketForEvent(
    event.id,
    viewerHumanId,
  );
  if (!holds) return null;

  deps.logger?.info("event.banned_owner_holder_access", {
    eventId: event.id,
  });
  return { eventId: event.id, currentSlug: resolution.currentSlug };
}
