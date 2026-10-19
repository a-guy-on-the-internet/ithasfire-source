import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import {
  CURRENT_CHARGEBACK_TERMS_VERSION,
  getCurrentChargebackTermsSnapshot,
} from "../../../lib/payments/chargeback-terms";
import {
  acceptChargebackTerms,
  type AcceptChargebackTermsDeps,
} from "../accept-chargeback-terms";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

/** An acceptance recorded BEFORE `now`, so an overwrite is observable. */
const PRIOR_ACCEPTED_AT = new Date("2025-11-02T09:30:00.000Z");
const STALE_VERSION = "2000-01-01";

type ExistingAcceptance = "current" | "stale";

function makeContext(
  options: {
    membershipRole?: OrgRole | null;
    /** Seed the org AND human rows with a prior acceptance. */
    existingAcceptance?: ExistingAcceptance;
  } = {},
) {
  const now = new Date("2026-05-15T12:00:00.000Z");
  const existingVersion =
    options.existingAcceptance === "current"
      ? CURRENT_CHARGEBACK_TERMS_VERSION
      : options.existingAcceptance === "stale"
        ? STALE_VERSION
        : null;
  const existingAcceptedAt = existingVersion ? PRIOR_ACCEPTED_AT : null;
  const membershipRole = Object.prototype.hasOwnProperty.call(
    options,
    "membershipRole",
  )
    ? (options.membershipRole ?? null)
    : "ADMIN";

  const organization: OrganizationRecord = {
    id: ORG_ID,
    name: "Host Org",
    slug: "host-org",
    status: "ACTIVE",
    defaultLocale: null,
    contactEmail: null,
    physicalAddress: null,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW",
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    chargebackTermsVersion: existingVersion,
    chargebackTermsAcceptedAt: existingAcceptedAt,
    chargebackTermsAcceptedByHumanId: existingVersion ? OTHER_HUMAN_ID : null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  const human: HumanRecord = {
    id: ACTOR_ID,
    name: "Solo Host",
    status: "ACTIVE",
    roles: [],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW",
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    chargebackTermsVersion: existingVersion,
    chargebackTermsAcceptedAt: existingAcceptedAt,
    jobs: [],
    genreTags: [],
    otherJobDescription: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  const organizations = {
    getById: vi.fn(async (id: string) =>
      id === ORG_ID ? { ...organization } : null,
    ),
    acceptChargebackTerms: vi.fn(async (input) => ({
      ...organization,
      chargebackTermsVersion: input.version,
      chargebackTermsAcceptedAt: input.acceptedAt,
      chargebackTermsAcceptedByHumanId: input.acceptedByHumanId,
    })),
  };

  const humans = {
    getById: vi.fn(async (id: string) =>
      id === ACTOR_ID ? { ...human } : null,
    ),
    acceptChargebackTerms: vi.fn(async (input) => ({
      ...human,
      chargebackTermsVersion: input.version,
      chargebackTermsAcceptedAt: input.acceptedAt,
    })),
  };

  const authz = {
    getOrgMembership: vi.fn(async () => {
      if (!membershipRole) return null;
      return { orgId: ORG_ID, humanId: ACTOR_ID, role: membershipRole };
    }),
  };

  const audit = {
    log: vi.fn(async () => undefined),
  };

  const acceptances = {
    findCurrent: vi.fn(async () => null),
    create: vi.fn(async (input) => ({
      id: "acc-1",
      humanId: input.humanId,
      documentType: input.documentType,
      documentVersion: input.documentVersion,
      documentTextSnapshot: input.documentTextSnapshot,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      acceptedAt: input.acceptedAt ?? new Date(),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ?? null,
    })),
  };

  const txRepos = {
    organizations,
    humans,
    authz,
    audit,
    acceptances,
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos)),
  } as unknown as Repos;

  const deps: AcceptChargebackTermsDeps = {
    repos,
    clock: { now: () => now },
    logger: createTestLogger(),
  };

  return { deps, repos, organizations, humans, authz, audit, acceptances, now };
}

