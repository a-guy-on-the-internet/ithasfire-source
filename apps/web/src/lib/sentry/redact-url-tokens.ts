import { isLocationSensitiveKey } from "@th/errors/scrub-location-pii";

/**
 * Bearer tokens ride in some of our URLs' query strings — invitation accept
 * pages (`/invite/accept?token=`, `/delegate/accept?token=`), claim links,
 * unsubscribe links. The browser SDK copies the full URL into the event's
 * `request.url`, navigation/fetch breadcrumbs and transaction span data, and
 * `sendDefaultPii: false` does NOT strip query strings. These helpers redact
 * the VALUE of any `…token=` or `…secret=` parameter wherever a URL can
 * appear, so an error report can never carry a live credential.
 *
 * `…secret=` covers Stripe's redirect return
 * (`?payment_intent_client_secret=pi_X_secret_Y`): the checkout and embed
 * keep that URL on screen until the payment settles, and a client secret
 * reads and confirms its PaymentIntent. Any bare `pi_…_secret_…` /
 * `seti_…_secret_…` string is redacted too, wherever the scrubber looks.
 *
 * `…signature=` / `…credential=` cover signed storage links: a GCS or S3 V4
 * link (`X-Goog-Signature`, `X-Goog-Credential`, `X-Amz-Signature`,
 * `X-Amz-Credential`) reads the object until it expires, and the admin seat
 * map fetches one, so it lands in a fetch breadcrumb.
 *
 * Geocoder URLs also lose the address or point they look up (see
 * `GEOCODER_URL`).
 *
 * Pure and never throwing: they run inside `beforeSend` /
 * `beforeBreadcrumb` / `beforeSendTransaction`, which must not throw.
 */

/**
 * `?token=` / `&claim_token=` / `#invite-token=` /
 * `&payment_intent_client_secret=` … (query AND fragment), and the gated-event
 * invite link's `?invite=<token>` (the page strips it on load, but the
 * pageload transaction and the replaceState breadcrumb still saw it).
 */
