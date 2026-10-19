#!/usr/bin/env node
/**
 * Resource-burn collector for `[skill:resource-burn]`.
 *
 * Queries Sentry's Discover/EAP events API for consumption per metered
 * dependency and prints a compact summary the skill folds into
 * `docs/ops/resource-burn.md`.
 *
 * ## Why this exists rather than the Sentry MCP
 *
 * The MCP authenticates via interactive OAuth. That token expires, and a
 * headless weekly run has no way to refresh it — an expired OAuth token is
 * exactly what killed the 2026-08-10 scheduled curation run. A long-lived
 * `SENTRY_AUTH_TOKEN` has no such failure mode, so the scheduled path uses
 * this script and the MCP stays for interactive work.
 *
 * ## Auth
 *
 *   SENTRY_AUTH_TOKEN   required (org:read / event:read scope)
 *   SENTRY_ORG          optional, defaults to "hearth-fire"
 *   SENTRY_API_HOST     optional, defaults to https://us.sentry.io
 *
 * ## Usage
 *
 *   node scripts/sentry-burn.mjs [--period 7d] [--env production] [--json]
 *
 * Exits non-zero on auth/transport failure so `run.sh` reports it rather than
 * writing a report full of zeroes that reads like "no usage".
 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const PERIOD = argOf("period", "7d");
const ENVIRONMENT = argOf("env", "production");
const AS_JSON = args.includes("--json");

const TOKEN = process.env.SENTRY_AUTH_TOKEN;
const ORG = process.env.SENTRY_ORG || "hearth-fire";
const HOST = process.env.SENTRY_API_HOST || "https://us.sentry.io";

if (!TOKEN) {
  console.error(
    "SENTRY_AUTH_TOKEN is not set.\n" +
      "This is the headless path — do NOT fall back to the Sentry MCP here; its\n" +
      "OAuth token expires and that is the failure this script exists to avoid.",
  );
  process.exit(2);
}

const DAYS = (() => {
  const m = /^(\d+)([hdw])$/.exec(PERIOD);
  if (!m) return 7;
  const n = Number(m[1]);
  return m[2] === "h" ? n / 24 : m[2] === "w" ? n * 7 : n;
})();

/**
 * One aggregate query. `query` is Sentry search syntax; `groupBy` is the
 * non-aggregate field to group on (omit to get a bare total).
 */
