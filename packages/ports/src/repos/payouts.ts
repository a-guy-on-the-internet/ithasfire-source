import type {
  CreatePayoutInput,
  DuePayoutRecord,
  PayoutRecord,
} from "@th/types/repos/payouts";

export interface PayoutsRepo {
  create(input: CreatePayoutInput): Promise<PayoutRecord>;
  listDue(now: Date, limit: number): Promise<DuePayoutRecord[]>;
  markRunning(payoutId: string, startedAt: Date): Promise<void>;
  markCompleted(payoutId: string, completedAt: Date): Promise<void>;
  markFailed(payoutId: string, failedAt: Date, reason: string): Promise<void>;
  cancel(payoutId: string, canceledAt: Date): Promise<void>;
}

export type {
  CreatePayoutInput,
  DuePayoutRecord,
  PayoutRecord,
} from "@th/types/repos/payouts";
