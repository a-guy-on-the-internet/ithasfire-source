/**
 * Stripe CLI listener config for the local dev stack.
 *
 * WHY: `stripe listen` signs deliveries with a secret tied to the Stripe
 * account the CLI is attached to. The dev API runs on the account behind
 * `STRIPE_SECRET_KEY` (the "Hearthfire sandbox"), while the CLI's default
 * profile is a different account — so a listener started without a key never
 * sees the API's events, and a listener on the right account signs with a
 * secret the API does not know (verified 2026-09-02: every sandbox delivery
 * 400'd with `stripe_webhook_bad_signature`).
 *
 * Fix: attach the listener to the API's own key (passed as `STRIPE_API_KEY`
 * in the child env — never on argv, so it cannot leak through `ps`/errors),
 * obtain THAT account's signing secret via `stripe listen --print-secret`,
 * and pin `STRIPE_WEBHOOK_SECRET` in the API child's env (the API honours
 * `DEV_ENV_PINS`, see apps/api/src/index.ts).
 *
 * Pure helpers live at the top (unit-tested in
 * apps/api/test/stripe-listen-config.test.ts); the I/O lives at the bottom.
 * Anything that could carry the key (CLI error output) goes through
 * `redactSecrets`.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Where STRIPE_SECRET_KEY is looked up, first hit wins — the same order the
 * API resolves it (apps/api/src/index.ts: apps/api/.env.local, then the repo
 * root .env.local, then whatever is already in the shell env).
 */
const KEY_ENV_FILES = ["apps/api/.env.local", ".env.local"];
const KEY_ENV_VAR = "STRIPE_SECRET_KEY";
const WEBHOOK_ROUTE = "apps/api/src/routes/stripe/webhook.ts";
const ACCOUNT_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Events the API's webhook handler switches on. Derived at boot from the
 * `case "…":` labels in webhook.ts; this list is the fallback if the file
 * cannot be read/parsed. Keep in sync when adding a handler (the unit test
 * fails on drift).
 */
const FALLBACK_WEBHOOK_EVENT_TYPES = Object.freeze([
  "account.application.deauthorized",
  "account.updated",
  "charge.dispute.closed",
  "charge.dispute.created",
  "charge.dispute.funds_reinstated",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.updated",
  "charge.refund.updated",
  "charge.refunded",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "customer.updated",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.upcoming",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "radar.early_fraud_warning.created",
  "radar.early_fraud_warning.updated",
]);

/**
 * Read one KEY=value from dotenv-style text. Handles `export KEY=`, quoted
 * values and `#` comments; returns null when absent or empty.
 * @param {string} content
 * @param {string} name
 * @returns {string|null}
 */
function parseEnvValue(content, name) {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * STRIPE_SECRET_KEY: apps/api/.env.local → repo-root .env.local → shell env.
 * @param {string} rootDir
 * @param {{ readFile?: (p: string) => string, env?: NodeJS.ProcessEnv }} [io]
 * @returns {{ key: string, source: string } | null}
 */
function readStripeSecretKey(rootDir, io = {}) {
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const env = io.env ?? process.env;
  for (const rel of KEY_ENV_FILES) {
    let content;
    try {
      content = readFile(path.join(rootDir, rel));
    } catch {
      continue;
    }
    const key = parseEnvValue(content, KEY_ENV_VAR);
    if (key) return { key, source: rel };
  }
  const fromEnv = env[KEY_ENV_VAR];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { key: fromEnv.trim(), source: `process.env.${KEY_ENV_VAR}` };
  }
  return null;
}

/**
 * Stripe event types the webhook route handles, read from its
 * `case "<type>":` labels. Sorted + de-duplicated. Empty array when the
 * source has no such labels (caller falls back).
 * @param {string} webhookSource
 * @returns {string[]}
 */
function deriveWebhookEventTypes(webhookSource) {
  const found = new Set();
  const re = /case\s+"([a-z_]+(?:\.[a-z_]+)+)"\s*:/g;
  let m;
  while ((m = re.exec(webhookSource)) !== null) found.add(m[1]);
  return [...found].sort();
}

/**
 * argv for `stripe` — the key is NOT here; see `buildStripeListenEnv`.
 * @param {{ forwardTo: string, events: readonly string[] }} input
 * @returns {string[]}
 */
function buildStripeListenArgs({ forwardTo, events }) {
  const args = ["listen"];
  if (events && events.length > 0) args.push("--events", events.join(","));
  args.push("--forward-to", forwardTo);
  return args;
}

/**
 * Child env for any `stripe` invocation: the CLI honours STRIPE_API_KEY
 * (`stripe listen --help`: "Use --api-key … (or set STRIPE_API_KEY)").
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string} apiKey
 * @returns {NodeJS.ProcessEnv}
 */
function buildStripeListenEnv(baseEnv, apiKey) {
  return { ...baseEnv, STRIPE_API_KEY: apiKey };
}

/**
 * Env for the API child: the listener's signing secret, pinned so the API's
 * `override:true` dotenv load of apps/api/.env.local cannot clobber it.
 * Existing DEV_ENV_PINS entries are kept.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string} webhookSecret
 * @returns {NodeJS.ProcessEnv}
 */
