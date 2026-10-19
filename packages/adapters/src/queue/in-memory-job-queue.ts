import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  JOB_QUEUE_BACKOFF_JITTER_MS,
  JOB_QUEUE_DEFAULT_BACKOFF_BASE_MS,
  JOB_QUEUE_DEFAULT_DEDUPE_TTL_SEC,
  JOB_QUEUE_DEFAULT_MAX_ATTEMPTS,
  JOB_QUEUE_DEFAULT_VISIBILITY_TIMEOUT_SEC,
  type AckJobInput,
  ackJobInputSchema,
  type DequeueJobInput,
  dequeueJobInputSchema,
  type EnqueueJobInput,
  enqueueJobInputSchema,
  type EnqueueJobResult,
  type ExtendLeaseInput,
  extendLeaseInputSchema,
  type FailJobInput,
  failJobInputSchema,
  type JobQueuePort,
  type DLQJobRecord,
  type JobBackoff,
  type JobQueueWorkerHandle,
  type JobQueueWorkerInitArgs,
  type JobRecord,
  type JobRef,
  type JobState,
  jobRecordSchema,
  jobRefSchema,
  jobStateSchema,
  type PeekDLQInput,
  peekDlqInputSchema,
  type GetDlqJobInput,
  getDlqJobInputSchema,
  type DeleteDlqJobInput,
  deleteDlqJobInputSchema,
  type PurgeInput,
  purgeInputSchema,
  type RequeueFromDLQInput,
  requeueFromDlqInputSchema,
  createJobQueueError,
} from "@th/ports/job-queue";

export interface InMemoryJobQueueOptions {
  maxAttempts?: number;
  defaultVisibilityTimeoutSec?: number;
  defaultDedupeTtlSec?: number;
  baseBackoffMs?: number;
  jitterMs?: number;
  now?: () => number;
}

type InternalJob = {
  id: string;
  queue: string;
  name: string;
  payload: unknown;
  priority: number;
  availableAt: number;
  visibilityDeadline: number | null;
  attempts: number;
  maxAttempts: number;
  labels: Record<string, string>;
  idempotencyKey?: string;
  enqueuedAt: number;
  backoff?: JobBackoff;
  failedAt: number | null;
};

type QueueState = {
  ready: InternalJob[];
  delayed: InternalJob[];
  inflight: Map<string, InternalJob>;
  dlq: InternalJob[];
  timer: ReturnType<typeof setTimeout> | null;
};

type IdempotencyEntry = {
  jobId: string;
  queue: string;
  expiresAt: number;
  enqueuedAt: number;
};

export class InMemoryJobQueue implements JobQueuePort {
  private readonly maxAttempts: number;
  private readonly defaultVisibilityTimeoutSec: number;
  private readonly defaultDedupeTtlSec: number;
  private readonly baseBackoffMs: number;
  private readonly jitterMs: number;
  private readonly nowFn: () => number;

  private readonly queues = new Map<string, QueueState>();
  private readonly jobs = new Map<string, InternalJob>();
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();

  constructor(options: InMemoryJobQueueOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? JOB_QUEUE_DEFAULT_MAX_ATTEMPTS;
    this.defaultVisibilityTimeoutSec =
      options.defaultVisibilityTimeoutSec ??
      JOB_QUEUE_DEFAULT_VISIBILITY_TIMEOUT_SEC;
    this.defaultDedupeTtlSec =
      options.defaultDedupeTtlSec ?? JOB_QUEUE_DEFAULT_DEDUPE_TTL_SEC;
    this.baseBackoffMs =
      options.baseBackoffMs ?? JOB_QUEUE_DEFAULT_BACKOFF_BASE_MS;
    this.jitterMs = options.jitterMs ?? JOB_QUEUE_BACKOFF_JITTER_MS;
    this.nowFn = options.now ?? (() => Date.now());
  }

  async enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    const parsed = this.parseInput(
      enqueueJobInputSchema,
      input,
      "enqueue input",
    );
    const queueState = this.getQueue(parsed.queue);
    const now = this.now();

    this.cleanupIdempotency();

