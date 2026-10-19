export interface SettlementLineRecord {
  id: string;
  settlementId: string;
  orderId: string;
  orderSplitId: string;
  payeeId: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
}

export interface SettlementLineDraftRow {
  settlementId: string;
  orderId: string;
  orderSplitId: string;
  payeeId: string;
  amountCents: number;
  currency: string;
}
