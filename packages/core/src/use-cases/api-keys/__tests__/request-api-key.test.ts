import { describe, expect, it } from "vitest";

import { ApiKeyRepoError } from "@th/ports/repos/api-keys";

import { requestApiKey } from "../request-api-key";
import {
  ACTING_KEY,
  ALICE,
  BOB,
  CAROL,
  defaultWorld,
  makeHarness,
  MODERATOR,
  ORG,
  OTHER_ORG,
  OUTSIDER,
  STAFF_ADMIN,
  STAFF_REVIEWER,
  SUSPENDED_ADMIN,
  UNVERIFIED,
} from "./api-keys-harness";

const base = {
  actingApiKeyId: null,
  access: "READ",
  label: "ci",
  purpose: "Nightly export of my own orders",
  expiryDays: 30,
  autoRenew: false,
} as const;

function input(over: Record<string, unknown>) {
  return { ...base, ...over };
}

describe("requestApiKey: eligibility (Key scopes table)", () => {
  it.each([
    ["ORG", ALICE, ORG, true],
    ["ORG", BOB, ORG, true],
    ["ORG", CAROL, ORG, false], // VIEWER (R13)
    ["ORG", OUTSIDER, ORG, false], // owner of ANOTHER org
    ["ORG", STAFF_ADMIN, ORG, false], // staff is not an org admin
    ["STAFF", STAFF_ADMIN, null, true],
    ["STAFF", STAFF_REVIEWER, null, true],
    ["STAFF", MODERATOR, null, false], // R28
    ["STAFF", ALICE, null, false],
    ["PERSONAL", ALICE, null, true],
    ["PERSONAL", OUTSIDER, null, true],
    ["PLATFORM_WIDE", OUTSIDER, null, true],
  ] as const)(
    "%s requested by %s → allowed=%s",
    async (subject, who, orgId, ok) => {
      const h = makeHarness();
      const call = requestApiKey(
        h.deps,
        input({ actorHumanId: who, subject, orgId }),
      );
      if (ok) {
        await expect(call).resolves.toMatchObject({ status: "pending" });
        expect(h.apiKeys.createRequest).toHaveBeenCalledTimes(1);
      } else {
        await expect(call).rejects.toMatchObject({
          code: "forbidden",
          message: "api_key_request_not_eligible",
        });
        expect(h.apiKeys.createRequest).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses an unverified email and a suspended human, whatever the subject", async () => {
    const h = makeHarness();
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: UNVERIFIED, subject: "PERSONAL" }),
      ),
    ).rejects.toMatchObject({
      message: "api_key_request_not_eligible",
      meta: { why: "email_unverified" },
    });
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: SUSPENDED_ADMIN, subject: "ORG", orgId: ORG }),
      ),
    ).rejects.toMatchObject({ meta: { why: "inactive" } });
  });

  it("refuses a key caller (session only, FR-008)", async () => {
    const h = makeHarness();
    await expect(
      requestApiKey(
        h.deps,
        input({
          actorHumanId: ALICE,
          subject: "PERSONAL",
          actingApiKeyId: ACTING_KEY,
        }),
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "api_key_session_only",
    });
  });
});

