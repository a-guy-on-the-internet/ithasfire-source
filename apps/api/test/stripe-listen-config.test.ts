/**
 * Unit tests for scripts/lib/stripe-listen-config.cjs — the helper that
 * attaches the dev `stripe listen` to the API's own Stripe account. Lives
 * here (not under scripts/) so CI's api vitest step runs it.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../../..");
const helper = require(path.join(ROOT, "scripts/lib/stripe-listen-config.cjs")) as {
  KEY_ENV_FILES: readonly string[];
  FALLBACK_WEBHOOK_EVENT_TYPES: readonly string[];
  WEBHOOK_ROUTE: string;
  parseEnvValue: (content: string, name: string) => string | null;
  readStripeSecretKey: (
    rootDir: string,
    io?: { readFile?: (p: string) => string; env?: Record<string, string | undefined> },
  ) => { key: string; source: string } | null;
  deriveWebhookEventTypes: (src: string) => string[];
  buildStripeListenArgs: (input: { forwardTo: string; events: readonly string[] }) => string[];
  buildStripeListenEnv: (
    base: Record<string, string | undefined>,
    apiKey: string,
  ) => Record<string, string | undefined>;
  applyWebhookSecretOverride: (
    base: Record<string, string | undefined>,
    whsec: string,
  ) => Record<string, string | undefined>;
  redactSecrets: (text: string) => string;
  formatAccountBanner: (account: { id: string; name: string | null; livemode?: boolean }) => string;
};

const {
  KEY_ENV_FILES,
  FALLBACK_WEBHOOK_EVENT_TYPES,
  WEBHOOK_ROUTE,
  parseEnvValue,
  readStripeSecretKey,
  deriveWebhookEventTypes,
  buildStripeListenArgs,
  buildStripeListenEnv,
  applyWebhookSecretOverride,
  redactSecrets,
  formatAccountBanner,
} = helper;

const missing = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

describe("parseEnvValue", () => {
  it("reads plain, quoted and exported values and ignores comments", () => {
    const content = [
      "# STRIPE_SECRET_KEY=sk_test_commented",
      "OTHER=1",
      'export STRIPE_SECRET_KEY="sk_test_quoted"',
    ].join("\n");
    expect(parseEnvValue(content, "STRIPE_SECRET_KEY")).toBe("sk_test_quoted");
    expect(parseEnvValue("STRIPE_SECRET_KEY=sk_test_plain # trailing", "STRIPE_SECRET_KEY")).toBe(
      "sk_test_plain",
    );
    expect(parseEnvValue("STRIPE_SECRET_KEY=", "STRIPE_SECRET_KEY")).toBeNull();
    expect(parseEnvValue("UNRELATED=x", "STRIPE_SECRET_KEY")).toBeNull();
  });
});

describe("readStripeSecretKey", () => {
  it("mirrors the API's resolution order: apps/api/.env.local, root .env.local, shell env", () => {
    expect(KEY_ENV_FILES).toEqual(["apps/api/.env.local", ".env.local"]);
    const files: Record<string, string> = {
      "apps/api/.env.local": "STRIPE_SECRET_KEY=sk_test_api_local\n",
      ".env.local": "STRIPE_SECRET_KEY=sk_test_root_local\n",
    };
    const readFile = (p: string) => files[path.relative("/root", p)] ?? missing();
    expect(readStripeSecretKey("/root", { readFile, env: { STRIPE_SECRET_KEY: "sk_test_shell" } })).toEqual({
      key: "sk_test_api_local",
      source: "apps/api/.env.local",
    });
  });
  it("falls back to the repo-root .env.local, then to process.env", () => {
    const rootOnly = (p: string) =>
      p.endsWith(path.join("apps/api/.env.local")) ? "STRIPE_SECRET_KEY=\n" : "STRIPE_SECRET_KEY=sk_test_root_local\n";
    expect(readStripeSecretKey("/root", { readFile: rootOnly, env: {} })).toEqual({
      key: "sk_test_root_local",
      source: ".env.local",
    });
    expect(readStripeSecretKey("/root", { readFile: missing, env: { STRIPE_SECRET_KEY: " sk_test_shell " } })).toEqual({
      key: "sk_test_shell",
      source: "process.env.STRIPE_SECRET_KEY",
    });
  });
  it("never reads apps/api/.env (that file points at cloud resources)", () => {
    const seen: string[] = [];
    readStripeSecretKey("/root", {
      readFile: (p) => {
        seen.push(path.relative("/root", p));
        return missing();
      },
      env: {},
    });
    expect(seen).not.toContain(path.join("apps/api/.env"));
  });
  it("returns null when nothing provides the key", () => {
    expect(readStripeSecretKey("/root", { readFile: () => "NOPE=1", env: {} })).toBeNull();
    expect(readStripeSecretKey("/root", { readFile: missing, env: { STRIPE_SECRET_KEY: "" } })).toBeNull();
  });
});

describe("deriveWebhookEventTypes", () => {
  it("collects, de-duplicates and sorts case labels; ignores non-event strings", () => {
    const src = `
      switch (event.type) {
        case "payment_intent.succeeded": { break; }
        case "charge.dispute.created":
        case "charge.dispute.created": { break; }
        case "radar.early_fraud_warning.created":
        case "radar.early_fraud_warning.updated": { break; }
        default: { throw parseFailure(event, "charge.refunded", null); }
      }
      case "NotAnEvent": case "single": case 'no.single.quotes':`;
    expect(deriveWebhookEventTypes(src)).toEqual([
      "charge.dispute.created",
      "payment_intent.succeeded",
      "radar.early_fraud_warning.created",
      "radar.early_fraud_warning.updated",
    ]);
    expect(deriveWebhookEventTypes("nothing here")).toEqual([]);
  });

  it("derives the dispute / EFW / refund / payment_intent events from the real webhook route", () => {
    const events = deriveWebhookEventTypes(fs.readFileSync(path.join(ROOT, WEBHOOK_ROUTE), "utf8"));
    for (const required of [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "charge.refunded",
      "charge.refund.updated",
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.closed",
      "charge.dispute.funds_reinstated",
      "radar.early_fraud_warning.created",
      "radar.early_fraud_warning.updated",
    ]) {
      expect(events).toContain(required);
    }
    // The hardcoded fallback must not drift from the route: every fallback
    // entry is still handled, and nothing handled is missing from it.
    expect(events).toEqual([...FALLBACK_WEBHOOK_EVENT_TYPES]);
  });
});

describe("buildStripeListenArgs / buildStripeListenEnv", () => {
  it("keeps the key OFF argv and passes it as STRIPE_API_KEY in the env", () => {
    const args = buildStripeListenArgs({
      forwardTo: "http://localhost:3001/webhooks/stripe",
      events: ["a.b", "c.d"],
    });
    expect(args).toEqual(["listen", "--events", "a.b,c.d", "--forward-to", "http://localhost:3001/webhooks/stripe"]);
    expect(args.join(" ")).not.toContain("sk_");
    expect(buildStripeListenEnv({ PATH: "/bin" }, "sk_test_x")).toEqual({ PATH: "/bin", STRIPE_API_KEY: "sk_test_x" });
  });
  it("omits --events when the list is empty", () => {
    expect(buildStripeListenArgs({ forwardTo: "u", events: [] })).toEqual(["listen", "--forward-to", "u"]);
  });
});

describe("applyWebhookSecretOverride", () => {
  it("sets the secret and pins it so the API's override:true dotenv load cannot clobber it", () => {
    const env = applyWebhookSecretOverride({ PATH: "/bin", STRIPE_WEBHOOK_SECRET: "whsec_old" }, "whsec_new");
    expect(env.STRIPE_WEBHOOK_SECRET).toBe("whsec_new");
    expect(env.DEV_ENV_PINS).toBe("STRIPE_WEBHOOK_SECRET");
    expect(env.PATH).toBe("/bin");
  });
  it("merges with existing pins without duplicating", () => {
    const env = applyWebhookSecretOverride({ DEV_ENV_PINS: "FOO, STRIPE_WEBHOOK_SECRET" }, "whsec_x");
    expect(env.DEV_ENV_PINS!.split(",").sort()).toEqual(["FOO", "STRIPE_WEBHOOK_SECRET"]);
  });
  it("does not mutate the input env", () => {
    const base = { A: "1" };
    applyWebhookSecretOverride(base, "whsec_x");
    expect(base).toEqual({ A: "1" });
  });
});

describe("redactSecrets / formatAccountBanner", () => {
  it("masks keys and signing secrets in CLI output", () => {
    const text = "Command failed: STRIPE_API_KEY=sk_test_51ABCDEFxyz stripe listen --print-secret whsec_abcd1234ef";
    const out = redactSecrets(text);
    expect(out).not.toContain("sk_test_51ABCDEFxyz");
    expect(out).not.toContain("whsec_abcd1234ef");
    expect(out).toContain("sk_test_****");
    expect(out).toContain("whsec_****");
  });
  it("names the account and mode in the banner, including the degraded unknown account", () => {
    expect(formatAccountBanner({ id: "acct_1", name: "Hearthfire sandbox", livemode: false })).toBe(
      'Stripe listener attached to "Hearthfire sandbox" (acct_1, test mode)',
    );
    expect(formatAccountBanner({ id: "acct_2", name: null, livemode: true })).toContain("LIVE mode");
    expect(formatAccountBanner({ id: "unknown", name: null })).toBe(
      'Stripe listener attached to "(no display name)" (unknown, test mode)',
    );
  });
});
