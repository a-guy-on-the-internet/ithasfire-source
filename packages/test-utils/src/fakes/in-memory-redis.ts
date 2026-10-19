export class InMemoryRedis {
  private hashes = new Map<string, Record<string, string>>();
  private zsets = new Map<string, Map<string, number>>();
  private sets = new Map<string, Set<string>>();

  async zincrby(key: string, inc: number, member: string) {
    const zset = this.zsets.get(key) ?? new Map();
    const next = (zset.get(member) ?? 0) + Number(inc);
    zset.set(member, next);
    this.zsets.set(key, zset);
    return String(next);
  }

  async zrange(key: string, start: number, stop: number, withScores?: string) {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    const items = Array.from(zset.entries()).sort((a, b) => a[1] - b[1]);
    const slice = items.slice(start, stop === -1 ? undefined : stop + 1);
    if (withScores === "WITHSCORES") {
      return slice.flatMap(([member, score]) => [member, String(score)]);
    }
    return slice.map(([member]) => member);
  }

  async zrevrange(
    key: string,
    start: number,
    stop: number,
    withScores?: string,
  ) {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    const items = Array.from(zset.entries()).sort((a, b) => b[1] - a[1]);
    const slice = items.slice(start, stop + 1);
    if (withScores === "WITHSCORES") {
      return slice.flatMap(([member, score]) => [member, String(score)]);
    }
    return slice.map(([member]) => member);
  }

  async zrem(key: string, member: string) {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    const existed = zset.delete(member);
    if (zset.size === 0) {
      this.zsets.delete(key);
    }
    return existed ? 1 : 0;
  }

  async zcard(key: string) {
    return this.zsets.get(key)?.size ?? 0;
  }

  async hgetall(key: string) {
    return this.hashes.get(key) ?? {};
  }

  async hset(key: string, values: Record<string, string>) {
    const existing = this.hashes.get(key) ?? {};
    const next = { ...existing, ...values };
    this.hashes.set(key, next);
    return 1;
  }

  async del(key: string) {
    this.hashes.delete(key);
    this.zsets.delete(key);
    this.sets.delete(key);
    return 1;
  }

  async expire(_key: string, _ttlSeconds: number) {
    return 1;
  }

  async sadd(key: string, member: string) {
    const set = this.sets.get(key) ?? new Set();
    set.add(member);
    this.sets.set(key, set);
    return 1;
  }

  async smembers(key: string) {
    return Array.from(this.sets.get(key) ?? []);
  }

  async srem(key: string, member: string) {
    const set = this.sets.get(key);
    if (!set) return 0;
    const existed = set.delete(member);
    if (set.size === 0) {
      this.sets.delete(key);
    }
    return existed ? 1 : 0;
  }

  async scan(_cursor: string, _matchToken: string, pattern: string) {
    const prefix = pattern.replace(/\*$/, "");
    const keys = Array.from(this.zsets.keys()).filter((key) =>
      key.startsWith(prefix),
    );
    return ["0", keys] as [string, string[]];
  }

  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const builder = {
      zincrby: (key: string, inc: number, member: string) => {
        ops.push(() => this.zincrby(key, inc, member));
        return builder;
      },
      zrem: (key: string, member: string) => {
        ops.push(() => this.zrem(key, member));
        return builder;
      },
      hset: (key: string, values: Record<string, string>) => {
        ops.push(() => this.hset(key, values));
        return builder;
      },
      del: (key: string) => {
        ops.push(() => this.del(key));
        return builder;
      },
      expire: (key: string, ttl: number) => {
        ops.push(() => this.expire(key, ttl));
        return builder;
      },
      sadd: (key: string, member: string) => {
        ops.push(() => this.sadd(key, member));
        return builder;
      },
      async exec() {
        const results: unknown[] = [];
        for (const op of ops) {
          results.push(await op());
        }
        return results;
      },
    };
    return builder;
  }

  async flushall() {
    this.hashes.clear();
    this.zsets.clear();
    this.sets.clear();
  }

  async quit() {
    await this.flushall();
  }
}
