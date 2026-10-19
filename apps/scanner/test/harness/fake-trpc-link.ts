/**
 * The app's REAL tRPC React client with only the network swapped for a link a
 * test answers by hand. Same approach as `features/pos/use-door-sale.test.ts`,
 * shared by the hook tests that need a query to really be pending, refused or
 * lost (`use-access-revocation.test.ts`, `use-local-sync.test.ts`).
 *
 * The importing test must mock what `src/trpc.ts` pulls in before this module
 * loads: `@sentry/react-native`, `expo-secure-store`, `expo-constants` and
 * `src/config/api`.
 *
 * No JSX: the `unit` project compiles with the classic runtime.
 */
import { createElement, useState, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";

import type { AppRouter } from "@th/trpc";

import { trpc } from "../../src/trpc";

/**
 * `request.signal` is the caller's `AbortSignal`, when it passed one
 * (`client.x.mutate(input, { signal })`). The real HTTP link aborts its fetch
 * on it; a handler here may watch it to see that the caller gave up.
 */
export type Handler = (
  input: Record<string, unknown>,
  request: { signal: AbortSignal | undefined },
) => Promise<unknown>;
/** Procedure path (`scanner.getSessionContext`) → the answer. */
export type Handlers = Record<string, Handler>;

/** A refusal as the tRPC client surfaces one: the tRPC code on `data`. */
const REFUSALS = {
  UNAUTHORIZED: { rpc: -32001, httpStatus: 401 },
  FORBIDDEN: { rpc: -32003, httpStatus: 403 },
  INTERNAL_SERVER_ERROR: { rpc: -32603, httpStatus: 500 },
} as const;

export const refusal = (code: keyof typeof REFUSALS, appCode: string) =>
  TRPCClientError.from({
    error: {
      code: REFUSALS[code].rpc,
      message: appCode,
      data: { code, httpStatus: REFUSALS[code].httpStatus, appCode },
    },
  });

/** No response at all. */
export const lostAnswer = () =>
  TRPCClientError.from(new TypeError("Network request failed"));

/** A handler whose answer the test gives later. */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const linkFor =
  (handlers: () => Handlers): TRPCLink<AppRouter> =>
  () =>
  ({ op }) =>
    observable((observer) => {
      const handler = handlers()[op.path];
      if (!handler) {
        observer.error(
          TRPCClientError.from(new Error(`no handler for ${op.path}`)),
        );
        return;
      }
      handler(op.input as Record<string, unknown>, {
        signal: op.signal ?? undefined,
      }).then(
        (data) => {
          observer.next({ result: { type: "data", data } });
          observer.complete();
        },
        (err: unknown) =>
          observer.error(
            err instanceof TRPCClientError
              ? err
              : TRPCClientError.from(
                  err instanceof Error ? err : new Error(String(err)),
                ),
          ),
      );
    });

/**
 * A `renderHook` wrapper: `trpc.Provider` + `QueryClientProvider` over the
 * given client. `handlers` is read on every call, so a test can swap answers.
 */
export const trpcWrapper =
  (queryClient: () => QueryClient, handlers: () => Handlers) =>
  ({ children }: { children?: ReactNode }) => {
    const [client] = useState(() =>
      trpc.createClient({ links: [linkFor(handlers)] }),
    );
    return createElement(trpc.Provider, {
      client,
      queryClient: queryClient(),
      children: createElement(
        QueryClientProvider,
        { client: queryClient() },
        children,
      ),
    });
  };
