import type {
  SettlementLineDraftRow,
  SettlementLineRecord,
} from "@th/types/repos/settlement-lines";
import type { DisputeStatus } from "@th/types/repos/disputes";
import type { OrderKind } from "@th/types/repos/orders";

export interface SettlementLinesRepo {
  addDraft(rows: SettlementLineDraftRow[]): Promise<void>;
  listByOrderId(orderId: string): Promise<SettlementLineRecord[]>;

  // Get a single settlement line by its ID
  getById(settlementLineId: string): Promise<SettlementLineRecord | null>;

  /** Batch-fetch multiple settlement lines by ID. Missing IDs are silently omitted. */
  getByIds(ids: string[]): Promise<SettlementLineRecord[]>;

  // List lines by settlement id
  listBySettlementId(settlementId: string): Promise<SettlementLineRecord[]>;

  /** Return settlement IDs whose lines reference orders in any blocked dispute status. */
  settlementIdsWithDisputedOrders(
    settlementIds: string[],
    blockedStatuses: readonly DisputeStatus[],
  ): Promise<Set<string>>;

  /**
   * Return settlement IDs whose lines reference an order of any of the given
   * kinds. Used by the payout batch to tell TICKETING revenue from MEMBERSHIP
   * revenue inside a payee's settlement group — `Order.kind` is the only
   * discriminator for that, and the settlement→line→order path is the
   * authoritative record of what is actually being paid out (as opposed to
   * what was merely sold).
   *
   * Deliberately mirrors {@link settlementIdsWithDisputedOrders}: same access
   * path, same `distinct` shape, one batched query for the entire run.
   */
  settlementIdsWithOrderKinds(
    settlementIds: string[],
    kinds: readonly OrderKind[],
  ): Promise<Set<string>>;

  /**
   * Sum of line `amountCents` per settlement, restricted to lines whose
   * order is one of the given kinds. The rolling reserve needs the AMOUNT of
   * membership revenue inside a payout group, not just its presence —
   * {@link settlementIdsWithOrderKinds} answers "is there any?", this answers
   * "how much?". Settlements with no matching lines are absent from the map.
   * One grouped query for the entire run, same access path as the guards
   * above.
   */
  sumSettlementAmountsForOrderKinds(
    settlementIds: string[],
    kinds: readonly OrderKind[],
  ): Promise<Map<string, number>>;

  /** Return settlement IDs linked to an order whose settlement rows are in any requested status. */
  settlementIdsForOrderWithSettlementStatuses(
    orderId: string,
    statuses: readonly string[],
  ): Promise<Set<string>>;
}

export type {
  SettlementLineDraftRow,
  SettlementLineRecord,
} from "@th/types/repos/settlement-lines";
