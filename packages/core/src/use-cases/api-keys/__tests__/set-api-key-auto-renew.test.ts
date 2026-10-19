import { describe, expect, it } from "vitest";

import { setApiKeyAutoRenew } from "../set-api-key-auto-renew";
import {
  ACTING_KEY,
  defaultWorld,
  OTHER_ORG,
  type World,
  ALICE,
  BOB,
  CAROL,
  daysAgo,
  KEY,
  makeHarness,
  makeKey,
  makeRequest,
  ORG,
  OUTSIDER,
  REQ,
  STAFF_ADMIN,
  STAFF_REVIEWER,
} from "./api-keys-harness";

function setup(
  over: Parameters<typeof makeKey>[0] = {},
  world: World = defaultWorld(),
) {
  const h = makeHarness(world);
  h.apiKeys.keys.set(KEY, makeKey(over));
  h.apiKeys.requests.set(REQ, makeRequest({ autoRenew: true, expiryDays: 30 }));
  return h;
}

describe("setApiKeyAutoRenew", () => {
  it("the holder switches their key off, audited", async () => {
    const h = setup();
    await expect(
      setApiKeyAutoRenew(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        keyId: KEY,
        autoRenew: false,
      }),
    ).resolves.toEqual({
      keyId: KEY,
      switchedOn: "key",
      changed: true,
      autoRenew: false,
    });
    expect(h.apiKeys.setKeyAutoRenew).toHaveBeenCalledWith({
      keyId: KEY,
      autoRenew: false,
    });
    expect(h.auditEntries()[0]).toMatchObject({
      action: "api_key.auto_renew_off",
      data: {
        actorHumanId: ALICE,
        keyId: KEY,
        switch: "key",
        holderHumanId: ALICE,
      },
    });
  });

  it("the holder cannot switch on after the approver switched off", async () => {
    const h = setup({ autoRenew: false, requestAutoRenew: false });
    await expect(
      setApiKeyAutoRenew(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        keyId: KEY,
        autoRenew: true,
      }),
    ).rejects.toMatchObject({ message: "api_key_auto_renew_not_allowed" });
  });

  it("a revoked key does not change", async () => {
    const h = setup({ revokedAt: daysAgo(1) });
    await expect(
      setApiKeyAutoRenew(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        keyId: KEY,
        autoRenew: false,
      }),
    ).rejects.toMatchObject({ message: "api_key_not_live" });
  });

  it("unchanged → changed:false, no audit", async () => {
    const h = setup({ autoRenew: false });
    await expect(
      setApiKeyAutoRenew(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        keyId: KEY,
        autoRenew: false,
      }),
    ).resolves.toMatchObject({ changed: false });
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it.each([
    [
      "org admin on an ORG key",
      { subject: "ORG", orgId: ORG },
      BOB,
      "org_admin",
    ],
    ["staff ADMIN", {}, STAFF_ADMIN, "staff_admin"],
    [
      "the decider, still platform staff (no revoke right)",
      { decidedByHumanId: STAFF_REVIEWER },
      STAFF_REVIEWER,
      "decider",
    ],
  ] as const)(
    "%s switches off on the request, for good",
    async (_n, over, actor, as) => {
      const h = setup(over);
      await expect(
        setApiKeyAutoRenew(h.deps, {
          actingApiKeyId: null,
          actorHumanId: actor,
          keyId: KEY,
          autoRenew: false,
        }),
      ).resolves.toEqual({
        keyId: KEY,
        switchedOn: "request",
        changed: true,
        autoRenew: false,
      });
      expect(h.apiKeys.switchOffRequestAutoRenew).toHaveBeenCalledWith({
        requestId: REQ,
      });
      expect(h.apiKeys.setKeyAutoRenew).not.toHaveBeenCalled();
      expect(h.auditEntries()[0]).toMatchObject({
        action: "api_key_request.auto_renew_off",
        data: {
          switch: "request",
          switchedOffAs: as,
          switchedOffKeyIds: [KEY],
        },
      });
    },
  );

  it.each([
    [
      "PERSONAL key, decider no longer staff",
      { decidedByHumanId: STAFF_REVIEWER },
      STAFF_REVIEWER,
      (w: World) => {
        w.staffRoles[STAFF_REVIEWER] = [];
      },
    ],
    [
      "ORG key, decider demoted to viewer and not staff",
      { subject: "ORG", orgId: ORG, decidedByHumanId: CAROL },
      CAROL,
      () => {},
    ],
    [
      "ORG key on another org, decider is an admin elsewhere",
      {
        subject: "ORG",
        orgId: OTHER_ORG,
        humanId: OUTSIDER,
        decidedByHumanId: BOB,
      },
      BOB,
      () => {},
    ],
    [
      "STAFF key, decider now only a reviewer",
      { subject: "STAFF", decidedByHumanId: STAFF_REVIEWER },
      STAFF_REVIEWER,
      () => {},
    ],
  ] as const)(
    "a decider who lost the role is told not found: %s",
    async (_n, over, actor, mutate) => {
      const world = defaultWorld();
      mutate(world);
      const h = setup(over, world);
      await expect(
        setApiKeyAutoRenew(h.deps, {
          actingApiKeyId: null,
          actorHumanId: actor,
          keyId: KEY,
          autoRenew: false,
        }),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "api_key_not_found",
      });
      expect(h.apiKeys.switchOffRequestAutoRenew).not.toHaveBeenCalled();
      expect(h.apiKeys.setKeyAutoRenew).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    },
  );

  it("an approver cannot switch auto-renew on", async () => {
    const h = setup();
    await expect(
      setApiKeyAutoRenew(h.deps, {
        actingApiKeyId: null,
        actorHumanId: STAFF_ADMIN,
        keyId: KEY,
        autoRenew: true,
      }),
    ).rejects.toMatchObject({ message: "api_key_auto_renew_not_allowed" });
  });

  it.each([CAROL, OUTSIDER, BOB])(
    "anyone else gets not found (%s)",
    async (who) => {
      const h = setup(); // a PERSONAL key: BOB the org admin has no right to it
      await expect(
        setApiKeyAutoRenew(h.deps, {
          actingApiKeyId: null,
          actorHumanId: who,
          keyId: KEY,
          autoRenew: false,
        }),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "api_key_not_found",
      });
      expect(h.apiKeys.switchOffRequestAutoRenew).not.toHaveBeenCalled();
    },
  );

  it("refuses a legacy key and a key caller", async () => {
    const legacy = setup({ subject: null, access: null, requestId: null });
    await expect(
      setApiKeyAutoRenew(legacy.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        keyId: KEY,
        autoRenew: false,
      }),
    ).rejects.toMatchObject({ message: "api_key_legacy_key" });

    const h = setup();
    await expect(
      setApiKeyAutoRenew(h.deps, {
        actorHumanId: ALICE,
        keyId: KEY,
        autoRenew: false,
        actingApiKeyId: ACTING_KEY,
      }),
    ).rejects.toMatchObject({ message: "api_key_session_only" });
  });
});