const TOKEN_PARAM =
  /([?&#](?:[a-z_-]*(?:token|secret|signature|credential)|invite)=)[^&#\s"'<>]+/gi;
/**
 * The same parameter URL-ENCODED inside another URL — e.g. the sign-in
 * redirect `?redirect=%2Finvite%2Faccept%3Ftoken%3DT`. `%3F` = `?`,
 * `%26` = `&`, `%23` = `#`, `%3D` = `=`.
 */
const ENCODED_TOKEN_PARAM =
  /((?:%3F|%26|%23)(?:[a-z_-]*(?:token|secret|signature|credential)|invite)%3D)[^&%#\s"'<>]+/gi;
/**
 * A Stripe client secret anywhere in a string (`pi_X_secret_Y`,
 * `seti_X_secret_Y`), whatever carries it: keeps the object id, drops the
 * secret part.
 */
const STRIPE_CLIENT_SECRET = /\b((?:pi|seti)_[A-Za-z0-9]+_secret_)[A-Za-z0-9]+/g;
/**
 * A gated-event invite token anywhere in a string, whatever carries it:
 * `inv_<invite uuid>_<43-char base64url MAC>` (packages/core/src/lib/
 * security/invite-token.ts). The backstop for places no `invite=` parameter
 * rule sees, e.g. Next's segment key `__PAGE__?{"invite":"inv_…"}` in a
 * message or breadcrumb. Keeps the prefix and invite id, drops the MAC.
 * No leading `\b`: URL-encoded JSON puts `%22` right before it (`2i` is no
 * word boundary); the uuid-plus-underscore shape is specific enough alone.
 */
const INVITE_TOKEN =
  /(inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_)[A-Za-z0-9_-]+/gi;
export const REDACTED = "[redacted]";

/**
 * A geocoder request URL (`apps/web/src/lib/maps/geocoding.ts`: Geoapify
 * search, autocomplete and reverse). Its query is the address someone typed
 * (`text=`) or the point being looked up (`lat=` / `lon=`), and the fetch
 * breadcrumb and span copy it whole. Scoped to the geocoder host: our own
 * search page keeps `?q=` / `?lat=` for triage.
 */
const GEOCODER_URL = /\bapi\.geoapify\.com\/[^\s"'<>]*/gi;
/** The location-bearing parameters of a {@link GEOCODER_URL}. */
const GEOCODER_LOCATION_PARAM =
  /([?&](?:text|lat|lon|lng|q|address|postcode)=)[^&#\s"'<>]*/gi;

/**
 * A tRPC query's `input=` parameter (httpBatchLink sends queries over GET, so
 * the URL-encoded JSON input rides in the fetch breadcrumb and span URL).
 */
const TRPC_INPUT_PARAM = /([?&]input=)([^&#\s"'<>]*)/gi;
/** A JSON object key (`"lat":`) inside a decoded tRPC input; bounded length keeps the scan linear. */
const JSON_KEY = /"((?:[^"\\]|\\.){1,64})"\s*:/g;

/**
 * Drops a tRPC `input=` value whose JSON names a location key (`lat`, `lng`,
 * `addressLine1`, ... at any depth, e.g. inside `destination`), so a place's
 * exact point never reaches Sentry. Fails closed: an input that does not
 * decode is dropped too. Inputs with no location key are kept for triage.
 */
function redactLocationInput(value: string): string {
  return value.replace(
    TRPC_INPUT_PARAM,
    (match, prefix: string, raw: string) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        return `${prefix}${REDACTED}`;
      }
      for (const m of decoded.matchAll(JSON_KEY)) {
        if (isLocationSensitiveKey(m[1] ?? "")) return `${prefix}${REDACTED}`;
      }
      return match;
    },
  );
}

/**
 * True when a span is a Geoapify request, judged by any of its host-bearing
 * fields. Its `http.query` attribute has no host of its own, so
 * {@link GEOCODER_URL} cannot match it.
 */
function isGeocoderSpan(span: {
  data?: Record<string, unknown>;
  description?: string;
}): boolean {
  const d = span.data ?? {};
  return [d["server.address"], d["url"], d["http.url"], span.description].some(
    (v) => typeof v === "string" && /\bapi\.geoapify\.com\b/i.test(v),
  );
}

export function redactUrlTokens(value: string): string {
  return redactLocationInput(value)
    .replace(GEOCODER_URL, (url) =>
      url.replace(GEOCODER_LOCATION_PARAM, `$1${REDACTED}`),
    )
    .replace(TOKEN_PARAM, `$1${REDACTED}`)
    .replace(ENCODED_TOKEN_PARAM, `$1${REDACTED}`)
    .replace(STRIPE_CLIENT_SECRET, `$1${REDACTED}`)
    .replace(INVITE_TOKEN, `$1${REDACTED}`);
}

function redactUnknown(value: unknown): unknown {
  return typeof value === "string" ? redactUrlTokens(value) : value;
}

/**
 * `…token` / `…secret` / `…signature` / `…credential` keys, and the invite
 * link's exact `invite` key.
 */
const TOKEN_KEY = /(?:token|secret|signature|credential)$|^invite$/i;
const MAX_DEPTH = 4;

/**
 * Redacts every string reachable from `record`: own string values, array
 * members (console breadcrumbs carry `data.arguments` as an array) and nested
 * objects, to `MAX_DEPTH` levels (a cap that also bounds cyclic structures).
 * With `byKey`, a string under a `…token` / `…secret` key is dropped whole —
 * for stack-frame `vars`, where a credential sits in a variable, not a URL.
 */
function redactStringValues(
  record: unknown,
  byKey = false,
  depth = 0,
): void {
  if (!record || typeof record !== "object" || depth > MAX_DEPTH) return;
  const obj = record as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string") {
      const next =
        byKey && !Array.isArray(obj) && TOKEN_KEY.test(key)
          ? REDACTED
          : redactUrlTokens(v);
      // Assign only on change: no needless writes (setters, frozen objects).
      if (next !== v) obj[key] = next;
    } else if (v && typeof v === "object") {
      redactStringValues(v, byKey, depth + 1);
    }
  }
}

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * A redacted COPY of `value`. Console breadcrumbs carry the LIVE objects the
 * app passed to `console.*` (`data.arguments`), so they must never be written
 * to: a write can fire a setter (`location.href = …` navigates), or throw on
 * a frozen object. Descends only into plain objects and arrays (to
 * `MAX_DEPTH`, which also bounds cycles); any other object (Location, DOM
 * node, class instance) is kept by reference, untouched. Own enumerable data
 * properties are read via `Object.keys`; accessors on plain objects are
 * read, not written.
 */
