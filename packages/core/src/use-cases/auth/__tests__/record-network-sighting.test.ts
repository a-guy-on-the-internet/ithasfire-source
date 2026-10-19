import { describe, expect, it, vi } from "vitest";

import { recordNetworkSighting } from "../record-network-sighting";
import type { RecordNetworkSightingDeps } from "../record-network-sighting";

const SECRET = "k".repeat(48);
const AUTH_USER_ID = "auth-user-1";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const RAW_IP = "198.51.100.23";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.120 Safari/537.36";

function makeDeps(
  overrides: Partial<RecordNetworkSightingDeps> & {
    recordImpl?: () => Promise<void>;
  } = {},
) {
  const record = vi.fn(overrides.recordImpl ?? (async () => undefined));
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const deps = {
    repos: { networkSightings: { record } },
    identitySecret: SECRET,
    logger,
    reportError: vi.fn(),
    ...overrides,
  } as unknown as RecordNetworkSightingDeps;
  return { deps, record, logger };
}

const input = {
  authUserId: AUTH_USER_ID,
  humanId: HUMAN_ID,
  kind: "SIGN_UP" as const,
  clientIp: RAW_IP,
  countryHeader: "de",
  userAgent: CHROME_MAC,
};

describe("recordNetworkSighting", () => {
  it("hands the repo keyed hashes only — the raw IP and UA never reach it", async () => {
    const { deps, record } = makeDeps();

    await expect(recordNetworkSighting(deps, input)).resolves.toBe("recorded");

    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toEqual({
      authUserId: AUTH_USER_ID,
      humanId: HUMAN_ID,
      kind: "SIGN_UP",
      ipHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      networkHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      country: "DE",
      userAgentFamily: "Chrome on macOS",
    });
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain("198.51.100");
    expect(serialized).not.toContain("Mozilla");
    expect(serialized).not.toContain("128.0");
  });

  it("is deterministic: the same address twice gives the same hashes", async () => {
    const { deps, record } = makeDeps();
    await recordNetworkSighting(deps, input);
    await recordNetworkSighting(deps, { ...input, kind: "SIGN_IN" });
    const [a, b] = record.mock.calls.map(
      (c) => c[0] as { ipHash: string; networkHash: string },
    );
    expect(a!.ipHash).toBe(b!.ipHash);
    expect(a!.networkHash).toBe(b!.networkHash);
  });

  it("skips quietly when there is no usable IP", async () => {
    const { deps, record, logger } = makeDeps();
    await expect(
      recordNetworkSighting(deps, { ...input, clientIp: null }),
    ).resolves.toBe("skipped_no_ip");
    await expect(
      recordNetworkSighting(deps, { ...input, clientIp: "forged<value>" }),
    ).resolves.toBe("skipped_no_ip");
    expect(record).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("reports (and does not write) when the secret is missing", async () => {
    const { deps, record, logger } = makeDeps({ identitySecret: undefined });
    await expect(recordNetworkSighting(deps, input)).resolves.toBe(
      "skipped_no_secret",
    );
    expect(record).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "auth.network_sighting.secret_missing",
      expect.anything(),
    );
    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });

  it("is best-effort: a failed write is swallowed, logged at ERROR and reported", async () => {
    const boom = new Error("db down");
    const { deps, logger } = makeDeps({
      recordImpl: async () => {
        throw boom;
      },
    });

    await expect(recordNetworkSighting(deps, input)).resolves.toBe("failed");

    expect(logger.error).toHaveBeenCalledWith(
      "auth.network_sighting.record_failed",
      expect.objectContaining({ err: boom, kind: "SIGN_UP" }),
    );
    expect(deps.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ op: "network_sighting" }),
      }),
    );
  });

  it("a throwing reporter never changes the outcome", async () => {
    const { deps } = makeDeps({
      recordImpl: async () => {
        throw new Error("db down");
      },
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    await expect(recordNetworkSighting(deps, input)).resolves.toBe("failed");
  });

  it("invalid input is swallowed as a failure, never thrown", async () => {
    const { deps, record } = makeDeps();
    await expect(
      recordNetworkSighting(deps, { ...input, kind: "BOGUS" }),
    ).resolves.toBe("failed");
    expect(record).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });
});
