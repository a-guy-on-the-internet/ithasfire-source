import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeTicketsRepo } from "../../src/db/prisma/tickets";

/**
 * `TicketsRepo.countScannedByEvent` (venue-track-record spec 2026-09-24,
 * FR-009 / R4 / R11 as re-ruled 2026-09-25, FU-005). Attendance is counted
 * from the append-only `TicketScan` log: DISTINCT tickets with an ACCEPTED
 * row. Each property below is a real way the track record could lie:
 *
 *   1. A ticket admitted and then REFUNDED still counts. Every refund path
 *      clears `Ticket.scannedAt`; the log does not forget — the whole point
 *      of the re-ruling.
 *   2. REPLAY / REJECTED rows are not admits, and a ticket scanned twice is
 *      one person.
 *   3. A reverted admit does NOT count. The revert writes no log row; it
 *      leaves the ticket VALID (or LISTED, if re-listed) with no transfer
 *      since the scan. The resale refund unwind ALSO leaves an admitted
 *      ticket VALID/LISTED — but after a transfer — and that walk-in counts.
 *   4. An event with ZERO admits is ABSENT from the map — never present as
 *      0 (R4): the caller averages over `map.size` shows.
 *   5. Empty input issues NO query.
 *
 * Fixture rows model product states — an admit writes `status SCANNED` +
 * `scannedAt` + an ACCEPTED row; a refund leaves the row and sets
 * REFUNDED / NULL; a revert leaves the row and sets VALID / NULL — with two
 * labelled exceptions: the cross-event rows in "Only non-admit scans" are
 * NOT producible (`recordScanAttempt` always logs at `ticket.eventId`); they
 * pin the SQL's keying on `TicketScan.eventId`. And the INVALID case pins a
 * KNOWN over-count (FU-008), not correct attendance.
 */
