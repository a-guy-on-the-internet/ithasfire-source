import { describe, expect, it } from "vitest";

import type { LocalTicket } from "./local-db";
import {
  EXPRESS_MODE_MAX_MANIFEST_AGE_MS,
  OFFLINE_UNVERIFIABLE_COPY,
  OFFLINE_VOLUNTEER_COPY,
  canExpressAdmitOffline,
  classifyOfflinePayload,
  resolveOfflineScan,
  type OfflineManifestTicket,
  type OfflineResolveResult,
} from "./offline-resolve";

// `LocalTicket` (which pulls expo-sqlite at runtime) is imported TYPE-ONLY so
// this file stays node-runnable. The assignment documents that the read shape
// local-db returns satisfies the structural type this module accepts. Note it
// is not gated in CI — `tsc` inside apps/scanner is structurally red for
// unrelated reasons (no @th/core path mappings).
const _assertRowShape: (row: LocalTicket) => OfflineManifestTicket = (row) =>
  row;
void _assertRowShape;

const EVENT_A = "11111111-1111-4111-8111-111111111111";
const EVENT_B = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-08-06T20:00:00.000Z");
const FRESH = NOW - 60_000; // 1 minute old

const row = (
  over: Partial<OfflineManifestTicket> = {},
): OfflineManifestTicket => ({
  ticketId: "tkt_1",
  code: "TKT-DOOR-0001",
  eventId: EVENT_A,
  status: "VALID",
  ownerHuman: "human_1",
  scannedAt: null,
  ticketTypeName: "GA",
  orderId: "ord_1",
  syncedAt: FRESH,
  ...over,
});

const resolve = (
  raw: string,
  ticket: OfflineManifestTicket | null,
  over: Partial<Parameters<typeof resolveOfflineScan>[0]> = {},
): OfflineResolveResult =>
  resolveOfflineScan({
    payload: classifyOfflinePayload(raw),
    ticket,
    selectedEventId: EVENT_A,
    now: NOW,
    ...over,
  });

// ── classification ──────────────────────────────────────────────────────────

describe("classifyOfflinePayload", () => {
  it("reads the structured hf:// form and keeps the embedded event id", () => {
    expect(classifyOfflinePayload(`hf://${EVENT_B}/TKT-DOOR-0001`)).toEqual({
      kind: "ticket",
      ticketCode: "TKT-DOOR-0001",
      embeddedEventId: EVENT_B,
    });
  });

  it("reads a bare code with no event context", () => {
    expect(classifyOfflinePayload("  tkt-door-0001 ")).toEqual({
      kind: "ticket",
      ticketCode: "TKT-DOOR-0001",
      embeddedEventId: null,
    });
  });

  it("detects a volunteer JWT by its three base64url segments", () => {
    // Three dot-separated base64url segments — the same shape the server uses
    // (resolve-scan-payload.ts JWT_SHAPE_PATTERN). Without this check the JWT
    // would fall through as a "ticket code" (parseTicketQrPayload accepts any
    // 6+ character string) and be reported as an unverifiable ticket.
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodW1hbklkIjoiaHVtYW5fMSJ9.c2lnbmF0dXJl-_x";
    expect(classifyOfflinePayload(jwt)).toEqual({ kind: "volunteer_jwt" });
  });

  it("does not mistake a ticket code for a JWT", () => {
    // Ticket codes never contain dots: minted `tk_<hex>`, fixtures `TKT-…`.
    for (const code of [
      "tk_0123456789abcdef01234567",
      "TKT-E2E-CONCERT-001",
      "DOORABC123",
    ]) {
      expect(classifyOfflinePayload(code).kind).toBe("ticket");
    }
  });

  it("marks empty / too-short payloads unreadable", () => {
    expect(classifyOfflinePayload("").kind).toBe("unreadable");
    expect(classifyOfflinePayload("   ").kind).toBe("unreadable");
    expect(classifyOfflinePayload("abc").kind).toBe("unreadable");
  });
});

// ── status mapping ──────────────────────────────────────────────────────────

