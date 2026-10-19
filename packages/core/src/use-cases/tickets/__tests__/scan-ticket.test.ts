import { beforeEach, describe, expect, it, vi } from "vitest";

import { scanTicket } from "../scan-ticket";
import type { ScanTicketDeps } from "../scan-ticket";
import type { AuthZPort } from "@th/ports/authz";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import { generateTicketCode } from "../../../lib/tickets/generate-ticket-code";

const ACTOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLIENT_KEY = "scan-key-12345678";

const DEFAULT_EVENT: EventRecord = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  humanId: null,
  title: "Sample Event",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2024-05-01T18:00:00Z"),
  endsAt: new Date("2024-05-01T22:00:00Z"),
  placeId: "place-123",
  savedLocationId: null,
  addressText: "123 Event Way",
  lat: 37.7749,
  lng: -122.4194,
  publishedAt: new Date("2024-04-15T12:00:00Z"),
  categoryId: "category-rock",
  agreementPrimaryId: "agreement-primary",
  agreementResaleId: null,
  slug: "sample-event",
  shortId: null,
  regionCode: null,
  defaultLocale: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
};

type TestContext = ReturnType<typeof makeDeps>;

describe("scanTicket", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeDeps();
    ctx.mocks.eventsGetById.mockResolvedValue({ ...DEFAULT_EVENT });
    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: ACTOR_ID,
      role: "SCANNER" as OrgRole,
    });
  });

  it("accepts the first valid scan", async () => {
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      location: { lat: 37.7749, lng: -122.4194 },
      note: "Main entrance",
      clientKey: CLIENT_KEY,
    });

    expect(result).toEqual({
      outcome: "ACCEPTED",
      ticketId: ticket.id,
      eventId: ticket.eventId,
      ownerHumanId: ticket.ownerHumanId,
      scannedAt: ctx.clockNow,
    });

    expect(ctx.mocks.ticketsMarkScanned).toHaveBeenCalledWith(
      ticket.code,
      ctx.clockNow,
    );
    expect(ctx.mocks.ticketsRecordScan).toHaveBeenCalledTimes(1);
    const payload = ctx.mocks.ticketsRecordScan.mock.calls[0][0];
    expect(payload).toMatchObject({
      ticketId: ticket.id,
      eventId: ticket.eventId,
      actorHumanId: ACTOR_ID,
      outcome: "ACCEPTED",
      message: "Main entrance",
      locationLat: 37.7749,
      locationLng: -122.4194,
    });
    expect("deviceId" in payload).toBe(false);

    expect(ctx.mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket",
        entityId: ticket.id,
        action: "scan.accepted",
      }),
    );

    expect(ctx.mocks.metricsIncrement).toHaveBeenCalledWith(
      "ticket.scan",
      expect.objectContaining({ eventId: ticket.eventId, outcome: "ACCEPTED" }),
    );
    expect(ctx.mocks.metricsRecord).toHaveBeenCalledWith(
      "ticket.scan.duration_ms",
      expect.any(Number),
      expect.objectContaining({ eventId: ticket.eventId, outcome: "ACCEPTED" }),
    );
  });

  it("burns the ticket even when the audit write fails", async () => {
    // REGRESSION: the audit write used to run INSIDE the scan's transaction, as
    // the last statement, swallowing its own failure. Postgres aborts a
    // transaction on any failed statement and answers the following COMMIT with
    // ROLLBACK and NO error, so `markScanned` was discarded while the scan still
    // returned ACCEPTED — the scanner showed green and the same QR admitted
    // again. Reproduced against a real Postgres before this fix.
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });
    ctx.mocks.auditLog.mockRejectedValueOnce(new Error("22P05"));

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
    });

    // The scan still succeeds — an audit hiccup must not deny entry at a door.
    expect(result.outcome).toBe("ACCEPTED");
    expect(ctx.mocks.ticketsMarkScanned).toHaveBeenCalledTimes(1);
    // The failure has to reach Sentry, not just a log line — a deliberate
    // swallow rides ReporterPort per the project error convention. Without this
    // assertion, deleting the transport's `reportError` wiring leaves typecheck
    // and every test green while silently un-Sentrying the door path.
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "scanTicket", stage: "record_scan_audit" },
      extra: {
        eventId: DEFAULT_EVENT.id,
        ticketId: ticket.id,
        outcome: "ACCEPTED",
      },
    });

    // NOTE: this pins the JS contract only. These fakes model no transaction
    // (`tx` runs its callback inline), so nothing here can prove the burn
    // SURVIVES an audit failure — under a real Postgres it would not have, which
    // is the whole bug. The ordering test below is the structural gate; the
    // durability claim rests on the scratch-database reproduction.
  });

  it("survives a reporter that throws", async () => {
    // The guard around `reportError` exists so a Sentry outage cannot turn a
    // swallowed audit failure into a denied scan. Nothing executed it before.
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });
    ctx.mocks.auditLog.mockRejectedValueOnce(new Error("22P05"));
    ctx.mocks.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
    });

    expect(result.outcome).toBe("ACCEPTED");
  });

  it("strips lone surrogates, which jsonb rejects even after control chars go", async () => {
    // A second trigger the control-character range does not cover: an unpaired
    // surrogate is emitted literally by JSON.stringify and rejected by
    // Postgres's JSON parser. A valid pair (an emoji) must survive.
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      note: "gate \ud800 A \u{1F600}",
    });

    const audited = ctx.mocks.auditLog.mock.calls[0][0];
    expect(audited.data.reason).toBe("gate  A \u{1F600}");
  });

  it("writes the audit row only after the transaction has committed", async () => {
    // Pins the ORDER, which is the whole fix: while the audit write sat inside
    // the transaction, its failure could condemn everything before it. `tx` is
    // the last thing to resolve, so the audit call must come after it.
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
    });

    const commitOrder = ctx.mocks.txCommitted.mock.invocationCallOrder[0];
    const auditOrder = ctx.mocks.auditLog.mock.invocationCallOrder[0];
    expect(commitOrder).toBeGreaterThan(0);
    // The audit row is written strictly AFTER the transaction resolved. Moving
    // it back inside the callback fails here — verified by doing exactly that.
    expect(auditOrder).toBeGreaterThan(commitOrder);
  });

  it("strips control characters from note before they reach jsonb", async () => {
    // A NUL in `note` reached the audit row's jsonb column, which Postgres
    // rejects (22P05) — which used to abort the scan's transaction. `note` is
    // free text so it cannot take `ticketCode`'s allowlist; controls are stripped
    // instead. `trim()` alone does NOT remove NUL.
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      note: "Main\u0000 entrance",
    });

    expect(result.outcome).toBe("ACCEPTED");
    const audited = ctx.mocks.auditLog.mock.calls[0][0];
    expect(JSON.stringify(audited)).not.toContain("\u0000");
    expect(audited.data.reason).toBe("Main entrance");
  });

  it("returns replay when the ticket was already scanned", async () => {
    const scannedAt = new Date("2024-05-01T19:00:00Z");
    const ticket = sampleTicket({ status: "SCANNED", scannedAt });
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      clientKey: CLIENT_KEY,
    });

    expect(result).toEqual({
      outcome: "REPLAY",
      ticketId: ticket.id,
      eventId: ticket.eventId,
      ownerHumanId: ticket.ownerHumanId,
      scannedAt,
      previousScannedAt: scannedAt,
    });

    expect(ctx.mocks.ticketsMarkScanned).not.toHaveBeenCalled();
    const payload = ctx.mocks.ticketsRecordScan.mock.calls[0][0];
    expect(payload).toMatchObject({
      outcome: "REPLAY",
      message: "already_scanned",
    });
  });

  it("accepts within the 60-min early-arrival grace window", async () => {
    // clockNow = 2024-05-01T18:00:00Z, event default startsAt = same.
    // Push event start 30 min ahead so we're inside the early grace.
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...DEFAULT_EVENT,
      startsAt: new Date("2024-05-01T18:30:00Z"),
      endsAt: new Date("2024-05-01T22:00:00Z"),
    });
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      clientKey: CLIENT_KEY,
    });

    expect(result.outcome).toBe("ACCEPTED");
  });

  it("rejects beyond the 60-min early-arrival grace window", async () => {
    // Push event start 90 min ahead — past the 60-min grace.
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...DEFAULT_EVENT,
      startsAt: new Date("2024-05-01T19:30:00Z"),
      endsAt: new Date("2024-05-01T22:00:00Z"),
    });
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      clientKey: CLIENT_KEY,
    });

    expect(result.outcome).toBe("REJECTED");
  });

  it("rejects when the ticket is not valid for entry", async () => {
    const ticket = sampleTicket({ status: "REFUNDED" });
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      clientKey: CLIENT_KEY,
    });

    expect(result).toEqual({ outcome: "REJECTED", reason: "ticket_not_valid" });
    const payload = ctx.mocks.ticketsRecordScan.mock.calls[0][0];
    expect(payload).toMatchObject({
      outcome: "REJECTED",
      message: "ticket_not_valid",
    });
  });

  it("rejects when the ticket belongs to another event", async () => {
    const ticket = sampleTicket({
      eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      clientKey: CLIENT_KEY,
    });

    expect(result).toEqual({ outcome: "REJECTED", reason: "event_mismatch" });
    const payload = ctx.mocks.ticketsRecordScan.mock.calls[0][0];
    expect(payload).toMatchObject({
      outcome: "REJECTED",
      message: "event_mismatch",
    });
  });

  it("throws when actor lacks permissions", async () => {
    ctx.mocks.authzGetOrgMembership.mockResolvedValue(null);

    await expect(
      scanTicket(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: DEFAULT_EVENT.id,
        ticketCode: "TK123456",
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("replays without second repo calls when idempotency key is reused", async () => {
    const ticket = sampleTicket();
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    const input = {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: ticket.code,
      clientKey: CLIENT_KEY,
    } as const;

    const first = await scanTicket(ctx.deps, input);
    expect(first.outcome).toBe("ACCEPTED");

    const markCalls = ctx.mocks.ticketsMarkScanned.mock.calls.length;
    const recordCalls = ctx.mocks.ticketsRecordScan.mock.calls.length;
    const lookupCalls = ctx.mocks.ticketsGetByCode.mock.calls.length;

    const replay = await scanTicket(ctx.deps, input);
    expect(replay).toEqual(first);
    expect(ctx.mocks.ticketsMarkScanned.mock.calls.length).toBe(markCalls);
    expect(ctx.mocks.ticketsRecordScan.mock.calls.length).toBe(recordCalls);
    expect(ctx.mocks.ticketsGetByCode.mock.calls.length).toBe(lookupCalls);
  });
});

function sampleTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  const base: TicketRecord = {
    id: "44444444-4444-4444-8444-444444444444",
    eventId: DEFAULT_EVENT.id,
    ticketTypeId: null,
    ownerHumanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    orderId: "order-1111-2222-3333",
    orderItemId: null,
    seatId: null,
    code: "TK123456",
    status: "VALID",
    issuedAt: new Date("2024-04-02T12:00:00Z"),
    scannedAt: null,
  };

  return {
    ...base,
    ...overrides,
  };
}

function makeDeps() {
  const clockNow = new Date("2024-05-01T18:00:00Z");

  const ticketsGetByCode = vi.fn();
  const ticketsMarkScanned = vi.fn();
  const ticketsRecordScan = vi.fn();
  const auditLog = vi.fn();
  const eventsGetById = vi.fn();
  const authzGetOrgMembership = vi.fn();
  const metricsIncrement = vi.fn();
  const metricsRecord = vi.fn();

  const idempotencyStore = new Map<string, unknown>();
  const idempotencyLocks = new Set<string>();

  async function begin(key: string, _ttlSec?: number): Promise<boolean> {
    if (idempotencyLocks.has(key)) return false;
    idempotencyLocks.add(key);
    return true;
  }

  async function commit<T>(
    key: string,
    value: T,
    _keepSec?: number,
  ): Promise<void> {
    idempotencyStore.set(key, value);
    idempotencyLocks.delete(key);
  }

  async function fail(
    key: string,
    _error?: string,
    _keepSec?: number,
  ): Promise<void> {
    idempotencyLocks.delete(key);
  }

  async function get<T>(key: string): Promise<T | null> {
    if (!idempotencyStore.has(key)) {
      return null;
    }
    return idempotencyStore.get(key) as T;
  }

  async function run<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>,
    keepSec?: number,
  ): Promise<{ fresh: boolean; result: T }> {
    if (!(await begin(key, ttlSec))) {
      const cached = await get<T>(key);
      if (cached !== null) {
        return { fresh: false, result: cached };
      }
    }
    const result = await fn();
    await commit(key, result, keepSec);
    return { fresh: true, result };
  }

  const idempotency: IdempotencyPort = {
    begin,
    commit,
    fail,
    get,
    run,
    purgeExpired: async () => 0,
  };

  const scopedLogger: LoggerPort = {
    child: vi.fn(),
    withTime: vi.fn(async (_name, runner) => runner()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const loggerChild = vi.fn(() => scopedLogger);
  const logger: LoggerPort = {
    child: loggerChild,
    withTime: scopedLogger.withTime,
    log: scopedLogger.log,
    info: scopedLogger.info,
    warn: scopedLogger.warn,
    error: scopedLogger.error,
  };

  const tx = {
    events: { getById: eventsGetById },
    authz: { getOrgMembership: authzGetOrgMembership },
    audit: { log: auditLog },
    tickets: {
      getByCode: ticketsGetByCode,
      markScanned: ticketsMarkScanned,
      recordScan: ticketsRecordScan,
      setStatus: vi.fn(),
      create: vi.fn(),
      findBySeatIds: vi.fn(),
      countForOrderTicketType: vi.fn(),
      countIssuedForTicketType: vi.fn(),
      countIssuedForEvent: vi.fn(),
      transfer: vi.fn(),
      findTicketTypeByName: vi.fn(),
      createTicketType: vi.fn(),
    },
  } as unknown as TxRepos;

  // Mirrors the real bag: `TxRepos = Omit<Repos, "tx">`, so the non-transactional
  // surface carries the SAME repos as the transactional one. The previous shape
  // (`{ tx }` alone) had no non-tx surface at all, so anything the use case does
  // AFTER its transaction commits hit `undefined` and was eaten by its own catch.
  // `txCommitted` fires when the transaction callback RESOLVES. Without it no
  // test in this file can tell a write inside the transaction from one after it
  // — the fake runs the callback inline, so both orderings look identical.
  const txCommitted = vi.fn();
  const repos = {
    ...(tx as unknown as Record<string, unknown>),
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => {
      const result = await fn(tx);
      txCommitted();
      return result;
    },
  } as unknown as Repos;

  const reportError = vi.fn();
  const deps: ScanTicketDeps = {
    repos,
    reportError,
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as AuthZPort,
    idempotency,
    clock: {
      now: vi.fn(() => clockNow),
    },
    logger,
    metrics: {
      increment: metricsIncrement,
      record: metricsRecord,
    },
  };

  return {
    deps,
    mocks: {
      ticketsGetByCode,
      ticketsMarkScanned,
      ticketsRecordScan,
      auditLog,
      txCommitted,
      reportError,
      eventsGetById,
      authzGetOrgMembership,
      metricsIncrement,
      metricsRecord,
      loggerChild,
      loggerWarn: scopedLogger.warn,
      loggerError: scopedLogger.error,
    },
    clockNow,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REGRESSION — real minted / seeded ticket-code shapes
//
// `scanTicket` used to `.toUpperCase()` `ticketCode` in its zod schema before
// calling `tickets.getByCode`. `Ticket.code` is a case-sensitive unique column
// and real codes are lowercase (`generateTicketCode()` → `tk_<hex>`), so every
// real scan returned REJECTED/ticket_not_found. The suite stayed green because
// every fixture used the fictional all-uppercase code "TK123456" — a shape the
// system has never minted. These tests call the REAL generator instead.
// ══════════════════════════════════════════════════════════════════════════════

describe("scanTicket — real ticket-code shapes (regression)", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeDeps();
    ctx.mocks.eventsGetById.mockResolvedValue({ ...DEFAULT_EVENT });
    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: ACTOR_ID,
      role: "SCANNER" as OrgRole,
    });
  });

  it("accepts a freshly generated generateTicketCode() and looks it up VERBATIM", async () => {
    const code = generateTicketCode();
    expect(code).toMatch(/^tk_[0-9a-f]{24}$/);

    const ticket = sampleTicket({ code });
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: code,
      clientKey: CLIENT_KEY,
    });

    // The load-bearing assertion: the code must reach the repo unmangled.
    // Before the fix this was called with `code.toUpperCase()`, which the
    // case-sensitive unique index never matches.
    expect(ctx.mocks.ticketsGetByCode).toHaveBeenCalledWith(code);
    expect(ctx.mocks.ticketsMarkScanned).toHaveBeenCalledWith(
      code,
      ctx.clockNow,
    );
    expect(result).toMatchObject({ outcome: "ACCEPTED", ticketId: ticket.id });
  });

  it("accepts the hyphenated seed/POS code shape (SEED-E01-001-1) verbatim", async () => {
    const code = "SEED-E01-001-1";
    const ticket = sampleTicket({ code });
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: code,
      clientKey: CLIENT_KEY,
    });

    expect(ctx.mocks.ticketsGetByCode).toHaveBeenCalledWith(code);
    expect(result).toMatchObject({ outcome: "ACCEPTED" });
  });

  it("hands a hand-typed case-variant to the repo as typed, then marks scanned with the ROW's code", async () => {
    // Operator typed the code upper-cased into the manual-entry field. The use
    // case must not normalise it (that is `getByCode`'s deliberate fallback),
    // and the atomic `markScanned` must use the binary-exact code off the row.
    const storedCode = generateTicketCode();
    const typed = storedCode.toUpperCase();
    const ticket = sampleTicket({ code: storedCode });
    ctx.mocks.ticketsGetByCode.mockResolvedValue(ticket);
    ctx.mocks.ticketsMarkScanned.mockResolvedValue({
      ok: true,
      scannedAt: ctx.clockNow,
    });

    const result = await scanTicket(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: DEFAULT_EVENT.id,
      ticketCode: typed,
      clientKey: CLIENT_KEY,
    });

    expect(ctx.mocks.ticketsGetByCode).toHaveBeenCalledWith(typed);
    expect(ctx.mocks.ticketsMarkScanned).toHaveBeenCalledWith(
      storedCode,
      ctx.clockNow,
    );
    expect(result).toMatchObject({ outcome: "ACCEPTED" });
  });

  it("still enforces the 6..64 length bounds on the code", async () => {
    for (const bad of ["tk_ab", "x".repeat(65)]) {
      await expect(
        scanTicket(ctx.deps, {
          actorHumanId: ACTOR_ID,
          eventId: DEFAULT_EVENT.id,
          ticketCode: bad,
          clientKey: CLIENT_KEY,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });
});
