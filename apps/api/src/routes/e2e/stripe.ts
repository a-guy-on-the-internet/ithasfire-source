/**
 * E2E Stripe helper routes.
 *
 * - POST /e2e/stripe/add-test-funds
 * - GET  /e2e/stripe/balance
 */
import type { FastifyPluginAsync } from "fastify";
import { env } from "../../lib/env.js";
import { assertE2eAuthorized, formatError } from "./_helpers.js";

const stripe: FastifyPluginAsync = async (app) => {
  // ── Add test funds ────────────────────────────────────────────────────
  app.post("/e2e/stripe/add-test-funds", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    if (!env.STRIPE_SECRET_KEY) {
      return reply.status(500).send({
        ok: false,
        error: "missing_stripe_secret",
        message: "STRIPE_SECRET_KEY is required to add test funds.",
      });
    }

    const body = (request.body ?? {}) as {
      amountCents?: number;
      currency?: string;
    };
    const amountCents =
      typeof body.amountCents === "number" ? body.amountCents : 100_000;
    const currency = body.currency ?? "usd";

    try {
      const Stripe = (await import("stripe")).default;
      const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: "2025-08-27.basil",
      });

      const charge = await stripeClient.charges.create({
        amount: amountCents,
        currency,
        source: "tok_bypassPending",
        description: "E2E test: Add funds for Connect transfers",
      });

      const balance = await stripeClient.balance.retrieve();
      const availableUsd = balance.available.find(
        (b) => b.currency === currency,
      );

      app.log.info(
        {
          chargeId: charge.id,
          amountCents,
          availableBalance: availableUsd?.amount,
        },
        "e2e_stripe_test_funds_added",
      );

      return reply.send({
        ok: true,
        chargeId: charge.id,
        amountCents,
        currency,
        availableBalance: availableUsd?.amount ?? 0,
      });
    } catch (err) {
      const message = formatError(err);
      app.log.error(
        { err, amountCents, currency },
        "e2e_stripe_add_test_funds_failed",
      );
      return reply.status(500).send({
        ok: false,
        error: "e2e_stripe_add_test_funds_failed",
        message,
      });
    }
  });

  // ── Get balance ───────────────────────────────────────────────────────
  app.get("/e2e/stripe/balance", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    if (!env.STRIPE_SECRET_KEY) {
      return reply.status(500).send({
        ok: false,
        error: "missing_stripe_secret",
        message: "STRIPE_SECRET_KEY is required to check balance.",
      });
    }

    try {
      const Stripe = (await import("stripe")).default;
      const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: "2025-08-27.basil",
      });

      const balance = await stripeClient.balance.retrieve();

      return reply.send({
        ok: true,
        available: balance.available,
        pending: balance.pending,
      });
    } catch (err) {
      const message = formatError(err);
      app.log.error({ err }, "e2e_stripe_balance_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_stripe_balance_failed",
        message,
      });
    }
  });
};

export default stripe;
