import type {
  OrderItemSettlementLineDraftRow,
  OrderItemSettlementLineRecord,
} from "@th/types/repos/order-item-settlement-lines";

export interface OrderItemSettlementLinesRepo {
  /**
   * Bulk create order item settlement line records.
   * Links order items to their corresponding settlement lines for item-level payout tracking.
   */
  addDraft(rows: OrderItemSettlementLineDraftRow[]): Promise<void>;

  /**
   * List all order item settlement lines for a given settlement line.
   */
  listBySettlementLineId(
    settlementLineId: string,
  ): Promise<OrderItemSettlementLineRecord[]>;

  /**
   * List all order item settlement lines for a given order item.
   */
  listByOrderItemId(
    orderItemId: string,
  ): Promise<OrderItemSettlementLineRecord[]>;

  /**
   * List all order item settlement lines for a batch of order item IDs.
   * Used during refund flows to look up which settlements hold funds for the items being refunded.
   */
  listByOrderItemIds(
    orderItemIds: string[],
  ): Promise<OrderItemSettlementLineRecord[]>;

  /**
   * Collect distinct order item IDs linked to a batch of settlement IDs.
   * Replaces the nested settlement → lines → item-links loop in payout batch processing.
   */
  listOrderItemIdsBySettlementIds(settlementIds: string[]): Promise<string[]>;
}

export type {
  OrderItemSettlementLineDraftRow,
  OrderItemSettlementLineRecord,
} from "@th/types/repos/order-item-settlement-lines";
