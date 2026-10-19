import { describe, expect, it } from "vitest";

import { ApiKeyRepoError } from "@th/ports/repos/api-keys";

import { renewApiKeySelf } from "../renew-api-key-self";
import {
  ALICE,
  BOB,
  DAY,
  daysAgo,
  daysAhead,
  defaultWorld,
  KEY,
  KEY2,
  makeHarness,
  makeKey,
  NOW,
  ORG,
  PLAINTEXT_IN_TESTS,
  REQ,
  STAFF_ADMIN,
} from "./api-keys-harness";

function setup(
  over: Parameters<typeof makeKey>[0] = {},
  world = defaultWorld(),
) {
  const h = makeHarness(world);
  h.apiKeys.keys.set(KEY, makeKey(over));
  return h;
}
const call = { actorHumanId: ALICE, actingApiKeyId: KEY };

describe("renewApiKeySelf (FR-009)", () => {
  it("renews the calling key in its last 7 days; plaintext returned once", async () => {
    const h = setup();
    const out = await renewApiKeySelf(h.deps, call);
    expect(out).toEqual({
      keyId: KEY2,
      key: PLAINTEXT_IN_TESTS,
      keyLast4: PLAINTEXT_IN_TESTS.slice(-4),
      expiresAt: daysAhead(30),
      renewedFromKeyId: KEY,
      previousKeyExpiresAt: new Date(NOW.getTime() + DAY),
    });
    expect(h.apiKeys.renew).toHaveBeenCalledWith({
      parentKeyId: KEY,
      holderHumanId: ALICE,
    });
  });

  it("audits with the acting key and a scope snapshot, never the plaintext", async () => {
    const h = setup();
    await renewApiKeySelf(h.deps, call);
    expect(h.auditEntries()[0]).toMatchObject({
      action: "api_key.renewed",
      data: {
        actorHumanId: ALICE,
        actingApiKeyId: KEY,
        keyId: KEY2,
        renewedFromKeyId: KEY,
        holderHumanId: ALICE,
        requestId: REQ,
        subject: "PERSONAL",
        access: "READ",
        decidedByHumanId: STAFF_ADMIN,
        selfApproved: false,
      },
    });
    expect(JSON.stringify(h.audit.log.mock.calls)).not.toContain(
      PLAINTEXT_IN_TESTS,
    );
  });

  it("tells the org's admins when an ORG key renews", async () => {
    const h = setup({ subject: "ORG", orgId: ORG });
    await renewApiKeySelf(h.deps, call);
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "key_renewed",
        audience: { kind: "org_admins", orgId: ORG, excludeHumanId: ALICE },
        renewedFromKeyId: KEY,
      }),
    );
    expect(JSON.stringify(h.notifyApiKey.mock.calls)).not.toContain(
      PLAINTEXT_IN_TESTS,
    );
  });

  it("refuses another human's key (context mismatch) as not found", async () => {
    const h = setup({ humanId: BOB });
    await expect(renewApiKeySelf(h.deps, call)).rejects.toMatchObject({
      message: "api_key_not_found",
    });
    expect(h.apiKeys.renew).not.toHaveBeenCalled();
  });

  it("needs the acting key (key-only)", async () => {
    const h = setup();
    await expect(
      renewApiKeySelf(h.deps, { actorHumanId: ALICE }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a legacy key", async () => {
    const h = setup({
      subject: null,
      access: null,
      requestId: null,
      expiresAt: null,
    });
    await expect(renewApiKeySelf(h.deps, call)).rejects.toMatchObject({
      message: "api_key_legacy_key",
    });
  });

  it.each([
    ["outside the last 7 days", { expiresAt: daysAhead(10) }],
    ["holder's auto-renew off", { autoRenew: false }],
    ["approver switched auto-renew off", { requestAutoRenew: false }],
    ["revoked", { revokedAt: daysAgo(0) }],
    ["expired", { expiresAt: daysAgo(1) }],
    ["never expires", { expiresAt: null }],
  ] as const)("refuses: %s", async (_name, over) => {
    const h = setup(over);
    await expect(renewApiKeySelf(h.deps, call)).rejects.toMatchObject({
      code: "conflict",
      message: "api_key_not_renewable",
    });
    expect(h.apiKeys.renew).not.toHaveBeenCalled();
  });

  it("keeps the role cap: a demoted holder's ORG key does not renew", async () => {
    const world = defaultWorld();
    world.orgRoles[ORG]![ALICE] = "VIEWER";
    const h = setup({ subject: "ORG", orgId: ORG }, world);
    await expect(renewApiKeySelf(h.deps, call)).rejects.toMatchObject({
      message: "api_key_holder_no_longer_eligible",
    });
  });

  it.each([
    ["renewal_overlap", "api_key_not_renewable"],
    ["renewal_not_allowed", "api_key_not_renewable"],
    ["auto_renew_not_allowed", "api_key_not_renewable"],
    ["request_withdrawn", "api_key_request_withdrawn"],
    ["expiry_only_earlier", "api_key_write_refused"],
  ])("maps guard refusal %s → %s", async (reason, code) => {
    const h = setup();
    h.apiKeys.renew.mockRejectedValueOnce(
      new ApiKeyRepoError({
        code: "guard_refused",
        reason: reason as never,
        constraint: "api_keys_guard",
        sqlState: "23514",
        message: "api_keys_guard: renewal refused",
      }),
    );
    await expect(renewApiKeySelf(h.deps, call)).rejects.toMatchObject({
      message: code,
    });
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it("reports a failed renewal notice; the new key is still returned", async () => {
    const h = setup({ subject: "ORG", orgId: ORG });
    h.notifyApiKey.mockRejectedValueOnce(new Error("down"));
    h.reportError.mockImplementationOnce(() => {
      throw new Error("reporter down");
    });
    await expect(renewApiKeySelf(h.deps, call)).resolves.toMatchObject({
      key: PLAINTEXT_IN_TESTS,
    });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});
