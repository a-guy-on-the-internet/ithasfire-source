import { z } from "zod";

import { randomUUID } from "node:crypto";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { asKnownError } from "../../lib/errors";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { resolveAppRedirectUrl } from "../../lib/resolve-app-redirect-url";
import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import { requireCurrentChargebackTermsForRiskOwner } from "../../lib/payments/chargeback-terms";
import { requireOrgMembership, ORG_FINANCE_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

// ── Schema ───────────────────────────────────────────────────────────────────

export const initiateOnboardingOrgInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
    /**
     * Where Stripe redirects after completing onboarding. Same-origin
     * absolute URL or a root-relative path; resolved against `publicAppUrl`.
     */
    returnUrl: z.string().min(1).max(2_000),
    /** Where Stripe redirects if the link expires or the user refreshes. */
    refreshUrl: z.string().min(1).max(2_000),
  })
  .strict();

export const initiateOnboardingHumanInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    humanId: z.uuid(),
    /**
     * Where Stripe redirects after completing onboarding. Same-origin
     * absolute URL or a root-relative path; resolved against `publicAppUrl`.
     */
    returnUrl: z.string().min(1).max(2_000),
    /** Where Stripe redirects if the link expires or the user refreshes. */
    refreshUrl: z.string().min(1).max(2_000),
  })
  .strict();

export const initiateOnboardingInputSchema = z.union([
  initiateOnboardingOrgInputSchema,
  initiateOnboardingHumanInputSchema,
]);

export type InitiateOnboardingInput = z.infer<
  typeof initiateOnboardingInputSchema
>;

export const initiateOnboardingOutputSchema = z.object({
  payeeId: z.string(),
  stripeAccountId: z.string(),
  onboardingUrl: z.string().url(),
});

export type InitiateOnboardingOutput = z.infer<
  typeof initiateOnboardingOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type InitiateOnboardingDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
  /**
   * Reports a lost or failed release of the onboarding claim
   * (`abandonClaim`). Optional; a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort | null;
  /**
   * Our web app's base URL. `returnUrl` / `refreshUrl` must resolve onto its
   * origin (F16, 2026-09-29) — Stripe would otherwise send the user to any
   * site the caller named, on a Stripe-hosted page they trust.
   */
  publicAppUrl: string | null | undefined;
};

const IDEMPOTENCY_TTL_SECONDS = 120;
const IDEMPOTENCY_KEEP_SECONDS = 3 * 24 * 60 * 60;

type ConnectOwner = {
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  actorHumanId: string;
  businessType: "company" | "individual";
  logContext: { orgId: string } | { humanId: string };
};

type LinkedConnectAccount = {
  payeeId: string;
  stripeAccountId: string;
};

type PayeeLookupRepos = Pick<Repos, "payees">;

async function resolveConnectOwner(
  deps: InitiateOnboardingDeps,
  input: InitiateOnboardingInput,
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
      actorHumanId: input.actorHumanId,
      businessType: "company",
      logContext: { orgId: input.orgId },
    };
  }

  if (input.humanId !== input.actorHumanId) {
    throw fail("NOT_RESOURCE_OWNER");
  }

  // B2 (account squatting through guest checkout): an unverified account may
  // sit on someone else's address, and a payout account connected here keeps
  // receiving that Human's resale proceeds after the real owner reclaims it
  // (the unproven-account sweep never touches Payee). Prove the inbox first.
  await ensureEmailVerified(deps.repos, input.actorHumanId);

  return {
    subjectType: "HUMAN",
    subjectId: input.humanId,
    actorHumanId: input.actorHumanId,
    businessType: "individual",
    logContext: { humanId: input.humanId },
  };
}

async function getIndividualEmail(
  deps: InitiateOnboardingDeps,
  humanId: string,
): Promise<string | undefined> {
  const human = await deps.repos.humans.getByIdWithIdentity(humanId);
  const email = human?.identity.email.trim();
  return email ? email : undefined;
}

async function createAccountForOwner(
  deps: InitiateOnboardingDeps,
  owner: ConnectOwner,
  idempotencyKey: string,
): Promise<string> {
  const individualEmail =
    owner.subjectType === "HUMAN"
      ? await getIndividualEmail(deps, owner.subjectId)
      : undefined;

  const acct = await deps.payments.createConnectAccount({
    businessType: owner.businessType,
    idempotencyKey,
    ...(individualEmail ? { individualEmail } : {}),
  });
  return acct.accountId;
}

function buildOnboardingIdempotencyKey(owner: ConnectOwner): string {
  return `stripe-connect:onboarding:${owner.subjectType.toLowerCase()}:${owner.subjectId}`;
}

async function findLinkedConnectAccount(
  repos: PayeeLookupRepos,
  owner: ConnectOwner,
): Promise<LinkedConnectAccount | null> {
  const existingPayee = await repos.payees.getBySubject({
    type: owner.subjectType,
    id: owner.subjectId,
  });
  if (!existingPayee) return null;

  const payeeRecord = await repos.payees.getById(existingPayee.id);
  if (!payeeRecord?.stripeAccountId) return null;

  return {
    payeeId: payeeRecord.id,
    stripeAccountId: payeeRecord.stripeAccountId,
  };
}

