import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { getVenueCalendar } from "@th/core/use-cases/events";
import { exportMyVolunteeringIcs } from "@th/core/use-cases/volunteering";
import {
  generateVenueCalendarFeed,
  generateSingleEventIcs,
} from "@th/core/lib/ical";
import type { ICalEvent } from "@th/core/lib/ical";
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
 * GET /api/venues/:placeId/calendar.ics   → venue feed (webcal:// subscribable)
 * GET /api/orgs/:orgId/calendar.ics       → org feed (webcal:// subscribable)
 * GET /api/humans/:humanId/calendar.ics   → human/host feed (webcal:// subscribable)
 * GET /api/events/:eventId/event.ics      → single event download
 * GET /api/volunteering/:feedToken/calendar.ics
 *                                         → "my volunteering" feed
 *                                           (token-authenticated, webcal:// subscribable)
 */
const plugin: FastifyPluginAsync = async (app) => {
  const rawRepos = createPrismaRepos(prisma);
  const repos = withGuardedRepos(rawRepos, app.deps.logger);
  const logger = app.deps.logger;
  const clock = createSystemClock();
  const toErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  // ── Venue calendar feed ────────────────────────────────────────────────
  app.get(
    "/api/venues/:placeId/calendar.ics",
    async (request: FastifyRequest<{ Params: { placeId: string } }>, reply) => {
      const { placeId } = request.params;

      try {
        const result = await getVenueCalendar(
          { repos, logger },
          { mode: "public" as const, placeId },
        );

        // Look up the place for the calendar name + location
        const place = await repos.places.getById(placeId);
        const calendarName = place?.name
          ? `${place.name} — Ithas Fire`
          : "Venue Calendar — Ithas Fire";
        const venueLocation = place?.formattedAddress ?? place?.name ?? null;

        const icalEvents: ICalEvent[] = result.events.map((e) => ({
          uid: `${e.eventId}@ithasfire.com`,
          title: e.title,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          location: venueLocation,
          description: e.slug
            ? `View event: https://ithasfire.com/events/${e.slug}`
            : undefined,
          url: e.slug
            ? `https://ithasfire.com/events/${e.slug}`
            : undefined,
          geo:
            place?.lat != null && place?.lng != null
              ? { lat: place.lat, lng: place.lng }
              : null,
        }));

        const ics = generateVenueCalendarFeed(icalEvents, {
          calendarName,
          refreshInterval: "PT1H",
        });

        return reply
          .header("Content-Type", "text/calendar; charset=utf-8")
          .header("Content-Disposition", `inline; filename="calendar.ics"`)
          .header("Cache-Control", "public, max-age=3600")
          .send(ics);
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code === "not_found") {
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
    async (request: FastifyRequest<{ Params: { orgId: string } }>, reply) => {
      const { orgId } = request.params;

      try {
        const org = await repos.organizations.getById(orgId);
        if (!org || org.status !== "ACTIVE") {
          return reply.status(404).send({ error: "org_not_found" });
        }

        const calendarName = `${org.name} — Ithas Fire`;

        // Fetch published events owned by this org (most recent 200, last 90 days + future)
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // include recent past
        const result = await repos.events.listByOwner({
          ownerType: "ORGANIZATION",
          ownerId: orgId,
          status: ["PUBLISHED"],
          limit: 200,
          offset: 0,
        });

        // Only include events that haven't ended more than 30 days ago
        const relevantEvents = result.items.filter((e) => {
          const end = e.endsAt ?? e.startsAt;
          return end >= from;
        });

        const icalEvents: ICalEvent[] = await Promise.all(
          relevantEvents.map(async (e) => {
            let location: string | null = null;
            let geo: { lat: number; lng: number } | null = null;

            if (e.placeId) {
              const place = await repos.places.getById(e.placeId);
              if (place) {
                location = place.formattedAddress ?? place.name;
                if (place.lat != null && place.lng != null) {
                  geo = { lat: place.lat, lng: place.lng };
                }
              }
            } else if (e.addressText) {
              location = e.addressText;
            }
            if (!geo && e.lat != null && e.lng != null) {
              geo = { lat: e.lat, lng: e.lng };
            }

            return {
              uid: `${e.id}@ithasfire.com`,
              title: e.title,
              startsAt: e.startsAt,
              endsAt: e.endsAt,
              location,
              organizerName: org.name,
              description: e.slug
                ? `View event: https://ithasfire.com/events/${e.slug}`
                : undefined,
              url: e.slug
                ? `https://ithasfire.com/events/${e.slug}`
                : undefined,
              geo,
            };
          }),
        );

        const ics = generateVenueCalendarFeed(icalEvents, {
          calendarName,
          prodId: "-//Ithas Fire//OrgCalendar//EN",
          refreshInterval: "PT1H",
        });

        return reply
          .header("Content-Type", "text/calendar; charset=utf-8")
          .header("Content-Disposition", `inline; filename="calendar.ics"`)
          .header("Cache-Control", "public, max-age=3600")
          .send(ics);
      } catch (err) {
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
    async (request: FastifyRequest<{ Params: { humanId: string } }>, reply) => {
      const { humanId } = request.params;

      try {
        const human = await repos.humans.getById(humanId);
        if (!human || human.status !== "ACTIVE") {
          return reply.status(404).send({ error: "host_not_found" });
        }

        const calendarName = human.name
          ? `${human.name} — Ithas Fire`
          : "Host Calendar — Ithas Fire";

        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const result = await repos.events.listByOwner({
          ownerType: "HUMAN",
          ownerId: humanId,
          status: ["PUBLISHED"],
          limit: 200,
          offset: 0,
        });

        const relevantEvents = result.items.filter((e) => {
          const end = e.endsAt ?? e.startsAt;
          return end >= from;
        });

        const icalEvents: ICalEvent[] = await Promise.all(
          relevantEvents.map(async (e) => {
            let location: string | null = null;
            let geo: { lat: number; lng: number } | null = null;

            if (e.placeId) {
              const place = await repos.places.getById(e.placeId);
              if (place) {
                location = place.formattedAddress ?? place.name;
                if (place.lat != null && place.lng != null) {
                  geo = { lat: place.lat, lng: place.lng };
                }
              }
            } else if (e.addressText) {
              location = e.addressText;
            }
            if (!geo && e.lat != null && e.lng != null) {
              geo = { lat: e.lat, lng: e.lng };
            }

            return {
              uid: `${e.id}@ithasfire.com`,
              title: e.title,
              startsAt: e.startsAt,
              endsAt: e.endsAt,
              location,
              organizerName: human.name ?? undefined,
              description: e.slug
                ? `View event: https://ithasfire.com/events/${e.slug}`
                : undefined,
              url: e.slug
                ? `https://ithasfire.com/events/${e.slug}`
                : undefined,
              geo,
            };
          }),
        );

        const ics = generateVenueCalendarFeed(icalEvents, {
          calendarName,
          prodId: "-//Ithas Fire//HostCalendar//EN",
          refreshInterval: "PT1H",
        });

        return reply
          .header("Content-Type", "text/calendar; charset=utf-8")
          .header("Content-Disposition", `inline; filename="calendar.ics"`)
          .header("Cache-Control", "public, max-age=3600")
          .send(ics);
      } catch (err) {
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

      try {
        const event = await repos.events.getById(eventId);
        if (!event || event.status !== "PUBLISHED") {
          return reply.status(404).send({ error: "event_not_found" });
        }

        let location: string | null = null;
        let geo: { lat: number; lng: number } | null = null;

        if (event.placeId) {
          const place = await repos.places.getById(event.placeId);
          if (place) {
            location = place.formattedAddress ?? place.name;
            if (place.lat != null && place.lng != null) {
              geo = { lat: place.lat, lng: place.lng };
            }
          }
        } else if (event.addressText) {
          location = event.addressText;
        }

        if (!geo && event.lat != null && event.lng != null) {
          geo = { lat: event.lat, lng: event.lng };
        }

        const icalEvent: ICalEvent = {
          uid: `${event.id}@ithasfire.com`,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          location,
          description: event.slug
            ? `View event: https://ithasfire.com/events/${event.slug}`
            : undefined,
          url: event.slug
            ? `https://ithasfire.com/events/${event.slug}`
            : undefined,
          geo,
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
