import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { authZRoleSchema, type AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import {
  ORG_ADMIN_ROLES,
  ORG_OWNER_ONLY,
  requireOrgMembership,
} from "../../lib/rbac";
import { isLiveOwnerInvitation } from "./revoke-invitation";
import { fail } from "@th/errors";

const INVITATION_TTL_DAYS = 7;

/**
 * Per-org cap on invitation emails (security review F8, 2026-09-29): each
 * invite mails an arbitrary address with an org-controlled name in it, so an
 * org is a mail relay without a ceiling. Enforced HERE, after the role check,
 * rather than as a transport middleware keyed on `input.orgId` — a
 * pre-authz limiter would let any signed-in user drain a victim org's daily
 * budget by calling with its orgId. The per-ACTOR hourly cap lives in the
 * router (it needs no authz to key safely).
 */
export const ORG_INVITE_DAILY_MAX = 50;
export const ORG_INVITE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
export const orgInviteDailyKey = (orgId: string) => `orgs:invite:org:${orgId}`;

export const inviteMemberInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
    email: z.string().email().toLowerCase(),
    role: authZRoleSchema,
  })
  .strict();

export const inviteMemberOutputSchema = z
  .object({
    invitation: z.object({
      id: z.string(),
      email: z.string(),
      role: z.string(),
      status: z.string(),
      expiresAt: z.coerce.date(),
      createdAt: z.coerce.date(),
    }),
    /**
     * Always false. Kept for wire compatibility with clients that still read
     * it: nobody is ever added directly any more — every invitee, with or
     * without an account, must accept the invitation.
     */
    addedDirectly: z.literal(false),
  })
  .strict();

export type InviteMemberInput = z.infer<typeof inviteMemberInputSchema>;
export type InviteMemberOutput = z.infer<typeof inviteMemberOutputSchema>;

export type InviteMemberDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** When provided, an invitation email is sent after creating the invitation. */
  mailer?: MailerPort;
  /** Required when mailer is provided. Base URL for the web app (e.g. https://ithasfire.com). */
  publicAppUrl?: string;
  /** Public iOS / TestFlight URL — surfaced inline on SCANNER-role invites. */
  scannerAppIosUrl?: string | null;
  /** Public Android / Play Store / internal-track URL — same gate as iOS. */
  scannerAppAndroidUrl?: string | null;
  /** Swallowed invitation-email failures are reported here (Sentry). */
  reportError?: ReporterPort;
  /**
   * Backs the per-org daily invite cap. Optional so unit tests and callers
   * without Redis still work; the API always wires it (`ctx.rateLimit`).
   */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
};

