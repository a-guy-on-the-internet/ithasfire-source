import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The IMPURE half of FR-001 — the half `offline-resolve.test.ts` cannot reach.
 *
 * `offline-resolve.ts` is pure and exhaustively tested. This module is the one
 * that touches SQLite and Sentry, and every one of its interesting behaviours
 * is a behaviour under FAILURE:
 *
 *   (a) SQLite throws → the operator must get `lookup_failed`, not a crash and
 *       not a fabricated verdict, and the throw must be CAPTURED.
 *   (b) The device is merely offline → a breadcrumb, not an exception. A venue
 *       with no signal must not manufacture one Sentry issue per scan.
 *   (c) **A throwing reporter cannot change the admission outcome.** This is
 *       the one that has to be ASSERTED rather than reasoned about: the
 *       isolation is three lines of `try/catch` in `report.ts`, it is invisible
 *       at every call site, and the failure mode if it regresses is that a
 *       mis-configured Sentry DSN turns every offline scan into a dead camera.
 *
 * `vi.mock` is what makes this runnable in node: `./local-db` imports
 * `expo-sqlite` and the reporter imports `@sentry/react-native`, neither of
 * which exists outside a native runtime.
 */

const lookupTicketByCode = vi.fn();
vi.mock("./local-db", () => ({
  lookupTicketByCode: (code: string) => lookupTicketByCode(code) as unknown,
}));

const captureException = vi.fn();
const addBreadcrumb = vi.fn();
vi.mock("@sentry/react-native", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  addBreadcrumb: (...args: unknown[]) => addBreadcrumb(...args),
}));

import { resolveScanOffline } from "./offline-scan-fallback";

const EVENT = "evt_1";
const NOW = 1_700_000_000_000;

const manifestRow = (over: Record<string, unknown> = {}) => ({
  ticketId: "tkt_1",
  code: "TKT-ABC123",
  eventId: EVENT,
  status: "VALID",
  ownerHuman: "hum_1",
  scannedAt: null,
  ticketTypeName: "General Admission",
  orderId: "ord_1",
  syncedAt: NOW - 60_000,
  ...over,
});

beforeEach(() => {
  lookupTicketByCode.mockReset();
  captureException.mockReset();
  addBreadcrumb.mockReset();
});

describe("resolveScanOffline — (a) the local store itself fails", () => {
  it("returns `lookup_failed` instead of throwing, and captures", () => {
    lookupTicketByCode.mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });

    const result = resolveScanOffline({
      raw: "TKT-ABC123",
      eventId: EVENT,
      trigger: "device_offline",
      now: NOW,
    });

    expect(result.kind).toBe("offline_unverifiable");
    expect(
      result.kind === "offline_unverifiable" ? result.reason : null,
    ).toBe("lookup_failed");
    // A SQLite failure is a real failure, so it is an EXCEPTION even though the
    // trigger (device offline) would normally be breadcrumb-only.
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(err).toBeInstanceOf(Error);
    expect(ctx.tags.branch).toBe("offline_resolve_lookup");
    expect(ctx.tags.eventId).toBe(EVENT);
  });

  it("fails CLOSED on a store failure — stale provenance, never admittable", () => {
    lookupTicketByCode.mockImplementation(() => {
      throw new Error("boom");
    });

    const result = resolveScanOffline({
      raw: "TKT-ABC123",
      eventId: EVENT,
      trigger: "device_offline",
      now: NOW,
    });

    // `stale: true` is what keeps FR-004's express gate from auto-admitting on
    // a result produced by a broken database.
    expect(result.provenance.stale).toBe(true);
    expect(result.provenance.manifestSyncedAt).toBeNull();
  });

  it("never sends the ticket code to Sentry", () => {
    lookupTicketByCode.mockImplementation(() => {
      throw new Error("boom");
    });
    resolveScanOffline({
      raw: "TKT-SECRET99",
      eventId: EVENT,
      trigger: "resolver_network_error",
      error: new TypeError("Network request failed"),
      now: NOW,
    });
    const serialized = JSON.stringify([
      ...captureException.mock.calls,
      ...addBreadcrumb.mock.calls,
    ]);
    expect(serialized).not.toContain("SECRET99");
  });
});

