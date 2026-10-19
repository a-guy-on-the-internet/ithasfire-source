import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { fail } from "../../lib/errors";
import { fail as appFail } from "@th/errors";
import { parseInput } from "../../lib/io";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { requireOrgMembership, ORG_FINANCE_ROLES } from "../../lib/rbac";

// ── Schema ───────────────────────────────────────────────────────────────────

export const createConnectLoginLinkOrgInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
  })
  .strict();

export const createConnectLoginLinkHumanInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    humanId: z.uuid(),
  })
  .strict();

export const createConnectLoginLinkInputSchema = z.union([
  createConnectLoginLinkOrgInputSchema,
  createConnectLoginLinkHumanInputSchema,
]);

export type CreateConnectLoginLinkInput = z.infer<
  typeof createConnectLoginLinkInputSchema
>;

export const createConnectLoginLinkOutputSchema = z.object({
  url: z.string().url(),
});

export type CreateConnectLoginLinkOutput = z.infer<
  typeof createConnectLoginLinkOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type CreateConnectLoginLinkDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
};

type ConnectOwner = {
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  logContext: { orgId: string } | { humanId: string };
};

async function resolveConnectOwner(
  deps: CreateConnectLoginLinkDeps,
  input: CreateConnectLoginLinkInput,
): Promise<ConnectOwner> {
  if ("orgId" in input) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_FINANCE_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });

    return {
      subjectType: "ORGANIZATION",
      subjectId: input.orgId,
      logContext: { orgId: input.orgId },
    };
  }

  if (input.humanId !== input.actorHumanId) {
    return appFail("NOT_RESOURCE_OWNER");
  }

  // B2 (account squatting through guest checkout): an unverified account may
  // sit on someone else's address. The dashboard opened here manages the
  // payout account that receives that Human's resale proceeds, even after the
  // real owner reclaims it (the unproven-account sweep never touches Payee).
  // Prove the inbox first.
  await ensureEmailVerified(deps.repos, input.actorHumanId);

  return {
    subjectType: "HUMAN",
    subjectId: input.humanId,
    logContext: { humanId: input.humanId },
  };
}

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Mint a one-time login link to the Stripe Express dashboard of an org's, or
 * the actor's own, connected account. The dashboard shows balances, payouts
 * and the bank account, and lets them be changed.
 *
 * AUTH:
 *  - org: ORG_FINANCE_ROLES (Owner, Admin, Finance) on `orgId`. An Editor is
 *    refused with INSUFFICIENT_ROLE (decision of 2026-10-10: money is
 *    Finance's job); `getConnectStatus` still answers an Editor, so the page
 *    loads for them without this link.
 *  - human: the actor's own account only (NOT_RESOURCE_OWNER otherwise).
 *
 * NOT_CONNECTED without a connected account; PAYOUTS_NOT_ENABLED until the
 * account can receive payouts.
 */
export async function createConnectLoginLink(
  deps: CreateConnectLoginLinkDeps,
  rawInput: unknown,
): Promise<CreateConnectLoginLinkOutput> {
  const input = parseInput(createConnectLoginLinkInputSchema, rawInput);
  const owner = await resolveConnectOwner(deps, input);

  const payeeRef = await deps.repos.payees.getBySubject({
    type: owner.subjectType,
    id: owner.subjectId,
  });
  if (!payeeRef) return appFail("NOT_CONNECTED");

  const payee = await deps.repos.payees.getById(payeeRef.id);
  if (!payee?.stripeAccountId) return appFail("NOT_CONNECTED");

  // Express login links only work once the account can receive payouts; guard
  // early for a clean error instead of surfacing a raw Stripe failure.
  if (!payee.payoutsEnabled) return appFail("PAYOUTS_NOT_ENABLED");

  const { url } = await deps.payments.createConnectLoginLink({
    accountId: payee.stripeAccountId,
  });

  deps.logger?.info("stripe_connect_login_link_created", {
    ...owner.logContext,
    stripeAccountId: payee.stripeAccountId,
  });

  return { url };
}
