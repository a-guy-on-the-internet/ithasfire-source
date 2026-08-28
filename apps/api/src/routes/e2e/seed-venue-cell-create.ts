/**
 * E2E seed: calendar-cell create (venue-hierarchy FR-011).
 *
 * POST /e2e/seed/venue-cell-create           → mint fixture, return ids
 * POST /e2e/seed/venue-cell-create/cleanup   → delete everything it minted
 *
 * WHY THIS EXISTS instead of reusing `/e2e/seed/venue-calendar`: that seed
 * calls `prisma.place.create` directly, so its place has NO Space and NO
 * Calendar — the exact rows FR-011 prefills from. It also has no teardown,
 * because its spec runs behind `resetE2eState`.
 *
 * SELF-CLEANING BY DESIGN. The spec that drives this
 * (apps/web/e2e/venue-calendar-cell-create.spec.ts) is meant to be runnable
 * against a LIVE dev stack (`E2E_USE_LIVE_STACK=1`), where nothing wipes the
 * database before or after. Every row created here is reachable from the
 * returned `orgId` / `placeId`, and `/cleanup` removes all of it — including
 * whatever events the spec created through the product's own UI.
 *
 * The fixture deliberately gives the calendar exactly ONE active space, which
 * is the case where `VenueCalendar` auto-fills `spaceId`; with two or more the
 * UI declines to guess (see the `soleSpaceId` note there).
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";

import { assertE2eAuthorized, formatError, resolveHumanId } from "./_helpers.js";

/** Wall clock the fixture calendar defaults to — distinct from the
 *  `QUICK_CREATE_FALLBACK_START_TIME` ("19:00") the web helper falls back to,
 *  so the spec can prove the prefill came from the CALENDAR and not the
 *  fallback. */
const CALENDAR_DEFAULT_START_TIME = "20:30";

const seedVenueCellCreate: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/venue-cell-create", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { email?: string };
    const email = body.email ?? "playwright-setup@example.com";

    try {
      const humanId = await resolveHumanId({ email });
      if (!humanId) {
        return reply.status(400).send({
          ok: false,
          error: "human_not_found",
          message: `No human found for email ${email}. Run auth setup first.`,
        });
      }

      const stamp = Date.now();

      const org = await prisma.organization.create({
        data: {
          name: "E2E Cell Create Org",
          slug: `e2e-cell-${stamp}`,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });
      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      const place = await prisma.place.create({
        data: {
          name: "E2E Cell Create Venue",
          slug: `e2e-cell-venue-${stamp}`,
          address: "22 Room St, Test City, TS 00001",
          city: "Test City",
          region: "TS",
          country: "US",
          status: "ACTIVE",
          verification: "VERIFIED",
          timezone: "America/Chicago",
        },
      });
      await prisma.placeOwnership.create({
        data: {
          placeId: place.id,
          ownerType: "ORGANIZATION",
          ownerId: org.id,
          verified: true,
        },
      });

      // The venue hierarchy proper: one space, one named calendar joined to it.
      const space = await prisma.space.create({
        data: { placeId: place.id, name: "E2E Stage", sortOrder: 0 },
      });
      const calendar = await prisma.calendar.create({
        data: {
          placeId: place.id,
          name: "E2E Social Club",
          slug: "e2e-social-club",
          isDefault: true,
          defaultStartTime: CALENDAR_DEFAULT_START_TIME,
        },
      });
      await prisma.calendarSpace.create({
        data: { calendarId: calendar.id, spaceId: space.id },
      });

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug: org.slug,
          placeId: place.id,
          placeSlug: place.slug,
          placeName: place.name,
          spaceId: space.id,
          calendarId: calendar.id,
          calendarName: calendar.name,
          defaultStartTime: CALENDAR_DEFAULT_START_TIME,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_venue_cell_create_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_venue_cell_create_failed",
        message,
      });
    }
  });

  /**
   * Placement read-back. `Event.calendarId` / `Event.spaceId` are the two
   * columns FR-011 exists to stamp, and NO public read projects them (the
   * venue calendar returns neither), so the spec cannot otherwise observe
   * whether the prefill actually persisted. Scoped to a single id the spec
   * already holds.
   */
  app.get("/e2e/seed/venue-cell-create/event/:id", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { id } = request.params as { id: string };
    const event = await prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        startsAt: true,
        placeId: true,
        calendarId: true,
        spaceId: true,
      },
    });
    if (!event) return reply.status(404).send({ ok: false });
    return reply.status(200).send({ ok: true, event });
  });

  /**
   * Teardown. Ordered inner-to-outer, and every step is scoped to the ids the
   * seed handed back — nothing here can reach a row this fixture did not make.
   * Idempotent: a second call (or a call after a partial failure) is a no-op
   * rather than an error, so a spec's `afterAll` can always run.
   */
  app.post("/e2e/seed/venue-cell-create/cleanup", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orgId, placeId } = (request.body ?? {}) as {
      orgId?: string;
      placeId?: string;
    };
    if (!orgId && !placeId) {
      return reply
        .status(400)
        .send({ ok: false, error: "orgId_or_placeId_required" });
    }

    try {
      // Events first: Place/Calendar/Space deletes must not be blocked by (or
      // silently orphan) an event the spec created through the UI.
      const eventWhere = placeId
        ? { OR: [{ placeId }, ...(orgId ? [{ orgId }] : [])] }
        : { orgId: orgId! };
      const events = await prisma.event.findMany({
        where: eventWhere,
        select: { id: true, payoutTermsId: true },
      });
      const eventIds = events.map((e) => e.id);

      if (eventIds.length > 0) {
        // SearchDocument has no FK to Event (denormalised index rows), so it
        // does not cascade — clear it first or the row outlives the event.
        await prisma.searchDocument.deleteMany({
          where: { eventId: { in: eventIds } },
        });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });

        // Event → PayoutTerms is a forward FK, so the snapshot rows survive
        // the event and have to go explicitly.
        const termsIds = events
          .map((e) => e.payoutTermsId)
          .filter((id): id is string => Boolean(id));
        if (termsIds.length > 0) {
          await prisma.payoutTerms
            .deleteMany({ where: { id: { in: termsIds } } })
            .catch(() => undefined);
        }
      }

      // Place cascades PlaceOwnership / Space / Calendar / CalendarSpace /
      // CalendarAvailability. EntityPage is a polymorphic pointer with no FK.
      if (placeId) {
        await prisma.searchDocument
          .deleteMany({ where: { placeId } })
          .catch(() => undefined);
        await prisma.entityPage.deleteMany({
          where: { ownerType: "PLACE", ownerId: placeId },
        });
        await prisma.place.deleteMany({ where: { id: placeId } });
      }

      if (orgId) {
        await prisma.searchDocument
          .deleteMany({ where: { orgIdRef: orgId } })
          .catch(() => undefined);
        await prisma.entityPage.deleteMany({
          where: { ownerType: "ORGANIZATION", ownerId: orgId },
        });
        await prisma.orgMember.deleteMany({ where: { orgId } });
        await prisma.organization.deleteMany({ where: { id: orgId } });
      }

      return reply
        .status(200)
        .send({ ok: true, deletedEvents: eventIds.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_cleanup_venue_cell_create_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_cleanup_venue_cell_create_failed",
        message,
      });
    }
  });
};

export default seedVenueCellCreate;
