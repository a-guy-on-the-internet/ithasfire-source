import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { isAppError } from "@th/errors";

import {
  StripeInsufficientPlatformBalanceError,
  StripePaymentProcessor,
} from "../stripe-adapter";

function stripeDispute(overrides: Record<string, unknown> = {}) {
  return {
    id: "dp_test_1",
    object: "dispute",
    amount: 4500,
    currency: "USD",
    charge: "ch_test_1",
    payment_intent: "pi_test_1",
    reason: "product_not_received",
    status: "needs_response",
    evidence: {
      product_description: "2x GA — Launch Party",
      customer_name: null,
      receipt: { id: "file_receipt", object: "file" },
      service_documentation: "file_scanlog",
      shipping_address: null,
      enhanced_evidence: {},
    },
    evidence_details: {
      due_by: 1_767_225_600, // 2026-01-01T00:00:00Z
      has_evidence: true,
      past_due: false,
      submission_count: 0,
      enhanced_eligibility: {},
    },
    ...overrides,
  };
}

function stripeResourceMissing() {
  return Object.assign(new Error("No such dispute: 'dp_nope'"), {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    param: "dispute",
  });
}

describe("StripePaymentProcessor", () => {
  it("creates online payment intents with descriptor suffix, description, and automatic 3DS", async () => {
    const createPaymentIntent = vi.fn(async () => ({
      id: "pi_test_123",
      client_secret: "pi_test_123_secret_abc",
    }));

    const payments = new StripePaymentProcessor({
      apiKey: "sk_test_1234567890",
    });
    (payments as any).s = {
      paymentIntents: { create: createPaymentIntent },
    };

    await payments.createPaymentIntent({
      amountCents: 2500,
      currency: "usd",
      idempotencyKey: "pi:test",
      metadata: { orderId: "order-1" },
      statementDescriptorSuffix: "LAUNCH PARTY",
      description: "Launch Party — 3 tickets · Order DB21B2C3",
    });

    const [params, options] = createPaymentIntent.mock.calls[0] ?? [];

    expect(params).toEqual(
      expect.objectContaining({
        amount: 2500,
        currency: "usd",
        statement_descriptor_suffix: "LAUNCH PARTY",
        // Separate field from the descriptor above: Dashboard/exports only.
        description: "Launch Party — 3 tickets · Order DB21B2C3",
        payment_method_options: {
          card: { request_three_d_secure: "automatic" },
        },
      }),
    );
    expect(options).toEqual({ idempotencyKey: "pi:test" });
  });

  describe("payment_method_types", () => {
    async function methodTypes(
      input: {
        currency: string;
        allowRedirectPaymentMethods?: boolean;
        allowBankDebit?: boolean;
      },
    ): Promise<{ types: unknown; options: unknown }> {
      const create = vi.fn(async (_params: any) => ({
        id: "pi_test_pm",
        client_secret: "pi_test_pm_secret",
      }));
      const payments = new StripePaymentProcessor({
        apiKey: "sk_test_1234567890",
      });
      (payments as any).s = { paymentIntents: { create } };
      await payments.createPaymentIntent({ amountCents: 2500, ...input });
      const params = create.mock.calls[0]?.[0];
      return {
        types: params?.payment_method_types,
        options: params?.payment_method_options,
      };
    }

    // Owner, 2026-10-13: Amazon Pay and Cash App Pay are turned off in
    // Stripe (reversing 2026-10-12), so no surface may request them by name.
    const OFF_METHODS = ["amazon_pay", "cashapp"];

    it("defaults to card and ACH for usd, never Amazon Pay or Cash App", async () => {
      expect((await methodTypes({ currency: "usd" })).types).toEqual([
        "card",
        "us_bank_account",
      ]);
      expect(
        (await methodTypes({ currency: "usd", allowBankDebit: true })).types,
      ).toEqual(["card", "us_bank_account"]);
    });

    it("drops ACH for usd when allowBankDebit is false, leaving card only", async () => {
      const { types, options } = await methodTypes({
        currency: "usd",
        allowRedirectPaymentMethods: true,
        allowBankDebit: false,
      });
      expect(types).toEqual(["card"]);
      // No options for a method type that is not listed.
      expect(options).toEqual({
        card: { request_three_d_secure: "automatic" },
      });
    });

    it("offers card only for non-usd whether or not bank debit is allowed", async () => {
      expect(
        (await methodTypes({ currency: "cad", allowBankDebit: false })).types,
      ).toEqual(["card"]);
      expect((await methodTypes({ currency: "cad" })).types).toEqual([
        "card",
      ]);
    });

    it("requests neither Amazon Pay nor Cash App in any combination", async () => {
      for (const currency of ["usd", "cad", "eur"]) {
        for (const allowRedirectPaymentMethods of [undefined, true, false]) {
          for (const allowBankDebit of [undefined, true, false]) {
            const { types } = await methodTypes({
              currency,
              allowRedirectPaymentMethods,
              allowBankDebit,
            });
            expect(types).toEqual(expect.arrayContaining(["card"]));
            for (const off of OFF_METHODS) {
              expect(types).not.toContain(off);
            }
          }
        }
      }
    });

    it("is card-only when redirects are off, regardless of allowBankDebit", async () => {
      expect(
        (
          await methodTypes({
            currency: "usd",
            allowRedirectPaymentMethods: false,
            allowBankDebit: true,
          })
        ).types,
      ).toEqual(["card"]);
    });
  });

  it("omits description entirely when the caller passes none", async () => {
    const createPaymentIntent = vi.fn(async () => ({
      id: "pi_test_124",
      client_secret: "pi_test_124_secret_abc",
    }));

    const payments = new StripePaymentProcessor({
      apiKey: "sk_test_1234567890",
    });
    (payments as any).s = {
      paymentIntents: { create: createPaymentIntent },
    };

    await payments.createPaymentIntent({
      amountCents: 2500,
      currency: "usd",
      metadata: { orderId: "order-1" },
    });

    const [params] = createPaymentIntent.mock.calls[0] ?? [];

    expect(params).not.toHaveProperty("description");
  });

  it("creates card-present payment intents with a description", async () => {
    const createPaymentIntent = vi.fn(async () => ({
      id: "pi_pos_123",
      client_secret: "pi_pos_123_secret_abc",
    }));

    const payments = new StripePaymentProcessor({
      apiKey: "sk_test_1234567890",
    });
    (payments as any).s = {
      paymentIntents: { create: createPaymentIntent },
    };

    await payments.createCardPresentPaymentIntent({
      amountCents: 4000,
      currency: "usd",
      destinationAccountId: "acct_123",
      metadata: {
        orderId: "order-1",
        eventId: "event-1",
        paymentChannel: "POS",
      },
      idempotencyKey: "pos-pi:order-1",
      description: "Launch Party — 2 tickets · POS · Order DB21B2C3",
    });

    const [params, options] = createPaymentIntent.mock.calls[0] ?? [];

    expect(params).toEqual(
      expect.objectContaining({
        amount: 4000,
        currency: "usd",
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        description: "Launch Party — 2 tickets · POS · Order DB21B2C3",
        metadata: {
          orderId: "order-1",
          eventId: "event-1",
          paymentChannel: "POS",
          destinationAccountId: "acct_123",
        },
      }),
    );
    // Unchanged and deliberately absent: POS does not set a statement
    // descriptor suffix today.
    expect(params).not.toHaveProperty("statement_descriptor_suffix");
    expect(options).toEqual({ idempotencyKey: "pos-pi:order-1" });
  });

  it("passes the caller's idempotency key through to transfers.create", async () => {
    const createTransfer = vi.fn(async () => ({ id: "tr_test_123" }));

    const payments = new StripePaymentProcessor({
      apiKey: "sk_test_1234567890",
    });
    (payments as any).s = {
      transfers: { create: createTransfer },
    };

    await payments.createTransfer({
      amountCents: 4800,
      currency: "usd",
      destinationAccountId: "acct_dest",
      metadata: { payoutItemId: "pi-1" },
      idempotencyKey: "transfer:abc123",
    });

    const [params, options] = createTransfer.mock.calls[0] ?? [];
    expect(params).toEqual(
      expect.objectContaining({
        amount: 4800,
        currency: "usd",
        destination: "acct_dest",
      }),
    );
    // Stripe-side idempotency: a same-key retry within Stripe's 24h window
    // replays the original transfer instead of issuing a second one.
    expect(options).toEqual({ idempotencyKey: "transfer:abc123" });
  });

  it("omits the request options when no idempotency key is provided", async () => {
    const createTransfer = vi.fn(async () => ({ id: "tr_test_456" }));

    const payments = new StripePaymentProcessor({
      apiKey: "sk_test_1234567890",
    });
    (payments as any).s = {
      transfers: { create: createTransfer },
    };

    await payments.createTransfer({
      amountCents: 100,
      currency: "usd",
      destinationAccountId: "acct_dest",
    });

    const [, options] = createTransfer.mock.calls[0] ?? [];
    expect(options).toBeUndefined();
  });

  describe("createTransfer platform-balance shortfall", () => {
    /**
     * Shaped like the real thing: the Stripe node SDK raises an
     * `invalid_request_error` whose `.type` is the CLASS name
     * ("StripeInvalidRequestError") and whose `.code` is the documented
     * `balance_insufficient` — "The transfer or payout couldn't be completed
     * because the associated account doesn't have a sufficient balance
     * available." (docs.stripe.com/error-codes). Duck-typed here for the same
     * reason the adapter duck-types it: constructing a genuine SDK error
     * instance requires the private `generate` path.
     */
    const balanceInsufficient = () =>
      Object.assign(
        new Error(
          "You have insufficient available funds in your Stripe account. Try adding funds directly to your available balance by creating Charges using the 4000000000000077 test card. See https://stripe.com/docs/testing#available-balance.",
        ),
        {
          type: "StripeInvalidRequestError",
          rawType: "invalid_request_error",
          code: "balance_insufficient",
          statusCode: 400,
          requestId: "req_balance_1",
        },
      );

    const transferHarness = (create: (...args: unknown[]) => unknown) => {
      const payments = new StripePaymentProcessor({
        apiKey: "sk_test_1234567890",
      });
      (payments as any).s = { transfers: { create: vi.fn(create) } };
      return payments;
    };

    it("converts Stripe balance_insufficient into the typed marker", async () => {
      const raw = balanceInsufficient();
      const payments = transferHarness(async () => {
        throw raw;
      });

      const err = await payments
        .createTransfer({
          amountCents: 4800,
          currency: "usd",
          destinationAccountId: "acct_dest",
          idempotencyKey: "transfer:abc123",
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StripeInsufficientPlatformBalanceError);
      expect((err as Error).name).toBe(
        "StripeInsufficientPlatformBalanceError",
      );
      // The duck-typed flag is the actual contract with core (which must not
      // import this package) — assert the flag, not just the class.
      expect((err as any).isInsufficientPlatformBalanceError).toBe(true);
      expect((err as Error).message).toBe(raw.message);
      expect((err as any).cause).toBe(raw);
    });

    it.each([
      ["transfers_not_allowed"],
      ["resource_missing"],
      ["parameter_invalid_integer"],
      [undefined],
    ])(
      "rethrows other invalid_request_errors untouched (code=%s)",
      async (code) => {
        const boom = Object.assign(new Error("nope"), {
          type: "StripeInvalidRequestError",
          code,
        });
        const payments = transferHarness(async () => {
          throw boom;
        });

        await expect(
          payments.createTransfer({
            amountCents: 4800,
            currency: "usd",
            destinationAccountId: "acct_dest",
          }),
        ).rejects.toBe(boom);
      },
    );

    it("rethrows a non-invalid_request Stripe error untouched even with the same code", async () => {
      // Over-match guard: the code alone is not the discriminator.
      const boom = Object.assign(new Error("rate limited"), {
        type: "StripeRateLimitError",
        code: "balance_insufficient",
      });
      const payments = transferHarness(async () => {
        throw boom;
      });

      await expect(
        payments.createTransfer({
          amountCents: 4800,
          currency: "usd",
          destinationAccountId: "acct_dest",
        }),
      ).rejects.toBe(boom);
    });

    it("does NOT claim a platform shortfall when the transfer names a source charge", async () => {
      // With source_transaction the funding account is the named charge, not
      // the platform float — a different diagnosis, so no marker.
      const raw = balanceInsufficient();
      const payments = transferHarness(async () => {
        throw raw;
      });

      await expect(
        payments.createTransfer({
          amountCents: 4800,
          currency: "usd",
          destinationAccountId: "acct_dest",
          sourceTransaction: "ch_test_1",
        }),
      ).rejects.toBe(raw);
    });

    it("matches an error built by the real Stripe SDK, not just our double", async () => {
      // Belt-and-braces against the hand-rolled double above drifting from the
      // SDK: this error object is produced by the installed `stripe` package's
      // own generator, so if Stripe ever renames `.type` or reshapes the class
      // this test goes red rather than the production path silently missing.
      const real = (
        Stripe.errors.StripeError as unknown as {
          generate: (raw: Record<string, unknown>) => Error;
        }
      ).generate({
        type: "invalid_request_error",
        code: "balance_insufficient",
        message: "You have insufficient available funds in your Stripe account.",
        statusCode: 400,
        requestId: "req_balance_2",
      });
      expect(real).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);

      const payments = transferHarness(async () => {
        throw real;
      });

      const err = await payments
        .createTransfer({
          amountCents: 4800,
          currency: "usd",
          destinationAccountId: "acct_dest",
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StripeInsufficientPlatformBalanceError);
      expect((err as any).isInsufficientPlatformBalanceError).toBe(true);
      expect((err as any).cause).toBe(real);
    });

    it("still returns the transfer id on the happy path", async () => {
      const payments = transferHarness(async () => ({ id: "tr_ok_1" }));

      await expect(
        payments.createTransfer({
          amountCents: 4800,
          currency: "usd",
          destinationAccountId: "acct_dest",
        }),
      ).resolves.toEqual({ id: "tr_ok_1" });
    });
  });

  describe("disputes", () => {
    it("retrieveDispute normalises the Stripe shape: cents, lowercase currency, unix→Date, file ids", async () => {
      const retrieve = vi.fn(async () => stripeDispute());
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { retrieve } };

      const snapshot = await payments.retrieveDispute({
        processorDisputeId: "dp_test_1",
      });

      expect(retrieve).toHaveBeenCalledWith("dp_test_1");
      expect(snapshot).toEqual({
        processorDisputeId: "dp_test_1",
        chargeId: "ch_test_1",
        paymentIntentId: "pi_test_1",
        status: "needs_response",
        amountCents: 4500,
        currency: "usd",
        reason: "product_not_received",
        evidenceDetails: {
          dueBy: new Date("2026-01-01T00:00:00.000Z"),
          hasEvidence: true,
          pastDue: false,
          submissionCount: 0,
        },
        evidence: {
          productDescription: "2x GA — Launch Party",
          receipt: "file_receipt",
          serviceDocumentation: "file_scanlog",
        },
      });
      expect(snapshot.evidenceDetails.dueBy).toBeInstanceOf(Date);
    });

    it("retrieveDispute unwraps expanded charge / payment_intent objects and null due_by", async () => {
      const retrieve = vi.fn(async () =>
        stripeDispute({
          charge: { id: "ch_expanded", object: "charge" },
          payment_intent: null,
          status: "won",
          evidence_details: {
            due_by: null,
            has_evidence: true,
            past_due: false,
            submission_count: 1,
          },
        }),
      );
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { retrieve } };

      const snapshot = await payments.retrieveDispute({
        processorDisputeId: "dp_test_1",
      });
      expect(snapshot.chargeId).toBe("ch_expanded");
      expect(snapshot.paymentIntentId).toBeNull();
      expect(snapshot.status).toBe("won");
      expect(snapshot.evidenceDetails).toEqual({
        dueBy: null,
        hasEvidence: true,
        pastDue: false,
        submissionCount: 1,
      });
    });

    it("retrieveDispute maps Stripe resource_missing to a typed NOT_FOUND", async () => {
      const retrieve = vi.fn(async () => {
        throw stripeResourceMissing();
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { retrieve } };

      const err = await payments
        .retrieveDispute({ processorDisputeId: "dp_nope" })
        .catch((e: unknown) => e);
      expect(isAppError(err)).toBe(true);
      expect((err as any).code).toBe("NOT_FOUND");
      expect((err as any).meta).toEqual({ processorDisputeId: "dp_nope" });
    });

    it("retrieveDispute rethrows other Stripe errors untouched", async () => {
      const boom = Object.assign(new Error("rate limited"), {
        type: "StripeRateLimitError",
      });
      const retrieve = vi.fn(async () => {
        throw boom;
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { retrieve } };

      await expect(
        payments.retrieveDispute({ processorDisputeId: "dp_test_1" }),
      ).rejects.toBe(boom);
    });

    it("retrievePaymentIntent maps Stripe resource_missing to a typed NOT_FOUND (4xx, not a 500)", async () => {
      const retrieve = vi.fn(async () => {
        throw Object.assign(new Error("No such payment_intent: 'pi_nope'"), {
          type: "StripeInvalidRequestError",
          code: "resource_missing",
          param: "intent",
        });
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { retrieve } };

      const err = await payments
        .retrievePaymentIntent({ paymentIntentId: "pi_nope" })
        .catch((e: unknown) => e);
      expect(isAppError(err)).toBe(true);
      expect((err as any).code).toBe("NOT_FOUND");
      expect((err as any).meta).toEqual({ paymentIntentId: "pi_nope" });
    });

    // gitleaks:allow (fake test fixture)
    const PI_CLIENT_SECRET_FIXTURE = "pi_test_1_secret_FakeFixtureNotReal";
    const stripePaymentIntent = () => ({
      id: "pi_test_1",
      status: "succeeded",
      amount_received: 2500,
      currency: "USD",
      metadata: { orderId: "order-1" },
      client_secret: PI_CLIENT_SECRET_FIXTURE,
    });

    it("retrievePaymentIntent never carries the client secret (its callers hand the result on and may log it)", async () => {
      const retrieve = vi.fn(async () => stripePaymentIntent());
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { retrieve } };

      const pi = await payments.retrievePaymentIntent({
        paymentIntentId: "pi_test_1",
      });

      expect(pi).toEqual({
        id: "pi_test_1",
        status: "succeeded",
        amountReceived: 2500,
        currency: "usd",
        metadata: { orderId: "order-1" },
      });
      expect(JSON.stringify(pi)).not.toContain("_secret_");
    });

    it("retrievePaymentIntentWithClientSecret answers the same PaymentIntent plus its secret, in one Stripe call", async () => {
      const retrieve = vi.fn(async () => stripePaymentIntent());
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { retrieve } };

      const pi = await payments.retrievePaymentIntentWithClientSecret({
        paymentIntentId: "pi_test_1",
      });

      expect(pi).toEqual({
        id: "pi_test_1",
        status: "succeeded",
        amountReceived: 2500,
        currency: "usd",
        metadata: { orderId: "order-1" },
        clientSecret: PI_CLIENT_SECRET_FIXTURE,
      });
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve).toHaveBeenCalledWith("pi_test_1");
    });

    it("retrievePaymentIntentWithClientSecret answers a null secret when Stripe returns none", async () => {
      const retrieve = vi.fn(async () => ({
        ...stripePaymentIntent(),
        client_secret: null,
      }));
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { retrieve } };

      await expect(
        payments.retrievePaymentIntentWithClientSecret({
          paymentIntentId: "pi_test_1",
        }),
      ).resolves.toMatchObject({ clientSecret: null });
    });

    it("retrievePaymentIntentWithClientSecret maps Stripe resource_missing to the same typed NOT_FOUND", async () => {
      const retrieve = vi.fn(async () => {
        throw Object.assign(new Error("No such payment_intent: 'pi_nope'"), {
          type: "StripeInvalidRequestError",
          code: "resource_missing",
          param: "intent",
        });
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { retrieve } };

      const err = await payments
        .retrievePaymentIntentWithClientSecret({ paymentIntentId: "pi_nope" })
        .catch((e: unknown) => e);
      expect(isAppError(err)).toBe(true);
      expect((err as any).code).toBe("NOT_FOUND");
      expect((err as any).meta).toEqual({ paymentIntentId: "pi_nope" });
    });

    it("retrievePaymentIntent rethrows other Stripe errors untouched", async () => {
      const boom = Object.assign(new Error("rate limited"), {
        type: "StripeRateLimitError",
      });
      const retrieve = vi.fn(async () => {
        throw boom;
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { retrieve } };

      await expect(
        payments.retrievePaymentIntent({ paymentIntentId: "pi_test_1" }),
      ).rejects.toBe(boom);
    });

    /**
     * A Stripe error about a PaymentIntent can carry the whole object, client
     * secret included, on `err.payment_intent` and again under `err.raw`.
     * Callers log and report these errors whole, so the adapter removes the
     * objects before the error leaves it.
     */
    const stripeErrorCarryingIntent = (over: Record<string, unknown> = {}) =>
      Object.assign(new Error("Your card was declined."), {
        type: "StripeCardError",
        code: "card_declined",
        decline_code: "generic_decline",
        payment_intent: stripePaymentIntent(),
        setup_intent: { id: "seti_1", client_secret: PI_CLIENT_SECRET_FIXTURE },
        raw: {
          code: "card_declined",
          message: "Your card was declined.",
          payment_intent: stripePaymentIntent(),
          setup_intent: {
            id: "seti_1",
            client_secret: PI_CLIENT_SECRET_FIXTURE,
          },
        },
        ...over,
      });
    /** The error as pino and Sentry see it: own properties, `raw` included. */
    const asLogged = (err: unknown) =>
      JSON.stringify(err, Object.getOwnPropertyNames(err as object).concat([
        "raw",
        "payment_intent",
        "setup_intent",
        "client_secret",
        "cause",
        "code",
        "id",
      ]));

    it("the fixture is honest: untouched, the error does carry the client secret", () => {
      expect(asLogged(stripeErrorCarryingIntent())).toContain(
        PI_CLIENT_SECRET_FIXTURE,
      );
    });

    it("cancelPaymentIntent rethrows the same error without the PaymentIntent / SetupIntent objects, top level and under raw", async () => {
      const boom = stripeErrorCarryingIntent();
      const cancel = vi.fn(async () => {
        throw boom;
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { cancel } };

      const err = await payments
        .cancelPaymentIntent({ paymentIntentId: "pi_test_1" })
        .catch((e: unknown) => e);

      // The same error object: type, code and decline details stay.
      expect(err).toBe(boom);
      expect(err).toMatchObject({
        type: "StripeCardError",
        code: "card_declined",
        decline_code: "generic_decline",
        raw: { code: "card_declined", message: "Your card was declined." },
      });
      expect(err).not.toHaveProperty("payment_intent");
      expect(err).not.toHaveProperty("setup_intent");
      expect((err as any).raw).not.toHaveProperty("payment_intent");
      expect((err as any).raw).not.toHaveProperty("setup_intent");
      expect(asLogged(err)).not.toContain("_secret_");
    });

    it.each([
      ["retrievePaymentIntent", "retrievePaymentIntent"],
      [
        "retrievePaymentIntentWithClientSecret",
        "retrievePaymentIntentWithClientSecret",
      ],
    ] as const)(
      "%s rethrows a Stripe error without the PaymentIntent object",
      async (_label, method) => {
        const boom = stripeErrorCarryingIntent({
          type: "StripeAPIError",
          code: "api_error",
        });
        const retrieve = vi.fn(async () => {
          throw boom;
        });
        const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
        (payments as any).s = { paymentIntents: { retrieve } };

        const err = await payments[method]({
          paymentIntentId: "pi_test_1",
        }).catch((e: unknown) => e);

        expect(err).toBe(boom);
        expect(asLogged(err)).not.toContain("_secret_");
      },
    );

    it("the typed NOT_FOUND for resource_missing carries a cause without the PaymentIntent object", async () => {
      const boom = stripeErrorCarryingIntent({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
      });
      const retrieve = vi.fn(async () => {
        throw boom;
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { retrieve } };

      const err = await payments
        .retrievePaymentIntentWithClientSecret({ paymentIntentId: "pi_nope" })
        .catch((e: unknown) => e);

      expect((err as any).code).toBe("NOT_FOUND");
      expect((err as any).cause).toBe(boom);
      expect(asLogged((err as any).cause)).not.toContain("_secret_");
    });

    it("cancelPaymentIntent still answers { canceled: false } for a PaymentIntent already terminal", async () => {
      const cancel = vi.fn(async () => {
        throw Object.assign(
          new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "payment_intent_unexpected_state",
            message: "You cannot cancel this PaymentIntent",
          } as never),
          {},
        );
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { paymentIntents: { cancel } };

      await expect(
        payments.cancelPaymentIntent({ paymentIntentId: "pi_test_1" }),
      ).resolves.toEqual({ canceled: false });
    });

    it("updateDisputeEvidence passes submit through, omits undefined keys, and forwards the idempotency key", async () => {
      const update = vi.fn(async () =>
        stripeDispute({ status: "under_review" }),
      );
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { update } };

      const snapshot = await payments.updateDisputeEvidence({
        processorDisputeId: "dp_test_1",
        evidence: {
          productDescription: "2x GA — Launch Party",
          receipt: "file_receipt",
          customerName: undefined,
        },
        submit: true,
        idempotencyKey: "dispute-evidence:dp_test_1:attempt-1:update",
      });

      const [id, params, options] = update.mock.calls[0] ?? [];
      expect(id).toBe("dp_test_1");
      expect(params).toEqual({
        evidence: {
          product_description: "2x GA — Launch Party",
          receipt: "file_receipt",
        },
        submit: true,
      });
      expect("customer_name" in (params as any).evidence).toBe(false);
      expect(options).toEqual({
        idempotencyKey: "dispute-evidence:dp_test_1:attempt-1:update",
      });
      expect(snapshot.status).toBe("under_review");
    });

    it("updateDisputeEvidence sends submit:false explicitly when staging", async () => {
      const update = vi.fn(async () => stripeDispute());
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { update } };

      await payments.updateDisputeEvidence({
        processorDisputeId: "dp_test_1",
        evidence: { uncategorizedText: "draft" },
        submit: false,
      });

      const [, params, options] = update.mock.calls[0] ?? [];
      expect(params).toEqual({
        evidence: { uncategorized_text: "draft" },
        submit: false,
      });
      expect(options).toBeUndefined();
    });

    it("updateDisputeEvidence rejects over-limit evidence BEFORE calling Stripe", async () => {
      const update = vi.fn(async () => stripeDispute());
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { update } };

      const err = await payments
        .updateDisputeEvidence({
          processorDisputeId: "dp_test_1",
          evidence: { productDescription: "x".repeat(20_001) },
          submit: true,
        })
        .catch((e: unknown) => e);

      expect(update).not.toHaveBeenCalled();
      expect(isAppError(err)).toBe(true);
      expect((err as any).code).toBe("DISPUTE_EVIDENCE_LIMIT_EXCEEDED");
      expect((err as any).meta).toEqual({
        processorDisputeId: "dp_test_1",
        combinedChars: 20_001,
        violations: [
          {
            kind: "field",
            field: "productDescription",
            chars: 20_001,
            max: 20_000,
          },
        ],
      });
    });

    it("updateDisputeEvidence maps resource_missing to NOT_FOUND", async () => {
      const update = vi.fn(async () => {
        throw stripeResourceMissing();
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { update } };

      const err = await payments
        .updateDisputeEvidence({
          processorDisputeId: "dp_nope",
          evidence: {},
          submit: false,
        })
        .catch((e: unknown) => e);
      expect(isAppError(err)).toBe(true);
      expect((err as any).code).toBe("NOT_FOUND");
    });

    it("updateDisputeEvidence rethrows non-resource_missing Stripe errors untouched", async () => {
      // e.g. Stripe's "dispute is not in needs_response" invalid_request, or
      // an idempotency_error — neither is translated here by design; the use
      // case gates on retrieveDispute().status first.
      const boom = Object.assign(new Error("This dispute is not open"), {
        type: "StripeInvalidRequestError",
        code: "dispute_not_open",
      });
      const update = vi.fn(async () => {
        throw boom;
      });
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { disputes: { update } };

      await expect(
        payments.updateDisputeEvidence({
          processorDisputeId: "dp_test_1",
          evidence: { uncategorizedText: "x" },
          submit: true,
        }),
      ).rejects.toBe(boom);
    });

    it("uploadDisputeEvidenceFile uses purpose dispute_evidence and returns the file id", async () => {
      const create = vi.fn(async () => ({ id: "file_abc", object: "file" }));
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { files: { create } };

      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
      const result = await payments.uploadDisputeEvidenceFile({
        data: bytes,
        filename: "receipt.pdf",
        contentType: "application/pdf",
        idempotencyKey: "dispute-evidence:dp_test_1:attempt-1:file:receipt",
      });

      expect(result).toEqual({ processorFileId: "file_abc" });
      const [params, options] = create.mock.calls[0] ?? [];
      expect(params).toEqual({
        file: { data: bytes, name: "receipt.pdf", type: "application/pdf" },
        purpose: "dispute_evidence",
      });
      expect((params as any).file.data).toBe(bytes);
      expect(options).toEqual({
        idempotencyKey: "dispute-evidence:dp_test_1:attempt-1:file:receipt",
      });
    });

    it("uploadDisputeEvidenceFile omits the request options when no idempotency key is given", async () => {
      const create = vi.fn(async () => ({ id: "file_def", object: "file" }));
      const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
      (payments as any).s = { files: { create } };

      await payments.uploadDisputeEvidenceFile({
        data: new Uint8Array([1, 2, 3]),
        filename: "log.txt",
        contentType: "text/plain",
      });

      const [, options] = create.mock.calls[0] ?? [];
      expect(options).toBeUndefined();
    });
  });
});

