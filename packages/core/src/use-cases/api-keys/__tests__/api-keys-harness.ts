/**
 * In-memory fakes for the scoped API key use-case tests. The repo fake
 * mimics the adapter's CAS outcomes (decide / withdraw / collect / renew /
 * revoke) closely enough to drive the use cases; the SQL and the guard
 * triggers themselves are covered by the adapter integration tests
 * (packages/adapters/src/db/prisma/__tests__/api-keys-guards.integration.test.ts).
 */
import { vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type {
  ApiKeyListItem,
  ApiKeyRequestRecord,
  ApiKeysRepo,
} from "@th/ports/repos/api-keys";

export const NOW = new Date("2026-10-13T12:00:00.000Z");
export const DAY = 24 * 60 * 60 * 1000;
export const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
export const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY);

export const OWNER_ID = "00000000-0000-4000-8000-00000000d005"; // dev platform owner
export const ALICE = "11111111-1111-4111-8111-111111111111"; // org OWNER
export const BOB = "22222222-2222-4222-8222-222222222222"; // org ADMIN
export const CAROL = "33333333-3333-4333-8333-333333333333"; // org VIEWER
export const STAFF_ADMIN = "44444444-4444-4444-8444-444444444444";
export const STAFF_REVIEWER = "55555555-5555-4555-8555-555555555555";
export const MODERATOR = "66666666-6666-4666-8666-666666666666";
export const OUTSIDER = "77777777-7777-4777-8777-777777777777";
export const SUSPENDED_ADMIN = "88888888-8888-4888-8888-888888888888";
export const UNVERIFIED = "99999999-9999-4999-8999-999999999999";

export const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const REQ = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const KEY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const KEY2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const ACTING_KEY = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type OrgRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

export type World = {
  humans: Record<
    string,
    {
      status: "ACTIVE" | "SUSPENDED" | "BANNED";
      emailVerified: boolean;
      name: string;
    }
  >;
  orgRoles: Record<string, Record<string, OrgRole>>;
  staffRoles: Record<string, string[]>;
};

export function defaultWorld(): World {
  const human = (name: string) => ({
    status: "ACTIVE" as const,
    emailVerified: true,
    name,
  });
  return {
    humans: {
      [OWNER_ID]: human("Platform Owner"),
      [ALICE]: human("Alice"),
      [BOB]: human("Bob"),
      [CAROL]: human("Carol"),
      [STAFF_ADMIN]: human("Sam Admin"),
      [STAFF_REVIEWER]: human("Rae Reviewer"),
      [MODERATOR]: human("Mo Moderator"),
      [OUTSIDER]: human("Otto"),
      [SUSPENDED_ADMIN]: { ...human("Sus"), status: "SUSPENDED" },
      [UNVERIFIED]: { ...human("Una"), emailVerified: false },
    },
    orgRoles: {
      [ORG]: {
        [ALICE]: "OWNER",
        [BOB]: "ADMIN",
        [CAROL]: "VIEWER",
        [SUSPENDED_ADMIN]: "ADMIN",
      },
      [OTHER_ORG]: { [OUTSIDER]: "OWNER" },
    },
    staffRoles: {
      [OWNER_ID]: ["ADMIN"],
      [STAFF_ADMIN]: ["ADMIN"],
      [STAFF_REVIEWER]: ["REVIEWER"],
      [MODERATOR]: ["COMMUNITY_MODERATOR"],
    },
  };
}

export function makeAuthz(world: World): AuthZPort {
  const satisfies = (actual: OrgRole, required: string) =>
    actual === required || (actual === "OWNER" && required === "ADMIN");
  return {
    hasOrgRole: vi.fn(async ({ actorHumanId, orgId, requiredRoles }) => {
      const role = world.orgRoles[orgId]?.[actorHumanId];
      return {
        allowed: !!role && requiredRoles.some((r) => satisfies(role, r)),
      };
    }),
    requireOrgRole: vi.fn(async () => {}),
    canEditEvent: vi.fn(async () => ({ allowed: false })),
    canManagePlace: vi.fn(async () => ({ allowed: false })),
    canFinanceOrg: vi.fn(async () => ({ allowed: false })),
    hasStaffRole: vi.fn(async ({ actorHumanId, requiredRoles }) => ({
      allowed: (world.staffRoles[actorHumanId] ?? []).some((r) =>
        (requiredRoles as string[]).includes(r),
      ),
    })),
  };
}

