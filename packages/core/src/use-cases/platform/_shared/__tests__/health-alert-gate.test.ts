import { describe, expect, it, vi } from "vitest";

import {
  decideHealthAlert,
  describeSignals,
  fingerprintSignals,
  firingSignals,
  type HealthAlertGateConfig,
  type HealthAlertGateDeps,
  type HealthSignalTable,
} from "../health-alert-gate";

/**
 * The SHARED half of the edge-triggered health gate, tested against a caller
 * that is NOT moderation.
 *
 * That is the whole point of this file. The moderation suite next door already
 * pins the gate's behaviour for moderation — and it passed unchanged through
 * the extraction, which is exactly why it cannot prove the extraction worked.
 * A gate with `"moderationQueueHealth"` still hard-coded somewhere inside
 * would satisfy every one of those tests. These use a second config with
 * different strings and a different counts shape, so anything left welded to
 * the first caller fails here.
 */

interface FakeCounts {
  alpha: number;
  beta: number;
  gamma: number;
}

type FakeInput = { thresholdDays: number };

const SIGNALS: HealthSignalTable<FakeCounts, FakeInput> = {
  alpha: { describe: (n) => `alpha:${n}` },
  beta: { describe: (n, input) => `beta:${n}@${input.thresholdDays}` },
  gamma: { describe: (n) => `gamma:${n}` },
};

const CONFIG: HealthAlertGateConfig = {
  // Any real key from the union; the point is that it is NOT moderation's.
  settingKey: "memberships:healthAlertState",
  logPrefix: "widgetHealth",
  reporterArea: "widgets",
  errorLabel: "widget health",
};

const HEALTHY: FakeCounts = { alpha: 0, beta: 0, gamma: 0 };
const INPUT: FakeInput = { thresholdDays: 7 };
const HOUR_MS = 3_600_000;

function makeSettingsStore() {
  const rows = new Map<
    string,
    { key: string; value: string; updatedAt: Date; createdAt: Date }
  >();
  const rawUpsert = async (key: string, value: string) => {
    const row = {
      key,
      value,
      updatedAt: new Date(),
      createdAt: rows.get(key)?.createdAt ?? new Date(),
    };
    rows.set(key, row);
    return row;
  };
  return {
    rows,
    rawUpsert,
    get: vi.fn(async (key: string) => rows.get(key) ?? null),
    upsert: vi.fn(rawUpsert),
    getAll: vi.fn(async () => [...rows.values()]),
  };
}

function makeHarness(
  overrides: { settings?: ReturnType<typeof makeSettingsStore> } = {},
) {
  const settings = overrides.settings ?? makeSettingsStore();
  const reportError = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  const deps = {
    repos: { platformSettings: settings },
    reportError,
  } as unknown as HealthAlertGateDeps;

  return {
    settings,
    reportError,
    logger,
    run: (at: string, counts: FakeCounts, reAlertAfterMs = 24 * HOUR_MS) =>
      decideHealthAlert(deps, logger as never, CONFIG, {
        fingerprint:
          fingerprintSignals(SIGNALS, counts) === ""
            ? null
            : fingerprintSignals(SIGNALS, counts),
        now: new Date(at),
        reAlertAfterMs,
      }),
  };
}

describe("health-alert-gate — signal table", () => {
  it("fires only on counts above zero, in TABLE order not counts order", () => {
    // Declaration order is the contract: it is both the reading order and the
    // fingerprint's concatenation order, so a `counts` object built in a
    // different key order must not change the string.
    const a = fingerprintSignals(SIGNALS, { alpha: 1, beta: 0, gamma: 3 });
    const b = fingerprintSignals(SIGNALS, {
      gamma: 3,
      beta: 0,
      alpha: 1,
    } as FakeCounts);
    expect(a).toBe("alpha|gamma");
    expect(b).toBe(a);
  });

  it("ignores magnitude entirely", () => {
    const at = (n: number) => fingerprintSignals(SIGNALS, { ...HEALTHY, beta: n });
    expect(at(1)).toBe(at(4_000));
    expect(at(0)).not.toBe(at(1));
  });

  it("distinguishes the same total spread across different signals", () => {
    expect(fingerprintSignals(SIGNALS, { ...HEALTHY, alpha: 4 })).not.toBe(
      fingerprintSignals(SIGNALS, { ...HEALTHY, gamma: 4 }),
    );
  });

  it("describes only the firing signals, in table order, with the caller's input", () => {
    expect(
      describeSignals(SIGNALS, { alpha: 2, beta: 5, gamma: 0 }, INPUT),
    ).toEqual(["alpha:2", "beta:5@7"]);
    expect(firingSignals(SIGNALS, HEALTHY)).toEqual([]);
  });
});