describe("StripePaymentProcessor.refundPaymentIntent", () => {
  function refundHarness(create: (...args: any[]) => Promise<unknown>) {
    const retrieve = vi.fn(async () => ({
      id: "pi_test_1",
      latest_charge: "ch_test_1",
    }));
    const createSpy = vi.fn(create);
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = {
      paymentIntents: { retrieve },
      refunds: { create: createSpy },
    };
    return { payments, retrieve, create: createSpy };
  }

  it("refunds the latest charge and maps the refund status", async () => {
    const { payments, create } = refundHarness(async () => ({
      id: "re_test_1",
      status: "succeeded",
    }));

    const out = await payments.refundPaymentIntent({
      paymentIntentId: "pi_test_1",
      amountCents: 1500,
      reason: "requested_by_customer",
      idempotencyKey: "refund:test",
    });

    expect(out).toEqual({ refundId: "re_test_1", status: "succeeded" });
    expect(create).toHaveBeenCalledWith(
      {
        charge: "ch_test_1",
        amount: 1500,
        reason: "requested_by_customer",
      },
      { idempotencyKey: "refund:test" },
    );
  });

  it("maps Stripe charge_disputed to a typed ORDER_DISPUTED_REFUND_BLOCKED", async () => {
    const disputed = Object.assign(
      new Error("Charge ch_test_1 has been charged back; cannot issue a refund."),
      { type: "StripeInvalidRequestError", code: "charge_disputed" },
    );
    const { payments } = refundHarness(async () => {
      throw disputed;
    });

    const err = await payments
      .refundPaymentIntent({ paymentIntentId: "pi_test_1", amountCents: 1500 })
      .catch((e: unknown) => e);

    expect(isAppError(err)).toBe(true);
    expect((err as any).code).toBe("ORDER_DISPUTED_REFUND_BLOCKED");
    // message === code so the web's error funnel resolves it by identifier.
    expect((err as any).message).toBe("ORDER_DISPUTED_REFUND_BLOCKED");
    expect((err as any).meta).toEqual({ paymentIntentId: "pi_test_1" });
    expect((err as any).cause).toBe(disputed);
  });

  it.each([
    ["charge_already_refunded", "StripeInvalidRequestError"],
    ["resource_missing", "StripeInvalidRequestError"],
    [undefined, "StripeRateLimitError"],
  ])(
    "rethrows other Stripe refund errors untouched (code=%s, type=%s)",
    async (code, type) => {
      const boom = Object.assign(new Error("nope"), { type, code });
      const { payments } = refundHarness(async () => {
        throw boom;
      });

      await expect(
        payments.refundPaymentIntent({
          paymentIntentId: "pi_test_1",
          amountCents: 1500,
        }),
      ).rejects.toBe(boom);
    },
  );
});

