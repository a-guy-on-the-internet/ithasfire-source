import { describe, expect, it } from "vitest";

import {
  SCRUBBED_QUERY_MARKER,
  scrubBreadcrumb,
  scrubEvent,
  scrubMessage,
  scrubUrl,
} from "./sentry-scrub";

/**
 * The leak: `scan.resolvePayload` is a tRPC `.query()`, so a ticket code — a
 * BEARER CREDENTIAL — rides in the GET query string, and `trpc.ts` attached
 * that URL to every network-failure capture (`extra.url`) and every non-OK
 * breadcrumb (`data.url`, and the crumb MESSAGE, which is `"GET <url> → 404"`).
 *
 * Every assertion below is "the code does not appear", because that is the
 * property that matters. Asserting the exact scrubbed string as well is
 * deliberate: it keeps the diagnostic value (which procedure, which host) from
 * being scrubbed away along with the credential.
 */

const CODE = "TKT-BEARER-9Z";
const RESOLVE_URL = `https://api.ithasfire.com/trpc/scan.resolvePayload?batch=1&input=%7B%220%22%3A%7B%22raw%22%3A%22${CODE}%22%7D%7D`;

describe("scrubUrl", () => {
  it("keeps origin + path and drops the query carrying the ticket code", () => {
    const out = scrubUrl(RESOLVE_URL);
    expect(out).not.toContain(CODE);
    expect(out).toBe(
      `https://api.ithasfire.com/trpc/scan.resolvePayload${SCRUBBED_QUERY_MARKER}`,
    );
  });

  it("leaves a query-less URL completely alone", () => {
    const url = "https://api.ithasfire.com/trpc/tickets.scanTicket";
    expect(scrubUrl(url)).toBe(url);
  });

  it("drops fragments too", () => {
    expect(scrubUrl("https://x.test/a#frag")).toBe(
      `https://x.test/a${SCRUBBED_QUERY_MARKER}`,
    );
  });

  it("still scrubs a string that is not a parseable URL", () => {
    // "It didn't parse" is not a reason to ship a credential.
    expect(scrubUrl(`/trpc/scan.resolvePayload?input=${CODE}`)).toBe(
      `/trpc/scan.resolvePayload${SCRUBBED_QUERY_MARKER}`,
    );
  });

  it("is a no-op on empty input", () => {
    expect(scrubUrl("")).toBe("");
  });
});

describe("scrubMessage", () => {
  it("scrubs the URL inside the fetch instrumentation's crumb message", () => {
    const out = scrubMessage(`GET ${RESOLVE_URL} → 404`);
    expect(out).not.toContain(CODE);
    expect(out).toBe(
      `GET https://api.ithasfire.com/trpc/scan.resolvePayload${SCRUBBED_QUERY_MARKER} → 404`,
    );
  });
});

