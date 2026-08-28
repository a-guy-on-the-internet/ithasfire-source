/**
 * Strip credentials out of everything Sentry is about to send.
 *
 * PURE — no `@sentry/react-native` import — so every branch is asserted in node
 * and the scrubber can be reasoned about without a native runtime. `sentry.ts`
 * wires it into `beforeSend` / `beforeBreadcrumb`.
 *
 * ## The leak this closes
 *
 * `scan.resolvePayload` is a tRPC **`.query()`**, so its input travels in the
 * GET query string:
 *
 *     /trpc/scan.resolvePayload?batch=1&input={"0":{"eventId":"…","raw":"TKT-…"}}
 *
 * `trpc.ts`'s fetch instrumentation attaches that URL as `extra.url` on every
 * network-failure capture and as `data.url` on every non-OK breadcrumb. A
 * ticket code is a **bearer credential** (NFR-005) — anyone holding it can be
 * admitted — so a venue with flaky wifi was quietly shipping live credentials
 * into an error tracker, one per failed scan, retained for the project's issue
 * retention.
 *
 * ## Why the whole query string goes, not just `input=`
 *
 * An allowlist of "safe" params is a promise about every parameter anyone adds
 * later; a denylist of `input=` is a promise about the exact spelling tRPC uses
 * today. Neither is a promise this file can keep. **Origin + path is the whole
 * diagnostic value** of these URLs anyway — which procedure, which host, which
 * status — and the procedure name is in the path. So the query is dropped
 * wholesale, and the count of dropped params is kept so a reader can tell
 * "there was no query" from "the query was removed".
 *
 * Fragments go too: they are never on a tRPC URL, and if one ever appears it is
 * by definition something nobody audited.
 *
 * ## What is covered, precisely
 *
 * `beforeSend` is not the only exit. `sentry.ts` runs `tracesSampleRate: 1.0`
 * with `enableAutoPerformanceTracing` in production, and **transactions bypass
 * `beforeSend` entirely** — they leave through `beforeSendTransaction`. An
 * `http.client` span for a tRPC `.query()` carries the request URL in
 * `span.description` and in `http.query` / `url.query` / `http.url` attributes,
 * so the credential rides out on the performance channel with the error channel
 * sealed. Both hooks now call {@link scrubEvent}, and the walk covers:
 *
 *   - `request.url` and `request.query_string`
 *   - `extra`, `contexts`, `tags`, `breadcrumbs[].data` (any URL-ish key)
 *   - `event.message`, `breadcrumbs[].message`, `exception.values[].value`
 *   - `spans[].description` and `spans[].data`
 *
 * That is a claim about SHAPES this file walks, not a claim that no credential
 * can ever leave by another route — a payload that puts a code in a field with
 * a name nobody anticipated would still pass. The rule that keeps it honest is
 * upstream: never put a ticket code in a Sentry payload (`report.ts`).
 */

/** Marker appended when a query string was removed. */
export const SCRUBBED_QUERY_MARKER = "?<scrubbed>";

/**
 * Reduce a URL to origin + path. Returns the input unchanged when it does not
 * parse (a relative path, an already-scrubbed string) minus anything after
 * `?`/`#`, because "it didn't parse" is not a reason to send a credential.
 */
export function scrubUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;

  const cut = (raw: string): string => {
    const q = raw.search(/[?#]/);
    return q === -1 ? raw : `${raw.slice(0, q)}${SCRUBBED_QUERY_MARKER}`;
  };

  try {
    const url = new URL(value);
    const hadQuery = url.search.length > 0 || url.hash.length > 0;
    return `${url.origin}${url.pathname}${hadQuery ? SCRUBBED_QUERY_MARKER : ""}`;
  } catch {
    return cut(value);
  }
}

/** Keys whose values are URLs anywhere in the scanner's Sentry payloads. */
const URL_KEYS = new Set([
  "url",
  "URL",
  "href",
  "requestUrl",
  "request_url",
  // OTel/Sentry span attribute for an `http.client` span's full target.
  "http.url",
]);

/**
 * Keys whose value is a QUERY STRING on its own, with no origin in front of it
 * — `?batch=1&input={"0":{"raw":"tk_…"}}`, or the same thing without the
 * leading `?` (OTel's `url.query` excludes it, Sentry's `http.query` has
 * carried both).
 *
 * These get REPLACED, not `scrubUrl`'d: `scrubUrl` cuts from the first `?`, so
 * a value with no `?` in it would pass through completely untouched — which for
 * this key set means the entire credential. There is no diagnostic value in a
 * query string here anyway; the procedure name is in the path.
 */
const QUERY_KEYS = new Set(["http.query", "url.query", "query_string"]);

/**
 * Walk a plain-object payload and scrub every URL-ish string value.
 *
 * Depth-limited and cycle-safe: this runs inside `beforeSend`, on the error
 * path, in a process that is already having a bad time. It must not recurse
 * forever on a self-referencing `extra`, and it must not throw — a scrubber
 * that throws inside `beforeSend` drops the event entirely, which converts a
 * privacy fix into an observability outage.
 */
export function scrubUrlsDeep<T>(value: T, depth = 0, seen = new WeakSet()): T {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = scrubUrlsDeep(value[i], depth + 1, seen);
    }
    return value;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === "string") {
      if (QUERY_KEYS.has(key)) {
        record[key] = child.length > 0 ? SCRUBBED_QUERY_MARKER : child;
      } else if (URL_KEYS.has(key)) {
        record[key] = scrubUrl(child);
      }
      continue;
    }
    record[key] = scrubUrlsDeep(child, depth + 1, seen);
  }
  return value;
}

