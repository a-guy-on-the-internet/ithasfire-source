/**
 * TapToPaySurface — the actual Stripe Terminal collection flow.
 *
 * State machine:
 *   discovering → connecting → ready → collecting → confirming → finalizing → success
 *                                                                          ↘ error
 *
 * This file is ONLY mounted when:
 *   - `binarySupportsTapToPay()` is true (entitlement declared at build)
 *   - The parent has wrapped us in <StripeTerminalProvider>
 *
 * Anti-tipping (FR-014):
 *   `collectPaymentMethod({ skipTipping: true })`. Stripe Terminal does
 *   not have a global "no tipping" toggle — it's per-call. Hard-coded
 *   here, never plumbed as a prop.
 *
 * Anti-double-charge:
 *   The PaymentIntent is created server-side by `pos.startSale` BEFORE
 *   this component mounts. We retrieve it by clientSecret, collect a
 *   payment method, then confirm. Idempotency lives at the order layer
 *   (server-side `pos:{actorHumanId}:{clientKey}` key).
 *
 * Locations (Stripe Terminal requirement):
 *   Tap to Pay requires a `locationId` (a Stripe Terminal Location
 *   object). For the SCT charge model (D-2026-04-26) the Location lives
 *   on the PLATFORM account, not the connected account. Provisioning a
 *   default per-environment Location is a one-time setup job — see the
 *   `locationId` prop comment for the path forward.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import {
  useStripeTerminal,
  type Reader,
  type StripeError,
} from "@stripe/stripe-terminal-react-native";

import { Text } from "@th/ui";

import { getAppEnv } from "../../lib/capabilities";
import { trpc } from "../../trpc";
import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";
import { LoadingState } from "../../ui/loading-state";

type Stage =
  | { kind: "initializing" }
  | { kind: "discovering" }
  | { kind: "connecting"; reader: Reader.Type }
  | { kind: "retrieving" }
  | { kind: "collecting" }
  | { kind: "confirming" }
  | { kind: "finalizing"; attempt: number }
  | { kind: "success" }
  | { kind: "error"; message: string; recoverable: boolean };

export type TapToPaySurfaceProps = {
  orderId: string;
  clientSecret: string;
  amountCents: number;
  /**
   * Stripe Terminal Location ID (`tml_...`) on the platform account.
   * Required by the SDK for Tap to Pay. When omitted, the surface
   * surfaces a clear configuration error so the operator knows it's a
   * setup gap, not a card problem.
   *
   * TODO(infra): provision a per-environment default Location and
   * thread it via env / `extra.tapToPayLocationId` in app.config.ts.
   */
  locationId?: string;
  /** Display name shown on the Tap to Pay native UI. */
  merchantDisplayName?: string;
  /**
   * Non-production only: which Stripe test PAN the simulator should
   * "tap" before `collectPaymentMethod`. Ignored when the real reader
   * is in use (i.e. production builds, or any build where
   * `useSimulatedReader` resolves to false). Threaded through from
   * SellScreen so operators can exercise decline / insufficient-funds
   * branches without rebuilding.
   */
  simulatedTestCardNumber?: string;
  /** Called when the order finalises (status SUCCEEDED). */
  onSuccess: (orderId: string) => void;
  /** Called when the operator backs out before completing. */
  onCancel: () => void;
};

const COMPLETE_POLL_INTERVAL_MS = 1_000;
const COMPLETE_POLL_MAX_ATTEMPTS = 30;

