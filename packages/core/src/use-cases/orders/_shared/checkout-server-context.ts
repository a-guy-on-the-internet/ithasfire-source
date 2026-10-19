import { z } from "zod";

/**
 * What only SERVER code may tell `createCheckout` about the checkout it is
 * running. It is the use case's THIRD argument, never a field of its input.
 *
 * That is the point of the separate argument. `createCheckout`'s input is
 * built by transports out of a client's request body (`orders.createCheckout`
 * spreads its parsed input into it), so anything in the input schema is
 * client-settable unless every transport remembers to omit it. Nothing here
 * can arrive that way: a transport would have to write the value in by hand.
 */
export const checkoutServerContextSchema = z
  .object({
    /**
     * The embed this order is being made through. Set only by
     * `createEmbedGuestCheckout`, after it has checked that the embed is
     * ACTIVE, that the request's origin may host it, and that it may sell
     * the event. Written to the PaymentIntent's metadata, where
     * `releaseEmbedGuestOrder` reads it back: a guest may release an order
     * only through the embed it was made through. An order with no binding
     * (the main checkout's, a resale order) can never be released by a guest.
     */
    embedId: z.uuid().optional(),
    /**
     * The SHA-256 (lowercase hex) of an embed order's receipt secret. Set
     * only by `createEmbedGuestCheckout`, which makes the secret, returns it
     * to the widget and never stores it. Written to the PaymentIntent's
     * metadata (Stripe lets only the secret key write it), where
     * `confirmEmbedGuestPayment` reads it back: ticket codes go only to a
     * caller who presents the secret as well as the client secret. The hash
     * alone opens nothing.
     */
    receiptSecretHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export type CheckoutServerContext = z.infer<typeof checkoutServerContextSchema>;

/**
 * Adds the server context's keys to a checkout PaymentIntent's metadata.
 * Mutates and returns `metadata`. Stripe metadata is a flat string map, and
 * finalize reads it through a passthrough schema, so an extra key is ignored
 * by everything that does not look for it.
 */
export function applyCheckoutServerContextToMetadata(
  metadata: Record<string, string>,
  serverContext: CheckoutServerContext,
): Record<string, string> {
  if (serverContext.embedId) {
    metadata.embedId = serverContext.embedId;
  }
  if (serverContext.receiptSecretHash) {
    metadata.receiptSecretHash = serverContext.receiptSecretHash;
  }
  return metadata;
}
