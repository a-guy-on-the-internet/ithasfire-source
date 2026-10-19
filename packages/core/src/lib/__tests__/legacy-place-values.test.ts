import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGACY_AUDIT_ACTIONS,
  LEGACY_OWNER_SIDE,
  LEGACY_PLACE_CONFIRMATION_KEY_KINDS,
  LEGACY_REQUEST_DIRECTION,
  LEGACY_SYSTEM_ENTRY_KINDS,
  LEGACY_THREAD_SIDE,
  PLACE_TERM_KEEP_MARKER,
  auditActionsWithLegacy,
  normalizeAuditAction,
  normalizeCancellerSide,
  normalizeLegacySystemEntry,
  normalizeOwnerSide,
  normalizeRequestDirection,
  normalizeSystemEntryKind,
  normalizeThreadSide,
} from "../legacy-place-values";

// Old spellings come from the module under test, never retyped here: the
// module is the one place they are written down.

describe("legacy-place-values — audit actions", () => {
  it("maps every old action to its new one", () => {
    for (const [next, old] of Object.entries(LEGACY_AUDIT_ACTIONS)) {
      expect(old).not.toBe(next);
      expect(normalizeAuditAction(old)).toBe(next);
      expect(normalizeAuditAction(next)).toBe(next);
    }
  });

  it("leaves an action with no old spelling alone", () => {
    expect(normalizeAuditAction("event.published")).toBe("event.published");
  });

  it("widens an exact filter to both spellings, in order, without duplicates", () => {
    expect(
      auditActionsWithLegacy([
        "event.place_confirmed_by_grant",
        "event.published",
        "event.place_confirmed_by_grant",
      ]),
    ).toEqual([
      "event.place_confirmed_by_grant",
      LEGACY_AUDIT_ACTIONS["event.place_confirmed_by_grant"],
      "event.published",
    ]);
  });
});

describe("legacy-place-values — ledger kinds", () => {
  it("maps every old kind to its new one; null stays null", () => {
    for (const [next, old] of Object.entries(LEGACY_SYSTEM_ENTRY_KINDS)) {
      expect(normalizeSystemEntryKind(old)).toBe(next);
      expect(normalizeSystemEntryKind(next)).toBe(next);
    }
    expect(normalizeSystemEntryKind(null)).toBeNull();
    expect(normalizeSystemEntryKind("booking_request.opened")).toBe(
      "booking_request.opened",
    );
  });
});

describe("legacy-place-values — systemData values", () => {
  it("normalises each place-valued param, and only the old spelling", () => {
    expect(normalizeOwnerSide(LEGACY_OWNER_SIDE)).toBe("place");
    expect(normalizeOwnerSide("place")).toBe("place");
    expect(normalizeOwnerSide("requester")).toBe("requester");
    expect(normalizeOwnerSide(null)).toBeNull();
    expect(normalizeCancellerSide(LEGACY_OWNER_SIDE)).toBe("place");
    expect(normalizeCancellerSide("sender")).toBe("sender");
    expect(normalizeThreadSide(LEGACY_THREAD_SIDE)).toBe("PLACE");
    expect(normalizeThreadSide("PERFORMER")).toBe("PERFORMER");
    expect(normalizeRequestDirection(LEGACY_REQUEST_DIRECTION)).toBe("TO_PLACE");
    expect(normalizeRequestDirection("TO_PERFORMER")).toBe("TO_PERFORMER");
  });

  it("rewrites an old ledger row's kind and params, without mutating it", () => {
    const row = {
      id: "row-1",
      systemKind: LEGACY_SYSTEM_ENTRY_KINDS["booking_event.place_confirmed"],
      systemData: { eventId: "e-1", ownerSide: LEGACY_OWNER_SIDE },
    };
    expect(normalizeLegacySystemEntry(row)).toEqual({
      id: "row-1",
      systemKind: "booking_event.place_confirmed",
      systemData: { eventId: "e-1", ownerSide: "place" },
    });
    expect(row.systemData.ownerSide).toBe(LEGACY_OWNER_SIDE);
  });

  it("normalises direction, actorSide and by", () => {
    expect(
      normalizeLegacySystemEntry({
        systemKind: "booking_request.opened",
        systemData: { direction: LEGACY_REQUEST_DIRECTION, source: "EMBED" },
      }).systemData,
    ).toEqual({ direction: "TO_PLACE", source: "EMBED" });
    expect(
      normalizeLegacySystemEntry({
        systemKind: "booking_agreement.accepted",
        systemData: { agreementId: "a-1", actorSide: LEGACY_THREAD_SIDE },
      }).systemData,
    ).toEqual({ agreementId: "a-1", actorSide: "PLACE" });
    expect(
      normalizeLegacySystemEntry({
        systemKind: "booking_request.booking_cancelled",
        systemData: { by: LEGACY_OWNER_SIDE, reason: "Storm." },
      }).systemData,
    ).toEqual({ by: "place", reason: "Storm." });
  });

  it("returns the same object for a row already in the current spelling", () => {
    const row = {
      systemKind: "booking_event.place_confirmed",
      systemData: { eventId: "e-1", ownerSide: "requester" },
    };
    expect(normalizeLegacySystemEntry(row)).toBe(row);
    const human = { systemKind: null, systemData: null, body: "hi" };
    expect(normalizeLegacySystemEntry(human)).toBe(human);
  });
});

describe("legacy-place-values — the notification key", () => {
  it("spells each intent kind the way keys claimed before the rename did", () => {
    expect(LEGACY_PLACE_CONFIRMATION_KEY_KINDS["event.place_confirmed"]).toBe(
      LEGACY_AUDIT_ACTIONS["event.place_confirmed"],
    );
    expect(
      LEGACY_PLACE_CONFIRMATION_KEY_KINDS["event.place_confirmation_withdrawn"],
    ).toBe(LEGACY_AUDIT_ACTIONS["event.place_confirmation_withdrawn"]);
  });
});

describe("legacy-place-values — the file itself", () => {
  it("carries the keep marker on every line that holds an old spelling", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../legacy-place-values.ts", import.meta.url)),
      "utf8",
    );
    const oldWord = new RegExp(LEGACY_OWNER_SIDE, "i");
    const offenders = source
      .split("\n")
      .filter(
        (line) =>
          oldWord.test(line) && !line.includes(`// ${PLACE_TERM_KEEP_MARKER}:`),
      );
    expect(offenders).toEqual([]);
  });
});
