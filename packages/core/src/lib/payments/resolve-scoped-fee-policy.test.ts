import { describe, expect, it, vi, type Mock } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type { TxRepos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { resolveScopedFeePolicy } from "./resolve-scoped-fee-policy";

// ─────────────────────────────────────────────────────────────────────────────
// The scope walk runs INSIDE `repos.tx` at every caller. A repo failure at one
// scope therefore cannot be "skipped": Postgres aborts the session on the first
// failed statement, so continuing the walk only fabricated a `null` that the
// caller turned into a typed "misconfigured" error. These tests pin the two
// behaviours that matter and that the fakes CAN express:
//   - a repo failure REJECTS with that error and stops the walk;
//   - a clean MISS (`null`) is not a failure and falls through to the next scope.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-06T12:00:00.000Z");

type Scope = "EVENT" | "ORG" | "GLOBAL";

function buildFeePolicy(overrides: Partial<FeePolicyRecord> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    scopeType: "GLOBAL",
    scopeId: null,
    version: 1,
    ...overrides,
  } as FeePolicyRecord;
}

function makeTx(scoped: Partial<Record<Scope, FeePolicyRecord | null>> = {}) {
  const resolveEffective = vi.fn(
    async ({ scopeType }: { scopeType: Scope }) => scoped[scopeType] ?? null,
  );
  const tx = { feePolicies: { resolveEffective } } as unknown as TxRepos;
  return { tx, resolveEffective };
}

function makeLogger() {
  return createTestLogger() as LoggerPort & { error: Mock; warn: Mock };
}

describe("resolveScopedFeePolicy", () => {
  it("rethrows a repo failure at EVENT scope and does NOT go on to read ORG or GLOBAL", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const reportError = vi.fn();
    const logger = makeLogger();
    const { tx, resolveEffective } = makeTx({ GLOBAL: buildFeePolicy() });
    resolveEffective.mockRejectedValueOnce(boom);

    await expect(
      resolveScopedFeePolicy(
        tx,
        { eventId: EVENT_ID, orgId: ORG_ID },
        NOW,
        { logger, reportError, source: "spec" },
      ),
    ).rejects.toBe(boom);

    expect(resolveEffective).toHaveBeenCalledTimes(1);
    expect(resolveEffective).toHaveBeenCalledWith({
      scopeType: "EVENT",
      scopeId: EVENT_ID,
      at: NOW,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: {
        resolver: "resolveScopedFeePolicy",
        scopeType: "EVENT",
        source: "spec",
      },
      extra: {
        eventId: EVENT_ID,
        orgId: ORG_ID,
        scopeId: EVENT_ID,
        at: NOW.toISOString(),
      },
    });
    // `error`, not `warn` — warn is not captured by the Sentry pino integration.
    expect(logger.error).toHaveBeenCalledWith(
      "fee_policy_resolution_failed",
      expect.objectContaining({
        err: boom,
        scope: { scopeType: "EVENT", scopeId: EVENT_ID },
        source: "spec",
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a repo failure at ORG (after a clean EVENT miss) stops there, tagged with the failing scope", async () => {
    const boom = new Error("deadlock detected");
    const reportError = vi.fn();
    const { tx, resolveEffective } = makeTx({ GLOBAL: buildFeePolicy() });
    resolveEffective.mockImplementationOnce(async () => null);
    resolveEffective.mockRejectedValueOnce(boom);

    await expect(
      resolveScopedFeePolicy(tx, { eventId: EVENT_ID, orgId: ORG_ID }, NOW, {
        reportError,
      }),
    ).rejects.toBe(boom);

    expect(resolveEffective).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ scopeType: "ORG" }),
        extra: expect.objectContaining({ scopeId: ORG_ID }),
      }),
    );
  });

  it("a THROWING reporter never replaces the real error", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const { tx, resolveEffective } = makeTx({ GLOBAL: buildFeePolicy() });
    resolveEffective.mockRejectedValueOnce(boom);

    await expect(
      resolveScopedFeePolicy(tx, { eventId: EVENT_ID, orgId: ORG_ID }, NOW, {
        reportError,
      }),
    ).rejects.toBe(boom);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a clean MISS at EVENT and ORG still falls through to GLOBAL (a miss is null, not a throw)", async () => {
    const globalPolicy = buildFeePolicy();
    const reportError = vi.fn();
    const logger = makeLogger();
    const { tx, resolveEffective } = makeTx({ GLOBAL: globalPolicy });

    await expect(
      resolveScopedFeePolicy(tx, { eventId: EVENT_ID, orgId: ORG_ID }, NOW, {
        logger,
        reportError,
      }),
    ).resolves.toEqual(globalPolicy);

    expect(resolveEffective).toHaveBeenCalledTimes(3);
    expect(
      resolveEffective.mock.calls.map(([arg]) => (arg as { scopeType: Scope }).scopeType),
    ).toEqual(["EVENT", "ORG", "GLOBAL"]);
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("the most specific scope wins and later scopes are not read", async () => {
    const eventPolicy = buildFeePolicy({
      id: "44444444-4444-4444-8444-444444444444",
      scopeType: "EVENT",
      scopeId: EVENT_ID,
    });
    const { tx, resolveEffective } = makeTx({
      EVENT: eventPolicy,
      GLOBAL: buildFeePolicy(),
    });

    await expect(
      resolveScopedFeePolicy(tx, { eventId: EVENT_ID, orgId: ORG_ID }, NOW),
    ).resolves.toEqual(eventPolicy);
    expect(resolveEffective).toHaveBeenCalledTimes(1);
  });

  it("skips the ORG scope for a human-owned event", async () => {
    const { tx, resolveEffective } = makeTx({ GLOBAL: buildFeePolicy() });

    await resolveScopedFeePolicy(tx, { eventId: EVENT_ID, orgId: null }, NOW);

    expect(
      resolveEffective.mock.calls.map(([arg]) => (arg as { scopeType: Scope }).scopeType),
    ).toEqual(["EVENT", "GLOBAL"]);
  });

  it("returns null after a clean miss at every scope without reporting", async () => {
    const reportError = vi.fn();
    const { tx, resolveEffective } = makeTx({});

    await expect(
      resolveScopedFeePolicy(tx, { eventId: EVENT_ID, orgId: ORG_ID }, NOW, {
        reportError,
      }),
    ).resolves.toBeNull();
    expect(resolveEffective).toHaveBeenCalledTimes(3);
    expect(reportError).not.toHaveBeenCalled();
  });
});
