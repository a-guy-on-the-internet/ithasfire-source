/**
 * FR-013 — what a door operator is told when the ROUND TRIP fails.
 *
 * PURE. No React, no Tamagui, no tRPC types — a plain `unknown` in, copy out,
 * so every branch is asserted in node.
 *
 * ## Why this exists
 *
 * The scan surface used to put `err.message` straight onto the full-bleed
 * verdict as its guidance line, and a live door session rendered
 *
 *     SCAN FAILED / ERROR
 *     volunteer_scan_token_not_configured
 *
 * to an operator standing in front of a queue. A raw server identifier is not
 * guidance: there is no action in it, it looks like an accusation against the
 * person holding the pass, and it leaks our internals to a venue's door staff.
 *
 * The rule this module encodes is structural, not a lookup table with a hole in
 * it: **a server string can never become the primary guidance.** Guidance is
 * always chosen from {@link SCAN_FAILURE_COPY} by CLASSIFYING the failure. The
 * raw string survives only as {@link ScanFailure.detail}, which the verdict
 * renders as a small support line under the guidance (and which Sentry gets in
 * full regardless).
 *
 * ## Why not the shared `@th/types` unknown-reason copy
 *
 * `resolveScanUnknownCopy` is about the PAYLOAD — "Couldn't read this QR code",
 * "No ticket matches this code". Reusing it for a transport failure would tell
 * an operator to blame the ticket when the fault is ours, which is the same
 * class of mis-attribution as showing them a raw code. That shared map IS used
 * here — but only where it genuinely fits, for a server-side admit REJECTION
 * (`scan-result-presentation.ts`), where the server really is talking about the
 * ticket.
 *
 * Copy lives as DATA with a stable message key, like the rest of the scan
 * surface, so a later i18n pass routes it through the catalog without touching
 * a call site. Nothing here adds a catalog key today.
 *
 * Design: docs/records/2026-08-04-scan-screen-design.md §2.2, §10.
 */

import { lookupOwn } from "@/lib/lookup-own";

/**
 * The five things that can go wrong on a round trip, from the operator's point
 * of view. Deliberately coarse: an operator at a door has exactly three
 * available actions (try again, dismiss and search, fetch someone with more
 * access), so a sixth class would not change what anyone does.
 */
export type ScanFailureKind =
  | "offline"
  | "timeout"
  | "permission"
  | "server"
  | "unknown";

export type ScanFailure = {
  kind: ScanFailureKind;
  /** Stable message key for a later i18n pass. */
  key: string;
  /** Operator-actionable sentence. NEVER a raw code, by construction. */
  guidance: string;
  /**
   * The raw server code/message, for support only. Rendered small, under the
   * guidance, and never as the guidance itself. Null when the error carried
   * nothing worth quoting.
   */
  detail: string | null;
};

export const SCAN_FAILURE_COPY: Record<
  ScanFailureKind,
  { key: string; guidance: string }
> = {
  offline: {
    key: "scan.failure.offline.guidance",
    guidance:
      "Couldn't reach the server. Try the scan again, or dismiss and use Search.",
  },
  timeout: {
    key: "scan.failure.timeout.guidance",
    guidance:
      "The server didn't answer in time. Try the scan again, or dismiss and use Search.",
  },
  permission: {
    key: "scan.failure.permission.guidance",
    guidance:
      "You're not allowed to scan for this event. Ask an organizer for access.",
  },
  server: {
    key: "scan.failure.server.guidance",
    guidance:
      "The server couldn't complete that scan. Try again, or dismiss and use Search.",
  },
  unknown: {
    key: "scan.failure.unknown.guidance",
    guidance:
      "Something went wrong talking to the server. Try the scan again, or dismiss and use Search.",
  },
};

/**
 * A fetch that never reached a server. Every engine words it differently and
 * none of them is a tRPC code, so the message is the only signal available.
 */
