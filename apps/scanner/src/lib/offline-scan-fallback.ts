/**
 * The impure half of FR-001: decide WHEN to resolve locally, do the manifest
 * read, and report the degrade.
 *
 * Kept separate from `./offline-resolve` (pure, node-tested) because this
 * file touches SQLite and Sentry. Screen wiring lands in the next step; this
 * module is the seam it will call.
 *
 * ## Reporting (NFR-006, and the Neon-outage lesson)
 *
 * Falling back to the manifest because a resolve call FAILED is a
 * catch-and-degrade branch: it gets a real `Sentry.captureException`, never a
 * bare warn, or an API outage looks like "the scanner is a bit slow tonight"
 * for four days. Falling back because the device is simply offline is not a
 * caught failure — it is the designed behaviour — so it leaves a breadcrumb
 * instead of manufacturing an error event per scan at a venue with no signal.
 * A genuine local failure (SQLite throwing) is always captured.
 *
 * ## What this module does and does not guarantee about ticket codes
 *
 * Nothing THIS FILE sends carries the scanned payload or the ticket code: the
 * tags below are the event id and the outcome kind, and `extra` is counts and
 * classifications. Codes are bearer credentials (NFR-005).
 *
 * That is a statement about this file, not about the process. The earlier
 * wording ("NOTHING here reports the scanned payload") read as a system-wide
 * guarantee, and the system did not provide one: `scan.resolvePayload` is a
 * tRPC `.query()`, so its input — including the code — rides in the GET query
 * string, and `trpc.ts`'s fetch instrumentation attached that URL to every
 * network-failure capture and breadcrumb. `lib/sentry-scrub.ts` now strips
 * query strings inside `beforeSend` / `beforeBreadcrumb`, which is where a
 * guarantee of that scope has to live. Do not restate it here.
 */
import { lookupTicketByCode, type LocalTicket } from "./local-db";
import {
  classifyOfflinePayload,
  resolveOfflineScan,
  type OfflineFallbackTrigger,
  type OfflineResolveResult,
} from "./offline-resolve";
// One isolation wrapper for the whole scan flow. This module used to carry a
// byte-identical private `safeReport`, i.e. two places to fix the rule and two
// places to forget it.
import { reportScanBreadcrumb, reportScanIssue } from "./report";

// The "should we go local?" predicate lives in the pure module so it is
// node-testable; re-exported here so a screen imports one thing.
export {
  offlineFallbackTrigger,
  type OfflineFallbackTrigger,
} from "./offline-resolve";

/**
 * Resolve a scanned payload against the local manifest and report the
 * degrade. Never throws.
 */
export function resolveScanOffline(args: {
  /** Raw payload as captured by the camera / typed by the operator. */
  raw: string;
  /** The event the operator has selected. */
  eventId: string;
  trigger: OfflineFallbackTrigger;
  /** The server rejection, when `trigger === "resolver_network_error"`. */
  error?: unknown;
  /** Injected for tests; defaults to the wall clock. */
  now?: number;
  /** Optional display name resolved by the caller (manifest holds only ids). */
  holderDisplay?: string | null;
}): OfflineResolveResult {
  const now = args.now ?? Date.now();
  const payload = classifyOfflinePayload(args.raw);

  let ticket: LocalTicket | null = null;
  let lookupFailed = false;
  if (payload.kind === "ticket") {
    try {
      ticket = lookupTicketByCode(payload.ticketCode);
    } catch (err) {
      lookupFailed = true;
      reportScanIssue(err, {
        branch: "offline_resolve_lookup",
        eventId: args.eventId,
      });
    }
  }

  const result: OfflineResolveResult = lookupFailed
    ? {
        kind: "offline_unverifiable",
        reason: "lookup_failed",
        provenance: {
          source: "offline",
          manifestSyncedAt: null,
          manifestAgeMs: null,
          stale: true,
        },
      }
    : resolveOfflineScan({
        payload,
        ticket,
        selectedEventId: args.eventId,
        manifestSyncedAt: ticket?.syncedAt ?? null,
        now,
        holderDisplay: args.holderDisplay ?? null,
      });

  reportOfflineFallback({
    trigger: args.trigger,
    error: args.error,
    eventId: args.eventId,
    result,
  });

  return result;
}

function reportOfflineFallback(args: {
  trigger: OfflineFallbackTrigger;
  error?: unknown;
  eventId: string;
  result: OfflineResolveResult;
}): void {
  // Never the raw payload or the ticket code — bearer credentials.
  const shared = {
    resultKind: args.result.kind,
    manifestAgeMs: args.result.provenance.manifestAgeMs,
    manifestStale: args.result.provenance.stale,
  };

  if (args.trigger === "resolver_network_error") {
    reportScanIssue(args.error ?? new Error("scan_resolve_network_fallback"), {
      branch: "offline_resolve_fallback",
      eventId: args.eventId,
      // Indexed so "which outcomes are we degrading into?" stays a Sentry
      // search rather than a manual read of every event.
      tags: { resultKind: args.result.kind },
      extra: shared,
    });
    return;
  }

  reportScanBreadcrumb({
    branch: "offline_resolve.device_offline",
    eventId: args.eventId,
    extra: shared,
  });
}
