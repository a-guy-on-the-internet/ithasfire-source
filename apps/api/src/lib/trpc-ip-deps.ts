import type { TrpcDeps } from "@th/trpc";

type GlobalRateLimitMode = NonNullable<TrpcDeps["globalRateLimitMode"]>;

/** The slice of the validated env this mapping reads. */
export type TrpcClientIpEnv = {
  ORIGIN_SHARED_SECRET?: string | null;
  TRPC_GLOBAL_RATE_LIMIT_MODE?: GlobalRateLimitMode | null;
};

export type TrpcClientIpDeps = {
  clientIpForwardSecret: string | null;
  globalRateLimitMode: GlobalRateLimitMode;
};

/**
 * Env → the client-IP fields of `TrpcDeps`. Pulled out of `buildDeps()` (which
 * needs Prisma, Redis and Stripe) so the mapping has a unit test, and shared
 * with `plugins/verified-client-ip.ts` so the tRPC context and the Fastify
 * hook verify signed forwards with the SAME secret.
 *
 * - `clientIpForwardSecret`: the web app signs the visitor's IP onto its
 *   server-to-server calls (`x-th-client-ip*`) with a key derived from
 *   ORIGIN_SHARED_SECRET — the secret the origin guard already checks, so
 *   nothing new to provision. Unset or blank → null → forwards are ignored
 *   (local dev).
 * - `globalRateLimitMode`: enforce | shadow | off for the tRPC
 *   `global:<actor>` bucket. env.ts defaults it to "shadow"; repeated here so
 *   a caller passing a partial env gets the same answer.
 */
export function trpcClientIpDepsFromEnv(env: TrpcClientIpEnv): TrpcClientIpDeps {
  const secret = env.ORIGIN_SHARED_SECRET?.trim();
  return {
    clientIpForwardSecret: secret ? secret : null,
    globalRateLimitMode: env.TRPC_GLOBAL_RATE_LIMIT_MODE ?? "shadow",
  };
}
