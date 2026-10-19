import { describe, expect, it } from "vitest";

import { ApiKeyRepoError } from "@th/ports/repos/api-keys";

import { collectApiKey } from "../collect-api-key";
import {
  ACTING_KEY,
  ALICE,
  BOB,
  daysAgo,
  defaultWorld,
  makeHarness,
  NOW,
  ORG,
  PLAINTEXT_IN_TESTS,
  REQ,
  STAFF_ADMIN,
  makeRequest,
  DAY,
} from "./api-keys-harness";

const approved = {
  decidedAt: daysAgo(1),
  decision: "APPROVED",
  decidedByHumanId: STAFF_ADMIN,
} as const;

function setup(
  over: Parameters<typeof makeRequest>[0] = {},
  world = defaultWorld(),
) {
  const h = makeHarness(world);
  h.apiKeys.requests.set(REQ, makeRequest({ ...approved, ...over }));
  return h;
}

describe("collectApiKey", () => {
  it("mints the key and returns the plaintext once", async () => {
    const h = setup();
    const out = await collectApiKey(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
      requestId: REQ,
    });
    expect(out).toEqual({
      keyId: expect.any(String),
      key: PLAINTEXT_IN_TESTS,
      keyLast4: PLAINTEXT_IN_TESTS.slice(-4),
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(h.apiKeys.collect).toHaveBeenCalledWith({
      requestId: REQ,
      holderHumanId: ALICE,
    });
  });

  it("never puts the plaintext in the audit row or the notice", async () => {
    const h = setup({ subject: "ORG", orgId: ORG });
    await collectApiKey(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
      requestId: REQ,
    });
    const [entry] = h.auditEntries();
    expect(entry).toMatchObject({
      action: "api_key.collected",
      data: {
        actorHumanId: ALICE,
        actingApiKeyId: null,
        holderHumanId: ALICE,
        requestId: REQ,
        subject: "ORG",
        orgId: ORG,
        access: "READ",
        keyLast4: PLAINTEXT_IN_TESTS.slice(-4),
        decidedByHumanId: STAFF_ADMIN,
        selfApproved: false,
        renewedFromKeyId: null,
      },
    });
    expect(JSON.stringify(h.audit.log.mock.calls)).not.toContain(
      PLAINTEXT_IN_TESTS,
    );
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "key_collected",
        audience: { kind: "org_admins", orgId: ORG, excludeHumanId: ALICE },
      }),
    );
    expect(JSON.stringify(h.notifyApiKey.mock.calls)).not.toContain(
      PLAINTEXT_IN_TESTS,
    );
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(
      PLAINTEXT_IN_TESTS,
    );
  });

  it("does not notify for a non-ORG key", async () => {
    const h = setup();
    await collectApiKey(h.deps, {
      actingApiKeyId: null,
      actorHumanId: ALICE,
      requestId: REQ,
    });
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it.each([BOB, STAFF_ADMIN])(
    "answers not found to anyone but the requester (%s)",
    async (who) => {
      const h = setup();
      await expect(
        collectApiKey(h.deps, {
          actingApiKeyId: null,
          actorHumanId: who,
          requestId: REQ,
        }),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "api_key_request_not_found",
      });
      expect(h.apiKeys.collect).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      { decidedAt: null, decision: null, decidedByHumanId: null },
      "api_key_request_not_approved",
    ],
    [
      { decision: "DENIED", denialReason: "No, sorry: not needed" },
      "api_key_request_not_approved",
    ],
    [{ decidedAt: daysAgo(8) }, "api_key_already_collected_or_lapsed"],
    [{ collectedAt: daysAgo(0) }, "api_key_already_collected_or_lapsed"],
    [
      { withdrawnAt: daysAgo(0), withdrawalReason: "ACCOUNT_SECURITY" },
      "api_key_request_closed_for_account_security",
    ],
  ] as const)("refuses %o → %s", async (over, code) => {
    const h = setup(over);
    await expect(
      collectApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).rejects.toMatchObject({ message: code });
    expect(h.apiKeys.collect).not.toHaveBeenCalled();
  });

  it("re-checks the holder at collection (FR-002)", async () => {
    const world = defaultWorld();
    world.orgRoles[ORG]![BOB] = "VIEWER";
    const h = setup(
      { subject: "ORG", orgId: ORG, requesterHumanId: BOB },
      world,
    );
    await expect(
      collectApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: BOB,
        requestId: REQ,
      }),
    ).rejects.toMatchObject({ message: "api_key_holder_no_longer_eligible" });
    expect(h.apiKeys.collect).not.toHaveBeenCalled();
  });

  it("maps the repo's holder_inactive outcome", async () => {
    const h = setup();
    h.apiKeys.collect.mockResolvedValueOnce({
      status: "holder_inactive",
    } as never);
    await expect(
      collectApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "api_key_holder_inactive",
    });
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ["unique_violation", "api_key_already_collected_or_lapsed"],
    [
      "already_collected_or_collect_lapsed",
      "api_key_already_collected_or_lapsed",
    ],
    ["request_withdrawn", "api_key_request_withdrawn"],
    ["request_not_approved", "api_key_request_not_approved"],
    ["key_born_dirty", "api_key_write_refused"],
  ])(
    "maps guard refusal %s → %s, with no plaintext anywhere",
    async (reason, code) => {
      const h = setup();
      h.apiKeys.collect.mockRejectedValueOnce(
        new ApiKeyRepoError({
          code: "guard_refused",
          reason: reason as never,
          constraint: "api_keys_one_collect_per_request",
          sqlState: "23505",
          message: "duplicate key value",
        }),
      );
      const err = await collectApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }).catch((e) => e);
      expect(err).toMatchObject({ message: code });
      expect(JSON.stringify(err)).not.toContain(
        "api_keys_one_collect_per_request",
      );
      expect(h.notifyApiKey).not.toHaveBeenCalled();
    },
  );

  it("refuses a key caller (a key cannot mint a key)", async () => {
    const h = setup();
    await expect(
      collectApiKey(h.deps, {
        actorHumanId: ALICE,
        requestId: REQ,
        actingApiKeyId: ACTING_KEY,
      }),
    ).rejects.toMatchObject({ message: "api_key_session_only" });
  });

  it("reports a failed collected notice; the key is still returned", async () => {
    const h = setup({ subject: "ORG", orgId: ORG });
    h.notifyApiKey.mockRejectedValueOnce(new Error("down"));
    await expect(
      collectApiKey(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).resolves.toMatchObject({ key: PLAINTEXT_IN_TESTS });
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "collectApiKey", notice: "key_collected" },
      extra: { keyId: expect.any(String) },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(
      PLAINTEXT_IN_TESTS,
    );
  });
});
