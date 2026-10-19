/**
 * The Tap to Pay step sequence, out of the component so it can be tested
 * without the native SDK: initialize → (reuse | discover + connect) →
 * retrieve → collect → confirm → poll the server.
 *
 * Only TYPES come from `@stripe/stripe-terminal-react-native`; the SDK itself
 * arrives through `deps.sdk()` (the hook's latest return value, read through
 * the surface's ref), so vitest never loads the native module.
 *
 * The money rule lives in `phase`. It flips to "confirm-or-later" BEFORE
 * `confirmPaymentIntent` is awaited (and up front, when the PaymentIntent we
 * retrieved has already moved past collection), and every failure (returned
 * or thrown) reads the live value. From that point the copy never says the
 * card wasn't charged, so the operator checks the server before taking cash.
 */
import type {
  ErrorCode,
  PaymentIntent,
  Reader,
  useStripeTerminal,
} from "@stripe/stripe-terminal-react-native";

import type { PosReportContext } from "../../lib/report";

import type { CompletedSale } from "./sale-attempt";
import {
  TERMINAL_ALREADY_CONNECTED,
  describeTerminalFailure,
  isConnectedReader,
  type TerminalPhase,
  type TerminalStep,
} from "./terminal-errors";

export type TerminalSdk = Pick<
  ReturnType<typeof useStripeTerminal>,
  | "initialize"
  | "setSimulatedCard"
  | "getConnectedReader"
  | "discoverReaders"
  | "connectReader"
  | "retrievePaymentIntent"
  | "collectPaymentMethod"
  | "confirmPaymentIntent"
  | "connectedReader"
  | "discoveredReaders"
>;

export type FlowStage =
  | { kind: "initializing" }
  | { kind: "discovering" }
  | { kind: "connecting"; reader: Reader.Type }
  | { kind: "retrieving" }
  | { kind: "collecting" }
  | { kind: "confirming" }
  | { kind: "finalizing"; attempt: number }
  | { kind: "success" }
  | {
      kind: "error";
      message: string;
      recoverable: boolean;
      /** The SDK's error code, shown small under the message for support. */
      code: string | null;
    };

export type FlowStep = TerminalStep;

export type TapToPayFlowInput = {
  clientSecret: string;
  /** Stripe Terminal Location (`tml_…`); missing = a setup gap. */
  locationId: string | undefined;
  merchantDisplayName: string;
  useSimulatedReader: boolean;
  simulatedTestCardNumber?: string;
};

export type TapToPayFlowDeps = {
  /** The hook's LATEST value (it is recreated every render). */
  sdk: () => TerminalSdk;
  isCancelled: () => boolean;
  setStage: (stage: FlowStage) => void;
  /** One read of `pos.completeSale` for this order. */
  fetchOrder: () => Promise<CompletedSale | null | undefined>;
  onSuccess: (sale: CompletedSale) => void;
  /** Wired to `reportPosIssue`; the surface adds the order id. */
  report: (error: Error, context: Omit<PosReportContext, "orderId">) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides for tests. */
  timing?: Partial<typeof DEFAULT_TIMING>;
};

export const DEFAULT_TIMING = {
  pollIntervalMs: 1_000,
  pollMaxAttempts: 30,
  readerWaitMs: 5_000,
  readerPollMs: 100,
};

export const MISSING_LOCATION_MESSAGE =
  "Tap to Pay isn't configured for this environment yet (missing Stripe Terminal Location). Use Cash, or contact support.";
export const NO_READER_MESSAGE =
  "Couldn't find a Tap to Pay reader on this device. Press Back to try again or take cash.";
export const FINALIZE_TIMEOUT_MESSAGE =
  "Charge confirmed but the server hasn't finalised the order yet. The receipt + tickets will arrive shortly — check the orders list.";

/** The status a fresh PaymentIntent has before any card was collected. */
const PRE_COLLECT_STATUS =
  "requiresPaymentMethod" satisfies PaymentIntent.Status;

/** Outcomes of the buyer's card, reported at warning level. */
const BUYER_SIDE_CODES: ReadonlySet<string> = new Set([
  "DECLINED_BY_STRIPE_API",
  "DECLINED_BY_READER",
  "CARD_READ_TIMED_OUT",
] satisfies ErrorCode[]);

