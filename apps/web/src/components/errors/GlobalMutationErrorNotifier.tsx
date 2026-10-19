"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNotify, useTranslations } from "@th/ui";
import { formatErrorMessage } from "@/lib/format-error-message";

/**
 * Global mutation error notifier.
 *
 * Subscribes to the react-query `MutationCache` and fires a danger toast for
 * every mutation failure that doesn't carry `meta.silent`.
 *
 * Must render inside *both* `TrpcProvider` (QueryClientProvider) and
 * `NotificationProvider` so it can access the query client and the toast system.
 *
 * ## Silencing specific mutations
 *
 * Pass `meta: { silent: true }` in the `useMutation` options to suppress the
 * global toast for a particular call:
 *
 * ```ts
 * trpc.foo.bar.useMutation({ meta: { silent: true } });
 * ```
 *
 * Or `meta: { silentWhen: (error) => boolean }` to suppress it only for the
 * errors the call site shows itself:
 *
 * ```ts
 * trpc.foo.bar.useMutation({ meta: { silentWhen: isEmailVerificationRequired } });
 * ```
 */
export function GlobalMutationErrorNotifier() {
  const queryClient = useQueryClient();
  const { toast } = useNotify();
  const t = useTranslations();

  // Keep toast in a ref so the subscription callback never goes stale.
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    const cache = queryClient.getMutationCache();

    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;

      const mutation = event.mutation;
      const meta = mutation.options.meta as Record<string, unknown> | undefined;

      // Allow individual mutations to opt out of the global toast.
      if (meta?.silent) return;

      const error = event.action.error;

      // Narrower opt-out, same contract as GlobalQueryErrorLogger: skip only
      // the errors the predicate claims (the surface shows those inline).
      if (
        typeof meta?.silentWhen === "function" &&
        (meta.silentWhen as (error: unknown) => boolean)(error)
      ) {
        return;
      }
      const message = formatErrorMessage(error, tRef.current);

      toastRef.current.danger({
        id: `mutation-error-${mutation.mutationId}`,
        title: String(tRef.current("common.actionFailed")),
        message,
      });
    });

    return unsubscribe;
  }, [queryClient]);

  return null;
}