describe("scrubEvent", () => {
  it("scrubs `extra.url` — the exact field trpc.ts attaches on a fetch throw", () => {
    const event = scrubEvent({
      extra: {
        url: RESOLVE_URL,
        method: "GET",
        elapsedMs: 4123,
        causeMessage: "Network request failed",
      },
    });
    expect(JSON.stringify(event)).not.toContain(CODE);
    expect(event.extra?.url).toBe(
      `https://api.ithasfire.com/trpc/scan.resolvePayload${SCRUBBED_QUERY_MARKER}`,
    );
    // Diagnostics survive.
    expect(event.extra?.method).toBe("GET");
    expect(event.extra?.elapsedMs).toBe(4123);
  });

  it("scrubs request.url, nested contexts, and attached breadcrumbs", () => {
    const event = scrubEvent({
      request: { url: RESOLVE_URL },
      contexts: { response: { url: RESOLVE_URL, status: 500 } },
      breadcrumbs: [
        { message: `GET ${RESOLVE_URL} → 500`, data: { url: RESOLVE_URL } },
      ],
    });
    expect(JSON.stringify(event)).not.toContain(CODE);
    expect(event.request?.url).not.toContain("input=");
  });

  it("survives a cyclic `extra` without hanging", () => {
    const extra: Record<string, unknown> = { url: RESOLVE_URL };
    extra.self = extra;
    const event = scrubEvent({ extra });
    expect(event.extra?.url).not.toContain(CODE);
  });

  it("scrubs a TRANSACTION's http.client spans", () => {
    /**
     * `tracesSampleRate: 1.0` + `enableAutoPerformanceTracing` ships these in
     * production, and transactions leave via `beforeSendTransaction` — they
     * never touch `beforeSend`. The error channel was sealed while the
     * performance channel carried the same credential out untouched.
     */
    const txn = scrubEvent({
      spans: [
        {
          description: `GET ${RESOLVE_URL}`,
          data: {
            "http.url": RESOLVE_URL,
            "http.query": `?batch=1&input=%7B%22raw%22%3A%22${CODE}%22%7D`,
            "http.method": "GET",
            "http.response.status_code": 500,
          },
        },
      ],
    });
    expect(JSON.stringify(txn)).not.toContain(CODE);
    // Which procedure and which host survive — that is the whole diagnostic.
    expect(txn.spans?.[0]?.description).toContain("scan.resolvePayload");
    expect(txn.spans?.[0]?.data?.["http.method"]).toBe("GET");
    expect(txn.spans?.[0]?.data?.["http.response.status_code"]).toBe(500);
  });

  it("scrubs a bare query string with NO leading `?`", () => {
    // OTel's `url.query` excludes the `?`. `scrubUrl` cuts from the first `?`,
    // so such a value would pass through completely untouched — i.e. the entire
    // credential. These keys are replaced wholesale instead.
    const txn = scrubEvent({
      spans: [{ data: { "url.query": `batch=1&input={"raw":"${CODE}"}` } }],
    });
    expect(JSON.stringify(txn)).not.toContain(CODE);
    expect(txn.spans?.[0]?.data?.["url.query"]).toBe(SCRUBBED_QUERY_MARKER);
  });

  it("scrubs request.query_string, tags and exception values", () => {
    const event = scrubEvent({
      request: { url: RESOLVE_URL, query_string: `input=${CODE}` },
      tags: { url: RESOLVE_URL, branch: "scan_resolve_failed" },
      exception: {
        values: [{ value: `Network request failed: GET ${RESOLVE_URL}` }],
      },
    });
    expect(JSON.stringify(event)).not.toContain(CODE);
    expect(event.request?.query_string).toBe(SCRUBBED_QUERY_MARKER);
    // Diagnostics survive.
    expect(event.tags?.branch).toBe("scan_resolve_failed");
    expect(event.exception?.values?.[0]?.value).toContain(
      "Network request failed",
    );
  });

  /**
   * Sentry's `QueryParams` has three arms and the pair-array is one of them.
   * `ScrubbableEvent` originally listed only the string and record forms,
   * which did not make this shape unreachable — it made `ErrorEvent` fail the
   * type constraint, which degraded `scrubEvent`'s return type and broke the
   * `beforeSend` signature. The scanner had no typecheck step, so that landed
   * unnoticed. This pins the arm that was missing.
   */
  it("scrubs a query_string given as a [key, value] pair array", () => {
    const event = scrubEvent({
      request: {
        url: RESOLVE_URL,
        query_string: [
          ["input", `{"0":{"raw":"${CODE}"}}`],
          ["batch", "1"],
        ] as Array<[string, string]>,
      },
    });
    expect(JSON.stringify(event)).not.toContain(CODE);
    expect(event.request?.query_string).toBe(SCRUBBED_QUERY_MARKER);
  });

  it("leaves an empty query string alone rather than inventing a marker", () => {
    const event = scrubEvent({ spans: [{ data: { "url.query": "" } }] });
    expect(event.spans?.[0]?.data?.["url.query"]).toBe("");
  });

  it("returns the event even when it is structurally hostile", () => {
    // A scrubber that throws inside `beforeSend` DROPS the event, turning a
    // privacy fix into an observability outage.
    const hostile = {
      get extra(): Record<string, unknown> {
        throw new Error("nope");
      },
    } as unknown as Parameters<typeof scrubEvent>[0];
    expect(() => scrubEvent(hostile)).not.toThrow();
  });
});

describe("scrubBreadcrumb", () => {
  it("scrubs both the message and data.url of a non-OK fetch crumb", () => {
    const crumb = scrubBreadcrumb({
      message: `GET ${RESOLVE_URL} → 401`,
      data: { url: RESOLVE_URL, status: 401, method: "GET" },
    });
    expect(JSON.stringify(crumb)).not.toContain(CODE);
    expect(crumb.data?.status).toBe(401);
  });

  it("leaves the scan flow's own breadcrumbs untouched", () => {
    // `report.ts` crumbs carry counts and ids only — nothing to scrub, and
    // nothing should be mangled.
    const crumb = scrubBreadcrumb({
      message: "offline_resolve.device_offline",
      data: { eventId: "evt_1", resultKind: "ticket", manifestAgeMs: 42_000 },
    });
    expect(crumb.message).toBe("offline_resolve.device_offline");
    expect(crumb.data?.manifestAgeMs).toBe(42_000);
  });
});
