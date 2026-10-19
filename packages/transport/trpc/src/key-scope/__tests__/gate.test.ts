import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiKeyScope } from "@th/ports/authn";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { OrgRole } from "@th/ports/repos/authz";
import { ORG_ANY_ROLE, requireOrgMembership } from "@th/core/lib/rbac";
import { createInMemoryRateLimit } from "@th/test-utils/fakes/rate-limit";

import {
  authedProcedure,
  optionalProcedure,
  publicProcedure,
  router,
} from "../../init";
import { buildBaseCtx } from "../../routers/__tests__/test-helpers";
import { toTrpcError } from "../../utils";
import { requireKeySelfRenewal } from "../actor";
import {
  INVALID_KEY_MAX_ATTEMPTS,
  INVALID_KEY_WINDOW_SECONDS,
  PLATFORM_WIDE_KEY_RATE_LIMIT_MAX_REQUESTS,
  PLATFORM_WIDE_KEY_RATE_LIMIT_WINDOW_SECONDS,
  invalidKeyBucket,
} from "../gate";

// The gate as production chains it (init.ts): these procedures are built from
// the real `publicProcedure` / `optionalProcedure` / `authedProcedure`.

const HOLDER = "11111111-1111-4111-8111-111111111111";
const KEY_ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const EVENT_IN_KEY_ORG = "44444444-4444-4444-8444-444444444444";
const EVENT_IN_OTHER_ORG = "55555555-5555-4555-8555-555555555555";
const CLIENT_IP = "203.0.113.7";

/** Stand-in for a use case that resolves the org from an event id. */
const orgOfEvent = (eventId: string) =>
  eventId === EVENT_IN_KEY_ORG ? KEY_ORG : OTHER_ORG;

const scoped = (
  subject: "ORG" | "PERSONAL" | "STAFF" | "PLATFORM_WIDE",
  access: "READ" | "READ_WRITE",
): ApiKeyScope => ({
  kind: "scoped",
  keyId: "key-1",
  requestId: "req-1",
  subject,
  access,
  orgId: subject === "ORG" ? KEY_ORG : null,
});
const LEGACY: ApiKeyScope = { kind: "legacy", keyId: "legacy-1" };

const seenCtx = vi.fn();
const mapped = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    // As the routers do: domain and port errors map through toTrpcError.
    throw toTrpcError(err);
  }
};