// ── Refund metadata + retrieval (money audit 2026-09-08 #10) ─────────────────
describe("StripePaymentProcessor.refundPaymentIntent metadata", () => {
  it("passes the caller's metadata through to stripe.refunds.create", async () => {
    const retrieve = vi.fn(async () => ({
      id: "pi_test_1",
      latest_charge: "ch_test_1",
    }));
    const create = vi.fn(async () => ({ id: "re_test_2", status: "succeeded" }));
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = {
      paymentIntents: { retrieve },
      refunds: { create },
    };

    await payments.refundPaymentIntent({
      paymentIntentId: "pi_test_1",
      amountCents: 1500,
      idempotencyKey: "refund:test",
      metadata: { orderId: "order-1", orderItemIds: "item-a,item-b" },
    });

    expect(create).toHaveBeenCalledWith(
      {
        charge: "ch_test_1",
        amount: 1500,
        reason: undefined,
        metadata: { orderId: "order-1", orderItemIds: "item-a,item-b" },
      },
      { idempotencyKey: "refund:test" },
    );
  });
});

describe("StripePaymentProcessor.getRefund", () => {
  it("retrieves a refund and maps id, status, amount, payment intent and metadata", async () => {
    const retrieve = vi.fn(async () => ({
      id: "re_test_3",
      status: "succeeded",
      amount: 3000,
      payment_intent: "pi_test_1",
      metadata: { orderId: "order-1", orderItemIds: "item-a" },
    }));
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = { refunds: { retrieve } };

    const out = await payments.getRefund({ refundId: "re_test_3" });

    expect(retrieve).toHaveBeenCalledWith("re_test_3");
    expect(out).toEqual({
      refundId: "re_test_3",
      status: "succeeded",
      amountCents: 3000,
      paymentIntentId: "pi_test_1",
      metadata: { orderId: "order-1", orderItemIds: "item-a" },
    });
  });

  it("tolerates an expanded payment_intent object and missing metadata", async () => {
    const retrieve = vi.fn(async () => ({
      id: "re_test_4",
      status: "pending",
      amount: 100,
      payment_intent: { id: "pi_test_9" },
      metadata: null,
    }));
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = { refunds: { retrieve } };

    const out = await payments.getRefund({ refundId: "re_test_4" });

    expect(out).toEqual({
      refundId: "re_test_4",
      status: "pending",
      amountCents: 100,
      paymentIntentId: "pi_test_9",
      metadata: {},
    });
  });
});

