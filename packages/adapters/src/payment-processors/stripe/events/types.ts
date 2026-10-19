// adapters/stripe/events/types.ts
import type Stripe from "stripe";
import {
  PaymentIntentSucceededZ,
  PaymentIntentFailedZ,
  AccountUpdatedZ,
  ChargeRefundedZ,
  type PaymentIntentSucceeded,
  type PaymentIntentFailed,
  type AccountUpdated,
  type ChargeRefunded,
} from "./guards";

export type Narrowed<T extends Stripe.Event["type"]> =
  T extends "payment_intent.succeeded"
    ? PaymentIntentSucceeded
    : T extends "payment_intent.payment_failed"
      ? PaymentIntentFailed
      : T extends "account.updated"
        ? AccountUpdated
        : T extends "charge.refunded"
          ? ChargeRefunded
          : never;

export function parseEvent<T extends Stripe.Event["type"]>(
  type: T,
  obj: unknown,
): Narrowed<T> {
  switch (type) {
    case "payment_intent.succeeded":
      return PaymentIntentSucceededZ.parse(obj) as Narrowed<T>;
    case "payment_intent.payment_failed":
      return PaymentIntentFailedZ.parse(obj) as Narrowed<T>;
    case "account.updated":
      return AccountUpdatedZ.parse(obj) as Narrowed<T>;
    case "charge.refunded":
      return ChargeRefundedZ.parse(obj) as Narrowed<T>;
    default:
      throw new Error(`Unsupported event type: ${type}`);
  }
}