/** Non-reversible short id of a token, safe for idempotency keys and logs. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function inviteMember(
  deps: InviteMemberDeps,
  rawInput: unknown,
): Promise<InviteMemberOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "inviteMember" });

  const execute = async () => {
    const input = parseInput(inviteMemberInputSchema, rawInput);

    await deps.authz.requireOrgRole({
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
      requiredRoles: [...ORG_ADMIN_ROLES],
    });

    // An invitation at OWNER takes an OWNER. Checked here, before the member
    // lookup and the daily cap, so a refused invite spends none of the org's
    // budget; checked again inside the transaction, under the roster lock.
    if (input.role === "OWNER") {
      await requireOrgMembership({
        repos: deps.repos,
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_OWNER_ONLY,
      });
    }

    const now = deps.clock.now();

    // Existing members of THIS org are rejected (the admin can already see
    // them in `listMembers`, so this reveals nothing new). Everyone else —
    // with or without an account — gets the SAME pending invitation and the
    // SAME response shape. There is deliberately no "added directly" path:
    // a membership is only ever created by the invitee accepting
    // (`acceptInvitation`), and ORGS_JOINED / MEMBERS_PER_ORG are counted
    // there, on acceptance (security review F3/F10, 2026-09-29).
    // ONE query that runs identically whether or not the email has an
    // account — a conditional membership lookup after an account lookup was
    // a timing oracle for account existence.
    if (await deps.repos.organizations.isMemberByEmail(input.orgId, input.email)) {
      throw fail("ALREADY_A_MEMBER");
    }

    // Per-org daily cap — after authz and the member check so neither an
    // outsider nor a re-invite of an existing member burns the org's budget.
    // A re-invite the transaction below refuses (a non-owner writing over a
    // live OWNER invitation) has already spent its slot by then.
    if (deps.rateLimit) {
      let capResult: RateLimitResult | null = null;
      try {
        capResult = await deps.rateLimit.consume(
          orgInviteDailyKey(input.orgId),
          ORG_INVITE_DAILY_MAX,
          ORG_INVITE_DAILY_WINDOW_SECONDS,
        );
      } catch (capErr) {
        // Fail open like the transport limiter, but visibly: log AND report.
        scopedLogger?.error("inviteMember.orgDailyCapConsumeFailed", {
          orgId: input.orgId,
          err: capErr,
        });
        try {
          deps.reportError?.(capErr, {
            tags: { useCase: "inviteMember", area: "org_invite_daily_cap" },
            extra: { orgId: input.orgId },
          });
        } catch {
          // Reporting is best-effort.
        }
      }
      if (capResult && !capResult.allowed) {
        throw fail("RATE_LIMITED", {
          message:
            "This organization has reached today's invitation limit. Please try again tomorrow.",
          meta: {
            scope: "org_invite_daily",
            retryAfterSeconds: capResult.retryAfterSeconds,
          },
        });
      }
    }

    // Create or refresh the pending invitation
    const expiresAt = new Date(
      now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const token = generateToken();

    const invitation = await deps.repos.tx(async (tx) => {
      // Taken for every invite, before any read: the stored invitation, the
      // roles and the upsert below then cannot interleave with a role change
      // or another invite in this org. Unconditional because the stored row
      // that would make it conditional has to be read after the lock anyway.
      await tx.organizations.lockOwnerRoster(input.orgId);

      // The actor's role as this transaction sees it. The checks above are
      // only an early refusal: the actor may have been demoted or removed
      // since.
      const actor = await requireOrgMembership({
        repos: tx,
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_ADMIN_ROLES,
      });

      const org = await tx.organizations.getById(input.orgId);
      if (!org) {
        throw fail("ORGANIZATION_NOT_FOUND");
      }
      if (org.status !== "ACTIVE") {
        throw fail("ORGANIZATION_INACTIVE");
      }

      // A live OWNER invitation is an OWNER's to replace: the upsert below
      // overwrites role, inviter and token together, so a re-invite at any
      // role by anyone else would cancel or downgrade it. A lapsed one, or
      // one whose sender is no longer an OWNER, anyone who may invite can
      // write over. Keyed on org and email only, so it runs the same with or
      // without an account.
      const stored = await tx.organizations.getInvitationByOrgAndEmail(
        input.orgId,
        input.email,
      );
      if (
        !ORG_OWNER_ONLY.includes(actor.role) &&
        (input.role === "OWNER" ||
          (stored && (await isLiveOwnerInvitation(tx, stored, now))))
      ) {
        throw fail("INSUFFICIENT_ROLE");
      }

      const inv = await tx.organizations.createInvitation({
        orgId: input.orgId,
        email: input.email,
        role: input.role,
        invitedByHumanId: input.actorHumanId,
        token,
        expiresAt,
      });

      await tx.audit.log({
        entity: "organization",
        entityId: input.orgId,
        action: "org.invitation_sent",
        data: {
          actorHumanId: input.actorHumanId,
          invitationId: inv.id,
          email: input.email,
          role: input.role,
        },
        at: now,
      });

      return { inv, orgName: org.name };
    });

    // Send invitation email (fire-and-forget — failure is logged, not thrown)
    if (deps.mailer && deps.publicAppUrl) {
      try {
        const inviterHuman = await deps.repos.humans.getById(
          input.actorHumanId,
        );
        // The accept page lives at /invite/accept (apps/web/src/app/invite/
        // accept). This URL previously said /invitations/accept — a route that
        // never existed — so every emailed invite 404'd. A compat redirect page
        // now covers old emails still in the wild.
        const acceptUrl = `${deps.publicAppUrl.replace(/\/+$/, "")}/invite/accept?token=${token}`;

        const isScanner = input.role.toUpperCase() === "SCANNER";
        await deps.mailer.send({
          to: { to: input.email },
          // No replyTo: the org contact email is free text with no
          // verification, so it must not be attached to mail we send to an
          // arbitrary address (security review F8).
          template: {
            key: "org.invitation",
            variables: {
              orgName: invitation.orgName,
              role: input.role.toLowerCase(),
              inviterName: inviterHuman?.name ?? null,
              acceptUrl,
              expiresInDays: INVITATION_TTL_DAYS,
              accentColor: null,
              logoUrl: null,
              scannerIosUrl: isScanner ? (deps.scannerAppIosUrl ?? null) : null,
              scannerAndroidUrl: isScanner
                ? (deps.scannerAppAndroidUrl ?? null)
                : null,
            },
          },
          // A re-invite upserts the SAME row (same id) with a NEW token, so
          // the key must change with the token or the mail layer dedupes the
          // resend and the only live link is never delivered.
          idempotencyKey: `org-invitation:${invitation.inv.id}:${tokenFingerprint(token)}`,
        });

        scopedLogger?.info("inviteMember.emailSent", {
          invitationId: invitation.inv.id,
          email: input.email,
        });
      } catch (emailErr) {
        // Email failure must not break the invitation flow — but it is now
        // the ONLY way an invitee (with or without an account) learns of the
        // invite, so it must reach Sentry, not just a warn log.
        scopedLogger?.error("inviteMember.emailFailed", {
          invitationId: invitation.inv.id,
          error:
            emailErr instanceof Error ? emailErr.message : String(emailErr),
        });
        try {
          deps.reportError?.(emailErr, {
            tags: { useCase: "inviteMember", area: "org_invitation_email" },
            extra: { invitationId: invitation.inv.id, orgId: input.orgId },
          });
        } catch {
          // Reporting is best-effort; a throwing reporter changes nothing.
        }
      }
    }

    scopedLogger?.info("inviteMember.invitationSent", {
      orgId: input.orgId,
      invitationId: invitation.inv.id,
      email: input.email,
    });

    return inviteMemberOutputSchema.parse({
      invitation: {
        id: invitation.inv.id,
        email: invitation.inv.email,
        role: invitation.inv.role,
        status: invitation.inv.status,
        expiresAt: invitation.inv.expiresAt,
        createdAt: invitation.inv.createdAt,
      },
      addedDirectly: false,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("inviteMember", execute);
  }

  return execute();
}
