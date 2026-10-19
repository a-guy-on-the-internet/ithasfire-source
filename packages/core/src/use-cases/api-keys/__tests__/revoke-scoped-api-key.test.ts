import { describe, expect, it } from "vitest";

import { ApiKeyRepoError } from "@th/ports/repos/api-keys";

import { revokeScopedApiKey } from "../revoke-scoped-api-key";
import {
  ACTING_KEY,
  ALICE,
  BOB,
  CAROL,
  daysAgo,
  KEY,
  KEY2,
  makeHarness,
  makeKey,
  NOW,
  ORG,
  OTHER_ORG,
  OUTSIDER,
  REQ,
  STAFF_ADMIN,
  STAFF_REVIEWER,
} from "./api-keys-harness";

function setup(...keys: Parameters<typeof makeKey>[0][]) {
  const h = makeHarness();
  for (const k of keys.length ? keys : [{}]) {
    const key = makeKey(k);
    h.apiKeys.keys.set(key.id, key);
  }
  return h;
}

describe("revokeScopedApiKey: who (FR-010, R9)", () => {
  it.each([
    ["the holder", {}, ALICE, true],
    [
      "an org admin, ORG key",
      { subject: "ORG", orgId: ORG, humanId: ALICE },
      BOB,
      true,
    ],
    ["a staff ADMIN, any key", {}, STAFF_ADMIN, true],
    ["an org viewer, ORG key", { subject: "ORG", orgId: ORG }, CAROL, false],
    [
      "an owner of another org, ORG key",
      { subject: "ORG", orgId: ORG },
      OUTSIDER,
      false,
    ],
    ["an org admin, PERSONAL key of a member", {}, BOB, false],
    ["a staff reviewer", {}, STAFF_REVIEWER, false],
  ] as const)("%s → allowed=%s", async (_n, key, actor, ok) => {
    const h = setup(key);
    const call = revokeScopedApiKey(h.deps, {
      actingApiKeyId: null,
      actorHumanId: actor,
      keyId: KEY,
    });
    if (ok) {
      await expect(call).resolves.toMatchObject({
        status: "revoked",
        revokedKeyIds: [KEY],
      });
    } else {
      await expect(call).rejects.toMatchObject({
        code: "not_found",
        message: "api_key_not_found",
      });
      expect(h.apiKeys.revokeKey).not.toHaveBeenCalled();
    }
  });

  it("reads the org from the key row: an ORG key on another org is not the org admin's", async () => {
    const h = setup({ subject: "ORG", orgId: OTHER_ORG, humanId: OUTSIDER });
    await expect(
      revokeScopedApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: BOB,
        keyId: KEY,
      }),
    ).rejects.toMatchObject({ message: "api_key_not_found" });
  });

  it("refuses a key caller", async () => {
    const h = setup();
    await expect(
      revokeScopedApiKey(h.deps, {
        actorHumanId: ALICE,
        keyId: KEY,
        actingApiKeyId: ACTING_KEY,
      }),
    ).rejects.toMatchObject({ message: "api_key_session_only" });
  });
});