describe("resolveScanOffline — (b) the device is simply offline", () => {
  it("leaves a breadcrumb and captures NOTHING", () => {
    lookupTicketByCode.mockReturnValue(manifestRow());

    const result = resolveScanOffline({
      raw: "TKT-ABC123",
      eventId: EVENT,
      trigger: "device_offline",
      now: NOW,
    });

    expect(result.kind).toBe("ticket");
    expect(captureException).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    const [crumb] = addBreadcrumb.mock.calls[0] as [
      { message: string; data: Record<string, unknown> },
    ];
    expect(crumb.message).toBe("offline_resolve.device_offline");
    expect(crumb.data.eventId).toBe(EVENT);
    expect(crumb.data.resultKind).toBe("ticket");
  });

  it("captures an exception when the RESOLVER failed (an outage, not a venue)", () => {
    lookupTicketByCode.mockReturnValue(manifestRow());
    const cause = new TypeError("Network request failed");

    resolveScanOffline({
      raw: "TKT-ABC123",
      eventId: EVENT,
      trigger: "resolver_network_error",
      error: cause,
      now: NOW,
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(err).toBe(cause);
    expect(ctx.tags.branch).toBe("offline_resolve_fallback");
    expect(ctx.tags.resultKind).toBe("ticket");
  });
});

describe("resolveScanOffline — (c) reporter isolation", () => {
  /**
   * The assertion the whole file is for. If `safeReport` ever stops wrapping a
   * call, a Sentry client that throws (bad DSN, native module missing, a
   * `beforeSend` that blows up) propagates out of `resolveScanOffline` and the
   * operator's camera path dies with an error banner — while the answer sits
   * in SQLite on the device.
   */
  it("still returns the correct VALID result when the reporter throws", () => {
    lookupTicketByCode.mockReturnValue(manifestRow());
    captureException.mockImplementation(() => {
      throw new Error("Sentry is not initialized");
    });
    addBreadcrumb.mockImplementation(() => {
      throw new Error("Sentry is not initialized");
    });

    const offline = resolveScanOffline({
      raw: "TKT-ABC123",
      eventId: EVENT,
      trigger: "device_offline",
      now: NOW,
    });
    expect(offline.kind).toBe("ticket");
    expect(offline.kind === "ticket" ? offline.admittable : null).toBe(true);

    const degraded = resolveScanOffline({
      raw: "TKT-ABC123",
      eventId: EVENT,
      trigger: "resolver_network_error",
      error: new TypeError("Network request failed"),
      now: NOW,
    });
    expect(degraded.kind).toBe("ticket");
    expect(degraded.kind === "ticket" ? degraded.admittable : null).toBe(true);

    // And it really did try — this is isolation, not a missing call.
    expect(addBreadcrumb).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
  });

  it("still returns `lookup_failed` when BOTH the store and the reporter throw", () => {
    lookupTicketByCode.mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    captureException.mockImplementation(() => {
      throw new Error("Sentry is not initialized");
    });
    addBreadcrumb.mockImplementation(() => {
      throw new Error("Sentry is not initialized");
    });

    const result = resolveScanOffline({
      raw: "TKT-ABC123",
      eventId: EVENT,
      trigger: "device_offline",
      now: NOW,
    });

    expect(result.kind).toBe("offline_unverifiable");
    expect(
      result.kind === "offline_unverifiable" ? result.reason : null,
    ).toBe("lookup_failed");
  });
});

describe("resolveScanOffline — payload routing", () => {
  it("never touches the store for a volunteer JWT", () => {
    const result = resolveScanOffline({
      raw: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      eventId: EVENT,
      trigger: "device_offline",
      now: NOW,
    });
    expect(result.kind).toBe("volunteer_needs_connection");
    expect(lookupTicketByCode).not.toHaveBeenCalled();
  });
});
