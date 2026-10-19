import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { PlatformSettingKey } from "@th/ports/repos/platform-settings";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-TRIGGERED HEALTH ALERTING — the shared machinery.
//
// Extracted from `moderation/report-moderation-queue-health.ts`, which is
// still the file to read for WHY this shape exists. The short version: a
// health job that pages whenever a count is non-zero reads as "an alert always
// means something" and is true exactly once. Counts that never fall back to
// zero without a human — a review queue, a stuck subscription — then produce
// the identical message every run forever, and the channel stops being read.
// That is the same failure mode as the outage the health check was built to
// catch, wearing a different hat.
//
// So the READ stays on its schedule and only the SEND is gated, on:
//   * the SET of firing signals changing (`changed`), or
//   * an unchanged picture going `reAlertAfterMs` stale (`heartbeat`).
//
// WHAT LIVES HERE: fingerprinting a signal table, the send/suppress decision,
// and the `PlatformSetting` persist/clear around it.
//
// WHAT DOES NOT: the signal TABLE itself. Each caller keeps its own, because
// the describe strings are domain copy and belong beside the counts they
// describe. The table's TYPE is the contract (`HealthSignalTable`), and it is
// a TOTAL `Record` over the counts key set on purpose — adding a count to a
// port is a compile error until it is described, so a new signal cannot reach
// the alert copy without also reaching the fingerprint. That asymmetry is the
// silence bug this design exists to make impossible: a signal wired into the
// problem list but not into the fingerprint raises `unhealthy` without moving
// the string, so during any suppression window it says nothing at all.
//
// EVERY FAILURE HERE FALLS TOWARD SENDING — except the clear, which cannot,
// because "not clearing" IS the suppressing state. See `clearAlertState`.
// ─────────────────────────────────────────────────────────────────────────────

/** Why the caller was (or was not) told to send. */
export const healthAlertReasons = [
  /** Nothing is firing. Nothing to send, and any stored state is cleared. */
  "healthy",
  /** First problem, or a different set of signals firing. */
  "changed",
  /** Same picture, but the re-alert window has elapsed since the last send. */
  "heartbeat",
  /** Same picture, inside the window. The caller must stay quiet. */
  "suppressed",
] as const;

export type HealthAlertReason = (typeof healthAlertReasons)[number];

/**
 * Counts a health read produces: a fixed set of named non-negative integers.
 *
 * Written as a self-referential mapped type rather than `Record<string,
 * number>` on purpose. Port count types are `interface`s, and TypeScript does
 * not let an interface satisfy an index signature — `ModerationQueueHealth`
 * would fail a `Record<string, number>` constraint despite every field being a
 * number. `Record<keyof T, number>` constrains the declared keys instead,
 * which is exactly the intent and accepts interfaces.
 */
export type HealthCountsOf<TCounts> = Record<keyof TCounts, number>;

/** One row of a caller's signal table. */
export type HealthSignal<TInput> = {
  /** The operator-facing line, given the count and the thresholds behind it. */
  describe: (count: number, input: TInput) => string;
};

/**
 * THE table of things that can be wrong, per caller.
 *
 * TOTAL over `keyof TCounts` deliberately — see the file header. Callers
 * declare it as `HealthSignalTable<TheirCounts, TheirInput>` so a widened
 * counts type fails to compile until every new key has copy.
 *
 * Declaration order is the order an operator reads the problems in, and the
 * order the fingerprint concatenates. JS preserves insertion order for
 * non-numeric string keys, so the literal IS the ordering — the fingerprint
 * therefore never depends on how a `counts` object happened to be built.
 */
export type HealthSignalTable<TCounts, TInput> = Record<
  keyof TCounts,
  HealthSignal<TInput>
>;

/** The signals currently above zero, in table order. */
export function firingSignals<
  TCounts extends HealthCountsOf<TCounts>,
  TInput,
>(
  signals: HealthSignalTable<TCounts, TInput>,
  counts: TCounts,
): (keyof TCounts & string)[] {
  return (Object.keys(signals) as (keyof TCounts & string)[]).filter(
    (key) => (counts[key] ?? 0) > 0,
  );
}

