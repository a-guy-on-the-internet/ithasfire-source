import type { FastifyInstance } from "fastify";

import type { CacheGenerationPort } from "@th/ports/read-through-cache";

/**
 * E2E writes bypass the tRPC mutation path (they write through Prisma and the
 * reset `deleteMany`s whole tables), so nothing would tell the API's
 * in-process caches of anonymous reads that the data under them changed — and
 * a spec could read the pre-reset home page for up to a TTL.
 *
 * So every `POST /e2e/*` (reset and every seed; a superset on purpose) drops
 * this instance's platform-settings snapshot and bumps the shared public-read
 * generation BEFORE the response is sent (`onSend`), so the spec's next
 * request already sees fresh data. The bump never rejects.
 *
 * Registered only where the e2e routes are (non-production), and the e2e
 * barrel is wrapped in `fastify-plugin`, so this hook is app-wide: it filters
 * on the URL itself.
 */
export function registerE2ePublicReadReset(
  app: FastifyInstance,
  deps: {
    publicReadGeneration?: Pick<CacheGenerationPort, "bump"> | null;
    platformSettingsCache?: { invalidate(): void } | null;
  },
): void {
  app.addHook("onSend", async (request, _reply, payload) => {
    if (request.method === "POST" && request.url.startsWith("/e2e/")) {
      deps.platformSettingsCache?.invalidate();
      await deps.publicReadGeneration?.bump(
        `e2e:${request.routeOptions?.url ?? "unknown"}`,
      );
    }
    return payload;
  });
}
