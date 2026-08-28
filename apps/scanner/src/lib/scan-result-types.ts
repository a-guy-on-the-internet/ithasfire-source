/**
 * Result-union types for the scan flow, plus the pure mapping from a resolved
 * result to a {@link ScanResultDescriptor}.
 *
 * ## Why these types are declared by hand (NFR-007)
 *
 * `RouterOutputs["scan"]["resolvePayload"]` resolves to `unknown` in this app:
 * the scanner tsconfig cannot follow the transitive
 * `@th/trpc → @th/core → @th/ports` chain, and fixing that tsconfig is
 * explicitly out of scope for this spec. These are equivalent inline types
 * derived from the core use-case output definitions.
 *
 * **Source of truth:** `packages/core/src/use-cases/scanning/resolve-scan-payload.ts`
 * (result union) and `packages/core/src/use-cases/volunteers/*` (candidate
 * shape). Change one, change the other.
 *
 * They moved OUT of `unified-result-view.tsx` so `describeScanResult` — the
 * step that decides what an operator is told — can be unit-tested in node
 * without importing react-native.
 */
import type {
  OfflineProvenance,
  OfflineResolveResult,
} from "./offline-resolve";
import type { ScanResultDescriptor } from "./scan-result-presentation";

export type AlsoTicket = {
  ticketId: string;
  ticketCode: string;
  status: "VALID" | "SCANNED";
  scannedAt: Date | null;
};

export type Candidate = {
  signupId: string;
  humanId: string;
  humanDisplayName: string;
  humanContactMasked: string;
  eventId: string;
  eventTitle: string;
  roleId: string;
  roleLabel: string;
  shiftId: string;
  shiftLabel: string;
  shiftStartAt: string;
  shiftEndAt: string;
  status: "APPROVED" | "CHECKED_IN" | "NO_SHOW";
  checkedInAt: string | null;
  checkedInByHumanId: string | null;
  window: "before" | "within" | "after";
  scanWindowNote: string;
  alsoHoldsTicket: boolean;
};

export type VolunteerResult = {
  kind: "volunteer";
  humanId: string;
  displayName: string;
  candidates: Candidate[];
  alsoHoldsTicket: AlsoTicket[];
};

export type TicketResult = {
  kind: "ticket";
  ticketId: string;
  ticketCode: string;
  status: "VALID" | "SCANNED" | "INVALID" | "REFUNDED" | "LISTED" | "VOID";
  scannedAt: Date | null;
  holderHumanId: string;
  holderDisplay: string;
  ticketTypeName: string | null;
  alsoVolunteering: Candidate[];
};

export type WrongEventResult = {
  kind: "wrong_event";
  payloadKind: "volunteer" | "ticket";
  scannedEventId: string;
};

export type UnknownResult = {
  kind: "unknown";
  reason: "malformed" | "ticket_not_found" | "signature_failed";
};

/** What `scan.resolvePayload` returns. */
export type UnifiedResolveResult =
  | VolunteerResult
  | WrongEventResult
  | TicketResult
  | UnknownResult;

/**
 * Anything the result view can render: a server answer, or an FR-001 offline
 * one. The offline union carries two kinds the online resolver has no reason
 * to produce (`offline_unverifiable`, `volunteer_needs_connection`) and every
 * offline member carries `provenance` — which is precisely how the view knows
 * to draw the badge.
 */
export type AnyScanResult = UnifiedResolveResult | OfflineResolveResult;

export type SameOrderTicket = {
  ticketCode: string;
  ticketTypeName: string | null;
  /**
   * FR-006a. Carried through from the local manifest so a bulk-admitted
   * ticket lands in `recent_scans` WITH its id — without one, the 30s undo is
   * unreachable for every row a bulk admit created, because the
   * server-acknowledged undo path has nothing to revert.
   */
  ticketId: string | null;
};

/**
 * Offline provenance, or null for a server result.
 *
 * **A result with no provenance is a server result.** That invariant is what
 * makes the badge meaningful, so this is the only place the distinction is
 * derived.
 */
export const provenanceOf = (
  result: AnyScanResult,
): OfflineProvenance | null =>
  "provenance" in result ? result.provenance : null;

/**
 * Flatten a resolved result into the descriptor `presentScanResult` consumes.
 * Deliberately does NOT decide tone/glyph/copy — that table lives in
 * `./scan-result-presentation`, and keeping extraction separate from decision
 * is what makes both testable.
 */
export function describeScanResult(
  result: AnyScanResult,
  opts: {
    /** Name of the event the operator has selected — for wrong-event copy. */
    selectedEventName?: string | null;
    /** Pre-formatted local time of a prior scan, for ALREADY IN. */
    scannedAtLabel?: string | null;
    /**
     * FR-004 — `planExpressMode` halted with `recently_admitted_here`. Carried
     * through so the VERDICT can say so; a halt the operator cannot see is a
     * guard that only exists in a Sentry tag.
     */
    admittedHereRecently?: boolean;
  } = {},
): ScanResultDescriptor {
  switch (result.kind) {
    case "ticket":
      return {
        kind: "ticket",
        status: result.status,
        scannedAtLabel: opts.scannedAtLabel ?? null,
        admittedHereRecently: opts.admittedHereRecently ?? false,
      };
    case "wrong_event":
      return {
        kind: "wrong_event",
        selectedEventName: opts.selectedEventName ?? null,
      };
    case "unknown":
      return { kind: "unknown", reason: result.reason };
    case "volunteer": {
      const primary =
        result.candidates.find((c) => c.status === "APPROVED") ??
        result.candidates[0] ??
        null;
      return {
        kind: "volunteer",
        roleLabel: primary?.roleLabel ?? null,
        shiftLabel: primary?.shiftLabel ?? null,
        scanWindowNote: primary?.scanWindowNote ?? null,
      };
    }
    case "offline_unverifiable":
      return { kind: "offline_unverifiable", reason: result.reason };
    case "volunteer_needs_connection":
      return { kind: "volunteer_needs_connection" };
    default: {
      const _never: never = result;
      void _never;
      // Fails closed through the presenter's UNKNOWN branch.
      return { kind: "offline_unverifiable", reason: "unrecognized_status" };
    }
  }
}
