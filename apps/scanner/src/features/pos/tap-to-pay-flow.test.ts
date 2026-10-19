import { describe, expect, it, vi } from "vitest";

import type { CompletedSale } from "./sale-attempt";
import {
  FINALIZE_TIMEOUT_MESSAGE,
  MISSING_LOCATION_MESSAGE,
  TapToPayError,
  runTapToPayFlow,
  type FlowStage,
  type TapToPayFlowDeps,
  type TapToPayFlowInput,
  type TerminalSdk,
} from "./tap-to-pay-flow";
import {
  READER_CANCELLED_MESSAGE,
  READER_STOPPED_MAYBE_CHARGED_MESSAGE,
  READER_STOPPED_MESSAGE,
  READER_UNAVAILABLE_MESSAGE,
} from "./terminal-errors";

const READER = { serialNumber: "ttp_1" };
const INTENT = { id: "pi_1", status: "requiresPaymentMethod" };
const SECRET = "pi_1_secret_DO_NOT_REPORT";

type Overrides = Partial<Record<keyof TerminalSdk, unknown>>;

/** A connected-and-happy SDK; each test breaks one step. */
function fakeSdk(over: Overrides = {}) {
  const sdk = {
    connectedReader: undefined,
    discoveredReaders: [READER],
    initialize: vi.fn(async () => ({})),
    setSimulatedCard: vi.fn(async () => ({})),
    getConnectedReader: vi.fn(async () => READER),
    discoverReaders: vi.fn(async () => ({})),
    connectReader: vi.fn(async () => ({ reader: READER })),
    retrievePaymentIntent: vi.fn(async () => ({ paymentIntent: INTENT })),
    collectPaymentMethod: vi.fn(async () => ({
      paymentIntent: { ...INTENT, status: "requiresConfirmation" },
    })),
    confirmPaymentIntent: vi.fn(async () => ({
      paymentIntent: { ...INTENT, status: "succeeded" },
    })),
    ...over,
  };
  return sdk;
}

function run(
  sdk: ReturnType<typeof fakeSdk>,
  input: Partial<TapToPayFlowInput> = {},
  deps: Partial<TapToPayFlowDeps> = {},
) {
  const stages: FlowStage[] = [];
  const report = vi.fn();
  const onSuccess = vi.fn();
  const fetchOrder = vi.fn(
    async () => ({ orderId: "ord_1", status: "SUCCEEDED" }) as CompletedSale,
  );
  const done = runTapToPayFlow(
    {
      clientSecret: SECRET,
      locationId: "tml_1",
      merchantDisplayName: "Ithas Fire",
      useSimulatedReader: true,
      ...input,
    },
    {
      sdk: () => sdk as unknown as TerminalSdk,
      isCancelled: () => false,
      setStage: (stage) => stages.push(stage),
      fetchOrder,
      onSuccess,
      report,
      sleep: async () => {},
      ...deps,
    },
  );
  return {
    done,
    stages,
    report,
    onSuccess,
    fetchOrder,
    last: () => stages[stages.length - 1],
  };
}

const sdkError = (code: string) => ({
  error: {
    code,
    message: "SDK words the operator must not read",
    nativeErrorCode: "2020",
    // The SDK attaches the intent (client secret included) to some errors.
    paymentIntent: { ...INTENT, clientSecret: SECRET },
  },
});

describe("runTapToPayFlow — the happy path", () => {
  it("collects, confirms and hands over the finalised sale", async () => {
    const sdk = fakeSdk();
    const r = run(sdk);
    await r.done;
    expect(r.last()).toEqual({ kind: "success" });
    expect(r.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SUCCEEDED" }),
    );
    expect(sdk.collectPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ skipTipping: true }),
    );
    expect(r.report).not.toHaveBeenCalled();
  });
});

