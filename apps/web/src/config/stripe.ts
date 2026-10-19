import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;

/**
 * Returns a singleton Stripe.js instance (lazy-loaded).
 *
 * Uses `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` from the environment.
 * Returns `null` if the key is not configured.
 */
export const getStripe = (): Promise<Stripe | null> => {
  if (stripePromise) return stripePromise;

  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    console.warn(
      "[stripe] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set — payment form will not load.",
    );
    return Promise.resolve(null);
  }

  stripePromise = loadStripe(key);
  return stripePromise;
};
