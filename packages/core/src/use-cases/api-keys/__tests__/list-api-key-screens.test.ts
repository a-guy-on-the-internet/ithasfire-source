import { describe, expect, it } from "vitest";

import { listMyApiKeys } from "../list-my-api-keys";
import { listOrgApiKeys } from "../list-org-api-keys";
import { listPlatformApiKeys } from "../list-platform-api-keys";
import {
  ALICE,
  BOB,
  CAROL,
  daysAgo,
  daysAhead,
  KEY,
  KEY2,
  makeHarness,
  makeKey,
  makeRequest,
  MODERATOR,
  ORG,
  OWNER_ID,
  STAFF_ADMIN,
  STAFF_REVIEWER,
  DAY,
} from "./api-keys-harness";

const REQ_IDS = [
  "c0000000-0000-4000-8000-000000000001",
  "c0000000-0000-4000-8000-000000000002",
  "c0000000-0000-4000-8000-000000000003",
  "c0000000-0000-4000-8000-000000000004",
  "c0000000-0000-4000-8000-000000000005",
  "c0000000-0000-4000-8000-000000000006",
  "c0000000-0000-4000-8000-000000000007",
  "c0000000-0000-4000-8000-000000000008",
] as const;

describe("listMyApiKeys: derived statuses", () => {
  it("derives every request status from timestamps; account-security closes say so", async () => {
    const h = makeHarness();
    const rows = [
      makeRequest({ id: REQ_IDS[0], createdAt: daysAgo(1) }),
      makeRequest({ id: REQ_IDS[1], createdAt: daysAgo(14) }),
      makeRequest({
        id: REQ_IDS[2],
        withdrawnAt: daysAgo(0),
        withdrawalReason: "REQUESTER",
      }),
      makeRequest({
        id: REQ_IDS[3],
        decision: "APPROVED",
        decidedAt: daysAgo(1),
        withdrawnAt: daysAgo(0),
        withdrawalReason: "ACCOUNT_SECURITY",
      }),
      makeRequest({
        id: REQ_IDS[4],
        decision: "DENIED",
        decidedAt: daysAgo(1),
        decidedByHumanId: STAFF_ADMIN,
        denialReason: "Tell us which reports you need",
      }),
      makeRequest({
        id: REQ_IDS[5],
        decision: "APPROVED",
        decidedAt: daysAgo(6),
      }),
      makeRequest({
        id: REQ_IDS[6],
        decision: "APPROVED",
        decidedAt: daysAgo(7),
      }),
      makeRequest({
        id: REQ_IDS[7],
        decision: "APPROVED",
        decidedAt: daysAgo(3),
        collectedAt: daysAgo(2),
      }),
    ];
    for (const r of rows) h.apiKeys.requests.set(r.id, r);
    const out = await listMyApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
    });
    const status = Object.fromEntries(
      out.requests.map((r) => [r.id, r.status]),
    );
    expect(status).toEqual({
      [REQ_IDS[0]]: "pending",
      [REQ_IDS[1]]: "lapsed",
      [REQ_IDS[2]]: "withdrawn",
      [REQ_IDS[3]]: "closed_for_account_security",
      [REQ_IDS[4]]: "denied",
      [REQ_IDS[5]]: "ready_to_collect",
      [REQ_IDS[6]]: "collect_lapsed",
      [REQ_IDS[7]]: "collected",
    });
    const denied = out.requests.find((r) => r.id === REQ_IDS[4])!;
    expect(denied).toMatchObject({
      denialReason: "Tell us which reports you need",
      decidedByName: "Sam Admin",
    });
    const ready = out.requests.find((r) => r.id === REQ_IDS[5])!;
    expect(ready.lapsesAt).toEqual(new Date(daysAgo(6).getTime() + 7 * DAY));
    expect(out.requests.every((r) => !r.canDecide)).toBe(true);
  });

  it("lists only the caller's keys with derived status, names, and never a hash", async () => {
    const h = makeHarness();
    h.apiKeys.keys.set(KEY, makeKey({ expiresAt: daysAhead(3) }));
    h.apiKeys.keys.set(
      KEY2,
      makeKey({
        id: KEY2,
        humanId: BOB,
        revokedAt: daysAgo(1),
        revokedByHumanId: STAFF_ADMIN,
      }),
    );
    const out = await listMyApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
    });
    expect(out.keys).toHaveLength(1);
    expect(out.keys[0]).toMatchObject({
      id: KEY,
      status: "live",
      expiringSoon: true,
      holderName: "Alice",
      decidedByName: "Sam Admin",
      keyLast4: "ab12",
      autoRenew: true,
      canRevoke: true,
      legacy: false,
    });
    expect(Object.keys(out.keys[0]!)).not.toContain("keyHash");
    expect(h.apiKeys.listKeysByHolder).toHaveBeenCalledWith({
      humanId: ALICE,
      limit: 100,
    });
  });

  it("marks expired, revoked and legacy keys", async () => {
    const h = makeHarness();
    h.apiKeys.keys.set(KEY, makeKey({ expiresAt: daysAgo(1) }));
    h.apiKeys.keys.set(
      KEY2,
      makeKey({
        id: KEY2,
        subject: null,
        access: null,
        requestId: null,
        expiresAt: null,
        requestAutoRenew: null,
      }),
    );
    const out = await listMyApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
    });
    expect(out.keys.find((k) => k.id === KEY)).toMatchObject({
      status: "expired",
      canRevoke: true,
    });
    expect(out.keys.find((k) => k.id === KEY2)).toMatchObject({
      legacy: true,
      status: "live",
      autoRenew: false,
      renewalLockedOff: false,
    });
  });
});