export function TapToPaySurface({
  orderId,
  clientSecret,
  amountCents,
  locationId,
  merchantDisplayName = "Ithas Fire",
  simulatedTestCardNumber,
  onSuccess,
  onCancel,
}: TapToPaySurfaceProps) {
  const styles = useThemedSheet(makeSheet);
  const [stage, setStage] = useState<Stage>({ kind: "initializing" });
  const completeQuery = trpc.pos.completeSale.useQuery(
    { orderId },
    { enabled: false, retry: false },
  );

  // Stable handle to the SDK's actions. The hook returns new function
  // references on every render — we capture them in refs to avoid
  // re-running the effect-driven state machine on every keystroke.
  const sdk = useStripeTerminal();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;

  // One-shot run guard: the state machine is launched in a useEffect
  // and must not re-enter on re-renders.
  const startedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runFlow();

    return () => {
      cancelledRef.current = true;
      // Best-effort cleanup; the SDK cancels in-flight ops cleanly.
      void sdkRef.current?.cancelDiscovering();
      void sdkRef.current?.cancelCollectPaymentMethod();
      void sdkRef.current?.cancelConfirmPaymentIntent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runFlow() {
    if (!locationId) {
      setStage({
        kind: "error",
        message:
          "Tap to Pay isn't configured for this environment yet (missing Stripe Terminal Location). Use Cash, or contact support.",
        recoverable: false,
      });
      return;
    }

    try {
      // ── Step 0: initialize the native SDK ────────────────────────
      // <StripeTerminalProvider> mounts the bridge but does NOT call
      // Terminal.getInstance() — on Android that fails the first SDK
      // call with "First initialize the Stripe Terminal SDK". Calling
      // `initialize()` is idempotent; safe to repeat on retry.
      setStage({ kind: "initializing" });
      const initResult = await sdkRef.current.initialize();
      if (cancelledRef.current) return;
      if (initResult.error) {
        setStage(errorFromStripe(initResult.error, true));
        return;
      }

      // Stripe blocks the production Tap to Pay reader when Android
      // Developer Options is enabled (common on test devices used
      // with `adb`). Fall back to the simulated reader for non-prod
      // builds so preview/development APKs can still drive the flow.
      const useSimulatedReader = getAppEnv() !== "production";

      // Simulator-only: pick which test card the next tap will use.
      // Stripe's default is 4242 (Visa, success); operators can pick
      // a decline / insufficient-funds PAN from the SellScreen dev
      // picker to exercise error branches. Real readers ignore this.
      if (useSimulatedReader && simulatedTestCardNumber) {
        await sdkRef.current.setSimulatedCard(simulatedTestCardNumber);
        if (cancelledRef.current) return;
      }

      // ── Step 1+2: discover & connect ─────────────────────────────
      // The Terminal SDK keeps its native connection alive across this
      // component unmounting (StripeTerminalProvider is mounted higher
      // up). On a second sale we may still be connected to the
      // previous reader — calling `discoverReaders` in that state
      // errors with "You must disconnect from reader before
      // discovering readers." Reuse the existing connection instead;
      // it's the same device.
      const alreadyConnected = sdkRef.current.connectedReader;
      if (!alreadyConnected) {
        setStage({ kind: "discovering" });
        const discoverResult = await sdkRef.current.discoverReaders({
          discoveryMethod: "tapToPay",
          simulated: useSimulatedReader,
        });
        if (cancelledRef.current) return;
        if (discoverResult.error) {
          setStage(errorFromStripe(discoverResult.error, true));
          return;
        }

        // The SDK populates `discoveredReaders` over time; for tapToPay
        // there is exactly one (the local device). Wait briefly if needed.
        const reader = await waitForReader(() => sdkRef.current, 5_000);
        if (cancelledRef.current) return;
        if (!reader) {
          setStage({
            kind: "error",
            message: "Couldn't find a Tap to Pay reader on this device.",
            recoverable: true,
          });
          return;
        }

        setStage({ kind: "connecting", reader });
        const connectResult = await sdkRef.current.connectReader({
          discoveryMethod: "tapToPay",
          reader,
          locationId,
          merchantDisplayName,
        });
        if (cancelledRef.current) return;
        if (connectResult.error) {
          setStage(errorFromStripe(connectResult.error, true));
          return;
        }
      }

      // ── Step 3: retrieve PI from server-side clientSecret ────────
      setStage({ kind: "retrieving" });
      const retrieveResult =
        await sdkRef.current.retrievePaymentIntent(clientSecret);
      if (cancelledRef.current) return;
      if (retrieveResult.error || !retrieveResult.paymentIntent) {
        setStage(
          retrieveResult.error
            ? errorFromStripe(retrieveResult.error, true)
            : {
                kind: "error",
                message: "Couldn't load the payment intent.",
                recoverable: true,
              },
        );
        return;
      }

      // ── Step 4: collect (the Tap to Pay native UI surfaces here) ─
      setStage({ kind: "collecting" });
      const collectResult = await sdkRef.current.collectPaymentMethod({
        paymentIntent: retrieveResult.paymentIntent,
        // FR-014: Ithas Fire NEVER prompts for tip. Hard-coded.
        skipTipping: true,
      });
      if (cancelledRef.current) return;
      if (collectResult.error || !collectResult.paymentIntent) {
        setStage(
          collectResult.error
            ? errorFromStripe(collectResult.error, true)
            : {
                kind: "error",
                message: "Card collection cancelled.",
                recoverable: true,
              },
        );
        return;
      }

      // ── Step 5: confirm ──────────────────────────────────────────
      setStage({ kind: "confirming" });
      const confirmResult = await sdkRef.current.confirmPaymentIntent({
        paymentIntent: collectResult.paymentIntent,
      });
      if (cancelledRef.current) return;
      if (confirmResult.error) {
        setStage(errorFromStripe(confirmResult.error, true));
        return;
      }

      // ── Step 6: poll the server for finalisation ────────────────
      // Stripe's `payment_intent.succeeded` webhook drives our
      // finalize-from-payment-intent (which mints tickets + auto-admits
      // per FR-013). We poll `pos.completeSale` until status SUCCEEDED.
      for (let attempt = 1; attempt <= COMPLETE_POLL_MAX_ATTEMPTS; attempt++) {
        if (cancelledRef.current) return;
        setStage({ kind: "finalizing", attempt });
        const result = await completeQuery.refetch();
        if (cancelledRef.current) return;
        const data = result.data as { status?: string } | undefined;
        if (data?.status === "SUCCEEDED") {
          setStage({ kind: "success" });
          onSuccess(orderId);
          return;
        }
        await sleep(COMPLETE_POLL_INTERVAL_MS);
      }

      setStage({
        kind: "error",
        message:
          "Charge confirmed but the server hasn't finalised the order yet. The receipt + tickets will arrive shortly — check the orders list.",
        recoverable: false,
      });
    } catch (err) {
      if (cancelledRef.current) return;
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Tap to Pay failed.",
        recoverable: true,
      });
    }
  }

  const handleCancel = () => {
    cancelledRef.current = true;
    void sdkRef.current?.cancelDiscovering();
    void sdkRef.current?.cancelCollectPaymentMethod();
    void sdkRef.current?.cancelConfirmPaymentIntent();
    onCancel();
  };

  return (
    <View style={styles.root} testID="sell-tap-to-pay-surface">
      <Text style={styles.amount}>${(amountCents / 100).toFixed(2)}</Text>
      <View style={styles.body}>
        <StageView stage={stage} />
      </View>
      <Pressable
        onPress={handleCancel}
        style={styles.cancel}
        testID="sell-tap-to-pay-cancel"
        disabled={stage.kind === "success"}
        accessibilityRole="button"
        accessibilityLabel={
          stage.kind === "error" && stage.recoverable
            ? "Back"
            : "Cancel Tap to Pay"
        }
      >
        <Text style={styles.cancelText}>
          {stage.kind === "error" && stage.recoverable ? "Back" : "Cancel"}
        </Text>
      </Pressable>
    </View>
  );
}

