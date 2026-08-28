import { useEffect, type ReactElement } from "react";
import { StripeProvider } from "@stripe/stripe-react-native";

import { getStripePublishableKey } from "@/lib/capabilities";

/**
 * Apple Pay merchant identifier. Must match the merchant ID registered in
 * the Apple developer portal and the `@stripe/stripe-react-native` plugin
 * config in app.config.ts.
 */
export const STRIPE_MERCHANT_IDENTIFIER = "merchant.com.ithasfire";

/**
 * Mounts Stripe's <StripeProvider> when a publishable key is baked into the
 * build (EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY → app.config.ts `extra`).
 *
 * When the key is absent — common in local dev — children render without the
 * provider: the app stays fully usable, payments are simply unavailable.
 * Never throws or crashes over a missing key.
 */
export function PaymentsProvider({ children }: { children: ReactElement }) {
  const publishableKey = getStripePublishableKey();

  useEffect(() => {
    if (!publishableKey) {
      // eslint-disable-next-line no-console
      console.warn(
        "[payments] EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set; " +
          "rendering without StripeProvider — checkout will be unavailable.",
      );
    }
  }, [publishableKey]);

  if (!publishableKey) {
    return children;
  }

  return (
    <StripeProvider
      publishableKey={publishableKey}
      merchantIdentifier={STRIPE_MERCHANT_IDENTIFIER}
    >
      {children}
    </StripeProvider>
  );
}
