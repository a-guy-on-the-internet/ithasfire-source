// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  parseRouteContext,
  ROUTE_CONTEXT_HEADER,
  routeContextForPath,
  themeLockForContext,
  urlLocaleForContext,
} from "@/lib/route-context";
import middleware, {
  config as middlewareConfig,
  withRouteContext,
} from "../../middleware";

/**
 * Embeds live on organisers' own websites, so they must render the platform's
 * LIGHT theme whatever the viewer toggled on ithasfire.com, on a transparent
 * canvas. The root layout cannot see the path, so middleware hands it the
 * route context as a request header. These tests pin the path match, the
 * light lock, and that a client can never smuggle the header in (the layout
 * trusts it).
 */

const req = (path: string, headers?: Record<string, string>) =>
  new NextRequest(`https://app.example.com${path}`, { headers });

/** What the downstream layout will read for the context header. */
const forwarded = (res: Response): string | null => {
  const overridden = (res.headers.get("x-middleware-override-headers") ?? "")
    .split(",")
    .filter(Boolean);
  if (!overridden.includes(ROUTE_CONTEXT_HEADER)) {
    return "<not overridden>";
  }
  return res.headers.get(`x-middleware-request-${ROUTE_CONTEXT_HEADER}`);
};

describe("routeContextForPath", () => {
  it.each([
    "/embed",
    "/embed/abc",
    "/embed/calendar/abc",
    "/embed/book/abc",
    "/embed/memberships/abc",
    "/embed/auth-handoff",
  ])("marks %s as an embed", (path) => {
    expect(routeContextForPath(path)).toBe("embed");
  });

  it.each(["/search", "/embedded", "/admin/org/embeds", "/events/checkout/x"])(
    "leaves %s as an ordinary route",
    (path) => {
      expect(routeContextForPath(path)).toBeNull();
    },
  );
});

/**
 * Spanish SEO FR-002 / R21: the header also carries the language a public
 * page's URL fixes, and the layout renders it instead of the cookie pick.
 */
describe("routeContextForPath (public pages)", () => {
  it.each([
    "/",
    "/events/category/music",
    "/events/category/music/nashville-tn",
    "/about",
    "/contact",
    "/events/us/nashville/show",
    "/places/the-basement",
    "/orgs/some-org",
    "/p/some-page",
  ])("marks English-first page %s public:en", (path) => {
    expect(routeContextForPath(path)).toBe("public:en");
  });

  it.each([
    "/es",
    "/es/eventos/categoria/musica",
    "/es/eventos/categoria/musica/nashville-tn",
    "/es/acerca-de",
    "/es/contacto",
    "/es/about",
  ])("marks %s public:es", (path) => {
    expect(routeContextForPath(path)).toBe("public:es");
  });

  it.each(["/esports", "/es-foo", "/aboutus", "/account", "/help/x"])(
    "gives app path %s no context",
    (path) => {
      expect(routeContextForPath(path)).toBeNull();
    },
  );
});

describe("parseRouteContext / themeLockForContext / urlLocaleForContext", () => {
  it("accepts only the exact contexts", () => {
    expect(parseRouteContext("embed")).toBe("embed");
    expect(parseRouteContext("public:en")).toBe("public:en");
    expect(parseRouteContext("public:es")).toBe("public:es");
    for (const junk of [
      "EMBED",
      "",
      null,
      "public:fr",
      "public:",
      "public:ES",
      "public:es ",
      "public",
      "es",
    ]) {
      expect(parseRouteContext(junk)).toBeNull();
    }
  });

  it("pins embeds to light and leaves everything else to the viewer", () => {
    expect(themeLockForContext("embed")).toBe("light");
    expect(themeLockForContext("public:es")).toBeNull();
    expect(themeLockForContext(null)).toBeNull();
  });

  it("reads the URL language only from a public context", () => {
    expect(urlLocaleForContext("public:es")).toBe("es");
    expect(urlLocaleForContext("public:en")).toBe("en");
    expect(urlLocaleForContext("embed")).toBeNull();
    expect(urlLocaleForContext(null)).toBeNull();
  });
});

