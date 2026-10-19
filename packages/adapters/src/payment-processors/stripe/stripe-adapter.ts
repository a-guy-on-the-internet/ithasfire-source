import Stripe from "stripe";
import { fail } from "@th/errors";
import {
  checkDisputeEvidenceLimits,
  type DisputeEvidenceFields,
} from "@th/ports/dispute-evidence";
import type {
  CreateConnectAccountInput,
  PaymentProcessorPort,
  PaymentRefundStatus,
  PlatformBalanceAmount,
  PlatformBalanceSnapshot,
  ProcessorDisputeSnapshot,
} from "@th/ports/payment-processor-port";
import type { PaymentCardChecks } from "@th/types/repos/orders";

import {
  fromStripeDisputeEvidence,
  toStripeDisputeEvidence,
} from "./dispute-evidence-mapping";

function mapStripeRefundStatus(
  status: Stripe.Refund["status"],
): PaymentRefundStatus {
  switch (status) {
    case "succeeded":
    case "pending":
    case "failed":
    case "canceled":
    case "requires_action":
      return status;
    default:
      // Stripe types allow null; treat unknown as "pending" (safest for callers
      // which only short-circuit on explicit succeeded/failed).
      return "pending";
  }
}

/**
 * Stripe balance bucket → port shape. Currency stays in Stripe's lowercase
 * ISO-4217 casing; `amount` is already integer minor units. `source_types`
 * (the card/bank_account split) is deliberately dropped — the solvency read
 * cares what the balance IS, not which rail it arrived on.
 */
function mapBalanceAmounts(
  buckets: Array<{ currency: string; amount: number }> | undefined | null,
): PlatformBalanceAmount[] {
  if (!buckets) return [];
  return buckets.map((b) => ({
    currency: b.currency.toLowerCase(),
    amountCents: b.amount,
  }));
}

type Ctx = {
  apiKey: string;
  apiVersion?: Stripe.LatestApiVersion;
  /**
   * Optional API base URL override (ex: http://127.0.0.1:12111) for stripe-mock.
   *
   * When omitted, the Stripe SDK default (https://api.stripe.com) is used.
   */
  baseUrl?: string;
};

export class StripePaymentProcessor implements PaymentProcessorPort {
  private s: Stripe;

  constructor({
    apiKey,
    apiVersion = "2025-08-27.basil" as const,
    baseUrl,
  }: Ctx) {
    // Stripe SDK supports `host` override; stripe-mock speaks HTTP and typically
    // runs at http://localhost:12111.
    const host = baseUrl ? new URL(baseUrl).host : undefined;
    const protocol = baseUrl
      ? new URL(baseUrl).protocol.replace(":", "")
      : undefined;
    this.s = new Stripe(apiKey, {
      apiVersion,
      // Pinned so the worst case per call is bounded and KNOWN:
      // 60 s × (1 + maxNetworkRetries) = 120 s. The dispute-evidence submit
      // mutex (core `evidence/_shared/evidence-mutex.ts`, 300 s TTL) makes
      // two calls under its lock and sizes itself from these two numbers —
      // change them together.
      timeout: 60_000,
      maxNetworkRetries: 1,
      ...(host ? { host } : null),
      ...(protocol ? { protocol: protocol as "http" | "https" } : null),
    });
  }

  /**
   * Return the list of Stripe payment method types available for the given
   * currency. Card always (Apple Pay, Google Pay and Link ride on it). ACH
   * Direct Debit (`us_bank_account`) is USD-only and is dropped by
   * `allowBankDebit: false` or `allowRedirectPaymentMethods: false`.
   *
   * Amazon Pay and Cash App Pay are not requested: the owner turned them off
   * in Stripe on 2026-10-13 (reversing the 2026-10-12 ruling that added
   * them). Klarna is off too and was never requested here. With them gone,
   * bank debit is the only non-card method left, so
   * `allowRedirectPaymentMethods: false` now means "card only" and gates
   * nothing beyond what `allowBankDebit: false` already gates.
   */
  private paymentMethodsForCurrency(
    currency: string,
    allowRedirectPaymentMethods = true,
    allowBankDebit = true,
  ): string[] {
    const base = ["card"];
    if (!allowRedirectPaymentMethods) {
      return base;
    }
    if (currency.toLowerCase() === "usd" && allowBankDebit) {
      return [...base, "us_bank_account"];
    }
    return base;
  }

