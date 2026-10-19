import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";

import {
  POSTGIS_TEST_IMAGE,
  SHARED_PG_CONFIG_LABEL,
  SHARED_PG_CONFIG_VERSION,
  SHARED_PG_CONTAINER_NAME,
  SHARED_PG_PASSWORD,
  SHARED_PG_USER,
  classifyDockerInspectError,
  describeSharedContainerDrift,
  formatSweepComment,
  formatTemplateComment,
  isDockerNameConflict,
  isSweepDue,
  parseDockerPort,
  parseTemplateComment,
  resolveHostPgMode,
  selectLeakedTestDatabases,
  selectTemplatesToRetire,
  sharedPgUrl,
} from "./postgres-host-policy";

const execFileAsync = promisify(execFile);

export interface PostgresTestContainer {
  container: StartedPostgreSqlContainer | null;
  connectionUri: string;
  databaseUrl: string;
  stop: () => Promise<void>;
}

export interface StartPostgresOptions {
  image?: string;
  database?: string;
  username?: string;
  password?: string;
  schema?: string;
}

/**
 * Returns a usable host Postgres connection string when the runtime opts into
 * reuse instead of Testcontainers. Honors:
 *
 * - `TESTCONTAINERS_REUSE_DATABASE_URL` — explicit opt-in for any context.
 * - `CI=true` + `DATABASE_URL` — CI runners (Forgejo, GitHub Actions) that
 *   already provide a Postgres service container, where Docker-in-Docker /
 *   Testcontainers Reaper isn't reachable.
 *
 * Returns `undefined` otherwise: a local run then uses the shared
 * `th-test-pg` server (below), and CI without a URL or
 * `TESTCONTAINERS_SHARED_PG=0` falls back to a Testcontainers container per
 * file.
 */
function resolveReusableHostPg(): string | undefined {
  const mode = resolveHostPgMode(process.env);
  return mode.kind === "reuse" ? mode.url : undefined;
}

// ── Shared machine-wide test server (`th-test-pg`) ─────────────────────────
//
// Local runs (not CI, no explicit reuse URL, TESTCONTAINERS_SHARED_PG != 0)
// share ONE long-lived native-arch Postgres instead of booting a container per
// test file; each file gets its own `test_*` database on it, copied from a
// migrated template. Started with the docker CLI, not Testcontainers, so ryuk
// never reaps it: it outlives every run by design.
//
// Vitest isolates modules per test file (forks + isolate), so the memo below
// lasts one FILE, not one process, and this setup runs per file. It is kept
// cheap for that: a running server costs one connection and no docker call,
// and the leaked-database sweep runs at most once an hour machine-wide.

const SHARED_PG_READY_TIMEOUT_MS = 180_000;
/** Advisory try-lock key for the hourly sweep ("th", "sw"). */
const SWEEP_LOCK = [0x7468, 0x7377] as const;

let sharedPgBaseUrl: Promise<string> | undefined;
/** Set once `ensureSharedTestPg` has resolved in this module instance. */
let sharedPgResolvedUrl: string | undefined;

type DockerResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string };

async function docker(args: string[]): Promise<DockerResult> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args);
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: string;
    };
    if (e.code === "ENOENT") {
      throw new Error(
        "[test-utils/postgres] the docker CLI is not on PATH; start Docker or set TESTCONTAINERS_REUSE_DATABASE_URL",
      );
    }
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr || e.message || String(err),
    };
  }
}

interface SharedContainerInfo {
  state: "missing" | "running" | "stopped";
  image?: string;
  /** Value of the config-version label; "" when absent (pre-label server). */
  config?: string;
}

/** One `docker inspect`; a daemon that is down throws rather than reading as
 * "missing" (which would send the caller to `docker run` and a port hint). */
