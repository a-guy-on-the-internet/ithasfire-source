export type UserCreditStatus = "ACTIVE" | "REDEEMED" | "EXPIRED" | "REVOKED";

export type UserCreditSourceType =
  | "SIGNUP_BONUS"
  | "REFERRAL"
  | "REFUND_GOODWILL"
  | "PLATFORM_CAMPAIGN"
  | "PARTNER_SPIFF"
  | "MANUAL_STAFF_GRANT";

export interface UserCreditRecord {
  id: string;
  humanId: string;
  amountCents: number;
  /** ISO 4217 currency code (lowercase), e.g. "usd". */
  currency: string;
  balanceCents: number;
  reason: string;
  sourceType: UserCreditSourceType;
  grantedByHumanId?: string | null;
  sourceRef?: string | null;
  status: UserCreditStatus;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCreditRedemptionRecord {
  id: string;
  creditId: string;
  orderId: string;
  amountCents: number;
  redeemedAt: Date;
  refundedAt?: Date | null;
  /** Set when the PENDING order died unpaid and the cents were restored. */
  releasedAt?: Date | null;
}
