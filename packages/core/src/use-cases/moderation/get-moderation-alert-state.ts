import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY } from "./report-moderation-queue-health";

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY VIEW OF THE EDGE-TRIGGER STATE. THE EMPHASIS IS ON READ-ONLY.
//
// WHY AN OPERATOR NEEDS THIS. The hourly Discord alert is edge-triggered: it
// pages when the SET of firing signals changes, or when an unchanged picture
// goes stale, and stays quiet otherwise. That is the right design and it makes
// the dashboard ambiguous — "7 awaiting review" could be a known backlog
// someone is already sitting on, or something that started four minutes ago and
// nobody has been told about. Those call for opposite actions and the tile
// looks identical either way.
//
// WHY IT IS A SEPARATE USE CASE AND NOT A FIELD ON THE SNAPSHOT. The obvious
// move — have the page call `reportModerationQueueHealth` — is the bug this
// whole cluster of files keeps warning about. That use case WRITES the
// fingerprint and `sentAt` as part of its gate, so every page load would reset
// the suppression window, and a healthy-looking read would CLEAR the row and
// re-arm an alert that had already fired. A human watching a dashboard would
// silently change who gets paged and when.
//
// So this reads `platformSettings.get()` and nothing else. The containment is
// the same two-part deal as `get-moderation-queue-snapshot.ts`:
//   1. TYPE-LEVEL: the deps are `Pick<Repos, "platformSettings">`, which still
//      exposes `upsert` — there is no narrower Pick available. So the type
//      level does NOT carry this one on its own; it only makes the write
//      visible in a diff.
//   2. TEST-LEVEL: `get-moderation-alert-state.test.ts` runs this against a
//      `platformSettings` whose `upsert` THROWS on any call, so a write added
//      here fails loudly instead of quietly breaking the alert's edge trigger.
// Because half the guarantee is a test, do not delete that test.
//
// PARSING IS DEFENSIVE BY DESIGN. An absent row, an empty value, malformed
// JSON, or an unparseable timestamp all resolve to a named state rather than an
// exception. This is a dashboard: a corrupt bookkeeping row must not take down
// the page an operator opened to find out what is wrong. A STORE failure is a
// different thing and is left to throw — see below.
// ─────────────────────────────────────────────────────────────────────────────

export type ModerationAlertStateDeps = {
  repos: Pick<Repos, "platformSettings">;
  logger: LoggerPort;
  /**
   * Sentry for the ONE swallow in this file (a stored value we cannot parse).
   * Guarded at the call site so a throwing reporter can never change behaviour
   * — CLAUDE.md's error-reporting convention.
   */
  reportError?: ReporterPort;
};

export const getModerationAlertStateInputSchema = z.object({}).strict();

export type GetModerationAlertStateInput = z.infer<
  typeof getModerationAlertStateInputSchema
>;

/**
 * How to read `fingerprint` / `lastPagedAt`.
 *
 * - `never_paged`  — the setting row does not exist. Nothing has ever paged for
 *   this queue. Both fields are null.
 * - `cleared`      — the row exists and is empty, which is how a HEALTHY run
 *   clears it. Something paged once, the problem resolved, and the gate is
 *   re-armed: an identical problem arriving now would page immediately. Both
 *   fields are null.
 * - `paged`        — a problem picture is outstanding. `fingerprint` is the set
 *   of signals that fired and `lastPagedAt` is when Discord was last told.
 * - `unreadable`   — the row holds something this code cannot parse. Reported
 *   to Sentry. Treat the alert state as UNKNOWN, not as healthy: a corrupt row
 *   reads as "nothing suppressed" to the gate, so alerting still works, but
 *   nothing on this page can be trusted to say whether someone was told.
 *
 * Deliberately four named states rather than a nullable fingerprint plus a
 * boolean. "Never paged" and "paged, then recovered" are different facts about
 * the same nulls, and an operator triaging a live number needs to tell them
 * apart.
 */
export const MODERATION_ALERT_STATES = [
  "never_paged",
  "cleared",
  "paged",
  "unreadable",
] as const;

export const getModerationAlertStateOutputSchema = z
  .object({
    /** Which `PlatformSetting` row this came from. Echoed for traceability. */
    settingKey: z.string(),
    state: z.enum(MODERATION_ALERT_STATES),
    /**
     * The stored problem identity, verbatim — the pipe-joined set of firing
     * signal names. Null unless `state === "paged"`.
     */
    fingerprint: z.string().nullable(),
    /**
     * The same fingerprint split into signal names, for rendering.
     *
     * NOT validated against `MODERATION_QUEUE_HEALTH_SIGNALS`. A stored
     * fingerprint is a historical record written by an older deploy, and a
     * signal that has since been renamed or removed is exactly the thing an
     * operator needs to SEE rather than have silently dropped. Empty unless
     * `state === "paged"`.
     */
    firingSignals: z.array(z.string()),
    /** When Discord was last told about `fingerprint`. Null unless `paged`. */
    lastPagedAt: z.date().nullable(),
  })
  .strict();