describe("health-alert-gate — send decision", () => {
  it("sends on the first problem and suppresses an identical one", async () => {
    const h = makeHarness();
    const first = await h.run("2026-09-01T00:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });
    expect(first).toEqual({ shouldAlert: true, alertReason: "changed" });

    const second = await h.run("2026-09-01T01:00:00.000Z", {
      ...HEALTHY,
      alpha: 9,
    });
    expect(second).toEqual({ shouldAlert: false, alertReason: "suppressed" });
  });

  it("sends again when the SET of firing signals changes", async () => {
    const h = makeHarness();
    await h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 });
    const changed = await h.run("2026-09-01T01:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
      gamma: 1,
    });
    expect(changed).toEqual({ shouldAlert: true, alertReason: "changed" });
  });

  it("heartbeats once the re-alert window elapses", async () => {
    const h = makeHarness();
    await h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 });
    const inside = await h.run("2026-09-01T23:59:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });
    expect(inside.alertReason).toBe("suppressed");
    const outside = await h.run("2026-09-02T00:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });
    expect(outside).toEqual({ shouldAlert: true, alertReason: "heartbeat" });
  });

  it("honours the CALLER'S window, not a hard-coded 24h", async () => {
    // moderation's default is 24h; the membership job's is 168h. A gate that
    // kept moderation's constant would heartbeat here and this fails.
    const h = makeHarness();
    const week = 168 * HOUR_MS;
    await h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 }, week);
    const dayLater = await h.run(
      "2026-09-02T00:00:00.000Z",
      { ...HEALTHY, alpha: 3 },
      week,
    );
    expect(dayLater.alertReason).toBe("suppressed");
    const weekLater = await h.run(
      "2026-09-08T00:00:01.000Z",
      { ...HEALTHY, alpha: 3 },
      week,
    );
    expect(weekLater.alertReason).toBe("heartbeat");
  });

  it("sends when the stored sentAt is in the FUTURE (clock skew)", async () => {
    const h = makeHarness();
    await h.settings.rawUpsert(
      CONFIG.settingKey,
      JSON.stringify({
        fingerprint: "alpha",
        sentAt: "2030-01-01T00:00:00.000Z",
      }),
    );
    const out = await h.run("2026-09-01T00:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });
    expect(out).toEqual({ shouldAlert: true, alertReason: "heartbeat" });
  });

  it("clears on recovery so an identical recurrence alerts again", async () => {
    const h = makeHarness();
    await h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 });
    const healthy = await h.run("2026-09-01T01:00:00.000Z", HEALTHY);
    expect(healthy).toEqual({ shouldAlert: false, alertReason: "healthy" });
    expect(h.settings.rows.get(CONFIG.settingKey)?.value).toBe("");

    const recurrence = await h.run("2026-09-01T02:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });
    expect(recurrence.alertReason).toBe("changed");
  });

  it("does not rewrite the row on a healthy run with nothing stored", async () => {
    const h = makeHarness();
    await h.run("2026-09-01T00:00:00.000Z", HEALTHY);
    expect(h.settings.upsert).not.toHaveBeenCalled();
  });

  it("writes state under the CALLER'S setting key", async () => {
    // A gate still hard-coding moderation's key would write the wrong row and
    // the two jobs would suppress each other.
    const h = makeHarness();
    await h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 });
    expect(h.settings.get).toHaveBeenCalledWith(CONFIG.settingKey);
    expect([...h.settings.rows.keys()]).toEqual([CONFIG.settingKey]);
  });
});

