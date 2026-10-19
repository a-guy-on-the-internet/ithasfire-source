import { z } from "zod";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const walletPassTypeSchema = z.enum(["apple", "google"]);

export const walletPassTicketDataSchema = z.object({
  ticketId: z.string().uuid(),
  ticketCode: z.string().min(4),
  ticketTypeName: z.string(),
  eventId: z.string().uuid(),
  eventTitle: z.string(),
  eventStartsAt: z.string().datetime(),
  eventEndsAt: z.string().datetime().nullable(),
  venueName: z.string().nullable(),
  venueAddress: z.string().nullable(),
  /**
   * True when the holder may not see the street yet, or ever: `venueName` is
   * then a coarse area label and `venueAddress` a notice, not an address.
   *
   * Adapters that keep state SHARED across holders must not let a locked pass
   * attach to state created while the address was unlocked. Google's
   * per-event `EventTicketClass` is insert-once and carries `venue.address`,
   * so a locked pass saved after an unlocked one would otherwise show the
   * street from the older class. Absent = false.
   */
  addressLocked: z.boolean().optional(),
  organizerName: z.string().nullable(),
  orderId: z.string().uuid(),
  /**
   * The order's human-facing code — `formatOrderCode(orderId)` from
   * `@th/types/order-identifier` (the 8-hex tail, uppercased). Null only when
   * the order id could not be resolved. It is the SAME code the order page and
   * admin search show, so a pass holder can quote it and be found.
   */
  orderRef: z.string().nullable(),
  holderName: z.string().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
  /**
   * Absolute HTTPS URL of the organiser-cropped SQUARE wallet image, or null.
   *
   * Null is the normal case, not an error: the field is optional in the event
   * builder, and a pass without artwork is the shipped design (see
   * `docs/specs/2026-09-07/wallet-pass-image.spec.yaml`). Adapters MUST render
   * a valid pass when it is null, and must degrade to that same artwork-free
   * pass — never fail — when the image cannot be fetched.
   *
   * The image is expected to be square: Apple embeds it as `thumbnail.png`.
   * Google's `heroImage` is ~3:1, so a square asset letterboxes there (OQ-4 in
   * the spec).
   */
  walletImageUrl: z.string().url().nullable(),
});

export const walletPassResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("apple"),
    /** Raw .pkpass bytes — caller sends as application/vnd.apple.pkpass. */
    passBuffer: z.instanceof(Buffer),
    filename: z.string(),
  }),
  z.object({
    type: z.literal("google"),
    /** "Add to Google Wallet" JWT URL the client opens in a new tab. */
    saveUrl: z.string().url(),
  }),
]);

// ── Types ────────────────────────────────────────────────────────────────────

export type WalletPassType = z.infer<typeof walletPassTypeSchema>;
export type WalletPassTicketData = z.infer<typeof walletPassTicketDataSchema>;
export type WalletPassResult = z.infer<typeof walletPassResultSchema>;

// ── Errors ───────────────────────────────────────────────────────────────────

export type WalletPassErrorCode =
  | "invalid_input"
  | "not_configured"
  | "dependency_failed"
  | "transient";

export type WalletPassError<
  TCode extends WalletPassErrorCode = WalletPassErrorCode,
> = {
  code: TCode;
  message: string;
};

export function createWalletPassError<TCode extends WalletPassErrorCode>(
  code: TCode,
  message: string,
): WalletPassError<TCode> {
  return { code, message } as const;
}

export function isWalletPassError(error: unknown): error is WalletPassError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

// ── Port interface ───────────────────────────────────────────────────────────

/**
 * Wallet pass port — generates Apple Wallet (.pkpass) and Google Wallet passes
 * for event tickets.
 *
 * The primary implementation uses `passkit-generator` for Apple and the Google
 * Wallet REST API for Google. The interface is provider-agnostic so mock
 * adapters can be injected for testing.
 */
export interface WalletPassPort {
  /**
   * Generate a wallet pass for the given ticket.
   *
   * Apple: returns a signed .pkpass Buffer.
   * Google: returns a JWT "Add to Google Wallet" URL.
   *
   * Throws `{ code: "not_configured" }` when the required secrets/credentials
   * are missing for the requested pass type.
   */
  generate(
    passType: WalletPassType,
    ticketData: WalletPassTicketData,
  ): Promise<WalletPassResult>;

  /** Check whether the adapter is configured for the given pass type. */
  isConfigured(passType: WalletPassType): Promise<boolean>;
}
