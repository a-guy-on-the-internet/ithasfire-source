import { describe, expect, it, vi } from "vitest";

import {
  grantFeeWaiver,
  listFeeWaivers,
  revokeFeeWaiver,
  type FeeWaiverDeps,
} from "../fee-waivers";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const WAIVER_ID = "33333333-3333-4333-8333-333333333333";

function makeWaiver(overrides: Record<string, unknown> = {}) {
  return {
    id: WAIVER_ID,
    subjectType: "ORG",
    subjectId: ORG_ID,
    side: "ORGANIZER",
    ticketsGranted: 100,
    ticketsUsed: 10,
    ticketsRemaining: 90,
    status: "ACTIVE",
    effectiveFrom: new Date("2026-07-01"),
    effectiveTo: null,
    notes: null,
    createdBy: ADMIN,
    revokedBy: null,
    revokedAt: null,
    createdAt: new Date("2026-07-01"),
    updatedAt: new Date("2026-07-01"),
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    allowed?: boolean;
    feeWaivers?: Record<string, unknown>;
    orgExists?: boolean;
    humanExists?: boolean;
  } = {},
): FeeWaiverDeps {
  return {
    repos: {
      feeWaivers: {
        list: vi.fn(async () => ({ waivers: [makeWaiver()], total: 1 })),
        getById: vi.fn(async () => makeWaiver()),
        grant: vi.fn(async () => makeWaiver()),
        revoke: vi.fn(async () => makeWaiver({ status: "REVOKED" })),
        ...overrides.feeWaivers,
      },
      humans: {
        getByIds: vi.fn(async () => []),
        getById: vi.fn(async () =>
          overrides.humanExists === false ? null : { id: ADMIN, name: "Ada" },
        ),
      },
      organizations: {
        getByIds: vi.fn(async () => [
          { id: ORG_ID, name: "Bluebird Cafe", slug: "bluebird" },
        ]),
        getById: vi.fn(async () =>
          overrides.orgExists === false
            ? null
            : { id: ORG_ID, name: "Bluebird Cafe" },
        ),
      },
    },
    authz: {
      hasStaffRole: vi.fn(async () => ({
        allowed: overrides.allowed ?? true,
      })),
    },
  } as unknown as FeeWaiverDeps;
}

