import { z } from "zod";

/// Canonical vocabulary for `OrderItem.kind`.
///
/// The DB column is currently String (see `packages/db/prisma/order.prisma`)
/// and will stay that way until a dedicated cleanup migration converts it
/// to a Postgres enum. Until then, every write site should validate
/// through this Zod enum so we don't regress on the vocabulary.
///
/// Adding a new value? Update this file, the JSDoc on
/// `OrderItem.kind` in `order.prisma`, and any switch statements on
/// `kind` in the orders / refund use cases.
export const orderItemKindSchema = z.enum([
  "ticket",
  "merch_freeform",
  "merch_sku",
  "discount",
  "surcharge",
  "fee",
  "platform_credit",
  // One billing period of a membership tier. `membershipId` is set,
  // `ticketTypeId` is null, and the parent Order carries kind = MEMBERSHIP.
  "membership",
]);

export type OrderItemKind = z.infer<typeof orderItemKindSchema>;

/// Convenience predicates for the common dispatch points. Prefer these
/// over inline string compares so a future enum migration only has to
/// update one file.
export const isTicketKind = (k: string): k is "ticket" => k === "ticket";

export const isMerchKind = (k: string): k is "merch_freeform" | "merch_sku" =>
  k === "merch_freeform" || k === "merch_sku";

export const isAdjustmentKind = (
  k: string,
): k is "discount" | "surcharge" | "fee" =>
  k === "discount" || k === "surcharge" || k === "fee";
