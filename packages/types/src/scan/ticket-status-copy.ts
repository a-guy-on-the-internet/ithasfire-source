/**
 * Shared operator-facing copy for the six TICKET LIFECYCLE statuses, plus the
 * three "we couldn't resolve this payload" reasons.
 *
 * ## Why this lives in `@th/types`
 *
 * Both scan surfaces need it — the native scanner
 * (`apps/scanner/src/screens/unified-result-view.tsx`) and the web admin scan
 * page (`apps/web/src/app/admin/[slug]/scan/_components/UnifiedScanView.tsx`).
 * Those two files had drifted: the scanner handled REFUNDED + VOID but not
 * LISTED, the web handled REFUNDED + LISTED but not VOID *and* labelled
 * INVALID as "Voided", and the unknown-reason triplet was hand-copied into
 * both. Spec `docs/specs/2026-08-04/completed/scan-ticket-redesign.spec.yaml` FR-008 /
 * NFR-007 require ONE real shared import, not a fourth hand-copied enum.
 *
 * `@th/types` is framework-free pure TS, has zero React/React-Native imports,
 * is already a dependency of both apps, and its tests run in CI.
 *
 * ## i18n readiness
 *
 * The scanner is English-only today (no dual-catalog wiring in `apps/scanner`)
 * and this spec does not translate it. The copy is therefore stored as DATA
 * with a stable message key alongside each English default, so a later change
 * can route `labelKey` / `guidanceKey` through the web catalog
 * (`apps/web/src/i18n/messages/*`) without touching a single call site's
 * structure. Never inline these strings in JSX again.
 *
 * ## Not to be confused with
 *
 * TICKET-TYPE lifecycle status (DRAFT / ACTIVE). Those are deliberately never
 * surfaced to operators. These are per-TICKET statuses and the operator is the
 * intended audience.
 */

/**
 * Status tone. Mirrors the `BadgeTone` union exported by
 * `packages/ui-native/src/primitives.tsx` (and the web `Tone` union in
 * `UnifiedScanView.tsx`).
 *
 * Deliberately re-declared rather than imported: `@th/types` must not depend
 * on the React-Native package (`@th/ui-native`), and `@th/ui-native` must not
 * become a dependency of the web app.
 *
 * ## How the "keep them identical" rule is actually enforced
 *
 * It used to say "the consumer-side assignment `const tone: BadgeTone =
 * copy.tone` is what fails the build if they ever drift". That guard did not
 * exist and could not have run: the only such assignment lives in
 * `apps/scanner`, and `tsconfig.base.json` excludes `apps/**`, so the workspace
 * typecheck never looks at it. A type-level guard in a directory the typechecker
 * does not visit is a phantom gate.
 *
 * The real guard is a RUNTIME set-equality assertion over
 * {@link SCAN_STATUS_TONES} and `@th/ui-native`'s `BADGE_TONES`, living in
 * `packages/ui-native/src/__tests__/badge-tone-drift.test.ts` — a suite CI
 * executes (`pnpm -F @th/ui-native exec vitest --run`). Which is why the union
 * below has a value-level twin: a type alone cannot be compared at runtime.
 */
export type ScanStatusTone = "success" | "warning" | "danger" | "neutral";

/**
 * Value-level twin of {@link ScanStatusTone}. Exists so the drift guard can
 * compare SETS rather than trust a type assertion nothing runs.
 *
 * The `satisfies` below pins the two together in the other direction: adding a
 * member to the type without adding it here is a type error in this package,
 * which IS typechecked by `pnpm typecheck`.
 */
export const SCAN_STATUS_TONES = [
  "success",
  "warning",
  "danger",
  "neutral",
] as const satisfies readonly ScanStatusTone[];