function StageView({ stage }: { stage: Stage }) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const message = useMemo(() => {
    switch (stage.kind) {
      case "initializing":
        return "Starting the card reader…";
      case "discovering":
        return "Looking for a Tap to Pay reader…";
      case "connecting":
        return "Connecting to reader…";
      case "retrieving":
        return "Preparing the charge…";
      case "collecting":
        return "Hold the card to the back of the phone.";
      case "confirming":
        return "Confirming payment…";
      case "finalizing":
        return `Finalising order… (${stage.attempt}/${COMPLETE_POLL_MAX_ATTEMPTS})`;
      case "success":
        return "Charged.";
      case "error":
        return stage.message;
    }
  }, [stage]);

  const announcedMessage =
    stage.kind === "finalizing" ? "Finalising order." : message;

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(announcedMessage);
  }, [announcedMessage]);

  if (stage.kind === "success") {
    return (
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.status, { color: colors.success }]}
        testID="sell-tap-to-pay-status"
      >
        ✓ {message}
      </Text>
    );
  }

  if (stage.kind === "error") {
    return (
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.status, { color: colors.dangerSoft }]}
        testID="sell-tap-to-pay-status"
      >
        {message}
      </Text>
    );
  }

  return (
    <View style={{ alignItems: "center", gap: 12 }}>
      <LoadingState size={140} />
      <Text
        accessibilityLiveRegion="polite"
        style={styles.status}
        testID="sell-tap-to-pay-status"
      >
        {message}
      </Text>
    </View>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function errorFromStripe(error: StripeError, recoverable: boolean): Stage {
  return {
    kind: "error",
    message: error.message ?? `Stripe error: ${error.code ?? "unknown"}`,
    recoverable,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReader(
  // The hook return value is recreated on every render, so we need a
  // getter that resolves through the parent's ref. Reading `.discoveredReaders`
  // off a captured snapshot returns the array from the moment the polling
  // started — even though `didUpdateDiscoveredReaders` has since populated
  // a new array on the latest render's hook object.
  getSdk: () => ReturnType<typeof useStripeTerminal>,
  timeoutMs: number,
): Promise<Reader.Type | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readers = getSdk().discoveredReaders;
    if (readers && readers.length > 0) return readers[0]!;
    await sleep(100);
  }
  return null;
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      paddingVertical: 32,
      paddingHorizontal: 24,
      alignItems: "center",
      gap: 32,
    },
    amount: { fontSize: 56, fontWeight: "800", color: colors.color },
    body: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
    status: { fontSize: 18, textAlign: "center", color: colors.color },
    cancel: {
      minHeight: 52,
      paddingVertical: 14,
      paddingHorizontal: 24,
      borderRadius: 0,
      borderWidth: 2,
      borderColor: colors.borderColor,
      minWidth: 160,
      alignItems: "center",
      justifyContent: "center",
    },
    cancelText: { fontSize: 16, fontWeight: "600", color: colors.color },
  });