/**
 * Shape of the bits of a Sentry event this scrubber touches. Declared
 * structurally rather than imported so the module stays free of
 * `@sentry/react-native` (and therefore node-testable).
 */
export type ScrubbableEvent = {
  request?: {
    url?: string;
    /**
     * Sentry's HTTP interface. Carries the query on its own.
     *
     * All three arms of Sentry's own `QueryParams` are listed, including the
     * `[key, value][]` pair-array — omitting it did not make that shape
     * impossible, it made `ErrorEvent` fail this constraint, which silently
     * degraded `scrubEvent`'s return type from `T` to `ScrubbableEvent` and
     * broke the `beforeSend` signature. The value is overwritten wholesale
     * regardless of arm, so widening costs nothing at runtime.
     */
    query_string?: string | Record<string, unknown> | Array<[string, string]> | null;
  } | null;
  extra?: Record<string, unknown> | null;
  contexts?: Record<string, unknown> | null;
  /**
   * Indexed strings. Nothing in this app puts a URL in a tag — but a tag is one
   * `setTag("url", …)` away from being the leak, and walking it costs nothing.
   */
  tags?: Record<string, unknown> | null;
  breadcrumbs?: Array<{
    message?: string;
    data?: Record<string, unknown> | null;
  }> | null;
  message?: string;
  /**
   * TRANSACTION payloads. `beforeSendTransaction` hands the same envelope shape
   * as `beforeSend` plus this — one entry per span, and an `http.client` span's
   * `description` is `"GET https://api…/trpc/scan.resolvePayload?input=…"`.
   */
  spans?: Array<{
    description?: string;
    data?: Record<string, unknown> | null;
  }> | null;
  exception?: {
    /**
     * The thrown message. `trpc.ts` builds it from the request, so a URL can
     * land here even though the structured fields were clean.
     */
    values?: Array<{ value?: string }> | null;
  } | null;
};

/**
 * The instrumentation's breadcrumb message is `"GET <url> → 404"`, so the URL
 * has to come out of free text too, not only out of structured fields.
 */
export function scrubMessage(message: string): string {
  return message.replace(/https?:\/\/\S+/g, (m) => scrubUrl(m));
}

/**
 * `beforeSend` **and** `beforeSendTransaction`. Mutates and returns the event;
 * never throws.
 *
 * The two hooks share one implementation on purpose. They took different paths
 * once — only `beforeSend` was wired — and that is precisely how a sealed error
 * channel shipped alongside a wide-open performance channel.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  try {
    if (event.request?.url) event.request.url = scrubUrl(event.request.url);
    if (event.request && event.request.query_string != null) {
      // Whole value, string or parsed map: the query is never diagnostic here.
      event.request.query_string = SCRUBBED_QUERY_MARKER;
    }
    if (typeof event.message === "string") {
      event.message = scrubMessage(event.message);
    }
    if (event.extra) scrubUrlsDeep(event.extra);
    if (event.contexts) scrubUrlsDeep(event.contexts);
    if (event.tags) scrubUrlsDeep(event.tags);
    for (const crumb of event.breadcrumbs ?? []) {
      if (typeof crumb.message === "string") {
        crumb.message = scrubMessage(crumb.message);
      }
      if (crumb.data) scrubUrlsDeep(crumb.data);
    }
    for (const span of event.spans ?? []) {
      if (typeof span.description === "string") {
        span.description = scrubMessage(span.description);
      }
      if (span.data) scrubUrlsDeep(span.data);
    }
    for (const value of event.exception?.values ?? []) {
      if (typeof value.value === "string") {
        value.value = scrubMessage(value.value);
      }
    }
  } catch {
    // See the docblock: a throwing scrubber drops the event.
  }
  return event;
}

export type ScrubbableBreadcrumb = {
  message?: string;
  data?: Record<string, unknown> | null;
};

/** `beforeBreadcrumb`. Mutates and returns the crumb; never throws. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  try {
    if (typeof crumb.message === "string") {
      crumb.message = scrubMessage(crumb.message);
    }
    if (crumb.data) scrubUrlsDeep(crumb.data);
  } catch {
    // Same reasoning.
  }
  return crumb;
}