type SdkErrorLike = {
  code?: string | null;
  nativeErrorCode?: string | null;
  apiError?: { code?: string | null; declineCode?: string | null } | null;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runTapToPayFlow(
  input: TapToPayFlowInput,
  deps: TapToPayFlowDeps,
): Promise<void> {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const sleep = deps.sleep ?? defaultSleep;
  const sdk = deps.sdk;
  const cancelled = deps.isCancelled;

  let phase: TerminalPhase = "before-confirm";
  let step: FlowStep = "setup";

  /** Report a failure with no SDK error behind it (a timeout, a gap). */
  const reportOwn = (code: string) =>
    deps.report(new TapToPayError(step, code), {
      branch: "tap_to_pay_failed",
      tags: { step, phase, code },
    });

  /** Copy, code line and report for an SDK error, by the LIVE phase. */
  const failWith = (error: SdkErrorLike | null | undefined): void => {
    const failure = describeTerminalFailure(error, phase, step);
    if (failure.report) {
      const code = error?.code || "NO_CODE";
      deps.report(new TapToPayError(step, code), {
        branch: "tap_to_pay_sdk_error",
        // A decline or a slow tap is the buyer's card, not an incident.
        level: BUYER_SIDE_CODES.has(code) ? "warning" : undefined,
        tags: { step, phase, code },
        extra: sdkErrorExtra(error),
      });
    }
    deps.setStage({
      kind: "error",
      message: failure.message,
      recoverable: true,
      code: failure.code,
    });
  };

  if (!input.locationId) {
    reportOwn("MISSING_LOCATION");
    deps.setStage({
      kind: "error",
      message: MISSING_LOCATION_MESSAGE,
      recoverable: false,
      code: null,
    });
    return;
  }

  try {
    // ── Step 0: initialize the native SDK ────────────────────────
    // <StripeTerminalProvider> mounts the bridge but does NOT call
    // Terminal.getInstance() — on Android that fails the first SDK call
    // with "First initialize the Stripe Terminal SDK". `initialize()` is
    // idempotent; safe to repeat on retry.
    step = "initialize";
    deps.setStage({ kind: "initializing" });
    const initResult = await sdk().initialize();
    if (cancelled()) return;
    if (initResult.error) return failWith(initResult.error);

    // Simulator-only: pick which test card the next tap will use. Real
    // readers ignore this.
    if (input.useSimulatedReader && input.simulatedTestCardNumber) {
      await sdk().setSimulatedCard(input.simulatedTestCardNumber);
      if (cancelled()) return;
    }

    // ── Step 1+2: reuse, or discover & connect ──────────────────
    // The native connection outlives this surface, and `discoverReaders`
    // while connected fails ("You must disconnect from reader before
    // discovering readers"). The NATIVE answer decides: the hook's
    // `connectedReader` is React state that lags it both ways (a connect cut
    // short by Back never lands in it; a disconnect while no surface was
    // mounted leaves it stale), and a stale "connected" sends collect into
    // NOT_CONNECTED_TO_READER on every retry. The hook is only the fallback
    // when the native call itself throws.
    step = "reader-check";
    let alreadyConnected: boolean;
    try {
      alreadyConnected = isConnectedReader(await sdk().getConnectedReader());
    } catch {
      alreadyConnected = sdk().connectedReader != null;
    }
    if (cancelled()) return;

    if (!alreadyConnected) {
      step = "discover";
      deps.setStage({ kind: "discovering" });
      const discoverResult = await sdk().discoverReaders({
        discoveryMethod: "tapToPay",
        simulated: input.useSimulatedReader,
      });
      if (cancelled()) return;
      if (discoverResult.error) return failWith(discoverResult.error);

      // The SDK fills `discoveredReaders` over time; for tapToPay there is
      // exactly one (this phone).
      step = "find-reader";
      const reader = await waitForReader(sdk, timing, sleep);
      if (cancelled()) return;
      if (!reader) {
        reportOwn("NO_READER");
        deps.setStage({
          kind: "error",
          message: NO_READER_MESSAGE,
          recoverable: true,
          code: null,
        });
        return;
      }

      step = "connect";
      deps.setStage({ kind: "connecting", reader });
      const connectResult = await sdk().connectReader({
        discoveryMethod: "tapToPay",
        reader,
        locationId: input.locationId,
        merchantDisplayName: input.merchantDisplayName,
      });
      if (cancelled()) return;
      // Connected between our check and the connect: same device, carry on.
      if (
        connectResult.error &&
        connectResult.error.code !== TERMINAL_ALREADY_CONNECTED
      ) {
        return failWith(connectResult.error);
      }
    }

    // ── Step 3: retrieve the PaymentIntent ───────────────────────
    step = "retrieve";
    deps.setStage({ kind: "retrieving" });
    const retrieveResult = await sdk().retrievePaymentIntent(input.clientSecret);
    if (cancelled()) return;
    if (retrieveResult.error) return failWith(retrieveResult.error);
    const intent = retrieveResult.paymentIntent;
    if (!intent) return failWith({ code: "NO_PAYMENT_INTENT" });
    // A PaymentIntent past collection may already be charging (a retry
    // after a confirm we lost track of). Nothing from here may say the card
    // wasn't charged.
    if (intent.status !== PRE_COLLECT_STATUS) phase = "confirm-or-later";

    // ── Step 4: collect (the Tap to Pay native UI shows here) ────
    step = "collect";
    deps.setStage({ kind: "collecting" });
    const collectResult = await sdk().collectPaymentMethod({
      paymentIntent: intent,
      // FR-014: Ithas Fire NEVER prompts for tip. Hard-coded.
      skipTipping: true,
    });
    if (cancelled()) return;
    if (collectResult.error) return failWith(collectResult.error);
    if (!collectResult.paymentIntent) {
      return failWith({ code: "NO_PAYMENT_INTENT" });
    }

    // ── Step 5: confirm ──────────────────────────────────────────
    // The phase flips BEFORE the await: a failure from here on may have
    // come after the card was charged.
    step = "confirm";
    phase = "confirm-or-later";
    deps.setStage({ kind: "confirming" });
    const confirmResult = await sdk().confirmPaymentIntent({
      paymentIntent: collectResult.paymentIntent,
    });
    if (cancelled()) return;
    if (confirmResult.error) return failWith(confirmResult.error);

    // ── Step 6: poll the server for finalisation ─────────────────
    // Stripe's `payment_intent.succeeded` webhook drives finalisation
    // (mints tickets + auto-admits per FR-013).
    step = "finalize";
    for (let attempt = 1; attempt <= timing.pollMaxAttempts; attempt++) {
      if (cancelled()) return;
      deps.setStage({ kind: "finalizing", attempt });
      const sale = await deps.fetchOrder();
      if (cancelled()) return;
      if (sale?.status === "SUCCEEDED") {
        deps.setStage({ kind: "success" });
        deps.onSuccess(sale);
        return;
      }
      await sleep(timing.pollIntervalMs);
    }

    reportOwn("FINALIZE_TIMEOUT");
    deps.setStage({
      kind: "error",
      message: FINALIZE_TIMEOUT_MESSAGE,
      recoverable: false,
      code: null,
    });
  } catch (err) {
    if (cancelled()) return;
    const failure = describeTerminalFailure(null, phase, step);
    // A thrown SDK-shaped object may carry the PaymentIntent (and its client
    // secret): only plain JS errors go to Sentry as they are.
    const reportable =
      err instanceof Error && !("code" in err)
        ? err
        : new TapToPayError(step, "THREW");
    deps.report(reportable, {
      branch: "tap_to_pay_threw",
      tags: { step, phase, code: "THREW" },
    });
    deps.setStage({
      kind: "error",
      message: failure.message,
      recoverable: true,
      code: null,
    });
  }
}

/**
 * A fresh error per failure: the SDK's own error object can carry the
 * PaymentIntent (client secret included), so it never goes to Sentry.
 */
export class TapToPayError extends Error {
  constructor(step: FlowStep, code: string) {
    super(`Tap to Pay ${step} failed: ${code}`);
    this.name = "TapToPayError";
  }
}

/** Classifications only: codes, never the SDK's message. */
function sdkErrorExtra(
  error: SdkErrorLike | null | undefined,
): Record<string, string> | undefined {
  if (!error) return undefined;
  const extra: Record<string, string> = {};
  if (error.nativeErrorCode) extra.nativeErrorCode = String(error.nativeErrorCode);
  if (error.apiError?.code) extra.apiErrorCode = error.apiError.code;
  if (error.apiError?.declineCode) extra.declineCode = error.apiError.declineCode;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

async function waitForReader(
  // A getter, not a snapshot: `discoveredReaders` lands on a LATER render's
  // hook object, which the surface's ref (behind `sdk`) always points at.
  sdk: () => TerminalSdk,
  timing: typeof DEFAULT_TIMING,
  sleep: (ms: number) => Promise<void>,
): Promise<Reader.Type | null> {
  // Counted polls rather than a clock, so a test can drive it with a no-op
  // sleep.
  const polls = Math.ceil(timing.readerWaitMs / timing.readerPollMs);
  for (let i = 0; i < polls; i++) {
    const readers = sdk().discoveredReaders;
    if (readers && readers.length > 0) return readers[0]!;
    await sleep(timing.readerPollMs);
  }
  return null;
}
