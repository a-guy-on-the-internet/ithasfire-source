import type {
  SplitEntry,
  UpsertSplitsForOrderInput,
} from "@th/types/repos/splits";

export interface SplitsRepo {
  upsertForOrder(
    orderId: string,
    rows: UpsertSplitsForOrderInput["rows"],
  ): Promise<void>;
  getForOrder(orderId: string): Promise<SplitEntry[]>;
}

export type {
  SplitEntry,
  UpsertSplitsForOrderInput,
} from "@th/types/repos/splits";
