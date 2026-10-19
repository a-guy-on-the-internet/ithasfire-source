/**
 * The people cache and its search index, run as REAL SQL.
 *
 * `local-db.ts` executes against Node's built-in SQLite through the adapter in
 * `test/harness/expo-sqlite-on-node.ts`. That is a desktop SQLite, not the
 * phone's: these tests show what SQLite does with each statement, and nothing
 * about a device.
 *
 * Why real SQL: `people_fts` is a contentless FTS5 table, and SQLite refuses
 * every `DELETE` on one. The old code deleted from it inside a try/catch, so
 * each wipe left the tokens of every cached name and email in the index, and
 * a second manifest sync threw. No mock would have shown either.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite", () => import("../../test/harness/expo-sqlite-on-node"));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/react-native", () => ({
  captureException: sentry.captureException,
  addBreadcrumb: vi.fn(),
}));

type LocalDb = typeof import("./local-db");
type Harness = typeof import("../../test/harness/expo-sqlite-on-node");

let db: LocalDb;
let harness: Harness;

const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

const KEPT = "evt-kept";
const GONE = "evt-gone";

const sam = {
  humanId: "h-sam",
  displayName: "Sam Keeper",
  email: "Sam@Kept.test",
  kind: "attendee" as const,
};
const jo = {
  humanId: "h-jo",
  displayName: "Jo Leaver",
  email: "jo@gone.test",
  kind: "attendee" as const,
};

/** Every token the search index holds, read through `fts5vocab`. */
const indexedTerms = (): string[] => {
  const raw = harness.rawDatabase();
  raw.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS people_vocab USING fts5vocab(people_fts, 'row');",
  );
  return (
    raw.prepare("SELECT term FROM people_vocab ORDER BY term").all() as Array<{
      term: string;
    }>
  ).map((r) => r.term);
};

const peopleRowCount = (): number =>
  (
    harness.rawDatabase().prepare("SELECT count(*) AS n FROM people").get() as {
      n: number;
    }
  ).n;

const names = (eventId: string, query: string): Array<string | null> =>
  db.searchPeople(eventId, query).map((p) => p.displayName);

/** A fresh module graph: `local-db.ts` opens its database again. */
const launch = async () => {
  vi.resetModules();
  db = await import("./local-db");
  harness = await import("../../test/harness/expo-sqlite-on-node");
};

/** Scratch directories of the file-backed tests, removed after each. */
const scratch: string[] = [];
/** Open the next launches from a real file, as the app does. */
const useDatabaseOnDisk = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "scanner-local-db-"));
  scratch.push(dir);
  const file = join(dir, "scanner.db");
  harness.useDatabaseFile(file);
  return file;
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  sentry.captureException.mockReset();
  await launch();
});