/**
 * The stable identity of the current problem picture: the set of signals
 * firing, in table order, joined.
 *
 * Deliberately NOT the counts. A backlog ticks 3 → 4 → 5 on its own and none
 * of that is news; what an operator needs to hear is that a signal STARTED or
 * STOPPED firing. Magnitude was tried and removed upstream: bucketing counts
 * bought "three stuck rows became four hundred" at the cost of boundary
 * oscillation — a count wobbling across a band edge paged every run, which is
 * the exact bug this gate exists to remove — plus a version prefix to redefine
 * the bands later. If order-of-magnitude escalation is ever wanted, add it as
 * its OWN signal with its own threshold rather than as a second axis on all of
 * them.
 */
export function fingerprintSignals<
  TCounts extends HealthCountsOf<TCounts>,
  TInput,
>(
  signals: HealthSignalTable<TCounts, TInput>,
  counts: TCounts,
): string {
  return firingSignals(signals, counts).join("|");
}

/** The operator-facing problem lines, in table order. Empty when healthy. */
export function describeSignals<
  TCounts extends HealthCountsOf<TCounts>,
  TInput,
>(
  signals: HealthSignalTable<TCounts, TInput>,
  counts: TCounts,
  input: TInput,
): string[] {
  return firingSignals(signals, counts).map((key) =>
    signals[key].describe(counts[key] ?? 0, input),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stored state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the last-paged problem picture is remembered. `PlatformSetting` is a
 * plain key/value row — no migration, no new table for one string. An empty
 * value means "no outstanding problem", which is how a healthy run clears it
 * (the repo offers `get`/`upsert` and no delete).
 */
export type HealthAlertGateConfig = {
  /** The `PlatformSetting` row this gate owns. One key per caller. */
  settingKey: PlatformSettingKey;
  /**
   * Prefix for this gate's three log messages
   * (`<prefix>.alertState.corrupt` / `.failed` / `.clearRetrying`). These are
   * what an operator greps for, so each caller keeps its own.
   */
  logPrefix: string;
  /** `tags.area` on every `reportError` from this gate. */
  reporterArea: string;
  /** Human phrase for the synthesised Error when a non-Error is swallowed. */
  errorLabel: string;
};

export type HealthAlertGateDeps = {
  repos: Pick<Repos, "platformSettings">;
  reportError?: ReporterPort;
};

const alertStateSchema = z
  .object({
    fingerprint: z.string().min(1),
    sentAt: z.string().min(1),
  })
  .strict();

type StoredAlertState = { fingerprint: string; sentAt: Date };

export type HealthAlertDecision = {
  shouldAlert: boolean;
  alertReason: HealthAlertReason;
};

/**
 * Decide whether to page, and persist whatever the decision implies.
 *
 * `fingerprint === null` means HEALTHY: nothing is firing, so any stored state
 * is cleared and the answer is always "stay quiet".
 *
 * `logger` is the caller's own child logger (carrying its `useCase` binding),
 * not one built here — the three lines this gate writes must sit in the same
 * grep as everything else that run logged.
 */
export async function decideHealthAlert(
  deps: HealthAlertGateDeps,
  logger: LoggerPort,
  config: HealthAlertGateConfig,
  args: {
    /** The current problem picture, or null when healthy. */
    fingerprint: string | null;
    /** The clock instant this run was evaluated at. */
    now: Date;
    /**
     * How long an UNCHANGED problem picture may stay quiet before it is paged
     * once more. The anti-forgetting backstop, not a repeat alert.
     */
    reAlertAfterMs: number;
  },
): Promise<HealthAlertDecision> {
  const { fingerprint, now, reAlertAfterMs } = args;
  const stored = await readAlertState(deps, logger, config);

  if (fingerprint === null) {
    // Clear on recovery, and ONLY when there is something to clear — otherwise
    // a healthy platform rewrites this row on every run for nothing.
    //
    // This clear carries the design. Without it, a problem that resolves and
    // later recurs with an identical fingerprint is suppressed by state left
    // over from the previous episode, and the SECOND incident is silent. A
    // recurrence is news.
    //
    // READ THIS BEFORE TOUCHING clearAlertState. Every other failure in this
    // file falls toward sending. This one does not, and it is the only such
    // place: if the clear does not land, the row keeps the old fingerprint AND
    // the old `sentAt`, so an identical problem arriving later matches a
    // fingerprint that should no longer exist and is suppressed for the
    // remainder of the original window. Nothing links the resulting silence
    // back to the write failure that caused it — the Sentry report is about a
    // failed upsert, not about a missed incident. That is why the clear retries
    // rather than shrugging on the first error, and why any future change here
    // must keep asking "what goes quiet if this write is dropped?".
    if (stored) {
      await clearAlertState(deps, logger, config);
    }
    return { shouldAlert: false, alertReason: "healthy" };
  }

  const elapsedMs = stored ? now.getTime() - stored.sentAt.getTime() : null;

  let shouldAlert: boolean;
  let alertReason: HealthAlertReason;

  if (!stored || stored.fingerprint !== fingerprint) {
    shouldAlert = true;
    alertReason = "changed";
  } else if (
    // `elapsedMs === null` cannot happen in this branch (`stored` is set) and
    // is here so a future edit cannot turn a missing value into silence.
    elapsedMs === null ||
    // NEGATIVE means the stored `sentAt` is in the future: clock skew on the
    // run that wrote it, a clock stepped back afterwards, or a hand-edited
    // row. A bare `>=` treats that as "no time has passed" and stalls the
    // heartbeat for skew + the window, breaking this file's one promise — that
    // a standing problem is never forgotten entirely. Send instead.
    elapsedMs < 0 ||
    elapsedMs >= reAlertAfterMs
  ) {
    shouldAlert = true;
    alertReason = "heartbeat";
  } else {
    shouldAlert = false;
    alertReason = "suppressed";
  }

  if (shouldAlert) {
    // Recorded BEFORE the caller sends, because the sender is fire-and-forget
    // (env-gated, swallows its own failures) and can report nothing back. The
    // trade is deliberate: a dropped Discord post costs one quiet interval,
    // while recording only on confirmed delivery would re-page forever the
    // moment the webhook went away — the exact behaviour being removed here.
    await writeAlertState(deps, logger, config, { fingerprint, sentAt: now });
  }

  return { shouldAlert, alertReason };
}

// ─────────────────────────────────────────────────────────────────────────────
// State helpers
//
// Every failure here falls toward SENDING — except the clear, which cannot,
// because "not clearing" IS the suppressing state. That one retries instead.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the last-paged picture. A missing row, an empty value, malformed JSON,
 * an unparseable timestamp or an outright store failure all return null, which
 * the caller reads as "nothing suppressed" and therefore sends.
 *
 * Deliberate swallow (CLAUDE.md): a broken cooldown must never silence a real
 * incident, so this degrades to the old level-triggered behaviour rather than
 * throwing a health check that exists to notice things.
 */
async function readAlertState(
  deps: HealthAlertGateDeps,
  logger: LoggerPort,
  config: HealthAlertGateConfig,
): Promise<StoredAlertState | null> {
  let raw: string | null = null;
  try {
    const record = await deps.repos.platformSettings.get(config.settingKey);
    raw = record?.value ?? null;
  } catch (err) {
    reportSwallow(deps, logger, config, err, "read");
    return null;
  }

  if (!raw) return null;

  // Corruption is self-healing — the next send overwrites the row — so it gets
  // no `reportError`. It does NOT get silence: a row that keeps arriving
  // corrupt shows up to an operator as paging that mysteriously came back,
  // which is the noise this whole gate removes, wearing a disguise.
  // `logger.error` is Sentry-captured through pinoIntegration, so the symptom
  // is diagnosable without a second alerting path.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    logger.error(`${config.logPrefix}.alertState.corrupt`, {
      err,
      reason: "invalid_json",
      settingKey: config.settingKey,
    });
    return null;
  }

  const parsed = alertStateSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger.error(`${config.logPrefix}.alertState.corrupt`, {
      reason: "unexpected_shape",
      settingKey: config.settingKey,
    });
    return null;
  }

  const sentAt = new Date(parsed.data.sentAt);
  if (Number.isNaN(sentAt.getTime())) {
    logger.error(`${config.logPrefix}.alertState.corrupt`, {
      reason: "unparseable_sentAt",
      sentAt: parsed.data.sentAt,
      settingKey: config.settingKey,
    });
    return null;
  }

  return { fingerprint: parsed.data.fingerprint, sentAt };
}