describe("acceptChargebackTerms", () => {
  it.each(["OWNER", "ADMIN"] as const)(
    "allows an org %s to accept current chargeback terms",
    async (membershipRole) => {
      const ctx = makeContext({ membershipRole });
      const terms = getCurrentChargebackTermsSnapshot();

      const result = await acceptChargebackTerms(ctx.deps, {
        actorHumanId: ACTOR_ID,
        target: { type: "ORGANIZATION", orgId: ORG_ID },
      });

      expect(result).toEqual({
        ok: true,
        targetType: "ORGANIZATION",
        targetId: ORG_ID,
        acceptedAt: ctx.now,
        terms,
        alreadyAccepted: false,
      });
      expect(ctx.organizations.acceptChargebackTerms).toHaveBeenCalledWith({
        orgId: ORG_ID,
        version: CURRENT_CHARGEBACK_TERMS_VERSION,
        acceptedAt: ctx.now,
        acceptedByHumanId: ACTOR_ID,
      });
      expect(ctx.audit.log).toHaveBeenCalledWith({
        entity: "organization",
        entityId: ORG_ID,
        action: "organization.chargeback_terms_accepted",
        data: { actorHumanId: ACTOR_ID, terms },
        at: ctx.now,
      });
      expect(ctx.acceptances.create).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: ACTOR_ID,
          documentType: "CHARGEBACK_TERMS_ORGANIZER",
          documentVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
          scopeType: "ORGANIZATION",
          scopeId: ORG_ID,
          acceptedAt: ctx.now,
        }),
      );
      expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects org editors", async () => {
    const ctx = makeContext({ membershipRole: "EDITOR" });

    await expect(
      acceptChargebackTerms(ctx.deps, {
        actorHumanId: ACTOR_ID,
        target: { type: "ORGANIZATION", orgId: ORG_ID },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(ctx.organizations.acceptChargebackTerms).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("allows a direct human owner to accept current chargeback terms", async () => {
    const ctx = makeContext();
    const terms = getCurrentChargebackTermsSnapshot();

    const result = await acceptChargebackTerms(ctx.deps, {
      actorHumanId: ACTOR_ID,
      target: { type: "HUMAN", humanId: ACTOR_ID },
    });

    expect(result).toEqual({
      ok: true,
      targetType: "HUMAN",
      targetId: ACTOR_ID,
      acceptedAt: ctx.now,
      terms,
      alreadyAccepted: false,
    });
    expect(ctx.humans.acceptChargebackTerms).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      version: CURRENT_CHARGEBACK_TERMS_VERSION,
      acceptedAt: ctx.now,
    });
    expect(ctx.audit.log).toHaveBeenCalledWith({
      entity: "human",
      entityId: ACTOR_ID,
      action: "human.chargeback_terms_accepted",
      data: { actorHumanId: ACTOR_ID, terms },
      at: ctx.now,
    });
    expect(ctx.acceptances.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        documentType: "CHARGEBACK_TERMS_ORGANIZER",
        documentVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
        scopeType: "GLOBAL",
        scopeId: null,
        acceptedAt: ctx.now,
      }),
    );
  });

  // ── Idempotency for the CURRENT version ───────────────────────────────
  // The payments page may call accept on a returning owner. Re-running must
  // not overwrite the legal `acceptedAt` nor add a second audit row. A STALE
  // version is the re-bind path and still overwrites.

  it("org: an existing CURRENT acceptance is returned untouched — no column, audit, or ledger write", async () => {
    const ctx = makeContext({ existingAcceptance: "current" });
    const terms = getCurrentChargebackTermsSnapshot();

    const result = await acceptChargebackTerms(ctx.deps, {
      actorHumanId: ACTOR_ID,
      target: { type: "ORGANIZATION", orgId: ORG_ID },
    });

    expect(result).toEqual({
      ok: true,
      targetType: "ORGANIZATION",
      targetId: ORG_ID,
      acceptedAt: PRIOR_ACCEPTED_AT,
      terms,
      alreadyAccepted: true,
    });
    expect(result.acceptedAt).not.toEqual(ctx.now);
    expect(ctx.organizations.acceptChargebackTerms).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(ctx.acceptances.create).not.toHaveBeenCalled();
    // Still an admin-only mutation even on the no-op path.
    expect(ctx.authz.getOrgMembership).toHaveBeenCalledTimes(1);
  });

  it("org: a STALE acceptance is re-accepted and overwritten (re-bind path)", async () => {
    const ctx = makeContext({ existingAcceptance: "stale" });
    const terms = getCurrentChargebackTermsSnapshot();

    const result = await acceptChargebackTerms(ctx.deps, {
      actorHumanId: ACTOR_ID,
      target: { type: "ORGANIZATION", orgId: ORG_ID },
    });

    expect(result).toEqual({
      ok: true,
      targetType: "ORGANIZATION",
      targetId: ORG_ID,
      acceptedAt: ctx.now,
      terms,
      alreadyAccepted: false,
    });
    expect(ctx.organizations.acceptChargebackTerms).toHaveBeenCalledWith({
      orgId: ORG_ID,
      version: CURRENT_CHARGEBACK_TERMS_VERSION,
      acceptedAt: ctx.now,
      acceptedByHumanId: ACTOR_ID,
    });
    expect(ctx.audit.log).toHaveBeenCalledTimes(1);
    expect(ctx.acceptances.create).toHaveBeenCalledTimes(1);
  });

  it("org: editors are still refused on the already-accepted path", async () => {
    const ctx = makeContext({
      existingAcceptance: "current",
      membershipRole: "EDITOR",
    });

    await expect(
      acceptChargebackTerms(ctx.deps, {
        actorHumanId: ACTOR_ID,
        target: { type: "ORGANIZATION", orgId: ORG_ID },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("human: an existing CURRENT acceptance is returned untouched — no column, audit, or ledger write", async () => {
    const ctx = makeContext({ existingAcceptance: "current" });
    const terms = getCurrentChargebackTermsSnapshot();

    const result = await acceptChargebackTerms(ctx.deps, {
      actorHumanId: ACTOR_ID,
      target: { type: "HUMAN", humanId: ACTOR_ID },
    });

    expect(result).toEqual({
      ok: true,
      targetType: "HUMAN",
      targetId: ACTOR_ID,
      acceptedAt: PRIOR_ACCEPTED_AT,
      terms,
      alreadyAccepted: true,
    });
    expect(ctx.humans.acceptChargebackTerms).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(ctx.acceptances.create).not.toHaveBeenCalled();
  });

  it("human: a STALE acceptance is re-accepted and overwritten (re-bind path)", async () => {
    const ctx = makeContext({ existingAcceptance: "stale" });

    const result = await acceptChargebackTerms(ctx.deps, {
      actorHumanId: ACTOR_ID,
      target: { type: "HUMAN", humanId: ACTOR_ID },
    });

    expect(result).toMatchObject({
      acceptedAt: ctx.now,
      alreadyAccepted: false,
    });
    expect(ctx.humans.acceptChargebackTerms).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      version: CURRENT_CHARGEBACK_TERMS_VERSION,
      acceptedAt: ctx.now,
    });
    expect(ctx.audit.log).toHaveBeenCalledTimes(1);
  });

  it("rejects direct human acceptance for another human", async () => {
    const ctx = makeContext();

    await expect(
      acceptChargebackTerms(ctx.deps, {
        actorHumanId: ACTOR_ID,
        target: { type: "HUMAN", humanId: OTHER_HUMAN_ID },
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(ctx.humans.acceptChargebackTerms).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });
});