function redactedCopy(
  value: unknown,
  depth = 0,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") return redactUrlTokens(value);
  if (!value || typeof value !== "object" || depth > MAX_DEPTH) return value;
  // A URL has no own enumerable data; Sentry later stringifies it via
  // toJSON(). Redact its href here rather than relying on that order.
  if (typeof URL !== "undefined" && value instanceof URL) {
    return redactUrlTokens(value.href);
  }
  // Memo: a shared or self-referencing graph is copied once per object, not
  // once per path (logging a normalized store must not freeze the tab).
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value, arr);
    for (const v of value) arr.push(redactedCopy(v, depth + 1, seen));
    return arr;
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    out[key] = redactedCopy(
      (value as Record<string, unknown>)[key],
      depth + 1,
      seen,
    );
  }
  return out;
}

function redactQueryString(qs: unknown): unknown {
  if (typeof qs === "string") {
    // Sentry stores it without the leading "?".
    return redactUrlTokens(`?${qs}`).slice(1);
  }
  if (Array.isArray(qs)) {
    return qs.map((pair) =>
      Array.isArray(pair) && TOKEN_KEY.test(String(pair[0]))
        ? [pair[0], REDACTED]
        : pair,
    );
  }
  if (qs && typeof qs === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(qs as Record<string, unknown>)) {
      out[k] = TOKEN_KEY.test(k) ? REDACTED : v;
    }
    return out;
  }
  return qs;
}

type BreadcrumbLike = {
  message?: string;
  data?: Record<string, unknown>;
};

export function scrubBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
  try {
    if (typeof breadcrumb.message === "string") {
      const message = redactUrlTokens(breadcrumb.message);
      if (message !== breadcrumb.message) breadcrumb.message = message;
    }
    if (breadcrumb.data) {
      breadcrumb.data = redactedCopy(breadcrumb.data) as Record<string, unknown>;
    }
  } catch {
    // Never throw from a Sentry hook — and fail closed: data that could not
    // be copied is dropped rather than sent unredacted.
    if (breadcrumb.data) breadcrumb.data = { redaction_failed: true };
  }
  return breadcrumb;
}

type EventLike = {
  transaction?: string;
  request?: {
    url?: string;
    query_string?: unknown;
    headers?: Record<string, unknown>;
  };
  breadcrumbs?: BreadcrumbLike[];
  spans?: { data?: Record<string, unknown>; description?: string }[];
  contexts?: Record<string, unknown> & {
    trace?: { data?: Record<string, unknown> };
  };
  extra?: Record<string, unknown>;
  exception?: {
    values?: {
      value?: string;
      stacktrace?: { frames?: { vars?: Record<string, unknown> }[] };
    }[];
  };
};

export function scrubSentryEvent<T extends EventLike>(event: T): T {
  try {
    if (typeof event.transaction === "string") {
      event.transaction = redactUrlTokens(event.transaction);
    }
    if (event.request) {
      if (typeof event.request.url === "string") {
        event.request.url = redactUrlTokens(event.request.url);
      }
      // The Referer of a request made FROM an accept page is that page's URL.
      if (event.request.headers) {
        for (const key of Object.keys(event.request.headers)) {
          if (key.toLowerCase() === "referer") {
            event.request.headers[key] = redactUnknown(
              event.request.headers[key],
            );
          }
        }
      }
      if (event.request.query_string !== undefined) {
        event.request.query_string = redactQueryString(
          event.request.query_string,
        );
      }
    }
    event.breadcrumbs?.forEach((b) => scrubBreadcrumb(b));
    event.spans?.forEach((span) => {
      const query = span.data?.["http.query"];
      if (span.data && typeof query === "string" && isGeocoderSpan(span)) {
        span.data["http.query"] = query.replace(
          GEOCODER_LOCATION_PARAM,
          `$1${REDACTED}`,
        );
      }
      if (typeof span.description === "string") {
        span.description = redactUrlTokens(span.description);
      }
      redactStringValues(span.data);
    });
    redactStringValues(event.contexts);
    redactStringValues(event.extra);
    // `exception.values[].value` is the error message — `new Error(url)` /
    // a Stripe error quoting the client secret — and `includeLocalVariables`
    // (server) attaches frame locals, where a secret sits in a variable.
    event.exception?.values?.forEach((ex) => {
      if (typeof ex.value === "string") ex.value = redactUrlTokens(ex.value);
      ex.stacktrace?.frames?.forEach((frame) =>
        redactStringValues(frame.vars, true),
      );
    });
  } catch {
    // never throw from a Sentry hook
  }
  return event;
}
