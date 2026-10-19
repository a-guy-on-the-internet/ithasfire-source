import { describe, expect, it, vi } from "vitest";

import {
  getModerationAlertState,
  type ModerationAlertStateDeps,
} from "../get-moderation-alert-state";
import { MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY } from "../report-moderation-queue-health";

const KEY = MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY;
const NOW = new Date("2026-09-12T12:00:00.000Z");

function makeLogger() {
  const logger: any = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

/**
 * `upsert` THROWS. Not a spy that records the call — a throw, so a write added
 * to this file fails the test loudly rather than being asserted about later by
 * a `not.toHaveBeenCalled()` somebody might delete.
 */
function makeDeps(value: string | null | undefined) {
  const get = vi.fn(async (key: string) =>
    value === undefined
      ? null
      : { key, value: value as string, createdAt: NOW, updatedAt: NOW },
  );
  const upsert = vi.fn(async () => {
    throw new Error("alert-state read path WROTE to platformSettings");
  });
  const logger = makeLogger();
  const reportError = vi.fn();
  const deps = {
    repos: { platformSettings: { get, upsert, getAll: vi.fn(async () => []) } },
    logger,
    reportError,
  } as unknown as ModerationAlertStateDeps;
  return { deps, get, upsert, logger, reportError };
}

describe("getModerationAlertState", () => {
  it("NEVER writes — a page load must not reset the edge-trigger fingerprint", async () => {
    // THE constraint. `reportModerationQueueHealth` answers the same question
    // and WRITES the fingerprint + `sentAt` as part of its gate, so reusing it
    // here would reset the suppression window on every page load and a
    // healthy-looking read would CLEAR the row and re-arm an alert that had
    // already fired. Half of that guarantee is this test; do not delete it.
    const { deps, upsert } = makeDeps(
      JSON.stringify({ fingerprint: "awaitingReview", sentAt: NOW.toISOString() }),
    );

    await expect(getModerationAlertState(deps)).resolves.toMatchObject({
      state: "paged",
    });

    expect(upsert).not.toHaveBeenCalled();
  });

  it("reports `never_paged` when the setting row does not exist", async () => {
    const { deps, get } = makeDeps(undefined);

    const out = await getModerationAlertState(deps);

    expect(out).toEqual({
      settingKey: KEY,
      state: "never_paged",
      fingerprint: null,
      firingSignals: [],
      lastPagedAt: null,
    });
    expect(get).toHaveBeenCalledWith(KEY);
  });

  it("distinguishes `cleared` from `never_paged`", async () => {
    // Different facts about the same nulls. "Nothing has ever paged" and
    // "something paged, then recovered, and the gate is re-armed" call for
    // different reads of a live number, and `PlatformSettingsRepo` has no
    // delete so recovery looks like an empty string.
    const { deps } = makeDeps("");

    const out = await getModerationAlertState(deps);

    expect(out.state).toBe("cleared");
    expect(out.fingerprint).toBeNull();
    expect(out.lastPagedAt).toBeNull();
  });

  it("returns the outstanding picture and when it last paged", async () => {
    const sentAt = new Date("2026-09-12T09:30:00.000Z");
    const { deps } = makeDeps(
      JSON.stringify({
        fingerprint: "pendingOverdue|degradedRecent",
        sentAt: sentAt.toISOString(),
      }),
    );

    const out = await getModerationAlertState(deps);

    expect(out).toEqual({
      settingKey: KEY,
      state: "paged",
      fingerprint: "pendingOverdue|degradedRecent",
      firingSignals: ["pendingOverdue", "degradedRecent"],
      lastPagedAt: sentAt,
    });
  });

  it("does NOT validate stored signal names against the current enum", async () => {
    // A stored fingerprint is a historical record written by an older deploy.
    // A signal since renamed or removed is exactly the thing an operator needs
    // to SEE, not have silently dropped into an empty list.
    const { deps } = makeDeps(
      JSON.stringify({
        fingerprint: "someRetiredSignal",
        sentAt: NOW.toISOString(),
      }),
    );

    const out = await getModerationAlertState(deps);

    expect(out.firingSignals).toEqual(["someRetiredSignal"]);
  });

  it.each([
    ["invalid JSON", "not json at all"],
    ["wrong shape", JSON.stringify({ nope: true })],
    ["unparseable sentAt", JSON.stringify({ fingerprint: "x", sentAt: "soon" })],
  ])("degrades a %s value to `unreadable` and REPORTS it", async (_label, raw) => {
    // A corrupt bookkeeping row must not take down the page an operator opened
    // to find out what is wrong — but the swallow has to be Sentry-visible.
    // CLAUDE.md is unambiguous that `logger.warn` would make it invisible.
    const { deps, logger, reportError } = makeDeps(raw);

    const out = await getModerationAlertState(deps);

    expect(out.state).toBe("unreadable");
    expect(out.fingerprint).toBeNull();
    expect(out.lastPagedAt).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "moderation.alertState.unreadable",
      expect.objectContaining({ settingKey: KEY }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "alert-state-unreadable" },
      }),
    );
  });

  it("never logs the stored VALUE, only its shape", async () => {
    const { deps, logger } = makeDeps("definitely-not-json-secret-ish");

    await getModerationAlertState(deps);

    const [, meta] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(meta)).not.toContain("secret-ish");
    expect(meta.length).toBe("definitely-not-json-secret-ish".length);
  });

  it("survives a THROWING reporter without changing its answer", async () => {
    const { deps } = makeDeps("not json");
    (deps as { reportError?: unknown }).reportError = () => {
      throw new Error("sentry is down");
    };

    await expect(getModerationAlertState(deps)).resolves.toMatchObject({
      state: "unreadable",
    });
  });

  it("PROPAGATES a store failure rather than fabricating `never_paged`", async () => {
    // The deliberate asymmetry. An unparseable value is a bookkeeping defect
    // the page can render around; a database that will not answer must surface
    // as an error, because a fabricated all-clear on the one surface that
    // exists to say what is wrong is the failure mode this whole directory is
    // about.
    const { deps } = makeDeps(null);
    (
      deps.repos.platformSettings as unknown as { get: ReturnType<typeof vi.fn> }
    ).get.mockRejectedValueOnce(new Error("db down"));

    await expect(getModerationAlertState(deps)).rejects.toThrow("db down");
  });

  it("rejects unknown input keys", async () => {
    const { deps } = makeDeps(undefined);

    await expect(
      getModerationAlertState(deps, { settingKey: "something:else" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
