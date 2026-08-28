/**
 * Sentry capture for the scan flow's catch-and-degrade branches (NFR-006).
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