const appRouter = router({
  orgs: router({
    untagged: authedProcedure.query(({ ctx }) => {
      seenCtx(ctx);
      return { actor: ctx.actorHumanId };
    }),
    // Org-scoped read whose input carries NO orgId: the org is resolved from
    // the event, then checked through the authz port (spec risk 1).
    eventReport: authedProcedure
      .meta({
        key: { permission: "orgs.eventReport", subjects: ["ORG"], level: "READ" },
      })
      .input(z.object({ eventId: z.string() }))
      .query(({ ctx, input }) =>
        mapped(async () => {
          await ctx.authz.requireOrgRole({
            actorHumanId: ctx.actorHumanId!,
            orgId: orgOfEvent(input.eventId),
            requiredRoles: ["ADMIN", "OWNER"],
          });
          return { ok: true };
        }),
      ),
    // The same, authorised the way most of core does it: rbac.ts on
    // repos.authz, outside and inside a transaction.
    memberReport: authedProcedure
      .meta({
        key: {
          permission: "orgs.memberReport",
          subjects: ["ORG", "PERSONAL", "STAFF"],
          level: "READ",
        },
      })
      .input(z.object({ eventId: z.string(), inTx: z.boolean() }))
      .query(({ ctx, input }) =>
        mapped(async () => {
          const check = (repos: Pick<typeof ctx.repos, "authz">) =>
            requireOrgMembership({
              repos,
              orgId: orgOfEvent(input.eventId),
              actorHumanId: ctx.actorHumanId!,
              roles: ORG_ANY_ROLE,
            });
          const membership = input.inTx
            ? await ctx.repos.tx((tx) => check(tx))
            : await check(ctx.repos);
          return { role: membership.role };
        }),
      ),
    // A read any org member may make: VIEWER passes the procedure's own check.
    memberRead: authedProcedure
      .meta({
        key: { permission: "orgs.memberRead", subjects: ["ORG"], level: "READ" },
      })
      .query(async ({ ctx }) => {
        const { allowed } = await ctx.authz.hasOrgRole({
          actorHumanId: ctx.actorHumanId!,
          orgId: KEY_ORG,
          requiredRoles: ["OWNER", "ADMIN", "EDITOR", "VIEWER"],
        });
        if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });
        return { ok: true };
      }),
    rename: authedProcedure
      .meta({
        key: {
          permission: "orgs.rename",
          subjects: ["ORG"],
          level: "READ_WRITE",
        },
      })
      .mutation(async ({ ctx }) => {
        const { allowed } = await ctx.authz.hasOrgRole({
          actorHumanId: ctx.actorHumanId!,
          orgId: KEY_ORG,
          requiredRoles: ["OWNER", "ADMIN"],
        });
        if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });
        return { ok: true };
      }),
    // A mutation mis-tagged READ: the gate refuses it whatever the key.
    misTagged: authedProcedure
      .meta({ key: { permission: "orgs.misTagged", subjects: ["ORG"], level: "READ" } })
      .mutation(() => ({ ok: true })),
    // Denylisted path (FR-008) carrying a tag: refused before the tag is read.
    deleteOrg: authedProcedure
      .meta({
        key: {
          permission: "orgs.deleteOrg",
          subjects: ["ORG"],
          level: "READ_WRITE",
        },
      })
      .mutation(() => ({ deleted: true })),
  }),
  me: router({
    // Tagged for every subject; reports what the procedure saw.
    staffProbe: optionalProcedure
      .meta({
        key: {
          permission: "me.staffProbe",
          subjects: ["ORG", "PERSONAL", "STAFF", "PLATFORM_WIDE"],
          level: "READ",
        },
      })
      .query(async ({ ctx }) => {
        seenCtx(ctx);
        const staff = ctx.actorHumanId
          ? await ctx.authz.hasStaffRole({
              actorHumanId: ctx.actorHumanId,
              requiredRoles: ["ADMIN", "COMMUNITY_MODERATOR"],
            })
          : { allowed: false };
        const staffRoles = ctx.actorHumanId
          ? await ctx.repos.authz.getStaffRolesForHumanId(ctx.actorHumanId)
          : [];
        return { actor: ctx.actorHumanId, staff, staffRoles };
      }),
    authedPublicData: authedProcedure
      .meta({
        key: {
          permission: "me.authedPublicData",
          subjects: ["PLATFORM_WIDE"],
          level: "READ",
        },
      })
      .query(() => ({ ok: true })),
  }),
  pub: router({
    untagged: publicProcedure.query(() => ({ ok: true })),
    listing: publicProcedure
      .meta({
        key: {
          permission: "pub.listing",
          subjects: ["PLATFORM_WIDE"],
          level: "READ",
        },
      })
      .query(({ ctx }) => {
        seenCtx(ctx);
        return { actor: ctx.actorHumanId };
      }),
  }),
  apiKeys: router({
    renewSelf: optionalProcedure
      .meta({ key: { selfRenewal: true } })
      .mutation(({ ctx }) => {
        seenCtx(ctx);
        return { renewal: requireKeySelfRenewal(ctx), actor: ctx.actorHumanId };
      }),
  }),
  // R34a: real guarded paths (KEY_GUARDED_INPUT_FIELDS), untagged, so a
  // legacy key or a session reaches them.
  events: router({
    updateSettings: authedProcedure
      .input(
        z.object({
          eventId: z.string(),
          volunteerAutoApprove: z.boolean().optional(),
          title: z.string().optional(),
        }),
      )
      .mutation(() => ({ ok: true })),
  }),
  volunteer: router({
    roles: router({
      update: authedProcedure
        .input(
          z.object({
            id: z.string(),
            autoApprove: z.boolean().nullish(),
            name: z.string().optional(),
          }),
        )
        .mutation(() => ({ ok: true })),
    }),
  }),
  misc: router({
    // selfRenewal anywhere but apiKeys.renewSelf is refused.
    fakeRenew: optionalProcedure
      .meta({ key: { selfRenewal: true } })
      .mutation(() => ({ ok: true })),
  }),
});