describe("StripePaymentProcessor.listRefundsForPaymentIntent", () => {
  it("lists by payment_intent and maps id, status, amount and metadata", async () => {
    const list = vi.fn(async () => ({
      data: [
        {
          id: "re_new",
          status: "succeeded",
          amount: 3000,
          metadata: { orderId: "order-1", orderItemIds: "item-a" },
        },
        { id: "re_old", status: "failed", amount: 100, metadata: null },
      ],
      has_more: false,
    }));
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = { refunds: { list } };

    const out = await payments.listRefundsForPaymentIntent({
      paymentIntentId: "pi_test_1",
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      payment_intent: "pi_test_1",
      limit: 100,
    });
    expect(out).toEqual([
      {
        refundId: "re_new",
        status: "succeeded",
        amountCents: 3000,
        metadata: { orderId: "order-1", orderItemIds: "item-a" },
      },
      { refundId: "re_old", status: "failed", amountCents: 100, metadata: {} },
    ]);
  });

  it("follows has_more with starting_after so a page cap never hides a refund", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "re_1", status: "succeeded", amount: 1, metadata: {} }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "re_2", status: "pending", amount: 2, metadata: {} }],
        has_more: false,
      });
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = { refunds: { list } };

    const out = await payments.listRefundsForPaymentIntent({
      paymentIntentId: "pi_test_1",
    });

    expect(list).toHaveBeenNthCalledWith(2, {
      payment_intent: "pi_test_1",
      limit: 100,
      starting_after: "re_1",
    });
    expect(out.map((r) => r.refundId)).toEqual(["re_1", "re_2"]);
  });

  it("propagates a listing failure (the use case must not swallow it)", async () => {
    const list = vi.fn(async () => {
      throw new Error("stripe_down");
    });
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = { refunds: { list } };

    await expect(
      payments.listRefundsForPaymentIntent({ paymentIntentId: "pi_test_1" }),
    ).rejects.toThrow("stripe_down");
  });
});

