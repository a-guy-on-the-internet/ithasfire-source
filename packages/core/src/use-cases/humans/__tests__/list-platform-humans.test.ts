import { describe, expect, it, vi } from "vitest";

import { listPlatformHumans } from "../list-platform-humans";
import type { ListPlatformHumansDeps } from "../list-platform-humans";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const UNVERIFIED_ID = "00000000-0000-4000-8000-000000000002";
const VERIFIED_ID = "00000000-0000-4000-8000-000000000003";
const NO_IDENTITY_ID = "00000000-0000-4000-8000-000000000004";

function item(id: string, emailVerified: boolean | null) {
  return {
    human: {
      id,
      name: "Sam",
      status: "ACTIVE",
      roles: [],
      trustTier: "NEW",
      createdAt: new Date("2026-10-01T00:00:00Z"),
    },
    identity:
      emailVerified === null
        ? null
        : {
            authUserId: `auth-${id}`,
            email: `${id}@example.com`,
            emailVerified,
            phone: null,
            phoneVerified: false,
            username: null,
            displayUsername: null,
            image: null,
          },
    memberships: [],
  };
}

function buildDeps(
  opts: {
    admin?: boolean;
    holds?: boolean | Error;
    extraUnverified?: string[];
    reportError?: ListPlatformHumansDeps["reportError"];
  } = {},
) {
  const items = [
    item(UNVERIFIED_ID, false),
    item(VERIFIED_ID, true),
    item(NO_IDENTITY_ID, null),
    ...(opts.extraUnverified ?? []).map((id) => item(id, false)),
  ];
  const humans = {
    listAllWithMemberships: vi.fn(async () => ({
      items,
      pageInfo: { total: items.length },
    })),
    listHumanIdsHoldingEmailAttachedRows: vi.fn(async (ids: string[]) => {
      if (opts.holds instanceof Error) throw opts.holds;
      return (opts.holds ?? true) ? ids : [];
    }),
  };
  // Any staff role passes the roster check; the ADMIN-only ask is the
  // pre-flight's.
  const adminOnly = (roles: string[]) =>
    roles.length === 1 && roles[0] === "ADMIN";
  const hasStaffRole = vi.fn(
    async ({ requiredRoles }: { requiredRoles: string[] }) => ({
      allowed: adminOnly(requiredRoles) ? (opts.admin ?? true) : true,
    }),
  );
  const deps: ListPlatformHumansDeps = {
    repos: { humans } as unknown as ListPlatformHumansDeps["repos"],
    authz: { hasStaffRole } as unknown as ListPlatformHumansDeps["authz"],
    reportError: opts.reportError,
  };
  return { deps, humans };
}

const run = (deps: ListPlatformHumansDeps) =>
  listPlatformHumans(deps, { actorHumanId: ACTOR_ID });

const flagOf = (
  out: Awaited<ReturnType<typeof run>>,
  id: string,
): boolean | null | undefined =>
  out.items.find((i) => i.id === id)?.holdsEmailAttachedRows;

describe("listPlatformHumans — force-verify pre-flight", () => {
  it("flags an unverified human that holds email-attached rows", async () => {
    const { deps, humans } = buildDeps({ holds: true });
    const out = await run(deps);
    expect(flagOf(out, UNVERIFIED_ID)).toBe(true);
    expect(humans.listHumanIdsHoldingEmailAttachedRows).toHaveBeenCalledTimes(1);
    expect(humans.listHumanIdsHoldingEmailAttachedRows).toHaveBeenCalledWith([
      UNVERIFIED_ID,
    ]);
  });

  it("asks once for all unverified rows, however many", async () => {
    const extra = Array.from(
      { length: 25 },
      (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    );
    const { deps, humans } = buildDeps({ holds: true, extraUnverified: extra });
    const out = await run(deps);
    expect(humans.listHumanIdsHoldingEmailAttachedRows).toHaveBeenCalledTimes(1);
    expect(humans.listHumanIdsHoldingEmailAttachedRows).toHaveBeenCalledWith([
      UNVERIFIED_ID,
      ...extra,
    ]);
    expect(flagOf(out, extra[24]!)).toBe(true);
  });

  it("answers false for an unverified human that holds none", async () => {
    const { deps } = buildDeps({ holds: false });
    expect(flagOf(await run(deps), UNVERIFIED_ID)).toBe(false);
  });

  it("leaves verified and identity-less rows null without a lookup", async () => {
    const { deps } = buildDeps({ holds: true });
    const out = await run(deps);
    expect(flagOf(out, VERIFIED_ID)).toBeNull();
    expect(flagOf(out, NO_IDENTITY_ID)).toBeNull();
  });

  it("skips the lookup for non-ADMIN staff", async () => {
    const { deps, humans } = buildDeps({ admin: false });
    const out = await run(deps);
    expect(flagOf(out, UNVERIFIED_ID)).toBeNull();
    expect(humans.listHumanIdsHoldingEmailAttachedRows).not.toHaveBeenCalled();
  });

  it("reports a failed lookup and still returns the roster", async () => {
    const reportError = vi.fn();
    const boom = new Error("db down");
    const { deps } = buildDeps({ holds: boom, reportError });
    const out = await run(deps);
    expect(out.items).toHaveLength(3);
    expect(flagOf(out, UNVERIFIED_ID)).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "listPlatformHumans" }),
      }),
    );
  });

  it("a throwing reporter does not change the result", async () => {
    const { deps } = buildDeps({
      holds: new Error("db down"),
      reportError: () => {
        throw new Error("reporter down");
      },
    });
    const out = await run(deps);
    expect(flagOf(out, UNVERIFIED_ID)).toBeNull();
  });
});
