/**
 * Pure decisions behind the Postgres test helper in `./postgres.ts`: which
 * server a test file gets, how the shared server's URL is built, and which
 * databases on a long-lived server may be dropped. Kept free of I/O so the
 * policy is unit-tested without Docker.
 */

/** Image for every Postgres the helper starts. Multi-arch (arm64 + amd64), so
 * an arm64 Mac runs it natively instead of emulating `postgis/postgis`
 * (amd64-only; measured 148.9 s emulated vs 44.5 s native for one workload). */
export const POSTGIS_TEST_IMAGE = "imresamu/postgis:16-3.4";

/** One long-lived test server per machine (owner ruling, 2026-10-14). */
export const SHARED_PG_CONTAINER_NAME = "th-test-pg";

/** Fixed host port for `th-test-pg`. Away from 5432 (dev DB) and the 554xx /
 * 555xx range peers use for ad-hoc containers. */
export const SHARED_PG_DEFAULT_PORT = 54329;

/** Docker label carrying the version of th-test-pg's `docker run` config. */
export const SHARED_PG_CONFIG_LABEL = "com.tickethunter.config";
/** Bump when the run flags change (2: max_connections=1000, shm 1g,
 * cluster_name marker). A server with another value gets a recreate warning. */
export const SHARED_PG_CONFIG_VERSION = "2";

export const SHARED_PG_USER = "postgres";
export const SHARED_PG_PASSWORD = "postgres";

/** A template unused this long is retired the next time a template is built. */
export const TEMPLATE_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
/** At most this many templates (current one included) stay on a server. */
export const TEMPLATE_KEEP_MAX = 8;
/** A per-file test database this old with no connections is a leak. */
export const LEAKED_DB_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** The leaked-database sweep runs at most this often per server. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const TEMPLATE_PREFIX = "test_template_";
const TEST_DB_NAME = /^test_[a-z0-9_]+$/;
const LAST_USED_COMMENT = /^th:last_used=(\d+)$/;
const LAST_SWEEP_COMMENT = /^th:last_sweep=(\d+)$/;

export type HostPgMode =
  /** `TESTCONTAINERS_REUSE_DATABASE_URL`, or CI with `DATABASE_URL`. */
  | { kind: "reuse"; url: string }
  /** Local run: the machine-wide `th-test-pg` container. */
  | { kind: "shared"; port: number }
  /** A Testcontainers container per test file (CI without a URL, or opt-out). */
  | { kind: "container" };

type Env = Record<string, string | undefined>;

function isTruthyCi(value: string | undefined): boolean {
  const ci = value?.toLowerCase();
  return ci === "true" || ci === "1";
}

/**
 * Picks the server for this run. The `reuse` branch is the helper's original
 * behaviour, unchanged; `shared` applies only when neither it nor CI applies
 * and `TESTCONTAINERS_SHARED_PG=0` has not opted out.
 */
export function resolveHostPgMode(env: Env): HostPgMode {
  const explicit = env.TESTCONTAINERS_REUSE_DATABASE_URL?.trim();
  if (explicit) return { kind: "reuse", url: explicit };
  if (isTruthyCi(env.CI)) {
    if (env.DATABASE_URL) return { kind: "reuse", url: env.DATABASE_URL };
    return { kind: "container" };
  }
  if (env.TESTCONTAINERS_SHARED_PG?.trim() === "0") return { kind: "container" };
  return { kind: "shared", port: sharedPgPort(env) };
}

export function sharedPgPort(env: Env): number {
  const raw = env.TESTCONTAINERS_SHARED_PG_PORT?.trim();
  if (!raw) return SHARED_PG_DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5432) {
    throw new Error(
      `TESTCONTAINERS_SHARED_PG_PORT must be an integer in 1024-65535 other than 5432 (the dev DB), got "${raw}"`,
    );
  }
  return port;
}

