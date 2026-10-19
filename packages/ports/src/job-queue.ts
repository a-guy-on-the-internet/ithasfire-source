import { z } from "zod";

import type { LoggerPort } from "./logger";
import type { MetricsPort } from "./metric";

const queueNameSchema = z.string().min(1, "queue is required");
const jobNameSchema = z.string().min(1, "job name is required");
const isoDateSchema = z.string().datetime({ offset: true });

export const JOB_QUEUE_DEFAULT_ATTEMPTS = 5;
export const JOB_QUEUE_DEFAULT_MAX_ATTEMPTS = JOB_QUEUE_DEFAULT_ATTEMPTS;
export const JOB_QUEUE_DEFAULT_BACKOFF_MS = 30_000;
export const JOB_QUEUE_DEFAULT_BACKOFF_BASE_MS = 5_000;
export const JOB_QUEUE_BACKOFF_JITTER_MS = 5_000;
export const JOB_QUEUE_DEFAULT_DEDUPE_TTL_SEC = 600;
export const JOB_QUEUE_DEFAULT_VISIBILITY_TIMEOUT_SEC = 30;
export const JOB_QUEUE_DEFAULT_PRIORITY = 0;

export type JobQueueErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "transient"
  | "dependency_failed"
  | "internal";

export class JobQueueError extends Error {
  constructor(
    public readonly code: JobQueueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JobQueueError";
  }
}

export function createJobQueueError(
  code: JobQueueErrorCode,
  message: string,
): JobQueueError {
  return new JobQueueError(code, message);
}

export function isJobQueueError(error: unknown): error is JobQueueError {
  return error instanceof JobQueueError;
}

export const jobStateSchema = z.enum([
  "waiting",
  "active",
  "delayed",
  "completed",
  "failed",
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const jobBackoffSchema = z.union([
  z.object({
    type: z.literal("fixed"),
    delayMs: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("exponential"),
    delayMs: z.number().int().min(0).optional(),
  }),
]);

export type JobBackoff = z.infer<typeof jobBackoffSchema>;

const labelsSchema = z.record(z.string(), z.string());

const jobPayloadBaseSchema = z.object({
  name: jobNameSchema,
  payload: z.unknown(),
  priority: z
    .number()
    .int()
    .min(-500)
    .max(500)
    .default(JOB_QUEUE_DEFAULT_PRIORITY),
  delayMs: z.number().int().min(0).optional(),
  idempotencyKey: z.string().min(1).optional(),
  dedupeTtlSec: z.number().int().min(1).max(86_400).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
  labels: labelsSchema.default({}).optional(),
  metadata: labelsSchema.optional(),
  backoff: jobBackoffSchema.optional(),
  ttlMs: z.number().int().min(1).optional(),
});

export const jobPayloadSchema = jobPayloadBaseSchema;
export type JobPayloadBase = z.input<typeof jobPayloadSchema>;
export type JobPayload<T = unknown> = Omit<JobPayloadBase, "payload"> & {
  payload: T;
};

export const enqueueJobInputSchema = jobPayloadBaseSchema.extend({
  queue: queueNameSchema,
});

export type EnqueueJobInput = z.input<typeof enqueueJobInputSchema>;
export interface EnqueueJobResult {
  jobId: string;
  enqueuedAt: string;
}

export const dequeueJobInputSchema = z.object({
  queue: queueNameSchema,
  max: z.number().int().min(1).max(100).default(1),
  visibilityTimeoutSec: z.number().int().min(1).max(86_400).optional(),
});
export type DequeueJobInput = z.input<typeof dequeueJobInputSchema>;

export const ackJobInputSchema = z.object({
  jobId: z.string().min(1),
});
export type AckJobInput = z.input<typeof ackJobInputSchema>;

export const failJobInputSchema = z.object({
  jobId: z.string().min(1),
  retryBackoffMs: z.number().int().min(0).optional(),
});
export type FailJobInput = z.input<typeof failJobInputSchema>;

export const extendLeaseInputSchema = z.object({
  jobId: z.string().min(1),
  extendBySec: z.number().int().min(1).max(86_400),
});
export type ExtendLeaseInput = z.input<typeof extendLeaseInputSchema>;

export const peekDlqInputSchema = z.object({
  queue: queueNameSchema,
  max: z.number().int().min(1).max(500).default(10),
});
export type PeekDLQInput = z.input<typeof peekDlqInputSchema>;

export const requeueFromDlqInputSchema = z.object({
  queue: queueNameSchema,
  jobId: z.string().min(1),
});
export type RequeueFromDLQInput = z.input<typeof requeueFromDlqInputSchema>;

export const getDlqJobInputSchema = z.object({
  queue: queueNameSchema,
  jobId: z.string().min(1),
});
export type GetDlqJobInput = z.input<typeof getDlqJobInputSchema>;

export const deleteDlqJobInputSchema = z.object({
  queue: queueNameSchema,
  jobId: z.string().min(1),
});
export type DeleteDlqJobInput = z.input<typeof deleteDlqJobInputSchema>;

export const purgeInputSchema = z.object({
  queue: queueNameSchema,
  kind: z.enum(["ready", "inflight", "dlq"]).default("ready"),
});
export type PurgeInput = z.input<typeof purgeInputSchema>;

export const jobRefSchema = z.object({
  queue: queueNameSchema,
  id: z.string().min(1),
  name: jobNameSchema,
});

export type JobRef = z.infer<typeof jobRefSchema>;

export const jobRecordSchema = z.object({
  jobId: z.string().min(1),
  queue: queueNameSchema,
  name: jobNameSchema,
  payload: z.unknown(),
  attempt: z.number().int().min(1),
  availableAt: isoDateSchema,
  visibilityDeadline: isoDateSchema.nullable(),
  labels: labelsSchema.optional().default({}),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;

export interface JobQueueWorkerInitArgs {
  queue: string;
  processor: (
    payload: unknown,
    ctx: { job: JobRef; logger: LoggerPort; metrics?: MetricsPort },
  ) => Promise<unknown>;
  options?: {
    concurrency?: number;
    limiter?: { max: number; durationMs: number };
  };
}

export interface JobQueueWorkerHandle {
  close(): Promise<void>;
}

export interface DLQJobRecord {
  name: string;
  ref: JobRef;
  failedAt: string;
  error?: {
    message: string;
    stack?: string;
  };
  payload: unknown;
  metadata?: Record<string, string>;
  attempt?: number;
}

export interface JobQueuePort {
  enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult>;
  bulkEnqueue(inputs: EnqueueJobInput[]): Promise<EnqueueJobResult[]>;
  dequeue(input: DequeueJobInput): Promise<JobRecord[]>;
  ack(input: AckJobInput): Promise<void>;
  fail(input: FailJobInput): Promise<void>;
  extendLease(input: ExtendLeaseInput): Promise<void>;
  getState(ref: JobRef): Promise<JobState>;
  getResult<T>(ref: JobRef): Promise<T | null>;
  remove(ref: JobRef): Promise<void>;
  peekDLQ(input: PeekDLQInput): Promise<DLQJobRecord[]>;
  getJobFromDLQ(input: GetDlqJobInput): Promise<DLQJobRecord | null>;
  deleteFromDLQ(input: DeleteDlqJobInput): Promise<boolean>;
  requeueFromDLQ(input: RequeueFromDLQInput): Promise<JobRef>;
  purge(input: PurgeInput): Promise<{ purged: number }>;
  initWorker(args: JobQueueWorkerInitArgs): Promise<JobQueueWorkerHandle>;
  close(): Promise<void>;
}
