/**
 * Redis-backed dead-letter queue for failed Stripe webhook events.
 *
 * When a webhook handler fails, the raw Stripe event is stored here so it
 * can be investigated and replayed. Events are kept for 30 days.
 *
 * Storage: Redis sorted set keyed by timestamp, individual events as hashes.
 */
import type Redis from "ioredis";

import { execOrThrow } from "@th/adapters/redis/exec-or-throw";
import type { ReporterPort } from "@th/ports/reporter";

const DLQ_INDEX_KEY = "webhook_dlq:index";
const DLQ_EVENT_PREFIX = "webhook_dlq:event:";
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_ITEMS = 500;

export interface WebhookDlqItem {
  stripeEventId: string;
  eventType: string;
  payload: string; // raw JSON
  error: string;
  receivedAt: string; // ISO
}

export class WebhookDlq {
  /**
   * `reportError` is optional: only the push path (the webhook route) passes
   * it, to report a failed post-push trim without failing the push.
   */
  constructor(
    private redis: Redis,
    private reportError?: ReporterPort,
  ) {}

  async push(item: WebhookDlqItem): Promise<void> {
    const key = `${DLQ_EVENT_PREFIX}${item.stripeEventId}`;
    const score = Date.now();

    // execOrThrow, not a bare exec(): ioredis resolves exec() even when a
    // queued command failed, so a lost event would look stored.
    await execOrThrow(
      this.redis
        .multi()
        .hset(key, {
          stripeEventId: item.stripeEventId,
          eventType: item.eventType,
          payload: item.payload,
          error: item.error,
          receivedAt: item.receivedAt,
        })
        .expire(key, TTL_SECONDS)
        .zadd(DLQ_INDEX_KEY, score, item.stripeEventId),
      "webhook dlq push",
      key,
    );

    // The event is stored at this point. A trim failure must NOT reject
    // push(): the caller logs `stripe_webhook_dlq_store_failed` (a paging
    // alert: "event lost") on rejection, and this event was not lost. Report
    // it under its own step instead. Do not log the alert strings here.
    try {
      await this.trim();
    } catch (err) {
      try {
        this.reportError?.(err, {
          tags: { area: "webhook_dlq", step: "dlq_trim" },
          extra: { step: "dlq_trim", eventId: item.stripeEventId },
        });
      } catch {
        // A throwing reporter never changes behaviour.
      }
    }
  }

  /** Trim oldest entries beyond MAX_ITEMS. */
  private async trim(): Promise<void> {
    const count = await this.redis.zcard(DLQ_INDEX_KEY);
    if (count > MAX_ITEMS) {
      const toRemove = await this.redis.zrange(
        DLQ_INDEX_KEY,
        0,
        count - MAX_ITEMS - 1,
      );
      if (toRemove.length > 0) {
        const pipeline = this.redis.multi();
        pipeline.zrem(DLQ_INDEX_KEY, ...toRemove);
        for (const id of toRemove) {
          pipeline.del(`${DLQ_EVENT_PREFIX}${id}`);
        }
        await execOrThrow(pipeline, "webhook dlq trim", DLQ_INDEX_KEY);
      }
    }
  }

  /**
   * Fetch one item by Stripe event id.
   *
   * Exists so the replay path doesn't have to `list(500)` — that ran 500
   * sequential `hgetall`s, each pulling a full raw Stripe event, just to
   * `.find()` one row, against a Redis client configured with a 500ms command
   * timeout. On the page an operator uses mid-incident.
   */
  async get(stripeEventId: string): Promise<WebhookDlqItem | null> {
    const data = await this.redis.hgetall(`${DLQ_EVENT_PREFIX}${stripeEventId}`);
    // A hash whose TTL expired leaves its id in the index but returns {} here.
    if (!data?.stripeEventId) return null;
    return data as unknown as WebhookDlqItem;
  }

  async list(limit = 50): Promise<WebhookDlqItem[]> {
    const ids = await this.redis.zrevrange(DLQ_INDEX_KEY, 0, limit - 1);
    if (ids.length === 0) return [];

    const items: WebhookDlqItem[] = [];
    for (const id of ids) {
      const data = await this.redis.hgetall(`${DLQ_EVENT_PREFIX}${id}`);
      if (data.stripeEventId) {
        items.push(data as unknown as WebhookDlqItem);
      }
    }
    return items;
  }

  async remove(stripeEventId: string): Promise<void> {
    const key = `${DLQ_EVENT_PREFIX}${stripeEventId}`;
    await execOrThrow(
      this.redis.multi().del(key).zrem(DLQ_INDEX_KEY, stripeEventId),
      "webhook dlq remove",
      key,
    );
  }

  async count(): Promise<number> {
    return this.redis.zcard(DLQ_INDEX_KEY);
  }
}
