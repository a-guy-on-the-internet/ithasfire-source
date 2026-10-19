import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
// File subpath (not the `use-cases/events` barrel): the feeds are the whole
// of these routes, and the route tests exercise them for real.
import {
  buildOwnerCalendarFeed,
  buildPlaceCalendarFeed,
  feedSequence,
  PUBLIC_CALENDAR_FEED_NOT_FOUND_CODES,
} from "@th/core/use-cases/events/public-calendar-feeds";
import { exportMyVolunteeringIcs } from "@th/core/use-cases/volunteering";
import { generateSingleEventIcs } from "@th/core/lib/ical";
import type { ICalEvent } from "@th/core/lib/ical";
import { publicIcalLocation } from "@th/core/lib/location/public-ical-location";
import { createPrismaRepos } from "@th/adapters/db/prisma-repos";
import { withGuardedRepos } from "@th/adapters/decorators/with-dependency-guard";
import { createSystemClock } from "@th/adapters/infra/clock";
import { logAndReport } from "@th/adapters/infra/discord-alerts";
import { prisma } from "@th/db";
import { env } from "../lib/env";
import { Sentry } from "../instrument";

/**
 * Public iCal routes for calendar feeds and single-event downloads.
 *
 * The three public feeds are built in core (`public-calendar-feeds.ts`), which
 * owns what they list: PUBLIC + PUBLISHED shows, plus upcoming called-off ones
 * as `STATUS:CANCELLED`, every LOCATION/GEO through `publicIcalLocation`.
 * These handlers only map the result to HTTP: any "no such public feed"
 * (unknown or malformed id, unverified or inactive place, inactive owner) is
 * one uniform 404 and is not reported; anything else is a reported 500.
 *
 * GET /api/venues/:placeId/calendar.ics   → place feed (webcal:// subscribable)
 * GET /api/orgs/:orgId/calendar.ics       → org feed (webcal:// subscribable)
 * GET /api/humans/:humanId/calendar.ics   → human/host feed (webcal:// subscribable)
 * GET /api/events/:eventId/event.ics      → single event download
 * GET /api/volunteering/:feedToken/calendar.ics
 *                                         → "my volunteering" feed
 *                                           (token-authenticated, webcal:// subscribable)
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isFeedNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && PUBLIC_CALENDAR_FEED_NOT_FOUND_CODES.has(code);
}

/**
 * The feed language rides in the URL (`?lang=es`), never Accept-Language: the
 * feeds are cached publicly by URL. Core maps unknown values to English; a
 * repeated param (an array) or a non-string is treated as absent.
 */
function langParam(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 35) : undefined;
}

