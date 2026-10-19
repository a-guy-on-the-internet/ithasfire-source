/**
 * E2E seed: Gated Event + Magic Link fixtures.
 *
 * - POST /e2e/seed/gated-event
 * - POST /e2e/seed/magic-link
 *
 * Creates a PASSWORD- or APPLICATION-gated event and, optionally, magic
 * links for direct unlock.
 */
import { createHash, randomBytes } from "node:crypto";
import { mintApplicationFormPublicId } from "@th/core/lib/application-form-public-id";
import type { FastifyPluginAsync } from "fastify";
import { hashEventPassword } from "@th/core/lib/security/event-password";
import { prisma } from "@th/db";
import { env } from "../../lib/env.js";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
  seedFeePolicy,
  seedPayoutTerms,
  snapshotPayoutTermsForE2eEvent,
} from "./_helpers.js";

const seedGatedEvent: FastifyPluginAsync = async (app) => {
  // ── Seed gated event ──────────────────────────────────────────────────
  app.post("/e2e/seed/gated-event", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      gateType?: "PASSWORD" | "APPLICATION";
      password?: string;
      email?: string;
      userPassword?: string;
      /**
       * Make an EXISTING auth user (e.g. the Playwright storageState user,
       * who can actually sign in) the org owner, instead of minting a
       * password-less organiser.
       */
      ownerEmail?: string;
      /** Override the payee's Stripe account (it is unique per payee). */
      stripeAccountId?: string;
      priceCents?: number;
      applicationQuestions?: Array<{
        prompt: string;
        type?: "SHORT_TEXT" | "LONG_TEXT";
      }>;
    };

    const gateType = body.gateType ?? "PASSWORD";
    const eventPassword = body.password ?? "test-password-123";
    const email = body.email ?? `e2e-gated-${Date.now()}@example.com`;
    const userPassword = body.userPassword ?? "Test-Account-2026!";
    const priceCents =
      typeof body.priceCents === "number" ? body.priceCents : 2500;
    const now = new Date();
    const startsAt = new Date(now.getTime() + 86_400_000);

    try {
      // ── Human + auth ───────────────────────────────────────────────
      let human: { id: string };
      if (body.ownerEmail) {
        const existingId = await resolveHumanId({ email: body.ownerEmail });
        if (!existingId) {
          return reply.status(400).send({
            ok: false,
            error: "human_not_found",
            message: `No human found for email ${body.ownerEmail}.`,
          });
        }
        human = { id: existingId };
      } else {
        human = await prisma.human.create({
          data: { status: "ACTIVE", roles: ["USER"] },
        });

        await prisma.authUser.create({
          data: {
            id: human.id,
            humanId: human.id,
            email,
            emailVerified: true,
            name: "E2E Gated Test User",
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // ── Org + membership ───────────────────────────────────────────
      const org = await prisma.organization.create({
        data: {
          name: "E2E Gated Org",
          slug: `e2e-gated-org-${Date.now()}`,
          status: "ACTIVE",
        },
      });

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId: human.id, role: "OWNER" },
      });

      // ── Fee policy + payout terms ──────────────────────────────────
      const feePolicy = await seedFeePolicy({
        notes: "e2e-gated-event",
        createdBy: human.id,
      });

      const { agreement } = await seedPayoutTerms({
        feePolicyId: feePolicy.id,
        orgId: org.id,
        currency: "usd",
        stripeAccountId:
          body.stripeAccountId ??
          env.E2E_STRIPE_ACCOUNT_ID ??
          `acct_e2e_${Date.now()}`,
      });

      // ── Event ──────────────────────────────────────────────────────
      const slug = `e2e-gated-${gateType.toLowerCase()}-${Date.now()}`;
      const event = await prisma.event.create({
        data: {
          orgId: org.id,
          title: `E2E ${gateType} Gated Event`,
          slug,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
          status: "PUBLISHED",
          publishedAt: now,
          visibility: "PUBLIC",
          gateType,
          passwordHash:
            gateType === "PASSWORD" ? hashEventPassword(eventPassword) : null,
          passwordUpdatedAt: gateType === "PASSWORD" ? now : null,
          regionCode: "ca-sf",
          payoutTermsId: await snapshotPayoutTermsForE2eEvent(
            prisma,
            agreement.id,
          ),
        },
      });

      // ── Ticket type ────────────────────────────────────────────────
      const ticketType = await prisma.ticketType.create({
        data: {
          eventId: event.id,
          name: "General Admission",
          priceCents,
          capacity: 100,
          status: "ACTIVE",
        },
      });

      // ── Application form (if APPLICATION gate) ─────────────────────
      let applicationFormId: string | null = null;
      const applicationQuestionIds: string[] = [];

      if (gateType === "APPLICATION") {
        const questions = body.applicationQuestions ?? [
          {
            prompt: "Why do you want to attend this event?",
            type: "LONG_TEXT" as const,
          },
          {
            prompt: "How did you hear about us?",
            type: "SHORT_TEXT" as const,
          },
        ];

        const form = await prisma.eventApplicationForm.create({
          data: {
            eventId: event.id,
            purpose: "ATTEND",
            publicId: mintApplicationFormPublicId(),
          },
        });
        applicationFormId = form.id;

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]!;
          const question = await prisma.eventApplicationQuestion.create({
            data: {
              formId: form.id,
              label: q.prompt,
              type: q.type ?? "SHORT_TEXT",
              isRequired: true,
              order: i,
            },
          });
          applicationQuestionIds.push(question.id);
        }
      }

      return reply.send({
        ok: true,
        seed: {
          // With `ownerEmail` the owner is that EXISTING user: no account was
          // minted from `email`/`userPassword`, and this route never learns
          // the existing user's password, so it must not echo one.
          email: body.ownerEmail ?? email,
          password: body.ownerEmail ? null : userPassword,
          humanId: human.id,
          orgId: org.id,
          orgSlug: org.slug,
          eventId: event.id,
          eventSlug: event.slug,
          gateType,
          eventPassword: gateType === "PASSWORD" ? eventPassword : null,
          ticketTypeId: ticketType.id,
          priceCents,
          applicationFormId,
          applicationQuestionIds,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, "e2e_seed_gated_event_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_gated_event_failed",
        message,
      });
    }
  });

  // ── Magic link ────────────────────────────────────────────────────────
  app.post("/e2e/seed/magic-link", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    // Gated-event invite links (docs/specs/2026-10-02/completed/gated-event-invite-
    // links.spec.yaml): mints the event's SHARED invite. Only the SHA-256 of
    // the token is stored; the raw token is handed back once, here. Any live
    // SHARED invite is revoked first (one live per event, DB-enforced).
    // `targetHumanId` / `expiresInDays` from the old magic-link contract are
    // ignored: invites have no target and no timer.
    const body = (request.body ?? {}) as {
      eventId: string;
      creatorHumanId: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.eventId || !body.creatorHumanId) {
      return reply.status(400).send({
        ok: false,
        error: "missing_required_fields",
        message: "eventId and creatorHumanId are required",
      });
    }

    try {
      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");

      const invite = await prisma.$transaction(async (tx) => {
        await tx.eventInvite.updateMany({
          where: { eventId: body.eventId, kind: "SHARED", revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return tx.eventInvite.create({
          data: {
            eventId: body.eventId,
            kind: "SHARED",
            tokenHash,
            createdByHumanId: body.creatorHumanId,
            metadata: (body.metadata ?? {}) as object,
          },
        });
      });

      return reply.send({
        ok: true,
        magicLink: {
          id: invite.id,
          token,
          eventId: invite.eventId,
          kind: invite.kind,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, "e2e_seed_magic_link_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_seed_magic_link_failed",
        message,
      });
    }
  });
};

export default seedGatedEvent;
