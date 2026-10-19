/**
 * Booking-request concurrency guarantees against real Postgres.
 *
 * The unit tests in @th/core exercise these flows through fakes, so they
 * verify the *contract* but not the actual SQL. These tests run the real
 * Prisma adapter (packages/adapters/src/db/prisma/booking-requests.ts) so
 * we know:
 *
 *  - the partial unique index "BookingRequest_open_pair_key" (migration
 *    20260610120000) genuinely rejects a second OPEN request for the same
 *    (performerOwnerType, performerOwnerId, placeId) pair, and the adapter
 *    maps the P2002 to `duplicate_open_request`,
 *  - the index really is partial: once the first request reaches a terminal
 *    status, a new open request for the same pair is allowed,
 *  - concurrent `create` races have exactly one winner,
 *  - `updateStatus` / `markViewed` are write-time compare-and-swaps: a row
 *    that already left the `expectedFrom` set surfaces
 *    `{ code: "conflict", message: "booking_request_status_changed" }` and
 *    stays untouched,
 *  - two concurrent transactions both reading PENDING and both responding
 *    produce exactly one winner (READ COMMITTED row-lock + re-check),
 *  - the expiry sweep's port (`listExpiryCandidates` + the guarded
 *    `expireIfDue`) only flips open rows whose expiresAt has passed,
 *  - anonymous embed inquiries (booking-request-embed-button FR-005)
 *    round-trip (null owner pair, contact fields, source/embedId) and the
 *    partial expression index "BookingRequest_open_anon_pair_key" (migration
 *    20260713120000) rejects a second OPEN anonymous request for the same
 *    (placeId, lower(contactEmail)) as `duplicate_open_request` without
 *    colliding with owned requests at the same place,
 *  - the invite-to-claim trio (FR-007): `findByClaimTokenHash` is an exact
 *    unique lookup (found / not found / dead after consumption),
 *    `setClaimToken` is a CAS UPDATE that rotates the single active token
 *    and refuses non-ACCEPTED / claimed rows, and `claim` is a single-winner
 *    CAS redeem (backfills the owner pair, NULLs the token columns, and —
 *    claim-wins — an ACCEPTED backfill never trips the open-pair index even
 *    when the claimer already has an OPEN request at the same place).
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import type {
  CreateAnonymousBookingRequestRecordInput,
  CreateBookingRequestRecordInput,
} from "@th/ports/repos/booking-requests";
import { getBookingRequestSender } from "@th/ports/repos/booking-requests";

import { createPrismaRepos } from "../../src/db/prisma";

const FUTURE_EXPIRY = new Date("2027-01-01T00:00:00Z");

describe("Prisma adapters integration – booking requests", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let placeId: string;
  let senderHumanId: string;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      // Shared FK scaffolding. `performerOwnerId` is polymorphic (no FK), so
      // tests mint fresh sender ids per pair; only Place needs a real row.
      // Note: Place.verification is DB-mapped as "verificaion" [sic] — going
      // through the Prisma client means we never have to care.
      const place = await prisma.place.create({
        data: {
          name: "The Ember Room",
          address: "1 Fireside Ln",
          acceptsBookingRequests: true,
          verification: "VERIFIED",
        },
      });
      placeId = place.id;

      const sender = await prisma.human.create({
        data: { name: "Booking Tester", status: "ACTIVE" },
      });
      senderHumanId = sender.id;
    } catch (err) {
      runtimeError = err as Error;
      console.error("[booking-requests.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  // listExpiryCandidates scans every open row in the table, so leftovers from
  // earlier tests would pollute its counts. Wipe requests between tests;
  // the Place/Human scaffolding survives.
  beforeEach(async () => {
    if (!prisma) return;
    await prisma.bookingRequest.deleteMany({});
  }, 60_000);

  /** Fresh (performer, place) pair per call so the partial unique index never
   *  collides across assertions unless a test wants it to. */
  function makeCreateInput(
    ownerId: string,
    overrides?: Partial<CreateBookingRequestRecordInput>,
  ): CreateBookingRequestRecordInput {
    return {
      placeId,
      performerOwnerType: "human",
      performerOwnerId: ownerId,
      message: "We'd love to play your room.",
      preferredDates: ["2026-07-04"],
      expectedDraw: 80,
      genre: "indie",
      expiresAt: FUTURE_EXPIRY,
      ...overrides,
    };
  }

  /** Anonymous embed-inquiry input; contactEmail lowercased per convention. */
  function makeAnonymousInput(
    contactEmail: string,
    overrides?: Partial<CreateAnonymousBookingRequestRecordInput>,
  ): CreateAnonymousBookingRequestRecordInput {
    return {
      placeId,
      contactName: "The Basement Tapes",
      contactEmail,
      source: "EMBED",
      embedId: null,
      message: "Found you through your website — any open Fridays?",
      preferredDates: ["2026-08-14"],
      expiresAt: FUTURE_EXPIRY,
      ...overrides,
    };
  }

  async function readRow(id: string) {
    return prisma!.bookingRequest.findUniqueOrThrow({
      where: { id },
      select: { status: true, viewedAt: true, respondedAt: true },
    });
  }

  // ── 0. verifiedStatsSnapshot round-trips (musician-epk FR-009) ─────────────
  test("persists and reads back a verifiedStatsSnapshot; null by default", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    // Distinct performerOwnerId per create (polymorphic string, no FK) so the
    // partial open-pair unique index never collides between the two rows.
    const withNull = await repos.bookingRequests.create(
      makeCreateInput("11111111-1111-4111-8111-1111110000aa"),
    );
    expect(withNull.verifiedStatsSnapshot).toBeNull();

    const snapshot = {
      totalEventsPerformed: 5,
      avgDrawPerEvent: 20,
      repeatFanCount: 4,
      refLinkTickets: 33,
      last90DayTickets: 25,
      last90DayEvents: 2,
      computedAt: "2026-07-01T00:00:00.000Z",
    };
    const withSnapshot = await repos.bookingRequests.create(
      makeCreateInput("22222222-2222-4222-8222-2222220000bb", {
        verifiedStatsSnapshot: snapshot,
      }),
    );
    expect(withSnapshot.verifiedStatsSnapshot).toEqual(snapshot);

    const reread = await repos.bookingRequests.getById(withSnapshot.id);
    expect(reread?.verifiedStatsSnapshot).toEqual(snapshot);
  }, 60_000);

  // ── 1. Partial unique index ────────────────────────────────────────────────
  test("second OPEN request for the same pair fails with duplicate_open_request; terminal status frees the pair", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const ownerId = senderHumanId;

    const first = await repos.bookingRequests.create(makeCreateInput(ownerId));
    expect(first.status).toBe("PENDING");

    // Same pair, still PENDING → index rejects, adapter maps P2002.
    await expect(
      repos.bookingRequests.create(makeCreateInput(ownerId)),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });

    // VIEWED is still "open" — the index covers PENDING and VIEWED.
    await repos.bookingRequests.markViewed({
      id: first.id,
      now: new Date("2026-06-10T12:00:00Z"),
      expectedFrom: ["PENDING"],
    });
    await expect(
      repos.bookingRequests.create(makeCreateInput(ownerId)),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });

    // Terminal status (DECLINED) leaves the partial index → pair is free.
    await repos.bookingRequests.updateStatus({
      id: first.id,
      status: "DECLINED",
      expectedFrom: ["PENDING", "VIEWED"],
      respondedAt: new Date("2026-06-10T13:00:00Z"),
      declineReason: "calendar full",
    });
    const second = await repos.bookingRequests.create(makeCreateInput(ownerId));
    expect(second.status).toBe("PENDING");
    expect(second.id).not.toBe(first.id);
  }, 300_000);

  // ── 2. Concurrent create race ──────────────────────────────────────────────
  test("concurrent create for the same pair: exactly one wins, loser gets duplicate_open_request", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const ownerId = randomUUID();

    const results = await Promise.allSettled([
      repos.bookingRequests.create(makeCreateInput(ownerId)),
      repos.bookingRequests.create(makeCreateInput(ownerId)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "duplicate_open_request",
    });

    const openRows = await prisma.bookingRequest.count({
      where: {
        performerOwnerType: "human",
        performerOwnerId: ownerId,
        placeId,
        status: { in: ["PENDING", "VIEWED"] },
      },
    });
    expect(openRows).toBe(1);
  }, 300_000);

  // ── 3. CAS transitions ─────────────────────────────────────────────────────
  test("updateStatus / markViewed are guarded CAS: stale expectedFrom conflicts and leaves the row untouched", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    // Accept from PENDING succeeds.
    const req = await repos.bookingRequests.create(
      makeCreateInput(randomUUID()),
    );
    const accepted = await repos.bookingRequests.updateStatus({
      id: req.id,
      status: "ACCEPTED",
      expectedFrom: ["PENDING", "VIEWED"],
      respondedAt: new Date("2026-06-10T12:00:00Z"),
    });
    expect(accepted.status).toBe("ACCEPTED");

    // A conflicting withdraw on the now-ACCEPTED row must lose.
    await expect(
      repos.bookingRequests.updateStatus({
        id: req.id,
        status: "WITHDRAWN",
        expectedFrom: ["PENDING", "VIEWED"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });
    expect((await readRow(req.id)).status).toBe("ACCEPTED");

    // markViewed on a DECLINED row → conflict, row untouched.
    const declinedReq = await repos.bookingRequests.create(
      makeCreateInput(randomUUID()),
    );
    await repos.bookingRequests.updateStatus({
      id: declinedReq.id,
      status: "DECLINED",
      expectedFrom: ["PENDING", "VIEWED"],
      respondedAt: new Date("2026-06-10T12:30:00Z"),
    });
    await expect(
      repos.bookingRequests.markViewed({
        id: declinedReq.id,
        now: new Date("2026-06-10T13:00:00Z"),
        expectedFrom: ["PENDING"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });
    const declinedRow = await readRow(declinedReq.id);
    expect(declinedRow.status).toBe("DECLINED");
    expect(declinedRow.viewedAt).toBeNull();
  }, 300_000);

  // ── 4. Concurrent respond race ─────────────────────────────────────────────
  test("two transactions both read PENDING and both respond: exactly one wins, loser conflicts, row matches the winner", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const req = await repos.bookingRequests.create(
      makeCreateInput(randomUUID()),
    );

    // Barrier: neither transaction may write until BOTH have read the row as
    // PENDING. That guarantees the loser's in-tx read happened before the
    // winner's commit — the lost-update setup the CAS exists to defeat.
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let readersArrived = 0;
    const observedStatuses: string[] = [];
    const arrive = () => {
      readersArrived += 1;
      if (readersArrived === 2) releaseBarrier();
    };

    const respond = (status: "ACCEPTED" | "WITHDRAWN") =>
      repos.tx(async (tx) => {
        const row = await tx.bookingRequests.getById(req.id);
        observedStatuses.push(row?.status ?? "missing");
        arrive();
        await barrier;
        return tx.bookingRequests.updateStatus({
          id: req.id,
          status,
          expectedFrom: ["PENDING", "VIEWED"],
          respondedAt: new Date("2026-06-10T14:00:00Z"),
        });
      });

    const [acceptResult, withdrawResult] = await Promise.allSettled([
      respond("ACCEPTED"),
      respond("WITHDRAWN"),
    ]);

    // Both transactions saw the same PENDING snapshot before writing.
    expect(observedStatuses).toEqual(["PENDING", "PENDING"]);

    const settled = [
      { status: "ACCEPTED", result: acceptResult },
      { status: "WITHDRAWN", result: withdrawResult },
    ];
    const winners = settled.filter((s) => s.result.status === "fulfilled");
    const losers = settled.filter((s) => s.result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0]!.result as PromiseRejectedResult).reason).toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });

    const finalRow = await readRow(req.id);
    expect(finalRow.status).toBe(winners[0]!.status);
  }, 300_000);

  // ── 5. the expiry sweep's port (booking-the-night P2d-2: candidates, then a
  // guarded per-request flip under the request's booking lock) ─────────────
  test("listExpiryCandidates + expireIfDue flip exactly the open rows whose expiresAt has passed", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const past = new Date("2026-05-01T00:00:00Z");
    const future = new Date("2026-07-01T00:00:00Z");
    const cutoff = new Date("2026-06-01T00:00:00Z");

    // Distinct performer per row so the open-pair index never interferes.
    const seed = (status: string, expiresAt: Date) =>
      prisma!.bookingRequest.create({
        data: {
          placeId,
          performerOwnerType: "human",
          performerOwnerId: randomUUID(),
          message: "expiry seed",
          status: status as never,
          expiresAt,
        },
        select: { id: true },
      });

    const pendingPast = await seed("PENDING", past);
    const viewedPast = await seed("VIEWED", past);
    const acceptedPast = await seed("ACCEPTED", past);
    const pendingFuture = await seed("PENDING", future);

    const candidates = await repos.bookingRequests.listExpiryCandidates({
      cutoff,
      limit: 500,
    });
    expect([...candidates].sort()).toEqual(
      [pendingPast.id, viewedPast.id].sort(),
    );
    const flipped: string[] = [];
    for (const row of [pendingPast, viewedPast, acceptedPast, pendingFuture]) {
      const expired = await repos.tx(async (tx) => {
        await tx.bookingHolds.lockRequestBooking(row.id);
        return tx.bookingRequests.expireIfDue({ id: row.id, cutoff });
      });
      if (expired) flipped.push(expired.id);
    }
    expect(flipped.sort()).toEqual([pendingPast.id, viewedPast.id].sort());
    expect((await readRow(pendingPast.id)).status).toBe("EXPIRED");
    expect((await readRow(viewedPast.id)).status).toBe("EXPIRED");
    expect((await readRow(acceptedPast.id)).status).toBe("ACCEPTED");
    expect((await readRow(pendingFuture.id)).status).toBe("PENDING");
  }, 300_000);

  // ── 6. Anonymous embed inquiries (booking-request-embed-button FR-005) ─────
  test("anonymous create round-trips: null owner pair, contact fields, source/embedId; sender narrows to anonymous", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    const created = await repos.bookingRequests.create(
      makeAnonymousInput("band@example.com", { embedId: "embed-widget-1" }),
    );

    expect(created.performerOwnerType).toBeNull();
    expect(created.performerOwnerId).toBeNull();
    expect(created.contactName).toBe("The Basement Tapes");
    expect(created.contactEmail).toBe("band@example.com");
    expect(created.source).toBe("EMBED");
    expect(created.embedId).toBe("embed-widget-1");
    expect(created.claimTokenHash).toBeNull();
    expect(created.claimTokenExpiresAt).toBeNull();
    expect(created.claimedAt).toBeNull();
    expect(created.status).toBe("PENDING");

    const reread = await repos.bookingRequests.getById(created.id);
    expect(reread).not.toBeNull();
    expect(getBookingRequestSender(reread!)).toEqual({
      kind: "anonymous",
      contactName: "The Basement Tapes",
      contactEmail: "band@example.com",
    });

    // Owned rows still default to PLATFORM provenance.
    const owned = await repos.bookingRequests.create(
      makeCreateInput(randomUUID()),
    );
    expect(owned.source).toBe("PLATFORM");
    expect(owned.contactName).toBeNull();
    expect(owned.contactEmail).toBeNull();

    // Mixed-case contactEmail never lands at rest — the adapter lowercases
    // defensively behind the caller's lowercasing obligation.
    const mixed = await repos.bookingRequests.create(
      makeAnonymousInput("Mixed.Case@Example.COM"),
    );
    expect(mixed.contactEmail).toBe("mixed.case@example.com");
  }, 300_000);

  test("second OPEN anonymous request for the same (place, email) fails with duplicate_open_request; lower() matches case-insensitively; terminal status frees the pair; owned requests don't collide", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    const first = await repos.bookingRequests.create(
      makeAnonymousInput("dupe@example.com"),
    );
    expect(first.status).toBe("PENDING");

    // Same (place, email) while OPEN → the partial index rejects, the adapter
    // maps the P2002 to the same domain error as the owned open-pair rule.
    await expect(
      repos.bookingRequests.create(makeAnonymousInput("dupe@example.com")),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });

    // A mixed-case resubmission still collides. (The adapter lowercases
    // before insert, so this exercises the normalization; the raw lower()
    // expression semantics are pinned separately below.)
    await expect(
      repos.bookingRequests.create(makeAnonymousInput("DUPE@example.com")),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });

    // lower() expression semantics, adapter bypassed: seed a mixed-case row
    // via the raw client (legacy/out-of-band writes), then an adapter create
    // for the lowercase equivalent must still collide on lower(email).
    await prisma.bookingRequest.create({
      data: {
        placeId,
        contactName: "Raw Cased",
        contactEmail: "CASED@example.com",
        source: "EMBED",
        message: "raw mixed-case seed",
        preferredDates: ["2026-08-14"],
        expiresAt: FUTURE_EXPIRY,
      },
    });
    await expect(
      repos.bookingRequests.create(makeAnonymousInput("cased@example.com")),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });

    // A different email at the same place is fine.
    const other = await repos.bookingRequests.create(
      makeAnonymousInput("other@example.com"),
    );
    expect(other.status).toBe("PENDING");

    // An OWNED request at the same place never collides with the anonymous
    // index (performerOwnerId IS NULL predicate).
    const owned = await repos.bookingRequests.create(
      makeCreateInput(randomUUID()),
    );
    expect(owned.status).toBe("PENDING");

    // VIEWED is still "open".
    await repos.bookingRequests.markViewed({
      id: first.id,
      now: new Date("2026-06-10T12:00:00Z"),
      expectedFrom: ["PENDING"],
    });
    await expect(
      repos.bookingRequests.create(makeAnonymousInput("dupe@example.com")),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });

    // Terminal status leaves the partial index → the (place, email) is free.
    await repos.bookingRequests.updateStatus({
      id: first.id,
      status: "DECLINED",
      expectedFrom: ["PENDING", "VIEWED"],
      respondedAt: new Date("2026-06-10T13:00:00Z"),
      declineReason: "calendar full",
    });
    const second = await repos.bookingRequests.create(
      makeAnonymousInput("dupe@example.com"),
    );
    expect(second.status).toBe("PENDING");
    expect(second.id).not.toBe(first.id);
  }, 300_000);

  test("findOpenByContactEmailAndPlace: lowercased-equality open-anonymous lookup, no ILIKE wildcards, blind to owned/terminal rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    // Nothing open yet.
    expect(
      await repos.bookingRequests.findOpenByContactEmailAndPlace({
        placeId,
        contactEmail: "find-me@example.com",
      }),
    ).toBeNull();

    const anon = await repos.bookingRequests.create(
      makeAnonymousInput("find-me@example.com"),
    );

    // Exact and case-variant inputs both find the open row (the adapter
    // lowercases the argument; rows are lowercased at rest).
    const found = await repos.bookingRequests.findOpenByContactEmailAndPlace({
      placeId,
      contactEmail: "find-me@example.com",
    });
    expect(found?.id).toBe(anon.id);
    const foundUpper =
      await repos.bookingRequests.findOpenByContactEmailAndPlace({
        placeId,
        contactEmail: "FIND-ME@EXAMPLE.COM",
      });
    expect(foundUpper?.id).toBe(anon.id);

    // No pattern matching: `_`/`%` in the probe are LITERAL characters, not
    // ILIKE wildcards — a crafted email must never match another submitter's
    // open inquiry (dupe-check oracle / false DUPLICATE_OPEN_REQUEST).
    expect(
      await repos.bookingRequests.findOpenByContactEmailAndPlace({
        placeId,
        contactEmail: "find-m_@example.com",
      }),
    ).toBeNull();
    expect(
      await repos.bookingRequests.findOpenByContactEmailAndPlace({
        placeId,
        contactEmail: "%@example.com",
      }),
    ).toBeNull();

    // A mixed-case value AT REST (legacy / out-of-band write, adapter
    // bypassed) is deliberately NOT matched by this best-effort pre-check
    // (plain equality against lowercased-at-rest rows) — it stays guarded by
    // the authoritative lower(contactEmail) unique index, pinned in the
    // dedupe test above.
    await prisma.bookingRequest.create({
      data: {
        placeId,
        contactName: "Raw Cased",
        contactEmail: "Legacy.Cased@Example.com",
        source: "EMBED",
        message: "raw mixed-case seed",
        preferredDates: ["2026-08-14"],
        expiresAt: FUTURE_EXPIRY,
      },
      select: { id: true },
    });
    expect(
      await repos.bookingRequests.findOpenByContactEmailAndPlace({
        placeId,
        contactEmail: "legacy.cased@example.com",
      }),
    ).toBeNull();

    // An OWNED open request never matches (contactEmail null, owner set) —
    // probe with an email no anonymous row uses.
    await repos.bookingRequests.create(makeCreateInput(randomUUID()));
    expect(
      await repos.bookingRequests.findOpenByContactEmailAndPlace({
        placeId,
        contactEmail: "owned-probe@example.com",
      }),
    ).toBeNull();

    // VIEWED is still open …
    await repos.bookingRequests.markViewed({
      id: anon.id,
      now: new Date("2026-06-10T12:00:00Z"),
      expectedFrom: ["PENDING"],
    });
    expect(
      (
        await repos.bookingRequests.findOpenByContactEmailAndPlace({
          placeId,
          contactEmail: "find-me@example.com",
        })
      )?.id,
    ).toBe(anon.id);

    // … but a terminal status leaves the open scope.
    await repos.bookingRequests.updateStatus({
      id: anon.id,
      status: "DECLINED",
      expectedFrom: ["PENDING", "VIEWED"],
      respondedAt: new Date("2026-06-10T13:00:00Z"),
      declineReason: "calendar full",
    });
    expect(
      await repos.bookingRequests.findOpenByContactEmailAndPlace({
        placeId,
        contactEmail: "find-me@example.com",
      }),
    ).toBeNull();
  }, 300_000);

  test("concurrent anonymous create for the same (place, email): exactly one wins", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const email = `${randomUUID()}@example.com`;

    const results = await Promise.allSettled([
      repos.bookingRequests.create(makeAnonymousInput(email)),
      repos.bookingRequests.create(makeAnonymousInput(email)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "duplicate_open_request",
    });

    const openRows = await prisma.bookingRequest.count({
      where: {
        placeId,
        contactEmail: email,
        performerOwnerId: null,
        status: { in: ["PENDING", "VIEWED"] },
      },
    });
    expect(openRows).toBe(1);
  }, 300_000);

  // ── 7. Invite-to-claim (booking-request-embed-button FR-007) ───────────────

  /** sha256 hex, mirroring core's at-rest token form. */
  const hashOf = (raw: string) =>
    createHash("sha256").update(raw, "utf8").digest("hex");

  /** Create an anonymous inquiry and drive it to ACCEPTED with a live token. */
  async function seedAcceptedWithToken(
    repos: ReturnType<typeof createPrismaRepos>,
    email: string,
    tokenHash: string,
    expiresAt = new Date("2027-06-01T00:00:00Z"),
  ) {
    const req = await repos.bookingRequests.create(makeAnonymousInput(email));
    await repos.bookingRequests.updateStatus({
      id: req.id,
      status: "ACCEPTED",
      expectedFrom: ["PENDING", "VIEWED"],
      respondedAt: new Date("2026-06-10T12:00:00Z"),
    });
    return repos.bookingRequests.setClaimToken({
      id: req.id,
      claimTokenHash: tokenHash,
      claimTokenExpiresAt: expiresAt,
      expectedFrom: ["ACCEPTED"],
    });
  }

  test("findByClaimTokenHash: exact unique lookup — found, not found, dead after claim", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const tokenHash = hashOf(`raw-${randomUUID()}`);

    // Not found before any token exists.
    expect(
      await repos.bookingRequests.findByClaimTokenHash(tokenHash),
    ).toBeNull();

    const invited = await seedAcceptedWithToken(
      repos,
      "claim-lookup@example.com",
      tokenHash,
    );
    expect(invited.claimTokenHash).toBe(tokenHash);
    expect(invited.status).toBe("ACCEPTED");

    const found = await repos.bookingRequests.findByClaimTokenHash(tokenHash);
    expect(found?.id).toBe(invited.id);

    // A different hash misses.
    expect(
      await repos.bookingRequests.findByClaimTokenHash(hashOf("other-raw")),
    ).toBeNull();

    // After consumption the hash is NULLed → lookup dies (single use).
    await repos.bookingRequests.claim({
      id: invited.id,
      expectedClaimTokenHash: tokenHash,
      performerOwnerType: "human",
      performerOwnerId: randomUUID(),
      claimedAt: new Date("2026-06-11T12:00:00Z"),
    });
    expect(
      await repos.bookingRequests.findByClaimTokenHash(tokenHash),
    ).toBeNull();
  }, 300_000);

  test("setClaimToken: CAS rotation — single active token; refuses OPEN, claimed, and stale-status rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    // Refuses an OPEN (not-yet-accepted) row.
    const open = await repos.bookingRequests.create(
      makeAnonymousInput("rotate-open@example.com"),
    );
    await expect(
      repos.bookingRequests.setClaimToken({
        id: open.id,
        claimTokenHash: hashOf(`raw-${randomUUID()}`),
        claimTokenExpiresAt: FUTURE_EXPIRY,
        expectedFrom: ["ACCEPTED"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });

    // Accept + issue, then rotate: the old hash dies, the new one resolves.
    const firstHash = hashOf(`raw-${randomUUID()}`);
    const secondHash = hashOf(`raw-${randomUUID()}`);
    const invited = await seedAcceptedWithToken(
      repos,
      "rotate@example.com",
      firstHash,
    );
    const rotated = await repos.bookingRequests.setClaimToken({
      id: invited.id,
      claimTokenHash: secondHash,
      claimTokenExpiresAt: new Date("2027-07-01T00:00:00Z"),
      expectedFrom: ["ACCEPTED"],
    });
    expect(rotated.claimTokenHash).toBe(secondHash);
    expect(
      await repos.bookingRequests.findByClaimTokenHash(firstHash),
    ).toBeNull();
    expect(
      (await repos.bookingRequests.findByClaimTokenHash(secondHash))?.id,
    ).toBe(invited.id);

    // The OLD token can no longer be redeemed (rotation revoked it).
    await expect(
      repos.bookingRequests.claim({
        id: invited.id,
        expectedClaimTokenHash: firstHash,
        performerOwnerType: "human",
        performerOwnerId: randomUUID(),
        claimedAt: new Date("2026-06-11T12:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_already_claimed",
    });

    // Once claimed, a racing rotation must NOT resurrect a token.
    await repos.bookingRequests.claim({
      id: invited.id,
      expectedClaimTokenHash: secondHash,
      performerOwnerType: "human",
      performerOwnerId: randomUUID(),
      claimedAt: new Date("2026-06-11T13:00:00Z"),
    });
    await expect(
      repos.bookingRequests.setClaimToken({
        id: invited.id,
        claimTokenHash: hashOf(`raw-${randomUUID()}`),
        claimTokenExpiresAt: FUTURE_EXPIRY,
        expectedFrom: ["ACCEPTED"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });
  }, 300_000);

  test("claim: backfills the owner pair, NULLs token columns, second redeem loses; open-pair index untouched (claim wins)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const claimerId = randomUUID();

    // Claim-wins setup: the claimer ALREADY has an OPEN request at this
    // place. Backfilling the owner pair onto the ACCEPTED row must not trip
    // "BookingRequest_open_pair_key" (partial: PENDING/VIEWED only).
    const preexistingOpen = await repos.bookingRequests.create(
      makeCreateInput(claimerId),
    );
    expect(preexistingOpen.status).toBe("PENDING");

    const tokenHash = hashOf(`raw-${randomUUID()}`);
    const invited = await seedAcceptedWithToken(
      repos,
      "claim-redeem@example.com",
      tokenHash,
    );

    const claimed = await repos.bookingRequests.claim({
      id: invited.id,
      expectedClaimTokenHash: tokenHash,
      performerOwnerType: "human",
      performerOwnerId: claimerId,
      claimedAt: new Date("2026-06-11T12:00:00Z"),
    });
    expect(claimed.performerOwnerType).toBe("human");
    expect(claimed.performerOwnerId).toBe(claimerId);
    expect(claimed.claimedAt).toEqual(new Date("2026-06-11T12:00:00Z"));
    expect(claimed.claimTokenHash).toBeNull();
    expect(claimed.claimTokenExpiresAt).toBeNull();
    expect(claimed.status).toBe("ACCEPTED");
    // Both identities present → the sender union treats the row as OWNED.
    expect(getBookingRequestSender(claimed)).toEqual({
      kind: "owned",
      performerOwnerType: "human",
      performerOwnerId: claimerId,
    });
    // The claimer's other open request stayed untouched (claim wins).
    expect((await readRow(preexistingOpen.id)).status).toBe("PENDING");

    // Second redeem with the same (now-consumed) hash loses.
    await expect(
      repos.bookingRequests.claim({
        id: invited.id,
        expectedClaimTokenHash: tokenHash,
        performerOwnerType: "human",
        performerOwnerId: randomUUID(),
        claimedAt: new Date("2026-06-11T13:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_already_claimed",
    });
  }, 300_000);

  test("concurrent double-redeem: exactly one winner, loser conflicts, row matches the winner", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const tokenHash = hashOf(`raw-${randomUUID()}`);
    const invited = await seedAcceptedWithToken(
      repos,
      "claim-race@example.com",
      tokenHash,
    );

    const redeemerA = randomUUID();
    const redeemerB = randomUUID();
    const results = await Promise.allSettled([
      repos.bookingRequests.claim({
        id: invited.id,
        expectedClaimTokenHash: tokenHash,
        performerOwnerType: "human",
        performerOwnerId: redeemerA,
        claimedAt: new Date("2026-06-11T12:00:00Z"),
      }),
      repos.bookingRequests.claim({
        id: invited.id,
        expectedClaimTokenHash: tokenHash,
        performerOwnerType: "human",
        performerOwnerId: redeemerB,
        claimedAt: new Date("2026-06-11T12:00:00Z"),
      }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof repos.bookingRequests.claim>>> =>
        r.status === "fulfilled",
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "conflict",
      message: "booking_request_already_claimed",
    });

    // The row carries exactly the winner's identity, token consumed.
    const finalRow = await prisma.bookingRequest.findUniqueOrThrow({
      where: { id: invited.id },
      select: {
        performerOwnerId: true,
        claimTokenHash: true,
        claimedAt: true,
      },
    });
    expect(finalRow.performerOwnerId).toBe(
      fulfilled[0]!.value.performerOwnerId,
    );
    expect([redeemerA, redeemerB]).toContain(finalRow.performerOwnerId);
    expect(finalRow.claimTokenHash).toBeNull();
    expect(finalRow.claimedAt).not.toBeNull();
  }, 300_000);

  test("setClaimToken maps a claimTokenHash unique collision to claim_token_hash_collision", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const sharedHash = hashOf(`raw-${randomUUID()}`);

    await seedAcceptedWithToken(repos, "collide-a@example.com", sharedHash);
    const second = await seedAcceptedWithToken(
      repos,
      "collide-b@example.com",
      hashOf(`raw-${randomUUID()}`),
    );

    // Rotating the second row onto the FIRST row's hash trips the unique
    // index → the distinct collision conflict (core retries once on this).
    await expect(
      repos.bookingRequests.setClaimToken({
        id: second.id,
        claimTokenHash: sharedHash,
        claimTokenExpiresAt: FUTURE_EXPIRY,
        expectedFrom: ["ACCEPTED"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "claim_token_hash_collision",
    });
  }, 300_000);

  // ── 8. Sender-identity CHECK constraint ────────────────────────────────────
  test("BookingRequest_sender_identity_check rejects rows with no / half / contact-incomplete sender identity", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    // Raw client on purpose: the repo guard already refuses these shapes —
    // this pins the DB backstop (the migration's CHECK constraint), which is
    // what protects the dedupe index from NULL-contactEmail anonymous rows
    // (expression-index entries over NULL are all distinct).
    const rawSeed = (data: Record<string, unknown>) =>
      prisma!.bookingRequest.create({
        data: {
          placeId,
          message: "constraint probe",
          preferredDates: ["2026-08-14"],
          expiresAt: FUTURE_EXPIRY,
          ...data,
        },
      });

    // (a) Neither identity.
    await expect(rawSeed({})).rejects.toThrow(/sender_identity_check/);

    // (b) Half-populated owner pair (type without id, and id without type).
    await expect(
      rawSeed({ performerOwnerType: "human" }),
    ).rejects.toThrow(/sender_identity_check/);
    await expect(
      rawSeed({ performerOwnerId: randomUUID() }),
    ).rejects.toThrow(/sender_identity_check/);

    // (c) Anonymous with NULL contactEmail (and NULL contactName) — exactly
    // the rows that would slip past the lower(contactEmail) dedupe index.
    await expect(
      rawSeed({ contactName: "No Email Band", source: "EMBED" }),
    ).rejects.toThrow(/sender_identity_check/);
    await expect(
      rawSeed({ contactEmail: "half@example.com", source: "EMBED" }),
    ).rejects.toThrow(/sender_identity_check/);

    // Sanity: both identities together (claimed anonymous request) passes.
    const claimed = await rawSeed({
      performerOwnerType: "human",
      performerOwnerId: randomUUID(),
      contactName: "Claimed Band",
      contactEmail: "claimed@example.com",
      source: "EMBED",
      claimedAt: new Date("2026-07-13T00:00:00Z"),
    });
    expect(claimed.id).toBeTruthy();
  }, 300_000);

  // ── TO_PERFORMER direction (organizer-booking-requests, NFR-001) ───────────
  test("organizer requests: direction-scoped creates/lists never cross, CHECK constraint holds, open-pair index backstops", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    const org = await prisma.organization.create({
      data: { name: "Corner Booking Collective", slug: `corner-${randomUUID().slice(0, 8)}` },
    });
    const event = await prisma.event.create({
      data: {
        title: "East Side Showcase",
        startsAt: new Date("2026-08-14T19:00:00Z"),
        endsAt: new Date("2026-08-14T22:00:00Z"),
        status: "PUBLISHED",
        orgId: org.id,
        placeId,
      },
    });
    const actId = randomUUID();

    // Create TO_PERFORMER + a TO_VENUE row for the SAME act pair.
    const organizerRequest = await repos.bookingRequests.createToPerformer({
      organizerOrgId: org.id,
      performerOwnerType: "human",
      performerOwnerId: actId,
      message: "We want you on the showcase bill.",
      preferredDates: ["2026-08-14"],
      attachedEventId: event.id,
      expiresAt: FUTURE_EXPIRY,
    });
    expect(organizerRequest.direction).toBe("TO_PERFORMER");
    expect(organizerRequest.placeId).toBeNull();
    expect(organizerRequest.organizerOrgId).toBe(org.id);
    expect(organizerRequest.organizerOrgName).toBe("Corner Booking Collective");
    expect(organizerRequest.attachedEventTitle).toBe("East Side Showcase");

    const venueRequest = await repos.bookingRequests.create(
      makeCreateInput(actId),
    );
    expect(venueRequest.direction).toBe("TO_VENUE");

    // NFR-001 leakage matrix: each list sees ONLY its own direction.
    const venueInbox = await repos.bookingRequests.listForPlace({ placeId });
    expect(venueInbox.map((r) => r.id)).toEqual([venueRequest.id]);

    const sentList = await repos.bookingRequests.listForPerformer({
      ownerType: "human",
      ownerId: actId,
    });
    expect(sentList.map((r) => r.id)).toEqual([venueRequest.id]);

    const organizerList = await repos.bookingRequests.listForOrganizer({
      organizerOrgId: org.id,
    });
    expect(organizerList.map((r) => r.id)).toEqual([organizerRequest.id]);

    const inbox = await repos.bookingRequests.listForPerformerInbox({
      ownerType: "human",
      ownerId: actId,
    });
    expect(inbox.map((r) => r.id)).toEqual([organizerRequest.id]);

    // Open-pair pre-check finders stay direction-scoped too.
    const openVenue = await repos.bookingRequests.findOpenByPerformerAndPlace({
      ownerType: "human",
      ownerId: actId,
      placeId,
    });
    expect(openVenue?.id).toBe(venueRequest.id);
    const openOrganizer =
      await repos.bookingRequests.findOpenByOrganizerAndPerformer({
        organizerOrgId: org.id,
        ownerType: "human",
        ownerId: actId,
      });
    expect(openOrganizer?.id).toBe(organizerRequest.id);

    // One open request per (org, act): the partial unique index rejects a
    // second open create as duplicate_open_request …
    await expect(
      repos.bookingRequests.createToPerformer({
        organizerOrgId: org.id,
        performerOwnerType: "human",
        performerOwnerId: actId,
        message: "double-send should fail",
        preferredDates: ["2026-08-21"],
        expiresAt: FUTURE_EXPIRY,
      }),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });

    // … but a terminal status frees the pair.
    await repos.bookingRequests.updateStatus({
      id: organizerRequest.id,
      status: "DECLINED",
      expectedFrom: ["PENDING", "VIEWED"],
      respondedAt: new Date(),
    });
    const second = await repos.bookingRequests.createToPerformer({
      organizerOrgId: org.id,
      performerOwnerType: "human",
      performerOwnerId: actId,
      message: "trying again next month",
      preferredDates: ["2026-09-04"],
      expiresAt: FUTURE_EXPIRY,
    });
    expect(second.direction).toBe("TO_PERFORMER");

    // Direction-shape CHECK: a TO_PERFORMER row with a placeId (or a TO_VENUE
    // row with an organizerOrgId) is rejected at the DB.
    await expect(
      prisma.bookingRequest.create({
        data: {
          direction: "TO_PERFORMER",
          placeId,
          organizerOrgId: org.id,
          performerOwnerType: "human",
          performerOwnerId: randomUUID(),
          message: "constraint probe",
          preferredDates: ["2026-08-14"],
          expiresAt: FUTURE_EXPIRY,
        },
      }),
    ).rejects.toThrow(/direction_shape_check/);
    await expect(
      prisma.bookingRequest.create({
        data: {
          direction: "TO_VENUE",
          placeId,
          organizerOrgId: org.id,
          performerOwnerType: "human",
          performerOwnerId: randomUUID(),
          message: "constraint probe",
          preferredDates: ["2026-08-14"],
          expiresAt: FUTURE_EXPIRY,
        },
      }),
    ).rejects.toThrow(/direction_shape_check/);
  }, 300_000);

  test("organizer requests: attached-event SetNull detaches on event deletion; expiry sweep covers both directions", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    const org = await prisma.organization.create({
      data: { name: "Sweep Org", slug: `sweep-${randomUUID().slice(0, 8)}` },
    });
    const event = await prisma.event.create({
      data: {
        title: "Doomed Event",
        startsAt: new Date("2026-08-14T19:00:00Z"),
        endsAt: new Date("2026-08-14T22:00:00Z"),
        status: "DRAFT",
        orgId: org.id,
      },
    });

    const pastExpiry = new Date("2026-01-01T00:00:00Z");
    const organizerRequest = await repos.bookingRequests.createToPerformer({
      organizerOrgId: org.id,
      performerOwnerType: "human",
      performerOwnerId: randomUUID(),
      message: "attached event will be deleted",
      preferredDates: ["2026-08-14"],
      attachedEventId: event.id,
      expiresAt: pastExpiry,
    });
    const venueRequest = await repos.bookingRequests.create(
      makeCreateInput(randomUUID(), { expiresAt: pastExpiry }),
    );

    // Deleting the event detaches (SetNull), never deletes the request.
    await prisma.event.delete({ where: { id: event.id } });
    const detached = await repos.bookingRequests.getById(organizerRequest.id);
    expect(detached?.attachedEventId).toBeNull();
    expect(detached?.attachedEventTitle).toBeNull();

    // The daily sweep is direction-agnostic: both open rows expire.
    const sweepCutoff = new Date("2026-06-01T00:00:00Z");
    const candidates = await repos.bookingRequests.listExpiryCandidates({
      cutoff: sweepCutoff,
      limit: 500,
    });
    expect(new Set(candidates)).toEqual(
      new Set([organizerRequest.id, venueRequest.id]),
    );
    for (const id of candidates) {
      await expect(
        repos.tx(async (tx) => {
          await tx.bookingHolds.lockRequestBooking(id);
          return tx.bookingRequests.expireIfDue({ id, cutoff: sweepCutoff });
        }),
      ).resolves.toMatchObject({ id, status: "EXPIRED" });
    }
  }, 300_000);

  // ── Attachments: storageKey CLAIM-ONCE (Step-6 review) ─────────────────────
  test("addAttachment: an already-claimed storageKey rejects — same request, ANOTHER request, and soft-deleted rows all block", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    const requestA = await repos.bookingRequests.create(
      makeCreateInput(randomUUID()),
    );
    const requestB = await repos.bookingRequests.create(
      makeCreateInput(randomUUID()),
    );

    const key = `booking-requests/${requestA.id}/rider.pdf`;
    const first = await repos.bookingRequests.addAttachment({
      bookingRequestId: requestA.id,
      storageKey: key,
      fileName: "rider.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
      uploadedBySide: "PERFORMER",
      uploadedByHumanId: senderHumanId,
    });
    expect(first.storageKey).toBe(key);

    // Same request, same key — the other participant re-asserting it loses.
    await expect(
      repos.bookingRequests.addAttachment({
        bookingRequestId: requestA.id,
        storageKey: key,
        fileName: "rider-copy.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        uploadedBySide: "VENUE",
        uploadedByHumanId: null,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "attachment_key_taken",
    });

    // ANOTHER request, same key — the WHERE is on storageKey alone (no
    // request scoping): the adapter is the defense-in-depth layer behind
    // core's namespace-prefix guard, so it must reject even the cross-request
    // shape that guard would normally stop upstream.
    await expect(
      repos.bookingRequests.addAttachment({
        bookingRequestId: requestB.id,
        storageKey: key,
        fileName: "stolen.pdf",
        contentType: "application/pdf",
        sizeBytes: 512,
        uploadedBySide: "PERFORMER",
        uploadedByHumanId: senderHumanId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "attachment_key_taken",
    });

    // Soft-delete the claim: the key must STAY claimed (the deleted row's GC
    // enqueue may already be racing the bytes — re-claiming would hand the
    // next soft-delete a double-GC of an object the claimer never uploaded).
    const deleted = await repos.bookingRequests.softDeleteAttachment({
      id: first.id,
      bookingRequestId: requestA.id,
    });
    expect(deleted?.didStamp).toBe(true);
    await expect(
      repos.bookingRequests.addAttachment({
        bookingRequestId: requestA.id,
        storageKey: key,
        fileName: "rider-again.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        uploadedBySide: "PERFORMER",
        uploadedByHumanId: senderHumanId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "attachment_key_taken",
    });
  }, 300_000);
});