/**
 * The holder's live roles, mutable between calls. The fake port and repo
 * answer from it the way the real ones answer from the database.
 */
type Roles = { org: Record<string, OrgRole>; staff: HumanRole[] };

const livePort = (roles: Roles) => ({
  hasOrgRole: vi.fn(async (i: { orgId: string; requiredRoles: OrgRole[] }) => ({
    allowed: i.requiredRoles.includes(roles.org[i.orgId]!),
  })),
  requireOrgRole: vi.fn(async (i: { orgId: string; requiredRoles: OrgRole[] }) => {
    if (!i.requiredRoles.includes(roles.org[i.orgId]!)) {
      throw Object.assign(new Error("no"), { code: "forbidden" });
    }
  }),
  canEditEvent: vi.fn(async () => ({ allowed: true })),
  canManagePlace: vi.fn(async () => ({ allowed: true })),
  canFinanceOrg: vi.fn(async () => ({ allowed: true })),
  hasStaffRole: vi.fn(async (i: { requiredRoles: HumanRole[] }) => ({
    allowed: i.requiredRoles.some((r) => roles.staff.includes(r)),
  })),
});

const liveAuthzRepo = (roles: Roles) => ({
  getOrgMembership: vi.fn(async (i: { orgId: string; humanId: string }) =>
    roles.org[i.orgId]
      ? { orgId: i.orgId, humanId: i.humanId, role: roles.org[i.orgId]! }
      : null,
  ),
  getOrgMemberships: vi.fn(async () => []),
  listOrgMembershipsByHumanId: vi.fn(async () => []),
  getStaffRolesForHumanId: vi.fn(async () => [...roles.staff]),
  getHumanDelegation: vi.fn(async () => null),
});

/** Holder: OWNER of both orgs and a platform ADMIN, unless overridden. */
const allRoles = (): Roles => ({
  org: { [KEY_ORG]: "OWNER", [OTHER_ORG]: "OWNER" },
  staff: ["ADMIN"],
});

function callerFor(opts: {
  keyScope?: ApiKeyScope;
  apiKey?: string | null;
  roles?: Roles;
  port?: ReturnType<typeof livePort>;
  authnError?: { code: string } | Error;
  rateLimit?: object;
  consume?: ReturnType<typeof vi.fn>;
  session?: boolean;
}) {
  const roles = opts.roles ?? allRoles();
  const authz = opts.port ?? livePort(roles);
  const authzRepo = liveAuthzRepo(roles);
  const txAuthzRepo = liveAuthzRepo(roles);
  const tx = vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ authz: txAuthzRepo }),
  );
  const ensureAuthedHumanFromApiKey = vi.fn(async () => {
    if (opts.authnError) {
      throw opts.authnError instanceof Error
        ? opts.authnError
        : Object.assign(new Error(opts.authnError.code), opts.authnError);
    }
    return { humanId: HOLDER, keyScope: opts.keyScope ?? LEGACY };
  });
  const consume =
    opts.consume ??
    vi.fn(async () => ({
      allowed: true,
      remaining: 100,
      retryAfterSeconds: 0,
    }));
  const ctx = buildBaseCtx({
    apiKey: opts.session ? null : (opts.apiKey ?? "thk_test"),
    // A session caller arrives with its actor; a key caller with none.
    actorHumanId: opts.session ? HOLDER : null,
    authz: authz as unknown as AuthZPort,
    repos: { authz: authzRepo, tx } as never,
    authn: {
      ensureAuthedHuman: vi.fn(),
      ensureAuthedHumanFromApiKey,
      getProviderUserId: vi.fn(async () => ({ providerUserId: null })),
    } as never,
    rateLimit: (opts.rateLimit ?? { consume }) as never,
    clientIp: CLIENT_IP,
  });
  seenCtx.mockClear();
  return {
    caller: appRouter.createCaller(ctx) as any,
    authz,
    authzRepo,
    txAuthzRepo,
    roles,
    ensureAuthedHumanFromApiKey,
    consume,
  };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as TRPCError).code;
  }
};

