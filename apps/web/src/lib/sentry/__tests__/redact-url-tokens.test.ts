import { describe, expect, it } from "vitest";

import {
  redactUrlTokens,
  scrubBreadcrumb,
  scrubSentryEvent,
} from "../redact-url-tokens";

describe("redactUrlTokens", () => {
  it("redacts token values on the accept pages and keeps the rest", () => {
    expect(
      redactUrlTokens("https://ithasfire.com/invite/accept?token=abc_DEF-123"),
    ).toBe("https://ithasfire.com/invite/accept?token=[redacted]");
    expect(
      redactUrlTokens("/delegate/accept?token=v1.eyJw.sig&x=1#frag"),
    ).toBe("/delegate/accept?token=[redacted]&x=1#frag");
    expect(redactUrlTokens("/sign-in?redirect=%2Fx&claim_token=zz")).toBe(
      "/sign-in?redirect=%2Fx&claim_token=[redacted]",
    );
  });

  it("leaves token-free URLs untouched", () => {
    expect(redactUrlTokens("/events/foo?page=2")).toBe("/events/foo?page=2");
  });

  it("redacts a gated-event invite link's token, plain and URL-encoded", () => {
    expect(redactUrlTokens("/events/supper-club?invite=abc_DEF-123&utm=x")).toBe(
      "/events/supper-club?invite=[redacted]&utm=x",
    );
    expect(
      redactUrlTokens("/sign-in?redirect=%2Fevents%2Fx%3Finvite%3DT0K"),
    ).toBe("/sign-in?redirect=%2Fevents%2Fx%3Finvite%3D[redacted]");
    // Only the exact parameter: `invited=` is not a credential.
    expect(redactUrlTokens("/x?invited=3")).toBe("/x?invited=3");
  });

  it("redacts an invite token in every query_string shape Sentry sends", () => {
    const shaped = (query_string: unknown) =>
      scrubSentryEvent({ request: { query_string } } as never) as unknown as {
        request: { query_string: unknown };
      };
    expect(shaped("invite=T0K&utm=x").request.query_string).toBe(
      "invite=[redacted]&utm=x",
    );
    expect(
      shaped([
        ["invite", "T0K"],
        ["invited", "1"],
      ]).request.query_string,
    ).toEqual([
      ["invite", "[redacted]"],
      ["invited", "1"],
    ]);
    expect(
      shaped({ Invite: "T0K", invited: "1" }).request.query_string,
    ).toEqual({ Invite: "[redacted]", invited: "1" });
  });
});

describe("scrubSentryEvent / scrubBreadcrumb", () => {
  it("scrubs request, breadcrumbs, spans and trace data", () => {
    const event = scrubSentryEvent({
      transaction: "/invite/accept?token=T1",
      request: {
        url: "https://x/invite/accept?token=T1",
        query_string: "token=T1&a=b",
      },
      breadcrumbs: [
        {
          message: "nav",
          data: { from: "/", to: "/delegate/accept?token=T2" },
        },
      ],
      spans: [{ description: "GET /invite/accept?token=T3", data: { "url.full": "https://x/?token=T3" } }],
      contexts: { trace: { data: { "http.query": "?token=T4" } } },
    });
    expect(JSON.stringify(event)).not.toMatch(/T[1-4]/);
    expect(event.request?.query_string).toBe("token=[redacted]&a=b");
  });

  it("handles array and object query_string shapes", () => {
    expect(
      scrubSentryEvent({ request: { query_string: [["token", "T"], ["a", "b"]] } })
        .request?.query_string,
    ).toEqual([["token", "[redacted]"], ["a", "b"]]);
    expect(
      scrubSentryEvent({ request: { query_string: { token: "T", a: "b" } } })
        .request?.query_string,
    ).toEqual({ token: "[redacted]", a: "b" });
  });

  it("scrubs a fetch breadcrumb url", () => {
    const b = scrubBreadcrumb({ data: { url: "/invite/accept?token=SECRET", status_code: 200 } });
    expect(b.data?.url).toBe("/invite/accept?token=[redacted]");
    expect(b.data?.status_code).toBe(200);
  });
});

