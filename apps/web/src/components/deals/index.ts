export { DealEditor, type DealEditorProps } from "./DealEditor";
export { DealSummary } from "./DealSummary";
export { ResaleClause, type ResaleClauseProps } from "./ResaleClause";
export { BillSection } from "./BillSection";
export { DealTag, type DealTagTone } from "./ClauseRow";
export { billSuggestionsOf, type BillItem } from "./bill-model";
export {
  classifyDealReadError,
  isGuaranteeSetByDealError,
} from "./deal-errors";
export type { DealPerson, DealTarget } from "./deal-model";
export { recipientPortions, type PortionLine } from "./resale-clause-model";
export {
  DealChanges,
  changesLocale,
  type DealChangesPage,
} from "./DealChanges";
export { NotSaved } from "./DealFreeze";
export { joinNames, uniqueNames } from "./deal-names";