describe("requestApiKey: shape", () => {
  it.each([
    [{ subject: "ORG", orgId: null }, "api_key_org_required"],
    [{ subject: "PERSONAL", orgId: ORG }, "api_key_org_required"],
    [
      { subject: "PLATFORM_WIDE", access: "READ_WRITE" },
      "api_key_platform_wide_read_only",
    ],
    [
      { subject: "STAFF", actorHumanId: STAFF_ADMIN, expiryDays: null },
      "api_key_expiry_not_allowed",
    ],
    [
      { subject: "STAFF", actorHumanId: STAFF_ADMIN, expiryDays: 31 },
      "api_key_expiry_not_allowed",
    ],
    [
      { subject: "PLATFORM_WIDE", expiryDays: 31 },
      "api_key_expiry_not_allowed",
    ],
    [
      { subject: "PERSONAL", expiryDays: 1, autoRenew: true },
      "api_key_auto_renew_needs_term",
    ],
    [
      { subject: "PERSONAL", expiryDays: null, autoRenew: true },
      "api_key_auto_renew_needs_term",
    ],
  ] as const)("%o → %s", async (over, code) => {
    const h = makeHarness();
    await expect(
      requestApiKey(h.deps, input({ actorHumanId: ALICE, ...over })),
    ).rejects.toMatchObject({ message: code });
    expect(h.apiKeys.createRequest).not.toHaveBeenCalled();
  });

  it("allows a never-expiring PERSONAL key and a 2-day auto-renewing one", async () => {
    const h = makeHarness();
    await requestApiKey(
      h.deps,
      input({ actorHumanId: ALICE, subject: "PERSONAL", expiryDays: null }),
    );
    await requestApiKey(
      h.deps,
      input({
        actorHumanId: ALICE,
        subject: "PERSONAL",
        expiryDays: 2,
        autoRenew: true,
      }),
    );
    expect(h.apiKeys.createRequest).toHaveBeenCalledTimes(2);
  });

  it("sanitizes label and purpose before their bounds", async () => {
    const h = makeHarness();
    await requestApiKey(
      h.deps,
      input({
        actorHumanId: ALICE,
        subject: "PERSONAL",
        label: "<b>ci</b>‮",
        purpose: "<script>x</script>Nightly export of orders",
      }),
    );
    expect(h.apiKeys.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "ci",
        purpose: "Nightly export of orders",
      }),
    );
    await expect(
      requestApiKey(
        h.deps,
        input({
          actorHumanId: ALICE,
          subject: "PERSONAL",
          purpose: "<b>short</b>",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses unknown input keys (.strict())", async () => {
    const h = makeHarness();
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL", holderHumanId: BOB }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("requestApiKey: caps (FR-011)", () => {
  it("refuses the holder's sixth slot on a subject", async () => {
    const h = makeHarness();
    h.apiKeys.lockAndCountForCap.mockResolvedValueOnce({
      holderCount: 5,
      orgCount: null,
      holderRequestsLast24h: 0,
    });
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL" }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "api_key_cap_reached",
      meta: { limit: 5, active: 5 },
    });
    expect(h.apiKeys.createRequest).not.toHaveBeenCalled();
  });

  it("refuses the org's 21st slot across holders", async () => {
    const h = makeHarness();
    h.apiKeys.lockAndCountForCap.mockResolvedValueOnce({
      holderCount: 1,
      orgCount: 20,
      holderRequestsLast24h: 0,
    });
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "ORG", orgId: ORG }),
      ),
    ).rejects.toMatchObject({
      message: "api_key_org_cap_reached",
      meta: { limit: 20 },
    });
  });

  it("counts under the lock inside the transaction, before inserting", async () => {
    const h = makeHarness();
    h.apiKeys.lockAndCountForCap.mockResolvedValueOnce({
      holderCount: 4,
      orgCount: 19,
      holderRequestsLast24h: 0,
    });
    await requestApiKey(
      h.deps,
      input({ actorHumanId: ALICE, subject: "ORG", orgId: ORG }),
    );
    expect(h.tx).toHaveBeenCalledTimes(1);
    expect(h.apiKeys.lockAndCountForCap).toHaveBeenCalledWith({
      holderHumanId: ALICE,
      subject: "ORG",
      orgId: ORG,
    });
    expect(
      h.apiKeys.lockAndCountForCap.mock.invocationCallOrder[0]!,
    ).toBeLessThan(h.apiKeys.createRequest.mock.invocationCallOrder[0]!);
  });
});

describe("requestApiKey: per-holder request rate limit (orchestrator abuse limit)", () => {
  it("refuses the 11th request in 24 hours, withdrawn ones included", async () => {
    const h = makeHarness();
    h.apiKeys.lockAndCountForCap.mockResolvedValueOnce({
      holderCount: 0,
      orgCount: null,
      holderRequestsLast24h: 10,
    });
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL" }),
      ),
    ).rejects.toMatchObject({
      code: "rate_limited",
      message: "api_key_request_rate_limited",
      meta: { limit: 10 },
    });
    expect(h.apiKeys.createRequest).not.toHaveBeenCalled();
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it("allows the 10th", async () => {
    const h = makeHarness();
    h.apiKeys.lockAndCountForCap.mockResolvedValueOnce({
      holderCount: 0,
      orgCount: null,
      holderRequestsLast24h: 9,
    });
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL" }),
      ),
    ).resolves.toMatchObject({ status: "pending" });
  });
});

