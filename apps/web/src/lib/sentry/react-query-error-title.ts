import { TRPCClientError } from "@trpc/client";

/**
 * Stable, **host-agnostic** classification of a failed react-query error.
 * This is the single source of truth shared by:
 *   - the capture site (`GlobalQueryErrorLogger`) — sets `trpcKind`/`apiHost`
 *     tags + an explicit Sentry `fingerprint`, and
 *   - the browser `beforeSend` (`instrumentation-client`) — rewrites the human
 *     issue title from those tags.
 *
 * Classes:
 *   - `unreachable`  — no HTTP status ever reached us (DNS/CORS/offline/CSP).
 *                      This is the "Failed to fetch" / "Load failed" bucket.
 *   - `server-5xx`   — the API answered, but with a 5xx.
 *   - `client-4xx`   — the API answered with a non-auth 4xx (auth 401/403 is
 *                      already skipped upstream before capture).
 *   - `unknown`      — not a `TRPCClientError` (thrown `select`, parse error…).
 */
export type TrpcFailureClass =
  | "unreachable"
  | "server-5xx"
  | "client-4xx"
  | "unknown";

/**
 * Derive the failure class + a best-effort API host from a query error.
 *
 * The host is intentionally kept **out** of the class (and therefore the
 * fingerprint/title) and only surfaced as a tag, so a domain rename
 * (`api-dev` → `api`) can't fork one underlying problem into two issues.
 */
export function classifyTrpcFailure(error: unknown): {
  trpcKind: TrpcFailureClass;
  apiHost: string | undefined;
} {
  if (!(error instanceof TRPCClientError)) {
    return { trpcKind: "unknown", apiHost: undefined };
  }

  const data = error.data as { httpStatus?: unknown } | null | undefined;
  const meta = error.meta as
    | { response?: { url?: unknown; status?: unknown } }
    | undefined;

  const dataStatus =
    typeof data?.httpStatus === "number" ? data.httpStatus : undefined;
  // Fallback: a gateway 5xx with a NON-JSON body (e.g. a Google GFE HTML 500
  // page) makes tRPC throw on `res.json()` before `data.httpStatus` is
  // populated — but the `Response` is still stashed on `meta.response`, so we
  // recover the real status instead of mislabelling the outage `unreachable`.
  const responseStatus =
    typeof meta?.response?.status === "number"
      ? meta.response.status
      : undefined;
  const httpStatus = dataStatus ?? responseStatus;

  let trpcKind: TrpcFailureClass;
  if (httpStatus == null || httpStatus === 0) {
    trpcKind = "unreachable";
  } else if (httpStatus >= 500) {
    trpcKind = "server-5xx";
  } else {
    // Anything else that actually reached us is a client-4xx — auth (401/403)
    // is filtered out before capture, so this is a genuine client error.
    trpcKind = "client-4xx";
  }

  // Best-effort host from the HTTP `Response` tRPC stashes on `meta` for
  // HTTP-level errors. Absent for true network failures (fetch rejects before
  // any `Response` exists), which is exactly the `unreachable` case.
  let apiHost: string | undefined;
  const responseUrl = meta?.response?.url;
  if (typeof responseUrl === "string" && responseUrl.length > 0) {
    try {
      apiHost = new URL(responseUrl).host;
    } catch {
      apiHost = undefined;
    }
  }

  return { trpcKind, apiHost };
}

/**
 * Derive a stable, **input-free** procedure path from a tRPC v11 react-query
 * key. The real key shape is `[["events", "countryEvents"], { input, type }]`
 * (see `apps/web/src/lib/feature-gates/query-key.ts`), so the path lives in the
 * FIRST element (a string-segment array); the second element carries the raw
 * `input`, which must never reach the Sentry title/fingerprint — it's PII and
 * it would fork one endpoint into a separate issue per distinct input.
 *
 * Returns e.g. `"events.countryEvents"`, or `"unknown"` for a non-conforming
 * key.
 */
export function queryPathFromKey(queryKey: unknown): string {
  if (!Array.isArray(queryKey) || !Array.isArray(queryKey[0])) {
    return "unknown";
  }
  const segments = queryKey[0].filter(
    (part): part is string => typeof part === "string",
  );
  return segments.length > 0 ? segments.join(".") : "unknown";
}

const LABEL_BY_CLASS: Record<TrpcFailureClass, string> = {
  unreachable: "API unreachable",
  "server-5xx": "API 5xx",
  "client-4xx": "API 4xx",
  unknown: "Query failed",
};

/**
 * Build the concise, host-free issue title from the classification tags.
 * Inputs are read from the Sentry event tags, so both are `string | undefined`
 * and every value is guarded. Result e.g. `API unreachable · events.list`.
 */
export function buildReactQueryTitle(input: {
  trpcKind?: string;
  queryPath?: string;
}): string {
  const label =
    input.trpcKind === "unreachable" ||
    input.trpcKind === "server-5xx" ||
    input.trpcKind === "client-4xx" ||
    input.trpcKind === "unknown"
      ? LABEL_BY_CLASS[input.trpcKind]
      : LABEL_BY_CLASS.unknown;

  return input.queryPath ? `${label} · ${input.queryPath}` : label;
}
