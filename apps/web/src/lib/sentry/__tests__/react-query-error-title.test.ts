import { describe, expect, it } from "vitest";
import { TRPCClientError } from "@trpc/client";

import {
  buildReactQueryTitle,
  classifyTrpcFailure,
  queryPathFromKey,
} from "../react-query-error-title";

/**
 * Build a `TRPCClientError` with a given server-answered `data` payload and
 * optional `meta.response`, mirroring how tRPC's httpBatchLink constructs one.
 * `responseStatus` models the non-JSON gateway case: tRPC has a `Response` on
 * `meta` but never populated `data.httpStatus` (json() threw on an HTML body).
 */
function makeTrpcError(opts?: {
  httpStatus?: number;
  responseUrl?: string;
  responseStatus?: number;
}): TRPCClientError<never> {
  const err = Object.create(TRPCClientError.prototype) as {
    data?: unknown;
    meta?: unknown;
    message: string;
  };
  err.message = "boom";
  err.data =
    opts?.httpStatus === undefined ? undefined : { httpStatus: opts.httpStatus };
  const response =
    opts?.responseUrl !== undefined || opts?.responseStatus !== undefined
      ? {
          ...(opts?.responseUrl !== undefined ? { url: opts.responseUrl } : {}),
          ...(opts?.responseStatus !== undefined
            ? { status: opts.responseStatus }
            : {}),
        }
      : undefined;
  err.meta = response ? { response } : undefined;
  return err as unknown as TRPCClientError<never>;
}

describe("classifyTrpcFailure", () => {
  it("classifies a fetch failure with no httpStatus as unreachable", () => {
    // True network failure: fetch rejects, tRPC has no `data`, no `Response`.
    expect(classifyTrpcFailure(makeTrpcError())).toEqual({
      trpcKind: "unreachable",
      apiHost: undefined,
    });
  });

  it("treats httpStatus 0 as unreachable", () => {
    expect(classifyTrpcFailure(makeTrpcError({ httpStatus: 0 })).trpcKind).toBe(
      "unreachable",
    );
  });

  it("classifies a 5xx as server-5xx and parses the host from the response", () => {
    const result = classifyTrpcFailure(
      makeTrpcError({
        httpStatus: 503,
        responseUrl: "https://api-dev.ithasfire.com/trpc/events.list?batch=1",
      }),
    );
    expect(result.trpcKind).toBe("server-5xx");
    expect(result.apiHost).toBe("api-dev.ithasfire.com");
  });

  it("classifies a non-auth 4xx as client-4xx", () => {
    expect(
      classifyTrpcFailure(makeTrpcError({ httpStatus: 400 })).trpcKind,
    ).toBe("client-4xx");
    expect(
      classifyTrpcFailure(makeTrpcError({ httpStatus: 404 })).trpcKind,
    ).toBe("client-4xx");
  });

  it("classifies a non-TRPCClientError as unknown", () => {
    expect(classifyTrpcFailure(new Error("select threw"))).toEqual({
      trpcKind: "unknown",
      apiHost: undefined,
    });
    expect(classifyTrpcFailure(undefined).trpcKind).toBe("unknown");
    expect(classifyTrpcFailure({}).trpcKind).toBe("unknown");
  });

  it("swallows a malformed response url rather than throwing", () => {
    const result = classifyTrpcFailure(
      makeTrpcError({ httpStatus: 500, responseUrl: "::::not a url::::" }),
    );
    expect(result.trpcKind).toBe("server-5xx");
    expect(result.apiHost).toBeUndefined();
  });

  it("recovers a non-JSON gateway 5xx from meta.response.status (no data.httpStatus)", () => {
    // Real outage shape: gateway returns an HTML 500 page, tRPC throws on
    // res.json() so `data.httpStatus` is absent — but the Response is on meta.
    const result = classifyTrpcFailure(
      makeTrpcError({
        responseStatus: 500,
        responseUrl: "https://api-dev.ithasfire.com/trpc/events.list",
      }),
    );
    expect(result.trpcKind).toBe("server-5xx");
    expect(result.apiHost).toBe("api-dev.ithasfire.com");
  });

  it("recovers a non-JSON 4xx from meta.response.status", () => {
    expect(
      classifyTrpcFailure(makeTrpcError({ responseStatus: 429 })).trpcKind,
    ).toBe("client-4xx");
  });
});

describe("queryPathFromKey", () => {
  it("derives an input-free path from the real tRPC v11 key shape", () => {
    const result = queryPathFromKey([
      ["events", "countryEvents"],
      { input: { countryCode: "US" }, type: "query" },
    ]);
    expect(result).toBe("events.countryEvents");
    // Hard assertion: raw input must never leak into the path (→ title/fp).
    expect(result).not.toContain("US");
    expect(result).not.toContain("countryCode");
    expect(result).not.toContain("input");
  });

  it("handles a no-input key (`[[path…], { type }]`)", () => {
    expect(
      queryPathFromKey([["features", "getFeatureGates"], { type: "query" }]),
    ).toBe("features.getFeatureGates");
  });

  it("handles a single-segment path", () => {
    expect(queryPathFromKey([["health"], { type: "query" }])).toBe("health");
  });

  it("falls back to 'unknown' for non-conforming / garbage keys", () => {
    expect(queryPathFromKey(["events", "countryEvents"])).toBe("unknown");
    expect(queryPathFromKey([])).toBe("unknown");
    expect(queryPathFromKey([[]])).toBe("unknown");
    expect(queryPathFromKey(undefined)).toBe("unknown");
    expect(queryPathFromKey("events.countryEvents")).toBe("unknown");
  });
});

describe("buildReactQueryTitle", () => {
  it("builds descriptive, host-free titles per class", () => {
    expect(
      buildReactQueryTitle({
        trpcKind: "unreachable",
        queryPath: "events.eventsForMapOverview",
      }),
    ).toBe("API unreachable · events.eventsForMapOverview");
    expect(
      buildReactQueryTitle({ trpcKind: "server-5xx", queryPath: "events.list" }),
    ).toBe("API 5xx · events.list");
    expect(
      buildReactQueryTitle({ trpcKind: "client-4xx", queryPath: "orders.byId" }),
    ).toBe("API 4xx · orders.byId");
  });

  it("falls back to 'Query failed' for unknown/missing class", () => {
    expect(buildReactQueryTitle({ trpcKind: "unknown", queryPath: "x" })).toBe(
      "Query failed · x",
    );
    expect(buildReactQueryTitle({ trpcKind: undefined, queryPath: "x" })).toBe(
      "Query failed · x",
    );
    expect(buildReactQueryTitle({ trpcKind: "garbage", queryPath: "x" })).toBe(
      "Query failed · x",
    );
  });

  it("omits the separator when queryPath is missing", () => {
    expect(buildReactQueryTitle({ trpcKind: "server-5xx" })).toBe("API 5xx");
  });
});
