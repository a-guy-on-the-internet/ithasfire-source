import { describe, expect, it, vi } from "vitest";

import { createNetworkIdentityHasher } from "../../../lib/security/network-identity";
import {
  isEmailBanned,
  type CheckBannedEmailDeps,
} from "../check-banned-email";

const SECRET = "k".repeat(48);
const NOW = new Date("2026-09-29T12:00:00.000Z");

/** A fake bans repo holding EMAIL rows for the given addresses. */
function makeDeps(
  bannedEmails: string[],
  overrides: Partial<CheckBannedEmailDeps> & {
    isActiveImpl?: () => Promise<boolean>;
  } = {},
) {
  const hasher = createNetworkIdentityHasher(SECRET);
  const stored = new Set(bannedEmails.map((e) => hasher.hashEmail(e)!));
  const isActive = vi.fn(
    overrides.isActiveImpl ??
      (async ({ kind, valueHash }: { kind: string; valueHash: string }) =>
        kind === "EMAIL" && stored.has(valueHash)),
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    repos: { bans: { isActive } },
    clock: { now: () => NOW },
    identitySecret: SECRET,
    logger,
    reportError: vi.fn(),
    ...overrides,
  } as unknown as CheckBannedEmailDeps;
  return { deps, isActive, logger };
}

describe("isEmailBanned", () => {
  it("matches the banned address in every as-delivered variant", async () => {
    const { deps } = makeDeps(["banned.person@gmail.com"]);
    for (const variant of [
      "banned.person@gmail.com",
      "BannedPerson@gmail.com",
      "bannedperson+comeback@gmail.com",
      "b.a.n.n.e.d.person+x@googlemail.com",
    ]) {
      await expect(isEmailBanned(deps, variant)).resolves.toBe(true);
    }
  });

  it("matches +tag variants on any domain", async () => {
    const { deps } = makeDeps(["jane@example.com"]);
    await expect(isEmailBanned(deps, "jane+second@example.com")).resolves.toBe(
      true,
    );
    await expect(isEmailBanned(deps, "JANE@EXAMPLE.COM")).resolves.toBe(true);
  });

  it("does not match a different mailbox", async () => {
    const { deps } = makeDeps(["jane@example.com"]);
    await expect(isEmailBanned(deps, "j.ane@example.com")).resolves.toBe(false);
    await expect(isEmailBanned(deps, "someone@example.com")).resolves.toBe(
      false,
    );
  });

  it("looks up a hash, never the address", async () => {
    const { deps, isActive } = makeDeps([]);
    await isEmailBanned(deps, "Jane+x@Example.com");
    const arg = isActive.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe("EMAIL");
    expect(arg.now).toBe(NOW);
    expect(arg.valueHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(arg)).not.toContain("example.com");
  });

  it("fails closed on a lookup error: reported and rethrown", async () => {
    const boom = new Error("db down");
    const { deps, logger } = makeDeps([], {
      isActiveImpl: async () => {
        throw boom;
      },
    });
    await expect(isEmailBanned(deps, "jane@example.com")).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it("when the caller reports, a lookup error is rethrown unreported (one Sentry event)", async () => {
    const boom = new Error("db down");
    const { deps, logger } = makeDeps([], {
      callerReportsLookupFailure: true,
      isActiveImpl: async () => {
        throw boom;
      },
    });
    await expect(isEmailBanned(deps, "jane@example.com")).rejects.toBe(boom);
    expect(deps.reportError).not.toHaveBeenCalled();
    // error-level logs are captured by Sentry's pinoIntegration too.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("callerReportsLookupFailure does not silence the missing-secret report", async () => {
    const { deps } = makeDeps([], {
      identitySecret: null,
      callerReportsLookupFailure: true,
    });
    await expect(isEmailBanned(deps, "jane@example.com")).resolves.toBe(false);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });

  it("without a secret, answers false and reports the misconfiguration", async () => {
    const { deps, isActive } = makeDeps(["jane@example.com"], {
      identitySecret: null,
    });
    await expect(isEmailBanned(deps, "jane@example.com")).resolves.toBe(false);
    expect(isActive).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });

  it("an empty address is never banned", async () => {
    const { deps, isActive } = makeDeps([]);
    await expect(isEmailBanned(deps, "  ")).resolves.toBe(false);
    expect(isActive).not.toHaveBeenCalled();
  });

  it("uses a supplied (memoised) hasher instead of deriving keys per call", async () => {
    const { deps, isActive } = makeDeps([]);
    const hashEmail = vi.fn(() => "f".repeat(64));
    await isEmailBanned(
      { ...deps, hasher: { hashEmail, hashIp: vi.fn() } },
      "jane@example.com",
    );
    expect(hashEmail).toHaveBeenCalledWith("jane@example.com");
    expect(isActive).toHaveBeenCalledWith(
      expect.objectContaining({ valueHash: "f".repeat(64) }),
    );
  });
});
