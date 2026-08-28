import { describe, expect, it } from "vitest";

import { TICKET_SCAN_STATUSES } from "@th/types";

import {
  MAX_VERDICT_LENGTH,
  presentScanResult,
  type ScanResultDescriptor,
} from "./scan-result-presentation";
import { describeScanResult } from "./scan-result-types";

/**
 * FR-003 — what an operator is TOLD, asserted rather than eyeballed.
 *
 * The two tests that matter most here are the redundancy ones: "state 11 is
 * not state 6" and "every outcome differs on more than colour". Both encode
 * decisions a future refactor would otherwise be free to quietly undo, and
 * both are about not making a false accusation at a door.
 */

const ALL: ScanResultDescriptor[] = [
  ...TICKET_SCAN_STATUSES.map((status) => ({
    kind: "ticket" as const,
    status,
  })),
  { kind: "wrong_event" },
  { kind: "unknown", reason: "malformed" },
  { kind: "unknown", reason: "ticket_not_found" },
  { kind: "unknown", reason: "signature_failed" },
  { kind: "volunteer", roleLabel: "Bar", shiftLabel: "8–11pm" },
  { kind: "offline_unverifiable", reason: "not_in_manifest" },
  { kind: "offline_unverifiable", reason: "unreadable_payload" },
  { kind: "offline_unverifiable", reason: "unrecognized_status" },
  { kind: "offline_unverifiable", reason: "lookup_failed" },
  { kind: "volunteer_needs_connection" },
];

describe("presentScanResult — the tone table", () => {
  it("maps every ticket status to the designed family", () => {
    const tone = (status: string) =>
      presentScanResult({ kind: "ticket", status }).tone;
    expect(tone("VALID")).toBe("admit");
    expect(tone("SCANNED")).toBe("alreadyIn");
    for (const s of ["INVALID", "REFUNDED", "LISTED", "VOID"]) {
      expect(tone(s), s).toBe("stop");
    }
  });

  it("admits on VALID and nothing else", () => {
    for (const d of ALL) {
      const admittable = presentScanResult(d).admittable;
      const isValid = d.kind === "ticket" && d.status === "VALID";
      expect(admittable, JSON.stringify(d)).toBe(isValid);
    }
  });

  it("wrong_event is REDIRECT, not STOP", () => {
    // Splitting it from already-scanned in colour matches FR-002 splitting it
    // in haptics: today they shared a tone AND a buzz, so in the dark they
    // were the same event.
    expect(presentScanResult({ kind: "wrong_event" }).tone).toBe("redirect");
    expect(presentScanResult({ kind: "ticket", status: "SCANNED" }).tone).toBe(
      "alreadyIn",
    );
  });

  it("an offline volunteer pass is REDIRECT, never STOP", () => {
    // A volunteer JWT offline carries ZERO information about the person; it is
    // our capability gap, not their problem. Painting it red trains the
    // operator to distrust volunteers for a reason that is entirely ours.
    const p = presentScanResult({ kind: "volunteer_needs_connection" });
    expect(p.tone).toBe("redirect");
    expect(p.verdict).toBe("NEEDS SIGNAL");
  });

  it("falls closed on a status the build does not recognise", () => {
    const p = presentScanResult({ kind: "ticket", status: "TELEPORTED" });
    expect(p.tone).toBe("stop");
    expect(p.admittable).toBe(false);
    expect(p.verdict).not.toBe("INVALID");
  });
});