describe("resolveOfflineScan — status mapping", () => {
  it("admits a locally-VALID ticket", () => {
    const result = resolve("TKT-DOOR-0001", row({ status: "VALID" }));
    expect(result.kind).toBe("ticket");
    if (result.kind !== "ticket") throw new Error("unreachable");
    expect(result.status).toBe("VALID");
    expect(result.admittable).toBe(true);
    expect(result.ticketCode).toBe("TKT-DOOR-0001");
    expect(result.ticketTypeName).toBe("GA");
    expect(result.holderHumanId).toBe("human_1");
    expect(result.alsoVolunteering).toEqual([]);
    expect(result.provenance.source).toBe("offline");
  });

  it("returns already-scanned with the local scannedAt", () => {
    const scannedAt = "2026-08-06T19:45:00.000Z";
    const result = resolve(
      "TKT-DOOR-0001",
      row({ status: "SCANNED", scannedAt }),
    );
    if (result.kind !== "ticket") throw new Error("unreachable");
    expect(result.status).toBe("SCANNED");
    expect(result.admittable).toBe(false);
    expect(result.scannedAt?.toISOString()).toBe(scannedAt);
  });

  it("tolerates an unparseable scannedAt without losing the result", () => {
    const result = resolve(
      "TKT-DOOR-0001",
      row({ status: "SCANNED", scannedAt: "not-a-date" }),
    );
    if (result.kind !== "ticket") throw new Error("unreachable");
    expect(result.scannedAt).toBeNull();
  });

  it.each(["INVALID", "REFUNDED", "LISTED", "VOID"] as const)(
    "renders %s but never admits it",
    (status) => {
      const result = resolve("TKT-DOOR-0001", row({ status }));
      expect(result.kind).toBe("ticket");
      if (result.kind !== "ticket") throw new Error("unreachable");
      expect(result.status).toBe(status);
      expect(result.admittable).toBe(false);
    },
  );

  it("never synthesizes VALID from an unrecognised status", () => {
    const result = resolve("TKT-DOOR-0001", row({ status: "TRANSFERRED" }));
    expect(result.kind).toBe("offline_unverifiable");
    if (result.kind !== "offline_unverifiable") throw new Error("unreachable");
    expect(result.reason).toBe("unrecognized_status");
  });

  it("falls back to 'Unknown' for the holder when none was resolved", () => {
    const result = resolve("TKT-DOOR-0001", row());
    if (result.kind !== "ticket") throw new Error("unreachable");
    expect(result.holderDisplay).toBe("Unknown");

    const named = resolve("TKT-DOOR-0001", row(), {
      holderDisplay: "Jenny R.",
    });
    if (named.kind !== "ticket") throw new Error("unreachable");
    expect(named.holderDisplay).toBe("Jenny R.");
  });
});

// ── the single most important rule ──────────────────────────────────────────

