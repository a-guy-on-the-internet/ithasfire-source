export interface OrderItemSettlementLineRecord {
  id: string;
  orderItemId: string;
  settlementLineId: string;
  amountCents: number;
  createdAt: Date;
}

export interface OrderItemSettlementLineDraftRow {
  orderItemId: string;
  settlementLineId: string;
  amountCents: number;
}
