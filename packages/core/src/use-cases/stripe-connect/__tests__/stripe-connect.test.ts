import { describe, expect, it, vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { PayeeRecord, PayeeSubjectType } from "@th/ports/repos/payees";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { CURRENT_CHARGEBACK_TERMS_VERSION } from "../../../lib/payments/chargeback-terms";
import { createConnectLoginLink } from "../create-connect-login-link";
import { getConnectStatus } from "../get-connect-status";
import { initiateOnboarding } from "../initiate-onboarding";

const ACTOR_HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const RETURN_URL = "https://example.com/return";
const REFRESH_URL = "https://example.com/refresh";

const subjectKey = (type: PayeeSubjectType, id: string) => `${type}:${id}`;

/**
 * Organizer chargeback-terms acceptance state for the owner being onboarded.
 * Onboarding is the STRICT gate: only `"current"` passes. `"stale"` is an
 * acceptance of an older version — enough for publish/checkout backstops,
 * not for payout setup.
 */
type ChargebackTermsState = "current" | "stale" | "none";
const STALE_CHARGEBACK_TERMS_VERSION = "2000-01-01";
const CHARGEBACK_ACCEPTED_AT = new Date("2024-12-15T00:00:00.000Z");

function chargebackTermsFields(state: ChargebackTermsState) {
  if (state === "none") {
    return {
      chargebackTermsVersion: null,
      chargebackTermsAcceptedAt: null,
      chargebackTermsAcceptedByHumanId: null,
    };
  }
  return {
    chargebackTermsVersion:
      state === "current"
        ? CURRENT_CHARGEBACK_TERMS_VERSION
        : STALE_CHARGEBACK_TERMS_VERSION,
    chargebackTermsAcceptedAt: CHARGEBACK_ACCEPTED_AT,
    chargebackTermsAcceptedByHumanId: ACTOR_HUMAN_ID,
  };
}

function makePayee(overrides: Partial<PayeeRecord>): PayeeRecord {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    stripeAccountId: null,
    status: "PENDING",
    payoutsEnabled: false,
    chargesEnabled: false,
    defaultCurrency: "usd",
    resaleNegativeBalanceCents: 0,
    resaleNegativeBalanceOpenedAt: null,
    resaleNegativeBalanceAgingStartsAt: null,
    resalePayoutBlockReason: null,
    resalePayoutBlockedAt: null,
    ...overrides,
  };
}