export type GetModerationAlertStateOutput = z.infer<
  typeof getModerationAlertStateOutputSchema
>;

/**
 * The shape `health-alert-gate.ts` writes. Kept as a local schema rather than
 * imported: this is a PARSER for a foreign, historical value, and it should
 * tolerate exactly what it tolerates regardless of how the writer evolves.
 */
const storedAlertStateSchema = z
  .object({
    fingerprint: z.string().min(1),
    sentAt: z.string().min(1),
  })
  .strict();

/**
 * Read the moderation queue's edge-trigger alert state. NEVER WRITES.
 *
 * A store failure (`platformSettings.get` throwing) PROPAGATES. That is the
 * deliberate asymmetry in this file: an unparseable value is a bookkeeping
 * defect the page can render around, but a database that will not answer is
 * something the operator must see as an error rather than as "never paged" —
 * a fabricated all-clear on the one surface that exists to say what is wrong is
 * the failure mode every comment in this directory is about.
 */
export async function getModerationAlertState(
  deps: ModerationAlertStateDeps,
  rawInput: unknown = {},
): Promise<GetModerationAlertStateOutput> {
  parseInput(getModerationAlertStateInputSchema, rawInput);

  const settingKey = MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY;
  const record = await deps.repos.platformSettings.get(settingKey);

  const base = { settingKey, fingerprint: null, firingSignals: [], lastPagedAt: null };

  // No row at all: nothing has ever paged for this queue.
  if (!record) {
    return getModerationAlertStateOutputSchema.parse({
      ...base,
      state: "never_paged",
    });
  }

  // Empty value: a healthy run cleared it. `PlatformSettingsRepo` has no
  // delete, so "" is what recovery looks like.
  if (!record.value) {
    return getModerationAlertStateOutputSchema.parse({
      ...base,
      state: "cleared",
    });
  }

  const parsed = parseStoredState(record.value);
  if (!parsed) {
    // The one swallow here. `logger.error` is Sentry-captured via
    // pinoIntegration AND `reportError` is called explicitly, because this
    // branch is a catch-and-fallback and CLAUDE.md is unambiguous that a
    // `warn` would make it invisible. Self-healing (the next send overwrites
    // the row), so it is a defect signal, not an incident.
    deps.logger.error("moderation.alertState.unreadable", {
      settingKey,
      // The VALUE is not logged. It is bookkeeping, not content, but it is
      // also unbounded attacker-uncontrolled-but-unknown text and there is
      // nothing to learn from it that the shape does not already say.
      length: record.value.length,
    });
    try {
      deps.reportError?.(
        new Error("moderation queue health alert-state is unreadable"),
        {
          tags: { area: "image-moderation", reason: "alert-state-unreadable" },
          extra: { settingKey },
        },
      );
    } catch {
      // best-effort only — a throwing reporter must never change behaviour
    }
    return getModerationAlertStateOutputSchema.parse({
      ...base,
      state: "unreadable",
    });
  }

  return getModerationAlertStateOutputSchema.parse({
    settingKey,
    state: "paged",
    fingerprint: parsed.fingerprint,
    // The gate joins firing signal names with "|" (`fingerprintSignals`).
    // Splitting is presentation; `fingerprint` above stays the source of truth.
    firingSignals: parsed.fingerprint.split("|").filter((s) => s.length > 0),
    lastPagedAt: parsed.sentAt,
  });
}

/**
 * Parse a stored alert-state value, or null if it is unusable for any reason.
 *
 * Returns null rather than throwing across all three failure modes (bad JSON,
 * wrong shape, unparseable date) so the caller has ONE branch to report from
 * instead of three. Nothing here writes, logs, or reports — that is the
 * caller's job, and keeping it that way is what lets this be tested as a pure
 * function.
 */
function parseStoredState(
  raw: string,
): { fingerprint: string; sentAt: Date } | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = storedAlertStateSchema.safeParse(json);
  if (!parsed.success) return null;

  const sentAt = new Date(parsed.data.sentAt);
  if (Number.isNaN(sentAt.getTime())) return null;

  return { fingerprint: parsed.data.fingerprint, sentAt };
}