afterEach(() => {
  vi.useRealTimers();
  harness.refuseStatements(null);
  harness.useDatabaseFile(null);
  for (const dir of scratch.splice(0)) {
    try {
      harness.rawDatabase().close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const rowCount = (table: string): number =>
  (
    harness
      .rawDatabase()
      .prepare(`SELECT count(*) AS n FROM ${table}`)
      .get() as { n: number }
  ).n;

/** One row in every table the app creates, the way the app writes them. */
const seedEveryTable = () => {
  seedBothEvents();
  db.upsertEvents([
    {
      eventId: KEPT,
      eventName: "Kept",
      orgId: "org-1",
      startAt: null,
      endAt: null,
      status: "PUBLISHED",
      role: "SCANNER",
      lat: null,
      lng: null,
    },
  ]);
  db.upsertTickets([
    {
      ticketId: "t-1",
      code: "TKT-1",
      eventId: KEPT,
      status: "VALID",
      ownerHuman: "h-sam",
      scannedAt: null,
      ticketTypeName: "GA",
      orderId: null,
    },
  ]);
  db.recordRecentScan({
    eventId: KEPT,
    ticketCode: "TKT-1",
    ticketId: "t-1",
    holderDisplay: "Sam Keeper",
    kind: "ticket",
  });
  db.enqueueScan({ eventId: KEPT, ticketCode: "TKT-3", clientKey: "key-3" });
  // Recording the drop takes this one out of the queue: one row in each.
  const queued = db.enqueueScan({
    eventId: KEPT,
    ticketCode: "TKT-2",
    clientKey: "key-2",
  });
  db.recordDroppedScan({
    queueId: queued.queueId,
    eventId: KEPT,
    ticketCode: "TKT-2",
    clientKey: "key-2",
    enqueuedAt: queued.enqueuedAt,
    attempts: 8,
    reason: "max_attempts",
    lastError: null,
  });
};
const ATTENDEE_TABLES = ["people", "tickets", "events", "recent_scans"];

const seedBothEvents = () => {
  db.upsertPeople(KEPT, [sam]);
  db.upsertPeople(GONE, [jo]);
};

describe("the harness runs the real index (guards every test below)", () => {
  it("has FTS5, and search goes through it", () => {
    expect(db.isFtsAvailable()).toBe(true);
    seedBothEvents();
    expect(indexedTerms()).toEqual(
      expect.arrayContaining(["sam", "keeper", "kept", "jo", "leaver", "gone"]),
    );
    expect(names(KEPT, "keep")).toEqual(["Sam Keeper"]);
  });

  it("SQLite refuses a DELETE on the contentless index", () => {
    seedBothEvents();
    expect(() =>
      harness.rawDatabase().exec("DELETE FROM people_fts;"),
    ).toThrow(/cannot DELETE from contentless fts5 table/);
  });
});

describe("clearAll (sign-out)", () => {
  it("empties every table the app creates, and the search index", () => {
    seedEveryTable();
    for (const table of [...ATTENDEE_TABLES, "scan_queue", "dropped_scans"]) {
      expect(rowCount(table), `${table} was not seeded`).toBeGreaterThan(0);
    }

    db.clearAll();

    // Asked of SQLite itself, so a table added to `migrate()` and forgotten in
    // the wipe fails here once this test seeds it.
    const tables = (
      harness
        .rawDatabase()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'people_fts%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([...ATTENDEE_TABLES, "scan_queue", "dropped_scans"]),
    );
    for (const table of tables) expect(rowCount(table), table).toBe(0);
    expect(indexedTerms()).toEqual([]);
    expect(names(KEPT, "keep")).toEqual([]);
  });

  it("one failing table does not save the others, and the failure is thrown", () => {
    seedEveryTable();
    harness.rawDatabase().exec("DROP TABLE tickets;");

    expect(() => db.clearAll()).toThrow(/no such table: tickets/);

    for (const table of ["people", "events", "recent_scans", "scan_queue", "dropped_scans"]) {
      expect(rowCount(table), table).toBe(0);
    }
    expect(indexedTerms()).toEqual([]);
  });

  it("throws when the index cannot be emptied, after the rows are gone", () => {
    seedBothEvents();
    harness.rawDatabase().exec("DROP TABLE people_fts;");
    expect(() => db.clearAll()).toThrow();
    expect(peopleRowCount()).toBe(0);
  });
});

describe("clearAttendeeData (access denied)", () => {
  it("removes the attendee data and the index, and leaves the scan queue", () => {
    seedEveryTable();
    const queued = db.listQueuedScans();
    const dropped = db.listDroppedScans();
    expect(queued).toHaveLength(1);
    expect(dropped).toHaveLength(1);

    db.clearAttendeeData();

    for (const table of ATTENDEE_TABLES) expect(rowCount(table), table).toBe(0);
    expect(indexedTerms()).toEqual([]);
    expect(db.listQueuedScans()).toEqual(queued);
    expect(db.listDroppedScans()).toEqual(dropped);
  });

  it("the tables it leaves hold no name or email column", () => {
    const columns = (table: string) =>
      (
        harness
          .rawDatabase()
          .prepare(`SELECT name FROM pragma_table_info('${table}')`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
    expect(columns("scan_queue").sort()).toEqual(
      [
        "attempts",
        "client_key",
        "enqueued_at",
        "event_id",
        "last_error",
        "next_attempt_at",
        "queue_id",
        "ticket_code",
      ].sort(),
    );
    expect(columns("dropped_scans").sort()).toEqual(
      [
        "attempts",
        "client_key",
        "drop_id",
        "dropped_at",
        "enqueued_at",
        "event_id",
        "last_error",
        "queue_id",
        "reason",
        "ticket_code",
      ].sort(),
    );
  });

  it("one failing table does not save the others, and the failure is thrown", () => {
    seedEveryTable();
    harness.rawDatabase().exec("DROP TABLE events;");

    expect(() => db.clearAttendeeData()).toThrow(/no such table: events/);

    for (const table of ["people", "tickets", "recent_scans"]) {
      expect(rowCount(table), table).toBe(0);
    }
    expect(indexedTerms()).toEqual([]);
    expect(db.countQueuedScans()).toBe(1);
    expect(db.countDroppedScans()).toBe(1);
  });
});

describe("what a wipe leaves in the database file", () => {
  const bytesHold = (file: string, text: string) =>
    existsSync(file) &&
    readFileSync(file).toString("latin1").toLowerCase().includes(text);

  for (const wipe of ["clearAll", "clearAttendeeData"] as const) {
    it(`${wipe}: no name or email bytes in the file or its write-ahead log`, async () => {
      const file = useDatabaseOnDisk();
      await launch();
      // Enough rows that deleted ones would sit on pages of their own.
      db.upsertPeople(
        GONE,
        Array.from({ length: 400 }, (_, i) => ({
          humanId: `h-${i}`,
          displayName: `Zebedee Quillfeather${i}`,
          email: `zebedee${i}@quillfeather.test`,
          kind: "attendee" as const,
        })),
      );
      expect(
        bytesHold(file, "quillfeather") || bytesHold(`${file}-wal`, "quillfeather"),
      ).toBe(true);

      db[wipe]();

      expect(bytesHold(file, "quillfeather")).toBe(false);
      expect(bytesHold(`${file}-wal`, "quillfeather")).toBe(false);
      expect(statSync(`${file}-wal`).size).toBe(0);
      expect(sentry.captureException).not.toHaveBeenCalled();
    });
  }
});

describe("every launch rebuilds the index", () => {
  it("clears entries an older build left behind for people long dropped", async () => {
    useDatabaseOnDisk();
    await launch();
    db.upsertPeople(KEPT, [sam]);
    // What `dropPeopleForEvent` used to leave: the row gone, its entry not.
    harness
      .rawDatabase()
      .exec(
        "INSERT INTO people_fts (rowid, display_name, email_lower) VALUES (9001, 'Ghost Orphan', 'ghost@old.test');",
      );
    expect(indexedTerms()).toContain("orphan");
    harness.rawDatabase().exec("DROP TABLE people_vocab;");
    harness.rawDatabase().close();

    await launch();
    expect(db.isFtsAvailable()).toBe(true);

    expect(indexedTerms()).not.toContain("orphan");
    expect(indexedTerms()).not.toContain("ghost");
    expect(names(KEPT, "keeper")).toEqual(["Sam Keeper"]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("upsertPeople on a second manifest sync", () => {
  it("does not throw, adds a new attendee and refreshes the old one", () => {
    db.upsertPeople(KEPT, [sam]);
    vi.setSystemTime(T0 + HOUR);

    const late = {
      humanId: "h-late",
      displayName: "Late Buyer",
      email: "late@kept.test",
      kind: "attendee" as const,
    };
    expect(() => db.upsertPeople(KEPT, [sam, late])).not.toThrow();

    expect(names(KEPT, "late")).toEqual(["Late Buyer"]);
    expect(db.lookupPersonName(KEPT, "h-late")).toBe("Late Buyer");
    expect(db.searchPeople(KEPT, "keeper")[0]?.syncedAt).toBe(T0 + HOUR);
  });

  it("indexes a changed name and email, and forgets the old ones", () => {
    db.upsertPeople(KEPT, [sam]);
    db.upsertPeople(KEPT, [
      { ...sam, displayName: "Samira Holder", email: "samira@new.test" },
    ]);

    expect(names(KEPT, "samira")).toEqual(["Samira Holder"]);
    expect(names(KEPT, "new.test")).toEqual(["Samira Holder"]);
    expect(names(KEPT, "keeper")).toEqual([]);
    expect(indexedTerms()).not.toContain("keeper");
    expect(indexedTerms()).not.toContain("kept");
    expect(peopleRowCount()).toBe(1);
  });

  it("does not touch the index when nothing searchable changed", () => {
    const volunteer = { ...sam, kind: "volunteer" as const };
    db.upsertPeople(KEPT, [{ ...volunteer, signupStatus: "PENDING" }]);
    // With the index table gone, any insert, delete or rebuild would throw.
    harness.rawDatabase().exec("DROP TABLE people_fts;");

    expect(() =>
      db.upsertPeople(KEPT, [{ ...volunteer, signupStatus: "APPROVED" }]),
    ).not.toThrow();
    expect(() =>
      db.upsertPeople(KEPT, [{ ...volunteer, signupStatus: "APPROVED" }]),
    ).not.toThrow();

    const row = harness
      .rawDatabase()
      .prepare("SELECT signup_status FROM people WHERE human_id = 'h-sam'")
      .get() as { signup_status: string };
    expect(row.signup_status).toBe("APPROVED");
  });

  it("keeps a cached person the manifest no longer lists, and stamps the whole event", () => {
    // The server caps a manifest at 10,000 tickets and 10,000 signups, so a
    // person missing from it has not necessarily left.
    const other = { ...jo, humanId: "h-other" };
    db.upsertPeople(KEPT, [sam, other]);
    vi.setSystemTime(T0 + HOUR);

    db.upsertPeople(KEPT, [sam]);

    expect(db.lookupPersonName(KEPT, "h-other")).toBe("Jo Leaver");
    const stamps = harness
      .rawDatabase()
      .prepare("SELECT DISTINCT synced_at FROM people WHERE event_id = ?")
      .all(KEPT) as Array<{ synced_at: number }>;
    expect(stamps).toEqual([{ synced_at: T0 + HOUR }]);
  });

  it("a person listed twice in one manifest is one row and one index entry", () => {
    db.upsertPeople(KEPT, [sam, sam]);
    expect(peopleRowCount()).toBe(1);
    expect(names(KEPT, "keeper")).toEqual(["Sam Keeper"]);
  });

  it("throws when the index cannot be rebuilt after a rename, with the row written", () => {
    db.upsertPeople(KEPT, [sam]);
    harness.rawDatabase().exec("DROP TABLE people_fts;");

    expect(() =>
      db.upsertPeople(KEPT, [{ ...sam, displayName: "Samira Holder" }]),
    ).toThrow();
    expect(db.lookupPersonName(KEPT, "h-sam")).toBe("Samira Holder");
  });
});

describe("dropEventsNotIn: the people", () => {
  it("drops the events that left the list, rows and index, and keeps the rest", () => {
    seedBothEvents();

    expect(db.dropEventsNotIn([KEPT])).toBe(1);

    expect(names(GONE, "leaver")).toEqual([]);
    expect(db.lookupPersonName(GONE, "h-jo")).toBeNull();
    expect(indexedTerms()).not.toContain("leaver");
    expect(indexedTerms()).not.toContain("gone");
    // Still found through the index, by name and by a mixed-case email.
    expect(names(KEPT, "keeper")).toEqual(["Sam Keeper"]);
    expect(names(KEPT, "sam@kept")).toEqual(["Sam Keeper"]);
  });

  it("an empty list drops everyone", () => {
    seedBothEvents();
    expect(db.dropEventsNotIn([])).toBe(2);
    expect(peopleRowCount()).toBe(0);
    expect(indexedTerms()).toEqual([]);
  });

  it("drops nothing when every cached event is still in the list", () => {
    seedBothEvents();
    const before = indexedTerms();
    expect(db.dropEventsNotIn([KEPT, GONE, "evt-new"])).toBe(0);
    expect(peopleRowCount()).toBe(2);
    expect(indexedTerms()).toEqual(before);
  });

  it("throws when the index cannot be rebuilt, with the rows already gone", () => {
    seedBothEvents();
    harness.rawDatabase().exec("DROP TABLE people_fts;");
    expect(() => db.dropEventsNotIn([KEPT])).toThrow();
    expect(db.lookupPersonName(GONE, "h-jo")).toBeNull();
    expect(db.lookupPersonName(KEPT, "h-sam")).toBe("Sam Keeper");
  });
});

/** A ticket, an event row and a recent scan for `eventId`. */
const seedEventData = (eventId: string, n: number) => {
  db.upsertEvents([
    {
      eventId,
      eventName: eventId,
      orgId: "org-1",
      startAt: null,
      endAt: null,
      status: "PUBLISHED",
      role: "SCANNER",
      lat: null,
      lng: null,
    },
  ]);
  db.upsertTickets([
    {
      ticketId: `t-${n}`,
      code: `TKT-${eventId}`,
      eventId,
      status: "VALID",
      ownerHuman: `h-${n}`,
      scannedAt: null,
      ticketTypeName: "GA",
      orderId: null,
    },
  ]);
  db.recordRecentScan({
    eventId,
    ticketCode: `TKT-${eventId}`,
    ticketId: `t-${n}`,
    holderDisplay: `Holder ${eventId}`,
    kind: "ticket",
  });
};
const rowsFor = (table: string, eventId: string): number =>
  (
    harness
      .rawDatabase()
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE event_id = ?`)
      .get(eventId) as { n: number }
  ).n;

describe("dropEventsNotIn: the rest of a departed event", () => {
  it("drops its tickets, recent scans and event row, and keeps the listed event's", () => {
    seedBothEvents();
    seedEventData(KEPT, 1);
    seedEventData(GONE, 2);

    db.dropEventsNotIn([KEPT]);

    for (const table of ["people", "tickets", "recent_scans", "events"]) {
      expect(rowsFor(table, GONE), `${table} of the departed event`).toBe(0);
      expect(rowsFor(table, KEPT), `${table} of the listed event`).toBe(1);
    }
    expect(db.listRecentScans().map((r) => r.holderDisplay)).toEqual([
      `Holder ${KEPT}`,
    ]);
  });

  it("drops an event that has tickets or recent scans but no people", () => {
    seedEventData(GONE, 2);
    expect(db.dropEventsNotIn([KEPT])).toBe(0);
    for (const table of ["tickets", "recent_scans", "events"]) {
      expect(rowsFor(table, GONE), table).toBe(0);
    }
  });

  it("leaves the departed event's queued and failed admits", () => {
    seedEventData(GONE, 2);
    db.enqueueScan({ eventId: GONE, ticketCode: "TKT-q", clientKey: "key-q" });
    const failed = db.enqueueScan({
      eventId: GONE,
      ticketCode: "TKT-f",
      clientKey: "key-f",
    });
    db.recordDroppedScan({
      queueId: failed.queueId,
      eventId: GONE,
      ticketCode: "TKT-f",
      clientKey: "key-f",
      enqueuedAt: failed.enqueuedAt,
      attempts: 8,
      reason: "max_attempts",
      lastError: null,
    });

    db.dropEventsNotIn([]);

    expect(db.countQueuedScans()).toBe(1);
    expect(db.countDroppedScans()).toBe(1);
  });
});

describe("a platform admin's list, past SQLite's bound-parameter limit", () => {
  // Desktop SQLite's limit is 32,766; a phone's build may be lower.
  const ids = Array.from({ length: 40_000 }, (_, i) => `evt-${i}`);

  it("dropEventsNotIn", () => {
    seedBothEvents();
    expect(db.dropEventsNotIn([...ids, KEPT])).toBe(1);
    expect(db.lookupPersonName(KEPT, "h-sam")).toBe("Sam Keeper");
  });

  it("dropStalePeople", () => {
    seedBothEvents();
    vi.setSystemTime(T0 + 25 * HOUR);
    db.dropStalePeople({ staleAfterMs: 24 * HOUR, activeEventIds: [...ids, KEPT] });
    expect(db.lookupPersonName(GONE, "h-jo")).toBeNull();
    expect(db.lookupPersonName(KEPT, "h-sam")).toBe("Sam Keeper");
  });
});

describe("report branches of the best-effort steps", () => {
  const reportsOf = (branch: string) =>
    sentry.captureException.mock.calls.filter(
      ([, context]) => context?.tags?.branch === branch,
    );

  it("secure_delete_pragma: the database still opens, and it is reported", async () => {
    harness.refuseStatements(/secure_delete/);
    await launch();

    seedBothEvents();
    expect(names(KEPT, "keeper")).toEqual(["Sam Keeper"]);
    expect(reportsOf("secure_delete_pragma")).toHaveLength(1);
    expect(reportsOf("secure_delete_pragma")[0]?.[1]?.tags?.feature).toBe(
      "pii_retention",
    );
  });

  it("launch_index_rebuild: the database still opens, and it is reported", async () => {
    harness.refuseStatements(/'delete-all'/);
    await launch();

    expect(db.isFtsAvailable()).toBe(true);
    expect(reportsOf("launch_index_rebuild")).toHaveLength(1);
  });

  it("wal_checkpoint: a wipe still empties the tables, and it is reported once per app run", () => {
    seedBothEvents();
    harness.refuseStatements(/wal_checkpoint/);

    db.clearAll();
    db.clearAttendeeData();
    db.clearAll();

    expect(peopleRowCount()).toBe(0);
    expect(reportsOf("wal_checkpoint")).toHaveLength(1);
  });

  it("wal_checkpoint_busy: a checkpoint a reader blocks is reported once per app run", async () => {
    const file = useDatabaseOnDisk();
    await launch();
    seedBothEvents();
    // Another connection holding a read transaction, as a long query would.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { get(): unknown };
        close(): void;
      };
    };
    const reader = new DatabaseSync(file);
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM people").get();

      db.clearAll();
      db.clearAll();

      expect(peopleRowCount()).toBe(0);
      expect(reportsOf("wal_checkpoint_busy")).toHaveLength(1);
      expect(reportsOf("wal_checkpoint")).toHaveLength(0);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  });
});

describe("the older drops clear the index too", () => {
  it("dropPeopleForEvent", () => {
    seedBothEvents();
    db.dropPeopleForEvent(GONE);

    expect(names(GONE, "leaver")).toEqual([]);
    expect(indexedTerms()).not.toContain("leaver");
    expect(names(KEPT, "keeper")).toEqual(["Sam Keeper"]);
  });

  it("dropStalePeople, with events still active", () => {
    seedBothEvents();
    vi.setSystemTime(T0 + 25 * HOUR);
    db.dropStalePeople({ staleAfterMs: 24 * HOUR, activeEventIds: [KEPT] });

    expect(db.lookupPersonName(GONE, "h-jo")).toBeNull();
    expect(indexedTerms()).not.toContain("leaver");
    expect(names(KEPT, "keeper")).toEqual(["Sam Keeper"]);
  });

  it("dropStalePeople, with no active events", () => {
    seedBothEvents();
    vi.setSystemTime(T0 + 25 * HOUR);
    db.dropStalePeople({ staleAfterMs: 24 * HOUR, activeEventIds: [] });

    expect(peopleRowCount()).toBe(0);
    expect(indexedTerms()).toEqual([]);
  });

  it("dropStalePeople keeps a fresh row of an event that left the list", () => {
    seedBothEvents();
    vi.setSystemTime(T0 + HOUR);
    db.dropStalePeople({ staleAfterMs: 24 * HOUR, activeEventIds: [KEPT] });

    expect(names(GONE, "leaver")).toEqual(["Jo Leaver"]);
  });

});
