// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A reader who chose a non-default language (`th-locale` cookie) must never
 * get a `public, s-maxage` stamp: the edge cache key is the URL alone, so a
 * Spanish render would be served to English readers. Resolved from the REAL
 * `next.config.ts` with Next's own matchers, the same way
 * `next-config-invite-headers.test.ts` does (see that file for why `next dev`
 * cannot show Cache-Control). No rule match means the framework's own
 * `private, no-cache, no-store` applies.
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

let rawRules: HeaderRule[] = [];
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
  rawRules = raw;
  const fs =
    (await import("next/dist/server/lib/router-utils/filesystem.js")) as unknown as {
      buildCustomRoute: (
        type: "header",
        item: HeaderRule,
        basePath: string,
        caseSensitive: boolean,
      ) => BuiltRoute;
    };
  const prepare =
    (await import("next/dist/shared/lib/router/utils/prepare-destination.js")) as unknown as {
      matchHas: typeof matchHas;
    };
  matchHas = prepare.matchHas;
  rules = raw.map((r) => fs.buildCustomRoute("header", r, "", false));
}, 60_000);

function cacheControl(
  url: string,
  reqHeaders: Record<string, string> = {},
): string | undefined {
  const parsed = new URL(url, "http://localhost:3000");
  const query = Object.fromEntries(parsed.searchParams);
  let out: string | undefined;
  for (const rule of rules) {
    if (!rule.match(parsed.pathname)) continue;
    if (
      (rule.has || rule.missing) &&
      !matchHas({ headers: reqHeaders }, query, rule.has, rule.missing)
    ) {
      continue;
    }
    for (const { key, value } of rule.headers) {
      if (key.toLowerCase() === "cache-control") out = value;
    }
  }
  return out;
}

// One path per rule that stamps `public, s-maxage` on an app page.
const PUBLIC_PAGES = [
  "/",
  "/events",
  "/events/some-org/us/nashville/gig",
  "/places/some-place",
  "/orgs/some-org",
  "/humans/someone",
  "/p/some-page",
  "/about",
  "/privacy",
  "/terms",
  "/acceptable-use",
  "/cookie-policy",
  "/contact",
];

describe("next.config headers — chosen language bypasses the shared cache", () => {
  it.each(PUBLIC_PAGES)("%s is public with no cookie", (path) => {
    expect(cacheControl(path)).toMatch(/^public, .*s-maxage=/);
  });

  it.each(PUBLIC_PAGES)("%s is public when the reader chose en", (path) => {
    expect(cacheControl(path, { cookie: "th-locale=en" })).toMatch(
      /^public, .*s-maxage=/,
    );
  });

  it.each(PUBLIC_PAGES)(
    "%s gets no cache stamp when the reader chose es",
    (path) => {
      expect(cacheControl(path, { cookie: "th-locale=es" })).toBeUndefined();
    },
  );

  it.each([
    ["among other cookies", "a=1; th-locale=es; b=2"],
    ["without a space after ;", "a=1;th-locale=es"],
    ["any non-default value (a future locale)", "th-locale=fr"],
    [
      "en then es (the layout's parser reads the last)",
      "th-locale=en; th-locale=es",
    ],
    ["es then en", "th-locale=es; th-locale=en"],
  ])("no cache stamp: %s", (_label, cookie) => {
    expect(cacheControl("/about", { cookie })).toBeUndefined();
  });

  it.each([
    ["en among other cookies", "a=1; th-locale=en; b=2"],
    ["a different cookie that ends in th-locale", "xth-locale=es"],
    ["a different cookie that starts with th-locale", "th-locale2=es"],
    ["another cookie's value containing the name", "a=th-locale=es"],
    ["en with a trailing space", "th-locale=en "],
    ["unrelated cookies only", "theme=dark; session=abc"],
  ])("stays public: %s", (_label, cookie) => {
    expect(cacheControl("/about", { cookie })).toBe(
      "public, s-maxage=3600, stale-while-revalidate=7200",
    );
  });

  // Structural: PUBLIC_PAGES above is a hand list, so a NEW rule stamping
  // `public, s-maxage` without the guards would leave every case green. This
  // walks the raw `headers()` output instead. The allowlist is the `public/`
  // static files: the router's fs checker serves them without reaching the
  // app renderer, so they have no RSC redirect and no language to vary on.
  const STATIC_FILE_SOURCES = new Set([
    "/embed/:file(hf-embed\\.js|hf-resize\\.js|hf-embed\\.d\\.ts)",
    "/.well-known/apple-app-site-association",
    "/.well-known/apple-developer-merchantid-domain-association",
    "/.well-known/assetlinks.json",
  ]);

  it("every app-page rule stamping public, s-maxage carries both guards", () => {
    const stamping = rawRules.filter(
      (r) =>
        !STATIC_FILE_SOURCES.has(r.source) &&
        r.headers.some(
          (h) =>
            h.key.toLowerCase() === "cache-control" &&
            /public.*s-maxage/.test(h.value),
        ),
    );
    // Guards the filter itself: 13 such rules exist today.
    expect(stamping.length).toBeGreaterThanOrEqual(13);
    for (const rule of stamping) {
      const missing = rule.missing ?? [];
      expect(
        missing.some((m) => m.type === "header" && m.key === "RSC" && !m.value),
        `${rule.source} lacks the RSC guard`,
      ).toBe(true);
      expect(
        missing.some(
          (m) =>
            m.type === "header" &&
            m.key === "cookie" &&
            m.value?.includes("th-locale="),
        ),
        `${rule.source} lacks the language guard`,
      ).toBe(true);
    }
  });

  it("the static-file allowlist names real rules", () => {
    const sources = new Set(rawRules.map((r) => r.source));
    for (const s of STATIC_FILE_SOURCES) expect(sources.has(s), s).toBe(true);
  });

  it("the RSC guard still applies alongside it", () => {
    expect(
      cacheControl("/about", { cookie: "th-locale=en", rsc: "1" }),
    ).toBeUndefined();
  });

  it("the invite landing stays private, no-store whatever the language", () => {
    expect(
      cacheControl("/events/secret-show?invite=tok", {
        cookie: "th-locale=es",
      }),
    ).toBe("private, no-store, max-age=0");
  });
});

describe("next.config headers — Spanish twins cache like their English twin (FR-014)", () => {
  it.each([
    ["/es", "/"],
    ["/es/eventos/categoria/musica", "/events/category/music"],
    ["/es/eventos/categoria/musica/nashville-tn", "/events/category/music/nashville-tn"],
    ["/es/acerca-de", "/about"],
    ["/es/contacto", "/contact"],
  ])("%s gets the Cache-Control of %s", (es, en) => {
    expect(cacheControl(es)).toMatch(/^public, .*s-maxage=/);
    expect(cacheControl(es)).toBe(cacheControl(en));
  });

  it("keeps the shared-cache guards on /es/ pages", () => {
    expect(cacheControl("/es/acerca-de", { rsc: "1" })).toBeUndefined();
    expect(
      cacheControl("/es/eventos/categoria/musica", { cookie: "th-locale=es" }),
    ).toBeUndefined();
  });
});