/**
 * `satisfies` above proves every LISTED member is a real tone. This proves the
 * converse — that every real tone is listed — so neither direction can drift.
 * Adding a member to {@link ScanStatusTone} without adding it to
 * {@link SCAN_STATUS_TONES} turns the annotation into `false` and fails
 * `pnpm typecheck`.
 */
const _everyToneIsListed: [
  Exclude<ScanStatusTone, (typeof SCAN_STATUS_TONES)[number]>,
] extends [never]
  ? true
  : false = true;
void _everyToneIsListed;

/** Every ticket lifecycle status an operator can be shown at the door. */
export const TICKET_SCAN_STATUSES = [
  "VALID",
  "SCANNED",
  "INVALID",
  "REFUNDED",
  "LISTED",
  "VOID",
] as const;

export type TicketScanStatus = (typeof TICKET_SCAN_STATUSES)[number];

/**
 * Resolved copy for one status.
 *
 * `label` / `guidance` are the English defaults; `labelKey` / `guidanceKey`
 * are the stable catalog keys a future i18n pass routes through.
 */
export type TicketStatusCopy = {
  /** The status this entry describes, or `"UNKNOWN"` for the safe fallback. */
  status: TicketScanStatus | "UNKNOWN";
  tone: ScanStatusTone;
  /**
   * Whether an operator may admit on this status.
   *
   * TRUE for exactly one status: `VALID`. Lives here so the online screen,
   * the offline resolver, and any future express-mode gate all read the same
   * table instead of each re-deriving `status === "VALID"` (and eventually
   * disagreeing). The `UNKNOWN` fallback is never admittable — an
   * unrecognised status is not a pass.
   */
  admittable: boolean;
  labelKey: string;
  label: string;
  guidanceKey: string;
  guidance: string;
};

/**
 * Status → copy. Guidance lines for REFUNDED and VOID are byte-identical to
 * the scanner's previous inline copy; LISTED is verbatim from FR-008.
 */
export const TICKET_STATUS_COPY: Record<TicketScanStatus, TicketStatusCopy> = {
  VALID: {
    status: "VALID",
    tone: "success",
    admittable: true,
    labelKey: "scan.status.valid.label",
    label: "Valid",
    guidanceKey: "scan.status.valid.guidance",
    guidance: "Valid ticket — admit.",
  },
  SCANNED: {
    status: "SCANNED",
    tone: "warning",
    admittable: false,
    labelKey: "scan.status.scanned.label",
    label: "Already scanned",
    guidanceKey: "scan.status.scanned.guidance",
    guidance: "Already scanned — check with the operator before re-admitting.",
  },
  INVALID: {
    // NOT "Voided" — that was the web's bug (UnifiedScanView.tsx:1210-1214),
    // which labelled INVALID with VOID's copy and left VOID unhandled.
    status: "INVALID",
    tone: "danger",
    admittable: false,
    labelKey: "scan.status.invalid.label",
    label: "Invalid",
    guidanceKey: "scan.status.invalid.guidance",
    guidance: "Invalid ticket — do not admit.",
  },
  REFUNDED: {
    status: "REFUNDED",
    tone: "danger",
    admittable: false,
    labelKey: "scan.status.refunded.label",
    label: "Refunded",
    guidanceKey: "scan.status.refunded.guidance",
    guidance: "Refunded — do not admit.",
  },
  LISTED: {
    status: "LISTED",
    tone: "danger",
    admittable: false,
    labelKey: "scan.status.listed.label",
    label: "Listed for resale",
    guidanceKey: "scan.status.listed.guidance",
    // Verbatim per FR-008.
    guidance: "Listed for resale — do not admit.",
  },
  VOID: {
    status: "VOID",
    tone: "danger",
    admittable: false,
    labelKey: "scan.status.void.label",
    label: "Voided",
    guidanceKey: "scan.status.void.guidance",
    guidance: "Voided — do not admit.",
  },
};

/**
 * Fallback for a status string neither surface recognises (e.g. a server-side
 * enum added after the client shipped, or a locally-cached manifest row from
 * an older schema). Fails CLOSED: danger tone, never admittable.
 */