    if (parsed.idempotencyKey) {
      const cacheKey = this.toIdempotencyCacheKey(
        parsed.queue,
        parsed.idempotencyKey,
      );
      const cached = this.idempotencyCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return {
          jobId: cached.jobId,
          enqueuedAt: new Date(cached.enqueuedAt).toISOString(),
        };
      }
    }

    const labels = {
      ...(parsed.metadata ?? {}),
      ...(parsed.labels ?? {}),
    };

    const job: InternalJob = {
      id: randomUUID(),
      queue: parsed.queue,
      name: parsed.name,
      payload: parsed.payload,
      priority: parsed.priority,
      availableAt: now + (parsed.delayMs ?? 0),
      visibilityDeadline: null,
      attempts: 0,
      maxAttempts: parsed.maxAttempts ?? this.maxAttempts,
      labels,
      idempotencyKey: parsed.idempotencyKey,
      enqueuedAt: now,
      backoff: parsed.backoff,
      failedAt: null,
    };

    this.jobs.set(job.id, job);

    if (job.availableAt <= now) {
      this.insertReady(queueState, job);
    } else {
      this.insertDelayed(queueState, job);
    }

    if (parsed.idempotencyKey) {
      const cacheKey = this.toIdempotencyCacheKey(
        parsed.queue,
        parsed.idempotencyKey,
      );
      const dedupeTtlSec = parsed.dedupeTtlSec ?? this.defaultDedupeTtlSec;
      this.idempotencyCache.set(cacheKey, {
        jobId: job.id,
        queue: job.queue,
        enqueuedAt: job.enqueuedAt,
        expiresAt: now + dedupeTtlSec * 1_000,
      });
    }

    this.ensureTimer(parsed.queue, queueState);

    return {
      jobId: job.id,
      enqueuedAt: new Date(job.enqueuedAt).toISOString(),
    };
  }

  async bulkEnqueue(inputs: EnqueueJobInput[]): Promise<EnqueueJobResult[]> {
    const results: EnqueueJobResult[] = [];
    for (const input of inputs) {
      const result = await this.enqueue(input);
      results.push(result);
    }
    return results;
  }

  async dequeue(input: DequeueJobInput): Promise<JobRecord[]> {
    const parsed = this.parseInput(
      dequeueJobInputSchema,
      input,
      "dequeue input",
    );
    const queueState = this.getQueue(parsed.queue);
    this.synchronizeQueue(parsed.queue, queueState);

    const now = this.now();
    const visibilityTimeoutSec =
      parsed.visibilityTimeoutSec ?? this.defaultVisibilityTimeoutSec;

    const results: JobRecord[] = [];
    while (results.length < parsed.max && queueState.ready.length > 0) {
      const job = queueState.ready.shift();
      if (!job) {
        break;
      }

      job.attempts += 1;
      job.visibilityDeadline = now + visibilityTimeoutSec * 1_000;
      job.availableAt = now;
      queueState.inflight.set(job.id, job);

      results.push(this.toRecord(job));
    }

    this.ensureTimer(parsed.queue, queueState);

    return results;
  }

  async ack(input: AckJobInput): Promise<void> {
    const parsed = this.parseInput(ackJobInputSchema, input, "ack input");
    const job = this.jobs.get(parsed.jobId);
    if (!job) {
      throw createJobQueueError("not_found", `Job ${parsed.jobId} not found`);
    }

    const queueState = this.queues.get(job.queue);
    if (queueState) {
      queueState.inflight.delete(job.id);
      this.removeFromArray(queueState.ready, job.id);
      this.removeFromArray(queueState.delayed, job.id);
      this.removeFromArray(queueState.dlq, job.id);
    }

    this.jobs.delete(job.id);
    this.removeIdempotency(parsed.jobId);
  }

  async fail(input: FailJobInput): Promise<void> {
    const parsed = this.parseInput(failJobInputSchema, input, "fail input");
    const job = this.jobs.get(parsed.jobId);
    if (!job) {
      throw createJobQueueError("not_found", `Job ${parsed.jobId} not found`);
    }

    const queueState = this.queues.get(job.queue);
    if (!queueState || !queueState.inflight.has(job.id)) {
      throw createJobQueueError(
        "not_found",
        `Job ${parsed.jobId} is not in-flight`,
      );
    }

    queueState.inflight.delete(job.id);
    job.visibilityDeadline = null;

    if (job.attempts >= job.maxAttempts) {
      this.moveToDlq(job.queue, queueState, job);
      return;
    }

    const delayMs =
      parsed.retryBackoffMs ?? this.computeBackoff(job.attempts, job.backoff);
    const now = this.now();
    job.availableAt = now + delayMs;
    if (delayMs <= 0) {
      this.insertReady(queueState, job);
    } else {
      this.insertDelayed(queueState, job);
    }

    this.ensureTimer(job.queue, queueState);
  }

  async extendLease(input: ExtendLeaseInput): Promise<void> {
    const parsed = this.parseInput(
      extendLeaseInputSchema,
      input,
      "extend lease input",
    );
    const job = this.jobs.get(parsed.jobId);
    if (!job) {
      throw createJobQueueError("not_found", `Job ${parsed.jobId} not found`);
    }

    const queueState = this.queues.get(job.queue);
    if (!queueState || !queueState.inflight.has(job.id)) {
      throw createJobQueueError(
        "not_found",
        `Job ${parsed.jobId} is not in-flight`,
      );
    }

    const base = job.visibilityDeadline ?? this.now();
    job.visibilityDeadline = base + parsed.extendBySec * 1_000;
    queueState.inflight.set(job.id, job);

    this.ensureTimer(job.queue, queueState);
  }

  async peekDLQ(input: PeekDLQInput): Promise<DLQJobRecord[]> {
    const parsed = this.parseInput(peekDlqInputSchema, input, "peek DLQ input");
    const queueState = this.queues.get(parsed.queue);
    if (!queueState) {
      return [];
    }

    return queueState.dlq
      .slice(0, parsed.max)
      .map((job) => this.toDlqRecord(job));
  }

  async getJobFromDLQ(input: GetDlqJobInput): Promise<DLQJobRecord | null> {
    const parsed = this.parseInput(
      getDlqJobInputSchema,
      input,
      "get DLQ job input",
    );
    const queueState = this.queues.get(parsed.queue);
    if (!queueState) {
      return null;
    }
    const job = queueState.dlq.find((entry) => entry.id === parsed.jobId);
    return job ? this.toDlqRecord(job) : null;
  }

  async deleteFromDLQ(input: DeleteDlqJobInput): Promise<boolean> {
    const parsed = this.parseInput(
      deleteDlqJobInputSchema,
      input,
      "delete DLQ job input",
    );
    const queueState = this.queues.get(parsed.queue);
    if (!queueState) {
      return false;
    }
    const index = queueState.dlq.findIndex((job) => job.id === parsed.jobId);
    if (index === -1) {
      return false;
    }
    const [job] = queueState.dlq.splice(index, 1);
    if (job) {
      this.jobs.delete(job.id);
      this.removeIdempotency(job.id);
      return true;
    }
    return false;
  }

  async requeueFromDLQ(input: RequeueFromDLQInput): Promise<JobRef> {
    const parsed = this.parseInput(
      requeueFromDlqInputSchema,
      input,
      "requeue DLQ input",
    );
    const queueState = this.queues.get(parsed.queue);
    if (!queueState) {
      throw createJobQueueError("not_found", `Queue ${parsed.queue} not found`);
    }

    const index = queueState.dlq.findIndex((job) => job.id === parsed.jobId);
    if (index === -1) {
      throw createJobQueueError(
        "not_found",
        `Job ${parsed.jobId} not found in DLQ`,
      );
    }

    const [job] = queueState.dlq.splice(index, 1);
    if (!job) {
      throw createJobQueueError(
        "not_found",
        `Job ${parsed.jobId} not found in DLQ`,
      );
    }
    job.attempts = 0;
    job.visibilityDeadline = null;
    job.availableAt = this.now();
    job.failedAt = null;
    this.insertReady(queueState, job);
    this.ensureTimer(job.queue, queueState);
    return jobRefSchema.parse({ queue: job.queue, id: job.id, name: job.name });
  }

  async purge(input: PurgeInput): Promise<{ purged: number }> {
    const parsed = this.parseInput(purgeInputSchema, input, "purge input");
    const queueState = this.queues.get(parsed.queue);
    if (!queueState) {
      return { purged: 0 };
    }

    let purged = 0;

    switch (parsed.kind) {
      case "ready": {
        purged += queueState.ready.length;
        purged += queueState.delayed.length;
        queueState.ready.forEach((job) => this.jobs.delete(job.id));
        queueState.delayed.forEach((job) => this.jobs.delete(job.id));
        queueState.ready = [];
        queueState.delayed = [];
        if (queueState.timer) {
          clearTimeout(queueState.timer);
          queueState.timer = null;
        }
        break;
      }
      case "inflight": {
        purged += queueState.inflight.size;
        queueState.inflight.forEach((job) => this.jobs.delete(job.id));
        queueState.inflight.clear();
        break;
      }
      case "dlq": {
        purged += queueState.dlq.length;
        queueState.dlq.forEach((job) => this.jobs.delete(job.id));
        queueState.dlq = [];
        break;
      }
      default:
        break;
    }

    return { purged };
  }

  async getState(ref: JobRef): Promise<JobState> {
    const parsed = this.parseInput(jobRefSchema, ref, "job ref");
    const queueState = this.queues.get(parsed.queue);
    if (!queueState) {
      return jobStateSchema.parse("completed");
    }

    if (queueState.inflight.has(parsed.id)) {
      return jobStateSchema.parse("active");
    }

    if (queueState.dlq.some((job) => job.id === parsed.id)) {
      return jobStateSchema.parse("failed");
    }

    if (queueState.delayed.some((job) => job.id === parsed.id)) {
      return jobStateSchema.parse("delayed");
    }

    if (queueState.ready.some((job) => job.id === parsed.id)) {
      return jobStateSchema.parse("waiting");
    }

    if (this.jobs.has(parsed.id)) {
      return jobStateSchema.parse("waiting");
    }

    return jobStateSchema.parse("completed");
  }

  async getResult<T>(_ref: JobRef): Promise<T | null> {
    return null;
  }

  async remove(ref: JobRef): Promise<void> {
    const parsed = this.parseInput(jobRefSchema, ref, "remove ref");
    const queueState = this.queues.get(parsed.queue);
    if (!queueState) {
      this.jobs.delete(parsed.id);
      this.removeIdempotency(parsed.id);
      return;
    }

    queueState.inflight.delete(parsed.id);
    this.removeFromArray(queueState.ready, parsed.id);
    this.removeFromArray(queueState.delayed, parsed.id);
    this.removeFromArray(queueState.dlq, parsed.id);

    this.jobs.delete(parsed.id);
    this.removeIdempotency(parsed.id);
  }

  async initWorker(
    _args: JobQueueWorkerInitArgs,
  ): Promise<JobQueueWorkerHandle> {
    throw createJobQueueError(
      "internal",
      "InMemoryJobQueue does not support workers",
    );
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      if (queue.timer) {
        clearTimeout(queue.timer);
        queue.timer = null;
      }
      queue.ready = [];
      queue.delayed = [];
      queue.inflight.clear();
      queue.dlq = [];
    }
    this.queues.clear();
    this.jobs.clear();
    this.idempotencyCache.clear();
  }

  private getQueue(name: string): QueueState {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = {
        ready: [],
        delayed: [],
        inflight: new Map(),
        dlq: [],
        timer: null,
      };
      this.queues.set(name, queue);
    }

    return queue;
  }

  private synchronizeQueue(queueName: string, queueState: QueueState): void {
    const now = this.now();

    // Reclaim expired leases
    for (const [jobId, job] of queueState.inflight.entries()) {
      if (job.visibilityDeadline !== null && job.visibilityDeadline <= now) {
        queueState.inflight.delete(jobId);
        job.visibilityDeadline = null;
        this.insertReady(queueState, job);
      }
    }

    // Promote available delayed jobs
    while (queueState.delayed.length > 0) {
      const nextDelayed = queueState.delayed[0];
      if (!nextDelayed || nextDelayed.availableAt > now) {
        break;
      }

      const job = queueState.delayed.shift();
      if (job) {
        this.insertReady(queueState, job, false);
      }
    }

    this.ensureTimer(queueName, queueState);
  }

  private insertReady(
    queueState: QueueState,
    job: InternalJob,
    resetAvailableAt = true,
  ): void {
    if (resetAvailableAt) {
      job.availableAt = this.now();
    }

    this.removeFromArray(queueState.ready, job.id);

    let insertIndex = queueState.ready.findIndex((existing) => {
      if (existing.priority !== job.priority) {
        return existing.priority < job.priority;
      }
      if (existing.availableAt !== job.availableAt) {
        return existing.availableAt > job.availableAt;
      }
      return existing.enqueuedAt > job.enqueuedAt;
    });

    if (insertIndex === -1) {
      insertIndex = queueState.ready.length;
    }

    queueState.ready.splice(insertIndex, 0, job);
  }

  private insertDelayed(queueState: QueueState, job: InternalJob): void {
    this.removeFromArray(queueState.delayed, job.id);

    let insertIndex = queueState.delayed.findIndex((existing) => {
      if (existing.availableAt !== job.availableAt) {
        return existing.availableAt > job.availableAt;
      }
      if (existing.priority !== job.priority) {
        return existing.priority < job.priority;
      }
      return existing.enqueuedAt > job.enqueuedAt;
    });

    if (insertIndex === -1) {
      insertIndex = queueState.delayed.length;
    }

    queueState.delayed.splice(insertIndex, 0, job);
  }

  private moveToDlq(
    queueName: string,
    queueState: QueueState,
    job: InternalJob,
  ): void {
    this.removeFromArray(queueState.ready, job.id);
    this.removeFromArray(queueState.delayed, job.id);
    this.removeFromArray(queueState.dlq, job.id);
    queueState.dlq.push(job);
    job.visibilityDeadline = null;
    job.failedAt = this.now();
    this.ensureTimer(queueName, queueState);
  }

  private ensureTimer(queueName: string, queueState: QueueState): void {
    const nextTimes: number[] = [];
    const now = this.now();

    const firstDelayed = queueState.delayed[0];
    if (firstDelayed) {
      nextTimes.push(firstDelayed.availableAt);
    }

    for (const job of queueState.inflight.values()) {
      if (job.visibilityDeadline !== null) {
        nextTimes.push(job.visibilityDeadline);
      }
    }

    const nextTime = nextTimes.length > 0 ? Math.min(...nextTimes) : null;

    if (queueState.timer) {
      clearTimeout(queueState.timer);
      queueState.timer = null;
    }

    if (nextTime === null) {
      return;
    }

    const delay = Math.max(nextTime - now, 0);
    queueState.timer = setTimeout(() => {
      queueState.timer = null;
      const state = this.queues.get(queueName);
      if (!state) {
        return;
      }
      this.synchronizeQueue(queueName, state);
    }, delay);
  }

  private removeFromArray(collection: InternalJob[], jobId: string): void {
    const index = collection.findIndex((job) => job.id === jobId);
    if (index >= 0) {
      collection.splice(index, 1);
    }
  }

  private toRecord(job: InternalJob): JobRecord {
    const parsed = this.parseInput(
      jobRecordSchema,
      {
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        payload: job.payload,
        attempt: job.attempts,
        availableAt: new Date(job.availableAt).toISOString(),
        visibilityDeadline: job.visibilityDeadline
          ? new Date(job.visibilityDeadline).toISOString()
          : null,
        labels: job.labels,
      },
      "job record",
    );

    return parsed;
  }

  private toDlqRecord(job: InternalJob): DLQJobRecord {
    const ref = jobRefSchema.parse({
      queue: job.queue,
      id: job.id,
      name: job.name,
    });
    const failedAt = job.failedAt ?? this.now();
    return {
      name: job.name,
      ref,
      failedAt: new Date(failedAt).toISOString(),
      payload: job.payload,
      metadata: { ...job.labels },
      attempt: job.attempts,
    };
  }

  private computeBackoff(attempt: number, override?: JobBackoff): number {
    if (override) {
      const base = override.delayMs ?? this.baseBackoffMs;
      if (override.type === "fixed") {
        return base;
      }
      if (override.type === "exponential") {
        const exponent = Math.max(attempt - 1, 0);
        return base * 2 ** exponent;
      }
    }

    const exponent = Math.max(attempt - 1, 0);
    const baseDelay = this.baseBackoffMs * 2 ** exponent;
    if (this.jitterMs <= 0) {
      return baseDelay;
    }

    const jitter = Math.floor(Math.random() * this.jitterMs);
    return baseDelay + jitter;
  }

  private parseInput<T>(
    schema: { parse: (input: unknown) => T },
    input: unknown,
    context: string,
  ): T {
    try {
      return schema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues.map((issue) => issue.message).join(", ");
        throw createJobQueueError(
          "invalid_input",
          `${context} validation failed: ${issues}`,
        );
      }
      throw error;
    }
  }

  private now(): number {
    return this.nowFn();
  }

  private cleanupIdempotency(): void {
    const now = this.now();
    for (const [key, entry] of this.idempotencyCache.entries()) {
      if (entry.expiresAt <= now) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  private toIdempotencyCacheKey(queue: string, idempotencyKey: string): string {
    return `${queue}::${idempotencyKey}`;
  }

  private removeIdempotency(jobId: string): void {
    for (const [key, entry] of this.idempotencyCache.entries()) {
      if (entry.jobId === jobId) {
        this.idempotencyCache.delete(key);
      }
    }
  }
}
