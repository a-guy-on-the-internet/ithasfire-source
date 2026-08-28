/**
 * E2E seed: Event Series Builder fixtures.
 *
 * POST /e2e/seed/event-series
 *
 * Creates an org with membership and returns the slug so the E2E test
 * can navigate to /admin/{slug}/events/new and exercise the recurrence
 * builder UI in create mode.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
} from "./_helpers.js";

const seedEventSeries: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/event-series", async (request, reply) => {
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
      const orgSlug = `e2e-series-${Date.now()}`;
      const org = await prisma.organization.create({
        data: {
          name: "E2E Series Org",
          slug: orgSlug,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId, role: "OWNER" },
      });

      return reply.status(200).send({
        ok: true,
        seed: {
          humanId,
          orgId: org.id,
          orgSlug,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : formatError(err);
      app.log.error({ err }, "e2e_seed_event_series_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_event_series_failed",
        message,
      });
    }
  });
};

export default seedEventSeries;