export const UNKNOWN_TICKET_STATUS_COPY: TicketStatusCopy = {
  status: "UNKNOWN",
  tone: "danger",
  admittable: false,
  labelKey: "scan.status.unknownStatus.label",
  label: "Unrecognized status",
  guidanceKey: "scan.status.unknownStatus.guidance",
  guidance: "This ticket's status isn't recognized — do not admit.",
};

export function isTicketScanStatus(value: unknown): value is TicketScanStatus {
  return (
    typeof value === "string" &&
    (TICKET_SCAN_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Resolve any status string to copy. Unknown / null / undefined inputs get
 * {@link UNKNOWN_TICKET_STATUS_COPY} — deliberately NOT an exception, because
 * this runs on the scan hot path where throwing would blank the result state
 * an operator is standing at a door reading.
 */
export function resolveTicketStatusCopy(
  status: string | null | undefined,
): TicketStatusCopy {
  return isTicketScanStatus(status)
    ? TICKET_STATUS_COPY[status]
    : UNKNOWN_TICKET_STATUS_COPY;
}

// ── Unresolvable payloads ───────────────────────────────────────────────────

/**
 * Reasons `scan.resolvePayload` returns `{ kind: "unknown" }`. Mirrors
 * `ResolveScanPayloadUnknownResult["reason"]` in
 * `packages/core/src/use-cases/scanning/resolve-scan-payload.ts`.
 */
export const SCAN_UNKNOWN_REASONS = [
  "malformed",
  "ticket_not_found",
  "signature_failed",
] as const;

export type ScanUnknownReason = (typeof SCAN_UNKNOWN_REASONS)[number];

export type ScanUnknownCopy = {
  reason: ScanUnknownReason;
  tone: ScanStatusTone;
  labelKey: string;
  label: string;
  guidanceKey: string;
  guidance: string;
};

/**
 * Copy for the three unknown reasons. Guidance strings are byte-identical to
 * the two hand-copied `UNKNOWN_COPY` maps this replaces
 * (`unified-result-view.tsx:96-100`, `UnifiedScanView.tsx:154-161`) so no
 * operator-visible string changes when the duplication is removed.
 */
export const SCAN_UNKNOWN_COPY: Record<ScanUnknownReason, ScanUnknownCopy> = {
  malformed: {
    reason: "malformed",
    tone: "danger",
    labelKey: "scan.unknown.malformed.label",
    label: "Not recognized",
    guidanceKey: "scan.unknown.malformed.guidance",
    guidance: "Couldn't read this QR code. Try again or use Manual Search.",
  },
  ticket_not_found: {
    reason: "ticket_not_found",
    tone: "danger",
    labelKey: "scan.unknown.ticketNotFound.label",
    label: "Not recognized",
    guidanceKey: "scan.unknown.ticketNotFound.guidance",
    guidance: "No ticket matches this code for this event.",
  },
  signature_failed: {
    reason: "signature_failed",
    tone: "danger",
    labelKey: "scan.unknown.signatureFailed.label",
    label: "Not recognized",
    guidanceKey: "scan.unknown.signatureFailed.guidance",
    guidance: "This volunteer pass is invalid or has been tampered with.",
  },
};

export function isScanUnknownReason(
  value: unknown,
): value is ScanUnknownReason {
  return (
    typeof value === "string" &&
    (SCAN_UNKNOWN_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Resolve an unknown-reason to copy, falling back to `malformed` (the most
 * conservative "we couldn't read it" phrasing) for an unrecognised reason.
 */
export function resolveScanUnknownCopy(
  reason: string | null | undefined,
): ScanUnknownCopy {
  return isScanUnknownReason(reason)
    ? SCAN_UNKNOWN_COPY[reason]
    : SCAN_UNKNOWN_COPY.malformed;
}