describe("withRouteContext (middleware)", () => {
  it("forwards the embed context on an embed route", () => {
    expect(forwarded(withRouteContext(req("/embed/abc")))).toBe("embed");
  });

  it("overwrites a client-supplied context on an embed route", () => {
    const res = withRouteContext(
      req("/embed/abc", { [ROUTE_CONTEXT_HEADER]: "something-else" }),
    );
    expect(forwarded(res)).toBe("embed");
  });

  it.each([
    ["/", "public:en"],
    ["/events/category/music", "public:en"],
    ["/events/us/nashville/show", "public:en"],
    ["/places/the-basement", "public:en"],
    ["/es", "public:es"],
    ["/es/eventos/categoria/musica", "public:es"],
  ])("forwards the URL language on public page %s", (path, expected) => {
    expect(forwarded(withRouteContext(req(path)))).toBe(expected);
  });

  it.each([
    ["/", "public:es", "public:en"],
    ["/events/category/music", "public:es", "public:en"],
    ["/places/x", "embed", "public:en"],
    ["/es/acerca-de", "public:en", "public:es"],
    ["/es", "embed", "public:es"],
    ["/embed/abc", "public:es", "embed"],
  ])(
    "overwrites a spoofed context on %s (client sent %s)",
    (path, spoofed, expected) => {
      const res = withRouteContext(
        req(path, { [ROUTE_CONTEXT_HEADER]: spoofed }),
      );
      expect(forwarded(res)).toBe(expected);
    },
  );

  it.each(["embed", "public:es", "public:en"])(
    "strips a client-supplied %s on an app page",
    (spoofed) => {
      const res = withRouteContext(
        req("/account/settings", { [ROUTE_CONTEXT_HEADER]: spoofed }),
      );
      const overridden = res.headers.get("x-middleware-override-headers");
      expect(overridden).not.toBeNull();
      expect(overridden!.split(",")).not.toContain(ROUTE_CONTEXT_HEADER);
      expect(
        res.headers.get(`x-middleware-request-${ROUTE_CONTEXT_HEADER}`),
      ).toBeNull();
    },
  );

  it("strips a client-supplied context everywhere else", () => {
    const res = withRouteContext(
      req("/search", { [ROUTE_CONTEXT_HEADER]: "embed", "x-other": "kept" }),
    );
    // The request headers ARE rewritten (override list present) — and the
    // rewritten set omits the context, so the layout never sees it.
    const overridden = res.headers.get("x-middleware-override-headers");
    expect(overridden).not.toBeNull();
    expect(overridden!.split(",")).toContain("x-other");
    expect(overridden!.split(",")).not.toContain(ROUTE_CONTEXT_HEADER);
    expect(
      res.headers.get(`x-middleware-request-${ROUTE_CONTEXT_HEADER}`),
    ).toBeNull();
  });

  it("is a plain pass-through for ordinary routes", () => {
    const res = withRouteContext(req("/search"));
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
  });
});

/**
 * Through the whole middleware: public pages pass the gates untouched and get
 * their language; the private-route gate still redirects an anonymous visitor.
 */
describe("middleware (end to end)", () => {
  it.each([
    ["/", "public:en"],
    ["/es/eventos/categoria/musica", "public:es"],
    ["/places/the-basement", "public:en"],
  ])("forwards the URL language on %s past the gates", async (path, expected) => {
    const res = await middleware(
      req(path, { [ROUTE_CONTEXT_HEADER]: "embed" }),
    );
    expect(res.status).toBe(200);
    expect(forwarded(res)).toBe(expected);
  });

  it("still redirects an anonymous visitor away from a private page", async () => {
    const res = await middleware(req("/account/settings"));
    expect(res.status).toBe(307);
  });
});

/**
 * The matcher decides whether middleware runs AT ALL. Any page request it
 * skips also skips the context-header strip above, so a client-sent
 * `x-th-route-context: embed` would reach the root layout. Its asset-extension
 * exclusion used to be unanchored: `/events/next.js-meetup` matched
 * `\.js` mid-path and skipped middleware (and the auth gates) entirely.
 */
describe("middleware matcher", () => {
  // Next's own matcher evaluator touches AsyncLocalStorage at import.
  const g = globalThis as { AsyncLocalStorage?: unknown };
  const runs = async (url: string): Promise<boolean> => {
    g.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
    const { unstable_doesMiddlewareMatch } = await import(
      "next/experimental/testing/server"
    );
    return unstable_doesMiddlewareMatch({ config: middlewareConfig, url });
  };

  it.each([
    "/embed/abc",
    "/embed/book/abc",
    "/",
    "/es",
    "/es/eventos/categoria/musica/nashville-tn",
    "/about",
    "/events/next.js-meetup",
    "/events/x.css-night",
    "/p/some.name",
    "/manifest.json",
    "/api/x.json",
  ])("runs for page/API path %s", async (url) => {
    expect(await runs(url)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/a.js",
    "/_next/image?url=x",
    "/favicon.ico",
    "/fonts/a.woff2?v=1",
    "/logo.png?x=1",
    "/embed/hf-resize.js",
    "/og-image-v2.png",
    "/monitoring",
  ])("skips asset/internal path %s", async (url) => {
    expect(await runs(url)).toBe(false);
  });
});