describe("redaction gaps (review round 3)", () => {
  it("redacts the URL-ENCODED token inside a sign-in redirect", () => {
    const url =
      "https://ithasfire.com/sign-in?redirect=%2Finvite%2Faccept%3Ftoken%3DSECRET123%26x%3D1";
    const out = redactUrlTokens(url);
    expect(out).not.toContain("SECRET123");
    expect(out).toBe(
      "https://ithasfire.com/sign-in?redirect=%2Finvite%2Faccept%3Ftoken%3D[redacted]%26x%3D1",
    );
    expect(redactUrlTokens("/x?r=%2Fa%3Fa%3D1%26claim_token%3DZZ")).not.toContain("ZZ");
  });

  it("redacts fragment tokens and hyphenated parameter names", () => {
    expect(redactUrlTokens("/delegate/accept#token=FRAG")).toBe(
      "/delegate/accept#token=[redacted]",
    );
    expect(redactUrlTokens("/x?invite-token=HY&a=1")).toBe(
      "/x?invite-token=[redacted]&a=1",
    );
  });

  it("redacts request.headers.Referer (any casing) and leaves other headers", () => {
    const event = scrubSentryEvent({
      request: {
        headers: {
          Referer: "https://ithasfire.com/invite/accept?token=REF1",
          referer: "https://ithasfire.com/delegate/accept?token=REF2",
          "user-agent": "ua?token=not-a-url-param-but-still-fine",
        },
      },
    });
    expect(JSON.stringify(event.request?.headers)).not.toMatch(/REF[12]/);
    expect(event.request?.headers?.["user-agent"]).toBe(
      "ua?token=not-a-url-param-but-still-fine",
    );
  });
});

