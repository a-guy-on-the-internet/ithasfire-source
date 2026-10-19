export type PayoutStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface PayoutRecord {
  id: string;
  scheduledFor: Date;
  status: PayoutStatus;
  canceledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  processorBatchId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePayoutInput {
  scheduledFor: Date;
}

export interface DuePayoutRecord {
  id: string;
  scheduledFor: Date;
}