async function inspectSharedContainer(): Promise<SharedContainerInfo> {
  const res = await docker([
    "inspect",
    "-f",
    `{{.State.Running}}|{{.Config.Image}}|{{index .Config.Labels "${SHARED_PG_CONFIG_LABEL}"}}`,
    SHARED_PG_CONTAINER_NAME,
  ]);
  if (!res.ok) {
    if (classifyDockerInspectError(res.stderr) === "missing") {
      return { state: "missing" };
    }
    throw new Error(
      `[test-utils/postgres] cannot reach the Docker daemon (is Docker running?): ${res.stderr.trim()}`,
    );
  }
  const [running, image, config] = res.stdout.trim().split("|");
  return {
    state: running === "true" ? "running" : "stopped",
    image,
    config: config === "<no value>" ? "" : (config ?? ""),
  };
}

let driftWarned = false;

/**
 * Warns (once per module instance, i.e. per test file) when the existing
 * th-test-pg was created from another image or an older `docker run` config
 * (e.g. before max_connections=1000 / shm 1g / the cluster_name marker; such
 * a server fails the fast probe and costs docker calls on every file). Never
 * removes it: another session may hold a test database on it.
 */
function warnOnDrift(info: SharedContainerInfo): void {
  if (driftWarned || info.state === "missing") return;
  const problems = describeSharedContainerDrift(info);
  if (!problems.length) return;
  driftWarned = true;
  console.warn(
    `[test-utils/postgres] ${SHARED_PG_CONTAINER_NAME} ${problems.join("; ")}. ` +
      `Recreate when idle: docker rm -f ${SHARED_PG_CONTAINER_NAME}`,
  );
}

/**
 * Connects, checks PostGIS answers, and reads the sweep stamp in one round
 * trip. `requireIdentity` also demands `cluster_name = th-test-pg`: needed
 * when probing a bare port, not when docker just reported the port for the
 * th-test-pg container (which also keeps a container from before the marker
 * usable).
 */
