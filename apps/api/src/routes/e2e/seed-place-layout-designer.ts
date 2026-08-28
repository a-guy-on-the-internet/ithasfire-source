/**
 * E2E seed: Place Layout Designer fixtures.
 *
 * POST /e2e/seed/place-layout-designer
 *
 * Creates an org with a place and ownership so the layout designer page
 * can be tested end-to-end.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
} from "./_helpers.js";

const seedPlaceLayoutDesigner: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/place-layout-designer", async (request, reply) => {
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

      // ── Org + Membership ───────────────────────────────────────────
      const orgSlug = `e2e-layout-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Layout Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      // ── Place ──────────────────────────────────────────────────────
      const placeSlug = `e2e-venue-${Date.now()}`;
      const place = await prisma.place.create({
        data: {
          name: "E2E Test Venue",
          slug: placeSlug,
          address: "100 E2E Blvd",
          city: "Testville",
          region: "TX",
          country: "US",
          postcode: "00001",
          lat: 30.27,
          lng: -97.74,
          capacity: 500,
          verification: "VERIFIED",
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

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
          placeId: place.id,
          placeSlug,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_place_layout_designer_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_place_layout_designer_failed",
        message,
      });
    }
  });
};

export default seedPlaceLayoutDesigner;