const NETWORK_MESSAGE =
  /failed to fetch|network\s?error|network request failed|load failed|fetch failed|connection (refused|reset)|err_internet_disconnected/i;

/** tRPC codes whose operator meaning is NOT "the server broke". */
const TRPC_CODE_KIND: Record<string, ScanFailureKind> = {
  UNAUTHORIZED: "permission",
  FORBIDDEN: "permission",
  TIMEOUT: "timeout",
  CLIENT_CLOSED_REQUEST: "timeout",
};

/**
 * A support line, not a paragraph. Long enough for a code plus a short server
 * sentence; short enough that it cannot push the verdict word off a 320px
 * screen (design §2.1's vertical budget).
 */
export const MAX_FAILURE_DETAIL_LENGTH = 120;

type ErrorLike = {
  message?: unknown;
  name?: unknown;
  data?: { code?: unknown; appCode?: unknown } | null;
  shape?: { data?: { code?: unknown; appCode?: unknown } | null } | null;
};

const asRecord = (value: unknown): ErrorLike =>
  value && typeof value === "object" ? (value as ErrorLike) : {};

const readMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message.trim();
  const raw = asRecord(err).message;
  if (typeof raw === "string") return raw.trim();
  if (typeof err === "string") return err.trim();
  return "";
};

/** tRPC's transport code (`INTERNAL_SERVER_ERROR`), not the domain code. */
const readTrpcCode = (err: unknown): string => {
  const e = asRecord(err);
  const raw = e.data?.code ?? e.shape?.data?.code;
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
};

/** The domain code the wire `errorFormatter` attaches (`data.appCode`). */
const readAppCode = (err: unknown): string => {
  const e = asRecord(err);
  const raw = e.data?.appCode ?? e.shape?.data?.appCode;
  return typeof raw === "string" ? raw.trim() : "";
};

const truncate = (value: string): string =>
  value.length <= MAX_FAILURE_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_FAILURE_DETAIL_LENGTH - 1)}…`;

/**
 * Build the support line: the most specific identifier we have, plus the server
 * message when it adds anything. Whitespace is collapsed because a stack-ish
 * multi-line message would otherwise blow up the verdict block.
 */
const buildDetail = (err: unknown): string | null => {
  const appCode = readAppCode(err);
  const trpcCode = readTrpcCode(err);
  const message = readMessage(err).replace(/\s+/g, " ");
  const code = appCode || trpcCode;
  const parts = [code, message && message !== code ? message : ""].filter(
    Boolean,
  );
  const detail = parts.join(" · ").trim();
  return detail ? truncate(detail) : null;
};

/**
 * Classify a thrown resolve/admit/check-in failure.
 *
 * `opts.online` lets the caller hand in `navigator.onLine`: a phone that has
 * genuinely lost signal at a door is the single most likely failure on this
 * surface, and it outranks whatever the fetch layer happened to say.
 */
export function describeScanFailure(
  err: unknown,
  opts: { online?: boolean } = {},
): ScanFailure {
  const kind = classify(err, opts);
  const copy = SCAN_FAILURE_COPY[kind];
  return { kind, key: copy.key, guidance: copy.guidance, detail: buildDetail(err) };
}

function classify(
  err: unknown,
  opts: { online?: boolean },
): ScanFailureKind {
  if (opts.online === false) return "offline";

  const trpcCode = readTrpcCode(err);
  if (trpcCode) return lookupOwn(TRPC_CODE_KIND, trpcCode) ?? "server";

  const message = readMessage(err);
  if (NETWORK_MESSAGE.test(message)) return "offline";
  // `fetch` rejects with a TypeError for every transport-level failure, and
  // that is the only signal a cross-origin network error carries.
  if (err instanceof TypeError || asRecord(err).name === "TypeError") {
    return "offline";
  }
  if (/abort|timed? ?out/i.test(message)) return "timeout";

  return "unknown";
}