async function writeAlertState(
  deps: HealthAlertGateDeps,
  logger: LoggerPort,
  config: HealthAlertGateConfig,
  state: StoredAlertState,
): Promise<void> {
  try {
    await deps.repos.platformSettings.upsert(
      config.settingKey,
      JSON.stringify({
        fingerprint: state.fingerprint,
        sentAt: state.sentAt.toISOString(),
      }),
    );
  } catch (err) {
    // Swallowed on purpose: the alert has already been decided, and refusing to
    // send it because bookkeeping failed would invert the whole point. The cost
    // of losing this write is one extra page next run.
    reportSwallow(deps, logger, config, err, "write");
  }
}

/**
 * Clears the row on recovery. THE dangerous write in this file.
 *
 * A dropped write here leaves both the old fingerprint and the old `sentAt` in
 * place, so a genuinely new incident with the same shape, arriving any time in
 * the remaining window, is suppressed — and nothing connects that silence back
 * to this failure, because the report describes a failed upsert rather than a
 * missed incident.
 *
 * So it retries once. A single immediate retry closes most of the window: the
 * realistic causes (a dropped pooled connection, a Neon compute waking, a
 * statement timeout on a busy tick) are transient and per-connection, and the
 * second attempt usually lands on a fresh one. It is not a full fix — two
 * failures in a row still leave the stale row — which is why the caller's
 * comment names this as the file's one path toward silence rather than
 * pretending the retry closes it.
 *
 * Not retried in a loop: these jobs run on a schedule, the next healthy run
 * clears it anyway, and a job that hammers a struggling database to tidy up its
 * own bookkeeping is a worse failure than the one it is avoiding.
 */