describe("resolveOfflineScan — absence is unknown, not invalid", () => {
  it("returns can't-verify-offline for a code absent from the manifest", () => {
    const result = resolve("TKT-NOT-SYNCED-9", null);
    expect(result.kind).toBe("offline_unverifiable");
    if (result.kind !== "offline_unverifiable") throw new Error("unreachable");
    expect(result.reason).toBe("not_in_manifest");
  });

  it("does NOT claim the ticket is invalid, void, or not found", () => {
    const result = resolve("TKT-NOT-SYNCED-9", null);
    if (result.kind !== "offline_unverifiable") throw new Error("unreachable");
    const copy = OFFLINE_UNVERIFIABLE_COPY[result.reason];
    // The exact failure this rule exists to prevent: telling an operator a
    // real ticket is fake because the device hadn't synced it yet.
    expect(copy.label).toBe("Can't verify offline");
    // The copy must DIS-claim invalidity out loud (design §2.2 row 11): that
    // sentence is the safety mechanism for a red full-screen state on a
    // possibly-valid ticket.
    expect(copy.guidance).toMatch(/does not mean it's invalid/i);
    // …and nothing outside that clause may ASSERT it. Strip the disclaimer,
    // then apply the original guard to what remains.
    const claim = `${copy.label} ${copy.guidance}`.replace(
      /that does not mean it's invalid/i,
      "",
    );
    expect(claim).not.toMatch(
      /invalid|void|refund|forged|fake|no ticket matches/i,
    );
    // And it is definitely not a ticket result with a status.
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("admittable");
  });

  it("returns not-in-manifest when the row's code doesn't match the scan", () => {
    // Defence in depth against a caller handing over the wrong row.
    const result = resolve("TKT-DOOR-0001", row({ code: "TKT-OTHER-0002" }));
    expect(result.kind).toBe("offline_unverifiable");
    if (result.kind !== "offline_unverifiable") throw new Error("unreachable");
    expect(result.reason).toBe("not_in_manifest");
  });

  it("matches a lowercase minted code against an upper-cased scan", () => {
    // `tk_<24 hex>` codes are lowercase; the QR parser upper-cases. The row
    // returned by the NOCASE lookup must still resolve.
    const code = "tk_0123456789abcdef01234567";
    const result = resolve(code, row({ code }));
    expect(result.kind).toBe("ticket");
    if (result.kind !== "ticket") throw new Error("unreachable");
    expect(result.ticketCode).toBe(code);
    expect(result.admittable).toBe(true);
  });

  it("marks an unreadable payload unreadable, not invalid", () => {
    const result = resolve("abc", null);
    expect(result.kind).toBe("offline_unverifiable");
    if (result.kind !== "offline_unverifiable") throw new Error("unreachable");
    expect(result.reason).toBe("unreadable_payload");
  });
});

// ── event scoping ───────────────────────────────────────────────────────────

describe("resolveOfflineScan — event mismatch", () => {
  it("rejects an hf:// payload whose embedded event is a different show", () => {
    const result = resolve(`hf://${EVENT_B}/TKT-DOOR-0001`, row());
    expect(result.kind).toBe("wrong_event");
    if (result.kind !== "wrong_event") throw new Error("unreachable");
    expect(result.scannedEventId).toBe(EVENT_B);
    expect(result.payloadKind).toBe("ticket");
  });

  it("rejects a BARE code whose manifest row belongs to another event", () => {
    // The bug this guards: lookupTicketByCode is NOT event-scoped, and a bare
    // typed code carries no event id, so without this check a ticket for
    // tomorrow's show admits at tonight's door.
    const result = resolve("TKT-DOOR-0001", row({ eventId: EVENT_B }));
    expect(result.kind).toBe("wrong_event");
    if (result.kind !== "wrong_event") throw new Error("unreachable");
    expect(result.scannedEventId).toBe(EVENT_B);
  });

  it("rejects on the row's event even when the QR claims the right one", () => {
    // Attacker-supplied embedded id says "this event"; the row disagrees.
    const result = resolve(
      `hf://${EVENT_A}/TKT-DOOR-0001`,
      row({ eventId: EVENT_B }),
    );
    expect(result.kind).toBe("wrong_event");
  });

  it("compares event ids case-insensitively", () => {
    const result = resolve(
      `hf://${EVENT_A.toUpperCase()}/TKT-DOOR-0001`,
      row({ eventId: EVENT_A }),
    );
    expect(result.kind).toBe("ticket");
  });

  it("does not need the manifest at all to reject a wrong-event QR", () => {
    const result = resolve(`hf://${EVENT_B}/TKT-DOOR-0001`, null);
    expect(result.kind).toBe("wrong_event");
  });
});

// ── volunteer ───────────────────────────────────────────────────────────────

describe("resolveOfflineScan — volunteer passes", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzaWdudXBJZCI6InN1XzEiLCJldmVudElkIjoiZSJ9.AbCd-_09";

  it("returns the needs-a-connection state, not the generic error", () => {
    const result = resolve(jwt, null);
    expect(result.kind).toBe("volunteer_needs_connection");
    expect(OFFLINE_VOLUNTEER_COPY.guidance).toBe(
      "Volunteer passes are verified on the server. Reconnect, or find them with Search.",
    );
    // "Search" is the rail button one tap below this state. "Lookup" is a
    // different screen, reachable only from Home — sending a door operator
    // two navigations away for an answer that is one tap down.
    expect(OFFLINE_VOLUNTEER_COPY.guidance).not.toMatch(/lookup/i);
  });

  it("never verifies a signature locally — no manifest row is consulted", () => {
    // Even with a ticket row present, a JWT resolves to the volunteer state:
    // signature verification is server-side only (NFR-005).
    const result = resolve(jwt, row({ status: "VALID" }));
    expect(result.kind).toBe("volunteer_needs_connection");
    expect(result).not.toHaveProperty("admittable");
  });
});

// ── provenance / manifest age ───────────────────────────────────────────────

