import { describe, expect, it, vi } from "vitest";

import { InMemoryJobQueue } from "../../src/queue/in-memory-job-queue";
import {
  JOB_QUEUE_DEFAULT_DEDUPE_TTL_SEC,
  type JobQueuePort,
} from "@th/ports/job-queue";

const flushAllTimers = async () => {
  await vi.runAllTimersAsync();
};

describe("InMemoryJobQueue", () => {
  it("enqueues and dequeues respecting priority and delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    try {
      const queue: JobQueuePort = new InMemoryJobQueue({ jitterMs: 0 });

      await queue.enqueue({
        queue: "jobs",
        name: "low",
        payload: { value: 1 },
      });

      await queue.enqueue({
        queue: "jobs",
        name: "delayed",
        payload: { value: 2 },
        delayMs: 10_000,
      });

      await queue.enqueue({
        queue: "jobs",
        name: "high",
        payload: { value: 3 },
        priority: 5,
      });

      const immediate = await queue.dequeue({ queue: "jobs", max: 2 });
      const names = immediate.map(
        (job: (typeof immediate)[number]) => job.name,
      );
      expect(names).toEqual(["high", "low"]);

      await vi.advanceTimersByTimeAsync(10_000);
      const delayed = await queue.dequeue({ queue: "jobs", max: 2 });
      expect(delayed).toHaveLength(1);
      expect(delayed[0]?.name).toBe("delayed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries with backoff and moves job to DLQ after max attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    try {
      const queue = new InMemoryJobQueue({
        maxAttempts: 3,
        baseBackoffMs: 10,
        jitterMs: 0,
      });

      await queue.enqueue({
        queue: "tasks",
        name: "retry-me",
        payload: { tries: 0 },
      });

      for (let attempt = 1; attempt <= 3; attempt++) {
        const [job] = await queue.dequeue({
          queue: "tasks",
          visibilityTimeoutSec: 1,
        });
        expect(job).toBeDefined();
        if (!job) {
          throw new Error("Expected job to be dequeued");
        }

        expect(job.attempt).toBe(attempt);
        await queue.fail({ jobId: job.jobId });

        if (attempt < 3) {
          const backoff = 10 * 2 ** (attempt - 1);
          await vi.advanceTimersByTimeAsync(backoff);
        }
      }

      await flushAllTimers();

      const dlqJobs = await queue.peekDLQ({ queue: "tasks", max: 10 });
      expect(dlqJobs).toHaveLength(1);
      expect(dlqJobs[0]?.attempt).toBe(3);
      expect(dlqJobs[0]?.name).toBe("retry-me");
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends leases to avoid duplicate delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    try {
      const queue = new InMemoryJobQueue({ jitterMs: 0 });

      await queue.enqueue({ queue: "mail", name: "send", payload: { id: 1 } });

      const [first] = await queue.dequeue({
        queue: "mail",
        visibilityTimeoutSec: 5,
      });
      expect(first).toBeDefined();
      if (!first) {
        throw new Error("Expected first job to exist");
      }

      await vi.advanceTimersByTimeAsync(4_000);
      await queue.extendLease({ jobId: first.jobId, extendBySec: 10 });

      await vi.advanceTimersByTimeAsync(3_000);
      const nothingYet = await queue.dequeue({ queue: "mail", max: 1 });
      expect(nothingYet).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(8_000);
      const [redelivered] = await queue.dequeue({ queue: "mail", max: 1 });
      expect(redelivered).toBeDefined();
      if (!redelivered) {
        throw new Error("Expected redelivery");
      }
      expect(redelivered.jobId).toBe(first.jobId);
      expect(redelivered.attempt).toBe(2);

      await queue.ack({ jobId: redelivered.jobId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports idempotent enqueue, DLQ requeue, and purge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    try {
      const queue = new InMemoryJobQueue({
        maxAttempts: 2,
        baseBackoffMs: 5,
        jitterMs: 0,
      });

      const first = await queue.enqueue({
        queue: "jobs",
        name: "dedupe",
        payload: { id: 1 },
        idempotencyKey: "dedupe-key",
      });

      const second = await queue.enqueue({
        queue: "jobs",
        name: "dedupe",
        payload: { id: 1 },
        idempotencyKey: "dedupe-key",
      });

      expect(second.jobId).toBe(first.jobId);

      const [job] = await queue.dequeue({ queue: "jobs" });
      expect(job).toBeDefined();
      if (!job) {
        throw new Error("Expected job for retry");
      }
      await queue.fail({ jobId: job.jobId, retryBackoffMs: 0 });
      await flushAllTimers();

      const [jobAgain] = await queue.dequeue({ queue: "jobs" });
      expect(jobAgain).toBeDefined();
      if (!jobAgain) {
        throw new Error("Expected retry job");
      }
      expect(jobAgain.attempt).toBe(2);
      await queue.fail({ jobId: jobAgain.jobId, retryBackoffMs: 0 });

      await flushAllTimers();

      const dlqBefore = await queue.peekDLQ({ queue: "jobs" });
      expect(dlqBefore).toHaveLength(1);

      await queue.requeueFromDLQ({ queue: "jobs", jobId: jobAgain.jobId });

      const [requeued] = await queue.dequeue({ queue: "jobs" });
      expect(requeued).toBeDefined();
      if (!requeued) {
        throw new Error("Expected requeued job");
      }
      expect(requeued.attempt).toBe(1);
      await queue.ack({ jobId: requeued.jobId });

      await queue.enqueue({ queue: "jobs", name: "to-purge", payload: null });

      const purgeResult = await queue.purge({ queue: "jobs", kind: "ready" });
      expect(purgeResult.purged).toBe(1);

      const afterPurge = await queue.dequeue({ queue: "jobs" });
      expect(afterPurge).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(
        JOB_QUEUE_DEFAULT_DEDUPE_TTL_SEC * 1_000 + 1,
      );

      const third = await queue.enqueue({
        queue: "jobs",
        name: "dedupe",
        payload: { id: 1 },
        idempotencyKey: "dedupe-key",
      });
      expect(third.jobId).not.toBe(first.jobId);
    } finally {
      vi.useRealTimers();
    }
  });
});
