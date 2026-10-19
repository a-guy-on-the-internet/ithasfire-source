"use client";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "@th/trpc";

import { getTrpcHttpUrl } from "@/config/trpc";

/**
 * Scoped tRPC client for the embed widget's SIGNED-IN calls (FR-010/FR-011).
 *
 * The app-wide `trpc` react client mints its bearer token from the Better Auth
 * session COOKIE — which is a third-party cookie inside the widget iframe and
 * therefore absent. This client instead attaches the popup-handoff JWT held in
 * memory (`useEmbedAuthHandoff`) as `Authorization: Bearer`, and deliberately
 * does NOT send credentials: bearer-only, no cookie fallback.
 *
 * `getToken` is read per-request so a refreshed token (re-login after expiry)
 * is picked up without rebuilding the client. A null token sends no header —
 * the server answers UNAUTHORIZED and callers route that through
 * `markSessionExpired`.
 */
export function createEmbedAuthedClient(getToken: () => string | null) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: getTrpcHttpUrl(),
        transformer: superjson,
        headers: () => {
          const token = getToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
      }),
    ],
  });
}

export type EmbedAuthedClient = ReturnType<typeof createEmbedAuthedClient>;
