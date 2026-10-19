/**
 * TapToPaySurface — the actual Stripe Terminal collection flow.
 *
 * State machine:
 *   discovering → connecting → ready → collecting → confirming → finalizing → success
 *                                                                          ↘ error
 *
 * The step sequence (and the "was the card charged?" phase that decides
 * the error copy) lives in `tap-to-pay-flow.ts`, where it is tested
 * without the native SDK; this file renders its stages.
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
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useStripeTerminal } from "@stripe/stripe-terminal-react-native";

import { Text } from "@th/ui";

import { getAppEnv } from "../../lib/capabilities";
import { reportPosIssue } from "../../lib/report";
import { trpc } from "../../trpc";
import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";
import { LoadingState } from "../../ui/loading-state";

import type { CompletedSale } from "./sale-attempt";
import { SupportNotice } from "./sale-notices";
import { formatMoney } from "./sell-quote";
import {
  DEFAULT_TIMING,
  runTapToPayFlow,
  type FlowStage,
} from "./tap-to-pay-flow";

type Stage = FlowStage;

export type TapToPaySurfaceProps = {
  orderId: string;
  clientSecret: string;
  /** What the reader asks for: `startSale.amountCents`, the server's charge. */
  amountCents: number;
  /**
   * The card total the quote showed before the sale started, or null when
   * there was none. When it differs from `amountCents` the screen says so
   * before the buyer taps.
   */
  quotedCents: number | null;
  currency: string;
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
  /** Called with the server's read of the order once it is SUCCEEDED. */
  onSuccess: (sale: CompletedSale) => void;
  /** Called when the operator backs out before completing. */
  onCancel: () => void;
};


export function TapToPaySurface({
  orderId,
  clientSecret,
  amountCents,
  quotedCents,
  currency,
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
      cancelInFlight(sdkRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function runFlow() {
    return runTapToPayFlow(
      {
        clientSecret,
        locationId,
        merchantDisplayName,
        // Stripe blocks the production Tap to Pay reader when Android
        // Developer Options is enabled (common on test devices used with
        // `adb`). Non-prod builds use the simulated reader so preview and
        // development builds can still drive the flow.
        useSimulatedReader: getAppEnv() !== "production",
        simulatedTestCardNumber,
      },
      {
        sdk: () => sdkRef.current,
        isCancelled: () => cancelledRef.current,
        setStage,
        fetchOrder: async () => (await completeQuery.refetch()).data,
        onSuccess,
        report: (error, context) => {
          if (__DEV__) {
            console.warn(`[tap-to-pay] ${error.message}`, context.tags);
          }
          reportPosIssue(error, { ...context, orderId });
        },
      },
    );
  }

  const handleCancel = () => {
    cancelledRef.current = true;
    cancelInFlight(sdkRef.current);
    onCancel();
  };

  // The reader asks for the server's number. If that moved after the
  // operator read the quote out, the buyer is about to tap for a total nobody
  // told them. No cause is given: a tax rate update is one, a price or fee
  // change is another, and the screen can't tell which.
  const moved = quotedCents !== null && quotedCents !== amountCents;

  return (
    <View style={styles.root} testID="sell-tap-to-pay-surface">
      <Text style={styles.amount}>{formatMoney(amountCents, currency)}</Text>
      {moved && (
        <SupportNotice testID="sell-tap-to-pay-total-moved">
          The total changed since the quote. The reader is asking for{" "}
          {formatMoney(amountCents, currency)}. Tell the buyer before they
          tap.
        </SupportNotice>
      )}
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
        return `Finalising order… (${stage.attempt}/${DEFAULT_TIMING.pollMaxAttempts})`;
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
      <View style={styles.errorBlock}>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, { color: colors.dangerSoft }]}
          testID="sell-tap-to-pay-status"
        >
          {message}
        </Text>
        {/* The SDK's code (never its message), for whoever the operator
            asks for help. */}
        {stage.code !== null && (
          <Text
            variant="caption"
            color={colors.colorMuted}
            style={styles.errorCode}
            testID="sell-tap-to-pay-error-code"
          >
            Reader code: {stage.code}
          </Text>
        )}
      </View>
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

/**
 * Stop whatever the reader is doing. Each cancel rejects when the SDK isn't
 * initialized yet (Back during "Starting the card reader…"); there is then
 * nothing to cancel, and an unhandled rejection would only be Sentry noise.
 */
function cancelInFlight(sdk: ReturnType<typeof useStripeTerminal> | undefined) {
  sdk?.cancelDiscovering().catch(() => {});
  sdk?.cancelCollectPaymentMethod().catch(() => {});
  sdk?.cancelConfirmPaymentIntent().catch(() => {});
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
    // An explicit lineHeight: `@th/ui` Text's default body line box (24pt)
    // clips 56pt digits. Same ratio as the other big amounts in this folder.
    amount: {
      fontSize: 56,
      lineHeight: 66,
      fontWeight: "800",
      color: colors.color,
      fontVariant: ["tabular-nums"],
    },
    body: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
    status: { fontSize: 18, textAlign: "center", color: colors.color },
    errorBlock: { alignItems: "center", gap: 12 },
    errorCode: { textAlign: "center", fontVariant: ["tabular-nums"] },
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
