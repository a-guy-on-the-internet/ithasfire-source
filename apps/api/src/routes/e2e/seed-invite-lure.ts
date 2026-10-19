/**
 * E2E fixture for the org-invitation LURE (security review 2026-09-29):
 *
 * - POST /e2e/seed/invite-lure    — an ACTIVE org (with an owner who sent the
 *   invite), a PENDING invitation addressed to an INVITEE, and a second
 *   signed-in-able VICTIM account. Both invitee and victim get a password so
 *   the spec can sign in as each. Returns the raw invitation token.
 * - POST /e2e/cleanup/invite-lure — deletes exactly what the seed created
 *   (org cascade: members + invitations; the three humans and their auth
 *   rows; quota usage rows). Never touches anything else — safe on a live
 *   dev stack, unlike `resetE2eState`.
 */
import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@th/db";

import { assertE2eAuthorized, formatError } from "./_helpers.js";

/**
 * Everything the seed creates carries this prefix: org slugs
 * (`invite-lure-<stamp>`) and every account email
 * (`invite-lure-{owner,invitee,victim}-<stamp>@example.com`). The cleanup
 * route refuses any id that doesn't, so a bad or malicious payload can't use
 * it to delete a real org or account on a live dev stack.
 */
export const INVITE_LURE_PREFIX = "invite-lure-";

async function createHuman(opts: {
  email: string;
  name: string;
  password?: string;
}) {
  const now = new Date();
  const human = await prisma.human.create({
    data: { status: "ACTIVE", roles: ["USER"], name: opts.name },
  });
  await prisma.authUser.create({
    data: {
      id: human.id,
      humanId: human.id,
      email: opts.email,
      emailVerified: true,
      name: opts.name,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (opts.password) {
    await prisma.authAccount.create({
      data: {
        providerId: "credential",
        accountId: human.id,
        userId: human.id,
        password: await hashPassword(opts.password),
      },
    });
  }
  return human;
}

const seedInviteLure: FastifyPluginAsync = async (app) => {
  app.post("/e2e/seed/invite-lure", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { password?: string };
    const password = body.password ?? "Test-Account-2026!";
    const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    const inviteeEmail = `invite-lure-invitee-${stamp}@example.com`;
    const victimEmail = `invite-lure-victim-${stamp}@example.com`;

    try {
      const inviter = await createHuman({
        email: `invite-lure-owner-${stamp}@example.com`,
        name: "Lure Owner",
      });
      const invitee = await createHuman({
        email: inviteeEmail,
        name: "Lure Invitee",
        password,
      });
      const victim = await createHuman({
        email: victimEmail,
        name: "Lure Victim",
        password,
      });

      const orgName = `Lure Test Org ${stamp}`;
      const org = await prisma.organization.create({
        data: {
          name: orgName,
          slug: `${INVITE_LURE_PREFIX}${stamp}`,
          status: "ACTIVE",
          defaultLocale: null,
        },
      });
      await prisma.orgMember.create({
        data: { orgId: org.id, humanId: inviter.id, role: "OWNER" },
      });

      const token = randomBytes(32).toString("base64url");
      await prisma.orgInvitation.create({
        data: {
          orgId: org.id,
          email: inviteeEmail,
          role: "EDITOR",
          invitedByHumanId: inviter.id,
          token,
          status: "PENDING",
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });

      return reply.send({
        ok: true,
        seed: {
          orgId: org.id,
          orgName,
          token,
          password,
          inviter: { humanId: inviter.id },
          invitee: { humanId: invitee.id, email: inviteeEmail },
          victim: { humanId: victim.id, email: victimEmail },
        },
      });
    } catch (err) {
      app.log.error({ err }, "e2e_seed_invite_lure_failed");
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_seed_invite_lure_failed", message: formatError(err) });
    }
  });

  app.post("/e2e/cleanup/invite-lure", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { orgId?: string; humanIds?: string[] };
    const humanIds = (body.humanIds ?? []).filter((id) => typeof id === "string");
    try {
      // Refuse — before deleting ANYTHING — any id the seed didn't create.
      if (body.orgId) {
        const org = await prisma.organization.findUnique({
          where: { id: body.orgId },
          select: { slug: true },
        });
        if (org && !org.slug.startsWith(INVITE_LURE_PREFIX)) {
          return reply
            .status(400)
            .send({ ok: false, error: "not_an_invite_lure_org" });
        }
      }
      if (humanIds.length) {
        const users = await prisma.authUser.findMany({
          where: { humanId: { in: humanIds } },
          select: { humanId: true, email: true },
        });
        const ok = new Set(
          users
            .filter((u) => u.email.startsWith(INVITE_LURE_PREFIX))
            .map((u) => u.humanId),
        );
        const refused = humanIds.filter((id) => !ok.has(id));
        if (refused.length) {
          return reply.status(400).send({
            ok: false,
            error: "not_invite_lure_accounts",
            refused,
          });
        }
      }

      if (body.orgId) {
        // Cascades OrgMember + OrgInvitation.
        await prisma.organization.deleteMany({ where: { id: body.orgId } });
      }
      const subjectIds = [...humanIds, ...(body.orgId ? [body.orgId] : [])];
      if (subjectIds.length) {
        await prisma.resourceUsage.deleteMany({
          where: { subjectId: { in: subjectIds } },
        });
      }
      if (humanIds.length) {
        await prisma.authSession.deleteMany({ where: { userId: { in: humanIds } } });
        await prisma.authAccount.deleteMany({ where: { userId: { in: humanIds } } });
        await prisma.authUser.deleteMany({ where: { id: { in: humanIds } } });
        await prisma.human.deleteMany({ where: { id: { in: humanIds } } });
      }
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error({ err }, "e2e_cleanup_invite_lure_failed");
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_cleanup_invite_lure_failed", message: formatError(err) });
    }
  });
};

export default seedInviteLure;