describe("API-key gate: default deny (FR-006 a, R5)", () => {
  it("refuses a scoped key on a procedure with no key tag", async () => {
    const { caller, ensureAuthedHumanFromApiKey } = callerFor({
      keyScope: scoped("ORG", "READ_WRITE"),
    });
    expect(await code(caller.orgs.untagged())).toBe("FORBIDDEN");
    expect(seenCtx).not.toHaveBeenCalled();
    expect(ensureAuthedHumanFromApiKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a scoped key on an untagged PUBLIC procedure too", async () => {
    const { caller } = callerFor({ keyScope: scoped("PERSONAL", "READ") });
    expect(await code(caller.pub.untagged())).toBe("FORBIDDEN");
  });

  it("refuses a subject the tag does not list", async () => {
    const { caller } = callerFor({ keyScope: scoped("PERSONAL", "READ") });
    expect(await code(caller.orgs.eventReport({ eventId: EVENT_IN_KEY_ORG }))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("API-key gate: a refused key vs a failing backend", () => {
  it("answers a refused key UNAUTHORIZED on every chain", async () => {
    const { caller } = callerFor({ authnError: { code: "unauthorized" } });
    expect(await code(caller.pub.untagged())).toBe("UNAUTHORIZED");
    expect(await code(caller.me.staffProbe())).toBe("UNAUTHORIZED");
    expect(await code(caller.orgs.untagged())).toBe("UNAUTHORIZED");
  });

  it("answers a transient key-check failure 503, not 401", async () => {
    const { caller, consume } = callerFor({ authnError: { code: "transient" } });
    expect(await code(caller.orgs.untagged())).toBe("SERVICE_UNAVAILABLE");
    expect(await code(caller.pub.untagged())).toBe("SERVICE_UNAVAILABLE");
    // Not a refusal: nothing charged to the refused-key bucket.
    expect(consume).not.toHaveBeenCalledWith(
      invalidKeyBucket(CLIENT_IP),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rethrows any other failure (500), never 401", async () => {
    const { caller } = callerFor({ authnError: new Error("db down") });
    expect(await code(caller.orgs.untagged())).toBe("INTERNAL_SERVER_ERROR");
    const dep = callerFor({ authnError: { code: "dependency_failed" } });
    expect(await code(dep.caller.orgs.untagged())).not.toBe("UNAUTHORIZED");
  });

  it("throttles refused keys per IP: 429 once the bucket is spent", async () => {
    const rateLimit = createInMemoryRateLimit();
    const { caller, ensureAuthedHumanFromApiKey } = callerFor({
      authnError: { code: "unauthorized" },
      rateLimit,
    });
    for (let i = 0; i < INVALID_KEY_MAX_ATTEMPTS; i += 1) {
      expect(await code(caller.pub.untagged())).toBe("UNAUTHORIZED");
    }
    expect(await code(caller.pub.untagged())).toBe("TOO_MANY_REQUESTS");
    expect(await code(caller.orgs.untagged())).toBe("TOO_MANY_REQUESTS");
    // The key is still looked up: the 429 is the answer to a REFUSAL.
    expect(ensureAuthedHumanFromApiKey).toHaveBeenCalledTimes(
      INVALID_KEY_MAX_ATTEMPTS + 2,
    );
    expect(INVALID_KEY_WINDOW_SECONDS).toBeGreaterThan(0);
  });

  it("lets a valid key through while its address's refused-key bucket is spent", async () => {
    const rateLimit = createInMemoryRateLimit();
    const guesser = callerFor({ authnError: { code: "unauthorized" }, rateLimit });
    for (let i = 0; i <= INVALID_KEY_MAX_ATTEMPTS; i += 1) {
      await code(guesser.caller.pub.untagged());
    }
    expect(await code(guesser.caller.pub.untagged())).toBe("TOO_MANY_REQUESTS");
    const [spent = 0] = await rateLimit.peek([invalidKeyBucket(CLIENT_IP)]);
    expect(spent).toBeGreaterThanOrEqual(INVALID_KEY_MAX_ATTEMPTS);

    // Same IP (callerFor pins CLIENT_IP), same buckets, a good key.
    const good = callerFor({ keyScope: scoped("ORG", "READ"), rateLimit });
    await expect(good.caller.orgs.memberRead()).resolves.toBeDefined();
    // And it is not charged for it.
    expect(await rateLimit.peek([invalidKeyBucket(CLIENT_IP)])).toEqual([spent]);
  });

  it("never charges a good key to the refused-key bucket", async () => {
    const rateLimit = createInMemoryRateLimit();
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ"), rateLimit });
    for (let i = 0; i < INVALID_KEY_MAX_ATTEMPTS + 2; i += 1) {
      await caller.orgs.memberRead();
    }
    expect(await rateLimit.peek([invalidKeyBucket(CLIENT_IP)])).toEqual([0]);
  });
});

describe("API-key gate: access level (FR-006 b)", () => {
  it("refuses an ORG READ key on a mutation", async () => {
    const { caller, authz } = callerFor({ keyScope: scoped("ORG", "READ") });
    expect(await code(caller.orgs.rename())).toBe("FORBIDDEN");
    expect(authz.hasOrgRole).not.toHaveBeenCalled();
  });

  it("lets an ORG READ_WRITE key run the same mutation on its own org", async () => {
    const { caller, authz } = callerFor({
      keyScope: scoped("ORG", "READ_WRITE"),
    });
    await expect(caller.orgs.rename()).resolves.toEqual({ ok: true });
    expect(authz.hasOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: HOLDER, orgId: KEY_ORG }),
    );
  });

  it("refuses a mutation tagged READ even for a READ_WRITE key (invalid tag)", async () => {
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ_WRITE") });
    expect(await code(caller.orgs.misTagged())).toBe("FORBIDDEN");
  });
});

describe("API-key gate: ORG binding on the RESOLVED org (FR-006 d, risk 1)", () => {
  it("refuses an ORG key when the authz call resolves another org, with no orgId in the input", async () => {
    const { caller, authz } = callerFor({ keyScope: scoped("ORG", "READ") });
    expect(
      await code(caller.orgs.eventReport({ eventId: EVENT_IN_OTHER_ORG })),
    ).toBe("FORBIDDEN");
    // Refused by the wrapper, before the real port: the holder's role in the
    // other org is never consulted.
    expect(authz.requireOrgRole).not.toHaveBeenCalled();
  });

  it("allows the same call when the resolved org is the key's org", async () => {
    const { caller, authz } = callerFor({ keyScope: scoped("ORG", "READ") });
    await expect(
      caller.orgs.eventReport({ eventId: EVENT_IN_KEY_ORG }),
    ).resolves.toEqual({ ok: true });
    expect(authz.requireOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: HOLDER, orgId: KEY_ORG }),
    );
  });
});

describe("API-key gate: repos.authz narrowed (rbac.ts path, in and out of a tx)", () => {
  for (const inTx of [false, true]) {
    const where = inTx ? "inside repos.tx" : "outside a tx";

    it(`ORG key: requireOrgMembership for another org fails ${where}`, async () => {
      const { caller, authzRepo, txAuthzRepo } = callerFor({
        keyScope: scoped("ORG", "READ"),
      });
      // A session would pass: the holder is OWNER of the other org too.
      expect(
        await code(caller.orgs.memberReport({ eventId: EVENT_IN_OTHER_ORG, inTx })),
      ).toBe("FORBIDDEN");
      expect(authzRepo.getOrgMembership).not.toHaveBeenCalled();
      expect(txAuthzRepo.getOrgMembership).not.toHaveBeenCalled();
    });

    it(`ORG key: requireOrgMembership for its own org passes ${where}`, async () => {
      const { caller } = callerFor({ keyScope: scoped("ORG", "READ") });
      await expect(
        caller.orgs.memberReport({ eventId: EVENT_IN_KEY_ORG, inTx }),
      ).resolves.toEqual({ role: "OWNER" });
    });

    it.each(["PERSONAL", "STAFF"] as const)(
      `%s key: requireOrgMembership fails for every org ${where}`,
      async (subject) => {
        const { caller } = callerFor({ keyScope: scoped(subject, "READ") });
        for (const eventId of [EVENT_IN_KEY_ORG, EVENT_IN_OTHER_ORG]) {
          expect(await code(caller.orgs.memberReport({ eventId, inTx }))).toBe(
            "FORBIDDEN",
          );
        }
      },
    );
  }

  it("a session still sees every membership", async () => {
    const { caller } = callerFor({ session: true });
    await expect(
      caller.orgs.memberReport({ eventId: EVENT_IN_OTHER_ORG, inTx: true }),
    ).resolves.toEqual({ role: "OWNER" });
  });
});

describe("API-key gate: live role on every call (R3, FR-006 c)", () => {
  it("ORG key: demoting the holder ADMIN -> VIEWER fails the next call", async () => {
    const roles: Roles = { org: { [KEY_ORG]: "ADMIN" }, staff: [] };
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ"), roles });
    await expect(caller.orgs.memberRead()).resolves.toEqual({ ok: true });
    roles.org[KEY_ORG] = "VIEWER";
    // The procedure itself admits a VIEWER; the gate's live probe does not.
    expect(await code(caller.orgs.memberRead())).toBe("FORBIDDEN");
  });

  it("ORG key: removing the holder from the org fails the next call", async () => {
    const roles: Roles = { org: { [KEY_ORG]: "OWNER" }, staff: [] };
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ"), roles });
    await expect(caller.orgs.memberRead()).resolves.toEqual({ ok: true });
    delete roles.org[KEY_ORG];
    expect(await code(caller.orgs.memberRead())).toBe("FORBIDDEN");
  });

  it("STAFF key: ADMIN -> COMMUNITY_MODERATOR fails the next call", async () => {
    const roles: Roles = { org: {}, staff: ["ADMIN"] };
    const { caller } = callerFor({ keyScope: scoped("STAFF", "READ"), roles });
    expect((await caller.me.staffProbe()).staff).toEqual({ allowed: true });
    roles.staff = ["COMMUNITY_MODERATOR"];
    // The procedure's own probe would admit a moderator; R28 does not.
    expect(await code(caller.me.staffProbe())).toBe("FORBIDDEN");
  });

  it("STAFF key: a holder the port refuses for want of a second factor fails", async () => {
    const port = livePort({ org: {}, staff: ["ADMIN"] });
    port.hasStaffRole.mockImplementation(async () => ({
      allowed: false,
      secondFactorRequired: true,
    }) as never);
    const { caller } = callerFor({ keyScope: scoped("STAFF", "READ"), port });
    expect(await code(caller.me.staffProbe())).toBe("FORBIDDEN");
  });
});

describe("API-key gate: staff probes by subject", () => {
  it("refuses hasStaffRole and staff roles under a PERSONAL key though the holder is staff", async () => {
    const { caller, authz } = callerFor({ keyScope: scoped("PERSONAL", "READ") });
    const out = await caller.me.staffProbe();
    expect(out.actor).toBe(HOLDER);
    expect(out.staff).toEqual({ allowed: false });
    expect(out.staffRoles).toEqual([]);
    expect(authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("refuses hasStaffRole and staff roles under an ORG key", async () => {
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ") });
    const out = await caller.me.staffProbe();
    expect(out.staff).toEqual({ allowed: false });
    expect(out.staffRoles).toEqual([]);
  });

  it("passes a STAFF key's probes to the live port and repo", async () => {
    const { caller, authz } = callerFor({ keyScope: scoped("STAFF", "READ") });
    const out = await caller.me.staffProbe();
    expect(out.staff).toEqual({ allowed: true });
    expect(out.staffRoles).toEqual(["ADMIN"]);
    expect(authz.hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: HOLDER,
        requiredRoles: ["ADMIN", "COMMUNITY_MODERATOR"],
      }),
    );
  });
});

describe("API-key gate: PLATFORM_WIDE runs as a visitor (FR-007, NFR-004)", () => {
  it("gives the procedure no actor", async () => {
    const { caller } = callerFor({ keyScope: scoped("PLATFORM_WIDE", "READ") });
    expect(await caller.me.staffProbe()).toEqual({
      actor: null,
      staff: { allowed: false },
      staffRoles: [],
    });
    expect(seenCtx.mock.calls[0]![0].actorHumanId).toBeNull();
    expect(seenCtx.mock.calls[0]![0].keySelfRenewal).toBeNull();
    await expect(caller.pub.listing()).resolves.toEqual({ actor: null });
  });

  it("is UNAUTHORIZED on an authed procedure even when tagged for it", async () => {
    const { caller } = callerFor({ keyScope: scoped("PLATFORM_WIDE", "READ") });
    expect(await code(caller.me.authedPublicData())).toBe("UNAUTHORIZED");
  });

  it("spends its own per-key bucket, enforced", async () => {
    const consume = vi.fn(async (key: string) =>
      key.startsWith("apikey:platform-wide:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 17 }
        : { allowed: true, remaining: 100, retryAfterSeconds: 0 },
    );
    const { caller } = callerFor({
      keyScope: scoped("PLATFORM_WIDE", "READ"),
      consume,
    });
    expect(await code(caller.pub.listing())).toBe("TOO_MANY_REQUESTS");
    expect(consume).toHaveBeenCalledWith(
      "apikey:platform-wide:key-1",
      PLATFORM_WIDE_KEY_RATE_LIMIT_MAX_REQUESTS,
      PLATFORM_WIDE_KEY_RATE_LIMIT_WINDOW_SECONDS,
    );
    expect(seenCtx).not.toHaveBeenCalled();
  });

  it("charges no per-key bucket for other subjects", async () => {
    const { caller, consume } = callerFor({ keyScope: scoped("PERSONAL", "READ") });
    await caller.me.staffProbe();
    expect(
      consume.mock.calls.some(([key]) => String(key).startsWith("apikey:")),
    ).toBe(false);
  });
});

describe("API-key gate: FR-008 denylist", () => {
  it("refuses a denylisted path whatever its tag and the key", async () => {
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ_WRITE") });
    expect(await code(caller.orgs.deleteOrg())).toBe("FORBIDDEN");
  });

  it("refuses a denylisted path to a legacy key too (R4)", async () => {
    const { caller } = callerFor({ keyScope: LEGACY });
    expect(await code(caller.orgs.deleteOrg())).toBe("FORBIDDEN");
  });

  it("lets a session call the denylisted path", async () => {
    const { caller } = callerFor({ session: true });
    await expect(caller.orgs.deleteOrg()).resolves.toEqual({ deleted: true });
  });
});

describe("API-key gate: self-renewal (FR-009)", () => {
  it("is key-only: a session is refused", async () => {
    const { caller } = callerFor({ session: true });
    expect(await code(caller.apiKeys.renewSelf())).toBe("FORBIDDEN");
  });

  it("hands a PLATFORM_WIDE key its holder id there and nowhere else", async () => {
    const { caller } = callerFor({ keyScope: scoped("PLATFORM_WIDE", "READ") });
    await expect(caller.apiKeys.renewSelf()).resolves.toEqual({
      renewal: { keyId: "key-1", holderHumanId: HOLDER },
      actor: null,
    });
  });

  it("accepts every subject and skips the level check", async () => {
    for (const subject of ["ORG", "PERSONAL", "STAFF"] as const) {
      const { caller } = callerFor({ keyScope: scoped(subject, "READ") });
      await expect(caller.apiKeys.renewSelf()).resolves.toMatchObject({
        renewal: { keyId: "key-1", holderHumanId: HOLDER },
        actor: HOLDER,
      });
    }
  });

  it("refuses a demoted ORG holder there too", async () => {
    const roles: Roles = { org: { [KEY_ORG]: "VIEWER" }, staff: [] };
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ"), roles });
    expect(await code(caller.apiKeys.renewSelf())).toBe("FORBIDDEN");
  });

  it("refuses a legacy key (nothing to renew)", async () => {
    const { caller } = callerFor({ keyScope: LEGACY });
    expect(await code(caller.apiKeys.renewSelf())).toBe("FORBIDDEN");
  });

  it("refuses the selfRenewal tag on any other path", async () => {
    const { caller } = callerFor({ keyScope: scoped("PERSONAL", "READ_WRITE") });
    expect(await code(caller.misc.fakeRenew())).toBe("FORBIDDEN");
  });
});

describe("API-key gate: legacy keys keep the holder's session until FR-013", () => {
  it("reaches an untagged procedure as the holder, authz and repos not narrowed", async () => {
    const { caller, authz } = callerFor({ keyScope: LEGACY });
    await expect(caller.orgs.untagged()).resolves.toEqual({ actor: HOLDER });
    expect(seenCtx.mock.calls[0]![0].authz).toBe(authz);
    expect(seenCtx.mock.calls[0]![0].keyScope).toEqual(LEGACY);
    // Any org the holder belongs to, as in a session.
    await expect(
      caller.orgs.memberReport({ eventId: EVENT_IN_OTHER_ORG, inTx: true }),
    ).resolves.toEqual({ role: "OWNER" });
  });

  it("still sets no actor on a public procedure", async () => {
    const { caller } = callerFor({ keyScope: LEGACY });
    await expect(caller.pub.untagged()).resolves.toEqual({ ok: true });
  });
});

describe("API-key gate: volunteer auto-approve is session-only (R34a)", () => {
  it("refuses a key that switches it on, on the event or a role", async () => {
    const { caller } = callerFor({ keyScope: LEGACY });
    await expect(
      caller.events.updateSettings({ eventId: "e", volunteerAutoApprove: true }),
    ).rejects.toThrow(/API_KEY_SCOPE: .*volunteerAutoApprove/);
    await expect(
      caller.volunteer.roles.update({ id: "r", autoApprove: true }),
    ).rejects.toThrow(/API_KEY_SCOPE: .*autoApprove/);
    // null clears the role's override: the role inherits the event's
    // setting, which may be on.
    expect(
      await code(caller.volunteer.roles.update({ id: "r", autoApprove: null })),
    ).toBe("FORBIDDEN");
  });

  it("refuses it for a scoped key before the tag is read", async () => {
    const { caller } = callerFor({ keyScope: scoped("ORG", "READ_WRITE") });
    await expect(
      caller.volunteer.roles.update({ id: "r", autoApprove: true }),
    ).rejects.toThrow(/cannot set autoApprove/);
  });

  it("lets the same call through without the field, or switching it off", async () => {
    const { caller } = callerFor({ keyScope: LEGACY });
    await expect(
      caller.events.updateSettings({ eventId: "e", title: "New" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      caller.events.updateSettings({ eventId: "e", volunteerAutoApprove: false }),
    ).resolves.toEqual({ ok: true });
    await expect(
      caller.volunteer.roles.update({ id: "r", name: "Door" }),
    ).resolves.toEqual({ ok: true });
  });

  it("leaves a session free to switch it on", async () => {
    const { caller } = callerFor({ session: true });
    await expect(
      caller.events.updateSettings({ eventId: "e", volunteerAutoApprove: true }),
    ).resolves.toEqual({ ok: true });
    await expect(
      caller.volunteer.roles.update({ id: "r", autoApprove: true }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("API-key gate: a session is unaffected", () => {
  it("reaches an untagged procedure with the real authz and repos, no key scope", async () => {
    const { caller, authz, ensureAuthedHumanFromApiKey } = callerFor({
      session: true,
    });
    await expect(caller.orgs.untagged()).resolves.toEqual({ actor: HOLDER });
    const ctx = seenCtx.mock.calls[0]![0];
    expect(ctx.authz).toBe(authz);
    expect(ctx.keyScope).toBeNull();
    expect(ctx.keySelfRenewal).toBeNull();
    expect(ensureAuthedHumanFromApiKey).not.toHaveBeenCalled();
  });

  it("is not held to a tag's access level", async () => {
    const { caller } = callerFor({ session: true });
    await expect(caller.orgs.misTagged()).resolves.toEqual({ ok: true });
  });
});
