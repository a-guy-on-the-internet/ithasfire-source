import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env.local files
// Priority: apps/web/.env.local > apps/api/.env.local
// This ensures STRIPE_SECRET_KEY and other secrets are available for E2E tests
dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, "../api/.env.local") });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const apiBaseUrl =
  process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
const explicitApiReadyUrl = process.env.PLAYWRIGHT_API_READY_URL;
const explicitApiReadyUrlObject = explicitApiReadyUrl
  ? new URL(explicitApiReadyUrl)
  : null;
const apiReadyToken = process.env.PLAYWRIGHT_API_READY_TOKEN ?? randomUUID();
const apiReadyPath =
  process.env.PLAYWRIGHT_API_READY_PATH ??
  (explicitApiReadyUrlObject
    ? explicitApiReadyUrlObject.pathname
    : `/ready/${apiReadyToken}`);
const apiReadyUrl =
  explicitApiReadyUrl ?? `http://127.0.0.1:3101${apiReadyPath}`;
const apiReadyPort =
  explicitApiReadyUrlObject?.port ||
  (explicitApiReadyUrlObject ? "80" : "3101");
const playwrightDatabaseUrl =
  process.env.PLAYWRIGHT_DATABASE_URL ??
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/dev?schema=public";
const authFile = "playwright/.auth/user.json";
// Budget for the API webServer entry, which covers DB reset + seed + API boot +
// readiness polling. CI on a shared VM can need more than the local default.
const apiWebServerTimeoutMs =
  Number(process.env.PLAYWRIGHT_API_WEBSERVER_TIMEOUT_MS) > 0
    ? Number(process.env.PLAYWRIGHT_API_WEBSERVER_TIMEOUT_MS)
    : 120_000;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Hard stop so CI/local runs never hang forever.
  // Keeping this modest forces us to fix real deadlocks instead of waiting them out.
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: authFile },
      // Guest-only smoke tests live alongside authenticated tests, but they
      // should not run with storageState.
      testIgnore: [
        /.*\.setup\.ts/,
        /home-location-modes\.spec\.ts/,
        /coming-soon-review-form\.spec\.ts/,
        // Reads resting button colours on /sign-up, which redirects away once
        // authenticated. Guest project only.
        /button-label-color\.spec\.ts/,
        // Drives /sign-in with a stubbed session; a real storageState session
        // would race the stub and the auto-redirect. Guest project only —
        // running it in both projects just doubles a hermetic test.
        /sign-in-bounce\.spec\.ts/,
      ],
    },
    {
      name: "guest",
      // Guest tests should not depend on auth setup.
      // Some runs intentionally validate signed-out flows only, and Better Auth
      // account creation can be flaky (e.g. idempotent 422 responses).
      testIgnore: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer:
    // ── E2E_USE_LIVE_STACK=1 ──────────────────────────────────────────────
    // Run against the dev stack you ALREADY have up, and touch the database
    // not at all.
    //
    // Why this mode exists: every other branch below boots
    // `scripts/wait-api-healthy.cjs`, whose readiness path runs
    // `pnpm -w db:reset:remote` → `prisma migrate reset --force`. That WIPES
    // the local dev database (and is refused outright by Prisma's agent
    // guardrail). Correct for a hermetic suite, but it priced casual live
    // verification so high that nobody did it — and a class of defect that
    // only appears in a real browser (page-level a11y-name collisions, SSR
    // hydration mismatches, reflow at 320px) sailed through unit tests and
    // code review untouched. Cheap live checks have to be genuinely cheap.
    //
    // Both entries below are pure readiness probes: `reuseExistingServer`
    // makes Playwright hit `url` FIRST and skip `command` entirely when the
    // server answers, so `command` is only ever reached as a fail-fast
    // message. Nothing here can migrate, seed, reset or drop anything.
    //
    // Trade-off, stated plainly: your DB is NOT pristine, so specs that
    // assume seeded fixtures may fail. Use it for UI/interaction work; use
    // the default (wiping) path for money, settlement and journey suites.
    // Any spec run this way must clean up whatever it creates.
    (process.env.E2E_USE_LIVE_STACK === "1"
      ? [
          {
            command:
              "node -e \"console.error('\\\\n[e2e] E2E_USE_LIVE_STACK=1 expects an ALREADY-RUNNING web server on http://localhost:3000.\\\\n[e2e] Start the stack first (pnpm dev), or drop E2E_USE_LIVE_STACK to let Playwright boot it (that path RESETS the dev database).\\\\n'); process.exit(1)\"",
            url: baseURL,
            reuseExistingServer: true,
            timeout: 20_000,
            stdout: "pipe",
            stderr: "pipe",
          },
          {
            command:
              "node -e \"console.error('\\\\n[e2e] E2E_USE_LIVE_STACK=1 expects an ALREADY-RUNNING API on http://localhost:3001.\\\\n[e2e] Start the stack first (pnpm dev).\\\\n'); process.exit(1)\"",
            url: `${apiBaseUrl}/health`,
            reuseExistingServer: true,
            timeout: 20_000,
            stdout: "pipe",
            stderr: "pipe",
          },
        ]
      : // Some E2E specs are API-only and don't need Next.js. Keeping those tests
        // runnable even when the web package is in flux is important for payment
        // adapters and infra confidence.
        process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1"
        ? [
            {
              command: "node ../../scripts/wait-api-healthy.cjs",
              url: apiReadyUrl,
              reuseExistingServer: false,
              timeout: apiWebServerTimeoutMs,
              stdout: "pipe",
              stderr: "pipe",
              env: {
                PLAYWRIGHT_E2E: "1",
                PLAYWRIGHT_WEBSERVER_MODE: "1",
                PLAYWRIGHT_API_FRESH_START: "1",
                PLAYWRIGHT_API_BASE_URL: apiBaseUrl,
                PLAYWRIGHT_API_READY_PATH: apiReadyPath,
                PLAYWRIGHT_API_READY_PORT: apiReadyPort,
                PLAYWRIGHT_DATABASE_URL: playwrightDatabaseUrl,
                DATABASE_URL: playwrightDatabaseUrl,
                APP_BASE_URL: apiBaseUrl,
                BETTER_AUTH_BASE_URL: apiBaseUrl,
                BETTER_AUTH_TRUSTED_ORIGINS:
                  process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? baseURL,
                // JWKS settings for JWT verification - enables authenticated tRPC calls
                BETTER_AUTH_JWKS_URL: `${apiBaseUrl}/api/auth/jwks`,
                BETTER_AUTH_ISSUER: apiBaseUrl,
                BETTER_AUTH_AUDIENCE: apiBaseUrl,
                REDIS_URL:
                  process.env.PLAYWRIGHT_REDIS_URL ??
                  process.env.REDIS_URL ??
                  "redis://127.0.0.1:6379",
                SMTP_HOST:
                  process.env.PLAYWRIGHT_SMTP_HOST ??
                  process.env.SMTP_HOST ??
                  "127.0.0.1",
                SMTP_PORT:
                  process.env.PLAYWRIGHT_SMTP_PORT ??
                  process.env.SMTP_PORT ??
                  "1025",
                SMTP_SECURE: process.env.PLAYWRIGHT_SMTP_SECURE ?? "0",
                SMTP_DEFAULT_FROM_EMAIL:
                  process.env.PLAYWRIGHT_SMTP_DEFAULT_FROM_EMAIL ??
                  process.env.SMTP_DEFAULT_FROM_EMAIL ??
                  "no-reply@ithasfire.local",
                E2E_RESET_SECRET:
                  process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
                STRIPE_SECRET_KEY:
                  process.env.PLAYWRIGHT_STRIPE_SECRET_KEY ??
                  process.env.STRIPE_SECRET_KEY,
                // Only pass STRIPE_BASE_URL if explicitly set (don't default to stripe-mock)
                ...(process.env.PLAYWRIGHT_STRIPE_BASE_URL ||
                process.env.STRIPE_BASE_URL
                  ? {
                      STRIPE_BASE_URL:
                        process.env.PLAYWRIGHT_STRIPE_BASE_URL ??
                        process.env.STRIPE_BASE_URL,
                    }
                  : {}),
                PRISMA_CLIENT_ENGINE_TYPE:
                  process.env.PRISMA_CLIENT_ENGINE_TYPE ?? "library",
              },
            },
          ]
        : [
            {
              // Start the API in a detached background process so tests don't depend on
              // a manually running API.
              // Logs/pid are managed by the repo helper scripts.
              // NOTE: `pnpm api:bg` exits immediately (detached). Playwright expects the
              // command to stay alive until the URL is reachable, so we use a tiny
              // node script that starts the detached API and polls /health.
              command: "node ../../scripts/wait-api-healthy.cjs",
              url: apiReadyUrl,
              // Always start the managed E2E API instance with the intended local DB/env.
              reuseExistingServer: false,
              timeout: apiWebServerTimeoutMs,
              stdout: "pipe",
              stderr: "pipe",
              env: {
                PLAYWRIGHT_E2E: "1",
                // Tell scripts/wait-api-healthy.cjs to stay alive so Playwright doesn't
                // think the webServer "exited early".
                PLAYWRIGHT_WEBSERVER_MODE: "1",
                PLAYWRIGHT_API_FRESH_START: "1",
                PLAYWRIGHT_API_BASE_URL: apiBaseUrl,
                PLAYWRIGHT_API_READY_PATH: apiReadyPath,
                PLAYWRIGHT_API_READY_PORT: apiReadyPort,
                // E2E must use local DB for determinism.
                PLAYWRIGHT_DATABASE_URL: playwrightDatabaseUrl,
                DATABASE_URL: playwrightDatabaseUrl,
                // Ensure API gets a predictable base URL for Better Auth.
                APP_BASE_URL: apiBaseUrl,
                BETTER_AUTH_BASE_URL: apiBaseUrl,
                // Let Better Auth accept requests originating from the web app during E2E.
                BETTER_AUTH_TRUSTED_ORIGINS:
                  process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? baseURL,
                // JWKS settings for JWT verification - enables authenticated tRPC calls
                BETTER_AUTH_JWKS_URL: `${apiBaseUrl}/api/auth/jwks`,
                BETTER_AUTH_ISSUER: apiBaseUrl,
                BETTER_AUTH_AUDIENCE: apiBaseUrl,
                // Real email-verification E2E (Mailpit + Redis).
                // Our Better Auth email verification hook is intentionally defensive and
                // will *skip sending* unless both Redis + SMTP are configured.
                REDIS_URL:
                  process.env.PLAYWRIGHT_REDIS_URL ??
                  process.env.REDIS_URL ??
                  "redis://127.0.0.1:6379",
                SMTP_HOST:
                  process.env.PLAYWRIGHT_SMTP_HOST ??
                  process.env.SMTP_HOST ??
                  "127.0.0.1",
                SMTP_PORT:
                  process.env.PLAYWRIGHT_SMTP_PORT ??
                  process.env.SMTP_PORT ??
                  "1025",
                // Mailpit's SMTP port is plain-text; do not negotiate TLS.
                SMTP_SECURE: process.env.PLAYWRIGHT_SMTP_SECURE ?? "0",
                SMTP_DEFAULT_FROM_EMAIL:
                  process.env.PLAYWRIGHT_SMTP_DEFAULT_FROM_EMAIL ??
                  process.env.SMTP_DEFAULT_FROM_EMAIL ??
                  "no-reply@ithasfire.local",
                // Enables the API's /e2e/reset endpoint (test-only) via a shared secret.
                E2E_RESET_SECRET:
                  process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
                // Optional: override the connected account used for E2E seed data.
                E2E_STRIPE_ACCOUNT_ID:
                  process.env.PLAYWRIGHT_E2E_STRIPE_ACCOUNT_ID ??
                  process.env.E2E_STRIPE_ACCOUNT_ID ??
                  process.env.STRIPE_CONNECT_ACCOUNT_ID,
                // Stripe - uses real Stripe sandbox by default.
                // Set STRIPE_BASE_URL only if you want to use stripe-mock (http://127.0.0.1:12111).
                STRIPE_SECRET_KEY:
                  process.env.PLAYWRIGHT_STRIPE_SECRET_KEY ??
                  process.env.STRIPE_SECRET_KEY,
                // Only pass STRIPE_BASE_URL if explicitly set (don't default to stripe-mock)
                ...(process.env.PLAYWRIGHT_STRIPE_BASE_URL ||
                process.env.STRIPE_BASE_URL
                  ? {
                      STRIPE_BASE_URL:
                        process.env.PLAYWRIGHT_STRIPE_BASE_URL ??
                        process.env.STRIPE_BASE_URL,
                    }
                  : {}),
                // Audio transcoder URL for audio upload E2E tests.
                ...(process.env.AUDIO_TRANSCODER_URL
                  ? { AUDIO_TRANSCODER_URL: process.env.AUDIO_TRANSCODER_URL }
                  : {}),
                // S3/MinIO config for file uploads (presigned URLs, audio, images).
                ...(process.env.S3_BUCKET
                  ? { S3_BUCKET: process.env.S3_BUCKET }
                  : {}),
                ...(process.env.S3_ENDPOINT
                  ? { S3_ENDPOINT: process.env.S3_ENDPOINT }
                  : {}),
                ...(process.env.S3_ACCESS_KEY_ID
                  ? { S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID }
                  : {}),
                ...(process.env.S3_SECRET_ACCESS_KEY
                  ? { S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY }
                  : {}),
                ...(process.env.S3_PUBLIC_BASE_URL
                  ? { S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL }
                  : {}),
                // Better Auth uses Prisma at runtime; ensure Prisma runs in a compatible engine mode.
                // Avoid the "engine type 'client' requires adapter/accelerateUrl" runtime crash.
                PRISMA_CLIENT_ENGINE_TYPE:
                  process.env.PRISMA_CLIENT_ENGINE_TYPE ?? "library",
              },
            },
            {
              // Reuse an already-running Next.js dev server.
              //
              // We intentionally do NOT try to start Next automatically here because
              // `next dev` can get stuck on `.next/dev/lock` if a prior instance died
              // uncleanly. In that case, automation can't reliably recover.
              //
              // Run the web server yourself (e.g. `pnpm web:dev:local`) and Playwright
              // will connect to it.
              //
              // If starting Next fails (e.g. temporary TS errors in @th/trpc), we still
              // want API-only journeys to be runnable. In that case, set
              // PLAYWRIGHT_REQUIRE_WEB_SERVER=0 and Playwright will skip starting Next.
              command:
                process.env.PLAYWRIGHT_REQUIRE_WEB_SERVER === "0"
                  ? "node -e \"const http=require('http'); const port=3000; http.createServer((req,res)=>{res.statusCode=200;res.end('ok');}).listen(port,'127.0.0.1',()=>{console.log('Dummy web server listening on '+port);}); setInterval(()=>{}, 1<<30)\""
                  : "pnpm --dir ../.. web:dev:local",
              url: baseURL,
              reuseExistingServer:
                process.env.PLAYWRIGHT_REQUIRE_WEB_SERVER === "0" ? true : true,
              timeout: 120_000,
              stdout: "pipe",
              stderr: "pipe",
              env: {
                WEB_API_BASE_URL: apiBaseUrl,
                NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
                PLAYWRIGHT_BASE_URL: baseURL,
                PLAYWRIGHT_API_BASE_URL: apiBaseUrl,
                PLAYWRIGHT_E2E: "1",
              },
            },
          ]) as any,

  // Ensure the detached API helper is stopped when Playwright exits.
  // This runs even if the tests fail.
  // Machine-wide HEAVY slot (scripts/dev/gate), held until the run ends. The
  // package scripts (test:e2e*, root e2e / smoke:pages) take it BEFORE
  // Playwright starts, so webServer boots inside the slot; this is the
  // re-entrant fallback for a bare `playwright test`, whose webServer boots
  // before globalSetup and so ungated (E2E_USE_LIVE_STACK=1 webServers only probe).
  globalSetup: path.resolve(__dirname, "../../scripts/dev/gate/playwright-global-setup.mjs"),
  globalTeardown: require.resolve("./e2e/global-teardown"),
});
