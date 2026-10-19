import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeBookingRequestMessagesRepo } from "../booking-request-messages";

// ---------------------------------------------------------------------------
// Real-Postgres coverage for `countUnreadByRequest` / `markRead`
// (booking-conversation FR-001, plus the system-entry ledger). The fake-Prisma
// sibling asserts the query SHAPE; this file asserts what that shape actually
// SELECTS, because the load-bearing semantics are SQL-level:
//
//   - `authorSide NOT IN ($side, 'SYSTEM')` is a THREE-valued enum comparison.
//     SYSTEM rows must fall OUT of it for BOTH parties — the ledger is not
//     mail, so an entry never badges an inbox. This INVERTS the original
//     `authorSide <> $side` rule (which counted them), and it is exactly the
//     sort of thing a well-meaning "simplify back to <>" refactor would
//     quietly undo.
//   - `readAt IS NULL` — a NULL comparison, the classic place where an
//     `!= <date>` rewrite silently drops every unread row.
//   - grouped counts emit NO row for an empty group, which is why the port
//     contract says callers must zero-fill.
//   - `systemKind` / `systemData` must survive the round trip, or the timeline
//     has nothing to render.
//
// THE DDL IS READ FROM THE SHIPPED MIGRATION BYTES, NOT RETYPED HERE (house
// precedent: payee-ledger-payable / fee-policies-one-active-per-scope). The
// load-bearing properties above are SCHEMA properties — a three-valued enum, a
// nullable `readAt`, a jsonb `systemData` — so retyping them would let this
// suite keep passing against a table the product no longer has.
// `statementFrom` throws (loudly, not skips) if the statement it wants has
// moved, which is the signal to re-point this file at the newer migration.
//
// TWO migrations are read: the CREATE from the venue-hierarchy migration and
// the system-entry ALTER that added the ledger columns. Only the statements
// this table needs are lifted; the FK to BookingRequest is deliberately left
// behind so the table is self-contained. Caveat: a THIRD migration altering
// this table would need adding here too — reading from disk removes the
// retyping drift, not all drift.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../db/prisma/migrations",
);

const CREATE_MIGRATION_SQL = readFileSync(
  resolve(
    MIGRATIONS_DIR,
    "20260818120000_venue_hierarchy_rooms_calendars/migration.sql",
  ),
  "utf8",
);

const SYSTEM_ENTRY_MIGRATION_SQL = readFileSync(
  resolve(
    MIGRATIONS_DIR,
    "20260821120000_booking_request_message_system_entries/migration.sql",
  ),
  "utf8",
);

/**
 * Lift one `;`-terminated statement out of a migration by its opening text.
 * None of the statements taken here contains an inner `;`.
 */
function statementFrom(sql: string, startsWith: string): string {
  const start = sql.indexOf(startsWith);
  if (start === -1) {
    throw new Error(
      `Migration DDL not found: ${startsWith}. The schema moved — re-point this test at the migration that owns it. Do NOT retype the DDL here.`,
    );
  }
  const end = sql.indexOf(";", start);
  if (end === -1) {
    throw new Error(`Unterminated statement in migration: ${startsWith}`);
  }
  return sql.slice(start, end + 1);
}

const TABLE_SQL = [
  statementFrom(CREATE_MIGRATION_SQL, `CREATE TYPE "BookingMessageAuthorSide"`),
  statementFrom(CREATE_MIGRATION_SQL, `CREATE TABLE "BookingRequestMessage" (`),
  statementFrom(
    CREATE_MIGRATION_SQL,
    `CREATE INDEX "BookingRequestMessage_bookingRequestId_`,
  ),
  statementFrom(
    SYSTEM_ENTRY_MIGRATION_SQL,
    `ALTER TABLE "BookingRequestMessage" ADD COLUMN`,
  ),
].join("\n\n");

const REQUEST_A = "44444444-4444-4444-8444-444444444444";
const REQUEST_B = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
const REQUEST_C = "4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c";
/** Not in any queried page — proves the `IN` scope actually scopes. */
const REQUEST_OTHER = "4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f";