  async createPaymentIntent(input: {
    amountCents: number;
    currency: string;
    customerId?: string;
    idempotencyKey?: string;
    destinationAccountId?: string;
    metadata?: Record<string, string>;
    statementDescriptorSuffix?: string;
    description?: string;
    allowRedirectPaymentMethods?: boolean;
    allowBankDebit?: boolean;
  }): Promise<{ id: string; clientSecret: string }> {
    // NOTE: We do NOT use destination charges (transfer_data.destination) here.
    // Instead, funds stay on the platform account until we explicitly create
    // transfers via createTransfer() (run-batch sets no source_transaction).
    // This allows for flexible settlement logic (e.g., splits to multiple
    // payees, platform fees, refund handling). The destinationAccountId is stored in metadata for
    // reference but doesn't trigger automatic transfer.
    //
    // We explicitly list allowed payment methods instead of using
    // automatic_payment_methods so we can:
    //   1. Exclude BNPL methods (afterpay, klarna, affirm) — not suitable for
    //      ticket sales with hold-based checkout.
    //   2. Include wallets (Apple Pay, Google Pay) and ACH Direct Debit
    //      alongside card. Amazon Pay and Cash App Pay are not requested:
    //      the owner turned them off in Stripe on 2026-10-13.
    //   3. Control exactly which methods appear in the PaymentElement.
    //
    // Note: Apple Pay and Google Pay are surfaced via the `card` method type
    // and the ExpressCheckoutElement on the frontend. They don't need to be
    // listed separately here.
    const pi = await this.s.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency,
        customer: input.customerId,
        metadata: {
          ...input.metadata,
          // Store destination for reference/auditing but don't auto-transfer
          ...(input.destinationAccountId
            ? { destinationAccountId: input.destinationAccountId }
            : null),
        },
        payment_method_types: this.paymentMethodsForCurrency(
          input.currency,
          input.allowRedirectPaymentMethods !== false,
          input.allowBankDebit !== false,
        ),
        payment_method_options: {
          card: { request_three_d_secure: "automatic" },
        },
        ...(input.statementDescriptorSuffix
          ? { statement_descriptor_suffix: input.statementDescriptorSuffix }
          : {}),
        ...(input.description ? { description: input.description } : {}),
        capture_method: "automatic_async",
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    // client_secret exists for client-side confirmation flows
    if (!pi.client_secret) throw new Error("Stripe PI missing client_secret");
    return { id: pi.id, clientSecret: pi.client_secret };
  }

  async refundPaymentIntent(input: {
    paymentIntentId: string;
    amountCents?: number;
    reason?: "duplicate" | "fraudulent" | "requested_by_customer";
    idempotencyKey?: string;
    metadata?: Record<string, string>;
  }): Promise<{ refundId: string; status: PaymentRefundStatus }> {
    // Refund the latest charge on the PI
    const pi = await this.s.paymentIntents.retrieve(input.paymentIntentId, {
      expand: ["latest_charge"],
    });
    const latestChargeId =
      (typeof pi.latest_charge === "string" && pi.latest_charge) ||
      (pi.latest_charge && (pi.latest_charge as Stripe.Charge).id);
    if (!latestChargeId) throw new Error("No latest charge on PaymentIntent");
    let refund: Stripe.Refund;
    try {
      refund = await this.s.refunds.create(
        {
          charge: latestChargeId,
          amount: input.amountCents,
          // `satisfies` keeps the reason checked against Stripe's own set
          // even though this params object is cast below: an off-list value
          // ("other") once made every claim refund fail at Stripe.
          reason: input.reason satisfies
            | Stripe.RefundCreateParams.Reason
            | undefined,
          // Operation identity for the charge.refunded reconciler (which
          // items this refund paid back). Omitted, not `undefined`, so the
          // request stays byte-identical for callers that stamp nothing.
          ...(input.metadata ? { metadata: input.metadata } : {}),
        } as any,
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );
    } catch (err: unknown) {
      rethrowRefundError(err, input.paymentIntentId);
    }
    return {
      refundId: refund.id,
      status: mapStripeRefundStatus(refund.status),
    };
  }

  async getRefund(input: { refundId: string }): Promise<{
    refundId: string;
    status: PaymentRefundStatus;
    amountCents: number;
    paymentIntentId: string | null;
    metadata: Record<string, string>;
  }> {
    const refund = await this.s.refunds.retrieve(input.refundId);
    const paymentIntentId =
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : (refund.payment_intent?.id ?? null);
    return {
      refundId: refund.id,
      status: mapStripeRefundStatus(refund.status),
      amountCents: refund.amount,
      paymentIntentId,
      metadata: (refund.metadata ?? {}) as Record<string, string>,
    };
  }

  async listRefundsForPaymentIntent(input: { paymentIntentId: string }): Promise<
    Array<{
      refundId: string;
      status: PaymentRefundStatus;
      amountCents: number;
      metadata: Record<string, string>;
    }>
  > {
    // Retry pre-flight for the refund use cases: EVERY refund on the
    // PaymentIntent, most-recent-first, following `has_more` — a page cap
    // must never hide the one refund whose metadata names these items.
    const out: Array<{
      refundId: string;
      status: PaymentRefundStatus;
      amountCents: number;
      metadata: Record<string, string>;
    }> = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await this.s.refunds.list({
        payment_intent: input.paymentIntentId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const refund of page.data) {
        out.push({
          refundId: refund.id,
          status: mapStripeRefundStatus(refund.status),
          amountCents: refund.amount,
          metadata: (refund.metadata ?? {}) as Record<string, string>,
        });
      }
      const last = page.data[page.data.length - 1];
      if (!page.has_more || !last) {
        return out;
      }
      startingAfter = last.id;
    }
  }