const plugin: FastifyPluginAsync = async (app) => {
  const rawRepos = createPrismaRepos(prisma);
  const repos = withGuardedRepos(rawRepos, app.deps.logger);
  const logger = app.deps.logger;
  const clock = createSystemClock();
  const feedDeps = { repos, clock, logger, appBaseUrl: env.PUBLIC_WEB_URL };
  const toErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const webBase = env.PUBLIC_WEB_URL.replace(/\/+$/, "");

  const sendFeed = (reply: FastifyReply, icsBody: string) =>
    reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Content-Disposition", `inline; filename="calendar.ics"`)
      .header("Cache-Control", "public, max-age=3600")
      .send(icsBody);

  // ── Place calendar feed ────────────────────────────────────────────────
  app.get(
    "/api/venues/:placeId/calendar.ics",
    async (
      request: FastifyRequest<{
        Params: { placeId: string };
        Querystring: { lang?: unknown };
      }>,
      reply,
    ) => {
      const { placeId } = request.params;

      try {
        const { icsBody } = await buildPlaceCalendarFeed(feedDeps, {
          placeId,
          lang: langParam(request.query.lang),
        });
        return sendFeed(reply, icsBody);
      } catch (err: unknown) {
        if (isFeedNotFound(err)) {
          return reply.status(404).send({ error: "venue_not_found" });
        }
        await logAndReport({
          logger,
          level: "error",
          message: "ical_venue_feed_error",
          extra: {
            placeId,
            error: toErrorMessage(err),
          },
          report: {
            captureException: Sentry.captureException,
            error: err,
            context: {
              tags: {
                route: "venue_calendar",
                placeId,
              },
            },
          },
        });
        return reply.status(500).send({ error: "internal_error" });
      }
    },
  );

  // ── Organization calendar feed ─────────────────────────────────────────
  app.get(
    "/api/orgs/:orgId/calendar.ics",
    async (
      request: FastifyRequest<{
        Params: { orgId: string };
        Querystring: { lang?: unknown };
      }>,
      reply,
    ) => {
      const { orgId } = request.params;

      try {
        const { icsBody } = await buildOwnerCalendarFeed(feedDeps, {
          ownerType: "ORGANIZATION",
          ownerId: orgId,
          lang: langParam(request.query.lang),
        });
        return sendFeed(reply, icsBody);
      } catch (err) {
        if (isFeedNotFound(err)) {
          return reply.status(404).send({ error: "org_not_found" });
        }
        await logAndReport({
          logger,
          level: "error",
          message: "ical_org_feed_error",
          extra: {
            orgId,
            error: toErrorMessage(err),
          },
          report: {
            captureException: Sentry.captureException,
            error: err,
            context: {
              tags: {
                route: "org_calendar",
                orgId,
              },
            },
          },
        });
        return reply.status(500).send({ error: "internal_error" });
      }
    },
  );

  // ── Human / host calendar feed ─────────────────────────────────────────
  app.get(
    "/api/humans/:humanId/calendar.ics",
    async (
      request: FastifyRequest<{
        Params: { humanId: string };
        Querystring: { lang?: unknown };
      }>,
      reply,
    ) => {
      const { humanId } = request.params;

      try {
        const { icsBody } = await buildOwnerCalendarFeed(feedDeps, {
          ownerType: "HUMAN",
          ownerId: humanId,
          lang: langParam(request.query.lang),
        });
        return sendFeed(reply, icsBody);
      } catch (err) {
        if (isFeedNotFound(err)) {
          return reply.status(404).send({ error: "host_not_found" });
        }
        await logAndReport({
          logger,
          level: "error",
          message: "ical_human_feed_error",
          extra: {
            humanId,
            error: toErrorMessage(err),
          },
          report: {
            captureException: Sentry.captureException,
            error: err,
            context: {
              tags: {
                route: "human_calendar",
                humanId,
              },
            },
          },
        });
        return reply.status(500).send({ error: "internal_error" });
      }
    },
  );

  // ── Single event download ──────────────────────────────────────────────
  app.get(
    "/api/events/:eventId/event.ics",
    async (request: FastifyRequest<{ Params: { eventId: string } }>, reply) => {
      const { eventId } = request.params;

      if (!UUID_RE.test(eventId)) {
        return reply.status(404).send({ error: "event_not_found" });
      }

      try {
        const event = await repos.events.getById(eventId);
        // Anonymous and cached: only an event a stranger may see in full —
        // PUBLISHED, PUBLIC (a PRIVATE event is link-only, and an id is not
        // an invitation) and UNGATED (a password/application gate protects
        // the schedule and location; the gated preview is title + hero
        // only). Everything else is the same 404, so the route is no oracle
        // for which of those an id is.
        if (
          !event ||
          event.status !== "PUBLISHED" ||
          event.visibility !== "PUBLIC" ||
          event.gateType !== "NONE"
        ) {
          return reply.status(404).send({ error: "event_not_found" });
        }

        const { location, geo } = publicIcalLocation(
          event,
          event.placeId ? await repos.places.getById(event.placeId) : null,
        );

        const url = event.slug ? `${webBase}/events/${event.slug}` : null;
        const icalEvent: ICalEvent = {
          uid: `${event.id}@ithasfire.com`,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          location,
          description: url,
          url,
          geo,
          lastModified: event.updatedAt ?? null,
          // Same UID as the feed entry, so the same SEQUENCE: a client that
          // matches UIDs across calendars must not see this copy as older.
          sequence: feedSequence(event.updatedAt ?? null),
        };

        const ics = generateSingleEventIcs(icalEvent);

        return reply
          .header("Content-Type", "text/calendar; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(event.title || "event")}.ics"`,
          )
          .send(ics);
      } catch (err) {
        await logAndReport({
          logger,
          level: "error",
          message: "ical_single_event_error",
          extra: {
            eventId,
            error: toErrorMessage(err),
          },
          report: {
            captureException: Sentry.captureException,
            error: err,
            context: {
              tags: {
                route: "single_event_calendar",
                eventId,
              },
            },
          },
        });
        return reply.status(500).send({ error: "internal_error" });
      }
    },
  );

  // ── "My volunteering" feed (token-authenticated) ───────────────────────
  //
  // The feed token is a bearer secret minted by `volunteer.ics.myFeedToken`.
  // Unknown / malformed tokens collapse to the same 404 (no probe oracle),
  // and this handler never puts the token in its own logs or Sentry reports.
  // Residual surfaces: platform request logs (Cloud Run / load balancer)
  // still record the full path, and Sentry's auto-attached request URL is
  // scrubbed via `scrubVolunteerFeedToken` in apps/api/src/instrument.ts
  // rather than avoided outright. Cache-Control is `private`
  // (unlike the public venue/org feeds) so a shared cache never stores a
  // response keyed by a capability URL.
  app.get(
    "/api/volunteering/:feedToken/calendar.ics",
    async (
      request: FastifyRequest<{ Params: { feedToken: string } }>,
      reply,
    ) => {
      try {
        const result = await exportMyVolunteeringIcs(
          { repos, clock, logger, appBaseUrl: env.PUBLIC_WEB_URL },
          { feedToken: request.params.feedToken },
        );

        return reply
          .header("Content-Type", "text/calendar; charset=utf-8")
          .header(
            "Content-Disposition",
            `inline; filename="${result.filename}"`,
          )
          .header("Cache-Control", "private, max-age=3600")
          .send(result.icsBody);
      } catch (err: unknown) {
        const error = err as { code?: string };
        // Bad token (NOT_FOUND) and malformed token (invalid_input) are the
        // same uniform 404 — the response must never distinguish them.
        if (error.code === "NOT_FOUND" || error.code === "invalid_input") {
          return reply.status(404).send({ error: "feed_not_found" });
        }
        await logAndReport({
          logger,
          level: "error",
          message: "ical_volunteering_feed_error",
          extra: {
            // Deliberately NO feedToken — it's a bearer secret.
            error: toErrorMessage(err),
          },
          report: {
            captureException: Sentry.captureException,
            error: err,
            context: {
              tags: {
                route: "volunteering_calendar",
              },
            },
          },
        });
        return reply.status(500).send({ error: "internal_error" });
      }
    },
  );
};

export default fp(plugin as unknown as never) as unknown as never;
