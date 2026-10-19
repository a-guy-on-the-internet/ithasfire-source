/**
 * Sentry capture for the scan flow's catch-and-degrade branches (NFR-006),
 * and for the Sell tab's card failures ({@link reportPosIssue}).
 *
 * ## Why this exists
 *
 * The repo convention (CLAUDE.md) is that any branch which CATCHES a failure
 * and carries on must report it, or an outage looks like "the scanner is a bit
 * slow tonight" for four days. The scanner's bulk-admit path swallowed
 * permanent rejections with no capture and no message, and still fired the
 * success haptic — an operator was told "admitted" for tickets the server had
 * refused.
 *
 * ## Two rules, both non-negotiable
 *
 *   1. **Reporting never changes scan behaviour.** Every call is isolated: a
 *      throwing/mis-configured reporter must not break an admission. That is
 *      what {@link safeReport} is, and it is the ONLY isolation wrapper in the
 *      scan flow — `offline-scan-fallback.ts` used to carry a byte-identical
 *      private copy, which is one place for the rule to be fixed and one place
 *      for it to be forgotten.
 *   2. **Never report a ticket code or a scanned payload.** They are bearer
 *      credentials (NFR-005). Tags carry the event id, the branch and the
 *      outcome kind; `extra` carries counts. Nothing else.
 *
 * The type of `ScanReportContext["extra"]` is the enforcement for rule 2 as far
 * as a type can go — it cannot stop someone passing a code as a `string`, so
 * the rule is also a review rule. See `lib/sentry-scrub.ts` for the backstop
 * that strips codes out of the transport layer's own URLs.
 */
import * as Sentry from "@sentry/react-native";

export type ScanReportContext = {
  /** Where in the flow this was caught, e.g. `bulk_admit_permanent`. */
  branch: string;
  eventId: string;
  /**
   * Extra INDEXED tags (searchable / groupable in Sentry). Same payload rule as
   * `extra` — classifications only, never a code.
   */
  tags?: Record<string, string>;
  /** Counts and classifications ONLY — never codes, payloads or PII. */
  extra?: Record<string, number | string | boolean | null>;
};

/**
 * Run a reporting call in isolation. Never throws.
 *
 * Exported because the reporting SHAPE differs across the flow (exception vs
 * breadcrumb, different tag sets) but the isolation rule does not.
 */
export const safeReport = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // A throwing reporter must not break an admission.
  }
};

/**
 * Capture a swallowed scan-flow failure. Never throws.
 */
export function reportScanIssue(
  error: unknown,
  context: ScanReportContext,
): void {
  safeReport(() => {
    Sentry.captureException(
      error instanceof Error ? error : new Error(context.branch),
      {
        tags: {
          feature: "scan",
          branch: context.branch,
          eventId: context.eventId,
          ...context.tags,
        },
        extra: context.extra,
      },
    );
  });
}

/**
 * The Sell tab's report context: same shape and same payload rule as
 * {@link ScanReportContext}, keyed by the order instead of the event. Tags are
 * classifications (the SDK's error code, the step, the phase); never a
 * PaymentIntent client secret, an SDK message or anything the buyer typed.
 */
export type PosReportContext = {
  /** Where in the sale this was caught, e.g. `tap_to_pay_sdk_error`. */
  branch: string;
  orderId: string;
  /** Sentry's default ("error") when omitted; "warning" for buyer-side outcomes. */
  level?: "warning";
  tags?: Record<string, string>;
  /** Counts and classifications ONLY — never secrets, messages or PII. */
  extra?: Record<string, number | string | boolean | null>;
};

/**
 * Capture a Sell-tab failure the screen caught and turned into operator copy.
 * Never throws (same isolation as {@link reportScanIssue}).
 */
export function reportPosIssue(error: unknown, context: PosReportContext): void {
  safeReport(() => {
    Sentry.captureException(
      error instanceof Error ? error : new Error(context.branch),
      {
        ...(context.level ? { level: context.level } : {}),
        tags: {
          feature: "pos",
          branch: context.branch,
          orderId: context.orderId,
          ...context.tags,
        },
        extra: context.extra,
      },
    );
  });
}

/**
 * Capture a failed removal of cached attendee data (`docs/scanner-pii.md`): a
 * people drop in the manifest sync, or a step of the access-denied wipe. The
 * caller carries on, so without this a wipe that did not happen would look
 * like one that did. Never throws.
 *
 * `branch` names the step. `extra` is counts and classifications only, and the
 * error is SQLite's or React Query's own: no name, email or ticket code.
 */
export function reportRetentionIssue(
  error: unknown,
  context: {
    branch: string;
    extra?: Record<string, number | string | boolean | null>;
  },
): void {
  safeReport(() => {
    Sentry.captureException(
      error instanceof Error ? error : new Error(context.branch),
      {
        tags: { feature: "pii_retention", branch: context.branch },
        extra: context.extra,
      },
    );
  });
}

/**
 * Leave a breadcrumb for a degrade that is DESIGNED behaviour rather than a
 * caught failure — resolving from the local manifest because the device is
 * simply offline, for instance. Capturing an exception per scan at a venue with
 * no signal would manufacture an incident out of the feature working.
 *
 * Same payload rule as {@link reportScanIssue}: counts and classifications only.
 */
export function reportScanBreadcrumb(context: ScanReportContext): void {
  safeReport(() => {
    Sentry.addBreadcrumb({
      category: "scan",
      level: "info",
      message: context.branch,
      data: { eventId: context.eventId, ...context.extra },
    });
  });
}