async function clearAlertState(
  deps: HealthAlertGateDeps,
  logger: LoggerPort,
  config: HealthAlertGateConfig,
): Promise<void> {
  // Empty string, not a delete: `PlatformSettingsRepo` has no delete, and an
  // empty value reads as "no outstanding problem" on the next run.
  const attempt = () =>
    deps.repos.platformSettings.upsert(config.settingKey, "");

  try {
    await attempt();
    return;
  } catch (firstErr) {
    logger.warn(`${config.logPrefix}.alertState.clearRetrying`, {
      err: firstErr,
      settingKey: config.settingKey,
    });
  }

  try {
    await attempt();
  } catch (err) {
    // Both attempts failed. The row now holds a fingerprint for a problem that
    // is over, and an identical recurrence will be suppressed until the window
    // expires or another healthy run clears it. This is the one report in the
    // file that means "something may go QUIET", not "something was noisy".
    reportSwallow(deps, logger, config, err, "clear");
  }
}

function reportSwallow(
  deps: HealthAlertGateDeps,
  logger: LoggerPort,
  config: HealthAlertGateConfig,
  err: unknown,
  operation: "read" | "write" | "clear",
): void {
  logger.error(`${config.logPrefix}.alertState.failed`, {
    err,
    operation,
    // Named here because the consequence differs per operation, and the reader
    // of this line is mid-incident.
    consequence:
      operation === "clear"
        ? "stale fingerprint may suppress an identical recurrence"
        : "alert sent regardless; cooldown may be lost",
  });
  // Guarded — a throwing reporter must never change behaviour, least of all in
  // the branch whose job is to keep the alert flowing.
  try {
    deps.reportError?.(
      err instanceof Error
        ? err
        : new Error(`${config.errorLabel} alert-state ${operation} failed`),
      {
        tags: { area: config.reporterArea, operation },
        extra: { settingKey: config.settingKey },
      },
    );
  } catch {
    // best-effort only
  }
}
