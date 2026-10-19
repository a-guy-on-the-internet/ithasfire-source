"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { useNotify, useTranslations } from "@th/ui";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  classifyTrpcFailure,
  queryPathFromKey,
} from "@/lib/sentry/react-query-error-title";

type QueryErrorLike = {
  data?: { code?: string };
  message?: string;
  shape?: { message?: string; data?: { code?: string } };
};

/**
 * Global query error reporter.
 *
 * Subscribes to the react-query `QueryCache` and on every failed query:
 *   1. `console.error` — visible in DevTools immediately.
 *   2. `Sentry.captureException` — tagged with `queryPath` so it's filterable.
 *   3. **Toast notification** — surfaces the failure to the user with the
 *      same idiom as `GlobalMutationErrorNotifier`. Without this a list
 *      page that errored looked identical to one with zero results, which
 *      is exactly how the recent search-adapter regression went unnoticed
 *      until a user yelled.
 *
 * Per-query opt-out via `meta: { silent: true }`. Use this for queries
 * that fail expectedly (e.g. presence checks, optional features) so the
 * user isn't bombarded.
 *
 * Two narrower opt-outs, for queries that surface SOME failures themselves:
 *  - `meta: { silentWhen: (error) => boolean }` — skip everything (console,
 *    Sentry, toast) only for the errors the predicate claims, e.g. expected
 *    domain rejections the UI shows inline. Anything else is still reported.
 *  - `meta: { noToast: true }` — still log and report to Sentry, but never
 *    toast: the surface shows its own inline message for the failure.
 *
 * The existing `GlobalMutationErrorNotifier` covers mutations symmetrically.
 */
export function GlobalQueryErrorLogger() {
  const queryClient = useQueryClient();
  const { toast } = useNotify();
  const t = useTranslations();

  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // Dedupe rapid-fire identical errors from refetch storms.
  // - Toast: 5s window so the user sees one toast per failure burst.
  // - Sentry: 60s window so retry-driven duplicates don't burn quota
  //   (react-query retries 3x by default; tab focus + reconnect can
  //   easily produce 10+ events for a single underlying outage).
  const lastToastedRef = useRef<Map<string, number>>(new Map());
  const lastSentryRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const cache = queryClient.getQueryCache();

    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type !== "error") return;

      const query = event.query;
      const meta = query.options.meta as Record<string, unknown> | undefined;
      if (meta?.silent) return;

      const error = event.action.error;
      if (
        typeof meta?.silentWhen === "function" &&
        (meta.silentWhen as (error: unknown) => boolean)(error)
      ) {
        return;
      }
      const queryKey = query.queryKey;

      // Input-free procedure path (tRPC v11 keys are
      // `[[path…], { input, type }]`). Deriving from the whole key would
      // splice the raw `input` into the Sentry title AND the fingerprint —
      // leaking PII and forking one endpoint per distinct input.
      const queryPath = queryPathFromKey(queryKey);
      // Path segments only — never the `input`-bearing second key element.
      const queryPathSegments = Array.isArray(queryKey) ? queryKey[0] : queryKey;

      // Skip empty error objects entirely — react-query surfaces an empty
      // `{}` for cancelled / aborted requests (route change mid-fetch,
      // react strict-mode double-invoke, etc.). Logging those triggers
      // Next.js's dev error overlay for nothing actionable.
      const errorIsEmpty =
        error == null ||
        (typeof error === "object" &&
          Object.keys(error as object).length === 0 &&
          !(error instanceof Error));
      if (errorIsEmpty) return;

      // Skip auth-class failures. UNAUTHORIZED (401) means the session
      // isn't established (or just expired) — the auth UI will handle
      // it. FORBIDDEN (403) means the user is signed in but the page
      // they landed on isn't theirs to see; the page-level gate already
      // renders an unauthorized notice. Either way, a "something went
      // wrong" toast on top of that is noise.
      const errorLike = error as QueryErrorLike;
      const trpcCode = errorLike.data?.code ?? errorLike.shape?.data?.code;
      const normalizedCode = String(trpcCode ?? "")
        .trim()
        .toUpperCase();
      const rawMessage = errorLike.message ?? errorLike.shape?.message ?? "";
      const normalizedMessage = rawMessage.trim().toLowerCase();
      const isAuthError =
        normalizedCode === "UNAUTHORIZED" ||
        normalizedCode === "FORBIDDEN" ||
        normalizedMessage === "unauthorized" ||
        normalizedMessage === "forbidden";
      if (isAuthError) return;

      // 1. Console — always (devs need every event when they're debugging).
      //    Use `warn` instead of `error` so the Next.js dev overlay
      //    doesn't surface every transient network failure as a modal.
      //    The Sentry path below is still the source of truth in prod.
      console.warn("[query.error]", { queryPath, queryKey, error });

      const now = Date.now();

      // 2. Sentry — at most once per queryPath per 60s.
      const lastSentryAt = lastSentryRef.current.get(queryPath) ?? 0;
      if (now - lastSentryAt >= 60_000) {
        lastSentryRef.current.set(queryPath, now);
        const { trpcKind, apiHost } = classifyTrpcFailure(error);
        Sentry.captureException(error, {
          tags: {
            source: "react-query",
            queryPath,
            trpcKind,
            // Host is a filterable tag only — never the title/fingerprint.
            ...(apiHost ? { apiHost } : {}),
          },
          extra: {
            // Path segments only, not the full `input`-bearing key — keeps
            // raw query input out of Sentry. Triage still has trpcKind +
            // queryPath to work from.
            queryKey: queryPathSegments,
          },
          // Group PER-endpoint AND PER-class: `unreachable` and `server-5xx`
          // for the same query never merge into one issue, and grouping is
          // host-agnostic so a domain rename doesn't fork the issue.
          fingerprint: ["react-query", trpcKind, queryPath],
        });
      }

      // 3. Toast — at most once per queryPath per 5s window. Skipped when the
      //    query surfaces its own failure inline (`meta.noToast`).
      if (meta?.noToast) return;
      const lastAt = lastToastedRef.current.get(queryPath) ?? 0;
      if (now - lastAt < 5_000) return;
      lastToastedRef.current.set(queryPath, now);

      const message = formatErrorMessage(error, tRef.current);
      toastRef.current.danger({
        id: `query-error-${queryPath}-${query.queryHash}`,
        title: "Something went wrong",
        message,
      });
    });

    return unsubscribe;
  }, [queryClient]);

  return null;
}
