/**
 * Pure helpers for `/platform/image-moderation`.
 *
 * Kept in a plain module (no React, no `@th/ui`) so the three things that are
 * genuinely easy to get wrong are unit-testable without rendering a Tamagui
 * tree:
 *
 *   1. TILE LABELS ARE DERIVED FROM `thresholds`, never hardcoded. A tile that
 *      says "last 2h" while the snapshot was taken with
 *      `degradedWindowMinutes: 30` is a lie nobody catches, because the number
 *      still looks plausible. `signalWindowLabel` is the only place a window
 *      becomes words.
 *   2. THE PROVIDER BAND NEVER GUESSES. `getModerationConfig` throws
 *      PRECONDITION_FAILED when the jobs-service URL is unset, and the one
 *      unacceptable outcome is rendering "stub" (or "azure") when we do not
 *      know. `resolveProviderStatus` collapses every not-a-real-answer case
 *      into `loading` / `unknown`.
 *   3. `storageKey` IS ABSENT FOR `awaitingReview` — by design (the backend
 *      withholds it; a key plus the non-secret public base URL reconstructs
 *      un-reviewed flagged content, and this page admits DEVELOPERs who are
 *      not moderators). `storageKeyCell` makes `String(undefined)` unreachable.
 *
 * Copy lives here as literals rather than i18n keys: `/platform/**` is a
 * staff-only English console and the en/es catalogs are deliberately untouched
 * by this change.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Signals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five queue-health signals, in the order they are rendered.
 *
 * Mirrors `MODERATION_QUEUE_HEALTH_SIGNALS` (ports/repos/image-moderation-
 * records) — the same enum `moderation.queueSignal` accepts. Declared locally
 * so this module stays dependency-free; `tsc` still binds it to the procedure's
 * input type at every call site, so a divergence fails the build.
 */
export const QUEUE_SIGNALS = [
  "pendingOverdue",
  "awaitingReview",
  "degradedRecent",
  "degradedExhausted",
  "orphanedRecent",
] as const;

export type QueueSignal = (typeof QUEUE_SIGNALS)[number];

/** Echo of `queueSnapshot.thresholds`. */
export type QueueThresholds = {
  pendingOverdueMinutes: number;
  awaitingReviewHours: number;
  degradedWindowMinutes: number;
  maxRequeues: number;
};

/** The em dash used wherever a value is legitimately absent. */
export const NO_VALUE = "—";

// ─────────────────────────────────────────────────────────────────────────────
// Durations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whole minutes → the shortest exact unit ("90m", "2h", "3d").
 *
 * Only collapses when the division is EXACT: 90 minutes stays "90m" rather
 * than rounding to "2h", because a threshold label that rounds is the same
 * class of quiet lie as a hardcoded one.
 */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return NO_VALUE;
  const whole = Math.trunc(minutes);
  if (whole >= 1440 && whole % 1440 === 0) return `${whole / 1440}d`;
  if (whole >= 60 && whole % 60 === 0) return `${whole / 60}h`;
  return `${whole}m`;
}

/**
 * Compact relative age ("just now", "5m ago", "3h ago", "12d ago").
 *
 * Bidirectional: `nextAttemptAt` on an `orphanedRecent`/`degradedRecent` row
 * can legitimately sit in the future, and "in 4m" is the honest rendering of
 * that. Floors rather than rounds, so a row is never reported as older than it
 * is.
 */
export function formatAgo(from: Date, now: Date): string {
  const deltaMs = now.getTime() - from.getTime();
  if (!Number.isFinite(deltaMs)) return NO_VALUE;
  const past = deltaMs >= 0;
  const abs = Math.abs(deltaMs);

  if (abs < 60_000) return past ? "just now" : "in <1m";

  const minutes = Math.floor(abs / 60_000);
  const value =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;

  return past ? `${value} ago` : `in ${value}`;
}

/**
 * A job run's wall time. Local to this page rather than imported from
 * `/platform/jobs/_components` — a route's `_components` folder is private to
 * that route, and four lines of arithmetic is a poor reason to couple two ops
 * pages together.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return NO_VALUE;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile copy
// ─────────────────────────────────────────────────────────────────────────────

/** Plain-English name of the failure mode a signal counts. */
export function signalTitle(signal: QueueSignal): string {
  switch (signal) {
    case "pendingOverdue":
      return "Overdue for scan";
    case "awaitingReview":
      return "Awaiting review";
    case "degradedRecent":
      return "Failed to scan";
    case "degradedExhausted":
      return "Unscannable";
    case "orphanedRecent":
      return "Objects missing";
  }
}

/**
 * The window a tile counted, IN WORDS, derived from the snapshot's own
 * thresholds. Never hardcode any of these numbers at a call site.
 */
export function signalWindowLabel(
  signal: QueueSignal,
  thresholds: QueueThresholds,
): string {
  switch (signal) {
    case "pendingOverdue":
      return `over ${formatMinutes(thresholds.pendingOverdueMinutes)} late`;
    case "awaitingReview":
      return `held over ${formatMinutes(thresholds.awaitingReviewHours * 60)}`;
    case "degradedRecent":
      return `last ${formatMinutes(thresholds.degradedWindowMinutes)}`;
    case "degradedExhausted":
      return `${thresholds.maxRequeues}+ requeues`;
    case "orphanedRecent":
      return `last ${formatMinutes(thresholds.degradedWindowMinutes)}`;
  }
}

/** What a NON-ZERO count means operationally. */
export function signalMeaning(signal: QueueSignal): string {
  switch (signal) {
    case "pendingOverdue":
      return "The drain job is not running.";
    case "awaitingReview":
      return "Content holds nobody has decided on.";
    case "degradedRecent":
      return "The scanner is failing right now.";
    case "degradedExhausted":
      return "Past the requeue cap — no automation will clear these.";
    case "orphanedRecent":
      return "The record outlived its object in storage.";
  }
}

/**
 * What a ZERO reads as. Zero is the healthy value for all five, so the empty
 * copy is calm and affirmative — never an error tone.
 */
