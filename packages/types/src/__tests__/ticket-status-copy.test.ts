import { describe, expect, it } from "vitest";

import {
  SCAN_UNKNOWN_COPY,
  SCAN_UNKNOWN_REASONS,
  TICKET_SCAN_STATUSES,
  TICKET_STATUS_COPY,
  UNKNOWN_TICKET_STATUS_COPY,
  isScanUnknownReason,
  isTicketScanStatus,
  resolveScanUnknownCopy,
  resolveTicketStatusCopy,
  type ScanStatusTone,
} from "../scan/ticket-status-copy";

const TONES: ScanStatusTone[] = ["success", "warning", "danger", "neutral"];

describe("ticket status copy", () => {
  it("covers all six ticket statuses", () => {
    expect(TICKET_SCAN_STATUSES).toEqual([
      "VALID",
      "SCANNED",
      "INVALID",
      "REFUNDED",
      "LISTED",
      "VOID",
    ]);
    expect(Object.keys(TICKET_STATUS_COPY).sort()).toEqual(
      [...TICKET_SCAN_STATUSES].sort(),
    );
  });

  it.each(TICKET_SCAN_STATUSES)(
    "resolves %s to a label, tone and guidance",
    (status) => {
      const copy = resolveTicketStatusCopy(status);
      expect(copy.status).toBe(status);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.guidance.length).toBeGreaterThan(0);
      expect(TONES).toContain(copy.tone);
      expect(copy.labelKey.startsWith("scan.status.")).toBe(true);
      expect(copy.guidanceKey.startsWith("scan.status.")).toBe(true);
    },
  );

  it("matches the full copy table (snapshot of operator-visible strings)", () => {
    const table = TICKET_SCAN_STATUSES.map((status) => {
      const c = TICKET_STATUS_COPY[status];
      return [status, c.label, c.tone, c.guidance, c.admittable];
    });
    expect(table).toEqual([
      ["VALID", "Valid", "success", "Valid ticket — admit.", true],
      [
        "SCANNED",
        "Already scanned",
        "warning",
        "Already scanned — check with the operator before re-admitting.",
        false,
      ],
      ["INVALID", "Invalid", "danger", "Invalid ticket — do not admit.", false],
      ["REFUNDED", "Refunded", "danger", "Refunded — do not admit.", false],
      [
        "LISTED",
        "Listed for resale",
        "danger",
        "Listed for resale — do not admit.",
        false,
      ],
      ["VOID", "Voided", "danger", "Voided — do not admit.", false],
    ]);
  });

  it("admits on VALID and nothing else", () => {
    const admittable = TICKET_SCAN_STATUSES.filter(
      (s) => TICKET_STATUS_COPY[s].admittable,
    );
    expect(admittable).toEqual(["VALID"]);
    expect(UNKNOWN_TICKET_STATUS_COPY.admittable).toBe(false);
  });

  it("never labels INVALID as 'Voided' (the web's drift bug)", () => {
    expect(TICKET_STATUS_COPY.INVALID.label).not.toMatch(/void/i);
    expect(TICKET_STATUS_COPY.INVALID.guidance).not.toMatch(/void/i);
    expect(TICKET_STATUS_COPY.VOID.label).toBe("Voided");
  });

  it("uses the FR-008 LISTED guidance verbatim", () => {
    expect(TICKET_STATUS_COPY.LISTED.guidance).toBe(
      "Listed for resale — do not admit.",
    );
  });

  it("gives every non-VALID status a do-not-admit style guidance", () => {
    for (const status of TICKET_SCAN_STATUSES) {
      if (status === "VALID") continue;
      const copy = TICKET_STATUS_COPY[status];
      expect(copy.tone === "danger" || copy.tone === "warning").toBe(true);
    }
  });

  it("uses unique message keys across every entry", () => {
    const keys = [
      ...TICKET_SCAN_STATUSES.flatMap((s) => [
        TICKET_STATUS_COPY[s].labelKey,
        TICKET_STATUS_COPY[s].guidanceKey,
      ]),
      UNKNOWN_TICKET_STATUS_COPY.labelKey,
      UNKNOWN_TICKET_STATUS_COPY.guidanceKey,
      ...SCAN_UNKNOWN_REASONS.flatMap((r) => [
        SCAN_UNKNOWN_COPY[r].labelKey,
        SCAN_UNKNOWN_COPY[r].guidanceKey,
      ]),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fails closed on an unrecognised status", () => {
    for (const bogus of [
      "",
      "PENDING",
      "valid",
      null,
      undefined,
      "TRANSFERRED",
    ]) {
      const copy = resolveTicketStatusCopy(bogus);
      expect(copy).toBe(UNKNOWN_TICKET_STATUS_COPY);
      expect(copy.admittable).toBe(false);
      expect(copy.tone).toBe("danger");
    }
  });

  it("guards status strings", () => {
    expect(isTicketScanStatus("VALID")).toBe(true);
    expect(isTicketScanStatus("valid")).toBe(false);
    expect(isTicketScanStatus(7)).toBe(false);
  });
});

describe("unknown-reason copy", () => {
  it("covers all three reasons", () => {
    expect(Object.keys(SCAN_UNKNOWN_COPY).sort()).toEqual(
      [...SCAN_UNKNOWN_REASONS].sort(),
    );
  });

  it.each(SCAN_UNKNOWN_REASONS)(
    "resolves %s to a label, tone and guidance",
    (reason) => {
      const copy = resolveScanUnknownCopy(reason);
      expect(copy.reason).toBe(reason);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.guidance.length).toBeGreaterThan(0);
      expect(TONES).toContain(copy.tone);
    },
  );

  it("preserves the exact strings both surfaces render today", () => {
    expect(SCAN_UNKNOWN_COPY.malformed.guidance).toBe(
      "Couldn't read this QR code. Try again or use Manual Search.",
    );
    expect(SCAN_UNKNOWN_COPY.ticket_not_found.guidance).toBe(
      "No ticket matches this code for this event.",
    );
    expect(SCAN_UNKNOWN_COPY.signature_failed.guidance).toBe(
      "This volunteer pass is invalid or has been tampered with.",
    );
  });

  it("falls back to malformed for an unrecognised reason", () => {
    expect(resolveScanUnknownCopy("nope")).toBe(SCAN_UNKNOWN_COPY.malformed);
    expect(resolveScanUnknownCopy(null)).toBe(SCAN_UNKNOWN_COPY.malformed);
    expect(isScanUnknownReason("malformed")).toBe(true);
    expect(isScanUnknownReason("MALFORMED")).toBe(false);
  });
});
