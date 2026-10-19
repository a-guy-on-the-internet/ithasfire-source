import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { parseShortId } from "../../lib/slug-utils";
import {
  eventNotFoundBySlug,
  isEventPubliclyReadable,
} from "./_shared/event-public-readability";

export const resolveEventShortLinkInputSchema = z
  .object({
    // Loose on purpose: a non-empty string that is not a real short ID gets
    // the same EVENT_NOT_FOUND an unknown one gets (below), not a validation
    // error. Only empty, whitespace-only or >255-char input fails here, as
    // `invalid_input`, and that depends on no event, so it reveals nothing.
    // The web page never sends such input: `parseShortId` rejects it first.
    shortId: z.string().trim().min(1).max(255),
  })
  .strict();

export const resolveEventShortLinkOutputSchema = z
  .object({
    currentSlug: z.string().min(1),
  })
  .strict();

export type ResolveEventShortLinkInput = z.infer<
  typeof resolveEventShortLinkInputSchema
>;
export type ResolveEventShortLinkOutput = z.infer<
  typeof resolveEventShortLinkOutputSchema
>;

export type ResolveEventShortLinkDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * Resolves a `/e/<shortId>` short link to the event's CURRENT slug, for
 * NOBODY IN PARTICULAR — there is no viewer: the answer depends on the event
 * alone.
 *
 * Only for an event the public may read (`isEventPubliclyReadable`, the N3
 * rule the slug resolver applies to anonymous viewers). A DRAFT never
 * resolves: the short ID is DERIVED from the event's internal UUID
 * (`deriveShortIdFromUuid`), so anyone who ever saw a draft's id could compute
 * its short link and learn its slug — its title, date and host. A long slug
 * has no such exposure; guessing one takes the title and date already. The
 * same rule withholds an event cancelled or archived WITHOUT ever going live.
 * Whatever else `isEventPubliclyReadable` comes to cover, this link inherits,
 * and the canonical page it redirects to applies its own viewer rules on top
 * (a ticket holder's access, for instance). A CANCELLED / COMPLETED /
 * ARCHIVED event that WAS live does resolve: its links are already out in the
 * world (flyers, texts), and the canonical page shows its own status banner.
 *
 * Every "no" — not a short ID, unknown, no slug yet, not publicly readable —
 * throws the one EVENT_NOT_FOUND the slug reads use, so a caller cannot tell
 * hidden from never-existed.
 */
export async function resolveEventShortLink(
  deps: ResolveEventShortLinkDeps,
  rawInput: unknown,
): Promise<ResolveEventShortLinkOutput> {
  const input = parseInput(resolveEventShortLinkInputSchema, rawInput);

  // Strict: `sanitizeShortId` would PAD `ab` into `ab00000000` — another
  // event's link. Not a short ID ⇒ no lookup at all.
  const shortId = parseShortId(input.shortId);
  if (!shortId) {
    throw eventNotFoundBySlug();
  }

  const resolution = await deps.repos.events.resolveByShortId(shortId);
  if (!resolution) {
    throw eventNotFoundBySlug();
  }

  // `resolveByShortId` carries no status; the readability rule needs it.
  const event = await deps.repos.events.getById(resolution.eventId);
  if (!event || !isEventPubliclyReadable(event)) {
    deps.logger?.info("event.short_link_withheld", {
      shortId,
      eventId: resolution.eventId,
    });
    throw eventNotFoundBySlug();
  }

  deps.logger?.info("event.short_link_resolved", {
    shortId,
    eventId: resolution.eventId,
  });

  return resolveEventShortLinkOutputSchema.parse({
    currentSlug: resolution.currentSlug,
  });
}
