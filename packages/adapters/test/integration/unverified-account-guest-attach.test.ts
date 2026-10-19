import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeHumansRepo } from "../../src/db/prisma/humans";
import { makeTicketsRepo } from "../../src/db/prisma/tickets";
import { makeAttendeeReviewsRepo } from "../../src/db/prisma/attendee-reviews";

// B2, account squatting through guest checkout, against real Postgres.
//
// Someone signs up with a password under another person's address and never
// verifies. A guest checkout for that address then resolves to their Human
// (`ensureGuestHuman` resolves BY EMAIL) and mints the tickets onto it. The
// adapter reads below are what keep those tickets from unlocking anything for
// the unverified account, and keep the guest's name off it:
//   · ensureGuestHuman on an existing account never renames it;
//   · tickets.viewerHoldsActiveTicketForEvent needs a verified owner;
//   · humans.listEmailVerifiedIds (the address-reveal fan-out) omits it.
// A shadow guest whose address is later proven gains holder access.

const FEE_SNAPSHOT = { feeMode: "ABSORB", computedAt: "2026-01-01T00:00:00Z" };

describe("Prisma adapters integration – unverified account, guest attach (B2)", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let eventId: string;
  let codeSeq = 0;

  const SQUATTED_EMAIL = "victim@example.test";
  const SQUATTER_NAME = "Squatter Chosen Name";

  const makeTicketFor = async (
    ownerHumanId: string,
    opts: { eventId?: string; status?: string } = {},
  ) => {
    const forEventId = opts.eventId ?? eventId;
    const order = await prisma!.order.create({
      data: {
        eventId: forEventId,
        buyerHumanId: ownerHumanId,
        amountGrossCents: 1000,
        status: "SUCCEEDED" as any,
        feePolicySnapshot: FEE_SNAPSHOT,
      },
    });
    await prisma!.ticket.create({
      data: {
        eventId: forEventId,
        orderId: order.id,
        ownerHumanId,
        code: `b2-${(codeSeq += 1)}-${Math.random().toString(36).slice(2)}`,
        status: (opts.status ?? "VALID") as any,
      },
    });
  };

  /** A password account that never proved its address. */
  const makeUnverifiedPasswordAccount = async (email: string, name: string) => {
    const human = await prisma!.human.create({
      data: {
        name,
        status: "ACTIVE",
        authUser: { create: { name, email, emailVerified: false } },
      },
      include: { authUser: true },
    });
    await prisma!.authAccount.create({
      data: {
        accountId: human.authUser!.id,
        providerId: "credential",
        userId: human.authUser!.id,
      },
    });
    return human.id;
  };

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      eventId = (
        await prisma.event.create({
          data: {
            title: "Holder-only night",
            startsAt: new Date("2026-12-01T02:00:00.000Z"),
            endsAt: new Date("2026-12-01T05:00:00.000Z"),
            status: "PUBLISHED" as any,
            visibility: "PUBLIC" as any,
            timezone: "America/Chicago",
          },
        })
      ).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("unverified-account guest-attach setup failed:", error);
    }
  }, 600_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("squatter: guest checkout attaches to the account, never renames it, and grants no holder access", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const humans = makeHumansRepo(prisma);
    const tickets = makeTicketsRepo(prisma);
    const squatter = await makeUnverifiedPasswordAccount(
      SQUATTED_EMAIL,
      SQUATTER_NAME,
    );

    // What the embed guest checkout does with the buyer's typed name.
    const ensured = await humans.ensureGuestHuman({
      email: SQUATTED_EMAIL,
      name: "Real Buyer",
    });
    expect(ensured).toEqual({ humanId: squatter, created: false });
    const row = await prisma.human.findUniqueOrThrow({ where: { id: squatter } });
    expect(row.name).toBe(SQUATTER_NAME);

    await makeTicketFor(squatter);

    // The ownership fact is unchanged (the ticket email still reveals to
    // the inbox) ...
    await expect(tickets.hasActiveTicketForEvent(eventId, squatter)).resolves.toBe(true);
    // ... but a signed-in unverified viewer gets no holder access ...
    await expect(
      tickets.viewerHoldsActiveTicketForEvent(eventId, squatter),
    ).resolves.toBe(false);
    // ... and the reveal fan-out treats it as unverified.
    await expect(humans.listEmailVerifiedIds([squatter])).resolves.toEqual([]);
  });

  test("shadow guest: no holder access until the address is proven, then full access", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const humans = makeHumansRepo(prisma);
    const tickets = makeTicketsRepo(prisma);

    const shadow = await humans.ensureGuestHuman({
      email: "guest@example.test",
      name: "Guest Buyer",
    });
    expect(shadow.created).toBe(true);
    const shadowRow = await prisma.human.findUniqueOrThrow({
      where: { id: shadow.humanId },
    });
    expect(shadowRow.name).toBe("Guest Buyer");
    await makeTicketFor(shadow.humanId);

    await expect(
      tickets.viewerHoldsActiveTicketForEvent(eventId, shadow.humanId),
    ).resolves.toBe(false);

    // Email code / magic link sign-in flips the flag.
    await prisma.authUser.update({
      where: { email: "guest@example.test" },
      data: { emailVerified: true },
    });

    await expect(
      tickets.viewerHoldsActiveTicketForEvent(eventId, shadow.humanId),
    ).resolves.toBe(true);
    await expect(
      humans.listEmailVerifiedIds([shadow.humanId, shadow.humanId]),
    ).resolves.toEqual([shadow.humanId]);
  });

  test("verified holder keeps access; a non-holder or an account-less Human gets none", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const humans = makeHumansRepo(prisma);
    const tickets = makeTicketsRepo(prisma);

    const verified = await prisma.human.create({
      data: {
        name: "Verified",
        status: "ACTIVE",
        authUser: {
          create: {
            name: "Verified",
            email: "verified@example.test",
            emailVerified: true,
          },
        },
      },
    });
    await makeTicketFor(verified.id);
    const walkup = await prisma.human.create({
      data: { name: "Walk-up", status: "ACTIVE" },
    });
    await makeTicketFor(walkup.id);
    const stranger = await prisma.human.create({
      data: {
        name: "Stranger",
        status: "ACTIVE",
        authUser: {
          create: {
            name: "Stranger",
            email: "stranger@example.test",
            emailVerified: true,
          },
        },
      },
    });

    await expect(
      tickets.viewerHoldsActiveTicketForEvent(eventId, verified.id),
    ).resolves.toBe(true);
    await expect(
      tickets.viewerHoldsActiveTicketForEvent(eventId, stranger.id),
    ).resolves.toBe(false);
    await expect(
      tickets.viewerHoldsActiveTicketForEvent(eventId, walkup.id),
    ).resolves.toBe(false);
    await expect(
      humans.listEmailVerifiedIds([verified.id, walkup.id, stranger.id]),
    ).resolves.toEqual(expect.arrayContaining([verified.id, stranger.id]));
    await expect(
      humans.listEmailVerifiedIds([verified.id, walkup.id]),
    ).resolves.toEqual([verified.id]);
    await expect(humans.listEmailVerifiedIds([])).resolves.toEqual([]);
  });

  test("attendee review eligibility: a scanned ticket on an unverified account does not count", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const reviews = makeAttendeeReviewsRepo(prisma);

    const place = await prisma.place.create({
      data: { name: "The Ember Room", address: "1 Fireside Ln" },
    });
    const pastEvent = await prisma.event.create({
      data: {
        title: "Scanned night",
        startsAt: new Date("2026-09-01T02:00:00.000Z"),
        endsAt: new Date("2026-09-01T05:00:00.000Z"),
        status: "PUBLISHED" as any,
        visibility: "PUBLIC" as any,
        timezone: "America/Chicago",
        placeId: place.id,
      },
    });
    const squatter = await makeUnverifiedPasswordAccount(
      "reviewer-victim@example.test",
      "Squatter",
    );
    const verified = await prisma.human.create({
      data: {
        name: "Real Attendee",
        status: "ACTIVE",
        authUser: {
          create: {
            name: "Real Attendee",
            email: "attendee@example.test",
            emailVerified: true,
          },
        },
      },
    });
    await makeTicketFor(squatter, { eventId: pastEvent.id, status: "SCANNED" });
    await makeTicketFor(verified.id, { eventId: pastEvent.id, status: "SCANNED" });

    await expect(
      reviews.hasScannedTicket({ eventId: pastEvent.id, humanId: squatter }),
    ).resolves.toBe(false);
    await expect(
      reviews.hasScannedTicket({ eventId: pastEvent.id, humanId: verified.id }),
    ).resolves.toBe(true);

    const squatterCandidates = await reviews.listReviewableEventCandidatesForPlace({
      placeId: place.id,
      humanId: squatter,
    });
    expect(squatterCandidates).toEqual([]);
    const verifiedCandidates = await reviews.listReviewableEventCandidatesForPlace({
      placeId: place.id,
      humanId: verified.id,
    });
    expect(verifiedCandidates.map((c) => c.eventId)).toEqual([
      pastEvent.id,
    ]);
  });
});
