import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import Stripe from "stripe";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The webhook's failure policy, enforced.
 *
 * Every event that VERIFIES but is not fully applied must land in the DLQ and
 * in Sentry. Before this, three classes of failure returned 200 and vanished:
 * per-handler inner `catch`es, Zod parse failures, and handlers with no
 * `metadata.orderId` to act on. Stripe never retries a 2xx, so each of those
 * was permanent, silent data loss — the `account.updated` variant is what left
 * an org unable to publish paid events with a green Payments page.
 *
 * Two layers here on purpose:
 *   1. behavioural — drive real signed events through the real route;
 *   2. structural — fail if a future `case` re-introduces a swallowing catch.
 */

const ensureTermsMock = vi.fn(async () => ({ payoutTermsId: null }));

vi.mock(
  "@th/core/use-cases/payout-terms/ensure-entity-default-payout-terms-for-account",
  () => ({
    ensureEntityDefaultPayoutTermsForAccount: (...args: unknown[]) =>
      ensureTermsMock(...(args as [])),
  }),
);

// The dev bypass (`forceConnectCapabilities`) forces every account to
// ACTIVE/true/true outside production, which would make every capability
// assertion below vacuously pass. Switch it off so these tests exercise the
// real production semantics — this env var exists precisely so the bug class
// is reproducible outside prod.
process.env.STRIPE_CONNECT_FORCE_CAPABILITIES = "false";

const WEBHOOK_SECRET = "whsec_test_dlq";

/** Minimal ioredis surface used by `WebhookDlq`. */
function makeFakeRedis() {
  const pushed: Array<Record<string, string>> = [];
  const multi = () => {
    const ops: Record<string, string> | null = null;
    void ops;
    const chain = {
      hset: (_key: string, value: Record<string, string>) => {
        pushed.push(value);
        return chain;
      },
      expire: () => chain,
      zadd: () => chain,
      zrem: () => chain,
      del: () => chain,
      exec: async () => [],
    };
    return chain;
  };
  const redis = {
    multi,
    zcard: async () => pushed.length,
    zrange: async () => [],
    zrevrange: async () => [],
    hgetall: async () => ({}),
  };
  return { redis, pushed };
}

function makeApp(options?: {
  syncCapabilities?: (input: unknown) => Promise<void>;
  orders?: Record<string, unknown>;
  memberships?: Record<string, unknown>;
}) {
  return (async () => {
    const { default: rawBody } = await import("../src/plugins/raw-body");
    const { default: stripeWebhook } =
      await import("../src/routes/stripe/webhook");

    const { redis, pushed } = makeFakeRedis();
    const syncCapabilities = vi.fn(
      options?.syncCapabilities ?? (async () => undefined),
    );
    const errorLogs: unknown[][] = [];

    const app = Fastify({ logger: false });
    const origError = app.log.error.bind(app.log);
    app.log.error = ((...args: unknown[]) => {
      errorLogs.push(args);
      origError(...(args as [never]));
    }) as never;

    app.decorate("deps", {
      redis,
      logger: {
        child: vi.fn(() => app.deps.logger),
        withTime: vi.fn(async (_n: unknown, f: () => unknown) => f()),
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      trpc: {
        repos: {
          payees: { syncCapabilities },
          // A real fn by default. `{}` left `findByPaymentIntent` undefined, so
          // `isOrphanPaymentIntent` threw and its catch (not its lookup) is
          // what reached the DLQ — the test passed for the wrong reason.
          orders: {
            findByPaymentIntent: vi.fn(async () => ({
              id: "order_1",
              status: "PENDING",
            })),
            ...(options?.orders ?? {}),
          },
          // Backs `trackedMembership` for the Stripe Billing invoice cases
          // and the customer.updated guards. Default: we track nothing.
          memberships: {
            findByStripeSubscriptionId: vi.fn(async () => null),
            listByStripeCustomerId: vi.fn(async () => []),
            ...(options?.memberships ?? {}),
          },
        },
        idempotency: {},
        clock: { now: () => new Date("2026-08-06T12:00:00.000Z") },
      },
    } as never);

    await app.register(rawBody);
    await app.register(stripeWebhook);

    return { app, pushed, syncCapabilities, errorLogs };
  })();
}

async function post(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  payloadObj: unknown,
  opts?: { secret?: string },
) {
  const stripe = new Stripe("stripe-mock", {
    apiVersion: "2025-08-27.basil" as never,
  });
  const payload = JSON.stringify(payloadObj);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts?.secret ?? WEBHOOK_SECRET,
  });
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "stripe-signature": signature,
      "content-type": "application/json",
    },
    payload,
  });
}