describe("presentScanResult — redundancy contract (NFR-002)", () => {
  it("state 11 (can't verify offline) is NOT state 6 (INVALID)", () => {
    const invalid = presentScanResult({ kind: "ticket", status: "INVALID" });
    const cantVerify = presentScanResult({
      kind: "offline_unverifiable",
      reason: "not_in_manifest",
    });
    // Same family (both red — a code absent from a synced manifest is more
    // likely bad than good, and the operator should hesitate). But three of
    // the five channels MUST differ, because a cache miss is not evidence of
    // forgery and the state must never CLAIM invalidity.
    expect(cantVerify.tone).toBe(invalid.tone);
    expect(cantVerify.glyph).not.toBe(invalid.glyph);
    expect(cantVerify.verdict).not.toBe(invalid.verdict);
    expect(cantVerify.badge).not.toBe(invalid.badge);
    expect(cantVerify.verdict).not.toMatch(/invalid/i);
    expect(cantVerify.badge).not.toMatch(/invalid/i);
    // The guidance DIS-claims invalidity explicitly — that clause is the
    // safety mechanism, not a softener (design §2.2 row 11).
    expect(cantVerify.guidance ?? "").toMatch(/does not mean it's invalid/i);
    // Strip the disclaimer; nothing that remains may assert invalidity.
    expect(
      (cantVerify.guidance ?? "").replace(
        /that does not mean it's invalid/i,
        "",
      ),
    ).not.toMatch(/\binvalid\b/i);
  });

  it("never lets COLOUR alone carry the outcome", () => {
    // The real invariant. Several outcomes deliberately share a presentation
    // because they are the same FACT — `offline_unverifiable/unreadable_payload`
    // and `unknown/malformed` are both "we couldn't read this QR" (the offline
    // one adds a mandatory provenance chip at render time), and the three
    // "can't verify offline" reasons differ only in their explanation. What
    // must never happen is a tone family whose members are distinguishable
    // ONLY by that tone.
    const byTone = new Map<string, Set<string>>();
    const guidanceByTone = new Map<string, Set<string>>();
    for (const d of ALL) {
      const p = presentScanResult(d);
      (byTone.get(p.tone) ?? byTone.set(p.tone, new Set()).get(p.tone)!).add(
        p.verdict,
      );
      (
        guidanceByTone.get(p.tone) ??
        guidanceByTone.set(p.tone, new Set()).get(p.tone)!
      ).add(p.guidance ?? "");
    }
    for (const [tone, guidances] of guidanceByTone) {
      if (guidances.size <= 1) continue;
      expect(
        byTone.get(tone)!.size,
        `tone "${tone}" carries ${guidances.size} distinct meanings but only ` +
          `${byTone.get(tone)!.size} verdict word(s) — colour is doing the work`,
      ).toBeGreaterThan(1);
    }
  });

  it("keeps verdict ⇄ glyph ⇄ badge a consistent mapping", () => {
    // One word must never appear with two different glyphs: the operator is
    // learning a vocabulary, and an inconsistent one is worse than a small one.
    const glyphFor = new Map<string, string>();
    const badgeFor = new Map<string, string>();
    for (const d of ALL) {
      const p = presentScanResult(d);
      const priorGlyph = glyphFor.get(p.verdict);
      if (priorGlyph) expect(priorGlyph, p.verdict).toBe(p.glyph);
      glyphFor.set(p.verdict, p.glyph);
      const priorBadge = badgeFor.get(p.verdict);
      if (priorBadge) expect(priorBadge, p.verdict).toBe(p.badge);
      badgeFor.set(p.verdict, p.badge);
    }
  });

  it("keeps every verdict word short enough to fit one line at 375pt", () => {
    for (const d of ALL) {
      const { verdict } = presentScanResult(d);
      expect(verdict.length, verdict).toBeLessThanOrEqual(MAX_VERDICT_LENGTH);
      expect(verdict, verdict).toBe(verdict.toUpperCase());
      expect(verdict, verdict).not.toMatch(/[.!?]/);
    }
  });

  it("always carries a badge — the fifth channel is never dropped", () => {
    for (const d of ALL) {
      expect(presentScanResult(d).badge.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("presentScanResult — copy", () => {
  it("uses the FR-008 shared LISTED string verbatim", () => {
    expect(
      presentScanResult({ kind: "ticket", status: "LISTED" }).guidance,
    ).toBe("Listed for resale — do not admit.");
  });

  it("gives VALID no guidance line — the ADMIT button is the copy", () => {
    expect(
      presentScanResult({ kind: "ticket", status: "VALID" }).guidance,
    ).toBe(null);
  });

  it("puts the scan time in the ALREADY IN line when it is known", () => {
    expect(
      presentScanResult({
        kind: "ticket",
        status: "SCANNED",
        scannedAtLabel: "21:14",
      }).guidance,
    ).toBe("Scanned at 21:14 — already admitted.");
  });

  it("names the selected event in the wrong-event redirect", () => {
    expect(
      presentScanResult({
        kind: "wrong_event",
        selectedEventName: "Basement Show",
      }).guidance,
    ).toContain("Basement Show");
  });
});

describe("describeScanResult", () => {
  it("carries the offline reason through untouched", () => {
    const d = describeScanResult({
      kind: "offline_unverifiable",
      reason: "lookup_failed",
      provenance: {
        source: "offline",
        manifestSyncedAt: null,
        manifestAgeMs: null,
        stale: true,
      },
    });
    expect(d).toEqual({
      kind: "offline_unverifiable",
      reason: "lookup_failed",
    });
  });

  it("prefers an APPROVED volunteer candidate over the first one", () => {
    const candidate = (status: string, roleLabel: string) => ({
      signupId: `s-${roleLabel}`,
      humanId: "h1",
      humanDisplayName: "A",
      humanContactMasked: "",
      eventId: "e1",
      eventTitle: "E",
      roleId: "r",
      roleLabel,
      shiftId: "sh",
      shiftLabel: "8–11pm",
      shiftStartAt: "",
      shiftEndAt: "",
      status: status as "APPROVED" | "CHECKED_IN" | "NO_SHOW",
      checkedInAt: null,
      checkedInByHumanId: null,
      window: "within" as const,
      scanWindowNote: "",
      alsoHoldsTicket: false,
    });
    const d = describeScanResult({
      kind: "volunteer",
      humanId: "h1",
      displayName: "A",
      candidates: [candidate("NO_SHOW", "Door"), candidate("APPROVED", "Bar")],
      alsoHoldsTicket: [],
    });
    expect(d).toMatchObject({ kind: "volunteer", roleLabel: "Bar" });
  });
});

describe("presentScanResult — the re-admit guard is VISIBLE (FR-004)", () => {
  const readmit = presentScanResult({
    kind: "ticket",
    status: "VALID",
    admittedHereRecently: true,
  });

  it("renders ALREADY IN, not the green ADMIT state", () => {
    /**
     * `planExpressMode` halts on `recently_admitted_here` — but the RESULT
     * still says `VALID` (a full manifest re-sync overwrites an optimistic
     * local SCANNED before the queue reports it), so the screen painted the
     * full-bleed green ADMIT state and the rail offered ADMIT. The guard exists
     * for one scenario — a shared or screenshotted QR presented twice inside
     * that window — and in exactly that scenario an operator trained by express
     * to read green as "walk on" saw green.
     */
    expect(readmit.tone).toBe("alreadyIn");
    expect(readmit.glyph).toBe("CheckCheck");
    expect(readmit.verdict).toBe("ALREADY IN");
    expect(readmit.badge).toBe("ADMITTED HERE");
  });

  it("is NOT admittable — which is what suppresses the rail's ADMIT", () => {
    expect(readmit.admittable).toBe(false);
  });

  it("names the DEVICE-LOCAL admit, since the status does not corroborate it", () => {
    // The operator is being told something the ticket's own status contradicts.
    // The guidance has to say where the claim comes from, or it reads as a bug.
    expect(readmit.guidance).toMatch(/this device/i);
  });

  it("differs from a server SCANNED on more than the tone", () => {
    // Same family, different badge and different guidance: "the server says
    // this was scanned" and "I admitted this here, minutes ago" are different
    // facts with different recoveries.
    const scanned = presentScanResult({
      kind: "ticket",
      status: "SCANNED",
      scannedAtLabel: "9:41 PM",
    });
    expect(readmit.badge).not.toBe(scanned.badge);
    expect(readmit.guidance).not.toBe(scanned.guidance);
  });

  it("changes NOTHING when the flag is absent or false", () => {
    const plain = presentScanResult({ kind: "ticket", status: "VALID" });
    expect(plain.tone).toBe("admit");
    expect(plain.admittable).toBe(true);
    expect(
      presentScanResult({
        kind: "ticket",
        status: "VALID",
        admittedHereRecently: false,
      }),
    ).toEqual(plain);
  });

  it("never resurrects a non-VALID status", () => {
    // The flag is only consulted on VALID: a REFUNDED ticket this device
    // happened to admit recently is still REFUNDED, and STOP outranks ALREADY
    // IN.
    for (const status of ["SCANNED", "INVALID", "REFUNDED", "LISTED", "VOID"]) {
      const p = presentScanResult({
        kind: "ticket",
        status,
        admittedHereRecently: true,
      });
      expect(p.badge, status).not.toBe("ADMITTED HERE");
      expect(p.admittable, status).toBe(false);
    }
  });

  it("survives the descriptor round trip from a real result", () => {
    const d = describeScanResult(
      {
        kind: "ticket",
        ticketId: "tk_1",
        ticketCode: "TKT-1",
        status: "VALID",
        scannedAt: null,
        holderHumanId: "hm_1",
        holderDisplay: "Sam Rivera",
        ticketTypeName: "GA",
        alsoVolunteering: [],
      },
      { admittedHereRecently: true },
    );
    expect(presentScanResult(d).verdict).toBe("ALREADY IN");
  });
});