async function q({ query, groupBy, limit = 20 }) {
  const url = new URL(`${HOST}/api/0/organizations/${ORG}/events/`);
  url.searchParams.set("dataset", "spans");
  if (groupBy) url.searchParams.append("field", groupBy);
  url.searchParams.append("field", "count()");
  url.searchParams.set("query", `environment:${ENVIRONMENT} ${query}`.trim());
  url.searchParams.set("statsPeriod", PERIOD);
  url.searchParams.set("sort", "-count()");
  url.searchParams.set("per_page", String(limit));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Sentry ${res.status} for [${query}]: ${body.slice(0, 300)}`,
    );
  }
  const json = await res.json();
  return (json.data ?? []).map((row) => ({
    key: groupBy ? String(row[groupBy] ?? "") : "total",
    count: Number(row["count()"] ?? 0),
  }));
}

const sum = (rows) => rows.reduce((acc, r) => acc + r.count, 0);
const perDay = (total) => Math.round(total / DAYS);
const perMonth = (total) => Math.round((total / DAYS) * 30);

// Ceilings are read from the provider console, NOT inferred. `null` means
// "unknown" and the skill must render it as unknown rather than OK — an
// unmeasured ceiling cannot produce a utilisation.
const CEILINGS = { redis: 500_000 };

const main = async () => {
  const [redis, db, txns, httpClient] = await Promise.all([
    q({ query: "(span.op:db.redis OR span.description:*redis*)", groupBy: "span.description" }),
    // Every statement emits two spans (prisma + postgres otel origins); count the
    // prisma one only. Postgres twins and manual pool/connect spans are excluded.
    q({ query: "span.op:db sentry.origin:auto.db.otel.prisma", groupBy: "span.op" }),
    q({ query: "is_transaction:true", groupBy: "transaction" }),
    q({ query: "span.op:http.client", groupBy: "span.description" }),
  ]);

  const redisTotal = sum(redis);
  const dbTotal = sum(db);
  const txnTotal = sum(txns);

  // Traffic but zero DB spans means the origin filter matched nothing (SDK
  // rename), not "no usage": flag it and exit non-zero, like a transport failure.
  const dbUnverified = dbTotal === 0 && txnTotal > 0;

  const report = {
    period: PERIOD,
    environment: ENVIRONMENT,
    days: DAYS,
    redis: {
      byCommand: redis,
      total: redisTotal,
      perDay: perDay(redisTotal),
      perMonth: perMonth(redisTotal),
      ceiling: CEILINGS.redis,
      utilPct: Math.round((perMonth(redisTotal) / CEILINGS.redis) * 100),
      // The signature that caused the 2026-07-28 quota exhaustion. Its return
      // is a regression, not noise.
      jobTrackerPresent: redis.some((r) =>
        /zadd|zremrangebyrank|multi|exec|hget/.test(r.key),
      ),
    },
    postgres: {
      status: dbUnverified ? "unverified" : "ok",
      total: dbTotal,
      perDay: perDay(dbTotal),
      ceiling: null,
    },
    transactions: {
      total: txnTotal,
      perDay: perDay(txnTotal),
      top: txns.slice(0, 6),
      // Amplification is the number that matters: total traffic growing is
      // expected, each request costing more DB work is not.
      queriesPerTxn: txnTotal && !dbUnverified ? Number((dbTotal / txnTotal).toFixed(1)) : null,
    },
    httpClient,
  };

  if (dbUnverified) {
    console.error(
      "resource-burn: Postgres UNVERIFIED — origin filter matched no db spans " +
        "while transactions exist (did the Sentry SDK rename sentry.origin?).",
    );
    process.exitCode = 1;
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const r = report.redis;
  console.log(`# resource-burn — ${ENVIRONMENT} — last ${PERIOD}\n`);
  console.log(
    `Upstash Redis  ${r.total} cmds (${r.perDay}/day, ~${r.perMonth}/month) ` +
      `= ${r.utilPct}% of ${r.ceiling}/month`,
  );
  for (const row of r.byCommand) console.log(`    ${row.key.padEnd(28)} ${row.count}`);
  if (r.jobTrackerPresent) {
    console.log(
      "    !! JobRunTracker signature is BACK — that caused the 2026-07-28 outage",
    );
  }
  console.log(
    dbUnverified
      ? "\nNeon Postgres  UNVERIFIED (origin filter matched nothing; not zero usage)"
      : `\nNeon Postgres  ${report.postgres.total} SQL statements ` +
          `(prisma spans; postgres twins and pool spans excluded) ` +
          `(${report.postgres.perDay}/day) — ceiling UNKNOWN, read it from the console`,
  );
  console.log(
    `\nTransactions   ${report.transactions.total} (${report.transactions.perDay}/day), ` +
      `${dbUnverified ? "UNVERIFIED" : report.transactions.queriesPerTxn} SQL statements per transaction`,
  );
  for (const row of report.transactions.top) {
    console.log(`    ${row.key.padEnd(28)} ${row.count}`);
  }
  console.log(
    `\nhttp.client    ${report.httpClient.length} distinct ` +
      `(Resend / Expo / ZipTax live here; empty = UNVERIFIED, not OK)`,
  );
  for (const row of report.httpClient.slice(0, 8)) {
    console.log(`    ${row.key.slice(0, 60).padEnd(62)} ${row.count}`);
  }
};

main().catch((err) => {
  console.error(`resource-burn collection FAILED: ${err.message}`);
  process.exit(1);
});
