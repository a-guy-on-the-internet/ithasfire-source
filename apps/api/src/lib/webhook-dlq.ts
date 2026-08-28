/**
 * Redis-backed dead-letter queue for failed Stripe webhook events.
 *
 * When a webhook handler fails, the raw Stripe event is stored here so it
 * can be investigated and replayed. Events are kept for 30 days.
 *
 * Storage: Redis sorted set keyed by timestamp, individual events as hashes.
 */
import type Redis from "ioredis";

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
  constructor(private redis: Redis) {}

  async push(item: WebhookDlqItem): Promise<void> {
    const key = `${DLQ_EVENT_PREFIX}${item.stripeEventId}`;
    const score = Date.now();

    await this.redis
      .multi()
      .hset(key, {
        stripeEventId: item.stripeEventId,
        eventType: item.eventType,
        payload: item.payload,
        error: item.error,
        receivedAt: item.receivedAt,
      })
      .expire(key, TTL_SECONDS)
      .zadd(DLQ_INDEX_KEY, score, item.stripeEventId)
      .exec();

    // Trim oldest entries beyond MAX_ITEMS
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
        await pipeline.exec();
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
    await this.redis
      .multi()
      .del(`${DLQ_EVENT_PREFIX}${stripeEventId}`)
      .zrem(DLQ_INDEX_KEY, stripeEventId)
      .exec();
  }

  async count(): Promise<number> {
    return this.redis.zcard(DLQ_INDEX_KEY);
  }
}
