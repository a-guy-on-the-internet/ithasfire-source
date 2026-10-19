import { describe, expect, it, vi } from "vitest";

import type { FeePolicyRecord } from "@th/types";

import { DEFAULT_PAYOUT_MINIMUM_CENTS } from "../../../settlements/run-batch";
import {
  belowPayoutMinimum,
  readPayoutMinimum,
  type PayoutMinimumDeps,
} from "../payout-minimum";

const NOW = new Date("2026-09-14T12:00:00.000Z");

const TELEMETRY = {
  logEvent: "some_view_fee_policy_lookup_failed",
  useCase: "someView",
  step: "resolveFeePolicy",
};

type Options = {
  /** `undefined` → a policy row carrying 2_500. `null` → NO policy row. */
  policy?: FeePolicyRecord | null;
  fail?: boolean;
  reportError?: (err: unknown, ctx?: unknown) => void;
  omitReporter?: boolean;
};

function makeDeps(options: Options = {}) {
  const failure = new Error("fee policy read timed out");
  const resolveEffective = vi.fn(async () => {
    if (options.fail) throw failure;
    return options.policy === undefined
      ? ({ payoutMinimumCents: 2_500 } as unknown as FeePolicyRecord)
      : options.policy;
  });
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const reportError = vi.fn(
    options.reportError ?? ((_err: unknown, _ctx?: unknown) => {}),
  );

  const deps = {
    repos: { feePolicies: { resolveEffective } },
    logger,
    ...(options.omitReporter ? {} : { reportError }),
  } as unknown as PayoutMinimumDeps;

  return { deps, resolveEffective, logger, reportError, failure };
}

describe("readPayoutMinimum — the three states", () => {
  it("A POLICY ROW: reports the row's own minimum, resolved", async () => {
    const h = makeDeps();

    const out = await readPayoutMinimum(h.deps, {
      asOf: NOW,
      telemetry: TELEMETRY,
    });

    expect(out).toEqual({ minimumResolved: true, payoutMinimumCents: 2_500 });
    // The GLOBAL scope, at the caller's clock — the same read the batch does.
    expect(h.resolveEffective).toHaveBeenCalledWith({
      scopeType: "GLOBAL",
      scopeId: null,
      at: NOW,
    });
  });

  it("NO POLICY ROW: falls back to the batch's OWN default, and is RESOLVED", async () => {
    const h = makeDeps({ policy: null });

    const out = await readPayoutMinimum(h.deps, {
      asOf: NOW,
      telemetry: TELEMETRY,
    });

    // A defined answer, not a guess: `run-batch.ts` §2 uses this exact
    // literal, so reporting it is reporting what tonight actually does.
    expect(out).toEqual({
      minimumResolved: true,
      payoutMinimumCents: DEFAULT_PAYOUT_MINIMUM_CENTS,
    });
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("A FAILED READ: null and unresolved — NEVER the batch default", async () => {
    const h = makeDeps({ fail: true });

    const out = await readPayoutMinimum(h.deps, {
      asOf: NOW,
      telemetry: TELEMETRY,
    });

    expect(out).toEqual({ minimumResolved: false, payoutMinimumCents: null });
    // THE ASSERTION THIS FILE EXISTS FOR. Substituting the default here makes
    // every test above still pass while the product measures a payee against
    // a threshold nobody read.
    expect(out.payoutMinimumCents).not.toBe(DEFAULT_PAYOUT_MINIMUM_CENTS);
  });

  it("never throws, even when the repo is missing entirely", async () => {
    const deps = { repos: {} } as unknown as PayoutMinimumDeps;

    await expect(
      readPayoutMinimum(deps, { asOf: NOW, telemetry: TELEMETRY }),
    ).resolves.toEqual({ minimumResolved: false, payoutMinimumCents: null });
  });
});

describe("readPayoutMinimum — swallow discipline", () => {
  it("logs at ERROR and reports, with the caller's telemetry", async () => {
    const h = makeDeps({ fail: true });

    await readPayoutMinimum(h.deps, { asOf: NOW, telemetry: TELEMETRY });

    expect(h.logger.error).toHaveBeenCalledWith(TELEMETRY.logEvent, {
      err: h.failure,
    });
    expect(h.reportError).toHaveBeenCalledWith(h.failure, {
      tags: { useCase: TELEMETRY.useCase, step: TELEMETRY.step },
    });
  });

  it("never demotes the swallow to logger.warn — warn is not captured by Sentry", async () => {
    const h = makeDeps({ fail: true });

    await readPayoutMinimum(h.deps, { asOf: NOW, telemetry: TELEMETRY });

    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("a THROWING reporter never changes the result", async () => {
    const h = makeDeps({
      fail: true,
      reportError: () => {
        throw new Error("sentry is down");
      },
    });

    await expect(
      readPayoutMinimum(h.deps, { asOf: NOW, telemetry: TELEMETRY }),
    ).resolves.toEqual({ minimumResolved: false, payoutMinimumCents: null });
  });

  it("a MISSING reporter never changes the result", async () => {
    const h = makeDeps({ fail: true, omitReporter: true });

    await expect(
      readPayoutMinimum(h.deps, { asOf: NOW, telemetry: TELEMETRY }),
    ).resolves.toEqual({ minimumResolved: false, payoutMinimumCents: null });
  });
});

describe("belowPayoutMinimum", () => {
  it("TRUE when the payable does not clear the threshold", () => {
    // The $6-on-a-Friday case this block exists for.
    expect(belowPayoutMinimum(600, 1_000)).toBe(true);
  });

  it("FALSE when it clears, and at the boundary the batch itself pays", () => {
    expect(belowPayoutMinimum(1_000, 1_000)).toBe(false);
    expect(belowPayoutMinimum(1_001, 1_000)).toBe(false);
  });

  it("TRUE for a carried-forward DEBT — nothing goes out either way", () => {
    expect(belowPayoutMinimum(-3_000, 1_000)).toBe(true);
  });

  it("NULL — not false — when the minimum is unknown", () => {
    const verdict = belowPayoutMinimum(600, null);
    expect(verdict).toBeNull();
    expect(verdict).not.toBe(false);
  });

  it("NULL — not false — when the payable is unknown", () => {
    const verdict = belowPayoutMinimum(null, 1_000);
    expect(verdict).toBeNull();
    expect(verdict).not.toBe(false);
  });

  it("NULL when both are unknown", () => {
    expect(belowPayoutMinimum(null, null)).toBeNull();
  });
});