function makeDeps(options?: {
  payees?: PayeeRecord[];
  humanEmail?: string | null;
  /** The actor's AuthUser.emailVerified; defaults to true (B2 gate open). */
  emailVerified?: boolean;
  idempotency?: IdempotencyPort;
  failNextPayeeUpsert?: boolean;
  /** Defaults to `"current"` so the pre-existing onboarding paths are ungated. */
  chargebackTerms?: ChargebackTermsState;
}) {
  const chargebackTerms = chargebackTermsFields(
    options?.chargebackTerms ?? "current",
  );
  const payeesById = new Map<string, PayeeRecord>();
  const payeeSubjects = new Map<string, string>();
  const connectAccountsByKey = new Map<string, string>();
  let failNextPayeeUpsert = options?.failNextPayeeUpsert ?? false;

  for (const payee of options?.payees ?? []) {
    payeesById.set(payee.id, payee);
    payeeSubjects.set(subjectKey(payee.subjectType, payee.subjectId), payee.id);
  }

  const authz = {
    getOrgMembership: vi.fn(async () => ({ role: "OWNER" })),
  };
  const audit = { log: vi.fn(async () => undefined) };

  const payees = {
    getBySubject: vi.fn(async (input: { type: PayeeSubjectType; id: string }) => {
      const payeeId = payeeSubjects.get(subjectKey(input.type, input.id));
      return payeeId ? { id: payeeId } : null;
    }),
    getById: vi.fn(async (id: string) => payeesById.get(id) ?? null),
    // `getConnectStatus` writes live Stripe state back through this so the
    // publish gate (which reads the Payee row) can't drift from what the
    // Payments page shows. It MUST report an outcome: `getConnectStatus`
    // returns the row's values instead of Stripe's whenever the write was
    // skipped, so a fake that returns `undefined` reads as "not written".
    syncCapabilities: vi.fn(async () => "applied" as const),
    upsertForSubject: vi.fn(
      async (input: {
        subjectType: PayeeSubjectType;
        subjectId: string;
        stripeAccountId?: string | null;
      }) => {
        if (failNextPayeeUpsert) {
          failNextPayeeUpsert = false;
          throw new Error("payee_write_failed");
        }

        const key = subjectKey(input.subjectType, input.subjectId);
        const id =
          payeeSubjects.get(key) ??
          `00000000-0000-4000-8000-${String(payeesById.size + 1).padStart(12, "0")}`;
        const existing = payeesById.get(id);
        const payee = makePayee({
          ...existing,
          id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          stripeAccountId: input.stripeAccountId ?? null,
        });
        payeesById.set(id, payee);
        payeeSubjects.set(key, id);
        return payee;
      },
    ),
  };

  const humans = {
    getById: vi.fn(async (humanId: string) =>
      humanId === ACTOR_HUMAN_ID
        ? {
            id: humanId,
            chargebackTermsVersion: chargebackTerms.chargebackTermsVersion,
            chargebackTermsAcceptedAt: chargebackTerms.chargebackTermsAcceptedAt,
          }
        : null,
    ),
    getByIdWithIdentity: vi.fn(async (humanId: string) => ({
      human: { id: humanId },
      identity: {
        email: options?.humanEmail ?? "actor@example.com",
        emailVerified: options?.emailVerified ?? true,
      },
    })),
  };

  const organizations = {
    getById: vi.fn(async (orgId: string) =>
      orgId === ORG_ID ? { id: orgId, ...chargebackTerms } : null,
    ),
  };

  const tx = vi.fn(
    async (fn: (txRepos: { payees: typeof payees; audit: typeof audit }) => any) =>
      fn({ payees, audit }),
  );

  const repos = {
    tx,
    authz,
    payees,
    humans,
    organizations,
    audit,
  } as unknown as Repos;

  const idempotency = options?.idempotency ?? createFakeIdempotencyPort();

  const payments = {
    createConnectAccount: vi.fn(async (input) => ({
      accountId: (() => {
        const fallbackAccountId =
          input.businessType === "individual" ? "acct_human" : "acct_org";
        if (!input.idempotencyKey) return fallbackAccountId;
        const existing = connectAccountsByKey.get(input.idempotencyKey);
        if (existing) return existing;
        connectAccountsByKey.set(input.idempotencyKey, fallbackAccountId);
        return fallbackAccountId;
      })(),
    })),
    createAccountOnboardingLink: vi.fn(async () => ({
      url: "https://connect.stripe.com/setup/test",
    })),
    createConnectLoginLink: vi.fn(async () => ({
      url: "https://connect.stripe.com/express/test",
    })),
    getConnectAccountStatus: vi.fn(async () => ({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], eventuallyDue: [], pastDue: [] },
    })),
  } as unknown as PaymentProcessorPort;

  return {
    repos,
    payments,
    idempotency,
    publicAppUrl: "https://example.com",
    mocks: {
      authz,
      payees,
      humans,
      organizations,
      audit,
      payments,
      tx,
      idempotency,
      connectAccountsByKey,
    },
  };
}

