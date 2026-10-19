import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const adminForceVerifyEmailInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    humanId: z.string().uuid(),
  })
  .strict();

const signInFootprintSchema = z
  .object({
    hasPasswordCredential: z.boolean(),
    linkedProviders: z.array(z.string()),
    passkeys: z.number().int(),
    hasPhoneNumber: z.boolean(),
    phoneNumberVerified: z.boolean(),
    twoFactorEnabled: z.boolean(),
    activeApiKeys: z.number().int(),
    delegateGrants: z.number().int(),
  })
  .strict();

export const adminForceVerifyEmailOutputSchema = z
  .object({
    humanId: z.string().uuid(),
    emailVerified: z.literal(true),
    /** Whether the address was already verified before this call. */
    wasAlreadyVerified: z.boolean(),
    /**
     * What could sign in to / act for the account at the moment staff
     * vouched for its address. See the note in the use case.
     */
    signInFootprint: signInFootprintSchema.nullable(),
  })
  .strict();

export type AdminForceVerifyEmailInput = z.infer<
  typeof adminForceVerifyEmailInputSchema
>;
export type AdminForceVerifyEmailOutput = z.infer<
  typeof adminForceVerifyEmailOutputSchema
>;

export type AdminForceVerifyEmailDeps = {
  repos: Pick<Repos, "humans" | "audit" | "tx">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function adminForceVerifyEmail(
  deps: AdminForceVerifyEmailDeps,
  rawInput: unknown,
): Promise<AdminForceVerifyEmailOutput> {
  const logger = deps.logger?.child({ useCase: "adminForceVerifyEmail" });

  const execute = async () => {
    const input = parseInput(adminForceVerifyEmailInputSchema, rawInput);

    // RBAC: ADMIN only
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Verify target exists
    const target = await deps.repos.humans.getByIdWithIdentity(input.humanId);
    if (!target) {
      throw fail("HUMAN_NOT_FOUND");
    }

    // Wrap mutation + audit in a single transaction
    const signInFootprint = await deps.repos.tx(async (tx) => {
      // Staff vouching for an UNVERIFIED address also vouches for whatever
      // is attached to the account. Sign-up doesn't require verification, so
      // a squatter may have registered someone else's address and attached a
      // password, passkeys, a phone, API keys or delegate grants — and after
      // this call the account-takeover sweep (which only runs on unverified
      // accounts, apps/api/src/auth/account-security.ts) never fires for it.
      //
      // REFUSED when the account holds anything attached BY EMAIL (orders,
      // tickets, a coordinator seat, a lineup link; B2, owner ruling
      // 2026-10-16). Guest checkout, comps and door sales put the real inbox
      // owner's orders on whatever account carries the address, and those
      // stay hidden until the account proves the inbox. Force-verifying here
      // would hand them to a squatter with no sweep. Staff send the person to
      // email-code sign-in instead: proving the inbox that way runs the sweep
      // (removing every sign-in method a squatter could have attached:
      // password, sessions, passkeys, 2FA, phone number, API keys, delegate
      // grants) and verifies the address. A lookup error throws, so this
      // fails closed. An already-verified account is not checked: nothing
      // changes for it. A row attached between this check and the verify
      // below is ACCEPTED (2026-10-16 review): the window is milliseconds,
      // the outcome equals an order arriving just after a legitimate verify,
      // and an attacker cannot time the victim's checkout.
      if (!target.identity.emailVerified) {
        const holds = await tx.humans.holdsEmailAttachedRows(input.humanId);
        if (holds) {
          throw fail("FORCE_VERIFY_HOLDS_EMAIL_ATTACHED");
        }
      }

      // An unverified account that holds nothing (typically someone who
      // cannot receive our mail) is still verified without a sweep: there is
      // nothing of anyone else's to hand over, and sweeping would delete the
      // password of the very person support is helping. Its footprint is
      // returned and written to the audit row so staff can see what signs in
      // to it (2026-09-29 security review).
      const footprint = await tx.humans.getSignInFootprint(input.humanId);

      await tx.humans.forceVerifyEmail(input.humanId);

      // Audit log
      await tx.audit.log({
        entity: "Human",
        entityId: input.humanId,
        action: "admin.forceVerifyEmail",
        data: {
          actorHumanId: input.actorHumanId,
          wasAlreadyVerified: target.identity.emailVerified,
          signInFootprint: footprint,
        },
      });

      return footprint;
    });

    return adminForceVerifyEmailOutputSchema.parse({
      humanId: input.humanId,
      emailVerified: true,
      wasAlreadyVerified: target.identity.emailVerified,
      signInFootprint,
    });
  };

  if (logger) {
    return logger.withTime("adminForceVerifyEmail", execute);
  }

  return execute();
}
