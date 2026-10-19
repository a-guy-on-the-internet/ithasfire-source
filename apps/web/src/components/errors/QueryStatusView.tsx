"use client";

import type { ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslations } from "@th/ui";
import { formatErrorMessage } from "@/lib/format-error-message";

/**
 * Drop-in wrapper for query-driven list/detail pages that turns a
 * react-query result into one of:
 *   - inline error banner with a Retry button (when `isError`)
 *   - whatever the page renders (otherwise)
 *
 * Console + Sentry + toast are already handled globally by
 * `GlobalQueryErrorLogger`. This component is the *page-level* surface so
 * users see a clear "something broke" instead of a misleading empty state
 * (which is the exact bug we hit on the search page when the Meilisearch
 * adapter dropped a required attribute).
 *
 * Usage:
 *   <QueryStatusView query={ordersQuery}>
 *     <OrdersList items={ordersQuery.data?.items ?? []} />
 *   </QueryStatusView>
 *
 * For surfaces that prefer a custom error layout, use the `useQueryStatus()`
 * hook directly and render whatever fits.
 */
export type QueryStatusLike = {
  isError: boolean;
  error?: unknown;
  refetch?: () => unknown;
};

export interface QueryStatusViewProps {
  query: QueryStatusLike;
  children: ReactNode;
  /** Optional override title shown above the error message. */
  errorTitle?: string;
}

export function QueryStatusView({
  query,
  children,
  errorTitle,
}: QueryStatusViewProps) {
  const t = useTranslations();

  if (!query.isError) {
    return <>{children}</>;
  }

  const message = formatErrorMessage(query.error, t);
  const titleText = errorTitle ?? "Something went wrong";
  const retryLabel = "Try again";

  return (
    <div
      role="alert"
      data-testid="query-status-error"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px 20px",
        border: "2px solid #cc3333",
        borderLeft: "4px solid #cc3333",
        fontFamily: "Inter, Helvetica, Arial, sans-serif",
        color: "var(--color, #211C16)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AlertCircle size={16} color="#cc3333" strokeWidth={2.5} />
        <strong
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {titleText}
        </strong>
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--colorMuted, #5C544A)",
        }}
      >
        {message}
      </div>
      {query.refetch && (
        <button
          type="button"
          onClick={() => {
            void query.refetch?.();
          }}
          style={{
            alignSelf: "flex-start",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            // Retry sits inside the banner on the page canvas (cream in Stub):
            // ink hairline + faint ink wash, not the retired white alphas.
            border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
            background: "var(--surfaceOverlay, rgba(33,28,22,0.04))",
            color: "inherit",
            fontFamily: "Inter, Helvetica, Arial, sans-serif",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            cursor: "pointer",
            borderRadius: 0,
          }}
        >
          <RefreshCw size={12} strokeWidth={2.5} />
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Lightweight hook that returns the boolean state + a stable retry handler.
 * Useful when a page wants to render a custom error layout but still wants
 * the boilerplate consolidation.
 */
export function useQueryStatus(query: QueryStatusLike) {
  return {
    isError: query.isError,
    error: query.error,
    retry: () => {
      void query.refetch?.();
    },
  };
}