describe("stripe connect use cases", () => {
  it("initiates org onboarding with membership check and company account", async () => {
    const deps = makeDeps();

    const result = await initiateOnboarding(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      orgId: ORG_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    });

    expect(result).toEqual({
      payeeId: "00000000-0000-4000-8000-000000000001",
      stripeAccountId: "acct_org",
      onboardingUrl: "https://connect.stripe.com/setup/test",
    });
    expect(deps.mocks.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_HUMAN_ID,
    });
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenCalledWith({
      businessType: "company",
      idempotencyKey: `stripe-connect:onboarding:organization:${ORG_ID}`,
    });
    expect(deps.mocks.payees.upsertForSubject).toHaveBeenCalledWith({
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      stripeAccountId: "acct_org",
    });
    expect(deps.mocks.audit.log).toHaveBeenCalledTimes(1);
    expect(deps.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "payee",
        entityId: "00000000-0000-4000-8000-000000000001",
        action: "payee.stripe_connect_account_linked",
        data: expect.objectContaining({
          actorHumanId: ACTOR_HUMAN_ID,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          payeeId: "00000000-0000-4000-8000-000000000001",
          stripeAccountId: "acct_org",
        }),
        at: expect.any(Date),
      }),
    );
    expect(deps.mocks.humans.getByIdWithIdentity).not.toHaveBeenCalled();
    // The strict chargeback-terms gate read the org's acceptance before
    // any Stripe call.
    expect(deps.mocks.organizations.getById).toHaveBeenCalledWith(ORG_ID);
  });

  it("initiates human onboarding for the actor with an individual account", async () => {
    const deps = makeDeps({ humanEmail: "organizer@example.com" });

    const result = await initiateOnboarding(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    });

    expect(result.stripeAccountId).toBe("acct_human");
    expect(deps.mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(deps.mocks.humans.getByIdWithIdentity).toHaveBeenCalledWith(
      ACTOR_HUMAN_ID,
    );
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenCalledWith({
      businessType: "individual",
      idempotencyKey: `stripe-connect:onboarding:human:${ACTOR_HUMAN_ID}`,
      individualEmail: "organizer@example.com",
    });
    expect(deps.mocks.payees.upsertForSubject).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: ACTOR_HUMAN_ID,
      stripeAccountId: "acct_human",
    });
  });

  // B2: a squatter on an unverified account must not connect their own bank
  // to the Human that guest checkout attached someone else's tickets to.
  it("refuses human onboarding for an unverified account before any Stripe call", async () => {
    const deps = makeDeps({ emailVerified: false });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(deps.mocks.payments.createConnectAccount).not.toHaveBeenCalled();
    expect(deps.mocks.payees.upsertForSubject).not.toHaveBeenCalled();
  });

  it("org onboarding does not consult the actor's email verification", async () => {
    const deps = makeDeps({ emailVerified: false });

    const result = await initiateOnboarding(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      orgId: ORG_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    });

    expect(result.stripeAccountId).toBe("acct_org");
  });

  it("reuses an existing human Stripe account", async () => {
    const existingPayee = makePayee({
      id: "00000000-0000-4000-8000-000000000099",
      subjectType: "HUMAN",
      subjectId: ACTOR_HUMAN_ID,
      stripeAccountId: "acct_existing",
    });
    const deps = makeDeps({ payees: [existingPayee] });

    const result = await initiateOnboarding(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    });

    expect(result).toMatchObject({
      payeeId: existingPayee.id,
      stripeAccountId: "acct_existing",
    });
    expect(deps.mocks.payments.createConnectAccount).not.toHaveBeenCalled();
    expect(deps.mocks.payees.upsertForSubject).not.toHaveBeenCalled();
    expect(deps.mocks.audit.log).not.toHaveBeenCalled();
    expect(deps.mocks.tx).not.toHaveBeenCalled();
  });

  it("retries onboarding after a Payee write failure with the same provider idempotency key", async () => {
    const deps = makeDeps({ failNextPayeeUpsert: true });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "stripe_connect_onboarding",
    });

    const result = await initiateOnboarding(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    });

    expect(result).toMatchObject({
      payeeId: "00000000-0000-4000-8000-000000000001",
      stripeAccountId: "acct_human",
    });
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenCalledTimes(2);
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: `stripe-connect:onboarding:human:${ACTOR_HUMAN_ID}`,
      }),
    );
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: `stripe-connect:onboarding:human:${ACTOR_HUMAN_ID}`,
      }),
    );
    expect(deps.mocks.connectAccountsByKey.size).toBe(1);
    expect(deps.mocks.payees.upsertForSubject).toHaveBeenCalledTimes(2);
    expect(deps.mocks.tx).toHaveBeenCalledTimes(2);
  });

  it("releases (never fails) the onboarding claim on a Payee write failure", async () => {
    const idempotency = createFakeIdempotencyPort();
    const deps = makeDeps({ failNextPayeeUpsert: true, idempotency });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    expect(idempotency.__mocks.release).toHaveBeenCalledWith(
      `stripe-connect:onboarding:human:${ACTOR_HUMAN_ID}`,
      expect.any(String),
    );
    expect(idempotency.__mocks.fail).not.toHaveBeenCalled();
  });

  it("a commit that throws after the Payee is linked keeps the claim; the retry finds the linked Payee, no second Stripe account", async () => {
    const idempotency = createFakeIdempotencyPort();
    idempotency.__mocks.commit.mockRejectedValueOnce(
      new Error("idempotency_store_down"),
    );
    const deps = makeDeps({ idempotency });
    const input = {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    };

    await expect(initiateOnboarding(deps, input)).rejects.toThrow(
      "idempotency_store_down",
    );
    expect(idempotency.__mocks.release).not.toHaveBeenCalled();
    expect(idempotency.__mocks.fail).not.toHaveBeenCalled();

    const result = await initiateOnboarding(deps, input);
    expect(result.stripeAccountId).toBe("acct_human");
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenCalledTimes(1);
  });

  it("reuses one Payee link and Stripe account for repeated owner onboarding", async () => {
    const deps = makeDeps();
    const input = {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    };

    const first = await initiateOnboarding(deps, input);
    const second = await initiateOnboarding(deps, input);

    expect(second).toMatchObject({
      payeeId: first.payeeId,
      stripeAccountId: first.stripeAccountId,
    });
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenCalledTimes(1);
    expect(deps.mocks.payees.upsertForSubject).toHaveBeenCalledTimes(1);
    expect(deps.mocks.audit.log).toHaveBeenCalledTimes(1);
    expect(deps.mocks.tx).toHaveBeenCalledTimes(1);
    expect(deps.mocks.connectAccountsByKey.size).toBe(1);
  });

  it("rejects concurrent onboarding while the owner idempotency lock is in progress", async () => {
    const idempotency = createFakeIdempotencyPort({ beginSequence: [false] });
    const deps = makeDeps({ idempotency });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });

    expect(deps.mocks.payments.createConnectAccount).not.toHaveBeenCalled();
    expect(deps.mocks.payees.upsertForSubject).not.toHaveBeenCalled();
    expect(deps.mocks.tx).not.toHaveBeenCalled();
  });

  // F16 (2026-09-29): Stripe redirects only ever land back on our origin.
  it("refuses a foreign returnUrl before creating any Stripe account", async () => {
    const deps = makeDeps();
    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
        returnUrl: "https://evil.example/phish",
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "redirect_url_not_allowed",
    });
    expect(deps.mocks.payments.createConnectAccount).not.toHaveBeenCalled();
    expect(
      deps.mocks.payments.createAccountOnboardingLink,
    ).not.toHaveBeenCalled();
  });

  it("resolves root-relative redirect paths against publicAppUrl", async () => {
    const deps = makeDeps();
    await initiateOnboarding(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
      returnUrl: "/admin/me/payments?tab=stripe",
      refreshUrl: "/admin/me/payments",
    });
    expect(
      deps.mocks.payments.createAccountOnboardingLink,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: "https://example.com/admin/me/payments?tab=stripe",
        refreshUrl: "https://example.com/admin/me/payments",
      }),
    );
  });

  it("rejects initiating onboarding for another human", async () => {
    const deps = makeDeps();

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: OTHER_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(deps.mocks.payments.createConnectAccount).not.toHaveBeenCalled();
  });

  it("rejects reading connect status for another human", async () => {
    const deps = makeDeps();

    await expect(
      getConnectStatus(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: OTHER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(deps.mocks.payments.getConnectAccountStatus).not.toHaveBeenCalled();
  });

  it("reads org connect status with membership check", async () => {
    const existingPayee = makePayee({
      id: "00000000-0000-4000-8000-000000000088",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      stripeAccountId: "acct_org_status",
    });
    const deps = makeDeps({ payees: [existingPayee] });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      orgId: ORG_ID,
    });

    expect(result).toMatchObject({
      connected: true,
      stripeAccountId: "acct_org_status",
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    expect(deps.mocks.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_HUMAN_ID,
    });
    expect(deps.mocks.payees.getBySubject).toHaveBeenCalledWith({
      type: "ORGANIZATION",
      id: ORG_ID,
    });
  });

  it("reads human connect status without org membership", async () => {
    const existingPayee = makePayee({
      id: "00000000-0000-4000-8000-000000000077",
      subjectType: "HUMAN",
      subjectId: ACTOR_HUMAN_ID,
      stripeAccountId: "acct_human_status",
    });
    const deps = makeDeps({ payees: [existingPayee] });

    const result = await getConnectStatus(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(result).toMatchObject({
      connected: true,
      stripeAccountId: "acct_human_status",
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    expect(deps.mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(deps.mocks.payees.getBySubject).toHaveBeenCalledWith({
      type: "HUMAN",
      id: ACTOR_HUMAN_ID,
    });
  });

  it("creates an Express dashboard login link for a payout-enabled org", async () => {
    const existingPayee = makePayee({
      id: "00000000-0000-4000-8000-000000000099",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      stripeAccountId: "acct_org_payouts",
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
    });
    const deps = makeDeps({ payees: [existingPayee] });

    const result = await createConnectLoginLink(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      orgId: ORG_ID,
    });

    expect(result).toEqual({ url: "https://connect.stripe.com/express/test" });
    expect(deps.mocks.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_HUMAN_ID,
    });
    expect(deps.mocks.payments.createConnectLoginLink).toHaveBeenCalledWith({
      accountId: "acct_org_payouts",
    });
  });

  // Decision of 2026-10-10: the Express dashboard is finance-only
  // (ORG_FINANCE_ROLES). An Editor used to get the link.
  function payoutEnabledOrgPayee() {
    return makePayee({
      id: "00000000-0000-4000-8000-000000000099",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      stripeAccountId: "acct_org_payouts",
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
    });
  }

  it.each(["OWNER", "ADMIN", "FINANCE"])(
    "gives %s the org's login link",
    async (role) => {
      const deps = makeDeps({ payees: [payoutEnabledOrgPayee()] });
      deps.mocks.authz.getOrgMembership.mockResolvedValue({ role });

      const result = await createConnectLoginLink(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        orgId: ORG_ID,
      });

      expect(result).toEqual({ url: "https://connect.stripe.com/express/test" });
      expect(deps.mocks.payments.createConnectLoginLink).toHaveBeenCalledWith({
        accountId: "acct_org_payouts",
      });
    },
  );

  it.each(["EDITOR", "SCANNER", "VIEWER"])(
    "refuses %s the org's login link with INSUFFICIENT_ROLE, before the payee is read",
    async (role) => {
      const deps = makeDeps({ payees: [payoutEnabledOrgPayee()] });
      deps.mocks.authz.getOrgMembership.mockResolvedValue({ role });

      await expect(
        createConnectLoginLink(deps, {
          actorHumanId: ACTOR_HUMAN_ID,
          orgId: ORG_ID,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(deps.mocks.payees.getBySubject).not.toHaveBeenCalled();
      expect(deps.mocks.payments.createConnectLoginLink).not.toHaveBeenCalled();
    },
  );

  it("gives a human their own login link without an org membership lookup", async () => {
    const ownPayee = makePayee({
      id: "00000000-0000-4000-8000-0000000000c1",
      subjectType: "HUMAN",
      subjectId: ACTOR_HUMAN_ID,
      stripeAccountId: "acct_human_payouts",
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
    });
    const deps = makeDeps({ payees: [ownPayee] });
    // No org role is consulted on the human branch, whatever the actor holds.
    deps.mocks.authz.getOrgMembership.mockResolvedValue({ role: "EDITOR" });

    const result = await createConnectLoginLink(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      humanId: ACTOR_HUMAN_ID,
    });

    expect(result).toEqual({ url: "https://connect.stripe.com/express/test" });
    expect(deps.mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(deps.mocks.payees.getBySubject).toHaveBeenCalledWith({
      type: "HUMAN",
      id: ACTOR_HUMAN_ID,
    });
    expect(deps.mocks.payments.createConnectLoginLink).toHaveBeenCalledWith({
      accountId: "acct_human_payouts",
    });
  });

  it("refuses a human login link for an unverified account (B2)", async () => {
    const ownPayee = makePayee({
      id: "00000000-0000-4000-8000-0000000000c2",
      subjectType: "HUMAN",
      subjectId: ACTOR_HUMAN_ID,
      stripeAccountId: "acct_human_payouts",
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
    });
    const deps = makeDeps({ payees: [ownPayee], emailVerified: false });

    await expect(
      createConnectLoginLink(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(deps.mocks.payments.createConnectLoginLink).not.toHaveBeenCalled();
  });

  it("rejects login link when the owner has no connected account", async () => {
    const deps = makeDeps();

    await expect(
      createConnectLoginLink(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(deps.mocks.payments.createConnectLoginLink).not.toHaveBeenCalled();
  });

  it("rejects login link when payouts are not yet enabled", async () => {
    const existingPayee = makePayee({
      id: "00000000-0000-4000-8000-0000000000b1",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      stripeAccountId: "acct_org_pending",
      payoutsEnabled: false,
    });
    const deps = makeDeps({ payees: [existingPayee] });

    await expect(
      createConnectLoginLink(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "PAYOUTS_NOT_ENABLED" });
    expect(deps.mocks.payments.createConnectLoginLink).not.toHaveBeenCalled();
  });

  it("rejects login link for another human", async () => {
    const deps = makeDeps();

    await expect(
      createConnectLoginLink(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: OTHER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(deps.mocks.payments.createConnectLoginLink).not.toHaveBeenCalled();
  });
});
// ---------------------------------------------------------------------------
// Chargeback-terms gate at payout setup
// ---------------------------------------------------------------------------

/**
 * Ithas Fire is merchant of record, so the organizer chargeback terms
 * (repayment + payout setoff) are accepted at Stripe Connect onboarding —
 * the STRICT, current-version gate. Publish and checkout only keep a
 * version-agnostic backstop. A rejection here must leave NO side effect:
 * no Payee row, no Stripe account, no account link, no idempotency claim.
 */
describe("initiateOnboarding — strict chargeback-terms gate", () => {
  function expectNoSideEffects(deps: ReturnType<typeof makeDeps>) {
    expect(deps.mocks.payments.createConnectAccount).not.toHaveBeenCalled();
    expect(
      deps.mocks.payments.createAccountOnboardingLink,
    ).not.toHaveBeenCalled();
    expect(deps.mocks.payees.upsertForSubject).not.toHaveBeenCalled();
    expect(deps.mocks.audit.log).not.toHaveBeenCalled();
    expect(deps.mocks.tx).not.toHaveBeenCalled();
    expect(deps.mocks.idempotency.begin).not.toHaveBeenCalled();
  }

  it("rejects org onboarding when the org has never accepted the terms", async () => {
    const deps = makeDeps({ chargebackTerms: "none" });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        orgId: ORG_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "chargeback_terms_required",
      message: "chargeback_terms_required",
      requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      owner: { type: "ORGANIZATION", id: ORG_ID },
      // The client only ever sees `meta` (toTrpcError forwards nothing else).
      meta: {
        owner: { type: "ORGANIZATION", id: ORG_ID },
        requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      },
    });

    // RBAC ran first — a non-member never learns the org's acceptance state.
    expect(deps.mocks.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_HUMAN_ID,
    });
    expectNoSideEffects(deps);
  });

  it("rejects org onboarding when the org accepted only a stale version", async () => {
    const deps = makeDeps({ chargebackTerms: "stale" });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        orgId: ORG_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "chargeback_terms_required",
      requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      owner: { type: "ORGANIZATION", id: ORG_ID },
    });

    expectNoSideEffects(deps);
  });

  it("rejects human onboarding when the human has never accepted the terms", async () => {
    const deps = makeDeps({ chargebackTerms: "none" });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "chargeback_terms_required",
      requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      owner: { type: "HUMAN", id: ACTOR_HUMAN_ID },
      meta: {
        owner: { type: "HUMAN", id: ACTOR_HUMAN_ID },
        requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      },
    });

    expect(deps.mocks.humans.getById).toHaveBeenCalledWith(ACTOR_HUMAN_ID);
    expectNoSideEffects(deps);
  });

  it("rejects human onboarding when the human accepted only a stale version", async () => {
    const deps = makeDeps({ chargebackTerms: "stale" });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        humanId: ACTOR_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "chargeback_terms_required",
      owner: { type: "HUMAN", id: ACTOR_HUMAN_ID },
    });

    expectNoSideEffects(deps);
  });

  it("does not mint a fresh onboarding link for an already-linked owner with a stale acceptance", async () => {
    // Re-entering onboarding (e.g. an expired link) is still payout setup:
    // the strict gate applies even when the Stripe account already exists.
    const existingPayee = makePayee({
      id: "00000000-0000-4000-8000-0000000000c1",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      stripeAccountId: "acct_existing_org",
    });
    const deps = makeDeps({ payees: [existingPayee], chargebackTerms: "stale" });

    await expect(
      initiateOnboarding(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        orgId: ORG_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({ code: "chargeback_terms_required" });

    expect(
      deps.mocks.payments.createAccountOnboardingLink,
    ).not.toHaveBeenCalled();
    expect(deps.mocks.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("allows onboarding once the current version is accepted", async () => {
    const deps = makeDeps({ chargebackTerms: "current" });

    const result = await initiateOnboarding(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      orgId: ORG_ID,
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    });

    expect(result.onboardingUrl).toBe("https://connect.stripe.com/setup/test");
    expect(deps.mocks.organizations.getById).toHaveBeenCalledWith(ORG_ID);
    expect(deps.mocks.payments.createConnectAccount).toHaveBeenCalledTimes(1);
    expect(
      deps.mocks.payments.createAccountOnboardingLink,
    ).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Deliberate-swallow reporting (repo error convention)
// ---------------------------------------------------------------------------

/**
 * `getConnectStatus` catches a Stripe failure and returns the last-known DB
 * values instead of throwing. Per the repo's error convention that swallow MUST
 * call `reportError` — `logger.warn` is not captured by Sentry, and before this
 * was wired a Stripe outage silently served stale connect state everywhere with
 * zero visibility (it also feeds the publish gate).
 *
 * These tests exist so deleting the `reportError` call fails CI rather than
 * quietly re-opening that blind spot.
 */
describe("getConnectStatus — deliberate swallow is reported", () => {
  const STALE_ACCOUNT = "acct_stale_status";

  function makeDegradedDeps() {
    // Payee row says NOT ready; the live-Stripe mock says ready. So if the
    // result comes back `false/false`, it provably came from the DB fallback
    // and not from Stripe.
    const payee = makePayee({
      id: "00000000-0000-4000-8000-0000000000f1",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      stripeAccountId: STALE_ACCOUNT,
      status: "ACTIVE",
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    const deps = makeDeps({ payees: [payee] });
    (
      deps.mocks.payments.getConnectAccountStatus as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("stripe_unreachable"));
    return deps;
  }

  it("reports to Sentry and degrades to the stored Payee values", async () => {
    const deps = makeDegradedDeps();
    const reportError = vi.fn();

    const result = await getConnectStatus(
      { ...deps, reportError },
      { actorHumanId: ACTOR_HUMAN_ID, orgId: ORG_ID },
    );

    // Degraded, not thrown, and sourced from the DB row (false/false).
    expect(result).toMatchObject({
      connected: true,
      stripeAccountId: STALE_ACCOUNT,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: null,
      requirements: null,
    });

    // The swallow is visible.
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reportedErr, context] = reportError.mock.calls[0]!;
    expect(reportedErr).toBeInstanceOf(Error);
    expect((reportedErr as Error).message).toBe("stripe_unreachable");
    expect(context).toMatchObject({
      tags: { area: "stripe-connect", op: "get-connect-status" },
      extra: { stripeAccountId: STALE_ACCOUNT },
    });
  });

  it("still returns the degraded result when the reporter itself throws", async () => {
    const deps = makeDegradedDeps();
    const reportError = vi.fn(() => {
      throw new Error("sentry_down");
    });

    // A throwing reporter must never change behaviour — the guard around the
    // report is load-bearing, not decorative.
    const result = await getConnectStatus(
      { ...deps, reportError },
      { actorHumanId: ACTOR_HUMAN_ID, orgId: ORG_ID },
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      connected: true,
      chargesEnabled: false,
      payoutsEnabled: false,
    });
  });
});