describe("bookingRequestMessages.countUnreadByRequest (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "BookingRequestMessage"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  let seq = 0;
  async function insertMessage(
    bookingRequestId: string,
    authorSide: "VENUE" | "PERFORMER" | "SYSTEM",
    readAt: Date | null = null,
  ) {
    seq += 1;
    await pool!.query(
      `INSERT INTO "BookingRequestMessage"
         ("id", "bookingRequestId", "authorSide", "body", "readAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [`msg-${seq}`, bookingRequestId, authorSide, "hello", readAt],
    );
  }

  /** A ledger entry: SYSTEM-sided, empty body, kind + params. */
  async function insertSystemEntry(
    bookingRequestId: string,
    systemKind: string,
    systemData: Record<string, unknown>,
  ) {
    seq += 1;
    const id = `msg-${seq}`;
    await pool!.query(
      `INSERT INTO "BookingRequestMessage"
         ("id", "bookingRequestId", "authorSide", "body", "systemKind", "systemData")
       VALUES ($1, $2, 'SYSTEM', '', $3, $4)`,
      [id, bookingRequestId, systemKind, JSON.stringify(systemData)],
    );
    return id;
  }

  const repo = () => makeBookingRequestMessagesRepo(prisma!);

  // INVERTED with the system-entry migration. This test previously asserted
  // "SYSTEM messages count as unread for a side that has not stamped them".
  // They must not: unread means "a human is waiting on you", and every
  // lifecycle transition is now a SYSTEM entry, so counting them would badge
  // both inboxes for actions the viewer took themselves.
  test("SYSTEM entries NEVER count as unread, for either side", async () => {
    await insertSystemEntry(REQUEST_A, "booking_agreement.accepted", {
      agreementId: "55555555-5555-4555-8555-555555555555",
      actorSide: "VENUE",
    });

    const forVenue = await repo().countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "VENUE",
    });
    const forPerformer = await repo().countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "PERFORMER",
    });

    // Absent, not zero — the port's zero-fill contract.
    expect(forVenue.has(REQUEST_A)).toBe(false);
    expect(forPerformer.has(REQUEST_A)).toBe(false);
  });

  test("markRead never stamps a SYSTEM entry (no receipt for an unreadable row)", async () => {
    const entryId = await insertSystemEntry(
      REQUEST_A,
      "booking_request.viewed",
      {},
    );
    await insertMessage(REQUEST_A, "PERFORMER");

    const stamped = await repo().markRead({
      bookingRequestId: REQUEST_A,
      side: "VENUE",
      upToCreatedAt: new Date("2999-01-01T00:00:00Z"),
    });

    // Only the human message.
    expect(stamped).toBe(1);
    const { rows } = await pool!.query<{ readAt: Date | null }>(
      `SELECT "readAt" FROM "BookingRequestMessage" WHERE "id" = $1`,
      [entryId],
    );
    expect(rows[0]?.readAt).toBeNull();
  });

  test("listForRequest carries systemKind and systemData through to the DTO", async () => {
    await insertMessage(REQUEST_A, "PERFORMER");
    await insertSystemEntry(REQUEST_A, "booking_event.created", {
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agreementId: null,
      startsAt: "2026-07-10T02:00:00.000Z",
    });

    const page = await repo().listForRequest({ bookingRequestId: REQUEST_A });

    expect(page.items).toHaveLength(2);
    const [human, entry] = page.items;
    // A human message carries neither column.
    expect(human?.systemKind).toBeNull();
    expect(human?.systemData).toBeNull();
    // The entry round-trips its params out of jsonb, ISO strings intact.
    expect(entry?.authorSide).toBe("SYSTEM");
    expect(entry?.body).toBe("");
    expect(entry?.systemKind).toBe("booking_event.created");
    expect(entry?.systemData).toEqual({
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agreementId: null,
      startsAt: "2026-07-10T02:00:00.000Z",
    });
  });

  test("non-object systemData is guarded to null rather than cast", async () => {
    // The column is jsonb, which also admits arrays and scalars. A row like
    // this should never exist (the append helper only writes `.strict()`
    // objects) but the mapper must not hand a renderer an array typed as an
    // object.
    seq += 1;
    await pool!.query(
      `INSERT INTO "BookingRequestMessage"
         ("id", "bookingRequestId", "authorSide", "body", "systemKind", "systemData")
       VALUES ($1, $2, 'SYSTEM', '', 'booking_request.viewed', '[1,2]'::jsonb)`,
      [`msg-${seq}`, REQUEST_A],
    );

    const page = await repo().listForRequest({ bookingRequestId: REQUEST_A });

    expect(page.items[0]?.systemKind).toBe("booking_request.viewed");
    expect(page.items[0]?.systemData).toBeNull();
  });

  test("an unknown systemKind reads back verbatim instead of throwing", async () => {
    // Forward compatibility: a row written by a newer build must not break a
    // read on an older one. Renderers narrow with `isBookingSystemEntryKind`
    // and skip what they do not recognize.
    await insertSystemEntry(REQUEST_A, "booking_hold.placed", { holdId: "x" });

    const page = await repo().listForRequest({ bookingRequestId: REQUEST_A });

    expect(page.items[0]?.systemKind).toBe("booking_hold.placed");
  });

  test("counts the counterparty's unread rows, never the viewer's own", async () => {
    await insertMessage(REQUEST_A, "PERFORMER");
    await insertMessage(REQUEST_A, "PERFORMER");
    await insertMessage(REQUEST_A, "VENUE"); // the venue's own, unread by act
    await insertMessage(
      REQUEST_A,
      "PERFORMER",
      new Date("2026-06-05T00:00:00Z"),
    );

    const forVenue = await repo().countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "VENUE",
    });
    const forPerformer = await repo().countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "PERFORMER",
    });

    expect(forVenue.get(REQUEST_A)).toBe(2);
    expect(forPerformer.get(REQUEST_A)).toBe(1);
  });

  test("batches the whole page in one map, omitting quiet requests", async () => {
    await insertMessage(REQUEST_A, "PERFORMER");
    // A ledger entry sitting next to real mail must not inflate the badge.
    await insertMessage(REQUEST_C, "SYSTEM");
    await insertMessage(REQUEST_C, "PERFORMER");
    // REQUEST_B is quiet; REQUEST_OTHER is loud but off-page.
    await insertMessage(REQUEST_OTHER, "PERFORMER");

    const counts = await repo().countUnreadByRequest({
      bookingRequestIds: [REQUEST_A, REQUEST_B, REQUEST_C],
      side: "VENUE",
    });

    expect(counts.get(REQUEST_A)).toBe(1);
    // Absent, not 0 — the contract callers zero-fill against.
    expect(counts.has(REQUEST_B)).toBe(false);
    // The human message only; the SYSTEM row does not count.
    expect(counts.get(REQUEST_C)).toBe(1);
    // The IN scope must not leak another page's request.
    expect(counts.has(REQUEST_OTHER)).toBe(false);
  });

  // The at-most-once guard the expiry sweep leans on. Two SQL-level properties
  // matter and neither is visible in the fake-Prisma sibling: the probe must be
  // scoped to ONE request (a `booking_request.expired` on someone else's thread
  // must not suppress this one's entry), and a NULL `systemKind` — every human
  // message — must never match.
  test("hasSystemEntry is scoped to the request and ignores human messages", async () => {
    await insertSystemEntry(REQUEST_A, "booking_request.expired", {
      expiresAt: "2026-06-09T12:00:00.000Z",
    });
    // A human message on the thread we are about to ask about.
    await insertMessage(REQUEST_B, "PERFORMER");

    await expect(
      repo().hasSystemEntry({
        bookingRequestId: REQUEST_A,
        kind: "booking_request.expired",
      }),
    ).resolves.toBe(true);
    // Same thread, DIFFERENT kind.
    await expect(
      repo().hasSystemEntry({
        bookingRequestId: REQUEST_A,
        kind: "booking_request.withdrawn",
      }),
    ).resolves.toBe(false);
    // Another thread entirely — a neighbour's entry must not leak in.
    await expect(
      repo().hasSystemEntry({
        bookingRequestId: REQUEST_B,
        kind: "booking_request.expired",
      }),
    ).resolves.toBe(false);
  });

  test("markRead then recount reads zero (the badge and the thread agree)", async () => {
    await insertMessage(REQUEST_A, "PERFORMER");
    await insertMessage(REQUEST_A, "SYSTEM");
    await insertMessage(REQUEST_A, "VENUE");

    const before = await repo().countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "VENUE",
    });
    // The act's message only — never the venue's own, never the SYSTEM row.
    expect(before.get(REQUEST_A)).toBe(1);

    const stamped = await repo().markRead({
      bookingRequestId: REQUEST_A,
      side: "VENUE",
      upToCreatedAt: new Date("2999-01-01T00:00:00Z"),
    });
    // markRead stamps EXACTLY what the count counted — the invariant.
    expect(stamped).toBe(1);

    const after = await repo().countUnreadByRequest({
      bookingRequestIds: [REQUEST_A],
      side: "VENUE",
    });
    expect(after.has(REQUEST_A)).toBe(false);
  });
});