describe("renewalLockedOff and key callers", () => {
  it("says auto-renew cannot be switched on when the request's switch is off, without naming who", async () => {
    const h = makeHarness();
    h.apiKeys.keys.set(
      KEY,
      makeKey({ autoRenew: false, requestAutoRenew: false }),
    );
    const out = await listMyApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
    });
    expect(out.keys[0]).toMatchObject({
      renewalLockedOff: true,
      autoRenew: false,
    });
    expect(Object.keys(out.keys[0]!).some((k) => /approver/i.test(k))).toBe(
      false,
    );
  });

  it("every list refuses a key caller (FR-008 credentials denylist)", async () => {
    const h = makeHarness();
    const key = { actingApiKeyId: KEY2, actorHumanId: ALICE };
    await expect(listMyApiKeys(h.deps, key)).rejects.toMatchObject({
      message: "api_key_session_only",
    });
    await expect(
      listOrgApiKeys(h.deps, { ...key, orgId: ORG }),
    ).rejects.toMatchObject({
      message: "api_key_session_only",
    });
    await expect(
      listPlatformApiKeys(h.deps, { ...key, actorHumanId: STAFF_ADMIN }),
    ).rejects.toMatchObject({ message: "api_key_session_only" });
    expect(h.apiKeys.listKeysByHolder).not.toHaveBeenCalled();
  });

  it("actingApiKeyId is required (null for a session)", async () => {
    const h = makeHarness();
    await expect(
      listMyApiKeys(h.deps, { actorHumanId: ALICE }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("listOrgApiKeys", () => {
  it("is for the org's OWNERs / ADMINs only", async () => {
    const h = makeHarness();
    await expect(
      listOrgApiKeys(h.deps, {
        actingApiKeyId: null,
        actorHumanId: CAROL,
        orgId: ORG,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "api_key_list_not_allowed",
    });
    await expect(
      listOrgApiKeys(h.deps, {
        actingApiKeyId: null,
        actorHumanId: STAFF_ADMIN,
        orgId: ORG,
      }),
    ).rejects.toMatchObject({ message: "api_key_list_not_allowed" });
  });

  it("lists every key on the org and the queue; own requests are not decidable", async () => {
    const h = makeHarness();
    h.apiKeys.keys.set(
      KEY,
      makeKey({ subject: "ORG", orgId: ORG, humanId: ALICE }),
    );
    h.apiKeys.requests.set(
      REQ_IDS[0],
      makeRequest({
        id: REQ_IDS[0],
        subject: "ORG",
        orgId: ORG,
        requesterHumanId: BOB,
      }),
    );
    h.apiKeys.requests.set(
      REQ_IDS[1],
      makeRequest({
        id: REQ_IDS[1],
        subject: "ORG",
        orgId: ORG,
        requesterHumanId: ALICE,
      }),
    );
    const out = await listOrgApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
      orgId: ORG,
    });
    expect(out.keys).toHaveLength(1);
    expect(out.keys[0]).toMatchObject({ holderName: "Alice", canRevoke: true });
    expect(out.queue.find((r) => r.id === REQ_IDS[0])).toMatchObject({
      canDecide: true,
      requesterName: "Bob",
    });
    expect(out.queue.find((r) => r.id === REQ_IDS[1])).toMatchObject({
      canDecide: false,
    });
  });
});

describe("listPlatformApiKeys", () => {
  it("is for platform staff only (not community moderators)", async () => {
    const h = makeHarness();
    for (const who of [MODERATOR, ALICE]) {
      await expect(
        listPlatformApiKeys(h.deps, {
          actingApiKeyId: null,
          actorHumanId: who,
        }),
      ).rejects.toMatchObject({
        message: "api_key_list_not_allowed",
      });
    }
  });

  it("marks what a reviewer, an admin and the platform owner may decide", async () => {
    const h = makeHarness();
    const personal = makeRequest({
      id: REQ_IDS[0],
      subject: "PERSONAL",
      requesterHumanId: ALICE,
    });
    const staff = makeRequest({
      id: REQ_IDS[1],
      subject: "STAFF",
      requesterHumanId: STAFF_REVIEWER,
    });
    const ownersOwn = makeRequest({
      id: REQ_IDS[2],
      subject: "STAFF",
      requesterHumanId: OWNER_ID,
      autoRenew: true,
      expiryDays: 30,
    });
    for (const r of [personal, staff, ownersOwn])
      h.apiKeys.requests.set(r.id, r);

    const reviewer = await listPlatformApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: STAFF_REVIEWER,
    });
    const byId = (out: typeof reviewer, id: string) =>
      out.queue.find((r) => r.id === id)!;
    expect(byId(reviewer, REQ_IDS[0]).canDecide).toBe(true);
    expect(byId(reviewer, REQ_IDS[1]).canDecide).toBe(false); // own + STAFF needs ADMIN

    const owner = await listPlatformApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: OWNER_ID,
    });
    expect(byId(owner, REQ_IDS[1]).canDecide).toBe(true);
    expect(byId(owner, REQ_IDS[2])).toMatchObject({
      canDecide: false,
      canSelfApprove: true,
    });

    const admin = await listPlatformApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: STAFF_ADMIN,
    });
    expect(byId(admin, REQ_IDS[2])).toMatchObject({
      canDecide: true,
      canSelfApprove: false,
    });

    const noOwnerEnv = await listPlatformApiKeys(
      { ...h.deps, platformOwnerEnvironment: null },
      { actingApiKeyId: null, actorHumanId: OWNER_ID },
    );
    expect(byId(noOwnerEnv, REQ_IDS[2]).canSelfApprove).toBe(false);
    expect(h.apiKeys.listPlatformQueue).toHaveBeenCalledWith({
      subjects: ["PERSONAL", "STAFF", "PLATFORM_WIDE"],
      includeOrgFallbacks: true,
      limit: 100,
    });
  });

  it("pages every key; only staff ADMINs may revoke others' keys; selfApproved shown", async () => {
    const h = makeHarness();
    h.apiKeys.keys.set(
      KEY,
      makeKey({ selfApproved: true, humanId: OWNER_ID, subject: "STAFF" }),
    );
    h.apiKeys.listAllKeys.mockResolvedValueOnce({
      items: [...h.apiKeys.keys.values()],
      total: 3,
    });
    const reviewer = await listPlatformApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: STAFF_REVIEWER,
      limit: 1,
      offset: 0,
    });
    expect(reviewer.keys).toMatchObject({
      total: 3,
      limit: 1,
      offset: 0,
      hasNextPage: true,
    });
    expect(reviewer.keys.items[0]).toMatchObject({
      selfApproved: true,
      canRevoke: false,
    });

    const admin = await listPlatformApiKeys(h.deps, {
      actingApiKeyId: null,
      actorHumanId: STAFF_ADMIN,
    });
    expect(admin.keys.items[0]!.canRevoke).toBe(true);
  });
});