export function sharedPgUrl(port: number, database = "postgres"): string {
  return `postgresql://${SHARED_PG_USER}:${SHARED_PG_PASSWORD}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

/** Parses `docker port <name> 5432/tcp` output (`127.0.0.1:54329`, possibly
 * followed by an IPv6 line). */
export function parseDockerPort(output: string): number | undefined {
  for (const line of output.split("\n")) {
    const match = /:(\d+)\s*$/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** `docker run` failed because another process holds the name: it is
 * starting the shared server, so this process waits instead. */
export function isDockerNameConflict(stderr: string): boolean {
  return /Conflict\. The container name .* is already in use/i.test(stderr);
}

/** Why an existing th-test-pg differs from what `docker run` would create
 * today; empty when it matches. `config` is "" for a server without the label. */
export function describeSharedContainerDrift(info: {
  image?: string;
  config?: string;
}): string[] {
  const problems: string[] = [];
  if (info.image && info.image !== POSTGIS_TEST_IMAGE) {
    problems.push(`runs ${info.image}, expected ${POSTGIS_TEST_IMAGE}`);
  }
  if ((info.config ?? "") !== SHARED_PG_CONFIG_VERSION) {
    problems.push(
      `config version "${info.config ?? ""}", expected "${SHARED_PG_CONFIG_VERSION}"`,
    );
  }
  return problems;
}

/** `docker inspect` failed: is the container absent, or is the daemon down?
 * Only an explicit "no such object" means absent; anything else must not be
 * mistaken for it (that path runs `docker run` and blames the port). */
export function classifyDockerInspectError(stderr: string): "missing" | "daemon" {
  return /no such (object|container)/i.test(stderr) ? "missing" : "daemon";
}

export function formatSweepComment(nowMs: number): string {
  return `th:last_sweep=${nowMs}`;
}

/** Due when never stamped, stamped over `intervalMs` ago, or stamped in the
 * future (clock moved back; don't wait it out). */
export function isSweepDue(
  comment: string | null | undefined,
  nowMs: number,
  intervalMs = SWEEP_INTERVAL_MS,
): boolean {
  const match = comment ? LAST_SWEEP_COMMENT.exec(comment.trim()) : null;
  if (!match) return true;
  const last = Number(match[1]);
  return last > nowMs || nowMs - last >= intervalMs;
}

export function formatTemplateComment(nowMs: number): string {
  return `th:last_used=${nowMs}`;
}

export function parseTemplateComment(
  comment: string | null | undefined,
): number | undefined {
  const match = comment ? LAST_USED_COMMENT.exec(comment.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

export interface TemplateDatabase {
  name: string;
  /** From the `th:last_used=` comment, else the database's creation time. */
  lastUsedMs: number | undefined;
}

/**
 * Templates to drop when `current` is being built. Different working trees
 * (peer sessions with WIP migrations) fingerprint differently and share one
 * server, so dropping every other template made them rebuild each other's on
 * every run. Instead: keep anything used within `maxIdleMs`, newest first, up
 * to `keepMax` including `current`. Unknown age counts as oldest.
 */
export function selectTemplatesToRetire(
  templates: TemplateDatabase[],
  current: string,
  nowMs: number,
  { maxIdleMs = TEMPLATE_MAX_IDLE_MS, keepMax = TEMPLATE_KEEP_MAX } = {},
): string[] {
  const others = templates
    .filter((t) => t.name.startsWith(TEMPLATE_PREFIX) && t.name !== current)
    .sort((a, b) => (b.lastUsedMs ?? -Infinity) - (a.lastUsedMs ?? -Infinity));
  const retire: string[] = [];
  let kept = 1; // `current`
  for (const t of others) {
    const fresh =
      t.lastUsedMs !== undefined && nowMs - t.lastUsedMs <= maxIdleMs;
    if (fresh && kept < keepMax) {
      kept += 1;
    } else {
      retire.push(t.name);
    }
  }
  return retire;
}

export interface TestDatabase {
  name: string;
  createdMs: number | undefined;
  connections: number;
}

/**
 * Per-file `test_*` databases left behind by a killed run. Only one with no
 * connection and older than `minAgeMs` qualifies; the caller drops without
 * FORCE, so a run that connects in between makes the drop fail rather than
 * losing its database.
 */
export function selectLeakedTestDatabases(
  databases: TestDatabase[],
  nowMs: number,
  minAgeMs = LEAKED_DB_MIN_AGE_MS,
): string[] {
  return databases
    .filter(
      (db) =>
        TEST_DB_NAME.test(db.name) &&
        !db.name.startsWith(TEMPLATE_PREFIX) &&
        db.connections === 0 &&
        db.createdMs !== undefined &&
        nowMs - db.createdMs > minAgeMs,
    )
    .map((db) => db.name);
}
