import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import type { Repos } from "@th/ports/repos";
import type { BookingRequestAskRecord } from "@th/ports/repos/booking-requests";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../index";

// ---------------------------------------------------------------------------
// ── P3b (asks) ── BookingRequestAsk on REAL Postgres (venue-booking-standards
// v1.1 FR-009b), through the production adapters and `repos.tx`:
//
//   1. The state machine's CASes: answer from OPEN / ANSWERED at the read
//      revision, never from WITHDRAWN or a stale revision; withdraw from OPEN
//      only; a replaced answer clears the other answer columns.
//   2. A concurrent answer vs withdraw on one ask: the first writer holds the
//      row lock inside its transaction; the second blocks, then re-evaluates
//      its WHERE against the committed row and matches nothing. Exactly one
//      wins, in either order.
//   3. The migration's SQL-only CHECKs (answer columns exclusive per kind,
//      minutes 5–600, use-as-event-image IMAGE-only) and the FKs (cascade
//      with the request, SetNull of the answer attachment).
//   4. The V10 stamp is once per (ask, event); `setHeroImageIfEmpty` never
//      replaces a hero.
//
// FK triggers on BookingRequest and Event are disabled so fixtures need no
// Place / Calendar / owner graph (the BookingRequestAsk / Attachment FKs stay
// ENFORCED — they are triggers on those tables, which stay enabled).
// ---------------------------------------------------------------------------

const VENUE = "c2c2c2c2-0000-4000-8000-000000000001";
const ACT = "c2c2c2c2-0000-4000-8000-00000000000a";
const PLACE = "c2c2c2c2-0000-4000-8000-0000000000f1";
const AT = new Date("2026-11-01T12:00:00.000Z");