describe("resolveOfflineScan — provenance", () => {
  it("tags every outcome as offline", () => {
    const results = [
      resolve("TKT-DOOR-0001", row()),
      resolve("TKT-DOOR-0001", row({ eventId: EVENT_B })),
      resolve("TKT-MISSING-01", null),
      resolve("a.b.c", null),
    ];
    for (const result of results) {
      expect(result.provenance.source).toBe("offline");
    }
  });

  it("computes the manifest age from the row's syncedAt", () => {
    const result = resolve("TKT-DOOR-0001", row({ syncedAt: NOW - 90_000 }));
    expect(result.provenance.manifestSyncedAt).toBe(NOW - 90_000);
    expect(result.provenance.manifestAgeMs).toBe(90_000);
    expect(result.provenance.stale).toBe(false);
  });

  it("prefers an explicitly-supplied manifest timestamp over the row", () => {
    const result = resolve("TKT-DOOR-0001", row({ syncedAt: NOW - 90_000 }), {
      manifestSyncedAt: NOW - 5_000,
    });
    expect(result.provenance.manifestAgeMs).toBe(5_000);
  });

  it("marks a manifest older than 10 minutes stale", () => {
    const stale = resolve(
      "TKT-DOOR-0001",
      row({ syncedAt: NOW - (EXPRESS_MODE_MAX_MANIFEST_AGE_MS + 1_000) }),
    );
    expect(stale.provenance.stale).toBe(true);
    // Still resolvable and still manually admittable — only AUTO-admit is
    // refused (FR-004); the operator can confirm by hand.
    expect(stale.kind).toBe("ticket");
    if (stale.kind !== "ticket") throw new Error("unreachable");
    expect(stale.admittable).toBe(true);
    expect(canExpressAdmitOffline(stale)).toBe(false);
  });

  it("allows express auto-admit only for a fresh VALID ticket", () => {
    expect(canExpressAdmitOffline(resolve("TKT-DOOR-0001", row()))).toBe(true);
    expect(
      canExpressAdmitOffline(
        resolve("TKT-DOOR-0001", row({ status: "SCANNED" })),
      ),
    ).toBe(false);
    expect(canExpressAdmitOffline(resolve("TKT-MISSING-01", null))).toBe(false);
  });

  it("treats an unknown manifest age as stale (fails closed)", () => {
    const result = resolve("TKT-MISSING-01", null);
    expect(result.provenance.manifestSyncedAt).toBeNull();
    expect(result.provenance.manifestAgeMs).toBeNull();
    expect(result.provenance.stale).toBe(true);
  });

  it("treats a BACKWARDS device clock as unknown age, not as maximally fresh", () => {
    /**
     * This shipped as `Math.max(0, now - syncedAt)` with a comment saying it
     * stopped a backwards clock reporting an impossibly fresh age. Clamping to
     * 0 *is* maximally fresh: `stale: false` ⇒ `canExpressAdmitOffline` true ⇒
     * express auto-admits off an arbitrarily old manifest with no gesture from
     * anyone, while the provenance chip reads `OFFLINE · JUST SYNCED` so the
     * operator's second safeguard also reads clean.
     *
     * `synced_at` comes from the LOCAL clock, so `now < syncedAt` is never
     * routine skew — the clock moved. We can make no trustworthy claim about
     * this manifest's age, so it fails closed like every other bad input.
     */
    const result = resolve("TKT-DOOR-0001", row({ syncedAt: NOW + 60_000 }));
    expect(result.provenance.manifestAgeMs).toBeNull();
    expect(result.provenance.manifestSyncedAt).toBeNull();
    expect(result.provenance.stale).toBe(true);
    expect(canExpressAdmitOffline(result)).toBe(false);
  });

  it("treats even a one-millisecond backwards clock as unknown", () => {
    // No tolerance band: the timestamp is written by the same clock that is
    // being compared against, so any inversion at all is a clock change.
    const result = resolve("TKT-DOOR-0001", row({ syncedAt: NOW + 1 }));
    expect(result.provenance.manifestAgeMs).toBeNull();
    expect(result.provenance.stale).toBe(true);
  });

  it("still reports age 0 for a manifest synced this instant", () => {
    // The boundary the clock check must not swallow: `now === syncedAt`.
    const result = resolve("TKT-DOOR-0001", row({ syncedAt: NOW }));
    expect(result.provenance.manifestAgeMs).toBe(0);
    expect(result.provenance.stale).toBe(false);
    expect(canExpressAdmitOffline(result)).toBe(true);
  });

  it("treats a non-finite syncedAt as unknown", () => {
    const result = resolve("TKT-DOOR-0001", row({ syncedAt: Number.NaN }));
    expect(result.provenance.manifestAgeMs).toBeNull();
    expect(result.provenance.stale).toBe(true);
  });
});

// ── copy ────────────────────────────────────────────────────────────────────

describe("offline copy", () => {
  it("gives every unverifiable reason a tone, label and guidance", () => {
    for (const [reason, copy] of Object.entries(OFFLINE_UNVERIFIABLE_COPY)) {
      expect(copy.tone).toBe("danger");
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.guidance.length).toBeGreaterThan(0);
      expect(copy.labelKey).toContain(".");
      expect(copy.guidanceKey).toContain(".");
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("never tells the operator to admit on an unverifiable result", () => {
    for (const copy of Object.values(OFFLINE_UNVERIFIABLE_COPY)) {
      expect(copy.guidance).not.toMatch(/\badmit\b/i);
    }
  });
});
