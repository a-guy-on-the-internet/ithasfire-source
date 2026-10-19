import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";

type Translate = (key: string) => string;

/**
 * The line shown when `orders.orgRefundCashSale` refuses, and whether the
 * caller should re-read what it shows because the refusal means it is stale.
 * Shared by the two places a cash door sale is refunded: the org Orders
 * panel (Owner/Admin/Finance) and Sell → Cash taken tonight
 * (Owner/Admin/Editor).
 *
 *  - CASH_REFUND_WINDOW_CLOSED: the window closed while the screen was open;
 *    the re-read shows it closed.
 *  - `order_not_refundable` (a non-SUCCEEDED order) / ORDER_NOT_REFUNDABLE:
 *    someone else changed the order; the re-read shows where it stands.
 *  - INSUFFICIENT_ROLE, ORDER_NOT_FOUND, EVENT_NOT_FOUND, NOT_A_CASH_ORDER and
 *    anything else: the catalog copy, no re-read.
 *
 * Every code resolves through `formatErrorMessage(err, t)` — its `errors.*`
 * key — so the copy lives in the catalog, never here.
 */
export function cashRefundError(
  error: unknown,
  t: Translate,
): { message: string; refetch: boolean } {
  const code = getAppErrorCode(error);
  const refetch =
    code === "CASH_REFUND_WINDOW_CLOSED" || code === "ORDER_NOT_REFUNDABLE";
  return { message: formatErrorMessage(error, t), refetch };
}