describe("Stripe redirect returns (the client secret rides the page URL)", () => {
  const PI = "pi_3PqRsT1aBcDeFgH";
  const SECRET_PART = "Zx9YwVuT8sR7qPo"; // gitleaks:allow (fake test fixture)
  const CLIENT_SECRET = `${PI}_secret_${SECRET_PART}`;
  const QUERY = `orderId=44444444&payment_intent=${PI}&payment_intent_client_secret=${CLIENT_SECRET}&redirect_status=failed`;
  const RETURN_URL = `https://ithasfire.com/events/checkout/gallery-walk?${QUERY}`;
  const EMBED_RETURN_URL = `https://ithasfire.com/embed/00000000-0000-4000-8000-00000000d060?${QUERY}`;
  /** No `pi_…_secret_<secret>` survives, in any spelling. */
  const expectNoSecret = (value: unknown) => {
    const json = JSON.stringify(value);
    expect(json).not.toContain(SECRET_PART);
    expect(json).not.toMatch(/(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]/);
  };

  it("redacts the secret in a checkout and an embed return URL, keeping the PaymentIntent id and the status", () => {
    for (const url of [RETURN_URL, EMBED_RETURN_URL]) {
      const out = redactUrlTokens(url);
      expectNoSecret(out);
      expect(out).toContain(`payment_intent=${PI}&`);
      expect(out).toContain("payment_intent_client_secret=[redacted]");
      expect(out).toContain("redirect_status=failed");
    }
  });

  it("scrubs request.url, the string query_string, the Referer, breadcrumbs (from/to), spans and trace data", () => {
    const event = scrubSentryEvent({
      transaction: `/events/checkout/gallery-walk?${QUERY}`,
      request: {
        url: RETURN_URL,
        query_string: QUERY,
        headers: { Referer: RETURN_URL },
      },
      breadcrumbs: [
        { message: `navigated to ${RETURN_URL}`, data: { from: "/events/gallery-walk", to: RETURN_URL } },
        { data: { from: EMBED_RETURN_URL, to: "/embed/x" } },
        { data: { url: `https://api.stripe.com/v1/payment_intents/${PI}?client_secret=${CLIENT_SECRET}`, status_code: 404 } },
      ],
      spans: [{ description: `GET ${RETURN_URL}`, data: { "url.full": RETURN_URL } }],
      contexts: { trace: { data: { "http.query": `?${QUERY}` } } },
    });
    expectNoSecret(event);
    expect(event.request?.query_string).toBe(
      `orderId=44444444&payment_intent=${PI}&payment_intent_client_secret=[redacted]&redirect_status=failed`,
    );
    expect(event.breadcrumbs?.[0]?.data?.from).toBe("/events/gallery-walk");
  });

  it("scrubs the array and object query_string shapes", () => {
    const pairs = scrubSentryEvent({
      request: {
        query_string: [
          ["payment_intent", PI],
          ["payment_intent_client_secret", CLIENT_SECRET],
          ["redirect_status", "failed"],
        ],
      },
    }).request?.query_string;
    expectNoSecret(pairs);
    expect(pairs).toEqual([
      ["payment_intent", PI],
      ["payment_intent_client_secret", "[redacted]"],
      ["redirect_status", "failed"],
    ]);
    const obj = scrubSentryEvent({
      request: { query_string: { payment_intent: PI, payment_intent_client_secret: CLIENT_SECRET } },
    }).request?.query_string;
    expectNoSecret(obj);
    expect(obj).toEqual({ payment_intent: PI, payment_intent_client_secret: "[redacted]" });
  });

  it("redacts the URL-ENCODED secret (a return URL nested in a sign-in redirect), in either case", () => {
    const nested = `/sign-in?redirect=${encodeURIComponent(`/events/checkout/gallery-walk?${QUERY}`)}`;
    expect(nested).toContain("%26payment_intent_client_secret%3D");
    expectNoSecret(redactUrlTokens(nested));
    expectNoSecret(redactUrlTokens(nested.replace(/%3D/g, "%3d").replace(/%26/g, "%26")));
    expectNoSecret(
      scrubBreadcrumb({ data: { from: "/x", to: `https://ithasfire.com${nested}` } }),
    );
  });

  it("redacts a bare client secret wherever the scrubber looks (not only as a param)", () => {
    expectNoSecret(redactUrlTokens(`retrieve failed for ${CLIENT_SECRET}`));
    expectNoSecret(redactUrlTokens(`seti_1AbC_secret_${SECRET_PART}`));
    expect(redactUrlTokens(`retrieve failed for ${CLIENT_SECRET}`)).toBe(
      `retrieve failed for ${PI}_secret_[redacted]`,
    );
  });

  it("keeps a URL with no secret byte-for-byte (no over-redaction)", () => {
    const plain = `https://ithasfire.com/events/checkout/gallery-walk?payment_intent=${PI}&redirect_status=succeeded&secretary=no`;
    expect(redactUrlTokens(plain)).toBe(plain);
  });
});

