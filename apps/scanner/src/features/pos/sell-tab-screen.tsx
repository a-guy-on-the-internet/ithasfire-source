/**
 * Sell tab wrapper — resolves the Sell screen's data dependencies and
 * conditionally wraps it in <StripeTerminalProvider> when this binary
 * supports Tap to Pay (D-2026-04-26 / spec FR-001).
 *
 * Composition layers:
 *   1. Tap to Pay capability gate (binarySupportsTapToPay):
 *      - true → wrap subtree in <StripeTerminalProvider> with our
 *        connection-token bridge to `pos.connectionToken`.
 *      - false → render bare; the SellScreen still allows CASH sales
 *        (FR-015 — cash works without Stripe).
 *   2. Sellable-items query → SellScreen receives ticketTypes[]
 *   3. SellScreen orchestrates cart → cash/card → result
 *
 * Empty state: if `pos.listSellableItems` returns no rows, SellScreen
 * renders its own empty-state copy.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "@th/ui";

import { trpc } from "../../trpc";
import {
  narrowSessionContext,
  type ScannerSessionContext,
} from "../../features/auth/use-scanner-session";
import { binarySupportsTapToPay } from "../../lib/capabilities";
import {
  Panel,
  ScreenSurface,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { LoadingState } from "../../ui/loading-state";

import { describeSaleState } from "./sale-state";
import { needsScannerTermsAck } from "./scanner-terms-ack";
import { ScannerTermsModal } from "./scanner-terms-modal";
import { SellScreen, type SellScreenProps } from "./sell-screen";

type SellTabScreenProps = {
  eventId: string;
  sessionContext: ScannerSessionContext | null;
};

export function SellTabScreen({ eventId, sessionContext }: SellTabScreenProps) {
  const styles = useThemedSheet(makeSheet);
  const sellable = trpc.pos.listSellableItems.useQuery({ eventId });

  // One idempotency key per SALE (the Sell screen holds it across retries; see
  // sale-attempt.ts). The server scopes it to the operator
  // (`pos:{actorHumanId}:{clientKey}`), so two operators at one door can't
  // collide; the random tail separates two sales by the same operator.
  const newClientKey = useCallback(() => {
    return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }, []);

  // No `as` here: the shape comes from the router. A cast is how a renamed
  // `sellability` field once reached the web till as `undefined` on every tier.
  const ticketTypes: SellScreenProps["ticketTypes"] = useMemo(() => {
    const data = sellable.data;
    if (!data) return [];
    return data.ticketTypes.map((t) => ({
      id: t.ticketTypeId,
      name: t.name,
      unitPriceCents: t.unitPriceCents,
      capacityRemaining: t.capacityRemaining,
      // FR-010: the till already REFUSES an out-of-window tier at sale time
      // (assertTicketTypeOnSale inside startPosSale / recordCashSale). Showing
      // the state here is what turns a fail-closed refusal into something the
      // operator sees BEFORE the customer's card is out.
      saleState: describeSaleState(t.sellability, data.timezone),
    }));
  }, [sellable.data]);
  const currency = sellable.data?.currency ?? "usd";

  // POS attestation entry gate (spec 2026-05-14/pos-attestation): an
  // operator without a current-version scanner-terms ack sees the blocking
  // terms surface INSTEAD of any sell UI. Fails closed when the session
  // context hasn't resolved/narrowed. UX-only — `pos.startSale` and
  // `pos.recordCashSale` re-check server-side. After the ack mutation
  // succeeds, the modal invalidates `scanner.getSessionContext`; the
  // refreshed operator state flips this branch and reveals the sell UI.
  if (needsScannerTermsAck(narrowSessionContext(sessionContext)?.operator)) {
    return <ScannerTermsModal />;
  }

  if (sellable.isLoading) {
    return (
      <ScreenSurface>
        <Panel>
          <LoadingState label="Loading items for sale…" />
          <Text variant="body">Loading sellable items...</Text>
        </Panel>
      </ScreenSurface>
    );
  }

  // Only when there is nothing to show. A failed BACKGROUND refetch (every
  // sale invalidates this list) keeps its data and must not replace the
  // screen: that would wipe the done screen's "Change $X" mid-handover.
  if (sellable.isError && !sellable.data) {
    return (
      <ScreenSurface>
        <Panel>
          <Text variant="body">
            {sellable.error?.message ?? "Couldn't load sellable items."}
          </Text>
        </Panel>
      </ScreenSurface>
    );
  }

  // When the binary supports Tap to Pay, wrap with <StripeTerminalProvider>
  // so `useStripeTerminal()` is available inside the SellScreen subtree.
  // The provider is loaded LAZILY via dynamic import so v1.0 binaries
  // (without the entitlement) never reach the SDK's native init code.
  if (binarySupportsTapToPay()) {
    return (
      <TapToPayCapableShell
        eventId={eventId}
        currency={currency}
        ticketTypes={ticketTypes}
        newClientKey={newClientKey}
      />
    );
  }

  return (
    <View style={styles.root}>
      <SellScreen
        eventId={eventId}
        currency={currency}
        ticketTypes={ticketTypes}
        newClientKey={newClientKey}
      />
    </View>
  );
}

/**
 * Lazily references the Terminal SDK so that requiring `sell-tab-screen.tsx`
 * doesn't pull StripeTerminalProvider into the v1.0 bundle's hot path.
 * Metro still bundles it (we install the dep), but the React provider tree
 * only mounts when the capability gate passes.
 */
