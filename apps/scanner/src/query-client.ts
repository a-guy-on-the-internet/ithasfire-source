import { QueryClient } from "@tanstack/react-query";

/**
 * The app's React Query defaults, in a module of their own so a test can
 * build the SAME client the app runs on (`trpc.ts` pulls in Sentry, SecureStore
 * and the API config; this pulls in nothing).
 *
 * `mutations.retry: 1` is a default, not a rule: a mutation sent under an
 * idempotency key must opt out (see `SALE_MUTATION_OPTIONS` in
 * `features/pos/sale-attempt.ts`).
 */
export const createQueryClient = () =>
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
