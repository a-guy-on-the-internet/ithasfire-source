import { describe, expect, it } from "vitest";

import {
  EXPRESS_DWELL_MS,
  planExpressMode,
  shouldShowConfirmManually,
  type ExpressPlanInput,
} from "./express-mode";
import { EXPRESS_MODE_MAX_MANIFEST_AGE_MS } from "./offline-resolve";
import type { AnyScanResult } from "./scan-result-types";

/**
 * FR-004's acceptance surface, asserted branch by branch.
 *
 * This is the only code path in the product that admits a human with no
 * operator gesture, so the interesting tests are the HALTS, and they are
 * written one-per-outcome rather than as a loop over a list — a loop over a
 * list is a loop over the list somebody remembered.
 */

const NOW = 1_700_000_000_000;

const ticket = (
  over: Partial<Extract<AnyScanResult, { kind: "ticket" }>> = {},
): AnyScanResult =>
  ({
    kind: "ticket",
    ticketId: "tkt_1",
    ticketCode: "TKT-ABC123",
    status: "VALID",
    scannedAt: null,
    holderHumanId: "hum_1",
    holderDisplay: "Marisol Delgado-Rivera",
    ticketTypeName: "General Admission",
    alsoVolunteering: [],
    ...over,
  }) as AnyScanResult;

const offlineTicket = (args: {
  status?: string;
  ageMs: number;
}): AnyScanResult =>
  ({
    kind: "ticket",
    ticketId: "tkt_1",
    ticketCode: "TKT-ABC123",
    status: args.status ?? "VALID",
    scannedAt: null,
    holderHumanId: "hum_1",
    holderDisplay: "Marisol Delgado-Rivera",
    ticketTypeName: "General Admission",
    alsoVolunteering: [],
    admittable: (args.status ?? "VALID") === "VALID",
    provenance: {
      source: "offline",
      manifestSyncedAt: NOW - args.ageMs,
      manifestAgeMs: args.ageMs,
      stale: args.ageMs > EXPRESS_MODE_MAX_MANIFEST_AGE_MS,
    },
  }) as AnyScanResult;

const plan = (over: Partial<ExpressPlanInput> = {}) =>
  planExpressMode({
    enabled: true,
    result: ticket(),
    screenReaderEnabled: false,
    admittedRecentlyOnDevice: false,
    ...over,
  });

describe("express mode — the ONE case that auto-admits", () => {
  it("auto-admits a server-resolved VALID ticket and auto-dismisses", () => {
    const out = plan();
    expect(out.autoAdmit).toBe(true);
    expect(out.autoDismiss).toBe(true);
    expect(out.dwellMs).toBe(EXPRESS_DWELL_MS);
  });

  it("pins the dwell at 1.2s — fixed, not configurable (design §6)", () => {
    expect(EXPRESS_DWELL_MS).toBe(1200);
  });
});

describe("express mode — the toggle", () => {
  it("halts entirely when the operator has not opted in", () => {
    const out = plan({ enabled: false });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe("disabled");
  });
});

describe("express mode — every non-VALID outcome HALTS", () => {
  // ── ticket statuses ───────────────────────────────────────────────────────
  for (const status of [
    "SCANNED",
    "REFUNDED",
    "VOID",
    "LISTED",
    "INVALID",
  ] as const) {
    it(`halts on a ${status} ticket`, () => {
      const out = plan({ result: ticket({ status }) });
      expect(out.autoAdmit).toBe(false);
      expect(out.autoDismiss).toBe(false);
      expect(out.autoAdmit === false ? out.halt : null).toBe(
        "status_not_valid",
      );
    });
  }

  it("halts on a status this build does not recognise", () => {
    const out = plan({
      result: ticket({ status: "TIME_TRAVELLED" as never }),
    });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe("status_not_valid");
  });

  // ── non-ticket outcomes ───────────────────────────────────────────────────
  it("halts on wrong_event", () => {
    const out = plan({
      result: {
        kind: "wrong_event",
        payloadKind: "ticket",
        scannedEventId: "evt_other",
      } as AnyScanResult,
    });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe("not_a_ticket");
  });

  for (const reason of [
    "malformed",
    "ticket_not_found",
    "signature_failed",
  ] as const) {
    it(`halts on unknown · ${reason}`, () => {
      const out = plan({ result: { kind: "unknown", reason } as AnyScanResult });
      expect(out.autoAdmit).toBe(false);
      expect(out.autoAdmit === false ? out.halt : null).toBe("not_a_ticket");
    });
  }

  it("halts on a volunteer pass — a volunteer is never auto-checked-in", () => {
    const out = plan({
      result: {
        kind: "volunteer",
        humanId: "hum_1",
        displayName: "Sam Rivera",
        candidates: [],
        alsoHoldsTicket: [],
      } as AnyScanResult,
    });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe("not_a_ticket");
  });

  it("halts on volunteer_needs_connection", () => {
    const out = plan({
      result: {
        kind: "volunteer_needs_connection",
        provenance: {
          source: "offline",
          manifestSyncedAt: NOW,
          manifestAgeMs: 0,
          stale: false,
        },
      } as AnyScanResult,
    });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe("not_a_ticket");
  });

  for (const reason of [
    "not_in_manifest",
    "unreadable_payload",
    "unrecognized_status",
    "lookup_failed",
  ] as const) {
    it(`halts on offline_unverifiable · ${reason}`, () => {
      const out = plan({
        result: {
          kind: "offline_unverifiable",
          reason,
          provenance: {
            source: "offline",
            manifestSyncedAt: null,
            manifestAgeMs: null,
            stale: true,
          },
        } as AnyScanResult,
      });
      expect(out.autoAdmit).toBe(false);
      expect(out.autoAdmit === false ? out.halt : null).toBe("not_a_ticket");
    });
  }
});