describe("Prisma adapters integration – countScannedByEvent", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const SCANNED_AT = new Date("2026-06-01T22:00:00.000Z");
  const LATER = new Date("2026-06-02T10:00:00.000Z");
  const ids: Record<string, string> = {};
  let humanId: string;
  let otherHumanId: string;
  let codeSeq = 0;

  type ScanOutcome = "ACCEPTED" | "REJECTED" | "REPLAY";

  async function makeEvent(title: string): Promise<string> {
    const ev = await prisma!.event.create({
      data: {
        title,
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:00:00.000Z"),
        status: "PUBLISHED",
        visibility: "PUBLIC",
      },
    });
    return ev.id;
  }

  /**
   * One ticket in its CURRENT state plus its scan-log rows (at `eventId`
   * unless a row names another event) and, optionally, a transfer after
   * the scan.
   */
  async function ticket(
    eventId: string,
    opts: {
      status: "VALID" | "SCANNED" | "REFUNDED" | "LISTED" | "INVALID";
      scannedAt?: Date | null;
      scans?: ReadonlyArray<
        ScanOutcome | { outcome: ScanOutcome; eventId: string }
      >;
      transferredAfterScan?: boolean;
    },
  ): Promise<string> {
    const t = await prisma!.ticket.create({
      data: {
        eventId,
        ownerHumanId: humanId,
        code: `code-${(codeSeq += 1)}`,
        status: opts.status,
        scannedAt: opts.scannedAt ?? null,
      },
    });
    for (const [i, scan] of (opts.scans ?? []).entries()) {
      const outcome = typeof scan === "string" ? scan : scan.outcome;
      await prisma!.ticketScan.create({
        data: {
          ticketId: t.id,
          eventId: typeof scan === "string" ? eventId : scan.eventId,
          actorHumanId: humanId,
          scannedAt: new Date(SCANNED_AT.getTime() + i * 1000),
          outcome,
        },
      });
    }
    if (opts.transferredAfterScan) {
      await prisma!.ticketTransfer.create({
        data: {
          ticketId: t.id,
          fromHumanId: otherHumanId,
          toHumanId: humanId,
          reason: "admin",
          at: LATER,
        },
      });
    }
    return t.id;
  }

  const admitted = { status: "SCANNED", scannedAt: SCANNED_AT, scans: ["ACCEPTED"] } as const;
  // A refund path cleared the stamp; the log row stays.
  const admittedThenRefunded = { status: "REFUNDED", scans: ["ACCEPTED"] } as const;

  async function many(eventId: string, n: number, opts: Parameters<typeof ticket>[1]) {
    for (let i = 0; i < n; i += 1) await ticket(eventId, opts);
  }

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      humanId = (
        await prisma.human.create({ data: { name: "Door Person", status: "ACTIVE" } })
      ).id;
      otherHumanId = (
        await prisma.human.create({ data: { name: "Seller", status: "ACTIVE" } })
      ).id;

      // 20 admitted + 5 never scanned + 3 admitted THEN refunded → 23.
      ids.twenty = await makeEvent("Twenty admitted, three refunded after");
      await many(ids.twenty, 20, admitted);
      await many(ids.twenty, 5, { status: "VALID" });
      await many(ids.twenty, 3, admittedThenRefunded);

      // 30 admitted.
      ids.thirty = await makeEvent("Thirty admitted");
      await many(ids.thirty, 30, admitted);

      // Ten tickets, nobody scanned.
      ids.zero = await makeEvent("Zero scanned");
      await many(ids.zero, 10, { status: "VALID" });

      // Every admitted ticket refunded after the door — all four still came.
      ids.allRefunded = await makeEvent("All refunded after the door");
      await many(ids.allRefunded, 4, admittedThenRefunded);

      // ONE ticket, logged ACCEPTED, REPLAY, REPLAY, then ACCEPTED again
      // (admit → revert → re-admit): one person.
      ids.duplicate = await makeEvent("One ticket, many scans");
      await ticket(ids.duplicate, {
        status: "SCANNED",
        scannedAt: SCANNED_AT,
        scans: ["ACCEPTED", "REPLAY", "REPLAY", "ACCEPTED"],
      });

      // Only non-admits: a REJECTED (ticket not valid), then two rows that
      // are NOT producible — the scanner logs every row at the ticket's own
      // event — kept to pin the SQL's keying on `TicketScan.eventId`: an
      // ACCEPTED row logged at ANOTHER event (plus a local REPLAY), and a
      // REJECTED row logged here for the other event's ticket. Nobody was
      // let in HERE.
      ids.nonAdmit = await makeEvent("Only non-admit scans");
      ids.nonAdmitOther = await makeEvent("Other event");
      await ticket(ids.nonAdmit, { status: "REFUNDED", scans: ["REJECTED"] });
      await ticket(ids.nonAdmit, {
        status: "SCANNED",
        scannedAt: SCANNED_AT,
        scans: [{ outcome: "ACCEPTED", eventId: ids.nonAdmitOther }, "REPLAY"],
      });
      await ticket(ids.nonAdmitOther, {
        status: "VALID",
        scans: [{ outcome: "REJECTED", eventId: ids.nonAdmit }],
      });

      // Reverted admits: VALID (plain revert) and LISTED (reverted, then put
      // up for resale), no transfer since → not attendance. Plus one real
      // admit so the event has a count to compare against.
      ids.reverted = await makeEvent("Reverted admits");
      await ticket(ids.reverted, { status: "VALID", scans: ["ACCEPTED"] });
      await ticket(ids.reverted, { status: "LISTED", scans: ["ACCEPTED"] });
      await ticket(ids.reverted, admitted);

      // Only a reverted admit → absent.
      ids.onlyReverted = await makeEvent("Only a reverted admit");
      await ticket(ids.onlyReverted, { status: "VALID", scans: ["ACCEPTED"] });

      // Resale refund unwind: the buyer was admitted, then the resale order
      // was refunded and the ticket handed back to its seller — a TRANSFER
      // after the scan, status VALID or LISTED. Both walked in.
      ids.resaleUnwound = await makeEvent("Resale refund unwind");
      await ticket(ids.resaleUnwound, {
        status: "VALID",
        scans: ["ACCEPTED"],
        transferredAfterScan: true,
      });
      await ticket(ids.resaleUnwound, {
        status: "LISTED",
        scans: ["ACCEPTED"],
        transferredAfterScan: true,
      });

      // KNOWN OVER-COUNT (FU-008): admit → revert → volunteer reward
      // revoked. `revokeVolunteerReward` (the only INVALID writer) refuses a
      // SCANNED ticket, so INVALID + an ACCEPTED row is reachable ONLY via a
      // revert first — `scannedAt` NULL, and the person did NOT come in. The
      // revert leaves no log row and INVALID is not a revert status, so the
      // count cannot tell.
      ids.invalidated = await makeEvent("Reverted admit, then reward revoked");
      await ticket(ids.invalidated, {
        status: "INVALID",
        scannedAt: null,
        scans: ["ACCEPTED"],
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("countScannedByEvent setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  function repo() {
    return makeTicketsRepo(prisma!);
  }

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("admits 23/30/0 → two entries; the zero-admit event is ABSENT, not 0 (R4)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent([ids.twenty!, ids.thirty!, ids.zero!]);
    expect(map.get(ids.twenty!)).toBe(23);
    expect(map.get(ids.thirty!)).toBe(30);
    expect(map.has(ids.zero!)).toBe(false);
    expect(map.size).toBe(2);
  }, 60_000);

  test("admitted then refunded STILL counts — the log does not forget (R11)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent([ids.twenty!, ids.allRefunded!]);
    // 20 SCANNED + the 3 whose refund cleared `scannedAt`.
    expect(map.get(ids.twenty!)).toBe(23);
    // No ticket at this show has a stamp left; all four walked in.
    expect(map.get(ids.allRefunded!)).toBe(4);
    const stamped = await prisma.ticket.count({
      where: { eventId: ids.allRefunded!, scannedAt: { not: null } },
    });
    expect(stamped).toBe(0);
  }, 60_000);

  test("a ticket scanned many times is ONE person", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent([ids.duplicate!]);
    expect([...map.entries()]).toStrictEqual([[ids.duplicate!, 1]]);
  }, 60_000);

  test("REPLAY and REJECTED are not admits; an admit counts only at the event it was logged at", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent([ids.nonAdmit!, ids.nonAdmitOther!]);
    expect(map.has(ids.nonAdmit!)).toBe(false);
    // The one ACCEPTED row logged at the other event.
    expect(map.get(ids.nonAdmitOther!)).toBe(1);
  }, 60_000);

  test("a reverted admit (VALID or LISTED, no transfer since) does not count; an event with only one is absent", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent([ids.reverted!, ids.onlyReverted!]);
    expect(map.get(ids.reverted!)).toBe(1);
    expect(map.has(ids.onlyReverted!)).toBe(false);
  }, 60_000);

  test("the resale refund unwind (VALID/LISTED AFTER a transfer) is not mistaken for a revert", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent([ids.resaleUnwound!]);
    expect(map.get(ids.resaleUnwound!)).toBe(2);
  }, 60_000);

  test("KNOWN OVER-COUNT (FU-008): a reverted admit whose ticket is later revoked (INVALID) still counts", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent([ids.invalidated!]);
    // WRONG BUT ACCEPTED: nobody came in — the admit was reverted before the
    // revoke. This pins today's behaviour. When FU-008 lands (the revert
    // writes a log row), add the revert row to this setup and expect the
    // event to be absent.
    expect(map.get(ids.invalidated!)).toBe(1);
  }, 60_000);

  test("unknown ids are simply absent", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const map = await repo().countScannedByEvent(["no-such-event", ids.thirty!]);
    expect([...map.entries()]).toStrictEqual([[ids.thirty!, 30]]);
  }, 60_000);

  test("empty input returns an empty map WITHOUT querying", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const spy = vi.spyOn(prisma, "$queryRaw");
    try {
      const map = await repo().countScannedByEvent([]);
      expect(map.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