export function signalEmptyLabel(signal: QueueSignal): string {
  switch (signal) {
    case "pendingOverdue":
      return "Nothing is overdue for a scan.";
    case "awaitingReview":
      return "No image is waiting on a human.";
    case "degradedRecent":
      return "No scan failures in this window.";
    case "degradedExhausted":
      return "Nothing has burned through its requeue budget.";
    case "orphanedRecent":
      return "Every record still has its object.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down columns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the drill-down for this signal renders a storage-key column at all.
 *
 * FALSE for `awaitingReview` ONLY, and that is a security control, not layout
 * preference: R2 public URLs are `${publicBaseUrl}/${storageKey}` by plain
 * string join and read-time gating is app-side, so a key IS the image — and
 * `awaitingReview` is the one bucket holding un-reviewed flagged content while
 * this page is visible to DEVELOPERs who are not moderators. The backend
 * already omits the field; this keeps the UI from rendering a column of
 * `undefined` where it used to be.
 */
export function signalShowsStorageKey(signal: QueueSignal): boolean {
  return signal !== "awaitingReview";
}

/**
 * The storage-key cell value, or `null` when there is nothing to show.
 *
 * Returns `null` — never the string `"undefined"` — for the `awaitingReview`
 * bucket and for any row that arrives without a key. Callers render
 * {@link NO_VALUE} for `null`.
 */
export function storageKeyCell(
  signal: QueueSignal,
  storageKey: string | undefined,
): string | null {
  if (!signalShowsStorageKey(signal)) return null;
  if (typeof storageKey !== "string") return null;
  const trimmed = storageKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether the drill-down for this signal renders the `lastError` column.
 *
 * FALSE for `awaitingReview`, for the same reason as
 * {@link signalShowsStorageKey} and deliberately as a sibling of it rather
 * than a special case buried in a cell renderer. `lastError` is UNFILTERED
 * third-party text — it comes back from the R2 / Azure path and is stored
 * verbatim — so it is the one remaining field on that bucket's rows that
 * could carry provider detail about un-reviewed flagged content to a
 * DEVELOPER who is not a moderator.
 *
 * Nothing leaks through it TODAY (`mapS3Error` rewrites the object-missing
 * case to a literal), but the withholding rule for this bucket is documented
 * as absolute, and "the current adapter happens to sanitise it" is not a
 * control — it is a coincidence that a future adapter change would silently
 * revoke. The other four buckets keep the column: they are scanner failures
 * and vanished objects, which is exactly the text an engineer is here to read.
 */
export function signalShowsLastError(signal: QueueSignal): boolean {
  return signal !== "awaitingReview";
}

/**
 * Which timestamp the "age" column reads, per signal.
 *
 * `pendingOverdue` rows have never been moderated — `moderatedAt` is null on
 * every one of them — so the only instant that says anything is
 * `nextAttemptAt`, the moment the drain was due to pick the row up. The other
 * four buckets are resolutions, so they read `moderatedAt`.
 */
export function ageBasis(signal: QueueSignal): {
  field: "nextAttemptAt" | "moderatedAt";
  header: string;
} {
  return signal === "pendingOverdue"
    ? { field: "nextAttemptAt", header: "Due" }
    : { field: "moderatedAt", header: "Moderated" };
}

/** The instant the age column should render for a row, or null. */
export function ageInstant(
  signal: QueueSignal,
  row: { nextAttemptAt: Date; moderatedAt: Date | null },
): Date | null {
  return ageBasis(signal).field === "nextAttemptAt"
    ? row.nextAttemptAt
    : row.moderatedAt;
}

export type ModerationRecordKind =
  | "EVENT_HERO"
  | "AVATAR"
  | "BANNER"
  | "PAGE_MEDIA";

export type ModerationRecordStatus =
  | "PENDING"
  | "APPROVED"
  | "FLAGGED"
  | "REJECTED"
  | "ORPHANED";

export type ModerationSubjectType =
  | "EVENT"
  | "HUMAN"
  | "ORGANIZATION"
  | "PLACE";

/** `EVENT_HERO` → `Event hero`. */
export function kindLabel(kind: ModerationRecordKind): string {
  switch (kind) {
    case "EVENT_HERO":
      return "Event hero";
    case "AVATAR":
      return "Avatar";
    case "BANNER":
      return "Banner";
    case "PAGE_MEDIA":
      return "Page media";
  }
}

/**
 * Badge tone for a record status.
 *
 * `FLAGGED` is `warning`, not `danger`: a flagged image is an image a human
 * still has to look at, not a failure. `ORPHANED` is `danger` because the
 * bytes are gone and no automation recovers from it.
 */
export function statusTone(
  status: ModerationRecordStatus,
): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "PENDING":
      return "neutral";
    case "APPROVED":
      return "success";
    case "FLAGGED":
      return "warning";
    case "REJECTED":
    case "ORPHANED":
      return "danger";
  }
}

/**
 * `EVENT · a1b2c3d4…`, or `null` when the record has no subject.
 *
 * A record with a `subjectType` but no `subjectId` (or the reverse) is
 * degraded data rather than an impossible state, so each half renders
 * independently instead of collapsing the row to nothing.
 */
export function subjectCell(row: {
  subjectType: ModerationSubjectType | null;
  subjectId: string | null;
}): { type: string | null; id: string | null } {
  return {
    type: row.subjectType ?? null,
    id:
      typeof row.subjectId === "string" && row.subjectId.length > 0
        ? row.subjectId
        : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider band
// ─────────────────────────────────────────────────────────────────────────────

export type ModerationProvider = "azure" | "stub" | "fail-closed";

/** Every state the provider band can be in, including the two non-answers. */
export type ProviderBandStatus = ModerationProvider | "loading" | "unknown";

const REAL_PROVIDERS: readonly string[] = ["azure", "stub", "fail-closed"];

/**
 * Collapse the config query into a band state.
 *
 * THE ORDER MATTERS. A real provider wins over `isLoading`, so a background
 * refetch never flips a known-good band back to "checking"; and anything that
 * is not one of the three literal values becomes `unknown`, never a default.
 * `getModerationConfig` throws PRECONDITION_FAILED when the jobs-service URL
 * is unset, which lands here as `provider: undefined` → `unknown`.
 */
export function resolveProviderStatus(input: {
  provider?: string | null;
  isLoading: boolean;
}): ProviderBandStatus {
  if (
    typeof input.provider === "string" &&
    REAL_PROVIDERS.includes(input.provider)
  ) {
    return input.provider as ModerationProvider;
  }
  return input.isLoading ? "loading" : "unknown";
}

/**
 * `neutral` = configured and scanning. `warning` = configured, but in a mode
 * an operator must see. `unknown` = we do not know, and say so.
 */
export type ProviderBandTone = "neutral" | "warning" | "unknown";

export type ProviderBandCopy = {
  status: ProviderBandStatus;
  tone: ProviderBandTone;
  /** The badge value. Only ever a provider we actually received. */
  value: string;
  headline: string;
  detail: string;
};

export function describeProviderBand(
  status: ProviderBandStatus,
): ProviderBandCopy {
  switch (status) {
    case "azure":
      return {
        status,
        tone: "neutral",
        value: "AZURE",
        headline: "Azure AI Content Safety is scanning uploads",
        detail:
          "Every uploaded public image is scored before it can be shown. Anything at or above a threshold below is held for a human.",
      };
    case "stub":
      return {
        status,
        tone: "warning",
        value: "STUB",
        headline: "Auto-approving every image without scanning",
        detail:
          "Nothing is being scored. This is the correct local and dev state; in production it means uploads are going public unchecked.",
      };
    case "fail-closed":
      return {
        status,
        tone: "warning",
        value: "FAIL-CLOSED",
        headline: "Every uploaded image is held for human review",
        detail:
          "No scanner is reachable, so nothing auto-approves. In production this means the Azure credentials are missing and the review queue is filling with images nobody needed to look at.",
      };
    case "loading":
      return {
        status,
        tone: "unknown",
        value: "CHECKING…",
        headline: "Reading the scanner configuration",
        detail: "Asking the jobs service which provider is wired up.",
      };
    case "unknown":
      return {
        status,
        tone: "unknown",
        value: "UNKNOWN",
        headline: "Scanner configuration could not be read",
        detail:
          "The jobs service did not answer — usually its URL is unset for this environment. Read nothing into this: the page will not guess a provider it did not receive.",
      };
  }
}

/**
 * Azure severity thresholds are integers (0/2/4/6). Rendered verbatim when
 * they are; a non-integer is shown to two places rather than silently floored,
 * because a threshold the operator cannot read exactly is worse than an ugly
 * one.
 */
export function formatThreshold(value: number): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Category keys in the order they are rendered. */
export const MODERATION_CATEGORIES = [
  "SEXUAL",
  "VIOLENCE",
  "HATE",
  "SELF_HARM",
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/**
 * Display name for a scanned category.
 *
 * An explicit map, not a `_`→space transform: that produced "Self harm", and
 * the term is hyphenated. Four fixed keys do not need an algorithm.
 */
const CATEGORY_LABELS: Record<ModerationCategory, string> = {
  SEXUAL: "Sexual",
  VIOLENCE: "Violence",
  HATE: "Hate",
  SELF_HARM: "Self-harm",
};

export function categoryLabel(category: ModerationCategory): string {
  return CATEGORY_LABELS[category];
}

/**
 * Split the four category thresholds into "same as the review threshold" and
 * genuine per-category overrides.
 *
 * The common case is all four equal to `reviewThreshold` — the jobs service
 * resolves absent overrides to it — and four large cards repeating one number
 * is noise that buries the thing the band exists to say (which provider is
 * running). So the uniform case collapses to one line and only real
 * exceptions get a card.
 *
 * A category missing from the payload is treated as an override of `null`
 * rather than as "equal", because an unknown threshold is exactly the thing
 * that must not be rendered as a confident number.
 */
export function splitCategoryThresholds(
  reviewThreshold: number,
  categoryThresholds: Partial<Record<string, number>>,
): {
  /** True when all four categories are known and equal the review threshold. */
  uniform: boolean;
  /** Categories that differ (or are missing). Empty when `uniform`. */
  overrides: Array<{ category: ModerationCategory; value: number | null }>;
} {
  const entries = MODERATION_CATEGORIES.map((category) => {
    const raw = categoryThresholds[category];
    return {
      category,
      value: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
    };
  });

  const uniform = entries.every((entry) => entry.value === reviewThreshold);
  return {
    uniform,
    overrides: uniform
      ? []
      : entries.filter((entry) => entry.value !== reviewThreshold),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job result summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The counters the two moderation jobs return, in reading order, with the
 * words a human would use. Unknown keys are not dropped — they are spaced out
 * of camelCase — so a job that grows a counter still reports it.
 */
const JOB_COUNTER_LABELS: Record<string, string> = {
  processed: "processed",
  moderated: "moderated",
  orphaned: "orphaned",
  retried: "retried",
  deadLettered: "dead-lettered",
  unprocessed: "unprocessed",
  requeued: "requeued",
  skipped: "skipped",
  examined: "examined",
};

const JOB_COUNTER_ORDER = Object.keys(JOB_COUNTER_LABELS);

const humanizeKey = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

const sentenceCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Turn a job's stored `resultSummary` into one line of prose.
 *
 * WHY THIS EXISTS. The jobs service stores `JSON.stringify(result).slice(0,
 * 500)`, and rendering that verbatim put a 520px unbreakable string in a
 * 320px viewport — it dragged the whole document to `scrollWidth 604`. It was
 * also just bad: this line is the one thing a human reads after pressing a
 * button, and `{"processed":0,"moderated":0,…}` makes them decode six zeros to
 * learn that nothing happened.
 *
 * The contract is deliberately defensive, because the input is neither typed
 * nor guaranteed well-formed:
 *
 *   - `.slice(0, 500)` TRUNCATES, so a large result is invalid JSON. That
 *     parses as a failure and returns `null`.
 *   - A payload with no numeric counters at all returns `null`.
 *   - `null` means RENDER NOTHING. It never falls back to printing the blob —
 *     the raw JSON must not reach the screen under any input.
 *   - Non-JSON text (a job that summarised itself in words) passes through as
 *     prose, since that is already the thing we want.
 *
 * All-zero is the common case and gets words, not zeros.
 */
export function describeJobResult(
  resultSummary: string | undefined | null,
): string | null {
  if (typeof resultSummary !== "string") return null;
  const trimmed = resultSummary.trim();
  if (trimmed.length === 0) return null;

  // Not JSON-shaped at all — already prose, pass it through.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Truncated or malformed. Say nothing rather than show the fragment.
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const counters = Object.entries(record).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  if (counters.length === 0) return null;

  counters.sort(([a], [b]) => {
    const ai = JOB_COUNTER_ORDER.indexOf(a);
    const bi = JOB_COUNTER_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  const nonZero = counters.filter(([, value]) => value !== 0);
  if (nonZero.length === 0) return "Nothing was due";

  const parts = nonZero.map(
    ([key, value]) => `${JOB_COUNTER_LABELS[key] ?? humanizeKey(key)} ${value}`,
  );
  const [first, ...rest] = parts;
  return [sentenceCase(first ?? ""), ...rest].join(" · ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs strip
// ─────────────────────────────────────────────────────────────────────────────

/** The drain job — turns PENDING rows into scan results. */
export const DRAIN_JOB = "moderation.drain-image-moderations";
/** The requeue job — revives rows the SCANNER failed on. */
export const REQUEUE_JOB = "moderation.requeue-degraded";

export type ModerationJobName = typeof DRAIN_JOB | typeof REQUEUE_JOB;

export type ModerationJobSpec = {
  name: ModerationJobName;
  label: string;
  description: string;
  runLabel: string;
  /**
   * Running this moves rows back into the scan queue, so it asks first.
   * The drain is idempotent catch-up work and does not.
   */
  confirm: {
    title: string;
    description: string;
    confirmLabel: string;
  } | null;
};

export const MODERATION_JOBS: readonly ModerationJobSpec[] = [
  {
    name: DRAIN_JOB,
    label: "Drain image moderations",
    description:
      "Scans the PENDING backlog. Safe to run at any time — it only picks up rows that are already due.",
    runLabel: "Run drain",
    confirm: null,
  },
  {
    name: REQUEUE_JOB,
    label: "Requeue degraded",
    description:
      "Revives rows the scanner failed on, up to the requeue cap. Does not touch content holds.",
    runLabel: "Requeue",
    confirm: {
      title: "Requeue degraded rows?",
      description:
        "This moves every degraded row that is still under the requeue cap back into the scan queue, and the drain job will re-scan them on its next pass. It does not touch rows awaiting human review.",
      confirmLabel: "Requeue",
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Counts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thousands-grouped integer, with an EXPLICIT locale.
 *
 * `Number.prototype.toLocaleString()` reads the ambient locale, which on the
 * server is Node's and in the browser is the reader's — so a four-digit total
 * can serialize as `1,204` in the SSR payload and `1.204` after hydration.
 * `/platform/**` is an English staff console; pinning `en-US` makes the two
 * halves agree by construction rather than by luck.
 */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  return COUNT_FORMAT.format(value);
}

/**
 * ALL-TIME counterparts to the two WINDOWED tiles (`snapshot.totals`).
 *
 * Deliberately a separate object from `counts`, mirroring the backend: the five
 * in `counts` are what the hourly Discord alert pages on, predicate for
 * predicate, and merging a total into that set is how a dashboard number turns
 * into a new thing that wakes someone up at 3am.
 */
export type QueueTotals = {
  awaitingReviewAll: number;
  orphanedAll: number;
};

/** The all-time total that belongs beside a tile, or null when it has none. */
export function signalTotal(
  signal: QueueSignal,
  totals: QueueTotals | undefined,
): number | null {
  if (!totals) return null;
  switch (signal) {
    case "awaitingReview":
      return totals.awaitingReviewAll;
    case "orphanedRecent":
      return totals.orphanedAll;
    case "pendingOverdue":
    case "degradedRecent":
    case "degradedExhausted":
      return null;
  }
}

/**
 * The SECONDARY line under a tile's windowed count — "6 waiting in total",
 * "1,204 all time" — or null when there is nothing worth saying.
 *
 * THE TILE'S PRIMARY NUMBER NEVER CHANGES. `awaitingReview` counts only holds
 * older than 24h and `orphanedRecent` only the last 2h, and those two counts
 * are exactly what the hourly Discord alert pages on; decoupling the page from
 * the alert would be a worse bug than the one this fixes. So the total arrives
 * as a second line and the tile keeps counting what the alert counts.
 *
 * Returns null when the total EQUALS the windowed count, because "0 / 0 waiting
 * in total" is a line that costs a reader attention and tells them nothing. It
 * also returns null when the total is somehow SMALLER than the window (the
 * backend guarantees `>=`, so this can only be a skew between two reads) —
 * printing "3 in total" under a tile reading 5 would look like a counting bug
 * in the dashboard rather than the transient it is.
 */
export function signalTotalLabel(
  signal: QueueSignal,
  count: number | undefined,
  totals: QueueTotals | undefined,
): string | null {
  const total = signalTotal(signal, totals);
  if (total === null || count === undefined) return null;
  if (total <= count) return null;
  return signal === "awaitingReview"
    ? `${formatCount(total)} waiting in total`
    : `${formatCount(total)} all time`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deletion outbox
// ─────────────────────────────────────────────────────────────────────────────

/** Echo of `snapshot.deletionOutbox`, minus the fields the UI does not read. */
export type DeletionOutboxCounts = {
  dead: number;
  overdue: number;
  overdueMinutes: number;
};

export type DeletionOutboxTone = "calm" | "warning" | "danger";

export type DeletionOutboxCopy = {
  tone: DeletionOutboxTone;
  headline: string;
  detail: string;
};

/**
 * "Rejected" does not mean the bytes are gone.
 *
 * A moderator REJECT writes the decision and enqueues the R2 object for
 * deletion in ONE transaction — which makes the ENQUEUE reliable and says
 * nothing about the DRAIN. If the drain stalls or dead-letters, we have told an
 * uploader their image was removed while the file is still being served from a
 * public CDN, and the moderation record reads REJECTED, which is true and
 * beside the point.
 *
 * NOT a sixth tile: the five are the alert's signal set and this is not one of
 * them. The copy leads with the CONSEQUENCE ("still on the public CDN") rather
 * than the mechanism ("rows in an outbox"), because the mechanism is the part
 * an operator can already see in the number.
 *
 * `dead` outranks `overdue` when both are non-zero: an exhausted row is never
 * retried by anything, so it is the one that needs a human today.
 */
export function describeDeletionOutbox(
  outbox: DeletionOutboxCounts,
): DeletionOutboxCopy {
  const { dead, overdue, overdueMinutes } = outbox;

  if (dead > 0) {
    const noun = dead === 1 ? "image" : "images";
    return {
      tone: "danger",
      headline: `${formatCount(dead)} rejected ${noun} will not be deleted without a human`,
      detail:
        overdue > 0
          ? `Deletion gave up on ${formatCount(dead)} and ${formatCount(overdue)} more ${overdue === 1 ? "is" : "are"} overdue. The uploader was told these were removed; the files are still served publicly.`
          : "Deletion gave up on these. The uploader was told they were removed; the files are still served publicly.",
    };
  }

  if (overdue > 0) {
    const noun = overdue === 1 ? "image" : "images";
    const verb = overdue === 1 ? "is" : "are";
    return {
      tone: "warning",
      headline: `${formatCount(overdue)} rejected ${noun} ${verb} still on the public CDN`,
      detail: `Queued for deletion over ${formatMinutes(overdueMinutes)} ago and not yet drained — usually the object-deletion job has stopped, which affects every producer, not just moderation.`,
    };
  }

  return {
    tone: "calm",
    headline: "Rejected images are being deleted from storage",
    detail: `Nothing in the moderation slice of the deletion outbox is dead or more than ${formatMinutes(overdueMinutes)} overdue.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discord alert state
// ─────────────────────────────────────────────────────────────────────────────

export const MODERATION_ALERT_STATES = [
  "never_paged",
  "cleared",
  "paged",
  "unreadable",
] as const;

export type ModerationAlertState = (typeof MODERATION_ALERT_STATES)[number];

/** `calm` = nothing is paging · `warning` = a page is outstanding · `unknown` = we cannot say. */
export type AlertStateTone = "calm" | "warning" | "unknown";

export type AlertStateCopy = {
  tone: AlertStateTone;
  headline: string;
  detail: string;
  /** Human-readable firing signal names. Empty unless `state === "paged"`. */
  signals: string[];
};

/**
 * A stored fingerprint segment → the tile title an operator recognises.
 *
 * `firingSignals` is deliberately NOT enum-validated by the backend: a stored
 * fingerprint is a historical record written by an older deploy, and a signal
 * that has since been renamed or removed is exactly the thing an operator needs
 * to SEE rather than have silently dropped. So an unrecognised name passes
 * through verbatim instead of being filtered out or rendered as "unknown".
 */
export function firingSignalLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return NO_VALUE;
  return (QUEUE_SIGNALS as readonly string[]).includes(trimmed)
    ? signalTitle(trimmed as QueueSignal)
    : trimmed;
}

/**
 * What the hourly Discord alert has, and has not, said.
 *
 * "7 awaiting review" is ambiguous on its own — a known backlog somebody is
 * already sitting on, or something nobody has been told about. The alert is
 * edge-triggered, so the tile looks identical either way.
 *
 * FOUR STATES, RENDERED DISTINCTLY, and `unreadable` must never read like
 * `cleared`. Both have a null fingerprint; only one of them means "nothing is
 * wrong". A corrupt row reads as "nothing suppressed" to the alert gate, so
 * alerting still works — but nothing on this page can be trusted to say whether
 * anyone was told, and that is a different sentence.
 */
export function describeAlertState(input: {
  state: ModerationAlertState;
  firingSignals: readonly string[];
  lastPagedAt: Date | null;
  now: Date;
}): AlertStateCopy {
  switch (input.state) {
    case "never_paged":
      return {
        tone: "calm",
        headline: "Nothing is paging",
        detail: "This queue has never alerted Discord.",
        signals: [],
      };
    case "cleared":
      return {
        tone: "calm",
        headline: "Nothing is paging",
        detail:
          "The last alert cleared, so the gate is re-armed — an identical problem arriving now would page immediately.",
        signals: [],
      };
    case "paged": {
      const signals = input.firingSignals.map(firingSignalLabel);
      const when = input.lastPagedAt
        ? formatAgo(input.lastPagedAt, input.now)
        : null;
      return {
        tone: "warning",
        headline: when ? `Discord was paged ${when}` : "Discord has been paged",
        detail:
          signals.length > 0
            ? "Someone has already been told about these signals; they will not page again until this picture changes."
            : "A page is outstanding, but the stored fingerprint named no signals.",
        signals,
      };
    }
    case "unreadable":
      return {
        tone: "unknown",
        headline: "Alert state could not be read",
        detail:
          "The stored fingerprint is not parseable, so this page cannot say whether anyone was told. Alerting itself still works — a corrupt row reads as nothing-suppressed to the gate.",
        signals: [],
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity histogram
// ─────────────────────────────────────────────────────────────────────────────

/** Provider severities are 0–6. The chart draws exactly these seven columns. */
export const SEVERITY_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;

/** The window the histogram asks for, in days. Well inside the 90-day cap. */
export const SEVERITY_WINDOW_DAYS = 7;

export type SeverityBucket = { severity: number; count: number };

/**
 * The histogram window, derived from ONE instant.
 *
 * Anchored to `snapshot.observedAt` rather than a fresh `new Date()` so the
 * query key is stable across renders — a window that moved every render would
 * refetch on every render.
 */
export function severityWindow(until: Date): { since: Date; until: Date } {
  return {
    since: new Date(until.getTime() - SEVERITY_WINDOW_DAYS * 86_400_000),
    until,
  };
}

/**
 * The index of the first HELD column, i.e. where the threshold rule is drawn.
 *
 * `Math.ceil`, not round or floor: the rule marks "at or above", so a
 * threshold of 3.5 holds severity 4 and up. Clamped to `[0, 7]` so a threshold
 * outside the scale draws the rule at one end instead of dropping it.
 * Returns null when the threshold is unknown — the chart then draws no rule at
 * all rather than guessing a line the operator would read as fact.
 */
export function severityThresholdIndex(
  threshold: number | null | undefined,
): number | null {
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return null;
  return Math.max(0, Math.min(SEVERITY_LEVELS.length, Math.ceil(threshold)));
}

export type SeverityBar = {
  severity: number;
  count: number;
  /** 0–100. A non-zero count never rounds to an invisible bar. */
  heightPct: number;
  /** At or above the review threshold — this scan was held for a human. */
  held: boolean;
};

/**
 * The seven bars, dense, with heights relative to the tallest bucket.
 *
 * The backend already returns a DENSE 0–6 array; this re-densifies anyway so a
 * short or scrambled payload cannot silently draw a four-column chart that
 * still looks like a distribution.
 *
 * A count of 1 beside a count of 1,200 is 0.08% of the height, which paints
 * nothing. It floors at 2% instead — the chart's job is "is there anything
 * sitting just under the line", and rounding a real row to invisible answers it
 * wrongly.
 */
export function severityBars(
  buckets: readonly SeverityBucket[],
  thresholdIndex: number | null,
): SeverityBar[] {
  const byLevel = new Map<number, number>();
  for (const bucket of buckets) {
    byLevel.set(bucket.severity, (byLevel.get(bucket.severity) ?? 0) + bucket.count);
  }
  const max = SEVERITY_LEVELS.reduce<number>(
    (acc, level) => Math.max(acc, byLevel.get(level) ?? 0),
    0,
  );
  return SEVERITY_LEVELS.map((severity) => {
    const count = byLevel.get(severity) ?? 0;
    const raw = max > 0 ? (count / max) * 100 : 0;
    return {
      severity,
      count,
      heightPct: count > 0 ? Math.max(raw, 2) : 0,
      held: thresholdIndex !== null && severity >= thresholdIndex,
    };
  });
}

/** How many of the seven in-range scans sit at or above the threshold. */
export function severityHeldCount(bars: readonly SeverityBar[]): number {
  return bars.reduce((sum, bar) => (bar.held ? sum + bar.count : sum), 0);
}

/**
 * The one-line summary under the chart. Exact numbers live HERE rather than on
 * the bars, because a five-digit label under a 28px column is the overflow that
 * drags a 320px document sideways.
 */
export function describeSeveritySummary(input: {
  scanned: number;
  bars: readonly SeverityBar[];
  threshold: number | null | undefined;
}): string {
  const scanned = `${formatCount(input.scanned)} scanned in the last ${SEVERITY_WINDOW_DAYS} days`;
  const threshold = input.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return scanned;
  }
  if (severityThresholdIndex(threshold) === null || input.scanned === 0) {
    return scanned;
  }
  const held = severityHeldCount(input.bars);
  /**
   * THE DENOMINATOR IS THE IN-RANGE TOTAL, NOT `scanned`.
   *
   * `scanned` includes `outOfRange` rows, which the numerator cannot count —
   * they are not in any of the seven buckets by construction. Dividing by it
   * understated the held share whenever a provider had written a severity
   * outside 0–6. The two are identical in the expected state (an empty
   * `outOfRange`), so this only ever moves when it should.
   */
  const inRange = input.bars.reduce((sum, bar) => sum + bar.count, 0);
  if (inRange === 0) return scanned;
  const share = held / inRange;
  const pct = (share * 100).toFixed(held > 0 && share < 0.001 ? 2 : 1);
  return `${scanned} · ${formatCount(held)} at or above ${formatThreshold(threshold)} (${pct}%)`;
}

/**
 * Severities outside 0–6, spelled out — or null when there are none (the
 * expected state).
 *
 * `max_severity` is a plain integer column with no check constraint, so a
 * provider change or a bad mapper can write anything. The backend refuses to
 * fold those into the nearest bucket, which means the chart's seven columns do
 * NOT sum to `scanned` when this is non-empty. Saying so is what keeps the
 * chart honest; hiding it would read as a counting bug in the dashboard while
 * the real defect (bad data) never gets looked at.
 */
export function describeOutOfRange(
  outOfRange: readonly SeverityBucket[],
): string | null {
  const real = outOfRange.filter((bucket) => bucket.count > 0);
  if (real.length === 0) return null;
  const total = real.reduce((sum, bucket) => sum + bucket.count, 0);
  const levels = real.map((bucket) => bucket.severity).join(", ");
  return `${formatCount(total)} ${total === 1 ? "scan" : "scans"} scored outside 0–6 (severity ${levels}) and ${total === 1 ? "is" : "are"} not in the chart.`;
}

/** The whole chart, said in one sentence, for `role="img"`. */
export function severityAriaLabel(input: {
  scanned: number;
  bars: readonly SeverityBar[];
  threshold: number | null | undefined;
}): string {
  if (input.scanned === 0) {
    return `Severity distribution over the last ${SEVERITY_WINDOW_DAYS} days: nothing was scored.`;
  }
  const parts = input.bars.map(
    (bar) => `severity ${bar.severity}, ${formatCount(bar.count)}`,
  );
  const threshold = input.threshold;
  const tail =
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    severityThresholdIndex(threshold) === null
      ? ""
      : ` Review threshold ${formatThreshold(threshold)}; ${formatCount(severityHeldCount(input.bars))} at or above it.`;
  return `Severity distribution over the last ${SEVERITY_WINDOW_DAYS} days, ${formatCount(input.scanned)} scanned: ${parts.join("; ")}.${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind breakdown
// ─────────────────────────────────────────────────────────────────────────────

export const MODERATION_KINDS = [
  "EVENT_HERO",
  "AVATAR",
  "BANNER",
  "PAGE_MEDIA",
] as const;

export type QueueCounts = Record<QueueSignal, number>;

export type BreakdownRow = {
  /** Stable row key. `UNRECOGNIZED` for the catch-all row. */
  id: string;
  label: string;
  counts: QueueCounts;
  /** True for the catch-all row, which is styled as a data-quality finding. */
  unrecognized: boolean;
};

/**
 * The breakdown table's rows.
 *
 * All four kinds ALWAYS render, including a kind with five zeros — the payload
 * is dense on purpose, and a UI that drops empty rows invents a third state
 * ("absent") nobody designed.
 *
 * `unrecognizedKinds` renders ONLY when non-zero, and then it is not optional:
 * `kind` is an app-validated string rather than a Prisma enum, so a typo'd or
 * retired value is representable, and without this row the columns visibly fail
 * to sum to the tiles above them.
 */
export function breakdownRows(input: {
  byKind: Record<(typeof MODERATION_KINDS)[number], QueueCounts>;
  unrecognizedKinds: QueueCounts;
}): BreakdownRow[] {
  const rows: BreakdownRow[] = MODERATION_KINDS.map((kind) => ({
    id: kind,
    label: kindLabel(kind),
    counts: input.byKind[kind],
    unrecognized: false,
  }));

  const unrecognizedTotal = QUEUE_SIGNALS.reduce(
    (sum, signal) => sum + (input.unrecognizedKinds[signal] ?? 0),
    0,
  );
  if (unrecognizedTotal > 0) {
    rows.push({
      id: "UNRECOGNIZED",
      label: "Unrecognized kind",
      counts: input.unrecognizedKinds,
      unrecognized: true,
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `moderation.lookupByKey`'s item, with every withholdable field OPTIONAL.
 *
 * Withheld fields are ABSENT, never null — by design, so "we are not telling
 * you" and "there is nothing here" do not serialize the same. Every consumer
 * here therefore normalises with `?? null` and NEVER `String(...)`s an optional.
 */
export type LookupItem = {
  recordId: string;
  kind: ModerationRecordKind;
  requeues: number;
  attempts: number;
  storageKey?: string;
  lastError?: string | null;
  status?: ModerationRecordStatus;
  subjectType?: ModerationSubjectType | null;
  subjectId?: string | null;
  degraded?: boolean;
  moderatedAt?: Date | null;
  nextAttemptAt?: Date;
};

export type LookupWithheld = {
  storageKey: boolean;
  lastError: boolean;
  status: boolean;
  subjectType: boolean;
  subjectId: boolean;
  degraded: boolean;
  moderatedAt: boolean;
  nextAttemptAt: boolean;
};

export type LookupResult = {
  storageKey: string;
  found: boolean;
  item: LookupItem | null;
  withheld: LookupWithheld;
};

export type LookupView =
  | { kind: "miss"; storageKey: string }
  | {
      kind: "withheld";
      storageKey: string;
      recordId: string;
      imageKind: string;
      requeues: number;
      attempts: number;
    }
  | {
      kind: "detail";
      storageKey: string;
      recordId: string;
      imageKind: string;
      requeues: number;
      attempts: number;
      status: ModerationRecordStatus | null;
      degraded: boolean | null;
      subjectType: ModerationSubjectType | null;
      subjectId: string | null;
      recordStorageKey: string | null;
      lastError: string | null;
      moderatedAt: Date | null;
      nextAttemptAt: Date | null;
    };

/**
 * Collapse a lookup response into the three things the page can render.
 *
 * `miss` IS NOT AN ERROR. `found: false` means the object has no moderation
 * record, and since read-time gating treats "no record" as APPROVED, that is a
 * finding — the object is unmoderated and publicly visible — not a fault.
 *
 * `withheld` is triggered by `withheld.status`, the flag that marks an
 * un-reviewed content hold. All eight booleans move together server-side; this
 * reads the one that means "the thing we are hiding is the CONTENT", so the UI
 * says "held for review — details withheld" instead of rendering a row of blank
 * cells that reads like missing data, or worse, like a record with no subject.
 */
export function describeLookup(result: LookupResult): LookupView {
  if (!result.found || result.item === null) {
    return { kind: "miss", storageKey: result.storageKey };
  }

  const item = result.item;
  const common = {
    storageKey: result.storageKey,
    recordId: item.recordId,
    imageKind: kindLabel(item.kind),
    requeues: item.requeues,
    attempts: item.attempts,
  };

  if (result.withheld.status) {
    return { kind: "withheld", ...common };
  }

  return {
    kind: "detail",
    ...common,
    status: item.status ?? null,
    degraded: item.degraded ?? null,
    subjectType: item.subjectType ?? null,
    subjectId: item.subjectId ?? null,
    recordStorageKey: item.storageKey ?? null,
    lastError: item.lastError ?? null,
    moderatedAt: item.moderatedAt ?? null,
    nextAttemptAt: item.nextAttemptAt ?? null,
  };
}

/** Trim a pasted key; empty (or whitespace-only) input is not a query. */
export function normalizeStorageKeyInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // The backend bounds this at R2's own 1024-byte key limit; anything longer
  // cannot name a real object and is a paste accident. Refused here so the
  // operator gets a sentence instead of a BAD_REQUEST.
  if (trimmed.length > 1024) return null;
  return trimmed;
}

/** Why the Look up button is inert, or null when it is not. */
export function storageKeyInputProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 1024) {
    return "A storage key cannot be longer than 1024 characters — that is R2's own limit, so this cannot name a real object.";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator actions (ADMIN only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether this viewer may run the two write actions.
 *
 * The READ gate on this page is ADMIN **or DEVELOPER**; both mutations are
 * ADMIN **only** — reading provider telemetry at 3am and mutating moderation
 * state are not the same privilege. So the page cannot infer write access from
 * the fact that it rendered.
 *
 * ERRS CLOSED, INCLUDING WHILE PENDING — the opposite of this page's
 * `reviewAccess`, deliberately. That one gates a LINK: erring open costs a real
 * moderator half a second of a locked CTA and costs a DEVELOPER one bounce.
 * This gates a MUTATION, and an enabled button that 403s on press teaches an
 * operator that the console lies. A locked button that unlocks a moment later
 * is the harmless direction.
 */
export type OpsWriteAccess = "allowed" | "pending" | "denied" | "unknown";

export function resolveOpsWriteAccess(input: {
  roles: readonly string[] | undefined;
  isError: boolean;
}): OpsWriteAccess {
  if (input.isError) return "unknown";
  if (input.roles === undefined) return "pending";
  return input.roles.includes("ADMIN") ? "allowed" : "denied";
}

export function canWriteOps(access: OpsWriteAccess): boolean {
  return access === "allowed";
}

/** One sentence saying why the row actions are locked. Null when they are not. */
export function opsWriteLockReason(access: OpsWriteAccess): string | null {
  switch (access) {
    case "allowed":
      return null;
    case "pending":
      return "Checking whether you can resolve or re-scan rows.";
    case "denied":
      return "Resolving and re-scanning need the platform admin role. Reading this page only needs admin or developer.";
    case "unknown":
      return "Your platform admin role could not be confirmed, so the row actions stay locked.";
  }
}

/**
 * Is this row in a MACHINE state — one no human has ruled on?
 *
 * Mirrors the use case's `isMachineState`, which mirrors the Prisma adapter's
 * `RESCANNABLE_MACHINE_STATES` (the enforcing copy). Duplicated here ONLY to
 * decide whether to draw a button: the two can disagree solely by making this
 * more permissive, in which case the SQL still refuses and the operator gets a
 * readable `human_decided` refusal rather than an unsafe write. The failure
 * direction is the point.
 *
 *   PENDING            → not scored yet.
 *   ORPHANED           → machine-made terminal state; if the object is back
 *                        this is the only way to get it scored.
 *   FLAGGED + degraded → the scanner FAILED. What a post-outage re-scan is for.
 *
 * Everything else is a person's decision.
 */
export function canRescanRow(row: {
  status: ModerationRecordStatus;
  degraded: boolean;
}): boolean {
  switch (row.status) {
    case "PENDING":
    case "ORPHANED":
      return true;
    case "FLAGGED":
      return row.degraded;
    case "APPROVED":
    case "REJECTED":
      return false;
  }
}

/**
 * Does this bucket get an Actions column at all?
 *
 * FALSE for `awaitingReview` alone, and it falls out of the two guards rather
 * than being a policy of its own: those rows are FLAGGED and not degraded — a
 * real content hold — so `canRescanRow` refuses every one of them and
 * `canResolveSignal` does not name the bucket. Rendering an empty column of
 * dashes for thirty rows says nothing; the header already says decisions on
 * held images are made in the review queue.
 */
export function signalShowsRowActions(signal: QueueSignal): boolean {
  return signal !== "awaitingReview";
}

/**
 * Only the `degradedExhausted` bucket can be terminally resolved.
 *
 * Eligibility is the repo's WHERE (degraded, past the requeue cap, unreviewed),
 * which is exactly what that bucket selects — so a genuine CONTENT hold is
 * unreachable from this button even under a race.
 */
export function canResolveSignal(signal: QueueSignal): boolean {
  return signal === "degradedExhausted";
}

/**
 * `resolveUnscannable` floors `maxRequeues` at the automation's own cap.
 *
 * A client that could pass a smaller number would terminally resolve rows the
 * requeue job had not finished trying — precisely what "exhausted" is supposed
 * to rule out — so the server rejects it at the boundary. The page echoes
 * `snapshot.thresholds.maxRequeues`; if a caller ever loads the snapshot with a
 * lower cap, the button locks with a reason instead of throwing on press.
 */
/**
 * MIRRORS `MIN_RESOLVABLE_REQUEUES` in
 * `packages/core/src/use-cases/moderation/resolve-unscannable-image.ts`, which
 * PARSES the value out of `moderationQueueHealthWindowShape.maxRequeues`
 * precisely so it cannot drift from the requeue job's own cap.
 *
 * This copy is a literal because `apps/web` does not import core, and a literal
 * is exactly the drift the server went out of its way to avoid — so a test
 * (`image-moderation-ops.additions.test.ts` → "server floor") reads both source
 * files and fails if either side moves. Without that pin this constant is a
 * comment that lies eventually.
 */
export const MIN_RESOLVABLE_REQUEUES = 3;

export function canResolveWithThreshold(maxRequeues: number): boolean {
  return Number.isInteger(maxRequeues) && maxRequeues >= MIN_RESOLVABLE_REQUEUES;
}

export type ActionOutcomeCopy = {
  tone: "success" | "info";
  title: string;
  message: string;
};

/**
 * `not_eligible` IS A NORMAL OUTCOME — someone else resolved the row first, or
 * it no longer matches — so it reads as information, never as an error. The
 * server refuses to say WHICH clause failed (one bucket, on purpose: a
 * per-clause reason would have to tell a caller "this is a content hold" when
 * the whole point is that they are not authorized to know that), so the copy
 * reports the status it did come back with and stops there.
 */
export function describeResolveOutcome(result: {
  resolved: boolean;
  status: ModerationRecordStatus;
  reason: "resolved" | "not_eligible";
}): ActionOutcomeCopy {
  if (result.resolved && result.reason === "resolved") {
    return {
      tone: "success",
      title: "Resolved",
      message: `The record is now ${result.status}. No automation will touch it again.`,
    };
  }
  return {
    tone: "info",
    title: "Nothing to resolve",
    message: `This row is no longer eligible — it is ${result.status} now. Someone else may have resolved it first.`,
  };
}

/**
 * `human_decided` is THE GUARD WORKING, not a failure: `create()` resets any
 * row, so a naive re-scan of a REJECTED record would revive a moderator's
 * decision and could put the image back into circulation. Worded as a
 * deliberate refusal.
 */
export function describeRescanOutcome(result: {
  requeued: boolean;
  status: ModerationRecordStatus;
  reason: "requeued" | "human_decided";
}): ActionOutcomeCopy {
  if (result.requeued && result.reason === "requeued") {
    return {
      tone: "success",
      title: "Queued for re-scan",
      message:
        "The record is back to PENDING. The drain job will score it on its next pass.",
    };
  }
  return {
    tone: "info",
    title: "Not re-scanned",
    message: `A person already decided this image (${result.status}). Re-scanning is refused on purpose — it would discard that decision.`,
  };
}