describe("express mode — the offline freshness gate (FR-004)", () => {
  it("auto-admits an offline VALID from a manifest inside the window", () => {
    const out = plan({ result: offlineTicket({ ageMs: 60_000 }) });
    expect(out.autoAdmit).toBe(true);
  });

  it("drops to manual confirm for a manifest older than 10 minutes", () => {
    const out = plan({
      result: offlineTicket({ ageMs: EXPRESS_MODE_MAX_MANIFEST_AGE_MS + 1 }),
    });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe("manifest_stale");
  });

  it("treats the boundary itself as fresh (>, not >=)", () => {
    // Matches `offline-resolve`'s own comparison, so the chip and the gate
    // cannot disagree about a manifest sitting exactly on 10 minutes.
    const out = plan({
      result: offlineTicket({ ageMs: EXPRESS_MODE_MAX_MANIFEST_AGE_MS }),
    });
    expect(out.autoAdmit).toBe(true);
  });

  it("treats an UNKNOWN manifest age as stale — fail closed", () => {
    const out = plan({
      result: {
        kind: "ticket",
        ticketId: "tkt_1",
        ticketCode: "TKT-ABC123",
        status: "VALID",
        scannedAt: null,
        holderHumanId: "hum_1",
        holderDisplay: "Unknown",
        ticketTypeName: null,
        alsoVolunteering: [],
        admittable: true,
        provenance: {
          source: "offline",
          manifestSyncedAt: null,
          manifestAgeMs: null,
          stale: true,
        },
      } as AnyScanResult,
    });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe("manifest_stale");
  });
});

describe("express mode — screen readers (NFR-002)", () => {
  it("still admits, but NEVER auto-dismisses, while a screen reader is on", () => {
    const out = plan({ screenReaderEnabled: true });
    expect(out.autoAdmit).toBe(true);
    expect(out.autoDismiss).toBe(false);
    expect(out.autoAdmit === true ? out.dismissSuppressedBy : null).toBe(
      "screen_reader",
    );
  });

  it("reports no suppression when no screen reader is active", () => {
    const out = plan({ screenReaderEnabled: false });
    expect(out.autoAdmit === true ? out.dismissSuppressedBy : "x").toBeNull();
  });
});

describe("express mode — the INSERT OR REPLACE re-admit guard", () => {
  /**
   * The scenario: a manifest sync lands between an optimistic local admit and
   * the queue flush that reports it, rewriting the local `SCANNED` back to the
   * server's `VALID`. In MANUAL mode a re-scan shows a green state and the
   * operator decides. In express mode, without this guard, it would admit a
   * second time with no gesture from anyone.
   */
  it("halts when this device already admitted the ticket recently", () => {
    const out = plan({ admittedRecentlyOnDevice: true });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe(
      "recently_admitted_here",
    );
  });

  it("halts on the offline path too — the race is not online-only", () => {
    const out = plan({
      result: offlineTicket({ ageMs: 30_000 }),
      admittedRecentlyOnDevice: true,
    });
    expect(out.autoAdmit).toBe(false);
    expect(out.autoAdmit === false ? out.halt : null).toBe(
      "recently_admitted_here",
    );
  });

  it("reports the STATUS halt, not the guard, for a non-VALID ticket", () => {
    // Ordering matters for the Sentry tag: `recently_admitted_here` on a
    // REFUNDED ticket would be a confusing lie.
    const out = plan({
      result: ticket({ status: "REFUNDED" }),
      admittedRecentlyOnDevice: true,
    });
    expect(out.autoAdmit === false ? out.halt : null).toBe("status_not_valid");
  });
});

describe("shouldShowConfirmManually", () => {
  it("is true for a stale offline VALID with express on", () => {
    expect(
      shouldShowConfirmManually({
        enabled: true,
        result: offlineTicket({ ageMs: EXPRESS_MODE_MAX_MANIFEST_AGE_MS + 1 }),
      }),
    ).toBe(true);
  });

  it("is false for a FRESH offline VALID — express will handle it", () => {
    expect(
      shouldShowConfirmManually({
        enabled: true,
        result: offlineTicket({ ageMs: 1_000 }),
      }),
    ).toBe(false);
  });

  it("is false when express is off — nothing 'stopped working'", () => {
    expect(
      shouldShowConfirmManually({
        enabled: false,
        result: offlineTicket({ ageMs: EXPRESS_MODE_MAX_MANIFEST_AGE_MS + 1 }),
      }),
    ).toBe(false);
  });

  it("is false for a server result — a server result has no chip at all", () => {
    expect(shouldShowConfirmManually({ enabled: true, result: ticket() })).toBe(
      false,
    );
  });

  it("is false for a non-VALID offline ticket — it was never going to admit", () => {
    expect(
      shouldShowConfirmManually({
        enabled: true,
        result: offlineTicket({
          status: "SCANNED",
          ageMs: EXPRESS_MODE_MAX_MANIFEST_AGE_MS + 1,
        }),
      }),
    ).toBe(false);
  });
});