describe("BookingRequestAsk — the real adapter (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repos: Repos;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.connectionUri });
    await pool.query(`ALTER TABLE "BookingRequest" DISABLE TRIGGER ALL`);
    await pool.query(`ALTER TABLE "Event" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repos = createPrismaRepos(prisma);
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  beforeEach(async () => {
    // The request's own triggers are off (fixtures), so its ON DELETE CASCADE
    // (an RI trigger on the REFERENCED table) does not fire: clear the
    // children first.
    await pool!.query(`DELETE FROM "BookingRequestAsk"`);
    await pool!.query(`DELETE FROM "BookingRequestAttachment"`);
    await pool!.query(`DELETE FROM "BookingRequest"`);
  });

  async function request(): Promise<string> {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "performerOwnerType", "performerOwnerId", "message", "status", "updatedAt")
       VALUES ($1, $2, 'human', $3, 'pitch', 'ACCEPTED', '2026-11-01T00:00:00.000Z')`,
      [id, PLACE, ACT],
    );
    return id;
  }

  async function ask(
    bookingRequestId: string,
    over: Partial<{
      kind: BookingRequestAskRecord["kind"];
      useAsEventImage: boolean;
      askedAt: Date;
    }> = {},
  ) {
    return repos.bookingRequests.createAsk({
      bookingRequestId,
      kind: over.kind ?? "LINK",
      label: "Live video",
      note: null,
      standardField: "LINK_VIDEO",
      useAsEventImage: over.useAsEventImage ?? false,
      askedByHumanId: VENUE,
      askedAt: over.askedAt ?? AT,
    });
  }

  async function file(bookingRequestId: string, askId: string | null) {
    return repos.tx((tx) =>
      tx.bookingRequests.addAttachment({
        bookingRequestId,
        storageKey: `booking-requests/${bookingRequestId}/${crypto.randomUUID()}.jpg`,
        fileName: "poster.jpg",
        contentType: "image/jpeg",
        sizeBytes: 1234,
        uploadedBySide: "PERFORMER",
        uploadedByHumanId: ACT,
        askId,
      }),
    );
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("1. the state machine: OPEN → ANSWERED (replaceable) ; OPEN → WITHDRAWN (final)", async () => {
    const requestId = await request();
    const a = await ask(requestId);
    expect(a).toMatchObject({ status: "OPEN", answerRevision: 0, standardField: "LINK_VIDEO" });

    const answered = await repos.bookingRequests.answerAsk({
      id: a.id,
      bookingRequestId: requestId,
      expectedRevision: 0,
      answer: { kind: "url", url: "https://video.test/a" },
      answeredByHumanId: ACT,
      answeredAt: AT,
    });
    expect(answered).toMatchObject({ status: "ANSWERED", answerUrl: "https://video.test/a", answerRevision: 1 });

    // A stale revision (another answer landed) matches nothing.
    await expect(
      repos.bookingRequests.answerAsk({
        id: a.id,
        bookingRequestId: requestId,
        expectedRevision: 0,
        answer: { kind: "url", url: "https://video.test/stale" },
        answeredByHumanId: ACT,
        answeredAt: AT,
      }),
    ).resolves.toBeNull();
    // Another request's id never matches (IDOR backstop).
    await expect(
      repos.bookingRequests.answerAsk({
        id: a.id,
        bookingRequestId: await request(),
        expectedRevision: 1,
        answer: { kind: "url", url: "https://video.test/x" },
        answeredByHumanId: ACT,
        answeredAt: AT,
      }),
    ).resolves.toBeNull();
    // Replace at the current revision.
    await expect(
      repos.bookingRequests.answerAsk({
        id: a.id,
        bookingRequestId: requestId,
        expectedRevision: 1,
        answer: { kind: "url", url: "https://video.test/b" },
        answeredByHumanId: ACT,
        answeredAt: AT,
      }),
    ).resolves.toMatchObject({ answerUrl: "https://video.test/b", answerRevision: 2 });

    // ANSWERED cannot be withdrawn.
    await expect(
      repos.bookingRequests.withdrawAsk({ id: a.id, bookingRequestId: requestId, withdrawnByHumanId: VENUE, withdrawnAt: AT }),
    ).resolves.toBeNull();

    const b = await ask(requestId, { askedAt: new Date(AT.getTime() + 60_000) });
    await expect(
      repos.bookingRequests.withdrawAsk({ id: b.id, bookingRequestId: requestId, withdrawnByHumanId: VENUE, withdrawnAt: AT }),
    ).resolves.toMatchObject({ status: "WITHDRAWN", withdrawnByHumanId: VENUE });
    // WITHDRAWN is final: neither a second withdraw nor an answer matches.
    await expect(
      repos.bookingRequests.withdrawAsk({ id: b.id, bookingRequestId: requestId, withdrawnByHumanId: VENUE, withdrawnAt: AT }),
    ).resolves.toBeNull();
    await expect(
      repos.bookingRequests.answerAsk({
        id: b.id,
        bookingRequestId: requestId,
        expectedRevision: 0,
        answer: { kind: "url", url: "https://video.test/late" },
        answeredByHumanId: ACT,
        answeredAt: AT,
      }),
    ).resolves.toBeNull();

    expect((await repos.bookingRequests.listAsks(requestId)).map((x) => x.status)).toEqual([
      "ANSWERED",
      "WITHDRAWN",
    ]);
  });

  test("2a. answer vs withdraw, answer first: the withdraw waits on the row, then matches nothing", async () => {
    const requestId = await request();
    const a = await ask(requestId);

    let answerWrote!: () => void;
    const answerHasLock = new Promise<void>((r) => (answerWrote = r));
    const answering = repos.tx(async (tx) => {
      const out = await tx.bookingRequests.answerAsk({
        id: a.id,
        bookingRequestId: requestId,
        expectedRevision: 0,
        answer: { kind: "url", url: "https://video.test/a" },
        answeredByHumanId: ACT,
        answeredAt: AT,
      });
      answerWrote();
      await sleep(400); // hold the row lock
      return out;
    });
    await answerHasLock;
    const withdrawing = repos.tx((tx) =>
      tx.bookingRequests.withdrawAsk({ id: a.id, bookingRequestId: requestId, withdrawnByHumanId: VENUE, withdrawnAt: AT }),
    );
    const [answered, withdrawn] = await Promise.all([answering, withdrawing]);

    expect(answered?.status).toBe("ANSWERED");
    expect(withdrawn).toBeNull();
    expect((await repos.bookingRequests.getAsk({ id: a.id, bookingRequestId: requestId }))?.status).toBe(
      "ANSWERED",
    );
  });

  test("2b. answer vs withdraw, withdraw first: the answer waits, then matches nothing", async () => {
    const requestId = await request();
    const a = await ask(requestId);

    let withdrawWrote!: () => void;
    const withdrawHasLock = new Promise<void>((r) => (withdrawWrote = r));
    const withdrawing = repos.tx(async (tx) => {
      const out = await tx.bookingRequests.withdrawAsk({
        id: a.id,
        bookingRequestId: requestId,
        withdrawnByHumanId: VENUE,
        withdrawnAt: AT,
      });
      withdrawWrote();
      await sleep(400);
      return out;
    });
    await withdrawHasLock;
    const answering = repos.tx((tx) =>
      tx.bookingRequests.answerAsk({
        id: a.id,
        bookingRequestId: requestId,
        expectedRevision: 0,
        answer: { kind: "url", url: "https://video.test/a" },
        answeredByHumanId: ACT,
        answeredAt: AT,
      }),
    );
    const [withdrawn, answered] = await Promise.all([withdrawing, answering]);

    expect(withdrawn?.status).toBe("WITHDRAWN");
    expect(answered).toBeNull();
    const final = await repos.bookingRequests.getAsk({ id: a.id, bookingRequestId: requestId });
    expect(final).toMatchObject({ status: "WITHDRAWN", answerUrl: null, answerRevision: 0 });
  });

  test("2c. two answers at once from the same revision: one wins", async () => {
    const requestId = await request();
    const a = await ask(requestId);
    const one = (url: string) =>
      repos.tx(async (tx) => {
        const out = await tx.bookingRequests.answerAsk({
          id: a.id,
          bookingRequestId: requestId,
          expectedRevision: 0,
          answer: { kind: "url", url },
          answeredByHumanId: ACT,
          answeredAt: AT,
        });
        await sleep(200);
        return out;
      });
    const results = await Promise.all([one("https://video.test/1"), one("https://video.test/2")]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await repos.bookingRequests.getAsk({ id: a.id, bookingRequestId: requestId }))?.answerRevision).toBe(1);
  });

  test("3. CHECKs: answer columns exclusive per kind, minutes 5–600, use-as-event-image IMAGE-only", async () => {
    const requestId = await request();
    const insert = (kind: string, cols: Record<string, unknown>) => {
      const names = Object.keys(cols);
      return pool!.query(
        `INSERT INTO "BookingRequestAsk"
           ("id", "bookingRequestId", "kind", "label", "askedByHumanId", "updatedAt"${names.map((n) => `, "${n}"`).join("")})
         VALUES ($1, $2, $3::"BookingRequestAskKind", 'x', $4, now()${names.map((_, i) => `, $${i + 5}`).join("")})`,
        [crypto.randomUUID(), requestId, kind, VENUE, ...Object.values(cols)],
      );
    };
    await expect(insert("LINK", { answerText: "not a url column" })).rejects.toThrow(/answer_shape_check/);
    await expect(insert("TEXT", { answerUrl: "https://x.test" })).rejects.toThrow(/answer_shape_check/);
    await expect(insert("IMAGE", { answerMinutes: 45 })).rejects.toThrow(/answer_shape_check/);
    await expect(insert("SET_LENGTH", { answerMinutes: 4 })).rejects.toThrow(/answer_shape_check/);
    await expect(insert("SET_LENGTH", { answerMinutes: 601 })).rejects.toThrow(/answer_shape_check/);
    await expect(insert("FILE", { useAsEventImage: true })).rejects.toThrow(/use_as_event_image_check/);
    await expect(insert("SET_LENGTH", { answerMinutes: 45 })).resolves.toBeTruthy();
    await expect(insert("IMAGE", { useAsEventImage: true })).resolves.toBeTruthy();

    // An answer through the adapter that does not fit the kind is refused by
    // the DB too (the use case refuses first; this is the backstop).
    const link = await ask(requestId, { kind: "LINK" });
    await expect(
      repos.bookingRequests.answerAsk({
        id: link.id,
        bookingRequestId: requestId,
        expectedRevision: 0,
        answer: { kind: "minutes", minutes: 45 },
        answeredByHumanId: ACT,
        answeredAt: AT,
      }),
    ).rejects.toBeTruthy();
  });

  test("3b. FKs: an answer file is SetNull'd on delete; the request cascades its asks and files; getAttachment is request-scoped", async () => {
    const requestId = await request();
    const img = await ask(requestId, { kind: "IMAGE", useAsEventImage: true });
    const poster = await file(requestId, img.id);
    expect(poster.askId).toBe(img.id);
    await expect(
      repos.bookingRequests.getAttachment({ id: poster.id, bookingRequestId: await request() }),
    ).resolves.toBeNull();
    await expect(
      repos.bookingRequests.getAttachment({ id: poster.id, bookingRequestId: requestId }),
    ).resolves.toMatchObject({ id: poster.id, askId: img.id });

    await repos.bookingRequests.answerAsk({
      id: img.id,
      bookingRequestId: requestId,
      expectedRevision: 0,
      answer: { kind: "attachment", attachmentId: poster.id },
      answeredByHumanId: ACT,
      answeredAt: AT,
    });
    await pool!.query(`DELETE FROM "BookingRequestAttachment" WHERE "id" = $1`, [poster.id]);
    expect(
      (await repos.bookingRequests.getAsk({ id: img.id, bookingRequestId: requestId }))?.answerAttachmentId,
    ).toBeNull();

    await file(requestId, img.id);
    // The cascade is an RI trigger on the referenced table: on for the delete.
    await pool!.query(`ALTER TABLE "BookingRequest" ENABLE TRIGGER ALL`);
    try {
      await pool!.query(`DELETE FROM "BookingRequest" WHERE "id" = $1`, [requestId]);
    } finally {
      await pool!.query(`ALTER TABLE "BookingRequest" DISABLE TRIGGER ALL`);
    }
    const left = await pool!.query(
      `SELECT (SELECT count(*) FROM "BookingRequestAsk" WHERE "bookingRequestId" = $1)::int AS asks,
              (SELECT count(*) FROM "BookingRequestAttachment" WHERE "bookingRequestId" = $1)::int AS files`,
      [requestId],
    );
    expect(left.rows[0]).toEqual({ asks: 0, files: 0 });
  });

  // ── review W6 ── the two FKs point at each other (ask.answerAttachmentId →
  // attachment, attachment.askId → ask, both SetNull) while both rows hang off
  // the request by CASCADE. Deleting the request must not trip either FK (or
  // the answer-shape CHECK the SetNull lands on) and must leave nothing.
  test("3c. a request whose ANSWERED IMAGE ask and its answer file reference each other cascades cleanly", async () => {
    const requestId = await request();
    const img = await ask(requestId, { kind: "IMAGE", useAsEventImage: true });
    const poster = await file(requestId, img.id);
    const answered = await repos.bookingRequests.answerAsk({
      id: img.id,
      bookingRequestId: requestId,
      expectedRevision: 0,
      answer: { kind: "attachment", attachmentId: poster.id },
      answeredByHumanId: ACT,
      answeredAt: AT,
    });
    expect(answered).toMatchObject({ status: "ANSWERED", answerAttachmentId: poster.id });
    const linked = await pool!.query(
      `SELECT a."answerAttachmentId", f."askId"
         FROM "BookingRequestAsk" a JOIN "BookingRequestAttachment" f ON f."id" = a."answerAttachmentId"
        WHERE a."id" = $1`,
      [img.id],
    );
    expect(linked.rows[0]).toEqual({ answerAttachmentId: poster.id, askId: img.id });

    // The cascade is an RI trigger on the referenced table: on for the delete.
    await pool!.query(`ALTER TABLE "BookingRequest" ENABLE TRIGGER ALL`);
    try {
      await expect(
        pool!.query(`DELETE FROM "BookingRequest" WHERE "id" = $1`, [requestId]),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await pool!.query(`ALTER TABLE "BookingRequest" DISABLE TRIGGER ALL`);
    }
    const left = await pool!.query(
      `SELECT (SELECT count(*) FROM "BookingRequest" WHERE "id" = $1)::int AS requests,
              (SELECT count(*) FROM "BookingRequestAsk" WHERE "id" = $2)::int AS asks,
              (SELECT count(*) FROM "BookingRequestAttachment" WHERE "id" = $3)::int AS files`,
      [requestId, img.id, poster.id],
    );
    expect(left.rows[0]).toEqual({ requests: 0, asks: 0, files: 0 });
  });

  test("4. the V10 stamp is once per (ask, event); setHeroImageIfEmpty never replaces a hero", async () => {
    const requestId = await request();
    const img = await ask(requestId, { kind: "IMAGE", useAsEventImage: true });
    const poster = await file(requestId, img.id);
    await repos.bookingRequests.answerAsk({
      id: img.id,
      bookingRequestId: requestId,
      expectedRevision: 0,
      answer: { kind: "attachment", attachmentId: poster.id },
      answeredByHumanId: ACT,
      answeredAt: AT,
    });

    const eventA = crypto.randomUUID();
    const eventB = crypto.randomUUID();
    const stamp = (eventId: string, attachmentId = poster.id, bookingRequestId = requestId) =>
      repos.bookingRequests.stampAskEventImage({
        id: img.id,
        bookingRequestId,
        attachmentId,
        eventId,
        imageId: crypto.randomUUID(),
      });
    // Another request's id never matches (IDOR backstop in the WHERE).
    expect(await stamp(eventA, poster.id, await request())).toBe(false);
    expect(await stamp(eventA)).toBe(true);
    expect(await stamp(eventA)).toBe(false); // once per (ask, event)
    expect(await stamp(eventB)).toBe(true); // a new event (draft replaced) maps again
    expect(await stamp(eventA, crypto.randomUUID())).toBe(false); // not the answer file

    for (const id of [eventA]) {
      await pool!.query(
        `INSERT INTO "Event" (id, title, "startsAt", "endsAt", status, "humanId", "updatedAt")
         VALUES ($1, 'Friday', $2, $2, 'DRAFT', $3, '2026-11-01T00:00:00.000Z')`,
        [id, AT.toISOString(), ACT],
      );
    }
    const first = crypto.randomUUID();
    expect(await repos.events.setHeroImageIfEmpty({ eventId: eventA, imageId: first })).toBe(true);
    expect(
      await repos.events.setHeroImageIfEmpty({ eventId: eventA, imageId: crypto.randomUUID() }),
    ).toBe(false);
    const hero = await pool!.query(`SELECT "hero_image_id" AS id FROM "Event" WHERE "id" = $1`, [eventA]);
    expect(hero.rows[0].id).toBe(first);
    expect(
      await repos.events.setHeroImageIfEmpty({ eventId: crypto.randomUUID(), imageId: first }),
    ).toBe(false);
  });
});