async function probeSharedPg(
  url: string,
  requireIdentity: boolean,
): Promise<{ ready: true; sweepComment: string | null } | { ready: false; error: unknown }> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{
      cluster: string;
      comment: string | null;
    }>(
      `SELECT postgis_full_version(),
              current_setting('cluster_name') AS cluster,
              shobj_description(d.oid, 'pg_database') AS comment
         FROM pg_database d WHERE d.datname = current_database()`,
    );
    if (requireIdentity && rows[0]?.cluster !== SHARED_PG_CONTAINER_NAME) {
      return {
        ready: false,
        error: new Error(
          `the Postgres at ${new URL(url).host} is not ${SHARED_PG_CONTAINER_NAME} (cluster_name "${rows[0]?.cluster ?? ""}")`,
        ),
      };
    }
    return { ready: true, sweepComment: rows[0]?.comment ?? null };
  } catch (error) {
    return { ready: false, error };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * `docker run -d` for th-test-pg. When it fails for a reason other than a
 * name conflict (port taken, bad image) Docker can leave a Created container
 * behind holding the old port, which later runs would `docker start` forever;
 * remove it, but only when the cidfile proves this call created it and it
 * never started.
 */
async function claimSharedContainer(port: number): Promise<void> {
  const cidfile = join(
    tmpdir(),
    `th-test-pg-${process.pid}-${randomUUID()}.cid`,
  );
  try {
    const run = await docker([
      "run",
      "-d",
      "--cidfile",
      cidfile,
      "--name",
      SHARED_PG_CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "--label",
      "com.tickethunter.role=shared-test-postgres",
      // Bump SHARED_PG_CONFIG_VERSION whenever these run flags change.
      "--label",
      `${SHARED_PG_CONFIG_LABEL}=${SHARED_PG_CONFIG_VERSION}`,
      "--shm-size",
      "1g",
      "-p",
      `127.0.0.1:${port}:5432`,
      "-e",
      `POSTGRES_USER=${SHARED_PG_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${SHARED_PG_PASSWORD}`,
      POSTGIS_TEST_IMAGE,
      "-c",
      "max_connections=1000",
      // Identity marker the probe checks, so a different Postgres that
      // happens to listen on the port is never mistaken for this one.
      "-c",
      `cluster_name=${SHARED_PG_CONTAINER_NAME}`,
      // Crash-safe (unlike fsync=off): a crash loses only the last commits of
      // throwaway test data, never the cluster.
      "-c",
      "synchronous_commit=off",
    ]);
    if (run.ok || isDockerNameConflict(run.stderr)) return;

    const ourId = existsSync(cidfile) ? readFileSync(cidfile, "utf8").trim() : "";
    if (ourId) {
      const status = await docker([
        "inspect",
        "-f",
        "{{.Id}} {{.State.Status}}",
        SHARED_PG_CONTAINER_NAME,
      ]);
      const [id, state] = status.ok ? status.stdout.trim().split(" ") : [];
      if (id === ourId && state === "created") {
        await docker(["rm", SHARED_PG_CONTAINER_NAME]);
      }
    }
    throw new Error(
      `[test-utils/postgres] could not start ${SHARED_PG_CONTAINER_NAME} on 127.0.0.1:${port}: ${run.stderr.trim()}\n` +
        `If the port is taken, set TESTCONTAINERS_SHARED_PG_PORT; to fall back to a container per file, set TESTCONTAINERS_SHARED_PG=0.`,
    );
  } finally {
    rmSync(cidfile, { force: true });
  }
}

/**
 * Makes sure `th-test-pg` exists, is running and answers with PostGIS, and
 * returns its admin URL plus the sweep stamp. A server already answering on
 * the configured port costs no docker call. Otherwise `docker run --name` is
 * the atomic claim: when two processes race, the loser sees a name conflict
 * and just waits.
 */
async function ensureSharedTestPg(
  port: number,
): Promise<{ url: string; sweepComment: string | null }> {
  const direct = sharedPgUrl(port);
  const fast = await probeSharedPg(direct, true);
  if (fast.ready) return { url: direct, sweepComment: fast.sweepComment };

  const info = await inspectSharedContainer();
  warnOnDrift(info);
  if (info.state === "missing") {
    await claimSharedContainer(port);
  } else if (info.state === "stopped") {
    const start = await docker(["start", SHARED_PG_CONTAINER_NAME]);
    if (!start.ok && (await inspectSharedContainer()).state !== "running") {
      throw new Error(
        `[test-utils/postgres] could not start existing ${SHARED_PG_CONTAINER_NAME}: ${start.stderr.trim()}`,
      );
    }
  }

  const deadline = Date.now() + SHARED_PG_READY_TIMEOUT_MS;
  let lastError: unknown = fast.error;
  while (Date.now() < deadline) {
    const mapped = await docker(["port", SHARED_PG_CONTAINER_NAME, "5432/tcp"]);
    // The container is the source of truth for its port (another session
    // may have created it with TESTCONTAINERS_SHARED_PG_PORT).
    const actualPort = mapped.ok ? parseDockerPort(mapped.stdout) : undefined;
    if (actualPort) {
      const url = sharedPgUrl(actualPort);
      const probe = await probeSharedPg(url, false);
      if (probe.ready) return { url, sweepComment: probe.sweepComment };
      lastError = probe.error;
    } else {
      lastError = new Error(
        mapped.ok ? `no port mapping: ${mapped.stdout}` : mapped.stderr,
      );
    }
    await sleep(500);
  }
  // Postgres logs to stderr; `docker logs` replays each stream on its own.
  const logs = await docker(["logs", "--tail", "20", SHARED_PG_CONTAINER_NAME]);
  throw new Error(
    `[test-utils/postgres] ${SHARED_PG_CONTAINER_NAME} not ready after ${SHARED_PG_READY_TIMEOUT_MS / 1000}s ` +
      `(last error: ${(lastError as Error | undefined)?.message ?? "unknown"}). ` +
      `Recent logs:\n${logs.stdout}${logs.stderr}`,
  );
}

function sharedTestPg(port: number): Promise<string> {
  if (!sharedPgBaseUrl) {
    sharedPgBaseUrl = ensureSharedTestPg(port)
      .then(async ({ url, sweepComment }) => {
        sharedPgResolvedUrl = url;
        if (isSweepDue(sweepComment, Date.now())) {
          await sweepLeakedTestDatabases(url);
        }
        return url;
      })
      .catch((err: unknown) => {
        sharedPgBaseUrl = undefined; // let the next file retry
        throw err;
      });
  }
  return sharedPgBaseUrl;
}

/**
 * Drops per-file databases a killed run left behind: `test_*` (never a
 * template), no connections, created over a day ago. DROP without FORCE, so
 * a run that holds a connection at that moment keeps its database. Runs at
 * most hourly (stamp on the server's `postgres` database, claimed under a
 * try-lock so concurrent files don't all sweep). Best effort; a failed sweep
 * never fails the test file.
 */
async function sweepLeakedTestDatabases(baseUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  try {
    await admin.connect();
    const lock = await admin.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [...SWEEP_LOCK],
    );
    if (!lock.rows[0]?.locked) return; // another file is sweeping
    const stamp = await admin.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = current_database()",
    );
    if (!isSweepDue(stamp.rows[0]?.comment ?? null, Date.now())) return;
    await admin.query(
      `COMMENT ON DATABASE ${ident(databaseNameOf(baseUrl))} IS '${formatSweepComment(Date.now())}'`,
    );

    // Hourly is also often enough to notice image drift on a server that
    // the fast path otherwise never inspects.
    try {
      warnOnDrift(await inspectSharedContainer());
    } catch {
      // docker unreachable from here; the server itself answered, carry on.
    }

    const { rows } = await admin.query<{
      datname: string;
      created: Date | null;
      connections: number;
    }>(
      `SELECT d.datname,
              (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification AS created,
              (SELECT count(*) FROM pg_stat_activity a WHERE a.datid = d.oid)::int AS connections
         FROM pg_database d
        WHERE d.datname LIKE 'test%'`,
    );
    const leaked = selectLeakedTestDatabases(
      rows.map((r) => ({
        name: r.datname,
        createdMs: r.created ? r.created.getTime() : undefined,
        connections: r.connections,
      })),
      Date.now(),
    );
    for (const name of leaked) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${ident(name)}`);
      } catch {
        // 55006: someone connected since the scan, so it is live; leave it.
      }
    }
  } catch (err) {
    console.warn("[test-utils/postgres] leaked test database sweep failed", err);
  } finally {
    // Session end releases the try-lock.
    await admin.end().catch(() => {});
  }
}

/** The shared server's admin URL if this run uses it, without starting it. */
function sharedBaseUrlIfActive(): string | undefined {
  const mode = resolveHostPgMode(process.env);
  if (mode.kind !== "shared") return undefined;
  return sharedPgResolvedUrl ?? sharedPgUrl(mode.port);
}

function replaceDatabasePath(baseUrl: string, newDatabase: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${encodeURIComponent(newDatabase)}`;
  return url.toString();
}

