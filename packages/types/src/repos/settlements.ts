export interface SettlementDraftRow {
  payeeId: string;
  date: Date;
  scheduledPayoutDate: Date;
  amountCents: number;
  currency: string;
  fxRate?: number | null;
  payoutTermsId?: string | null;
  /** @deprecated Use payoutTermsId */
  agreementId?: string | null;
  eventId?: string | null;
  meta?: unknown;
}

export interface SettlementRecord {
  id: string;
  payeeId: string;
  date: Date;
  scheduledPayoutDate: Date;
  amountCents: number;
  currency: string;
  fxRate?: number | null;
  stripeTransferId?: string | null;
  status: string;
  payoutTermsId?: string | null;
  /** @deprecated Use payoutTermsId */
  agreementId?: string | null;
  eventId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── List settlements for an org ──────────────────────────────────────────────

export type SettlementStatus =
  | "pending"
  | "transferred"
  | "failed"
  | "cancelled";

export interface ListSettlementsForOrgInput {
  /** Payee id (resolved from the org) */
  payeeId: string;
  status?: SettlementStatus;
  scheduledPayoutDateGte?: Date;
  scheduledPayoutDateLte?: Date;
  limit: number;
  offset: number;
}

export interface ListSettlementsForOrgItem {
  id: string;
  payeeId: string;
  date: Date;
  scheduledPayoutDate: Date;
  amountCents: number;
  currency: string;
  status: string;
  stripeTransferId: string | null;
  eventId: string | null;
  eventTitle: string | null;
  lineCount: number;
  createdAt: Date;
}

export interface ListSettlementsForOrgResult {
  items: ListSettlementsForOrgItem[];
  total: number;
}

// ── List settlements across all orgs (platform) ─────────────────────────────

export interface ListAllSettlementsInput {
  status?: SettlementStatus;
  scheduledPayoutDateGte?: Date;
  scheduledPayoutDateLte?: Date;
  searchQuery?: string;
  limit: number;
  offset: number;
}

export interface ListAllSettlementsItem {
  id: string;
  payeeId: string;
  payeeSubjectType: string;
  payeeSubjectId: string;
  payeeLabel: string | null;
  date: Date;
  scheduledPayoutDate: Date;
  amountCents: number;
  currency: string;
  status: string;
  stripeTransferId: string | null;
  /** Distinct Stripe PaymentIntent IDs from the settlement's order lines. */
  stripePaymentIntentIds: string[];
  eventId: string | null;
  eventTitle: string | null;
  lineCount: number;
  createdAt: Date;
}

export interface ListAllSettlementsResult {
  items: ListAllSettlementsItem[];
  total: number;
}
