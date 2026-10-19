// POS use cases — barrel export

export {
  posMintConnectionToken,
  posMintConnectionTokenInputSchema,
  posMintConnectionTokenOutputSchema,
  type PosMintConnectionTokenDeps,
  type PosMintConnectionTokenInput,
  type PosMintConnectionTokenOutput,
} from "./mint-connection-token";

export {
  ensurePlatformTerminalLocation,
  type EnsurePlatformTerminalLocationDeps,
  type EnsurePlatformTerminalLocationOutput,
} from "./ensure-platform-terminal-location";

export {
  recordCashSale,
  recordCashSaleInputSchema,
  recordCashSaleOutputSchema,
  type RecordCashSaleDeps,
  type RecordCashSaleInput,
  type RecordCashSaleOutput,
} from "./record-cash-sale";

export {
  completePosSale,
  completePosSaleInputSchema,
  completePosSaleOutputSchema,
  type CompletePosSaleDeps,
  type CompletePosSaleInput,
  type CompletePosSaleOutput,
} from "./complete-pos-sale";

export {
  refundCashSale,
  refundCashSaleInputSchema,
  refundCashSaleOutputSchema,
  type RefundCashSaleDeps,
  type RefundCashSaleInput,
  type RefundCashSaleOutput,
} from "./refund-cash-sale";

export {
  orgRefundCashSale,
  orgRefundCashSaleInputSchema,
  orgRefundCashSaleOutputSchema,
  type OrgRefundCashSaleDeps,
  type OrgRefundCashSaleInput,
  type OrgRefundCashSaleOutput,
} from "./org-refund-cash-sale";

export {
  refundPosSale,
  refundPosSaleInputSchema,
  type RefundPosSaleDeps,
  type RefundPosSaleInput,
  type RefundPosSaleOutput,
} from "./refund-pos-sale";

export {
  startPosSale,
  startPosSaleInputSchema,
  startPosSaleOutputSchema,
  type StartPosSaleDeps,
  type StartPosSaleInput,
  type StartPosSaleOutput,
} from "./start-pos-sale";

export {
  quotePosCart,
  quotePosCartInputSchema,
  quotePosCartOutputSchema,
  type PosChannelQuote,
  type QuotePosCartDeps,
  type QuotePosCartInput,
  type QuotePosCartOutput,
} from "./quote-pos-cart";

export {
  listSellableItems,
  listSellableItemsInputSchema,
  listSellableItemsOutputSchema,
  type ListSellableItemsDeps,
  type ListSellableItemsInput,
  type ListSellableItemsOutput,
} from "./list-sellable-items";

export {
  getCashTillReport,
  getCashTillReportInputSchema,
  getCashTillReportOutputSchema,
  type GetCashTillReportDeps,
  type GetCashTillReportInput,
  type GetCashTillReportOutput,
} from "./get-cash-till-report";

export {
  listEventCashSales,
  listEventCashSalesInputSchema,
  listEventCashSalesOutputSchema,
  LIST_EVENT_CASH_SALES_MAX_LIMIT,
  type ListEventCashSalesDeps,
  type ListEventCashSalesInput,
  type ListEventCashSalesOutput,
} from "./list-event-cash-sales";

export {
  resolvePosUnitPriceCents,
  type PosPricedLineRequest,
  type PosPricedTicketType,
} from "./resolve-pos-line-price";

export {
  assertPosCapacity,
  assertTicketTypeCapacity,
  heldSinceFor,
  CAPACITY_HELD_WINDOW_SECONDS,
  POS_HELD_WINDOW_SECONDS,
  type PosCapacityRequest,
} from "./assert-pos-capacity";

export {
  cancelPosSale,
  cancelPosSaleInputSchema,
  cancelPosSaleOutputSchema,
  type CancelPosSaleDeps,
  type CancelPosSaleInput,
  type CancelPosSaleOutput,
} from "./cancel-pos-sale";

// ── Server-driven smart readers ─────────────────────────────────────────────

export {
  pairPosReader,
  pairPosReaderInputSchema,
  pairPosReaderOutputSchema,
  type PairPosReaderDeps,
  type PairPosReaderInput,
  type PairPosReaderOutput,
} from "./pair-pos-reader";

export {
  listPosReaders,
  listPosReadersInputSchema,
  listPosReadersOutputSchema,
  type ListPosReadersDeps,
  type ListPosReadersInput,
  type ListPosReadersOutput,
} from "./list-pos-readers";

export {
  updatePosReader,
  updatePosReaderInputSchema,
  updatePosReaderOutputSchema,
  type UpdatePosReaderDeps,
  type UpdatePosReaderInput,
  type UpdatePosReaderOutput,
} from "./update-pos-reader";

export {
  unpairPosReader,
  unpairPosReaderInputSchema,
  unpairPosReaderOutputSchema,
  type UnpairPosReaderDeps,
  type UnpairPosReaderInput,
  type UnpairPosReaderOutput,
} from "./unpair-pos-reader";

export {
  processPosSaleOnReader,
  processPosSaleOnReaderInputSchema,
  processPosSaleOnReaderOutputSchema,
  type ProcessPosSaleOnReaderDeps,
  type ProcessPosSaleOnReaderInput,
  type ProcessPosSaleOnReaderOutput,
} from "./process-pos-sale-on-reader";

export {
  cancelPosReaderAction,
  cancelPosReaderActionInputSchema,
  cancelPosReaderActionOutputSchema,
  type CancelPosReaderActionDeps,
  type CancelPosReaderActionInput,
  type CancelPosReaderActionOutput,
} from "./cancel-pos-reader-action";
