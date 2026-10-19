import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { CURRENT_CHARGEBACK_TERMS_VERSION } from "../../../lib/payments/chargeback-terms";
import { getOrg, type GetOrgDeps } from "../get-org";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const ACCEPTED_AT = new Date("2025-11-02T09:30:00.000Z");

/**
 * `getOrg` is members-only (authedProcedure + requireOrgRole(ORG_ANY_ROLE)),
 * never public. The chargeback-terms fields are FINANCE-ONLY on top of that:
 * present (nullable) for OWNER / ADMIN / FINANCE, absent for everyone else so
 * a client can tell "not allowed to see" from "not accepted".
 */
function makeDeps(options: {
  role: OrgRole | null;
  accepted?: boolean;
  /** Overrides the accepter id (null = the accepter's account was deleted). */
  acceptedByHumanId?: string | null;
}) {
  const accepted = options.accepted ?? true;
  const organization = {
    id: ORG_ID,
    name: "Acme Collective",
    slug: "acme-collective",
    status: "ACTIVE" as const,
    defaultLocale: "en",
    contactEmail: "hello@acme.test",
    physicalAddress: "123 Main St",
    chargebackTermsVersion: accepted ? CURRENT_CHARGEBACK_TERMS_VERSION : null,
    chargebackTermsAcceptedAt: accepted ? ACCEPTED_AT : null,
    chargebackTermsAcceptedByHumanId:
      options.acceptedByHumanId !== undefined
        ? options.acceptedByHumanId
        : accepted
          ? ACTOR_ID
          : null,
  };

  const getOrgMembership = vi.fn(async () =>
    options.role
      ? { orgId: ORG_ID, humanId: ACTOR_ID, role: options.role }
      : null,
  );

  const repos = {
    organizations: { getById: vi.fn(async () => organization) },
    authz: { getOrgMembership },
  } as unknown as Repos;

  const authz = {
    requireOrgRole: vi.fn(async () => {}),
  } as unknown as AuthZPort;

  const deps: GetOrgDeps = { repos, authz, logger: createTestLogger() };
  return { deps, mocks: { getOrgMembership, requireOrgRole: authz.requireOrgRole } };
}

describe("getOrg — chargeback-terms fields are finance-only", () => {
  it.each(["OWNER", "ADMIN", "FINANCE"] as const)(
    "%s sees chargebackTermsVersion + chargebackTermsAcceptedAt",
    async (role) => {
      const { deps, mocks } = makeDeps({ role });

      const result = await getOrg(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      });

      expect(result).toMatchObject({
        id: ORG_ID,
        chargebackTermsVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
        chargebackTermsAcceptedAt: ACCEPTED_AT,
      });
      expect(mocks.requireOrgRole).toHaveBeenCalledTimes(1);
      expect(mocks.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
    },
  );

  it("a finance role with no acceptance sees explicit nulls (not absence)", async () => {
    const { deps } = makeDeps({ role: "FINANCE", accepted: false });

    const result = await getOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID });

    expect(result).toHaveProperty("chargebackTermsVersion", null);
    expect(result).toHaveProperty("chargebackTermsAcceptedAt", null);
  });

  it.each(["EDITOR", "VIEWER"] as const)(
    "%s gets the profile with the acceptance fields ABSENT",
    async (role) => {
      const { deps } = makeDeps({ role });

      const result = await getOrg(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      });

      expect(result).toMatchObject({ id: ORG_ID, name: "Acme Collective" });
      expect(result).not.toHaveProperty("chargebackTermsVersion");
      expect(result).not.toHaveProperty("chargebackTermsAcceptedAt");
    },
  );

  it("an acceptance whose accepter is gone (SetNull) reads as never accepted, as publish judges it", async () => {
    const { deps } = makeDeps({
      role: "OWNER",
      accepted: true,
      acceptedByHumanId: null,
    });

    const result = await getOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID });

    expect(result).toHaveProperty("chargebackTermsVersion", null);
    expect(result).toHaveProperty("chargebackTermsAcceptedAt", null);
  });

  it("a membership that vanished between the role check and the read hides the fields rather than throwing", async () => {
    const { deps } = makeDeps({ role: null });

    const result = await getOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID });

    expect(result.id).toBe(ORG_ID);
    expect(result).not.toHaveProperty("chargebackTermsVersion");
  });
});