async function linkConnectAccount(
  deps: InitiateOnboardingDeps,
  owner: ConnectOwner,
  stripeAccountId: string,
): Promise<LinkedConnectAccount> {
  return deps.repos.tx(async (tx) => {
    const existing = await findLinkedConnectAccount(tx, owner);
    if (existing) return existing;

    const payee = await tx.payees.upsertForSubject({
      subjectType: owner.subjectType,
      subjectId: owner.subjectId,
      stripeAccountId,
    });
    const linkedStripeAccountId = payee.stripeAccountId ?? stripeAccountId;

    await tx.audit.log({
      entity: "payee",
      entityId: payee.id,
      action: "payee.stripe_connect_account_linked",
      data: {
        actorHumanId: owner.actorHumanId,
        subjectType: owner.subjectType,
        subjectId: owner.subjectId,
        payeeId: payee.id,
        stripeAccountId: linkedStripeAccountId,
      },
      at: new Date(),
    });

    return {
      payeeId: payee.id,
      stripeAccountId: linkedStripeAccountId,
    };
  });
}

async function ensureLinkedConnectAccount(
  deps: InitiateOnboardingDeps,
  owner: ConnectOwner,
): Promise<LinkedConnectAccount> {
  const existing = await findLinkedConnectAccount(deps.repos, owner);
  if (existing) {
    deps.logger?.info("stripe_connect_reusing_existing_account", {
      ...owner.logContext,
      payeeId: existing.payeeId,
      stripeAccountId: existing.stripeAccountId,
    });
    return existing;
  }

  const idempotencyKey = buildOnboardingIdempotencyKey(owner);
  const replay =
    await deps.idempotency.get<LinkedConnectAccount>(idempotencyKey);
  if (replay) return replay;

  // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
  const claimOwnerToken = randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_TTL_SECONDS,
    claimOwnerToken,
  );
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<LinkedConnectAccount>(idempotencyKey);
    if (afterWait) return afterWait;

    const linked = await findLinkedConnectAccount(deps.repos, owner);
    if (linked) return linked;

    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  let linked: LinkedConnectAccount;
  try {
    const linkedAfterClaim = await findLinkedConnectAccount(deps.repos, owner);
    if (linkedAfterClaim) {
      linked = linkedAfterClaim;
    } else {
      const stripeAccountId = await createAccountForOwner(
        deps,
        owner,
        idempotencyKey,
      );
      linked = await linkConnectAccount(deps, owner, stripeAccountId);
    }
  } catch (error) {
    // Release, not `fail`: a `failed` record would lock the owner's retry
    // out for 15 minutes (lib/idempotency-claim.ts). A same-key retry is
    // safe: it re-sends the same Stripe idempotency key (Stripe returns the
    // account it already created) and `linkConnectAccount` is find-or-upsert.
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "initiateOnboarding",
      logger: deps.logger ?? null,
      reportError: deps.reportError ?? null,
    });
    throw asKnownError("stripe_connect_onboarding", error);
  }

  // Outside the abandon path: the Payee is linked, so a `commit` that throws
  // leaves the claim standing; a retry finds the linked Payee up front.
  await deps.idempotency.commit<LinkedConnectAccount>(
    idempotencyKey,
    linked,
    IDEMPOTENCY_KEEP_SECONDS,
  );

  return linked;
}

// ── Use case ─────────────────────────────────────────────────────────────────

export async function initiateOnboarding(
  deps: InitiateOnboardingDeps,
  rawInput: unknown,
): Promise<InitiateOnboardingOutput> {
  const input = parseInput(initiateOnboardingInputSchema, rawInput);
  const owner = await resolveConnectOwner(deps, input);

  // After RBAC (a non-member gets FORBIDDEN either way), before any side
  // effect: a refused URL must not leave a Payee row or Stripe account.
  const returnUrl = resolveAppRedirectUrl(input.returnUrl, deps.publicAppUrl);
  const refreshUrl = resolveAppRedirectUrl(input.refreshUrl, deps.publicAppUrl);

  // STRICT chargeback-terms gate. Ithas Fire is merchant of record, so the
  // repayment / payout-setoff obligation in these terms belongs at payout
  // setup. Runs after RBAC (a non-member must not learn the org's acceptance
  // state) and BEFORE any side effect — no Payee row, Stripe account, or
  // account link exists yet, so a rejection leaves nothing orphaned.
  // `resolveConnectOwner` already carries the ORGANIZATION | HUMAN
  // discriminant, so the risk owner is derived directly from it.
  await requireCurrentChargebackTermsForRiskOwner({
    repos: deps.repos,
    owner: { type: owner.subjectType, id: owner.subjectId },
  });

  const linkedAccount = await ensureLinkedConnectAccount(deps, owner);

  const link = await deps.payments.createAccountOnboardingLink({
    accountId: linkedAccount.stripeAccountId,
    returnUrl,
    refreshUrl,
  });

  deps.logger?.info("stripe_connect_onboarding_initiated", {
    ...owner.logContext,
    stripeAccountId: linkedAccount.stripeAccountId,
  });

  return {
    payeeId: linkedAccount.payeeId,
    stripeAccountId: linkedAccount.stripeAccountId,
    onboardingUrl: link.url,
  };
}