function TapToPayCapableShell({
  eventId,
  currency,
  ticketTypes,
  newClientKey,
}: {
  eventId: string;
  currency: string;
  ticketTypes: SellScreenProps["ticketTypes"];
  newClientKey: SellScreenProps["newClientKey"];
}) {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StripeTerminalProvider } =
    require("@stripe/stripe-terminal-react-native") as typeof import("@stripe/stripe-terminal-react-native");

  // Server-supplied Stripe Terminal Location ID. The SDK's tokenProvider
  // is the source of truth — we cache the latest seen value here and
  // pass it down to TapToPaySurface. First render is null; the surface
  // shows a spinner until the first mint completes.
  const [locationId, setLocationId] = useState<string | null>(null);

  const trpcUtils = trpc.useUtils();

  // Stable mutate handle — the SDK re-calls our provider on its own
  // schedule (init + token expiry), not on render, so we keep it
  // outside the React tree's rendering path. Each call also refreshes
  // our cached locationId; the value should never change for a given
  // platform but the cost of re-setting is zero if it doesn't.
  const tokenProvider = useMemo(() => {
    return async () => {
      const out = (await trpcUtils.client.pos.connectionToken.mutate({
        eventId,
      })) as {
        secret: string;
        locationId: string;
      };
      setLocationId(out.locationId);
      return out.secret;
    };
  }, [trpcUtils, eventId]);

  // Eagerly mint once so the operator doesn't sit on a spinner waiting
  // for the SDK to ask for its first token. The SDK will call
  // tokenProvider again on its own schedule for renewals.
  useEffect(() => {
    void tokenProvider().catch(() => {
      // Errors here surface via the SDK's own connection-status events
      // once the user reaches the Tap to Pay surface. No need to retry —
      // the next pull-to-refresh / charge press will re-trigger.
    });
  }, [tokenProvider]);

  return (
    <View style={styles.root}>
      <StripeTerminalProvider tokenProvider={tokenProvider} logLevel="verbose">
        <SellScreen
          eventId={eventId}
          currency={currency}
          ticketTypes={ticketTypes}
          newClientKey={newClientKey}
          tapToPayLocationId={locationId ?? undefined}
        />
      </StripeTerminalProvider>
    </View>
  );
}

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
  });
