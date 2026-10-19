// ─────────────────────────────────────────────────────────────────────────────
// Door cash sales in the org order panel (door-sales step 9b).
//
// Pure rules, kept out of the component so they can be tested without
// rendering it. The server is the authority on every one of them
// (`orgRefundCashSale`); these only decide what the panel offers.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentChannel = "WEB" | "POS" | "CASH";

/**
 * What the panel shows for refunding a cash sale:
 *  - `none`: nothing (not a cash order, not SUCCEEDED, or a role that cannot
 *    refund here: Editor, Viewer, Scanner. Editors refund cash from
 *    Sell → Cash taken tonight, owner ruling 2026-10-08: Orders shows buyer
 *    details and is Owner/Admin/Finance only);
 *  - `open`: the "Refund cash sale" action;
 *  - `closed`: the line saying the window closed and support can still do it.
 *
 * `cashRefundableUntil` is inclusive: at that instant the server still takes
 * the refund (`cashRefundWindowClosesAt`), so `now <= until` is open.
 */
export type CashRefundAffordance = "none" | "open" | "closed";

export function cashRefundAffordance(args: {
  paymentChannel: PaymentChannel | null | undefined;
  status: string;
  cashRefundableUntil: Date | string | null | undefined;
  /**
   * Owner, Admin or Finance: the roles that see Orders (ORG_FINANCE_ROLES).
   * `orgRefundCashSale` takes all three, and Editor besides.
   */
  canRefundCash: boolean;
  now: Date;
}): CashRefundAffordance {
  if (args.paymentChannel !== "CASH") return "none";
  if (args.status !== "SUCCEEDED") return "none";
  if (!args.canRefundCash) return "none";
  if (!args.cashRefundableUntil) return "none";
  const until = new Date(args.cashRefundableUntil).getTime();
  if (Number.isNaN(until)) return "none";
  return args.now.getTime() <= until ? "open" : "closed";
}

/**
 * How a CASH order is paid, for the panel's "Payment method" cell. The
 * server classifies the sale (`getOrgOrder`'s `isComp` / `isFreeWithCode`,
 * from `classifyCashSale`): only the Comp button makes a comp; a $0 sale with
 * a code is "Free with <CODE>", a sale (owner ruling 2026-10-08).
 */
export type CashPaymentLabel =
  | { kind: "cash" }
  | { kind: "freeWithCode"; codes: string }
  | { kind: "comp" };

export function cashPaymentLabel(order: {
  isComp: boolean | null;
  isFreeWithCode: boolean | null;
  promoCodes: readonly string[];
}): CashPaymentLabel {
  if (order.isComp === true) return { kind: "comp" };
  if (order.isFreeWithCode === true) {
    return { kind: "freeWithCode", codes: order.promoCodes.join(", ") };
  }
  return { kind: "cash" };
}