describe("fee waiver admin use cases", () => {
  describe("staff gating", () => {
    it("rejects a non-admin listing waivers", async () => {
      await expect(
        listFeeWaivers(makeDeps({ allowed: false }), {
          actorHumanId: ADMIN,
        }),
      ).rejects.toThrow();
    });

    it("rejects a non-admin granting a waiver", async () => {
      await expect(
        grantFeeWaiver(makeDeps({ allowed: false }), {
          actorHumanId: ADMIN,
          subjectType: "ORG",
          subjectId: ORG_ID,
          side: "ORGANIZER",
          ticketsGranted: 50,
        }),
      ).rejects.toThrow();
    });

    it("rejects a non-admin revoking a waiver", async () => {
      await expect(
        revokeFeeWaiver(makeDeps({ allowed: false }), {
          actorHumanId: ADMIN,
          waiverId: WAIVER_ID,
        }),
      ).rejects.toThrow();
    });

    it("requires the ADMIN role specifically", async () => {
      const deps = makeDeps();
      await listFeeWaivers(deps, { actorHumanId: ADMIN });
      expect(deps.authz.hasStaffRole).toHaveBeenCalledWith(
        expect.objectContaining({ requiredRoles: ["ADMIN"] }),
      );
    });
  });

  describe("listFeeWaivers", () => {
    it("resolves subject display names", async () => {
      const result = await listFeeWaivers(makeDeps(), { actorHumanId: ADMIN });
      expect(result.waivers[0]!.subjectLabel).toBe("Bluebird Cafe");
      expect(result.total).toBe(1);
    });

    it("still returns waivers when the name lookup blows up", async () => {
      const deps = makeDeps();
      deps.repos.organizations.getByIds = vi.fn(async () => {
        throw new Error("db down");
      }) as never;
      const reportError = vi.fn();

      const result = await listFeeWaivers(
        { ...deps, reportError },
        { actorHumanId: ADMIN },
      );

      // A waiver whose subject can't be named must stay visible and revocable.
      expect(result.waivers).toHaveLength(1);
      expect(result.waivers[0]!.subjectLabel).toBeNull();
      expect(reportError).toHaveBeenCalled();
    });

    it("defaults to active-only", async () => {
      const deps = makeDeps();
      await listFeeWaivers(deps, { actorHumanId: ADMIN });
      expect(deps.repos.feeWaivers.list).toHaveBeenCalledWith(
        expect.objectContaining({ includeInactive: false }),
      );
    });
  });

  describe("grantFeeWaiver", () => {
    it("rejects a grant against an unknown org", async () => {
      await expect(
        grantFeeWaiver(makeDeps({ orgExists: false }), {
          actorHumanId: ADMIN,
          subjectType: "ORG",
          subjectId: ORG_ID,
          side: "ORGANIZER",
          ticketsGranted: 50,
        }),
      ).rejects.toThrow();
    });

    it("rejects a zero-ticket grant", async () => {
      await expect(
        grantFeeWaiver(makeDeps(), {
          actorHumanId: ADMIN,
          subjectType: "ORG",
          subjectId: ORG_ID,
          side: "ORGANIZER",
          ticketsGranted: 0,
        }),
      ).rejects.toThrow();
    });

    it("rejects an expiry that precedes the start", async () => {
      await expect(
        grantFeeWaiver(makeDeps(), {
          actorHumanId: ADMIN,
          subjectType: "ORG",
          subjectId: ORG_ID,
          side: "ORGANIZER",
          ticketsGranted: 10,
          effectiveFrom: new Date("2026-08-01"),
          effectiveTo: new Date("2026-07-01"),
        }),
      ).rejects.toThrow();
    });

    it("persists the grant and stamps the actor", async () => {
      const deps = makeDeps();
      const result = await grantFeeWaiver(deps, {
        actorHumanId: ADMIN,
        subjectType: "ORG",
        subjectId: ORG_ID,
        side: "ORGANIZER",
        ticketsGranted: 500,
        notes: "launch incentive",
      });

      expect(deps.repos.feeWaivers.grant).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: "ORG",
          subjectId: ORG_ID,
          side: "ORGANIZER",
          ticketsGranted: 500,
          notes: "launch incentive",
          actorHumanId: ADMIN,
        }),
      );
      expect(result.waiver.id).toBe(WAIVER_ID);
    });
  });

  describe("revokeFeeWaiver", () => {
    it("404s on an unknown waiver", async () => {
      await expect(
        revokeFeeWaiver(
          makeDeps({ feeWaivers: { getById: vi.fn(async () => null) } }),
          { actorHumanId: ADMIN, waiverId: WAIVER_ID },
        ),
      ).rejects.toThrow();
    });

    it("refuses to revoke twice", async () => {
      await expect(
        revokeFeeWaiver(
          makeDeps({
            feeWaivers: {
              getById: vi.fn(async () => makeWaiver({ status: "REVOKED" })),
            },
          }),
          { actorHumanId: ADMIN, waiverId: WAIVER_ID },
        ),
      ).rejects.toThrow();
    });

    it("revokes without clawing back already-used tickets", async () => {
      const deps = makeDeps();
      const result = await revokeFeeWaiver(deps, {
        actorHumanId: ADMIN,
        waiverId: WAIVER_ID,
      });

      expect(result.waiver.status).toBe("REVOKED");
      // Buyers already quoted the discount keep it.
      expect(result.waiver.ticketsUsed).toBe(10);
    });
  });
});
