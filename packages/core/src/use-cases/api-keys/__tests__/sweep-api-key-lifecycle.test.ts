import { describe, expect, it } from "vitest";

import { sweepApiKeyLifecycle } from "../sweep-api-key-lifecycle";
import {
  ALICE,
  daysAhead,
  KEY,
  KEY2,
  makeHarness,
  makeKey,
  makeRequest,
  REQ,
} from "./api-keys-harness";

const REQ2 = "c0000000-0000-4000-8000-000000000002";

function setup() {
  const h = makeHarness();
  const deps = {
    repos: h.deps.repos,
    notifyApiKey: h.notifyApiKey,
    reportError: h.reportError,
    logger: h.deps.logger,
  };
  return { h, deps };
}

describe("sweepApiKeyLifecycle", () => {
  it("marks each due row, then sends its notice", async () => {
    const { h, deps } = setup();
    h.apiKeys.listRequestsDueLapseNotice.mockResolvedValueOnce([
      { request: makeRequest(), kind: "pending_lapsed" },
      { request: makeRequest({ id: REQ2 }), kind: "collect_lapsed" },
    ] as never);
    h.apiKeys.listKeysDueExpiryNotice.mockResolvedValueOnce([
      makeKey({ expiresAt: daysAhead(5), autoRenew: false }),
    ] as never);

    const out = await sweepApiKeyLifecycle(deps, {});
    expect(out).toEqual({
      pendingLapseNoticesSent: 1,
      collectLapseNoticesSent: 1,
      expiryNoticesSent: 1,
      noticesFailed: 0,
      skippedMarkRefused: 0,
    });
    expect(h.apiKeys.markRequestLapseNotified).toHaveBeenCalledWith({
      requestId: REQ,
    });
    expect(
      h.apiKeys.markRequestLapseNotified.mock.invocationCallOrder[0]!,
    ).toBeLessThan(h.notifyApiKey.mock.invocationCallOrder[0]!);
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "request_lapsed",
        lapse: "pending_lapsed",
        audience: { kind: "human", humanId: ALICE },
      }),
    );
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "key_expiring",
        keyId: KEY,
        expiresAt: daysAhead(5),
        audience: { kind: "human", humanId: ALICE },
      }),
    );
  });

  it("skips a row whose mark is refused: marked by another sweep, or withdrawn since listing", async () => {
    const { h, deps } = setup();
    h.apiKeys.listRequestsDueLapseNotice.mockResolvedValueOnce([
      { request: makeRequest(), kind: "pending_lapsed" },
    ] as never);
    h.apiKeys.markRequestLapseNotified.mockResolvedValueOnce(false);
    const out = await sweepApiKeyLifecycle(deps, {});
    expect(out.skippedMarkRefused).toBe(1);
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it("reports a failed send, counts it, and carries on", async () => {
    const { h, deps } = setup();
    h.apiKeys.listKeysDueExpiryNotice.mockResolvedValueOnce([
      makeKey({ expiresAt: daysAhead(5) }),
      makeKey({ id: KEY2, expiresAt: daysAhead(6) }),
    ] as never);
    const boom = new Error("mailer down");
    h.notifyApiKey.mockRejectedValueOnce(boom);
    const out = await sweepApiKeyLifecycle(deps, {});
    expect(out).toMatchObject({ expiryNoticesSent: 1, noticesFailed: 1 });
    expect(h.reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "sweepApiKeyLifecycle", notice: "key_expiring" },
      extra: { keyId: KEY },
    });
  });

  it("a throwing reporter does not stop the sweep", async () => {
    const { h, deps } = setup();
    h.apiKeys.listKeysDueExpiryNotice.mockResolvedValueOnce([
      makeKey({ expiresAt: daysAhead(5) }),
      makeKey({ id: KEY2, expiresAt: daysAhead(6) }),
    ] as never);
    h.notifyApiKey.mockRejectedValueOnce(new Error("down"));
    h.reportError.mockImplementationOnce(() => {
      throw new Error("reporter down");
    });
    await expect(sweepApiKeyLifecycle(deps, {})).resolves.toMatchObject({
      expiryNoticesSent: 1,
      noticesFailed: 1,
    });
  });

  it("reads further batches while they come back full, and stops at maxBatches", async () => {
    const { h, deps } = setup();
    h.apiKeys.listRequestsDueLapseNotice.mockResolvedValue([
      { request: makeRequest(), kind: "pending_lapsed" },
    ] as never);
    const out = await sweepApiKeyLifecycle(deps, {
      batchSize: 1,
      maxBatches: 3,
    });
    expect(h.apiKeys.listRequestsDueLapseNotice).toHaveBeenCalledTimes(3);
    expect(out.pendingLapseNoticesSent).toBe(3);
  });

  it("a partial batch ends the loop", async () => {
    const { h, deps } = setup();
    await sweepApiKeyLifecycle(deps, { batchSize: 10 });
    expect(h.apiKeys.listRequestsDueLapseNotice).toHaveBeenCalledTimes(1);
    expect(h.apiKeys.listKeysDueExpiryNotice).toHaveBeenCalledTimes(1);
  });
});