async function startEphemeralOnHostPg(
  baseUrl: string,
  options: StartPostgresOptions,
): Promise<PostgresTestContainer> {
  const database = options.database ?? `test_${randomUUID().replace(/-/g, "")}`;
  // stop() force-drops this database on a shared server; a non-test_ name
  // must never get near that code path (local DATABASE_URL can be Neon).
  if (!/^test_[a-z0-9_]+$/.test(database)) {
    throw new Error(
      `host-Postgres reuse mode requires a database name matching test_[a-z0-9_]+, got "${database}"`,
    );
  }
  const schema = options.schema ?? "public";

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${ident(database)}`);
  } finally {
    await admin.end();
  }

  const connectionUri = replaceDatabasePath(baseUrl, database);
  const databaseUrl = `${connectionUri}?schema=${schema}`;

  return {
    container: null,
    connectionUri,
    databaseUrl,
    stop: async () => {
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      try {
        // FORCE terminates any lingering connections from the test process.
        // A failed DROP must propagate: swallowing it here is how 47 orphaned
        // test_* databases piled up on the CI service container unnoticed.
        await cleanup.query(
          `DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`,
        );
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function startPostgresContainer(
  options: StartPostgresOptions = {},
): Promise<PostgresTestContainer> {
  const mode = resolveHostPgMode(process.env);
  if (mode.kind === "reuse") {
    return startEphemeralOnHostPg(mode.url, options);
  }
  if (mode.kind === "shared") {
    return startEphemeralOnHostPg(await sharedTestPg(mode.port), options);
  }

  const {
    image = POSTGIS_TEST_IMAGE,
    database = `test_${randomUUID().replace(/-/g, "")}`,
    username = "postgres",
    password = "postgres",
    schema = "public",
  } = options;

  const container = await new PostgreSqlContainer(image)
    .withDatabase(database)
    .withUsername(username)
    .withPassword(password)
    .withStartupTimeout(300_000)
    .start();

  const connectionUri = container.getConnectionUri();
  const databaseUrl = `${connectionUri}?schema=${schema}`;

  return {
    container,
    connectionUri,
    databaseUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

const MIGRATIONS_DIR = join("packages", "db", "prisma", "migrations");

// Advisory locks for the template path. Locktags are scoped to the database
// the session is connected to, so mutual exclusion only holds because every
// process takes them on an admin connection to the SAME base URL: the reuse
// URL in CI, or th-test-pg's `postgres` database locally. Don't move the
// acquiring connection elsewhere.
//
// - Per-template lock (TEMPLATE_LOCK_CLASS, hashtext(template name)): held
//   for check, build, copy and stamp of ONE template, so a session building
//   its WIP-migration template never blocks sessions on other fingerprints.
// - Retirement lock (RETIRE_LOCK, "th" "pg" as int16 pairs): held only while
//   retiring templates; each victim is dropped only if its per-template lock
//   can be TRY-locked, so a template is never dropped mid-build or mid-copy,
//   and the try (not a wait) rules out a deadlock between the two kinds.
const TEMPLATE_LOCK_CLASS = 0x7474;
const RETIRE_LOCK = [0x7468, 0x7067] as const;
/** Max wait for another file's build/copy of the same template. */
const TEMPLATE_LOCK_TIMEOUT = "150s";
/** Max run time of one `prisma migrate deploy` subprocess. */
const MIGRATE_DEPLOY_TIMEOUT_MS = 180_000;

function listMigrationNames(): string[] {
  const dir = join(findWorkspaceRoot(process.cwd()), MIGRATIONS_DIR);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Quote a Postgres identifier for interpolation into DDL. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Fingerprints the migration SET AND CONTENT so an edited-in-place
 * migration.sql (bad practice, but it happens in dev) retires the template
 * instead of silently serving the old schema from a long-lived server.
 */
function migrationsFingerprint(migrationNames: string[]): string {
  const root = join(findWorkspaceRoot(process.cwd()), MIGRATIONS_DIR);
  const hash = createHash("sha256");
  for (const name of migrationNames) {
    hash.update(name);
    hash.update("\0");
    const sqlPath = join(root, name, "migration.sql");
    if (existsSync(sqlPath)) hash.update(readFileSync(sqlPath));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function databaseNameOf(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
}

function sameServer(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return (
    ua.hostname === ub.hostname &&
    (ua.port || "5432") === (ub.port || "5432") &&
    ua.username === ub.username
  );
}

async function hasAllMigrationsApplied(
  client: pg.Client,
  migrationNames: string[],
): Promise<boolean> {
  let rows: Array<{ migration_name: string }>;
  try {
    const result = await client.query<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    rows = result.rows;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return false; // no table yet
    throw err;
  }
  const applied = new Set(rows.map((row) => row.migration_name));
  return migrationNames.every((name) => applied.has(name));
}

/**
 * Runs `pnpm exec prisma migrate deploy` in its own process group and, on
 * timeout, kills the whole group: SIGTERM to pnpm alone would leave prisma
 * and its schema engine migrating the template after this caller has given
 * up and released the per-template lock.
 */
async function spawnPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: findWorkspaceRoot(process.cwd()),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Group already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, MIGRATE_DEPLOY_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `prisma migrate deploy timed out after ${MIGRATE_DEPLOY_TIMEOUT_MS / 1000}s (process group killed)\n${output}`,
          ),
        );
      } else if (code === 0) {
        resolve();
      } else {
        // pnpm may exit while a grandchild lingers; make sure nothing does.
        killGroup();
        reject(
          new Error(
            `prisma migrate deploy failed (code ${code}, signal ${signal})\n${output}`,
          ),
        );
      }
    });
  });
}

async function retireStaleTemplates(
  admin: pg.Client,
  current: string,
): Promise<void> {
  const { rows } = await admin.query<{
    datname: string;
    comment: string | null;
    created: Date | null;
  }>(
    `SELECT d.datname,
            shobj_description(d.oid, 'pg_database') AS comment,
            (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification AS created
       FROM pg_database d
      WHERE d.datname LIKE 'test\\_template\\_%'`,
  );
  const scannedComment = new Map(rows.map((r) => [r.datname, r.comment]));
  const retire = selectTemplatesToRetire(
    rows.map((r) => ({
      name: r.datname,
      lastUsedMs: parseTemplateComment(r.comment) ?? r.created?.getTime(),
    })),
    current,
    Date.now(),
  );
  for (const name of retire) {
    const held = await admin.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
      [TEMPLATE_LOCK_CLASS, name],
    );
    // Locked by someone else = being built or copied right now; keep it.
    if (!held.rows[0]?.locked) continue;
    try {
      // A copy may have finished (and re-stamped last_used) between the scan
      // and the try-lock; a template used just now is not stale.
      const now = await admin.query<{ comment: string | null }>(
        "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
        [name],
      );
      if (!now.rowCount) continue; // already gone
      if ((now.rows[0]?.comment ?? null) !== (scannedComment.get(name) ?? null)) {
        continue;
      }
      await admin.query(`DROP DATABASE IF EXISTS ${ident(name)}`);
    } catch (err) {
      // Nobody should be connected to a template; if someone is, keep it
      // rather than kill their connection, and retry at the next build.
      console.warn(`[test-utils/postgres] could not retire ${name}`, err);
    } finally {
      try {
        await admin.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
          TEMPLATE_LOCK_CLASS,
          name,
        ]);
      } catch {
        // Dead connection: session end releases the lock; don't mask the
        // error that got us here.
      }
    }
  }
}

/**
 * Drops `database` and recreates it as a copy of a fully-migrated template
 * database, building (and verifying) the template first if this server does
 * not have one for the current migration set. The whole sequence holds this
 * template's advisory lock, so files on the same migration set serialize
 * instead of racing the build or the copy, while files on other migration
 * sets (other working trees) proceed in parallel.
 */
async function recreateFromMigratedTemplate(
  baseUrl: string,
  database: string,
  migrationNames: string[],
): Promise<void> {
  const template = `test_template_${migrationsFingerprint(migrationNames)}`;

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    // Bounds the wait below; a waiter that gives up falls back to a plain
    // migrate instead of building or copying long after its hook timed out.
    await admin.query(`SET lock_timeout = '${TEMPLATE_LOCK_TIMEOUT}'`);
    await admin.query("SELECT pg_advisory_lock($1, hashtext($2))", [
      TEMPLATE_LOCK_CLASS,
      template,
    ]);
    try {
      const existing = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [template],
      );
      let templateReady = false;
      if (existing.rowCount) {
        const check = new pg.Client({
          connectionString: replaceDatabasePath(baseUrl, template),
        });
        await check.connect();
        try {
          templateReady = await hasAllMigrationsApplied(check, migrationNames);
        } finally {
          await check.end();
        }
        if (!templateReady) {
          // A previous build died mid-migrate; rebuild from scratch.
          await admin.query(`DROP DATABASE ${ident(template)} WITH (FORCE)`);
        }
      }

      if (!templateReady) {
        // New fingerprint. Retire templates idle for a day or beyond the cap
        // so they don't pile up on long-lived servers, but keep recent ones:
        // sessions with different migration sets share a server and would
        // otherwise rebuild each other's template on every run.
        await admin.query("SELECT pg_advisory_lock($1, $2)", [...RETIRE_LOCK]);
        try {
          await retireStaleTemplates(admin, template);
        } finally {
          try {
            await admin.query("SELECT pg_advisory_unlock($1, $2)", [
              ...RETIRE_LOCK,
            ]);
          } catch {
            // Dead connection: session end releases the lock; don't mask
            // the root-cause error from the try block.
          }
        }
        await admin.query(`CREATE DATABASE ${ident(template)}`);
        await spawnPrismaMigrateDeploy(replaceDatabasePath(baseUrl, template));
        const verify = new pg.Client({
          connectionString: replaceDatabasePath(baseUrl, template),
        });
        await verify.connect();
        try {
          if (!(await hasAllMigrationsApplied(verify, migrationNames))) {
            throw new Error(
              `template database ${template} is incomplete after prisma migrate deploy`,
            );
          }
        } finally {
          await verify.end();
        }
      }

      await admin.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`);
      // The verify connection above closes asynchronously on the server side;
      // a straggling backend makes CREATE ... TEMPLATE fail with 55006.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await admin.query(
            `CREATE DATABASE ${ident(database)} TEMPLATE ${ident(template)}`,
          );
          break;
        } catch (err) {
          if ((err as { code?: string }).code !== "55006" || attempt >= 5) {
            throw err;
          }
          await sleep(200 * attempt);
        }
      }
      await admin.query(
        `COMMENT ON DATABASE ${ident(template)} IS '${formatTemplateComment(Date.now())}'`,
      );
    } finally {
      try {
        await admin.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
          TEMPLATE_LOCK_CLASS,
          template,
        ]);
      } catch {
        // Session teardown releases the lock anyway; don't let a dead
        // connection here mask the root-cause error from the try block.
      }
    }
  } finally {
    await admin.end();
  }
}