describe("health-alert-gate — failures fall toward SENDING", () => {
  it("still sends, and reports under the caller's area, when the READ throws", async () => {
    const settings = makeSettingsStore();
    settings.get.mockRejectedValue(new Error("pg is down"));
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });

    expect(out).toEqual({ shouldAlert: true, alertReason: "changed" });
    expect(h.reportError).toHaveBeenCalledOnce();
    expect(h.reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { area: "widgets", operation: "read" },
      extra: { settingKey: CONFIG.settingKey },
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      "widgetHealth.alertState.failed",
      expect.objectContaining({ operation: "read" }),
    );
  });

  it("still sends when the WRITE throws", async () => {
    const settings = makeSettingsStore();
    settings.upsert.mockRejectedValue(new Error("pg is down"));
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });

    expect(out.shouldAlert).toBe(true);
    expect(h.reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { operation: "write" },
    });
  });

  it("RETRIES the clear once, and only reports when both attempts fail", async () => {
    // The documented exception: the clear is the sole path that fails toward
    // SILENCE, so a single transient failure must not leave a stale
    // fingerprint suppressing the next incident.
    const settings = makeSettingsStore();
    const h = makeHarness({ settings });
    await h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 });

    settings.upsert.mockRejectedValueOnce(new Error("transient"));
    const healthy = await h.run("2026-09-01T01:00:00.000Z", HEALTHY);

    expect(healthy.alertReason).toBe("healthy");
    expect(h.logger.warn).toHaveBeenCalledWith(
      "widgetHealth.alertState.clearRetrying",
      expect.objectContaining({ settingKey: CONFIG.settingKey }),
    );
    // The retry landed, so nothing is reported and the row IS cleared.
    expect(h.reportError).not.toHaveBeenCalled();
    expect(settings.rows.get(CONFIG.settingKey)?.value).toBe("");
  });

  it("reports when BOTH clear attempts fail, naming the silence consequence", async () => {
    const settings = makeSettingsStore();
    const h = makeHarness({ settings });
    await h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 });

    settings.upsert.mockRejectedValue(new Error("pg is down"));
    await h.run("2026-09-01T01:00:00.000Z", HEALTHY);

    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ area: "widgets", operation: "clear" }),
      }),
    );
    expect(h.logger.error).toHaveBeenCalledWith(
      "widgetHealth.alertState.failed",
      expect.objectContaining({
        consequence: "stale fingerprint may suppress an identical recurrence",
      }),
    );
  });

  it("treats a corrupt stored value as no state, and logs under the caller's prefix", async () => {
    const settings = makeSettingsStore();
    await settings.rawUpsert(CONFIG.settingKey, "{not json");
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });

    expect(out.shouldAlert).toBe(true);
    // Self-healing, so no reportError — but never silent.
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      "widgetHealth.alertState.corrupt",
      expect.objectContaining({ reason: "invalid_json" }),
    );
  });

  it("treats an unparseable sentAt as no state and sends", async () => {
    const settings = makeSettingsStore();
    await settings.rawUpsert(
      CONFIG.settingKey,
      JSON.stringify({ fingerprint: "alpha", sentAt: "not-a-date" }),
    );
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:00:00.000Z", {
      ...HEALTHY,
      alpha: 3,
    });

    expect(out.shouldAlert).toBe(true);
    expect(h.logger.error).toHaveBeenCalledWith(
      "widgetHealth.alertState.corrupt",
      expect.objectContaining({ reason: "unparseable_sentAt" }),
    );
  });

  it("a THROWING reporter never changes the verdict", async () => {
    const settings = makeSettingsStore();
    settings.get.mockRejectedValue(new Error("pg is down"));
    const h = makeHarness({ settings });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down too");
    });

    await expect(
      h.run("2026-09-01T00:00:00.000Z", { ...HEALTHY, alpha: 3 }),
    ).resolves.toEqual({ shouldAlert: true, alertReason: "changed" });
  });
});
