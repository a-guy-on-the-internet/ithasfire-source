import { createElement, useCallback, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import * as Sentry from "@sentry/react-native";

import type { AppRouter } from "@th/trpc";

import { getTrpcHttpUrl } from "./config/api";
import { getAuthToken } from "./features/auth/auth-token-store";
import { notifyAuthInvalidated } from "./features/auth/auth-invalidation-bus";

/**
 * Wrap `fetch` so:
 *  - any 401 response triggers the auth-invalidation bus. Subscribers
 *    (currently `useScannerSession`) react by calling `signOut`, which
 *    wipes local SQLite + clears the auth token. This is how server-side
 *    session revocation propagates to the device — no polling needed.
 *  - network-level throws (DNS failure, TLS error, no connectivity)
 *    are reported to Sentry with the URL, method, and elapsed time
 *    attached as `extra`. Without this the only signal is a stack
 *    inside Hermes bytecode that symbolicates to `anonymous`.
 */
// Captured once. `httpBatchLink({ url })` reads its `url` property at
// link construction — there is no function form in this tRPC version
// — so the wrapper below rewrites any URL still pointing at this base
// to the *current* base from `getTrpcHttpUrl()`. That decouples the
// Settings → Developer preset flip from app restarts.
const pinnedBaseUrl = getTrpcHttpUrl();

const trpcFetchWithDynamicBase: typeof fetch = async (input, init) => {
  const currentBase = getTrpcHttpUrl();
  if (currentBase !== pinnedBaseUrl) {
    if (typeof input === "string" && input.startsWith(pinnedBaseUrl)) {
      input = currentBase + input.slice(pinnedBaseUrl.length);
    } else if (
      input instanceof URL &&
      input.toString().startsWith(pinnedBaseUrl)
    ) {
      input = new URL(
        currentBase + input.toString().slice(pinnedBaseUrl.length),
      );
    } else if (
      typeof input !== "string" &&
      !(input instanceof URL) &&
      input.url.startsWith(pinnedBaseUrl)
    ) {
      input = new Request(
        currentBase + input.url.slice(pinnedBaseUrl.length),
        input,
      );
    }
  }
  return fetchWithInstrumentation(input, init);
};

const fetchWithInstrumentation: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method =
    init?.method ??
    (typeof input !== "string" && !(input instanceof URL)
      ? input.method
      : "GET") ??
    "GET";
  const startedAt = Date.now();
  try {
    const response = await fetch(input, init);
    if (response.status === 401) {
      notifyAuthInvalidated();
    }
    if (!response.ok) {
      Sentry.addBreadcrumb({
        category: "fetch",
        type: "http",
        level: response.status >= 500 ? "error" : "warning",
        message: `${method} ${url} → ${response.status}`,
        data: {
          status: response.status,
          url,
          method,
          elapsedMs: Date.now() - startedAt,
        },
      });
    }
    return response;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { fetch_failure: "network" },
      extra: {
        url,
        method,
        elapsedMs: Date.now() - startedAt,
        // Surface the cause chain — RN's TypeError("Network request failed")
        // hides underlying NSURLError / Java IOException details here.
        causeName: err instanceof Error ? err.name : typeof err,
        causeMessage: err instanceof Error ? err.message : String(err),
      },
    });
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.error(
        `[fetch] ${method} ${url} threw after ${Date.now() - startedAt}ms`,
        err,
      );
    }
    throw err;
  }
};

export const trpc = createTRPCReact<AppRouter>();

/**
 * Inferred input/output types for every procedure in the app router.
 * Prefer these over hand-rolled shapes so router drift is caught by tsc.
 *
 * Usage:
 *   type TicketScanResult = RouterOutputs["tickets"]["scanTicket"];
 *   type VolunteerCandidate = RouterOutputs["volunteer"]["signups"]["searchForCheckIn"][number];
 */
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 1,
      },
    },
  });

type AuthTokenResolver = () => Promise<string | null>;

const createTrpcClient = (resolveAuthToken: AuthTokenResolver) =>
  trpc.createClient({
    links: [
      loggerLink({
        // Silence expected FORBIDDEN responses (e.g. operator without
        // SCANNER role hitting scanner.* — surfaced via the AccessDenied
        // screen). They aren't bugs and just clutter the dev log.
        enabled: (op) => {
          if (!__DEV__ && op.direction !== "down") return false;
          if (op.direction === "down" && op.result instanceof Error) {
            const code = (op.result as { data?: { code?: string } }).data?.code;
            if (code === "FORBIDDEN") return false;
          }
          return true;
        },
        colorMode: "none",
      }),
      httpBatchLink({
        // Captured at link construction. The real per-request URL is
        // re-resolved inside our `fetch` wrapper so a Settings →
        // Developer preset flip (Localhost ↔ api-dev) takes effect on
        // the *next* batch without an app restart — otherwise the
        // bearer minted against the new origin gets posted to the old
        // origin and 401s.
        url: pinnedBaseUrl,
        transformer: superjson,
        headers: async () => {
          const token = await resolveAuthToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
        fetch: trpcFetchWithDynamicBase,
      }),
    ],
  });

export const TrpcProvider = ({ children }: { children?: ReactNode }) => {
  const resolveAuthToken = useCallback<AuthTokenResolver>(
    async () => await getAuthToken(),
    [],
  );
  const [queryClient] = useState(createQueryClient);
  const [client] = useState(() => createTrpcClient(resolveAuthToken));

  return createElement(trpc.Provider, {
    client,
    queryClient,
    children: createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    ),
  });
};
