import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";

export interface RedisTestContainer {
  /** `null` when running against a reused host Redis (see below). */
  container: StartedRedisContainer | null;
  connectionUri: string;
  host: string;
  port: number;
  stop: () => Promise<void>;
}

export interface StartRedisOptions {
  image?: string;
}

/**
 * Returns a usable host Redis connection string when the runtime opts into
 * reuse instead of Testcontainers. Mirrors `resolveReusableHostPg` in
 * `./postgres.ts`, and exists for the same reason: CI runners (Forgejo,
 * GitHub Actions) provide service containers but cannot reach
 * Docker-in-Docker / the Testcontainers Reaper, so a bare Testcontainers
 * start there hangs and then fails.
 *
 * Honors:
 *  - `TESTCONTAINERS_REUSE_REDIS_URL` — explicit opt-in for any context.
 *  - `CI=true` + `REDIS_URL` — a CI runner that already declares a Redis
 *    service.
 *
 * Returns `undefined` when the helper should fall back to Testcontainers.
 */
function resolveReusableHostRedis(): string | undefined {
  const explicit = process.env.TESTCONTAINERS_REUSE_REDIS_URL?.trim();
  if (explicit) return explicit;
  const ci = process.env.CI?.toLowerCase();
  if ((ci === "true" || ci === "1") && process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }
  return undefined;
}

export async function startRedisContainer(
  options: StartRedisOptions = {},
): Promise<RedisTestContainer> {
  const reuseUrl = resolveReusableHostRedis();
  if (reuseUrl) {
    const url = new URL(reuseUrl);
    return {
      container: null,
      connectionUri: reuseUrl,
      host: url.hostname,
      port: Number(url.port || 6379),
      // Nothing to tear down — the server is shared and outlives the run.
      // Callers MUST namespace their keys (a random per-run prefix) so a
      // reused instance can't leak state between suites.
      stop: async () => {},
    };
  }

  const { image = "redis:7-alpine" } = options;

  const container = await new RedisContainer(image).withReuse().start();
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  const connectionUri = `redis://${host}:${port}`;

  return {
    container,
    connectionUri,
    host,
    port,
    stop: async () => {
      await container.stop();
    },
  };
}
