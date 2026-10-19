import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  canViewerReadEvent,
  eventNotFoundBySlug,
  type EventStaffReadProbe,
} from "./_shared/event-public-readability";

export const resolveEventBySlugInputSchema = z
  .object({
    slug: z.string().trim().min(1).max(255),
    // Injected by the transport from the session, never taken from the
    // client (the router omits it from its public input).
    viewerHumanId: z.string().uuid().nullish(),
  })
  .strict();

export const resolveEventBySlugOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    currentSlug: z.string().min(1),
    redirect: z.boolean(),
  })
  .strict();

export type ResolveEventBySlugInput = z.infer<
  typeof resolveEventBySlugInputSchema
>;
export type ResolveEventBySlugOutput = z.infer<
  typeof resolveEventBySlugOutputSchema
>;

export type ResolveEventBySlugDeps = {
  repos: Repos;
  /**
   * The staff probe behind a community moderator's read of a hidden
   * COMMUNITY listing.
   */
  authz: EventStaffReadProbe;
  logger?: LoggerPort;
};

/**
 * Resolves a slug (current, historical, or an event id) to an event.
 *
 * Only for a viewer who may read the event (place-address-withholding N3,
 * `event-public-readability`): the event is publicly readable, or the viewer
 * can edit it. Anyone else gets the same `EVENT_NOT_FOUND` an unknown slug
 * gets, for every kind of hit:
 * - a REDIRECT answer names the event's CURRENT slug (its current title, date
 *   and host). Without the gate, whoever held an old slug (or the id) of a
 *   DRAFT, or of an event cancelled / archived without ever going live,
 *   learned its new slug from the 308 before the target page 404'd;
 * - a CURRENT-slug answer carries the event's id, which other public reads
 *   accept, and would confirm the slug is a real event.
 *
 * A GATED (password / application) PUBLISHED event still resolves and
 * redirects: it is publicly readable, its current slug is already public, and
 * the gate is applied on the canonical URL.
 */
export async function resolveEventBySlug(
  deps: ResolveEventBySlugDeps,
  rawInput: unknown,
): Promise<ResolveEventBySlugOutput> {
  const input = parseInput(resolveEventBySlugInputSchema, rawInput);

  const resolution = await deps.repos.events.resolveBySlug(input.slug);
  if (!resolution) {
    throw eventNotFoundBySlug();
  }

  const event = await deps.repos.events.getById(resolution.eventId, {
    withOwnerStanding: true,
  });
  if (
    !event ||
    !(await canViewerReadEvent(
      deps.repos.authz,
      event,
      input.viewerHumanId,
      deps.repos.tickets,
      deps.authz,
    ))
  ) {
    deps.logger?.info("event.slug_resolution_withheld", {
      slug: input.slug,
      eventId: resolution.eventId,
      redirect: resolution.redirect,
    });
    // Identical to the unknown-slug branch above: the caller must not be
    // able to tell "hidden" from "never existed".
    throw eventNotFoundBySlug();
  }

  deps.logger?.info("event.slug_resolved", {
    slug: input.slug,
    eventId: resolution.eventId,
    redirect: resolution.redirect,
  });

  return resolveEventBySlugOutputSchema.parse({
    eventId: resolution.eventId,
    currentSlug: resolution.currentSlug,
    redirect: resolution.redirect,
  });
}
