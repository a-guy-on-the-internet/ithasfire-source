// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The `?invite=` landing headers (gated-event invite links NFR-002), resolved
 * from the REAL `next.config.ts` with Next's own matchers, the way
 * `next/dist/server/lib/router-utils/resolve-routes.js` applies header rules:
 * every rule whose source matches and whose `has` / `missing` hold, in order,
 * with `resHeaders[key] = value` (the later match wins the key).
 *
 * `next dev` cannot show this: it overwrites Cache-Control on every rendered
 * page (`base-server.js`, `if (this.dev) res.setHeader('Cache-Control', ...)`),
 * so only the Referrer-Policy half is observable there.
 */

type HeaderRule = {
  source: string;
  has?: Array<{ type: string; key: string; value?: string }>;
  missing?: Array<{ type: string; key: string; value?: string }>;
  headers: Array<{ key: string; value: string }>;
};

type BuiltRoute = HeaderRule & {
  match: (pathname: string) => false | Record<string, unknown>;
};

let rules: BuiltRoute[] = [];
let matchHas: (
  req: { headers: Record<string, string> },
  query: Record<string, string>,
  has?: HeaderRule["has"],
  missing?: HeaderRule["missing"],
) => false | Record<string, unknown>;

beforeAll(async () => {
  const configModule = (await import("../../next.config")) as {
    default: { headers?: () => Promise<HeaderRule[]> };
  };
  const raw = (await configModule.default.headers?.()) ?? [];
  // CJS internals of the installed Next — the same functions the router uses.
  const fs = (await import(
    "next/dist/server/lib/router-utils/filesystem.js"
  )) as unknown as {
    buildCustomRoute: (
      type: "header",
      item: HeaderRule,
      basePath: string,
      caseSensitive: boolean,
    ) => BuiltRoute;
  };
  const prepare = (await import(
    "next/dist/shared/lib/router/utils/prepare-destination.js"
  )) as unknown as { matchHas: typeof matchHas };
  matchHas = prepare.matchHas;
  rules = raw.map((r) => fs.buildCustomRoute("header", r, "", false));
}, 60_000);

function resolveHeaders(
  url: string,
  reqHeaders: Record<string, string> = {},
): Record<string, string> {
  const parsed = new URL(url, "http://localhost:3000");
  const query = Object.fromEntries(parsed.searchParams);
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.match(parsed.pathname)) continue;
    if (
      (rule.has || rule.missing) &&
      !matchHas({ headers: reqHeaders }, query, rule.has, rule.missing)
    ) {
      continue;
    }
    for (const { key, value } of rule.headers) out[key.toLowerCase()] = value;
  }
  return out;
}

const EVENT_PATHS = [
  "/events/secret-show",
  "/events/some-org/us/nashville/secret-show",
];

describe("next.config headers — invite landing", () => {
  it.each(EVENT_PATHS)(
    "%s?invite= is private, no-store and no-referrer",
    (path) => {
      const h = resolveHeaders(`${path}?invite=tok_abc`);
      expect(h["cache-control"]).toBe("private, no-store, max-age=0");
      expect(h["referrer-policy"]).toBe("no-referrer");
    },
  );

  it("also on an RSC request carrying the token", () => {
    const h = resolveHeaders("/events/secret-show?invite=tok_abc", {
      rsc: "1",
    });
    expect(h["cache-control"]).toBe("private, no-store, max-age=0");
    expect(h["referrer-policy"]).toBe("no-referrer");
  });

  it.each(EVENT_PATHS)(
    "the clean %s keeps its edge-cacheable headers (unchanged)",
    (path) => {
      const h = resolveHeaders(path);
      expect(h["cache-control"]).toBe(
        "public, max-age=0, s-maxage=120, stale-while-revalidate=300",
      );
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    },
  );

  it("another query param does not trigger it", () => {
    const h = resolveHeaders("/events/secret-show?ref=newsletter");
    expect(h["cache-control"]).toContain("public");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("the redeem POST route gets no-referrer (a config rule beats the handler's own header)", () => {
    const h = resolveHeaders(
      "/api/events/40000000-0000-4000-8000-000000000004/invite",
    );
    expect(h["referrer-policy"]).toBe("no-referrer");
    // Cache-Control stays the handler's own (`private, no-store`).
    expect(h["cache-control"]).toBeUndefined();
  });

  it("the application claim route (?token=) gets no-referrer", () => {
    const h = resolveHeaders(
      "/api/events/40000000-0000-4000-8000-000000000004/claim?token=abc",
    );
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cache-control"]).toBeUndefined();
  });

  it("the /invites/stop page (?token=) is private, no-store, no-referrer and noindex", () => {
    const h = resolveHeaders("/invites/stop?token=iso_abc");
    expect(h["cache-control"]).toBe(
      "private, no-store, max-age=0, must-revalidate",
    );
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["x-robots-tag"]).toBe("noindex");
  });

  it("the one-click POST route /api/invites/stop gets no-referrer, handler keeps Cache-Control", () => {
    const h = resolveHeaders("/api/invites/stop?token=iso_abc");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cache-control"]).toBeUndefined();
    expect(h["x-robots-tag"]).toBeUndefined();
  });

  it("a place page carries max-age=0 so a browser never keeps its old-slug 308", () => {
    const h = resolveHeaders("/places/some-place");
    expect(h["cache-control"]).toBe(
      "public, max-age=0, s-maxage=120, stale-while-revalidate=300",
    );
  });

  it("checkout keeps the framework's Cache-Control (no rule sets one)", () => {
    const h = resolveHeaders("/events/checkout/secret-show?invite=tok_abc");
    expect(h["cache-control"]).toBeUndefined();
  });
});
