/**
 * POS-facing view of the shared inventory rule.
 *
 * The rule itself lives in `_helpers/assert-ticket-type-capacity` because web
 * and embed checkout enforce the SAME rule; a second copy here is how the two
 * surfaces would drift into disagreeing about what "sold out" means. This file
 * keeps only what is genuinely POS-specific.
 *
 * (This file was briefly rewritten as a standalone copy of the rule. That was
 * a mistake — it silently dropped `excludeOrderId`, which is what stops a buyer
 * being refused their own cart. Keep it a shim.)
 */
import {
  assertTicketTypeCapacity,
  type TicketTypeCapacityRequest,
} from "../_helpers/assert-ticket-type-capacity";

export {
  assertTicketTypeCapacity,
  CAPACITY_HELD_WINDOW_SECONDS,
  heldSinceFor,
  type CapacityBearingTicketType,
  type CapacityCountingRepos,
} from "../_helpers/assert-ticket-type-capacity";

/** @deprecated Prefer `assertTicketTypeCapacity` — same function, honest name. */
export const assertPosCapacity = assertTicketTypeCapacity;

export type PosCapacityRequest = TicketTypeCapacityRequest;

export { CAPACITY_HELD_WINDOW_SECONDS as POS_HELD_WINDOW_SECONDS } from "../_helpers/assert-ticket-type-capacity";
