/**
 * Stripe Terminal SDK glue.
 *
 * The SDK initialises through `<StripeTerminalProvider>` (a React
 * component), NOT an imperative `initialize()` call. Wrap the Sell-tab
 * subtree in the provider and pass a `tokenProvider` callback that
 * returns a fresh connection token on demand.
 *
 * Example wiring at the Sell screen boundary:
 *
 *   import { StripeTerminalProvider } from "@stripe/stripe-terminal-react-native";
 *   import { createConnectionTokenProvider } from "@/features/pos/terminal-init";
 *   import { binarySupportsTapToPay } from "@/lib/capabilities";
 *
 *   function SellScreenRoot({ eventId }: { eventId: string }) {
 *     if (!binarySupportsTapToPay()) {
 *       return <SellTabUnsupported />;
 *     }
 *     const tokenProvider = useMemo(
 *       () => createConnectionTokenProvider({ trpcClient, eventId }),
 *       [eventId],
 *     );
 *     return (
 *       <StripeTerminalProvider tokenProvider={tokenProvider} logLevel="verbose">
 *         <SellScreen eventId={eventId} />
 *       </StripeTerminalProvider>
 *     );
 *   }
 *
 * Anti-tipping (FR-014):
 *   The Terminal SDK does not have a global "no tipping" toggle — tip
 *   prompts are configured per `collectPaymentMethod` call via
 *   `tipEligibleAmount`. Always pass `tipEligibleAmount: 0` (or
 *   omit + verify the prompt is suppressed) at the call site. The
 *   anti-tipping disclosure on the Sell screen footer is rendered
 *   regardless via the `pos.noTipDisclosure` i18n key.
 */
/**
 * Imperative caller for `pos.connectionToken`. The Sell-screen wiring
 * supplies this — typically by spreading the existing tRPC client:
 *
 *   const mintConnectionToken = (input: { eventId: string }) =>
 *     trpcClient.pos.connectionToken.mutate(input);
 *
 * Kept as a plain function-shape (not a TRPCClient<AppRouter> reference)
 * so this module doesn't pull the entire AppRouter type tree into the
 * Sell-tab bundle.
 */
export type MintConnectionToken = (input: { eventId: string }) => Promise<{
  secret: string;
}>;

export type CreateConnectionTokenProviderArgs = {
  mintConnectionToken: MintConnectionToken;
  /** The event the operator is currently selling for. */
  eventId: string;
};

/**
 * Builds a `tokenProvider` callback for `<StripeTerminalProvider>`.
 *
 * The SDK calls the returned function on init and on token renewal.
 * On the wire it goes:
 *   SDK → provider → tRPC `pos.connectionToken` → server use case
 *      → `payments.createTerminalConnectionToken` → Stripe → secret
 *
 * The secret is short-lived (Stripe default ~5 min); the SDK is
 * responsible for asking for a new one before expiry.
 *
 * Errors propagate to the SDK as Promise rejections — the SDK surfaces
 * them via its own connection-status events. We add no extra retry
 * here; the use case already throws the canonical `forbidden` /
 * `invalid_input` codes that the UI can map to user-facing messages.
 */
export function createConnectionTokenProvider(
  args: CreateConnectionTokenProviderArgs,
): () => Promise<string> {
  return async () => {
    const result = await args.mintConnectionToken({ eventId: args.eventId });
    return result.secret;
  };
}
