import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";

import type { AppRouter } from "@th/trpc";

import { getTrpcHttpUrl } from "@/config/api";
import { authClient } from "@/features/auth/better-auth-client";
import {
  getAuthToken,
  loadSessionToken,
} from "@/features/auth/auth-token-store";

export const trpc = createTRPCReact<AppRouter>();

/**
 * Inferred input/output types for every procedure in the app router.
 *
 * Usage:
 *   type EventsList = RouterOutputs["events"]["listPublic"];
 *   type EventInput = RouterInputs["events"]["getBySlug"];
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
        // DEV ONLY. This logs full response bodies, and
        // `orders.listMyOrderTickets` returns ticket codes — bearer
        // credentials that admit whoever holds them. In a release build those
        // lines become Sentry console breadcrumbs and ride along on the next
        // captured error. Do not re-enable this for production traffic.
        enabled: () => __DEV__,
        colorMode: "none",
      }),
      httpBatchLink({
        url: getTrpcHttpUrl(),
        transformer: superjson,
        headers: async () => {
          const token = await resolveAuthToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
        fetch,
      }),
    ],
  });

export const TrpcProvider = ({ children }: { children?: ReactNode }) => {
  const session = authClient.useSession();

  // Rehydrate the persisted session token before anything queries.
  //
  // It lives in the keychain, not in memory, so on a cold start `mintJwt()`
  // has nothing to send until this resolves — every authed procedure would
  // 401 and the app would look signed-out despite a valid session. Refetching
  // the session afterwards makes `useSession()` re-read now that the bearer
  // header will actually be attached. Mirrors the scanner's `useScannerSession`.
  const [tokenHydrated, setTokenHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadSessionToken().then(() => {
      if (cancelled) return;
      setTokenHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const authScope = session.isPending
    ? "pending"
    : `${session.data?.user?.id ?? "signed-out"}:${tokenHydrated ? "hydrated" : "cold"}`;
  const resolveAuthToken = useCallback<AuthTokenResolver>(
    async () => await getAuthToken(),
    [],
  );
  const queryClient = useMemo(() => createQueryClient(), [authScope]);
  const [client] = useState(() => createTrpcClient(resolveAuthToken));

  return createElement(
    trpc.Provider,
    { client, queryClient },
    createElement(QueryClientProvider, { client: queryClient }, children),
  );
};