describe("StripePaymentProcessor.getConnectAccountStatus", () => {
  it("maps the account's payout schedule so the payout email can talk about timing", async () => {
    const retrieve = vi.fn(async () => ({
      id: "acct_1",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], eventually_due: [], past_due: [] },
      capabilities: { transfers: "active", card_payments: "active" },
      settings: { payouts: { schedule: { interval: "daily", delay_days: 2 } } },
    }));
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = { accounts: { retrieve } };

    const out = await payments.getConnectAccountStatus({ accountId: "acct_1" });

    expect(retrieve).toHaveBeenCalledWith("acct_1");
    expect(out.payoutSchedule).toEqual({ interval: "daily", delayDays: 2 });
    expect(out.capabilities).toEqual({
      transfers: "active",
      card_payments: "active",
    });
  });

  it("returns payoutSchedule: null when the account carries no schedule (consumers say nothing about timing)", async () => {
    const retrieve = vi.fn(async () => ({
      id: "acct_2",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: { currently_due: ["tos"], eventually_due: [], past_due: [] },
      settings: {},
    }));
    const payments = new StripePaymentProcessor({ apiKey: "sk_test_x" });
    (payments as any).s = { accounts: { retrieve } };

    const out = await payments.getConnectAccountStatus({ accountId: "acct_2" });

    expect(out.payoutSchedule).toBeNull();
    expect(out.capabilities).toBeNull();
    expect(out.requirements.currentlyDue).toEqual(["tos"]);
  });
});
