import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { formatErrorMessage } from "@/lib/format-error-message";

// ─────────────────────────────────────────────────────────────────────────────
// Pure view logic for a dead-letter-queue rerun on `/platform/jobs`. No React.
//
// A rerun deletes the entry only when the job really ran. Every other answer
// keeps the entry, so the console has to say which one happened: it must never
// read as if a run took place when it did not.
//
// `not_run` and `failed` RESOLVE (they arrive in the mutation's `onSuccess`);
// only a missing entry, an auth failure or an unreachable jobs service throws.
// ─────────────────────────────────────────────────────────────────────────────

export type DlqRerunResult =
  inferRouterOutputs<AppRouter>["platformJobs"]["rerunDlqItem"];

/** What the rerun mutation settled with: an answer, or a thrown error. */
export type DlqRerunSettled =
  | { kind: "result"; result: DlqRerunResult }
  | { kind: "error"; error: unknown };

/**
 * - `success`: the job ran and the entry is gone.
 * - `warning`: the operator has something to do and nothing failed: nothing
 *   ran (paused, taken in by a live run, unconfirmed, or the entry is already
 *   gone), or the job ran and its entry could not be removed.
 * - `danger`: the rerun ran and failed, or the request itself failed.
 */
export type DlqRerunTone = "success" | "warning" | "danger";

export interface DlqRerunNotice {
  tone: DlqRerunTone;
  message: string;
  /** The job's own error code, shown in mono beside the message. */
  code?: string;
}

export type DlqTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** Longest job error quoted inside the status line, in characters. */
export const RERUN_ERROR_MAX_LENGTH = 200;

const NOT_RUN_KEYS = {
  disabled: "admin.jobsDlqRerunPaused",
  coalesced: "admin.jobsDlqRerunInFlight",
  unconfirmed: "admin.jobsDlqRerunUnconfirmed",
  // Another rerun of this entry holds its claim (or one broke off in the last
  // few minutes, and its run may still be going).
  claimed: "admin.jobsDlqRerunClaimed",
} as const satisfies Record<
  Extract<DlqRerunResult, { outcome: "not_run" }>["reason"],
  string
>;

/**
 * Fit a raw error into one sentence of the status line: whitespace collapsed
 * to single spaces, cut to `max` characters with an ellipsis, and closed with
 * a full stop so the sentence after it does not run on. Empty in, empty out.
 */
export function toErrorSentence(
  raw: string,
  max: number = RERUN_ERROR_MAX_LENGTH,
): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  // Spread, not `slice`: a cut must never land inside a surrogate pair.
  const chars = [...collapsed];
  if (chars.length > max) {
    return `${chars.slice(0, max).join("").trimEnd()}…`;
  }
  return /[.!?…]$/.test(collapsed) ? collapsed : `${collapsed}.`;
}

/** The tRPC error code (`NOT_FOUND`, `FORBIDDEN`, …) of a thrown client error. */
function trpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const like = error as {
    data?: { code?: unknown } | null;
    shape?: { data?: { code?: unknown } | null } | null;
  };
  const code = like.data?.code ?? like.shape?.data?.code;
  return typeof code === "string" ? code : undefined;
}

/** tRPC codes that mean the request was turned away before any job ran. */
const REFUSED_BEFORE_RUNNING: ReadonlySet<string> = new Set([
  "FORBIDDEN",
  "UNAUTHORIZED",
]);

/**
 * True when the job ran and its entry could not be removed afterwards. That
 * entry is stale: rerunning it runs the job a second time, so the row stays
 * marked and its Rerun stays off after the status line has moved on.
 */
export function ranButEntryKept(settled: DlqRerunSettled): boolean {
  return (
    settled.kind === "result" &&
    settled.result.outcome === "ran" &&
    !settled.result.entryDeleted
  );
}

/** The one message the DLQ panel shows for a settled rerun. */
export function dlqRerunNotice(
  settled: DlqRerunSettled,
  t: DlqTranslate,
): DlqRerunNotice {
  if (settled.kind === "error") {
    const trpcCode = trpcErrorCode(settled.error);
    if (trpcCode === "NOT_FOUND") {
      return { tone: "warning", message: t("admin.jobsDlqRerunGone") };
    }
    // `formatErrorMessage` needs the translator: without it every coded error
    // prints "Something went wrong". Jobs-service errors come through as
    // `Jobs API <status>: <body>`, so they are cut to length like a job error.
    const sentence = toErrorSentence(formatErrorMessage(settled.error, t));
    // A thrown error is not proof that nothing ran. The request can time out
    // or drop on any hop while the job carries on, and Rerun is live again
    // the moment this settles: a second press would run the job twice. Only
    // a refusal made before the jobs service did anything is exempt.
    const message = REFUSED_BEFORE_RUNNING.has(trpcCode ?? "")
      ? sentence
      : `${sentence} ${t("admin.jobsDlqRerunMayStillRun")}`;
    return { tone: "danger", message };
  }

  const { result } = settled;
  switch (result.outcome) {
    case "ran":
      // The job ran either way. `entryDeleted: false` means the entry could
      // not be removed afterwards: it is stale, and a second rerun of it
      // would run the job twice. Saying "the entry was removed" there would
      // be false, and the entry is sitting in the table with a Rerun button.
      return result.entryDeleted
        ? { tone: "success", message: t("admin.jobsDlqRerunRan") }
        : { tone: "warning", message: t("admin.jobsDlqRerunRanEntryKept") };
    case "not_run":
      return { tone: "warning", message: t(NOT_RUN_KEYS[result.reason]) };
    case "failed": {
      const error =
        toErrorSentence(result.error.message) || `HTTP ${result.status}.`;
      // A schema rejection answers with its code AS its message
      // (`invalid_input` / `invalid_input`). The sentence already quotes it,
      // so a code line under it would say the same word twice.
      const code = result.error.code?.trim();
      const repeatsMessage =
        code?.toLowerCase() === result.error.message.trim().toLowerCase();
      return {
        tone: "danger",
        message: t("admin.jobsDlqRerunFailed", { error }),
        ...(code && !repeatsMessage ? { code } : {}),
      };
    }
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

/** Identity of one DLQ entry across queues, for the in-flight rerun set. */
export function dlqItemKey(queue: string, jobId: string): string {
  return JSON.stringify([queue, jobId]);
}