describe("scrubber blind spots", () => {
  const PI = "pi_3Abc_secret_XyZ123";

  it("redacts inside array-valued breadcrumb data (console arguments)", () => {
    const b = scrubBreadcrumb({
      message: "console",
      data: {
        arguments: [
          `return ${PI}`,
          { url: "/checkout?payment_intent_client_secret=pi_1_secret_ZZ" },
          42,
        ],
      },
    });
    const json = JSON.stringify(b);
    expect(json).not.toContain("XyZ123");
    expect(json).not.toContain("secret_ZZ");
    expect(json).toContain("pi_3Abc_secret_[redacted]");
  });

  it("redacts exception values, extra and every context", () => {
    const e = scrubSentryEvent({
      exception: { values: [{ value: `Stripe said ${PI} is bad` }] },
      extra: { href: `/c?payment_intent_client_secret=${PI}`, n: { deep: PI } },
      contexts: { app: { url: `/x?token=T9` }, trace: { data: { u: PI } } },
    });
    const json = JSON.stringify(e);
    expect(json).not.toContain("XyZ123");
    expect(json).not.toContain("T9");
    expect(e.exception?.values?.[0]?.value).toBe(
      "Stripe said pi_3Abc_secret_[redacted] is bad",
    );
  });

  it("redacts stack-frame vars (includeLocalVariables)", () => {
    const e = scrubSentryEvent({
      exception: {
        values: [
          {
            value: "boom",
            stacktrace: {
              frames: [
                {
                  vars: {
                    href: `/c?payment_intent_client_secret=${PI}`,
                    clientSecret: "anything-opaque",
                    nested: { s: PI },
                    ok: "fine",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const vars = e.exception!.values![0]!.stacktrace!.frames![0]!.vars!;
    expect(JSON.stringify(vars)).not.toContain("XyZ123");
    expect(vars.clientSecret).toBe("[redacted]");
    expect(vars.ok).toBe("fine");
  });
});

describe("scrubBreadcrumb never mutates the live console arguments", () => {
  const SECRET_URL = "https://x/invite/accept?token=SECRET1";

  it("returns a redacted copy and leaves the original object unchanged", () => {
    const arg = { url: SECRET_URL, nested: { u: SECRET_URL }, n: 1 };
    const b = scrubBreadcrumb({ data: { arguments: [arg, SECRET_URL] } });
    const args = b.data!.arguments as [typeof arg, string];
    expect(args[0].url).toBe("https://x/invite/accept?token=[redacted]");
    expect(args[0].nested.u).toBe("https://x/invite/accept?token=[redacted]");
    expect(args[0].n).toBe(1);
    expect(args[1]).toBe("https://x/invite/accept?token=[redacted]");
    expect(args[0]).not.toBe(arg);
    expect(arg.url).toBe(SECRET_URL);
    expect(arg.nested.u).toBe(SECRET_URL);
  });

  it("never calls a setter on an argument", () => {
    const writes: unknown[] = [];
    const loc = {
      get href() {
        return SECRET_URL;
      },
      set href(v: string) {
        writes.push(v);
      },
    };
    class Holder {
      value = SECRET_URL;
    }
    const holder = new Holder();
    const b = scrubBreadcrumb({ data: { arguments: [loc, holder] } });
    expect(writes).toEqual([]);
    // Non-plain objects pass through by reference, untouched.
    expect((b.data!.arguments as unknown[])[1]).toBe(holder);
    expect(holder.value).toBe(SECRET_URL);
  });

  it("does not throw on a frozen object: copy redacted, original frozen and unchanged", () => {
    const frozen = Object.freeze({ url: SECRET_URL });
    const b = scrubBreadcrumb({
      data: { arguments: [frozen, { url: SECRET_URL }] },
    });
    const args = b.data!.arguments as { url: string }[];
    expect(args[0]!.url).toBe("https://x/invite/accept?token=[redacted]");
    // The argument after the frozen one is scrubbed too.
    expect(args[1]!.url).toBe("https://x/invite/accept?token=[redacted]");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.url).toBe(SECRET_URL);
  });
});

describe("scrubBreadcrumb — copy hardening", () => {
  it("redacts a URL instance's href instead of passing the live object through", () => {
    const url = new URL("https://ithasfire.com/invite/accept?token=T0PS3CRET&x=1");
    const out = scrubBreadcrumb({ data: { arguments: [url] } });
    const arg = (out.data!.arguments as unknown[])[0];
    expect(typeof arg).toBe("string");
    expect(String(arg)).not.toContain("T0PS3CRET");
    expect(url.href).toContain("T0PS3CRET"); // the live URL is untouched
  });

  it("copies a wide self-referencing graph once per object (no exponential blow-up)", () => {
    const node: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) node[`k${i}`] = node;
    node.secretUrl = "https://x.test/?payment_intent_client_secret=pi_1_secret_abc"; // gitleaks:allow (fake test fixture)
    const started = Date.now();
    const out = scrubBreadcrumb({ data: { arguments: [node] } });
    expect(Date.now() - started).toBeLessThan(500);
    const copy = (out.data!.arguments as Record<string, unknown>[])[0];
    expect(copy.k0).toBe(copy); // the cycle resolves to the copy
    expect(String(copy.secretUrl)).not.toContain("secret_abc");
    expect(node.secretUrl).toContain("secret_abc"); // the live object is untouched
  });

  it("fails closed when the data cannot be copied", () => {
    const hostile = { get boom() { throw new Error("nope"); } };
    const out = scrubBreadcrumb({ data: { arguments: [hostile] } });
    expect(out.data).toEqual({ redaction_failed: true });
  });
});

describe("bare invite tokens (the backstop)", () => {
  const ID = "3f2c9a1e-8b7d-4c6e-9f10-2a3b4c5d6e7f";
  // inv_<uuid>_<43 base64url chars>, the shape invite-token.ts mints.
  const TOKEN = `inv_${ID}_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE`;
  const KEPT = `inv_${ID}_[redacted]`;

  it("redacts a token embedded in Next's segment key, plain and URL-encoded", () => {
    expect(TOKEN.length).toBe(4 + 36 + 1 + 43);
    expect(redactUrlTokens(`__PAGE__?{"invite":"${TOKEN}"}`)).toBe(
      `__PAGE__?{"invite":"${KEPT}"}`,
    );
    expect(
      redactUrlTokens(`__PAGE__%3F%7B%22invite%22%3A%22${TOKEN}%22%7D`),
    ).toBe(`__PAGE__%3F%7B%22invite%22%3A%22${KEPT}%22%7D`);
  });

  it("reaches messages and breadcrumbs", () => {
    const crumb = scrubBreadcrumb({
      message: `segment __PAGE__?{"invite":"${TOKEN}"}`,
      data: { tree: [`__PAGE__?{"invite":"${TOKEN}"}`] },
    });
    expect(JSON.stringify(crumb)).not.toContain(TOKEN.slice(41));
    expect(crumb.message).toContain(KEPT);
  });

  it("leaves look-alikes alone", () => {
    expect(redactUrlTokens("inv_not-a-uuid_abc")).toBe("inv_not-a-uuid_abc");
    expect(redactUrlTokens(`inventory_${ID}`)).toBe(`inventory_${ID}`);
  });
});

describe("signed storage links (the admin seat map fetches one)", () => {
  const gcs =
    "https://storage.googleapis.com/th-layouts/place-1/abc123.json" +
    "?X-Goog-Algorithm=GOOG4-RSA-SHA256" +
    "&X-Goog-Credential=svc%40proj.iam.gserviceaccount.com%2F20261013%2Fauto%2Fstorage%2Fgoog4_request" +
    "&X-Goog-Date=20261013T120000Z&X-Goog-Expires=3600&X-Goog-SignedHeaders=host" +
    "&X-Goog-Signature=0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const s3 =
    "https://th-layouts.s3.us-east-1.amazonaws.com/place-1/abc123.json" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
    "&X-Amz-Credential=AKIAEXAMPLE%2F20261013%2Fus-east-1%2Fs3%2Faws4_request" +
    "&X-Amz-Date=20261013T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host" +
    "&X-Amz-Signature=fe0123456789abcdef";

  it("redacts the signature and credential of a GCS V4 link, keeping the rest", () => {
    const out = redactUrlTokens(gcs);
    expect(out).toContain("X-Goog-Signature=[redacted]");
    expect(out).toContain("X-Goog-Credential=[redacted]");
    expect(out).not.toContain("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    expect(out).not.toContain("iam.gserviceaccount.com");
    expect(out).toContain("https://storage.googleapis.com/th-layouts/place-1/abc123.json?");
    expect(out).toContain("X-Goog-Expires=3600");
  });

  it("redacts the signature and credential of an S3 V4 link", () => {
    const out = redactUrlTokens(s3);
    expect(out).toContain("X-Amz-Signature=[redacted]");
    expect(out).toContain("X-Amz-Credential=[redacted]");
    expect(out).not.toContain("fe0123456789abcdef");
    expect(out).not.toContain("AKIAEXAMPLE");
    expect(out).toContain("X-Amz-Date=20261013T120000Z");
  });

  it("scrubs a signed link in a fetch breadcrumb and in an object query_string", () => {
    const b = scrubBreadcrumb({ data: { url: gcs, method: "GET", status_code: 403 } });
    expect(b.data?.url).toContain("X-Goog-Signature=[redacted]");
    expect(b.data?.status_code).toBe(403);
    expect(
      scrubSentryEvent({
        request: { query_string: { "X-Amz-Signature": "abc", "X-Amz-Expires": "3600" } },
      }).request?.query_string,
    ).toEqual({ "X-Amz-Signature": "[redacted]", "X-Amz-Expires": "3600" });
  });
});

describe("geocoder URLs (the address typed, the point looked up)", () => {
  const SEARCH =
    "https://api.geoapify.com/v1/geocode/search?text=1412%20Holly%20St%2C%20Nashville%20TN%2037206&limit=5&apiKey=pk_abc";
  const AUTOCOMPLETE =
    "https://api.geoapify.com/v1/geocode/autocomplete?text=1412%20Holly&limit=5&format=geojson&apiKey=pk_abc";
  const REVERSE =
    "https://api.geoapify.com/v1/geocode/reverse?lat=36.1771&lon=-86.7389&limit=1&apiKey=pk_abc";

  it("redacts text= on search and autocomplete, keeping the rest of the URL", () => {
    expect(redactUrlTokens(SEARCH)).toBe(
      "https://api.geoapify.com/v1/geocode/search?text=[redacted]&limit=5&apiKey=pk_abc",
    );
    expect(redactUrlTokens(AUTOCOMPLETE)).toBe(
      "https://api.geoapify.com/v1/geocode/autocomplete?text=[redacted]&limit=5&format=geojson&apiKey=pk_abc",
    );
  });

  it("redacts lat= and lon= on reverse", () => {
    expect(redactUrlTokens(REVERSE)).toBe(
      "https://api.geoapify.com/v1/geocode/reverse?lat=[redacted]&lon=[redacted]&limit=1&apiKey=pk_abc",
    );
  });

  it("leaves unrelated URLs alone, our own search page's lat/lng and q included", () => {
    for (const url of [
      "https://ithasfire.com/search?q=open%20mic&lat=36.16&lng=-86.78",
      "https://twitter.com/intent/tweet?url=x&text=Open%20mic",
      "https://api.example.com/v1/geocode/search?text=Main%20St",
    ]) {
      expect(redactUrlTokens(url)).toBe(url);
    }
  });

  it("a fetch breadcrumb and a span carrying the geocoder URL lose the address and point", () => {
    const event = {
      request: { url: "https://ithasfire.com/admin/places/new" },
      breadcrumbs: [
        { category: "fetch", data: { url: SEARCH, method: "GET", status_code: 200 } },
        { category: "fetch", message: `GET ${REVERSE}` },
      ],
      spans: [{ description: `GET ${REVERSE}`, data: { "http.url": AUTOCOMPLETE } }],
      contexts: { trace: { data: { url: SEARCH } } },
    };
    const text = JSON.stringify(scrubSentryEvent(event));
    expect(text).not.toMatch(/1412|Holly|37206|36\.1771|86\.7389/);
    expect(event.request.url).toBe("https://ithasfire.com/admin/places/new");
    expect(event.breadcrumbs[0]!.data!.status_code).toBe(200);
  });

  describe("tRPC GET input and hostless geocoder query", () => {
    const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
    const TRAVEL = `https://ithasfire.com/api/trpc/routing.getTravelTime?batch=1&input=${enc({
      "0": { json: { origin: { lat: 36.1, lng: -86.7 }, destination: { lat: 36.1771, lng: -86.7389 } } },
    })}`;
    const TZ = `/api/trpc/places.resolveTimezone?batch=1&input=${enc({
      "0": { json: { lat: 36.1771, lng: -86.7389 } },
    })}`;

    it("redacts routing.getTravelTime in breadcrumb data.url, span http.url and http.query", () => {
      const event = {
        breadcrumbs: [{ category: "fetch", data: { url: TRAVEL, method: "GET" } }],
        spans: [
          {
            description: "GET /api/trpc/routing.getTravelTime",
            data: { "http.url": TRAVEL, "http.query": `?batch=1&input=${enc({ "0": { json: { destination: { lat: 36.1771, lng: -86.7389 } } } })}` },
          },
        ],
      };
      const text = JSON.stringify(scrubSentryEvent(event));
      expect(text).not.toMatch(/36\.1771|86\.7389|36\.1|86\.7/);
      expect(event.breadcrumbs[0]!.data.url).toContain("input=[redacted]");
      expect(event.breadcrumbs[0]!.data.method).toBe("GET");
      expect(event.spans[0]!.data["http.url"]).toContain("input=[redacted]");
      expect(event.spans[0]!.data["http.query"]).toBe("?batch=1&input=[redacted]");
    });

    it("redacts places.resolveTimezone", () => {
      expect(redactUrlTokens(TZ)).toBe(
        "/api/trpc/places.resolveTimezone?batch=1&input=[redacted]",
      );
    });

    it("keeps a tRPC input with no location keys", () => {
      const url = `/api/trpc/events.bySlug?batch=1&input=${enc({ "0": { json: { slug: "x" } } })}`;
      expect(redactUrlTokens(url)).toBe(url);
    });

    it("redacts a multi-procedure batch when only entry 1 names a location", () => {
      const url = `/api/trpc/events.bySlug,routing.getTravelTime?batch=1&input=${enc({
        "0": { json: { slug: "x" } },
        "1": { json: { destination: { lat: 36.1771, lng: -86.7389 } } },
      })}`;
      expect(redactUrlTokens(url)).toBe(
        "/api/trpc/events.bySlug,routing.getTravelTime?batch=1&input=[redacted]",
      );
    });

    it("keeps an input with only a city and region code", () => {
      const url = `/api/trpc/events.list?batch=1&input=${enc({ "0": { json: { city: "Nashville", regionCode: "US-TN" } } })}`;
      expect(redactUrlTokens(url)).toBe(url);
    });

    it("redacts the viewer position (userLat / userLng)", () => {
      const url = `/api/trpc/events.discoverPublicEvents?batch=1&input=${enc({ "0": { json: { userLat: 36.16, userLng: -86.78 } } })}`;
      expect(redactUrlTokens(url)).toBe(
        "/api/trpc/events.discoverPublicEvents?batch=1&input=[redacted]",
      );
    });

    it("fails closed on a truncated escape", () => {
      expect(redactUrlTokens("/api/trpc/x?input=%E0%A4")).toBe(
        "/api/trpc/x?input=[redacted]",
      );
    });

    it("redacts a Geoapify span's hostless http.query, keeping the apiKey handling", () => {
      const span = {
        data: {
          "server.address": "api.geoapify.com",
          "http.query": "?text=1417%20Shelby%20Ave&apiKey=K",
        },
      };
      scrubSentryEvent({ spans: [span] } as never);
      expect(span.data["http.query"]).toBe("?text=[redacted]&apiKey=K");
    });

    it("leaves a non-geocoder span's http.query alone", () => {
      const span = {
        data: { "server.address": "ithasfire.com", "http.query": "?q=foo" },
      };
      scrubSentryEvent({ spans: [span] } as never);
      expect(span.data["http.query"]).toBe("?q=foo");
    });

    it("scans an 80K adversarial escaped input in linear time", () => {
      const evil = `/x?input=${"%5C%22".repeat(16000)}`;
      const t0 = performance.now();
      redactUrlTokens(evil);
      redactUrlTokens(`/x?input=${encodeURIComponent('"' + "a".repeat(80000))}`);
      expect(performance.now() - t0).toBeLessThan(1000);
    });
  });
});
