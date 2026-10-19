/**
 * `expo-sqlite`'s synchronous API on top of Node's built-in SQLite, so
 * `src/lib/local-db.ts` runs its REAL SQL in a node test.
 *
 * `expo-sqlite` exists only in a native runtime, and a mocked database cannot
 * tell a statement that works from one SQLite refuses. The people search index
 * is the case that needed it: every `DELETE` on a contentless FTS5 table
 * throws, and `local-db.ts` swallowed that for as long as nothing ran the SQL.
 *
 * Use it as the module itself:
 *
 *   vi.mock("expo-sqlite", () => import("../../test/harness/expo-sqlite-on-node"));
 *
 * Each `openDatabaseSync` opens a NEW in-memory database. `local-db.ts` opens
 * one per module instance, so `vi.resetModules()` gives a test a clean one.
 *
 * {@link useDatabaseFile} points it at a file instead. Then `vi.resetModules()`
 * is an app relaunch on the same database, and the bytes a wipe leaves in the
 * file and its write-ahead log can be read back.
 *
 * Only what `local-db.ts` calls is implemented. Node's SQLite is a desktop
 * build (FTS5 included); it shows what SQLite does, not what a phone does.
 *
 * `node:sqlite` is loaded through `createRequire` because this repo's
 * `@types/node` predates it, and typed by hand below for the same reason.
 */
import { createRequire } from "node:module";

type NodeStatement = {
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type NodeDatabase = {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
};

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => NodeDatabase;
};

/** expo-sqlite binds `undefined` as NULL; Node's SQLite rejects it. */
const bind = (params: unknown[]): unknown[] =>
  params.map((p) => (p === undefined ? null : p));

const runResult = (r: ReturnType<NodeStatement["run"]>) => ({
  changes: Number(r.changes),
  lastInsertRowId: Number(r.lastInsertRowid),
});

/**
 * On `globalThis`, not in a module variable: after `vi.resetModules()` the
 * copy of this module a test imports and the copy `vi.mock` hands to
 * `local-db.ts` can be two instances.
 */
const shared = globalThis as {
  __scannerTestSqlite?: NodeDatabase;
  __scannerTestSqlitePath?: string | null;
  __scannerTestSqliteRefuse?: RegExp | null;
};

/**
 * Make every statement matching `pattern` throw, as a device SQLite that
 * refuses it would (`null`: refuse nothing). For report branches that a
 * desktop SQLite never reaches, such as a refused `PRAGMA`.
 */
export const refuseStatements = (pattern: RegExp | null): void => {
  shared.__scannerTestSqliteRefuse = pattern;
};
const check = (sql: string): void => {
  const pattern = shared.__scannerTestSqliteRefuse;
  if (pattern?.test(sql)) throw new Error(`refused by the test: ${sql}`);
};

/** Open the next database from this file (`null`: back to in-memory). */
export const useDatabaseFile = (path: string | null): void => {
  shared.__scannerTestSqlitePath = path;
};

/** The database `local-db.ts` last opened, for assertions in raw SQL. */
export const rawDatabase = (): NodeDatabase => {
  const raw = shared.__scannerTestSqlite;
  if (!raw) throw new Error("local-db has not opened a database yet");
  return raw;
};

export function openDatabaseSync(_name: string) {
  const raw = new DatabaseSync(shared.__scannerTestSqlitePath ?? ":memory:");
  shared.__scannerTestSqlite = raw;
  const execSync = (sql: string): void => {
    check(sql);
    raw.exec(sql);
  };
  return {
    execSync,
    runSync: (sql: string, ...params: unknown[]) => {
      check(sql);
      return runResult(raw.prepare(sql).run(...bind(params)));
    },
    getFirstSync: <T>(sql: string, ...params: unknown[]): T | null => {
      check(sql);
      return (raw.prepare(sql).get(...bind(params)) as T | undefined) ?? null;
    },
    getAllSync: <T>(sql: string, ...params: unknown[]): T[] => {
      check(sql);
      return raw.prepare(sql).all(...bind(params)) as T[];
    },
    prepareSync: (sql: string) => {
      check(sql);
      const statement = raw.prepare(sql);
      return {
        executeSync: (...params: unknown[]) =>
          runResult(statement.run(...bind(params))),
        finalizeSync: () => {},
      };
    },
    // Same shape as expo-sqlite's `withTransactionSync`.
    withTransactionSync: (task: () => void): void => {
      try {
        execSync("BEGIN");
        task();
        execSync("COMMIT");
      } catch (e) {
        execSync("ROLLBACK");
        throw e;
      }
    },
  };
}