describe("requestApiKey: audit and approvers", () => {
  it("audits a scope snapshot with the actor", async () => {
    const h = makeHarness();
    await requestApiKey(
      h.deps,
      input({ actorHumanId: BOB, subject: "ORG", orgId: ORG }),
    );
    const [entry] = h.auditEntries();
    expect(entry).toMatchObject({
      action: "api_key_request.created",
      data: {
        actorHumanId: BOB,
        actingApiKeyId: null,
        holderHumanId: BOB,
        subject: "ORG",
        orgId: ORG,
        access: "READ",
        label: "ci",
        selfApproved: false,
      },
    });
  });

  it("tells the org's other admins when one exists", async () => {
    const h = makeHarness();
    const out = await requestApiKey(
      h.deps,
      input({ actorHumanId: ALICE, subject: "ORG", orgId: ORG }),
    );
    expect(out.approvers).toBe("org_admins");
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "request_submitted",
        audience: { kind: "org_admins", orgId: ORG, excludeHumanId: ALICE },
      }),
    );
  });

  it("falls back to platform staff for a sole-owner org (a suspended admin does not count)", async () => {
    const world = defaultWorld();
    world.orgRoles[ORG] = { [ALICE]: "OWNER", [SUSPENDED_ADMIN]: "ADMIN" };
    const h = makeHarness(world);
    const out = await requestApiKey(
      h.deps,
      input({ actorHumanId: ALICE, subject: "ORG", orgId: ORG }),
    );
    expect(out.approvers).toBe("platform_staff");
    expect(h.apiKeys.orgHasOtherLiveApprover).toHaveBeenCalledWith({
      orgId: ORG,
      excludeHumanId: ALICE,
    });
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: expect.objectContaining({ kind: "platform_staff" }),
      }),
    );
  });

  it("sends STAFF and PLATFORM_WIDE requests to staff ADMINs", async () => {
    const h = makeHarness();
    const out = await requestApiKey(
      h.deps,
      input({ actorHumanId: OUTSIDER, subject: "PLATFORM_WIDE" }),
    );
    expect(out.approvers).toBe("staff_admins");
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: { kind: "platform_staff", roles: ["ADMIN"] },
      }),
    );
  });

  it("ignores a client-supplied org on another org (rights come from the org the request names)", async () => {
    const h = makeHarness();
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "ORG", orgId: OTHER_ORG }),
      ),
    ).rejects.toMatchObject({ message: "api_key_request_not_eligible" });
  });
});

describe("requestApiKey: swallowed notice failure (ReporterPort)", () => {
  it("reports a failed notice and still returns the request", async () => {
    const h = makeHarness();
    const boom = new Error("mailer down");
    h.notifyApiKey.mockRejectedValueOnce(boom);
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL" }),
      ),
    ).resolves.toMatchObject({ status: "pending" });
    expect(h.reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "requestApiKey", notice: "request_submitted" },
      extra: { requestId: expect.any(String) },
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      "api_keys.notice_failed",
      expect.objectContaining({ notice: "request_submitted" }),
    );
  });

  it("a throwing reporter never changes the outcome", async () => {
    const h = makeHarness();
    h.notifyApiKey.mockRejectedValueOnce(new Error("mailer down"));
    h.reportError.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL" }),
      ),
    ).resolves.toMatchObject({ status: "pending" });
  });
});

describe("requestApiKey: repo refusals", () => {
  const refusal = (
    code: "guard_refused" | "retryable",
    reason: string | null,
  ) =>
    new ApiKeyRepoError({
      code,
      reason: reason as never,
      constraint: "api_key_requests_expiry_days_cap",
      sqlState: code === "retryable" ? "40P01" : "23514",
      message:
        'new row violates check constraint "api_key_requests_expiry_days_cap"',
    });

  it("maps a guard refusal core should have caught to a stable code, never the DB text", async () => {
    const h = makeHarness();
    h.apiKeys.createRequest.mockRejectedValueOnce(
      refusal("guard_refused", "check_violation"),
    );
    const err = await requestApiKey(
      h.deps,
      input({ actorHumanId: ALICE, subject: "PERSONAL" }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "conflict",
      message: "api_key_write_refused",
    });
    expect(JSON.stringify(err)).not.toContain(
      "api_key_requests_expiry_days_cap",
    );
    expect((err as Error).message).not.toContain("violates");
    expect(h.logger.error).toHaveBeenCalledWith(
      "api_keys.guard_refused_unexpected_write",
      expect.objectContaining({
        constraint: "api_key_requests_expiry_days_cap",
      }),
    );
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it("retries the whole transaction once on a deadlock", async () => {
    const h = makeHarness();
    h.apiKeys.createRequest.mockRejectedValueOnce(refusal("retryable", null));
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL" }),
      ),
    ).resolves.toMatchObject({ status: "pending" });
    expect(h.tx).toHaveBeenCalledTimes(2);
    expect(h.notifyApiKey).toHaveBeenCalledTimes(1);
  });

  it("surfaces a second deadlock as api_key_busy_retry", async () => {
    const h = makeHarness();
    h.apiKeys.createRequest
      .mockRejectedValueOnce(refusal("retryable", null))
      .mockRejectedValueOnce(refusal("retryable", null));
    await expect(
      requestApiKey(
        h.deps,
        input({ actorHumanId: ALICE, subject: "PERSONAL" }),
      ),
    ).rejects.toMatchObject({ message: "api_key_busy_retry" });
    expect(h.tx).toHaveBeenCalledTimes(2);
  });
});