describe("runTapToPayFlow — was the card charged?", () => {
  it("says a reader cancel during collect left the card uncharged, and reports nothing", async () => {
    const r = run(
      fakeSdk({ collectPaymentMethod: vi.fn(async () => sdkError("CANCELED")) }),
    );
    await r.done;
    expect(r.last()).toMatchObject({
      kind: "error",
      message: READER_CANCELLED_MESSAGE,
      code: null,
    });
    expect(r.report).not.toHaveBeenCalled();
  });

  it("never says 'not charged' when confirm comes back CANCELED", async () => {
    const r = run(
      fakeSdk({ confirmPaymentIntent: vi.fn(async () => sdkError("CANCELED")) }),
    );
    await r.done;
    expect(r.last()).toMatchObject({
      kind: "error",
      message: READER_STOPPED_MAYBE_CHARGED_MESSAGE,
      code: "CANCELED",
    });
    expect(r.report).toHaveBeenCalledTimes(1);
    expect(r.report.mock.calls[0]![1]).toMatchObject({
      branch: "tap_to_pay_sdk_error",
      tags: { step: "confirm", phase: "confirm-or-later", code: "CANCELED" },
    });
  });

  it("never says 'not charged' when confirm throws", async () => {
    const r = run(
      fakeSdk({
        confirmPaymentIntent: vi.fn(async () => {
          throw new TypeError("bridge went away");
        }),
      }),
    );
    await r.done;
    expect(r.last()).toMatchObject({
      kind: "error",
      message: READER_STOPPED_MAYBE_CHARGED_MESSAGE,
    });
    expect(r.report.mock.calls[0]![1]).toMatchObject({
      branch: "tap_to_pay_threw",
      tags: { step: "confirm", phase: "confirm-or-later" },
    });
  });

  it("treats a retrieved intent that is past collection as maybe charged", async () => {
    const r = run(
      fakeSdk({
        retrievePaymentIntent: vi.fn(async () => ({
          paymentIntent: { ...INTENT, status: "requiresConfirmation" },
        })),
        collectPaymentMethod: vi.fn(async () => sdkError("CANCELED")),
      }),
    );
    await r.done;
    expect(r.last()).toMatchObject({
      message: READER_STOPPED_MAYBE_CHARGED_MESSAGE,
    });
    expect(r.report).toHaveBeenCalledTimes(1);
  });

  it("keeps a throw before confirm on the 'before the card was charged' copy", async () => {
    const r = run(
      fakeSdk({
        collectPaymentMethod: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    );
    await r.done;
    expect(r.last()).toMatchObject({ message: READER_STOPPED_MESSAGE });
    expect(r.report.mock.calls[0]![1]).toMatchObject({
      tags: { step: "collect", phase: "before-confirm" },
    });
  });
});

describe("runTapToPayFlow — reporting", () => {
  it("reports a pre-confirm failure that isn't a cancel, with the code on screen", async () => {
    const r = run(
      fakeSdk({
        initialize: vi.fn(async () => sdkError("TAP_TO_PAY_DEBUG_NOT_SUPPORTED")),
      }),
    );
    await r.done;
    expect(r.last()).toMatchObject({
      kind: "error",
      message: READER_UNAVAILABLE_MESSAGE,
      code: "TAP_TO_PAY_DEBUG_NOT_SUPPORTED",
    });
    expect(r.report).toHaveBeenCalledTimes(1);
    const [error, context] = r.report.mock.calls[0]!;
    expect(context).toEqual({
      branch: "tap_to_pay_sdk_error",
      tags: {
        step: "initialize",
        phase: "before-confirm",
        code: "TAP_TO_PAY_DEBUG_NOT_SUPPORTED",
      },
      extra: { nativeErrorCode: "2020" },
    });
    // A fresh error: never the SDK's object (it can carry the client secret)
    // and never its message.
    const sent = JSON.stringify([String(error), error, context]);
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain("SDK words");
  });

  it("reports a connect failure from a bad Location as no-retry", async () => {
    const r = run(
      fakeSdk({
        getConnectedReader: vi.fn(async () => null),
        connectReader: vi.fn(async () => sdkError("INVALID_REQUIRED_PARAMETER")),
      }),
    );
    await r.done;
    expect(r.last()).toMatchObject({
      message: READER_UNAVAILABLE_MESSAGE,
      code: "INVALID_REQUIRED_PARAMETER",
    });
    expect(r.report.mock.calls[0]![1]).toMatchObject({
      tags: { step: "connect", phase: "before-confirm" },
    });
  });

  it("reports a missing Location and a server that never finalises", async () => {
    const missing = run(fakeSdk(), { locationId: undefined });
    await missing.done;
    expect(missing.last()).toMatchObject({ message: MISSING_LOCATION_MESSAGE });
    expect(missing.report.mock.calls[0]![1]).toMatchObject({
      tags: { code: "MISSING_LOCATION" },
    });

    const slow = run(fakeSdk(), {}, {
      fetchOrder: vi.fn(async () => undefined),
      timing: { pollMaxAttempts: 2 },
    });
    await slow.done;
    expect(slow.last()).toMatchObject({ message: FINALIZE_TIMEOUT_MESSAGE });
    expect(slow.report.mock.calls[0]![1]).toMatchObject({
      tags: { step: "finalize", phase: "confirm-or-later", code: "FINALIZE_TIMEOUT" },
    });
  });
});

describe("runTapToPayFlow — CANCELED outside collect", () => {
  it("shows the stop copy and reports a CANCELED from connect (iOS terms sheet dismissed)", async () => {
    const r = run(
      fakeSdk({
        getConnectedReader: vi.fn(async () => null),
        connectReader: vi.fn(async () => sdkError("CANCELED")),
      }),
    );
    await r.done;
    expect(r.last()).toMatchObject({
      kind: "error",
      message: READER_STOPPED_MESSAGE,
      code: "CANCELED",
    });
    expect(r.report).toHaveBeenCalledTimes(1);
    expect(r.report.mock.calls[0]![1]).toMatchObject({
      tags: { step: "connect", phase: "before-confirm", code: "CANCELED" },
    });
  });
});

describe("runTapToPayFlow — what reaches Sentry", () => {
  it("sends a thrown SDK-shaped object only as a TapToPayError, secret-free", async () => {
    for (const thrown of [
      // A plain object, and an Error carrying the SDK's fields.
      { code: "UNEXPECTED_SDK_ERROR", paymentIntent: { clientSecret: SECRET } },
      Object.assign(new Error(`failed for ${SECRET}`), {
        code: "UNEXPECTED_SDK_ERROR",
        paymentIntent: { clientSecret: SECRET },
      }),
    ]) {
      const r = run(
        fakeSdk({
          collectPaymentMethod: vi.fn(async () => {
            throw thrown;
          }),
        }),
      );
      await r.done;
      expect(r.report).toHaveBeenCalledTimes(1);
      const [error, context] = r.report.mock.calls[0]!;
      expect(error).toBeInstanceOf(TapToPayError);
      expect(error).not.toBe(thrown);
      expect(context).toMatchObject({
        branch: "tap_to_pay_threw",
        tags: { step: "collect", code: "THREW" },
      });
      const sent = JSON.stringify([String(error), (error as Error).stack, context]);
      expect(sent).not.toContain(SECRET);
    }
  });

  it("reports a declined card at warning level, an SDK fault at the default", async () => {
    const declined = run(
      fakeSdk({ confirmPaymentIntent: vi.fn(async () => sdkError("DECLINED_BY_STRIPE_API")) }),
    );
    await declined.done;
    expect(declined.report.mock.calls[0]![1]).toMatchObject({ level: "warning" });

    const fault = run(
      fakeSdk({ initialize: vi.fn(async () => sdkError("UNEXPECTED_SDK_ERROR")) }),
    );
    await fault.done;
    expect(fault.report.mock.calls[0]![1].level).toBeUndefined();
  });
});

describe("runTapToPayFlow — reader reuse", () => {
  it("connects when native says no reader, even though the hook says connected", async () => {
    const sdk = fakeSdk({
      connectedReader: READER,
      getConnectedReader: vi.fn(async () => ({})),
    });
    const r = run(sdk);
    await r.done;
    expect(sdk.discoverReaders).toHaveBeenCalledTimes(1);
    expect(sdk.connectReader).toHaveBeenCalledTimes(1);
    expect(r.last()).toEqual({ kind: "success" });
  });

  it("skips discovery when native says connected, even though the hook says no", async () => {
    const sdk = fakeSdk({ connectedReader: undefined });
    const r = run(sdk);
    await r.done;
    expect(sdk.discoverReaders).not.toHaveBeenCalled();
    expect(r.last()).toEqual({ kind: "success" });
  });

  it("falls back to the hook only when the native call throws", async () => {
    const sdk = fakeSdk({
      connectedReader: READER,
      getConnectedReader: vi.fn(async () => {
        throw new Error("not initialized");
      }),
    });
    const r = run(sdk);
    await r.done;
    expect(sdk.discoverReaders).not.toHaveBeenCalled();
    expect(r.last()).toEqual({ kind: "success" });
  });

  it("carries on when connect says the reader is already connected", async () => {
    const sdk = fakeSdk({
      getConnectedReader: vi.fn(async () => null),
      connectReader: vi.fn(async () => sdkError("ALREADY_CONNECTED_TO_READER")),
    });
    const r = run(sdk);
    await r.done;
    expect(r.last()).toEqual({ kind: "success" });
    expect(r.report).not.toHaveBeenCalled();
  });
});
