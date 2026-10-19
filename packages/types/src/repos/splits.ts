export interface SplitEntry {
  id: string;
  orderId: string;
  orderSplitId: string;
  payeeId: string;
  amountCents: number;
}

export interface UpsertSplitsForOrderInput {
  orderId: string;
  rows: Omit<SplitEntry, "id" | "orderId" | "orderSplitId">[];
}