function applyWebhookSecretOverride(baseEnv, webhookSecret) {
  const pins = new Set(
    (baseEnv.DEV_ENV_PINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  pins.add("STRIPE_WEBHOOK_SECRET");
  return {
    ...baseEnv,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    DEV_ENV_PINS: [...pins].join(","),
  };
}

/**
 * Mask Stripe keys / signing secrets in free text (CLI errors echo env/argv).
 * @param {string} text
 */
function redactSecrets(text) {
  return String(text).replace(
    /\b((?:sk|rk|pk)_(?:test|live)_|whsec_)[A-Za-z0-9]{4}[A-Za-z0-9]*/g,
    "$1****",
  );
}

/**
 * Human-readable account line for the boot banner.
 * @param {{ id: string, name: string|null, livemode?: boolean }} account
 */
function formatAccountBanner(account) {
  const name = account.name ?? "(no display name)";
  const mode = account.livemode ? "LIVE" : "test";
  return `Stripe listener attached to "${name}" (${account.id}, ${mode} mode)`;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/**
 * `STRIPE_API_KEY=<key> stripe listen --print-secret` → this account's whsec.
 * @param {string} apiKey
 * @returns {string}
 */
function printListenSecret(apiKey) {
  let out;
  try {
    out = execFileSync("stripe", ["listen", "--print-secret"], {
      env: buildStripeListenEnv(process.env, apiKey),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).toString();
  } catch (err) {
    const detail = redactSecrets(
      err.stderr?.toString() || err.stdout?.toString() || err.message || "",
    );
    throw new Error(`stripe listen --print-secret failed: ${detail.trim().slice(0, 300)}`);
  }
  const secret = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^whsec_[A-Za-z0-9]+$/.test(l));
  if (!secret) throw new Error("stripe listen --print-secret returned no whsec_ line");
  return secret;
}

/**
 * GET /v1/account with the key → { id, name, livemode }. Bounded by
 * ACCOUNT_LOOKUP_TIMEOUT_MS; throws on any failure (caller degrades).
 * @param {string} apiKey
 * @param {typeof fetch} [fetchImpl]
 */
async function fetchStripeAccount(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl("https://api.stripe.com/v1/account", {
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
    signal: AbortSignal.timeout(ACCOUNT_LOOKUP_TIMEOUT_MS),
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`Stripe /v1/account failed: ${body.error?.code ?? res.status}`);
  }
  return {
    id: body.id,
    name: body.settings?.dashboard?.display_name ?? body.business_profile?.name ?? null,
    livemode: Boolean(body.livemode),
  };
}

/**
 * Everything a dev script needs to start a listener on the API's account.
 * Throws (redacted message) when there is no usable test key or the CLI
 * cannot produce a signing secret. An account-name lookup failure does NOT
 * throw: the secret is already in hand, so the result carries
 * `account: { id: "unknown", name: null }` plus `accountError` for the log.
 * @param {{ rootDir: string, forwardTo: string, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} input
 */
async function resolveStripeListenerConfig({ rootDir, forwardTo, fetchImpl, env }) {
  const found = readStripeSecretKey(rootDir, { env });
  if (!found) {
    throw new Error(
      `${KEY_ENV_VAR} not found in ${KEY_ENV_FILES.join(", ")} or the shell env`,
    );
  }
  if (!found.key.startsWith("sk_test_")) {
    throw new Error(
      `${KEY_ENV_VAR} from ${found.source} is not a test-mode key (${redactSecrets(found.key.slice(0, 8))}…); refusing to start a listener on it`,
    );
  }
  let events = [];
  try {
    events = deriveWebhookEventTypes(fs.readFileSync(path.join(rootDir, WEBHOOK_ROUTE), "utf8"));
  } catch {
    /* fall through to the hardcoded list */
  }
  const eventsSource = events.length > 0 ? WEBHOOK_ROUTE : "fallback list";
  if (events.length === 0) events = [...FALLBACK_WEBHOOK_EVENT_TYPES];

  const webhookSecret = printListenSecret(found.key);

  let account = { id: "unknown", name: null, livemode: false };
  let accountError = null;
  try {
    account = await fetchStripeAccount(found.key, fetchImpl);
  } catch (err) {
    accountError = redactSecrets(err?.message ?? String(err));
  }

  return {
    apiKey: found.key,
    keySource: found.source,
    webhookSecret,
    account,
    accountError,
    events,
    eventsSource,
    listenArgs: buildStripeListenArgs({ forwardTo, events }),
    listenEnv: (baseEnv) => buildStripeListenEnv(baseEnv, found.key),
  };
}

module.exports = {
  KEY_ENV_FILES,
  KEY_ENV_VAR,
  FALLBACK_WEBHOOK_EVENT_TYPES,
  WEBHOOK_ROUTE,
  ACCOUNT_LOOKUP_TIMEOUT_MS,
  parseEnvValue,
  readStripeSecretKey,
  deriveWebhookEventTypes,
  buildStripeListenArgs,
  buildStripeListenEnv,
  applyWebhookSecretOverride,
  redactSecrets,
  formatAccountBanner,
  printListenSecret,
  fetchStripeAccount,
  resolveStripeListenerConfig,
};