export function makeRequest(
  overrides: Partial<ApiKeyRequestRecord> = {},
): ApiKeyRequestRecord {
  return {
    id: REQ,
    requesterHumanId: ALICE,
    subject: "PERSONAL",
    orgId: null,
    access: "READ",
    label: "ci",
    purpose: "Nightly export for my own records",
    expiryDays: 30,
    autoRenew: false,
    createdAt: daysAgo(1),
    decidedAt: null,
    decision: null,
    decidedByHumanId: null,
    denialReason: null,
    selfApproved: false,
    withdrawnAt: null,
    withdrawalReason: null,
    collectedAt: null,
    lapseNotifiedAt: null,
    ...overrides,
  };
}

export function makeKey(
  overrides: Partial<ApiKeyListItem> = {},
): ApiKeyListItem {
  return {
    id: KEY,
    humanId: ALICE,
    requestId: REQ,
    subject: "PERSONAL",
    orgId: null,
    access: "READ",
    label: "ci",
    keyLast4: "ab12",
    createdAt: daysAgo(25),
    lastUsedAt: null,
    expiresAt: daysAhead(5),
    autoRenew: true,
    renewedFromKeyId: null,
    revokedAt: null,
    revokedByHumanId: null,
    revokeReason: null,
    expiryNotifiedAt: null,
    purpose: "Nightly export for my own records",
    selfApproved: false,
    decidedByHumanId: STAFF_ADMIN,
    requestAutoRenew: true,
    ...overrides,
  };
}

const MINTED = "thk_SECRETPLAINTEXTxyz9";