  async cancelPaymentIntent(input: {
    paymentIntentId: string;
  }): Promise<{ canceled: boolean }> {
    try {
      await this.s.paymentIntents.cancel(input.paymentIntentId);
      return { canceled: true };
    } catch (err: unknown) {
      // Stripe throws payment_intent_unexpected_state when the PI is already
      // in a terminal state (succeeded, canceled, etc.). Treat as no-op.
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        (err as any).code === "payment_intent_unexpected_state"
      ) {
        return { canceled: false };
      }
      // Callers log and report this error whole (`settleCarriedOverCart…`).
      throw withoutClientSecretCarriers(err);
    }
  }

  async getProcessingFeeForPaymentIntent(input: {
    paymentIntentId: string;
  }): Promise<{ feeCents: number; currency: string }> {
    const pi = await this.s.paymentIntents.retrieve(input.paymentIntentId, {
      expand: ["latest_charge.balance_transaction"],
    });

    const latestCharge = pi.latest_charge;
    if (!latestCharge) {
      throw new Error("No latest charge on PaymentIntent");
    }

    if (typeof latestCharge === "string") {
      const fetched = await this.s.charges.retrieve(latestCharge, {
        expand: ["balance_transaction"],
      });
      return extractFeeFromCharge(fetched);
    }

    return extractFeeFromCharge(latestCharge as Stripe.Charge);
  }

  /**
   * The PLATFORM account's own balance. No `stripeAccount` request option —
   * this reads OUR pot, the same one an unfunded `createTransfer` below draws
   * on, which is why a `balance_insufficient` there and a small `available`
   * here are the same fact seen from two sides.
   *
   * Stripe returns `available[]` and `pending[]` as one entry PER CURRENCY;
   * both are mapped through verbatim (no summing across currencies — the
   * caller compares like for like).
   *
   * `connect_reserved` is also on the balance object and is mapped too. It is
   * money Stripe holds against NEGATIVE balances on connected accounts: it
   * sits on our balance but is already earmarked, so it is NOT ours to spend
   * and is never folded into `available`. A solvency read wants to see it —
   * a growing `connect_reserved` is connected accounts going negative on us —
   * so it rides the returned shape as its own bucket. The field is optional
   * on Stripe's type (only present for Connect platforms); absent reads as an
   * empty bucket, i.e. zero for every currency.
   *
   * Read-only: `balance.retrieve` moves nothing.
   */
  async getPlatformBalance(): Promise<PlatformBalanceSnapshot> {
    const balance = await this.s.balance.retrieve();
    return {
      available: mapBalanceAmounts(balance.available),
      pending: mapBalanceAmounts(balance.pending),
      connectReserved: mapBalanceAmounts(balance.connect_reserved),
    };
  }

  async createTransfer(input: {
    amountCents: number;
    currency: string;
    destinationAccountId: string; // acct_xxx
    metadata?: Record<string, string>;
    sourceTransaction?: string; // charge ID (ch_xxx) to fund the transfer
    idempotencyKey?: string;
  }): Promise<{ id: string }> {
    let t: Stripe.Transfer;
    try {
      t = await this.s.transfers.create(
        {
          amount: input.amountCents,
          currency: input.currency,
          destination: input.destinationAccountId,
          metadata: input.metadata,
          // source_transaction links the transfer to a specific charge,
          // ensuring funds are taken from that payment. Required in Stripe
          // test mode for Connect transfers to succeed.
          ...(input.sourceTransaction
            ? { source_transaction: input.sourceTransaction }
            : {}),
        },
        // Stripe-side idempotency: a retry of the same logical transfer (same
        // key) within Stripe's 24h key window replays the original response
        // instead of issuing a second transfer. Mirrors reverseTransfer below.
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );
    } catch (err) {
      // Without source_transaction the transfer draws on the PLATFORM's
      // available balance, so `balance_insufficient` here means OUR float ran
      // dry — nothing is wrong with the destination account. Re-throw as a
      // typed marker so the payout batch can classify it instead of counting
      // it as one more anonymous transfer failure. Deliberately NOT applied
      // when source_transaction is set: that variant's shortfall is about the
      // named charge, which is a different diagnosis.
      if (!input.sourceTransaction && isInsufficientPlatformBalance(err)) {
        throw new StripeInsufficientPlatformBalanceError(
          err instanceof Error
            ? err.message
            : "insufficient platform balance for transfer",
          { cause: err },
        );
      }
      throw err;
    }
    return { id: t.id };
  }

  async reverseTransfer(input: {
    transferId: string;
    amountCents?: number;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{ reversalId: string }> {
    const reversal = await this.s.transfers.createReversal(
      input.transferId,
      {
        ...(input.amountCents != null ? { amount: input.amountCents } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return { reversalId: reversal.id };
  }

  async getTransfer(input: {
    transferId: string;
  }): Promise<{ amountCents: number; amountReversedCents: number }> {
    const t = await this.s.transfers.retrieve(input.transferId);
    return {
      amountCents: t.amount,
      amountReversedCents: t.amount_reversed,
    };
  }

  async listTransferReversals(input: { transferId: string }): Promise<
    Array<{
      reversalId: string;
      amountCents: number;
      metadata: Record<string, string>;
    }>
  > {
    // One max-size page is sufficient: a transfer accrues at most a handful
    // of partial reversals (one per refund operation that touched it), far
    // below Stripe's 100-per-page ceiling.
    const page = await this.s.transfers.listReversals(input.transferId, {
      limit: 100,
    });
    return page.data.map((r) => ({
      reversalId: r.id,
      amountCents: r.amount,
      metadata: (r.metadata ?? {}) as Record<string, string>,
    }));
  }

  async retrievePaymentIntent(input: { paymentIntentId: string }): Promise<{
    id: string;
    status: string;
    amountReceived: number;
    currency: string;
    metadata: Record<string, string>;
  }> {
    // Mapped field by field: the client secret must not ride along here.
    const pi = await this.retrievePaymentIntentWithClientSecret(input);
    return {
      id: pi.id,
      status: pi.status,
      amountReceived: pi.amountReceived,
      currency: pi.currency,
      metadata: pi.metadata,
    };
  }

  /**
   * The same retrieve, with the PaymentIntent's client secret. Kept off
   * `retrievePaymentIntent` so only the caller that must check a presented
   * secret ever holds one (see the port).
   */
  async retrievePaymentIntentWithClientSecret(input: {
    paymentIntentId: string;
  }): Promise<{
    id: string;
    status: string;
    amountReceived: number;
    currency: string;
    metadata: Record<string, string>;
    clientSecret: string | null;
  }> {
    let pi: Stripe.PaymentIntent;
    try {
      pi = await this.s.paymentIntents.retrieve(input.paymentIntentId);
    } catch (err) {
      rethrowPaymentIntentError(err, input.paymentIntentId);
    }
    return {
      id: pi.id,
      status: pi.status,
      amountReceived: pi.amount_received ?? 0,
      currency: (pi.currency ?? "").toLowerCase(),
      metadata: (pi.metadata ?? {}) as Record<string, string>,
      clientSecret: pi.client_secret ?? null,
    };
  }

  async getChargeIdForPaymentIntent(input: {
    paymentIntentId: string;
  }): Promise<{ chargeId: string }> {
    const pi = await this.s.paymentIntents.retrieve(input.paymentIntentId, {
      expand: ["latest_charge"],
    });
    const latestCharge = pi.latest_charge;
    if (!latestCharge) {
      throw new Error("No latest charge on PaymentIntent");
    }
    const chargeId =
      typeof latestCharge === "string" ? latestCharge : latestCharge.id;
    return { chargeId };
  }

  async getPaymentMethodType(input: {
    paymentIntentId: string;
  }): Promise<{
    methodType: string | null;
    cardChecks: PaymentCardChecks | null;
  }> {
    const pi = await this.s.paymentIntents.retrieve(input.paymentIntentId, {
      expand: ["latest_charge"],
    });
    const latestCharge = pi.latest_charge;
    if (!latestCharge || typeof latestCharge === "string") {
      // No expanded charge available — can't determine method.
      return { methodType: null, cardChecks: null };
    }
    const charge = latestCharge as Stripe.Charge;
    const checks = charge.payment_method_details?.card?.checks;
    return {
      methodType: charge.payment_method_details?.type ?? null,
      // Verbatim Stripe vocabulary (pass/fail/unavailable/unchecked); null
      // per check when Stripe did not run it, null overall for non-card.
      cardChecks: checks
        ? {
            addressLine1Check: checks.address_line1_check ?? null,
            addressPostalCodeCheck: checks.address_postal_code_check ?? null,
            cvcCheck: checks.cvc_check ?? null,
          }
        : null,
    };
  }

  // ── Stripe Connect ──────────────────────────────────────────────────────

  async createConnectAccount(
    input: CreateConnectAccountInput,
  ): Promise<{ accountId: string }> {
    // Online-checkout capability pair. `card_present` is requested later via
    // accounts.update when an account actually onboards to the scanner POS —
    // Stripe rejects it at create time for Express accounts.
    const acct = await this.s.accounts.create(
      {
        type: "express",
        business_type: input.businessType,
        ...(input.businessType === "individual" && input.individualEmail
          ? { individual: { email: input.individualEmail } }
          : {}),
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return { accountId: acct.id };
  }

  async createAccountOnboardingLink(params: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }> {
    const link = await this.s.accountLinks.create({
      account: params.accountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: "account_onboarding",
    });
    return { url: link.url };
  }

  async createConnectLoginLink(input: {
    accountId: string;
  }): Promise<{ url: string }> {
    const link = await this.s.accounts.createLoginLink(input.accountId);
    return { url: link.url };
  }

  async getConnectAccountStatus(input: { accountId: string }): Promise<{
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirements: {
      currentlyDue: string[];
      eventuallyDue: string[];
      pastDue: string[];
    };
    capabilities?: {
      transfers?: string | null;
      card_payments?: string | null;
    } | null;
    payoutSchedule?: { interval: string; delayDays: number } | null;
  }> {
    const acct = await this.s.accounts.retrieve(input.accountId);
    const schedule = acct.settings?.payouts?.schedule;
    return {
      chargesEnabled: acct.charges_enabled ?? false,
      payoutsEnabled: acct.payouts_enabled ?? false,
      detailsSubmitted: acct.details_submitted ?? false,
      requirements: {
        currentlyDue: (acct.requirements?.currently_due as string[]) ?? [],
        eventuallyDue: (acct.requirements?.eventually_due as string[]) ?? [],
        pastDue: (acct.requirements?.past_due as string[]) ?? [],
      },
      // Carried so the live read derives capability state from exactly the
      // same inputs as the `account.updated` webhook. Without it the two paths
      // disagree about `transfers`, and the live read (always the newer
      // observation) would win.
      capabilities: acct.capabilities
        ? {
            transfers: acct.capabilities.transfers ?? null,
            card_payments: acct.capabilities.card_payments ?? null,
          }
        : null,
      // `delay_days` is typed as required by Stripe but guarded anyway: the
      // consumer turns a null into "say nothing about timing", which is the
      // right failure mode for a field that only ever feeds copy.
      payoutSchedule:
        schedule && typeof schedule.delay_days === "number"
          ? { interval: schedule.interval, delayDays: schedule.delay_days }
          : null,
    };
  }

  // ── Disputes (chargebacks) ──────────────────────────────────────────────

  async retrieveDispute(input: {
    processorDisputeId: string;
  }): Promise<ProcessorDisputeSnapshot> {
    try {
      const dispute = await this.s.disputes.retrieve(input.processorDisputeId);
      return mapDispute(dispute);
    } catch (err) {
      rethrowDisputeError(err, input.processorDisputeId);
    }
  }

  async updateDisputeEvidence(input: {
    processorDisputeId: string;
    evidence: DisputeEvidenceFields;
    submit: boolean;
    idempotencyKey?: string;
  }): Promise<ProcessorDisputeSnapshot> {
    // Pre-flight the size caps locally so an over-limit payload never reaches
    // Stripe — after an operator hits "submit", a processor-side 400 is a
    // worse failure than a typed error they can act on.
    //
    // Scope: this checks the fields in THIS call only. Stripe's 150k combined
    // cap is over the MERGED hash (already-staged evidence + this update), and
    // this adapter does not read the dispute before every write. A submitting
    // use case must `retrieveDispute`, pass `snapshot.evidence` as the
    // helper's `existing` argument, and check the merge before calling here.
    const limits = checkDisputeEvidenceLimits(input.evidence);
    if (!limits.ok) {
      throw fail("DISPUTE_EVIDENCE_LIMIT_EXCEEDED", {
        message: "dispute evidence exceeds the processor's size limits",
        meta: {
          processorDisputeId: input.processorDisputeId,
          combinedChars: limits.combinedChars,
          violations: limits.violations,
        },
      });
    }

    try {
      const dispute = await this.s.disputes.update(
        input.processorDisputeId,
        {
          // Only present keys are forwarded; an `undefined` key would unset
          // the field at Stripe (see dispute-evidence-mapping).
          evidence: toStripeDisputeEvidence(input.evidence),
          // Explicit in both directions: Stripe defaults `submit` to true,
          // and a staging call that silently submitted would be irreversible.
          submit: input.submit,
        },
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );
      return mapDispute(dispute);
    } catch (err) {
      rethrowDisputeError(err, input.processorDisputeId);
    }
  }

  async uploadDisputeEvidenceFile(input: {
    data: Uint8Array;
    filename: string;
    contentType: string;
    idempotencyKey?: string;
  }): Promise<{ processorFileId: string }> {
    // Multipart upload; the SDK accepts a Uint8Array directly. Bytes are
    // never logged here.
    const file = await this.s.files.create(
      {
        file: {
          data: input.data,
          name: input.filename,
          type: input.contentType,
        },
        purpose: "dispute_evidence",
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return { processorFileId: file.id };
  }

  // ── Tax ─────────────────────────────────────────────────────────────────

  async calculateTax(input: {
    currency: string;
    lineItems: Array<{ amountCents: number; reference: string }>;
    customerAddress: {
      line1: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  }): Promise<{ taxAmountCents: number; calculationId: string | null }> {
    const calculation = await this.s.tax.calculations.create({
      currency: input.currency,
      line_items: input.lineItems.map((li) => ({
        amount: li.amountCents,
        reference: li.reference,
        // General tax code for event admissions / entertainment services
        tax_code: "txcd_20060006",
      })),
      customer_details: {
        address: {
          line1: input.customerAddress.line1,
          city: input.customerAddress.city,
          state: input.customerAddress.state,
          postal_code: input.customerAddress.postalCode,
          country: input.customerAddress.country,
        },
        address_source: "billing",
      },
    });

    return {
      taxAmountCents: calculation.tax_amount_exclusive ?? 0,
      calculationId: calculation.id,
    };
  }

  // ── Stripe Terminal / in-person POS ───────────────────────────────────

  async createTerminalConnectionToken(_input: {
    stripeAccountId: string;
  }): Promise<{ secret: string }> {
    // SCT (D-2026-04-26): card-present PIs are created on the PLATFORM
    // (see `createCardPresentPaymentIntent`), so the Terminal SDK must
    // authenticate against the PLATFORM too — otherwise `retrievePaymentIntent`
    // by client secret 404s because the SDK looks on the connected
    // account where the PI doesn't exist.
    //
    // We intentionally do NOT pass the connected account's
    // `stripeAccount` request option. `_input.stripeAccountId` is
    // retained on the contract for symmetry with future direct-charge
    // flows but ignored here.
    const token = await this.s.terminal.connectionTokens.create({});
    return { secret: token.secret };
  }

  async createTerminalLocation(input: {
    displayName: string;
    address: {
      line1: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  }): Promise<{ locationId: string }> {
    // Created on the PLATFORM account (no `stripeAccount` request option).
    // SCT card-present flows route every PI through the platform, so the
    // Reader's Location must match.
    const location = await this.s.terminal.locations.create({
      display_name: input.displayName,
      address: {
        line1: input.address.line1,
        city: input.address.city,
        state: input.address.state,
        postal_code: input.address.postalCode,
        country: input.address.country,
      },
    });
    return { locationId: location.id };
  }

  async createCardPresentPaymentIntent(input: {
    amountCents: number;
    currency: string;
    destinationAccountId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
    statementDescriptorSuffix?: string;
    description?: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string }> {
    // Per decision D-2026-04-26 (spec v1.3): POS Tap to Pay uses
    // separate-charge-and-transfer, NOT direct charges. The PaymentIntent
    // is created on the PLATFORM account (no `stripeAccount` request
    // option), and the eventual transfer to the connected account is
    // performed by the payout batch (settlements/run-batch.ts) using
    // `source_transaction`. No `application_fee_amount` — the platform's
    // cut is taken implicitly because the funds never leave the platform
    // balance until Settlement runs.
    //
    // Differs from `createPaymentIntent` in two intentional ways:
    //   1. payment_method_types: ["card_present"] — pinned, no other
    //      methods are valid for a Tap to Pay surface.
    //   2. capture_method: "automatic" — no manual capture step at the
    //      till; the SDK confirms and captures in one motion.
    //
    // Metadata MUST include orderId, eventId, paymentChannel="POS"
    // (caller's responsibility — see use case `start-pos-sale`).
    // We additionally stamp `destinationAccountId` so the Settlement
    // transfer step can resolve the connected account from the PI.
    const pi = await this.s.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency,
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        metadata: {
          ...input.metadata,
          destinationAccountId: input.destinationAccountId,
        },
        ...(input.statementDescriptorSuffix
          ? { statement_descriptor_suffix: input.statementDescriptorSuffix }
          : {}),
        ...(input.description ? { description: input.description } : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (!pi.client_secret) {
      // Should never happen for a freshly-created PI, but the type is
      // nullable so we guard explicitly rather than returning empty.
      throw new Error("Stripe PaymentIntent missing client_secret");
    }

    return { paymentIntentId: pi.id, clientSecret: pi.client_secret };
  }

  // ── Server-driven smart readers ─────────────────────────────────────────
  // All of these operate on the PLATFORM account (no `stripeAccount` request
  // option), matching the Location and the card-present PIs above.

  async registerTerminalReader(input: {
    registrationCode: string;
    label: string;
    locationId: string;
  }): Promise<{
    readerId: string;
    deviceType: string | null;
    status: "online" | "offline" | null;
  }> {
    try {
      const reader = await this.s.terminal.readers.create({
        registration_code: input.registrationCode,
        label: input.label,
        location: input.locationId,
      });
      return {
        readerId: reader.id,
        deviceType: reader.device_type ?? null,
        status: mapReaderStatus(reader.status),
      };
    } catch (err) {
      // A wrong/expired code comes back as a generic invalid_request_error.
      // Re-throw it as a typed marker so the use case can map it to
      // POS_READER_REGISTRATION_CODE_INVALID instead of a 500.
      if (isInvalidRegistrationCode(err)) {
        throw new StripeRegistrationCodeError(
          err instanceof Error ? err.message : "invalid registration code",
        );
      }
      throw err;
    }
  }

  async getTerminalReader(input: { readerId: string }): Promise<{
    readerId: string;
    label: string | null;
    deviceType: string | null;
    status: "online" | "offline" | null;
    action: {
      type: string;
      status: "in_progress" | "succeeded" | "failed";
      failureCode: string | null;
      failureMessage: string | null;
    } | null;
  }> {
    const reader = await this.s.terminal.readers.retrieve(input.readerId);
    if (reader.deleted) {
      throw new Error(`Stripe Terminal reader ${input.readerId} is deleted`);
    }
    const action = reader.action ?? null;
    return {
      readerId: reader.id,
      label: reader.label ?? null,
      deviceType: reader.device_type ?? null,
      status: mapReaderStatus(reader.status),
      action: action
        ? {
            type: action.type,
            status: action.status,
            failureCode: action.failure_code ?? null,
            failureMessage: action.failure_message ?? null,
          }
        : null,
    };
  }

  async deleteTerminalReader(input: { readerId: string }): Promise<void> {
    await this.s.terminal.readers.del(input.readerId);
  }

  async processPaymentIntentOnReader(input: {
    readerId: string;
    paymentIntentId: string;
  }): Promise<{ actionStatus: "in_progress" | "succeeded" | "failed" }> {
    const reader = await this.s.terminal.readers.processPaymentIntent(
      input.readerId,
      { payment_intent: input.paymentIntentId },
    );
    // Stripe returns the reader with its freshly-attached action. A null
    // action would mean the reader accepted the call but reported nothing to
    // do — treat it as in_progress and let the webhook/poll decide.
    return { actionStatus: reader.action?.status ?? "in_progress" };
  }

  async cancelReaderAction(input: { readerId: string }): Promise<void> {
    try {
      await this.s.terminal.readers.cancelAction(input.readerId);
    } catch (err) {
      // No action in flight → Stripe 400s. That is the desired end state, so
      // it is not an error from the operator's point of view.
      if (isNoActionInProgress(err)) {
        return;
      }
      throw err;
    }
  }
}

/**
 * Thrown when Stripe rejects a Terminal registration code. Carried as a named
 * class so the use case layer can map it without string-matching Stripe copy.
 */
export class StripeRegistrationCodeError extends Error {
  readonly isRegistrationCodeError = true as const;

  constructor(message: string) {
    super(message);
    this.name = "StripeRegistrationCodeError";
  }
}

/**
 * Thrown when Stripe refuses a platform-funded transfer because the PLATFORM's
 * available balance can't cover it. Carried as a named class (mirroring
 * StripeRegistrationCodeError) so the payout batch can classify it without
 * string-matching Stripe copy or importing the Stripe SDK into core.
 *
 * This is an operator-side condition, not a payee-side one: every payee in the
 * batch is affected and none of them is at fault.
 */
export class StripeInsufficientPlatformBalanceError extends Error {
  readonly isInsufficientPlatformBalanceError = true as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StripeInsufficientPlatformBalanceError";
  }
}

function mapReaderStatus(
  status: Stripe.Terminal.Reader["status"] | null | undefined,
): "online" | "offline" | null {
  return status === "online" || status === "offline" ? status : null;
}

function isStripeInvalidRequest(err: unknown): err is Stripe.errors.StripeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "StripeInvalidRequestError"
  );
}

function isInvalidRegistrationCode(err: unknown): boolean {
  if (!isStripeInvalidRequest(err)) {
    return false;
  }
  // Stripe does not give this a dedicated `code`; the param is the reliable
  // discriminator for "the code you sent is wrong or already consumed".
  return (err as { param?: unknown }).param === "registration_code";
}

/**
 * Stripe's `balance_insufficient` (docs: "The transfer or payout couldn't be
 * completed because the associated account doesn't have a sufficient balance
 * available") arrives as an `invalid_request_error`. The code alone does NOT
 * say WHOSE balance fell short — it is the same code for a connected account's
 * own payout or a transfer reversal. Which account it means is decided by the
 * CALL, so this predicate is only ever applied inside `createTransfer`, where
 * the funding account is the platform. Do not reuse it on reverseTransfer or
 * any connected-account-scoped call.
 */
function isInsufficientPlatformBalance(err: unknown): boolean {
  if (!isStripeInvalidRequest(err)) {
    return false;
  }
  return (err as { code?: unknown }).code === "balance_insufficient";
}

function isNoActionInProgress(err: unknown): boolean {
  if (!isStripeInvalidRequest(err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return (
    code === "terminal_reader_no_action_in_progress" ||
    code === "terminal_reader_invalid_state"
  );
}

function mapDispute(dispute: Stripe.Dispute): ProcessorDisputeSnapshot {
  const details = dispute.evidence_details;
  return {
    processorDisputeId: dispute.id,
    chargeId:
      typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id,
    paymentIntentId:
      dispute.payment_intent == null
        ? null
        : typeof dispute.payment_intent === "string"
          ? dispute.payment_intent
          : dispute.payment_intent.id,
    // `Stripe.Dispute.Status` is the same literal union as the port's
    // `ProcessorDisputeStatus`; the assignment is checked by tsc, so a new
    // Stripe status shows up here as a compile error rather than a silent
    // pass-through.
    status: dispute.status,
    amountCents: dispute.amount,
    currency: (dispute.currency ?? "").toLowerCase(),
    reason: dispute.reason,
    evidenceDetails: {
      // Stripe: unix seconds → Date.
      dueBy: details?.due_by != null ? new Date(details.due_by * 1000) : null,
      hasEvidence: details?.has_evidence ?? false,
      pastDue: details?.past_due ?? false,
      submissionCount: details?.submission_count ?? 0,
    },
    evidence: fromStripeDisputeEvidence(dispute.evidence),
  };
}

/**
 * Stripe reports an unknown dispute id as `invalid_request_error` with
 * `code: "resource_missing"`. Translate that one case to a typed NOT_FOUND;
 * everything else (auth, rate limit, "dispute not in needs_response") is
 * rethrown as-is for the backstops to capture.
 */
function rethrowDisputeError(err: unknown, processorDisputeId: string): never {
  if (
    isStripeInvalidRequest(err) &&
    (err as { code?: unknown }).code === "resource_missing"
  ) {
    throw fail("NOT_FOUND", {
      message: "dispute not found at processor",
      meta: { processorDisputeId },
      cause: err,
    });
  }
  throw err;
}

/**
 * A Stripe error about a PaymentIntent or SetupIntent can carry the whole
 * object (`err.payment_intent` / `err.setup_intent`, and again under
 * `err.raw`), and the object carries its `client_secret`: the bearer
 * credential for the payment, and an embed guest's only proof that an order
 * is theirs. Callers log these errors whole (`logger.error(msg, { err })`
 * copies own properties) and hand them to Sentry, so the objects are removed
 * HERE, once, for every caller. Mutates and returns `err`; the type, code,
 * message and decline details stay. Never throws.
 *
 * Applied where an error can name an existing PaymentIntent: the cancel and
 * `rethrowPaymentIntentError`. Deliberately not on the creates (neither
 * passes `confirm`, so a failed create has no PaymentIntent to attach) or the
 * refunds. A create that gains `confirm: true` needs it.
 */
function withoutClientSecretCarriers<T>(err: T): T {
  if (typeof err !== "object" || err === null) return err;
  const strip = (target: unknown) => {
    if (typeof target !== "object" || target === null) return;
    for (const key of ["payment_intent", "setup_intent"]) {
      try {
        delete (target as Record<string, unknown>)[key];
      } catch {
        // A frozen error keeps its property; nothing else can be done here.
      }
    }
  };
  strip(err);
  strip((err as { raw?: unknown }).raw);
  return err;
}

/**
 * Stripe reports an unknown PaymentIntent id as `invalid_request_error` with
 * `code: "resource_missing"`. The id comes from a buyer's request
 * (`orders.confirmPayment`), so a typo or a probe is the caller's fault: a
 * typed NOT_FOUND (404) instead of a 500 and a Sentry issue per attempt.
 * Everything else (auth, rate limit, network) is rethrown untouched for the
 * backstops to capture.
 */
function rethrowPaymentIntentError(
  err: unknown,
  paymentIntentId: string,
): never {
  // Before either throw: the NOT_FOUND below carries `err` as its `cause`.
  withoutClientSecretCarriers(err);
  if (
    isStripeInvalidRequest(err) &&
    (err as { code?: unknown }).code === "resource_missing"
  ) {
    throw fail("NOT_FOUND", {
      message: "payment intent not found at processor",
      meta: { paymentIntentId },
      cause: err,
    });
  }
  throw err;
}

/**
 * Stripe refuses to refund a charge that is under dispute with
 * `invalid_request_error` / `code: "charge_disputed"`. Translate that one case
 * to the typed ORDER_DISPUTED_REFUND_BLOCKED so the use case (and the support
 * UI) can explain the refusal; every other error — auth, rate limit,
 * `charge_already_refunded`, network — is rethrown untouched for the backstops.
 */
function rethrowRefundError(err: unknown, paymentIntentId: string): never {
  if (
    isStripeInvalidRequest(err) &&
    (err as { code?: unknown }).code === "charge_disputed"
  ) {
    throw fail("ORDER_DISPUTED_REFUND_BLOCKED", {
      meta: { paymentIntentId },
      cause: err,
    });
  }
  throw err;
}

function extractFeeFromCharge(charge: Stripe.Charge): {
  feeCents: number;
  currency: string;
} {
  const bt = charge.balance_transaction;
  if (!bt) {
    throw new Error("Stripe charge missing balance_transaction");
  }
  if (typeof bt === "string") {
    throw new Error("Stripe charge balance_transaction not expanded");
  }

  // Stripe returns fee in the smallest currency unit.
  const fee = typeof bt.fee === "number" ? bt.fee : Number(bt.fee);
  if (!Number.isFinite(fee)) {
    throw new Error("Stripe balance_transaction fee is not a number");
  }
  return {
    feeCents: Math.max(0, Math.trunc(fee)),
    currency: (bt.currency ?? "").toLowerCase(),
  };
}
