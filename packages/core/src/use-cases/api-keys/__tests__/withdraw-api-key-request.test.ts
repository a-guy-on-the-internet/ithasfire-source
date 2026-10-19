import { describe, expect, it } from "vitest";

import { withdrawApiKeyRequest } from "../withdraw-api-key-request";
import {
  ACTING_KEY,
  ALICE,
  BOB,
  daysAgo,
  makeHarness,
  makeRequest,
  NOW,
  REQ,
  STAFF_ADMIN,
} from "./api-keys-harness";

function setup(over: Parameters<typeof makeRequest>[0] = {}) {
  const h = makeHarness();
  h.apiKeys.requests.set(REQ, makeRequest(over));
  return h;
}

describe("withdrawApiKeyRequest", () => {
  it("lets the requester withdraw a pending request, audited", async () => {
    const h = setup();
    await expect(
      withdrawApiKeyRequest(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).resolves.toEqual({ requestId: REQ, status: "withdrawn" });
    expect(h.apiKeys.withdraw).toHaveBeenCalledWith({
      requestId: REQ,
      requesterHumanId: ALICE,
    });
    expect(h.auditEntries()[0]).toMatchObject({
      action: "api_key_request.withdrawn",
      data: { actorHumanId: ALICE, holderHumanId: ALICE, requestId: REQ },
    });
  });

  it("lets the requester withdraw a lapsed, undecided request", async () => {
    const h = setup({ createdAt: daysAgo(20) });
    await expect(
      withdrawApiKeyRequest(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).resolves.toMatchObject({ status: "withdrawn" });
  });

  it.each([BOB, STAFF_ADMIN])(
    "answers not found to anyone else (%s)",
    async (who) => {
      const h = setup();
      await expect(
        withdrawApiKeyRequest(h.deps, {
          actingApiKeyId: null,
          actorHumanId: who,
          requestId: REQ,
        }),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "api_key_request_not_found",
      });
      expect(h.audit.log).not.toHaveBeenCalled();
    },
  );

  it("refuses a decided request", async () => {
    const h = setup({
      decidedAt: NOW,
      decision: "APPROVED",
      decidedByHumanId: STAFF_ADMIN,
    });
    await expect(
      withdrawApiKeyRequest(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).rejects.toMatchObject({ message: "api_key_request_already_decided" });
  });

  it("is idempotent: already withdrawn returns its status, no new audit", async () => {
    const h = setup({ withdrawnAt: NOW, withdrawalReason: "REQUESTER" });
    await expect(
      withdrawApiKeyRequest(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).resolves.toMatchObject({ status: "withdrawn" });
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it("a request closed for account security says so, never 'withdrawn' (R31)", async () => {
    const h = setup({ withdrawnAt: NOW, withdrawalReason: "ACCOUNT_SECURITY" });
    await expect(
      withdrawApiKeyRequest(h.deps, {
        actingApiKeyId: null,
        actorHumanId: ALICE,
        requestId: REQ,
      }),
    ).resolves.toMatchObject({ status: "closed_for_account_security" });
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it("refuses a key caller", async () => {
    const h = setup();
    await expect(
      withdrawApiKeyRequest(h.deps, {
        actorHumanId: ALICE,
        requestId: REQ,
        actingApiKeyId: ACTING_KEY,
      }),
    ).rejects.toMatchObject({ message: "api_key_session_only" });
  });
});