/** A store-backed fake of the repo's request / key methods. */
export function makeApiKeysRepo(world: World) {
  const requests = new Map<string, ApiKeyRequestRecord>();
  const keys = new Map<string, ApiKeyListItem>();

  const repo = {
    requests,
    keys,
    getRequest: vi.fn(
      async ({ requestId }: { requestId: string }) =>
        requests.get(requestId) ?? null,
    ),
    createRequest: vi.fn(async (input) => {
      const created = makeRequest({ ...input, id: REQ, createdAt: NOW });
      requests.set(created.id, created);
      return created;
    }),
    lockAndCountForCap: vi.fn(async ({ subject }) => ({
      holderCount: 0,
      orgCount: subject === "ORG" ? 0 : null,
      holderRequestsLast24h: 0,
    })),
    orgHasOtherLiveApprover: vi.fn(
      async ({
        orgId,
        excludeHumanId,
      }: {
        orgId: string;
        excludeHumanId: string;
      }) =>
        Object.entries(world.orgRoles[orgId] ?? {}).some(
          ([humanId, role]) =>
            humanId !== excludeHumanId &&
            (role === "OWNER" || role === "ADMIN") &&
            world.humans[humanId]?.status === "ACTIVE",
        ),
    ),
    decide: vi.fn(async (input) => {
      const current = requests.get(input.requestId);
      if (!current) return { status: "not_found" } as const;
      if (current.decidedAt)
        return { status: "already_decided", request: current } as const;
      if (current.withdrawnAt)
        return { status: "withdrawn", request: current } as const;
      if (
        input.decision === "APPROVED" &&
        current.createdAt.getTime() <= NOW.getTime() - 14 * DAY
      ) {
        return { status: "lapsed", request: current } as const;
      }
      const decided: ApiKeyRequestRecord = {
        ...current,
        decision: input.decision,
        decidedAt: NOW,
        decidedByHumanId: input.decidedByHumanId,
        denialReason: input.denialReason,
        selfApproved: input.selfApproved,
      };
      requests.set(decided.id, decided);
      return { status: "decided", request: decided } as const;
    }),
    withdraw: vi.fn(async ({ requestId, requesterHumanId }) => {
      const current = requests.get(requestId);
      if (!current || current.requesterHumanId !== requesterHumanId) {
        return { status: "not_found" } as const;
      }
      if (current.decidedAt)
        return { status: "already_decided", request: current } as const;
      if (current.withdrawnAt)
        return { status: "already_withdrawn", request: current } as const;
      const withdrawn = {
        ...current,
        withdrawnAt: NOW,
        withdrawalReason: "REQUESTER" as const,
      };
      requests.set(requestId, withdrawn);
      return { status: "withdrawn", request: withdrawn } as const;
    }),
    collect: vi.fn(async ({ requestId, holderHumanId }) => {
      const r = requests.get(requestId);
      if (!r || r.requesterHumanId !== holderHumanId)
        return { status: "not_found" } as const;
      const record = makeKey({
        id: KEY,
        humanId: r.requesterHumanId,
        requestId: r.id,
        subject: r.subject,
        orgId: r.orgId,
        access: r.access,
        label: r.label,
        keyLast4: MINTED.slice(-4),
        createdAt: NOW,
        expiresAt: r.expiryDays === null ? null : daysAhead(r.expiryDays),
        autoRenew: r.autoRenew,
        decidedByHumanId: r.decidedByHumanId,
        selfApproved: r.selfApproved,
        requestAutoRenew: r.autoRenew,
      });
      keys.set(record.id, record);
      requests.set(r.id, { ...r, collectedAt: NOW });
      return { status: "collected", key: MINTED, record } as const;
    }),
    renew: vi.fn(async ({ parentKeyId, holderHumanId }) => {
      const parent = keys.get(parentKeyId);
      if (!parent || parent.humanId !== holderHumanId)
        return { status: "not_found" } as const;
      const cut = new Date(
        Math.min(parent.expiresAt!.getTime(), NOW.getTime() + DAY),
      );
      keys.set(parent.id, { ...parent, expiresAt: cut });
      const record = makeKey({
        ...parent,
        id: KEY2,
        keyLast4: MINTED.slice(-4),
        createdAt: NOW,
        expiresAt: daysAhead(30),
        renewedFromKeyId: parent.id,
      });
      keys.set(record.id, record);
      return { status: "renewed", key: MINTED, record } as const;
    }),
    getKey: vi.fn(
      async ({ keyId }: { keyId: string }) => keys.get(keyId) ?? null,
    ),
    revokeKey: vi.fn(async ({ keyId, revokedByHumanId, reason }) => {
      const k = keys.get(keyId);
      if (!k) return { status: "not_found" } as const;
      if (k.revokedAt) return { status: "already_revoked" } as const;
      const siblings = [...keys.values()].filter(
        (x) => x.requestId === k.requestId && !x.revokedAt,
      );
      const live: string[] = [];
      const expired: string[] = [];
      for (const s of siblings) {
        (s.expiresAt === null || s.expiresAt > NOW ? live : expired).push(s.id);
        keys.set(s.id, {
          ...s,
          revokedAt: NOW,
          revokedByHumanId,
          revokeReason: reason,
        });
      }
      return {
        status: "revoked",
        revokedKeyIds: live.sort(),
        alsoClosedExpiredKeyIds: expired.sort(),
      } as const;
    }),
    setKeyAutoRenew: vi.fn(async ({ keyId, autoRenew }) => {
      const k = keys.get(keyId);
      if (!k) return { status: "not_found" } as const;
      if (k.revokedAt || (k.expiresAt && k.expiresAt <= NOW)) {
        return { status: "not_live", record: k } as const;
      }
      if (k.autoRenew === autoRenew)
        return { status: "unchanged", record: k } as const;
      if (autoRenew && !k.requestAutoRenew) {
        return { status: "request_disallows", record: k } as const;
      }
      const updated = { ...k, autoRenew };
      keys.set(keyId, updated);
      return { status: "updated", record: updated } as const;
    }),
    switchOffRequestAutoRenew: vi.fn(async ({ requestId }) => {
      const r = requests.get(requestId);
      const anyKey = [...keys.values()].find((k) => k.requestId === requestId);
      if (!r && !anyKey) return { status: "not_found" } as const;
      const request = r ?? makeRequest({ id: requestId });
      if (!request.autoRenew && anyKey?.requestAutoRenew === false) {
        return { status: "unchanged", request } as const;
      }
      const off = { ...request, autoRenew: false };
      requests.set(requestId, off);
      const keyIds: string[] = [];
      for (const k of keys.values()) {
        if (k.requestId === requestId && !k.revokedAt) {
          keys.set(k.id, { ...k, autoRenew: false, requestAutoRenew: false });
          keyIds.push(k.id);
        }
      }
      return { status: "switched_off", request: off, keyIds } as const;
    }),
    listKeysByHolder: vi.fn(async ({ humanId }: { humanId: string }) =>
      [...keys.values()].filter((k) => k.humanId === humanId),
    ),
    listRequestsByRequester: vi.fn(
      async ({ requesterHumanId }: { requesterHumanId: string }) =>
        [...requests.values()].filter(
          (r) => r.requesterHumanId === requesterHumanId,
        ),
    ),
    listKeysByOrg: vi.fn(async ({ orgId }: { orgId: string }) =>
      [...keys.values()].filter((k) => k.orgId === orgId),
    ),
    listOrgQueue: vi.fn(async ({ orgId }: { orgId: string }) =>
      [...requests.values()].filter((r) => r.orgId === orgId && !r.decidedAt),
    ),
    listPlatformQueue: vi.fn(async () =>
      [...requests.values()].filter((r) => !r.decidedAt),
    ),
    listAllKeys: vi.fn(async () => ({
      items: [...keys.values()],
      total: keys.size,
    })),
    listRequestsDueLapseNotice: vi.fn(async () => [] as never[]),
    markRequestLapseNotified: vi.fn(async () => true),
    listKeysDueExpiryNotice: vi.fn(async () => [] as never[]),
    markKeyExpiryNotified: vi.fn(async () => true),
  };
  return repo;
}