describe("revokeScopedApiKey: what", () => {
  it("revokes the whole approval; audit separates live from already-expired keys", async () => {
    const h = setup(
      { id: KEY, expiresAt: new Date(NOW.getTime() + 3600_000) },
      { id: KEY2, expiresAt: daysAgo(1), renewedFromKeyId: null },
    );
    const out = await revokeScopedApiKey(h.deps, {
      actingApiKeyId: null,
      actorHumanId: STAFF_ADMIN,
      keyId: KEY,
      reason: "Leaked in a public <b>gist</b>",
    });
    expect(out).toEqual({
      keyId: KEY,
      status: "revoked",
      revokedKeyIds: [KEY],
      alsoClosedExpiredKeyIds: [KEY2],
    });
    expect(h.apiKeys.revokeKey).toHaveBeenCalledWith({
      keyId: KEY,
      revokedByHumanId: STAFF_ADMIN,
      reason: "Leaked in a public gist",
    });
    expect(h.auditEntries()[0]).toMatchObject({
      action: "api_key.revoked",
      data: {
        actorHumanId: STAFF_ADMIN,
        actingApiKeyId: null,
        keyId: KEY,
        requestId: REQ,
        holderHumanId: ALICE,
        subject: "PERSONAL",
        access: "READ",
        keyLast4: "ab12",
        decidedByHumanId: STAFF_ADMIN,
        selfApproved: false,
        revokedAs: "staff_admin",
        reason: "Leaked in a public gist",
        revokedKeyIds: [KEY],
        alsoClosedExpiredKeyIds: [KEY2],
      },
    });
  });

  it("tells the holder when someone else cut off a live key", async () => {
    const h = setup({ subject: "ORG", orgId: ORG });
    await revokeScopedApiKey(h.deps, {
      actingApiKeyId: null,
      actorHumanId: BOB,
      keyId: KEY,
      reason: "Rotating",
    });
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "key_revoked",
        audience: { kind: "human", humanId: ALICE },
        revokedBy: "org_admin",
        reason: "Rotating",
        revokedKeyIds: [KEY],
      }),
    );
  });

  it("does not notify the holder of their own revoke, nor of closing only expired keys", async () => {
    const own = setup();
    await revokeScopedApiKey(own.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
      keyId: KEY,
    });
    expect(own.notifyApiKey).not.toHaveBeenCalled();

    const expired = setup({ expiresAt: daysAgo(2) });
    const out = await revokeScopedApiKey(expired.deps, {
      actingApiKeyId: null,
      actorHumanId: STAFF_ADMIN,
      keyId: KEY,
    });
    expect(out).toMatchObject({
      revokedKeyIds: [],
      alsoClosedExpiredKeyIds: [KEY],
    });
    expect(expired.notifyApiKey).not.toHaveBeenCalled();
  });

  it("is idempotent: already revoked → no audit, no notice", async () => {
    const h = setup({ revokedAt: daysAgo(1) });
    await expect(
      revokeScopedApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: STAFF_ADMIN,
        keyId: KEY,
      }),
    ).resolves.toMatchObject({ status: "already_revoked" });
    expect(h.audit.log).not.toHaveBeenCalled();
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it("an empty reason is stored as no reason", async () => {
    const h = setup();
    await revokeScopedApiKey(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
      keyId: KEY,
      reason: "<i></i>",
    });
    expect(h.apiKeys.revokeKey).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
    );
  });

  it("revokes a legacy key (no request) for its holder", async () => {
    const h = setup({
      subject: null,
      access: null,
      requestId: null,
      expiresAt: null,
    });
    await expect(
      revokeScopedApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        keyId: KEY,
      }),
    ).resolves.toMatchObject({ status: "revoked" });
  });

  it("maps revocation_final to api_key_not_live", async () => {
    const h = setup();
    h.apiKeys.revokeKey.mockRejectedValueOnce(
      new ApiKeyRepoError({
        code: "guard_refused",
        reason: "revocation_final",
        constraint: "api_keys_guard",
        sqlState: "23514",
        message: "api_keys_guard: revoke is final",
      }),
    );
    await expect(
      revokeScopedApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        keyId: KEY,
      }),
    ).rejects.toMatchObject({ message: "api_key_not_live" });
  });

  it("reports a failed revoke notice; the revoke stands", async () => {
    const h = setup();
    h.notifyApiKey.mockRejectedValueOnce(new Error("down"));
    await expect(
      revokeScopedApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: STAFF_ADMIN,
        keyId: KEY,
      }),
    ).resolves.toMatchObject({ status: "revoked" });
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "revokeScopedApiKey", notice: "key_revoked" },
      extra: { keyId: KEY },
    });
  });
});