/**
 * Brings the database at `databaseUrl` to the current migration state.
 *
 * - Already fully migrated → no-op.
 * - Host-Postgres reuse mode (CI service container, an explicit throwaway
 *   via `TESTCONTAINERS_REUSE_DATABASE_URL`, or the local shared
 *   `th-test-pg`) → drop the empty `test_*`
 *   database and recreate it from a once-migrated template database, which is
 *   near-instant. Previously every one of the ~28 integration files ran a full
 *   `prisma migrate deploy` subprocess serially; on a saturated CI runner that
 *   blew the 300s beforeAll timeout and cascaded into P1003 failures.
 * - Otherwise (per-file Testcontainers) → spawn `prisma migrate deploy` as
 *   before.
 */
export async function runPrismaMigrateDeploy(
  databaseUrl: string,
): Promise<void> {
  const migrationNames = listMigrationNames();

  const target = new pg.Client({ connectionString: databaseUrl });
  await target.connect();
  let alreadyMigrated: boolean;
  try {
    alreadyMigrated = await hasAllMigrationsApplied(target, migrationNames);
  } finally {
    await target.end();
  }
  if (alreadyMigrated) return;

  const reuseBase = resolveReusableHostPg() ?? sharedBaseUrlIfActive();
  const database = databaseNameOf(databaseUrl);
  if (
    reuseBase &&
    sameServer(reuseBase, databaseUrl) &&
    database.startsWith("test_") &&
    !database.startsWith("test_template_")
  ) {
    try {
      await recreateFromMigratedTemplate(reuseBase, database, migrationNames);
      return;
    } catch (err) {
      // Fall back to a real migrate so a template-path bug degrades to the
      // old slow-but-correct behaviour instead of failing the suite.
      console.warn(
        `[test-utils/postgres] template fast-path failed for ${database}; falling back to prisma migrate deploy`,
        err,
      );
      // The fast path may have dropped the database before failing; the
      // fallback migrate needs it to exist again.
      const admin = new pg.Client({ connectionString: reuseBase });
      await admin.connect();
      try {
        const exists = await admin.query(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [database],
        );
        if (!exists.rowCount) {
          await admin.query(`CREATE DATABASE ${ident(database)}`);
        }
      } finally {
        await admin.end();
      }
    }
  }

  await spawnPrismaMigrateDeploy(databaseUrl);
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}