export function makeHarness(world: World = defaultWorld()) {
  const apiKeys = makeApiKeysRepo(world);
  const audit = { log: vi.fn(async (_entry: unknown) => {}) };
  const humans = {
    getByIdWithIdentity: vi.fn(async (id: string) => {
      const h = world.humans[id];
      if (!h) return null;
      return {
        human: { id, name: h.name, status: h.status, roles: [] },
        identity: { emailVerified: h.emailVerified },
      };
    }),
    getByIds: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => world.humans[id])
        .map((id) => ({ id, name: world.humans[id]!.name })),
    ),
  };
  const txRepos = { apiKeys, audit, humans };
  const tx = vi.fn(async <T>(fn: (t: typeof txRepos) => Promise<T>) =>
    fn(txRepos),
  );
  const repos = { ...txRepos, tx } as unknown as {
    apiKeys: ApiKeysRepo;
    audit: { log: (e: unknown) => Promise<void> };
    humans: never;
    tx: never;
  };
  const authz = makeAuthz(world);
  const notifyApiKey = vi.fn(async (_notice: unknown) => {});
  const reportError = vi.fn();
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const clock = { now: () => NOW };
  return {
    world,
    apiKeys,
    audit,
    humans,
    tx,
    authz,
    notifyApiKey,
    reportError,
    logger,
    clock,
    // Deps shaped for every use case (extra fields are harmless).
    deps: {
      repos: repos as never,
      authz,
      clock,
      notifyApiKey,
      reportError,
      logger: logger as never,
      platformOwnerEnvironment: "development" as const,
      stepUp: null,
    },
    auditEntries: () =>
      audit.log.mock.calls.map(
        (c) => c[0] as { action: string; data: Record<string, unknown> },
      ),
  };
}

export const PLAINTEXT_IN_TESTS = MINTED;