const accountEvent = (
  id: string,
  object: Record<string, unknown>,
  created = 1_785_000_000,
) => ({ id, type: "account.updated", created, data: { object } });

describe("stripe webhook — every failure path reaches the DLQ", () => {
  // Warm the module graph here, not inside a test: the first
  // `import("../src/routes/stripe/webhook")` pulls a large graph through Vite's
  // transform and was pushing whichever case ran first past its timeout.
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = "stripe-mock";
    process.env.STRIPE_API_VERSION = "2025-08-27.basil";
    await import("../src/routes/stripe/webhook");
    // 180s, not 60s: sibling packages' COLLECT phase alone has been observed
    // at 90–108s on a loaded machine, and this warm-up pulls a comparable
    // module graph through Vite's transform. At 60s a busy box skipped 11 of
    // these tests as "hook timed out" — a flaky gate on exactly the file that
    // enforces the webhook failure policy.
  }, 180_000);
  beforeEach(() => ensureTermsMock.mockClear());
  afterAll(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_API_VERSION;
  });

  it("DLQs a payload that fails the Zod guard (was: warn + break + 200, lost forever)", async () => {
    const { app, pushed } = await makeApp();

    const res = await post(
      app,
      accountEvent("evt_bad_shape", { id: "not_an_account_id" }),
    );

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      stripeEventId: "evt_bad_shape",
      eventType: "account.updated",
    });
    expect(pushed[0]?.error).toContain("[account.updated:parse]");
    // The WHICH-FIELD detail must reach the DLQ row itself, not just Sentry
    // extra: the operator page renders this string, and it used to read
    // "...parse_failed: ...parse_failed" — nothing to act on. Assert on the
    // failing path, not Zod's message text, so a zod bump doesn't flake this.
    expect(pushed[0]?.error).toContain("id");
    expect(pushed[0]?.error).not.toMatch(
      /stripe_webhook_payload_parse_failed: stripe_webhook_payload_parse_failed/,
    );
    // The raw payload must be stored — it is what you need to widen the guard.
    expect(JSON.parse(pushed[0]!.payload!)).toMatchObject({
      id: "evt_bad_shape",
    });

    await app.close();
  });

  it("DLQs a handler that throws (was: Sentry + Discord, then break — never DLQ'd)", async () => {
    const { app, pushed } = await makeApp({
      syncCapabilities: async () => {
        throw new Error("db_unavailable");
      },
    });

    const res = await post(
      app,
      accountEvent("evt_apply_fails", {
        id: "acct_1",
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.error).toContain("[account.updated:apply]");
    expect(pushed[0]?.error).toContain("db_unavailable");

    await app.close();
  });

  it("DLQs a payment_intent.processing event carrying no orderId", async () => {
    const { app, pushed } = await makeApp();

    const res = await post(app, {
      id: "evt_no_order",
      type: "payment_intent.processing",
      created: 1_785_000_000,
      data: { object: { id: "pi_orphan", metadata: {} } },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed[0]?.error).toContain(
      "[payment_intent.processing:no_order_id]",
    );

    await app.close();
  });

  it("ignores a FOREIGN PaymentIntent instead of taking a DLQ slot", async () => {
    // Dashboard-created payments and Stripe Billing invoices arrive here with
    // no orderId. DLQ-ing them would slowly evict genuine failures from a
    // 500-item queue that trims the oldest, and replay could never drain them.
    const { app, pushed } = await makeApp({
      orders: { findByPaymentIntent: vi.fn(async () => null) },
    });

    const res = await post(app, {
      id: "evt_foreign",
      type: "payment_intent.processing",
      created: 1_785_000_000,
      data: { object: { id: "pi_not_ours", metadata: {} } },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("ignores an ORPHAN payment_intent.succeeded instead of taking a DLQ slot", async () => {
    // Stripe Billing PIs (membership invoice payments) succeed with no
    // metadata.orderId. Before the guard, finalizePaymentIntent threw on
    // parse — one DLQ entry per member per month, evicting real failures.
    const { app, pushed } = await makeApp({
      orders: {
        findByPaymentIntent: vi.fn(async () => null),
        getById: vi.fn(async () => null),
      },
    });

    const res = await post(app, {
      id: "evt_billing_pi_succeeded",
      type: "payment_intent.succeeded",
      created: 1_785_000_000,
      data: { object: { id: "pi_billing", metadata: {} } },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("DLQs a metadata-STAMPED paid invoice whose Membership row has not landed", async () => {
    // First-invoice race: `invoice.payment_succeeded` can beat our own
    // `memberships.create` commit. A terminal "not ours" 200 would drop paid
    // money forever; DLQ-ing means a replay after the row lands records it.
    const { app, pushed } = await makeApp(); // memberships → tracks nothing

    const res = await post(app, {
      id: "evt_membership_race_dlq",
      type: "invoice.payment_succeeded",
      created: 1_785_000_000,
      data: {
        object: {
          id: "in_race",
          object: "invoice",
          currency: "usd",
          subtotal: 1000,
          amount_paid: 1098,
          amount_due: 1098,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          parent: {
            subscription_details: {
              subscription: "sub_racing",
              metadata: {
                tierId: "33333333-3333-4333-8333-333333333333",
                memberHumanId: "44444444-4444-4444-8444-444444444444",
              },
            },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.error).toContain(
      "[invoice.payment_succeeded:membership_row_pending]",
    );
    // The raw payload is stored — replay is what drains this once the row lands.
    expect(JSON.parse(pushed[0]!.payload!)).toMatchObject({
      id: "evt_membership_race_dlq",
    });

    await app.close();
  });

  it("still ignores a paid invoice with NO membership stamp (genuinely foreign)", async () => {
    const { app, pushed } = await makeApp();

    const res = await post(app, {
      id: "evt_foreign_invoice",
      type: "invoice.payment_succeeded",
      created: 1_785_000_000,
      data: {
        object: {
          id: "in_foreign",
          object: "invoice",
          currency: "usd",
          subtotal: 5000,
          amount_paid: 5000,
          amount_due: 5000,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          parent: { subscription_details: { subscription: "sub_theirs" } },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("DLQs when the PI IS ours but lost its orderId", async () => {
    // Inverting the orphan check would make this silently disappear, which is
    // the whole bug class this file exists to prevent.
    const { app, pushed } = await makeApp({
      orders: {
        findByPaymentIntent: vi.fn(async () => ({
          id: "order_1",
          status: "PENDING",
        })),
      },
    });

    await post(app, {
      id: "evt_ours_no_meta",
      type: "payment_intent.payment_failed",
      created: 1_785_000_000,
      data: { object: { id: "pi_ours", metadata: {} } },
    });

    expect(pushed[0]?.error).toContain(
      "[payment_intent.payment_failed:no_order_id]",
    );

    await app.close();
  });

  it("escalates rather than drops when the orphan lookup itself fails", async () => {
    const { app, pushed } = await makeApp({
      orders: {
        findByPaymentIntent: vi.fn(async () => {
          throw new Error("db_unavailable");
        }),
      },
    });

    await post(app, {
      id: "evt_lookup_failed",
      type: "payment_intent.processing",
      created: 1_785_000_000,
      data: { object: { id: "pi_unknown", metadata: {} } },
    });

    expect(pushed).toHaveLength(1);

    await app.close();
  });

  it("a bad signature is error-logged (Sentry-visible) and NOT stored in the DLQ", async () => {
    const { app, pushed, errorLogs } = await makeApp();

    const res = await post(app, accountEvent("evt_forged", { id: "acct_1" }), {
      secret: "whsec_wrong_secret",
    });

    // Stripe retries a 400 — correct, this may be a transient config problem.
    expect(res.statusCode).toBe(400);
    // error, not warn: warn is not captured by Sentry, and this is exactly the
    // signal a missing STRIPE_CONNECT_WEBHOOK_SECRET produces.
    expect(errorLogs.some((c) => c[1] === "stripe_webhook_bad_signature")).toBe(
      true,
    );
    // Unverified payloads must never be replayable, and must never be able to
    // evict genuine failures from the 500-item DLQ.
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("a FAILED replay does not re-push, so the original error and timestamp survive", async () => {
    // `push` writes the same hash key, so re-pushing on a replay would
    // overwrite the original `error` and `receivedAt` with this attempt's,
    // re-score the item to "now" (reshuffling a queue meant to be ordered by
    // delivery time), and refresh the 30-day TTL so a repeatedly-retried item
    // never ages out. The operator loses the timestamp they correlate against
    // the incident window.
    const { app, pushed } = await makeApp({
      syncCapabilities: async () => {
        throw new Error("still_broken");
      },
    });

    const replay = (
      app.deps as unknown as {
        trpc: {
          replayStripeEvent?: (
            raw: string,
          ) => Promise<{ ok: boolean; error?: string }>;
        };
      }
    ).trpc.replayStripeEvent;
    expect(replay).toBeTypeOf("function");

    const result = await replay!(
      JSON.stringify(
        accountEvent("evt_replay", {
          id: "acct_r",
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { card_payments: "active", transfers: "active" },
        }),
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("still_broken");
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("a SUCCESSFUL replay applies the event", async () => {
    const { app, syncCapabilities, pushed } = await makeApp();

    const replay = (
      app.deps as unknown as {
        trpc: {
          replayStripeEvent?: (
            raw: string,
          ) => Promise<{ ok: boolean; error?: string }>;
        };
      }
    ).trpc.replayStripeEvent;

    const result = await replay!(
      JSON.stringify(
        accountEvent("evt_replay_ok", {
          id: "acct_ro",
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { card_payments: "active", transfers: "active" },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    expect(syncCapabilities).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("rejects an unparseable stored payload without touching the queue", async () => {
    const { app, pushed } = await makeApp();
    const replay = (
      app.deps as unknown as {
        trpc: {
          replayStripeEvent?: (
            raw: string,
          ) => Promise<{ ok: boolean; error?: string }>;
        };
      }
    ).trpc.replayStripeEvent;

    const result = await replay!("{not json");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unparseable_dlq_payload");
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("DLQs a TRACKED member's address change when billing/tax config is missing", async () => {
    // A tracked member moved and we could not re-resolve their jurisdiction —
    // that must be replayable after the config fix, never a silent 200 (the
    // stale rate would bill forever; as MoR the shortfall is ours). This
    // harness has no membershipBilling/taxRateLookup in deps, which IS the
    // misconfiguration.
    const { app, pushed } = await makeApp({
      memberships: {
        listByStripeCustomerId: vi.fn(async () => [
          {
            id: "66666666-6666-4666-8666-666666666666",
            stripeSubscriptionId: "sub_ours",
            stripeCustomerId: "cus_member",
            status: "active",
            billingPostalCode: "37206",
            billingCountryCode: "US",
          },
        ]),
      },
    });

    const res = await post(app, {
      id: "evt_cust_moved_unconfigured",
      type: "customer.updated",
      created: 1_785_000_000,
      data: {
        object: {
          id: "cus_member",
          object: "customer",
          address: { postal_code: "97202", country: "US" },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.error).toContain("[customer.updated:not_configured]");

    await app.close();
  });

  it("ignores customer.updated for an untracked customer instead of taking a DLQ slot", async () => {
    const { app, pushed } = await makeApp(); // tracks nothing

    const res = await post(app, {
      id: "evt_cust_foreign_dlq",
      type: "customer.updated",
      created: 1_785_000_000,
      data: {
        object: {
          id: "cus_theirs",
          object: "customer",
          address: { postal_code: "97202", country: "US" },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(0);

    await app.close();
  });

  it("does NOT DLQ a healthy event", async () => {
    const { app, pushed, syncCapabilities } = await makeApp();

    const res = await post(
      app,
      accountEvent("evt_ok", {
        id: "acct_ok",
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
        default_currency: "usd",
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(0);
    expect(syncCapabilities).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

describe("stripe webhook — account.updated capability semantics", () => {
  beforeAll(() => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = "stripe-mock";
    process.env.STRIPE_API_VERSION = "2025-08-27.basil";
  });
  afterAll(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_API_VERSION;
  });

  it("survives a capability status outside the old enum instead of dropping the event", async () => {
    // `unrequested` is a real Stripe value. The old guard's
    // z.enum(["active","pending","inactive"]) rejected it, so the entire event
    // was dropped with an invisible warn — a permanent, silent capability
    // desync for that account.
    const { app, pushed, syncCapabilities } = await makeApp();

    const res = await post(
      app,
      accountEvent("evt_unrequested", {
        id: "acct_u",
        object: "account",
        capabilities: {
          card_payments: "unrequested",
          transfers: "provisioning",
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(0);
    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "PENDING",
        chargesEnabled: false,
        payoutsEnabled: false,
      }),
    );

    await app.close();
  });

  it("derives the Payee row from the SAME fields the Payments page renders", async () => {
    // Account-level flags beat capabilities for charges. The publish gate reads
    // this row and the Payments page reads `charges_enabled`/`payouts_enabled`
    // live; deriving the row from `capabilities` instead is what let them
    // disagree.
    const { app, syncCapabilities } = await makeApp();

    await post(
      app,
      accountEvent("evt_precedence", {
        id: "acct_p",
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: "pending", transfers: "active" },
      }),
    );

    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ACTIVE", payoutsEnabled: true }),
    );

    await app.close();
  });

  it("refuses payouts when transfers is not active, whatever payouts_enabled says", async () => {
    // `Payee.payoutsEnabled` is the only precondition before a destination
    // transfer (settlements/execute-transfer.ts) as well as the publish gate.
    // Letting the account-level flag win here would publish a paid event that
    // sells and then fails at settlement.
    const { app, syncCapabilities } = await makeApp();

    await post(
      app,
      accountEvent("evt_transfers_pending", {
        id: "acct_t",
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: "active", transfers: "pending" },
      }),
    );

    expect(syncCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PENDING", payoutsEnabled: false }),
    );

    await app.close();
  });

  it("stamps observedAt from Stripe's event.created so late retries lose the ordering guard", async () => {
    const { app, syncCapabilities } = await makeApp();

    await post(
      app,
      accountEvent(
        "evt_ordering",
        {
          id: "acct_o",
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
        },
        1_700_000_000,
      ),
    );

    expect(syncCapabilities.mock.calls[0]?.[0]).toMatchObject({
      observedAt: new Date(1_700_000_000 * 1000),
    });

    await app.close();
  });
});

// ── Structural guard ─────────────────────────────────────────────────────────

/**
 * True when the text ending at a `catch (` is preceded — with nothing but
 * comment, brace or blank lines in between — by a `// dlq-exempt:` marker.
 */
function hasAdjacentExemption(before: string): boolean {
  const lines = before.split("\n");
  lines.pop(); // the partial line the `catch` sits on
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === "" || line === "}" || line === "} else {") continue;
    if (line.startsWith("// dlq-exempt:")) return true;
    if (line.startsWith("//")) continue;
    return false; // real code before any marker
  }
  return false;
}

describe("stripe webhook — structural failure-policy guard", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/routes/stripe/webhook.ts", import.meta.url)),
    "utf8",
  );
  // Only the dispatch body, so the module-level helpers above it don't count.
  const dispatch = source.slice(source.indexOf("switch (event.type) {"));

  it("no handler swallows an error — every catch either rethrows or is marked dlq-exempt", () => {
    // A `catch` that neither rethrows nor is explicitly exempted is exactly the
    // bug this file exists to prevent: the event is not applied, Stripe gets a
    // 200, and nothing is recorded.
    const offenders: string[] = [];
    const re = /\bcatch\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(dispatch))) {
      const before = dispatch.slice(0, m.index);
      // Body = from this catch to the next one (or end); enough to see a throw.
      const nextIdx = dispatch.slice(m.index + 1).search(/\bcatch\s*\(/);
      const body = dispatch.slice(
        m.index,
        nextIdx === -1 ? undefined : m.index + 1 + nextIdx,
      );
      // The marker must be in the comment block IMMEDIATELY above this catch.
      // A plain "is it somewhere nearby" lookback would let a NEW swallowing
      // catch silently inherit its neighbour's exemption.
      if (hasAdjacentExemption(before)) continue;
      if (body.includes("throw ")) continue;
      offenders.push(body.slice(0, 200));
    }
    expect(offenders).toEqual([]);
  });

  it("documents every dlq-exempt catch (they are the only swallow sites)", () => {
    // The legitimate swallow sites, all of them: the sink itself, the
    // DLQ-write failure, the cosmetic payment-method-type enrichment (x2),
    // replay-payload parsing, and signature probing. If this number changes,
    // a new swallow was added — justify it or make it throw.
    expect(dispatch.match(/\/\/ dlq-exempt:/g) ?? []).toHaveLength(6);
  });

  it("no parse failure returns 200 by falling through to a bare break", () => {
    // Every `if (!parsed.success)` / `if (!input)` must throw, not break.
    const guards =
      dispatch.match(
        /if \(!(parsed\.success|input)\)\s*\{[\s\S]{0,300}?\n {10}\}/g,
      ) ?? [];
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      expect(guard, `parse guard must throw, not break:\n${guard}`).toContain(
        "throw ",
      );
    }
  });

  it("keeps the log messages the production alert policy matches on", () => {
    // infra/terraform/monitoring.tf's `stripe_webhook_failures` log metric
    // matches these two strings verbatim. Renaming them silently disables the
    // only production alert on this subsystem.
    expect(source).toContain("stripe_webhook_unhandled_error_dlq");
    expect(source).toContain("stripe_webhook_dlq_store_failed");
  });

  it("pushes to the DLQ from exactly one place", () => {
    // One sink means a new handler cannot land without DLQ coverage.
    expect(source.match(/webhookDlq\.push\(/g) ?? []).toHaveLength(1);
  });
});
