import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { withTamagui } from "@tamagui/next-plugin";
import type { Configuration as WebpackConfiguration } from "webpack";
import {
  buildNextTurbopackAliasMap,
  buildNextWebpackAliasMap,
} from "./config/aliases";
import { HELP_ARTICLE_REDIRECTS } from "./config/help-redirects";
import { MEDIA_EMBED_PROVIDERS } from "@th/core/lib/embeds/providers";
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "./src/i18n/config";

// Build the `frame-src` CSP directive from the media-embed provider metadata.
// The list of allowed iframe hosts is the single source of truth in
// `packages/core/src/lib/embeds/providers.ts`. New providers picked up here
// automatically.
const embedFrameSrcHosts = Array.from(
  new Set(
    Object.values(MEDIA_EMBED_PROVIDERS)
      .filter((p) => p.renderMode === "iframe")
      .flatMap((p) => p.cspFrameSrc),
  ),
);

// Stripe Elements (PaymentElement, ExpressCheckoutElement) renders its
// inputs inside iframes hosted on js.stripe.com / hooks.stripe.com. Without
// these in `frame-src` the CSP blocks the iframe and the buyer sees the
// surrounding form with no card field.
const stripeFrameSrcHosts = [
  "https://js.stripe.com",
  "https://hooks.stripe.com",
];

// Cloudflare Turnstile renders its bot challenge inside an iframe from
// challenges.cloudflare.com (embed guest checkout). Without this host in
// `frame-src` the CSP blocks the challenge and the widget can never produce
// a token — which hard-fails checkout once the API has TURNSTILE_SECRET_KEY
// set, because the server then requires a token the client can't mint.
const turnstileFrameSrcHosts = ["https://challenges.cloudflare.com"];

// `'self'` is required so the admin "Embeds" page can render the same-origin
// live-preview iframe (which points at /embed/[id]).
const frameSrcDirective = `frame-src 'self' ${[...embedFrameSrcHosts, ...stripeFrameSrcHosts, ...turnstileFrameSrcHosts].join(" ")}`;

// Default-src is intentionally permissive at v1; we tighten via specific directives below.
// The point of CSP at v1 is to lock down iframe sources and prevent click-jacking;
// a stricter default-src lockdown would require nonces for every Next-emitted inline script.
const contentSecurityPolicy = [
  frameSrcDirective,
  // Prevent the site from being embedded in third-party frames (click-jacking).
  "frame-ancestors 'self'",
].join("; ");

// The /embed/* routes are the public widget surface — partner sites paste an
// <iframe> snippet into WordPress/Squarespace/Wix/Shopify. We MUST allow third-
// party framing for those paths only. Click-jacking lock stays on every other
// route.
const embedContentSecurityPolicy = [
  frameSrcDirective,
  "frame-ancestors *",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Permissions-Policy",
    value: "geolocation=(self), camera=(), microphone=()",
  },
  // HSTS — the API already sends this via @fastify/helmet defaults, and
  // Cloudflare's edge sets it (with preload) in prod. This closes the gap on
  // the web origin itself, which matters when Cloud Run is hit directly.
  // Deliberately no `preload` at the app layer; the edge owns that decision.
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

// Override headers for the embed widget route. We intentionally do not emit
// X-Frame-Options anywhere; CSP frame-ancestors is the authoritative framing
// control, and the /embed override must be able to loosen that one directive
// without fighting a legacy XFO header.
//
// Referrer-Policy: a redirect payment (Amazon Pay, Cash App) returns to the
// widget with the PaymentIntent's client secret on the URL, and that secret
// is the guest's proof of payment. Under the global
// `strict-origin-when-cross-origin`, every same-origin request the page makes
// before the widget strips it (`/_next` chunks, RSC fetches) would carry the
// full URL as its Referer, into the request logs. `strict-origin` differs
// from the global policy ONLY on same-origin requests, which now carry the
// origin alone; every cross-origin request (the API, Stripe.js, Turnstile)
// sends exactly what it sent before. Not `no-referrer`: that would change
// the cross-origin ones too, and null the Origin header of the widget's
// non-CORS POSTs. Not `same-origin`: that is the leak itself. The domain
// allowlist does not read this policy: the widget's host origin comes from
// `ancestorOrigins`, or the iframe document's own `document.referrer`, which
// the HOST page's policy (our SDK stamps `referrerpolicy="strict-origin"`)
// decides, and the API never reads a Referer.
const embedFrameAllowHeaders = [
  { key: "Content-Security-Policy", value: embedContentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin" },
];

// ── RSC requests must never receive a shared-cache stamp ────────────────────
//
// Next answers a router fetch that arrives WITHOUT its cache-busting search
// param (`RSC: 1`, no `?_rsc=`) with a 307 to the `?_rsc=` form. That redirect
// exists precisely because CDNs ignore `Vary` — base-server.js calls it out as
// "prevents cache poisoning attacks on CDNs that don't respect Vary headers".
// But the 307 is emitted AFTER the header rules below have already been
// applied: router-server.js writes every `resHeaders` entry onto the response
// before the render runs, and the redirect branch never clears them. So a
// `public, s-maxage` from this file rides out ON the redirect — and Cloudflare
// files it under the PLAIN url's cache key, because the RSC request header is
// not part of that key.
//
// Net effect, reproduced against production on 2026-09-04: one unauthenticated
//     curl -H 'RSC: 1' https://ithasfire.com/events/<slug>
// puts a 307 into the edge cache, and every ordinary browser navigation to that
// page is then answered with the redirect instead of the page for the length of
// the TTL. Not self-sustaining (it must be re-poisoned every s-maxage window)
// but trivial, unauthenticated, and it worked on every public prefix.
//
// The guard: `missing: [{ type: "header", key: "RSC" }]` on every rule that
// stamps `public, s-maxage` on an APP PAGE (applied through
// `sharedCacheGuards()` below, with the language guard). `matchHas` (prepare-destination.js)
// treats a has/missing entry with no `value` as a pure presence test, and
// resolve-routes.js drops the rule when any `missing` entry matches. An
// RSC-shaped request therefore matches no cache rule at all and falls back to
// the framework's `private, no-cache, no-store, max-age=0, must-revalidate` —
// which is then what the 307 carries.
//
// Presence-only is deliberate, rather than `value: "1"`: `isRSCRequestHeader`
// accepts only the literal "1", so pinning the value would match the framework
// exactly, but over-covering costs nothing (no real client sends another value)
// and stays correct if that predicate is ever loosened.
//
// The trade-off is real and accepted: RSC flight payloads for prefetch and
// client-side navigation (`?_rsc=<hash>` — a distinct cache key) stop being
// edge-cacheable and go to the origin. Only SOFT navigation is affected; every
// cold document load, crawl and share-preview keeps its edge cache. The
// narrower alternative — a second rule with `has: [RSC, _rsc]` to keep those
// cached — was rejected because it leaves a live poisoning primitive: `_rsc` is
// a hash over client-controlled headers, so an attacker can send a
// deliberately-mismatched pair and plant a self-referential 307 under a `_rsc`
// value that real clients use. That only degrades soft navigation to a full
// reload rather than leaking anything, but it keeps the class alive.
//
// NOT applied to the static entries (`/embed/hf-embed.js`, `/.well-known/*`):
// those are files in `public/`, served by the router's fs checker without ever
// reaching the app renderer, so they have no RSC redirect branch to poison.
//
// Cloudflare carries the same decision as defence in depth — see
// `infra/terraform/modules/cloudflare-cache/main.tf`. Change both together.
//
// Returns a FRESH array per call so no two rules share a mutable object.
const notAnRscRequest = () => [{ type: "header" as const, key: "RSC" }];

// ── A reader's language choice must never receive a shared-cache stamp ──────
//
// The root layout renders in the reader's language: the `th-locale` cookie
// (their explicit choice) wins, then Accept-Language (`resolveLocale`). The
// Cloudflare cache key is the URL alone, and cookies in a custom cache key are
// Enterprise-only (the zone is on Free). So a Spanish render stamped `public,
// s-maxage` would be stored and served to English readers for the TTL, and a
// Spanish chooser would be served cached English (the flicker the cookie
// exists to remove). Owner ruling 2026-10-17: a reader who chose a non-default
// language bypasses the shared cache.
//
// The guard: a `missing` entry on the raw `Cookie` header that matches when
// it carries a `th-locale` pair whose value is anything but the default.
// Such a request matches no cache rule and falls back to the framework's
// `private, no-cache, no-store, max-age=0, must-revalidate` (every page is
// dynamic: the root layout awaits `cookies()` and `headers()`), which
// Cloudflare honours as BYPASS.
//
// Why `type: "header"` with a regex rather than `type: "cookie"`: the two
// parsers disagree on a repeated name. `matchHas` parses cookies with
// `next/dist/compiled/cookie`, where the FIRST `th-locale` wins; `cookies()`
// in the layout uses `@edge-runtime/cookies`, where the LAST wins. A crafted
// `Cookie: th-locale=en; th-locale=es` would pass a cookie-typed guard as
// English and render Spanish with a public stamp. The header regex matches if
// ANY `th-locale` pair is non-default, which covers both parsers.
//
// "Anything but the default" rather than a list of the other locales, so a
// new locale needs no edit here. It over-covers garbage values (`th-locale=fr`,
// an empty value), which `resolveLocale` ignores in favour of Accept-Language:
// those requests lose the edge cache, which costs an origin render and nothing
// else. The name is matched exactly (start of header or after `;`), so an
// unrelated `xth-locale=` cookie does not trip it. Next anchors the value as
// `^…$`.
//
// Not covered here, and pre-existing: a reader with NO cookie whose
// Accept-Language resolves to a non-default locale also renders that locale.
//
// Cloudflare carries the same decision as a lookup bypass, so the chooser
// never gets a cached hit — see `infra/terraform/modules/cloudflare-cache/
// main.tf`. Change both together.
const notAChosenLanguage = () => [
  {
    type: "header" as const,
    key: "cookie",
    value: `(?:.*;)?\\s*${LOCALE_COOKIE}=(?!${DEFAULT_LOCALE}\\s*(?:;|$)).*`,
  },
];

// Every rule that stamps `public, s-maxage` on an APP PAGE carries both
// guards above. Fresh array per call, as above.
const sharedCacheGuards = () => [...notAnRscRequest(), ...notAChosenLanguage()];

const moduleUrl = import.meta.url;
const isFileUrl = moduleUrl.startsWith("file:");
const fallbackFileUrl = new URL(
  "./next.config.ts",
  pathToFileURL(process.cwd()).href,
);
const resolvedModuleUrl = isFileUrl ? new URL(moduleUrl) : fallbackFileUrl;
const dirname = fileURLToPath(new URL(".", resolvedModuleUrl));
const require = createRequire(resolvedModuleUrl);

const aliasMap = buildNextTurbopackAliasMap();
const webpackAliasMap = buildNextWebpackAliasMap(dirname);
const localDevOrigins = [3000, 3001, 3002, 3003, 3004, 3005].flatMap((port) => [
  `localhost:${port}`,
  `127.0.0.1:${port}`,
]);

const flowBabelOptions = {
  babelrc: false,
  configFile: false,
  presets: [
    require.resolve("@babel/preset-flow"),
    [require.resolve("@babel/preset-react"), { runtime: "automatic" }],
  ],
  plugins: [
    require.resolve("@babel/plugin-syntax-typescript"),
    // React Native ships Flow files that also contain TS-style `as` assertions (e.g. `$FlowFixMe`).
    // The syntax plugin alone only *parses* them; we must *strip* them so both Webpack + Turbopack can bundle.
    require.resolve("@babel/plugin-transform-typescript"),
  ],
};

const trpcDistResourcePattern =
  /node_modules[\\/]+@trpc[\\/](?:react-query|client|server)[\\/]dist[\\/].*\.mjs$/;

const turbopackFlowLoader = {
  loaders: [
    {
      loader: require.resolve("babel-loader"),
      options: flowBabelOptions,
    },
  ],
  as: "*.js",
};

const nextConfig: NextConfig = {
  // Standalone output: Next.js traces only the files actually needed and
  // emits .next/standalone/ — a self-contained minimal server with zero
  // node_modules ceremony. The Dockerfile copies that folder directly into
  // the runtime image, cutting image size and cold-start time significantly.
  output: "standalone",

  // Move the dev-only "Open Dev Tools" floating button out of the bottom-
  // left, where it lands on top of the embed checkout's sticky CTA footer
  // and makes the flow uninteractive in local dev. Dev-only — production
  // doesn't render the indicator. Pinned to bottom-right so it stays out
  // of the way of the embed widget while still being reachable.
  devIndicators: {
    position: "bottom-right",
  },

  // Cloud Run sits behind Cloudflare (brotli/gzip at the edge) and the GCP
  // L7 load-balancer (gzip). Having Node also compress wastes CPU for no gain.
  compress: false,

  // Don't advertise what we're running on.
  poweredByHeader: false,

  // Use the git SHA as the build ID so /_next/static/<id>/ is deterministic
  // per commit, enabling pre-populated CDN caches without stale asset risk.
  generateBuildId: () => process.env.NEXT_PUBLIC_BUILD_SHA ?? "local",

  // Renamed help-article slugs: old URL -> new URL, permanent (308).
  // eslint-disable-next-line @typescript-eslint/require-await
  async redirects() {
    return HELP_ARTICLE_REDIRECTS;
  },

  // ── Edge cache headers ──────────────────────────────────────────────────
  // Cloudflare respects s-maxage for edge caching and stale-while-revalidate
  // for serving stale content while fetching a fresh copy in the background.
  // This keeps Cloud Run invocations low — most traffic is served from edge.
  // Next requires this hook to return a Promise-compatible value.
  // eslint-disable-next-line @typescript-eslint/require-await
  async headers() {
    return [
      // Security headers — applied to every route. CSP frame-src is the
      // load-bearing directive for the media-embed feature.
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // Keep admin + moderation surfaces out of search indexes. The routes
      // already export `robots: { index: false }` metadata; this header is
      // defense-in-depth so coverage survives if a page ever becomes a client
      // component (metadata robots only cover server-rendered HTML). The
      // `:path*` wildcard matches zero segments, so `/admin/:path*` covers
      // `/admin` too; bare-path entries are kept for explicitness.
      {
        source: "/admin",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/admin/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/moderate",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/moderate/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      // Printable documents (the print layer). A printed ticket is a BEARER
      // CREDENTIAL — the code on the paper is the whole of the authorisation at
      // the door — so the route that renders it is kept out of indexes, out of
      // caches, and out of Referer headers.
      //
      // `Referrer-Policy: no-referrer` is the load-bearing one: the sheet loads
      // `/tickets/qr/<code>` sub-resources and links onward, and the default
      // `strict-origin-when-cross-origin` would still leak the full same-origin
      // URL (which contains the order id) to any same-origin request. The QR
      // route already sends `no-referrer` for itself; this covers the document.
      //
      // The route also exports `robots: { index: false }` metadata; the header
      // is defence in depth for the client-component case, matching the /admin
      // and /moderate entries above.
      {
        source: "/my-tickets/:orderId/print",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          {
            key: "Cache-Control",
            value: "private, no-store, max-age=0, must-revalidate",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // The volunteer hours statement. Not a bearer credential, but a NAMED
      // record of one person's whereabouts over months — where they were, when,
      // and for whom — so it gets the same posture: no index, no shared cache,
      // no Referer leakage.
      {
        source: "/my-volunteering/hours/print",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          {
            key: "Cache-Control",
            value: "private, no-store, max-age=0, must-revalidate",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // The volunteer's OWN check-in code. A QR, not a badge — but the signed
      // token on the paper is still a bearer credential, and the URL carries an
      // event id in a query string, so the same posture applies.
      {
        source: "/my-volunteering/qr/print",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          {
            key: "Cache-Control",
            value: "private, no-store, max-age=0, must-revalidate",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // Invitation accept pages carry a BEARER token in the query string
      // (`?token=`). `no-referrer` keeps it out of the Referer of every
      // sub-resource and outbound link (the default policy still sends the
      // full URL same-origin); no-store keeps it out of shared caches. The
      // legacy `/invitations/accept` redirect stub carries the same token.
      ...["/invite/accept", "/invitations/accept", "/delegate/accept"].map(
        (source) => ({
          source,
          headers: [
            { key: "X-Robots-Tag", value: "noindex, nofollow" },
            {
              key: "Cache-Control",
              value: "private, no-store, max-age=0, must-revalidate",
            },
            { key: "Referrer-Policy", value: "no-referrer" },
          ],
        }),
      ),
      // The volunteer BADGE sheet — organizer/venue-issued credential stock.
      // The `/admin/:path*` rule above already supplies `X-Robots-Tag`, but not
      // the other two, and this document needs both: every badge on the page
      // carries a signed volunteer scan token that is live until shortly after
      // the event, so a whole roster's worth of bearer credentials must never
      // sit in a shared cache, and the URL (which names the event) must not
      // ride out in a Referer header. Same posture as the ticket sheet, for the
      // same reason, at roster scale.
      {
        source: "/admin/:slug/events/:eventId/volunteers/badges/print",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          {
            key: "Cache-Control",
            value: "private, no-store, max-age=0, must-revalidate",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // Public embed widget — must be framable by third-party customer sites.
      // This entry overrides the click-jack lock from the global rule above
      // (Next.js merges header rules; later matches win for the same key).
      {
        source: "/embed/:path*",
        headers: embedFrameAllowHeaders,
      },
      // Embed loader SDK + resize helper — static assets fetched by every
      // third-party page that embeds a widget. Without an explicit origin
      // cache policy Cloudflare revalidates on every request (weak ETag), so
      // when the web container is scaled to zero the 17KB script waits out a
      // full Cloud Run cold start before the embed button can even render.
      // s-maxage lets the edge serve HITs for a day with no origin trip;
      // browsers re-check hourly so SDK updates still roll out same-day.
      // stale-while-revalidate keeps serving during background refreshes.
      {
        source: "/embed/:file(hf-embed\\.js|hf-resize\\.js|hf-embed\\.d\\.ts)",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          },
        ],
      },
      // Embed auth-handoff popup — the ONE /embed/* page that must never run
      // framed: it mints a bearer JWT against the first-party session and
      // postMessages it to its opener (booking-request-embed-button FR-010).
      // Re-apply the global click-jack lock so the frame-permissive /embed
      // override above never covers it (same later-match-wins mechanism the
      // /embed override itself relies on). The page also refuses to operate
      // framed client-side — this header makes that defense structural.
      {
        source: "/embed/auth-handoff",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
        ],
      },
      // Apple App Site Association — extensionless file Apple fetches to
      // verify which apps are allowed to claim webcredentials / universal
      // links for this domain. MUST be served with `application/json` and
      // MUST be reachable at exactly /.well-known/apple-app-site-association
      // (no .json suffix).
      {
        source: "/.well-known/apple-app-site-association",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
      // Apple Pay merchant domain association — extensionless file Stripe
      // fetches to verify this domain when registering it for Apple Pay
      // Express Checkout. Placeholder lives in public/.well-known/ until
      // a real token is pasted in (see the file itself for the workflow).
      // Served as plain text; Stripe's verifier doesn't care as long as
      // the file contents match what their dashboard issued.
      {
        source: "/.well-known/apple-developer-merchantid-domain-association",
        headers: [
          { key: "Content-Type", value: "text/plain; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
      // Android Asset Links — equivalent for Credential Manager + App Links.
      {
        source: "/.well-known/assetlinks.json",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
      // Event pages — cache 2 min at edge, serve stale up to 5 min while revalidating.
      //
      // The `/events` prefix is NOT uniformly public: it also contains the two
      // buyer PAYMENT surfaces, `events/checkout/[...slug]` and
      // `events/resale/[listingId]`. Those render per-buyer state (holds, fee
      // quotes, Stripe intents) and must never sit in a shared cache. Until
      // 2026-09 a blanket `/events/:path*` rule stamped `public, s-maxage=120`
      // on them, and production was observed serving checkout HTML with
      // `cf-cache-status: EXPIRED` — i.e. it had been cached at the edge.
      //
      // The fix is to NARROW THE SOURCE rather than add a later rule that
      // re-sets Cache-Control for the payment paths. A later rule would win the
      // key (`resolve-routes.js` assigns `resHeaders[key] = value`), but it
      // would also keep the header PRESENT — and `send-payload.js` only emits
      // Next's own value when the response has none ("If cache control is
      // already set on the response we don't override it"). So an override rule
      // permanently suppresses the framework's `private, no-cache, no-store,
      // max-age=0, must-revalidate` and freezes these routes' cache policy in
      // this file. Removing the match hands the decision back to the framework,
      // and Cloudflare honours the resulting no-store (`cf-cache-status:
      // BYPASS`) even though the cache rule says `cache = true`.
      //
      // Watch `export const revalidate = 60` on the checkout page: it is inert
      // today only because the page awaits `searchParams` and `cookies()` and
      // is therefore dynamically rendered. If that ever stops being true, that
      // export becomes a public `s-maxage=60` and re-caches the route. The
      // Cloudflare exclusion is the backstop for exactly that.
      //
      // The lookahead is anchored to a segment boundary — `(?:/|$)` — so an org
      // slug that merely STARTS with "checkout" (e.g.
      // `/events/checkout-collective/us/nashville/gig`) keeps its cache header.
      // A custom-regex param is required (not optional like `:path*`), so bare
      // `/events` needs its own entry below.
      //
      // The Cloudflare side carries the same exclusions as defence in depth —
      // see `infra/terraform/modules/cloudflare-cache/main.tf`.
      {
        source: "/events",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=120, stale-while-revalidate=300",
          },
        ],
      },
      {
        source: "/events/:path((?!checkout(?:/|$)|resale(?:/|$)).*)",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            // `max-age=0`: an old slug answers with a 308 (EventSlugHistory),
            // and a browser keeps a 308 with no max-age forever. If the
            // event's slug later returns to a value it had before, that
            // stored hop would loop. The edge still caches for s-maxage.
            value: "public, max-age=0, s-maxage=120, stale-while-revalidate=300",
          },
        ],
      },
      // Place / org / human profile pages — cache 2 min
      {
        source: "/places/:path*",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            // `max-age=0`: an old place slug answers with a 308
            // (PageSlugHistory), and a browser keeps a 308 with no
            // max-age forever. Slugs can be edited back to an earlier value,
            // and that stored hop would then loop. The edge still caches for
            // s-maxage.
            value: "public, max-age=0, s-maxage=120, stale-while-revalidate=300",
          },
        ],
      },
      {
        source: "/orgs/:path*",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=120, stale-while-revalidate=300",
          },
        ],
      },
      {
        source: "/humans/:path*",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=120, stale-while-revalidate=300",
          },
        ],
      },
      // Entity pages — cache 2 min
      {
        source: "/p/:path*",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=120, stale-while-revalidate=300",
          },
        ],
      },
      // Homepage — cache 5 min at the edge.
      //
      // THIS is the header Cloudflare acts on, not `export const revalidate` in
      // `app/page.tsx`: `cloudflare-cache` caches web HTML with
      // `edge_ttl.mode = "respect_origin"`, and the page is dynamically
      // rendered (the SSR tRPC client's header callback awaits `headers()`), so
      // Next's own route cache never engages. Change the TTL here.
      //
      // Raised 60s → 300s because origin renders are governed by the
      // revalidation clock rather than by traffic: measured 2026-08-25, the home
      // page drove ~12,320 origin renders/week — roughly one per minute per hot
      // Cloudflare colo — and about 32% of ALL production SQL. Five minutes of
      // staleness on a discovery surface is well inside what this app already
      // accepts (`events/category/:slug/:city` runs at 3600).
      //
      // Note there is no CDN purge yet, so this TTL is the ONLY freshness
      // control on the home page — see the note in
      // `app/api/places/[placeId]/revalidate/route.ts`.
      {
        source: "/",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=300, stale-while-revalidate=600",
          },
        ],
      },
      // Static info pages — cache 1 hour
      {
        source: "/about",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      {
        source: "/privacy",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      {
        source: "/terms",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      {
        source: "/acceptable-use",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      {
        source: "/cookie-policy",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      {
        source: "/contact",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      // Spanish twins (spanish-seo FR-014): each /es/ page caches exactly like
      // its English twin above. Change a TTL in both places.
      {
        source: "/es",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=300, stale-while-revalidate=600",
          },
        ],
      },
      {
        // Category and category-in-a-city pages. `max-age=0` as on /events:
        // an old or other-language slug answers with a 308, and a browser
        // keeps a 308 with no max-age forever, so a slug changed back would
        // loop. The edge still caches for s-maxage.
        source: "/es/eventos/:path*",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, s-maxage=120, stale-while-revalidate=300",
          },
        ],
      },
      {
        source: "/es/acerca-de",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      {
        source: "/es/contacto",
        missing: sharedCacheGuards(),
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=3600, stale-while-revalidate=7200",
          },
        ],
      },
      // Invite-link landing: `/events/<slug>?invite=<token>` (gated-event
      // invite links NFR-002). The URL carries a bearer token, so:
      //   - `Referrer-Policy: no-referrer` keeps it out of the Referer of every
      //     subresource and outbound link on the page (overrides the global
      //     `strict-origin-when-cross-origin`, which would still send the path
      //     same-origin);
      //   - `private, no-store` keeps the token URL out of every cache. It
      //     overrides the event page's `public, s-maxage` above.
      // MUST stay AFTER the `/:path*` security rule and the `/events/...`
      // cache rule: `resolve-routes.js` assigns `resHeaders[key] = value` in
      // rule order, so the later match wins the key. `has` with no `value` is a
      // presence test, so the clean event URL never matches and keeps its
      // edge-cacheable headers. Same source as the event page rule above, so
      // checkout / resale keep the framework's own Cache-Control. No
      // `sharedCacheGuards()`: no-store is safe on an RSC request and on a
      // chosen language too.
      {
        source: "/events/:path((?!checkout(?:/|$)|resale(?:/|$)).*)",
        has: [{ type: "query", key: "invite" }],
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // The invite redeem route sets `Referrer-Policy: no-referrer` itself,
      // but a config rule beats a route handler's header for the same key
      // (measured on `next dev` 2026-10-05: the global `/:path*` value came
      // out), so the route's value only survives if a later rule agrees.
      {
        source: "/api/events/:eventId/invite",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      // The read-only invite peek takes the same token; same reason as above.
      {
        source: "/api/events/:eventId/invite/peek",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      // The application-approval claim link (`?token=<uuid>`, emailed on
      // approval) carries a bearer token. The route sets no-referrer itself,
      // but the global `/:path*` rule beats it (same cause as the invite
      // routes above). Its redirect target is the clean `/events/<slug>`, so
      // no page rule is needed.
      {
        source: "/api/events/:eventId/claim",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      // "Stop invites from this organiser" (security review W4): the email
      // footer links to `/invites/stop?token=<opt-out token>`, a bearer token
      // for one address at one organiser. Keep it out of every cache and
      // Referer, and out of search results. MUST stay after `/:path*` (later
      // rule wins the key, see above).
      {
        source: "/invites/stop",
        headers: [
          {
            key: "Cache-Control",
            value: "private, no-store, max-age=0, must-revalidate",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      // The RFC 8058 one-click POST target takes the same token in its query.
      {
        source: "/api/invites/stop",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },

  images: {
    // SVG posters: next/image refuses SVG unless explicitly allowed. Safe here
    // because every optimized-image response is forced to download instead of
    // render as a document (contentDispositionType) and carries a CSP that
    // blocks script execution and sandboxes the response entirely.
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: [
      // Unsplash — used by seed / test-data hero images
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      // S3 CDN — production event images (Cloudflare R2 or any S3-compatible store).
      // The actual hostname is set via S3_PUBLIC_BASE_URL; allow the
      // wildcard sub-domain so it works across staging / prod buckets.
      ...(process.env.NEXT_PUBLIC_CDN_HOSTNAME
        ? [
            {
              protocol: "https" as const,
              hostname: process.env.NEXT_PUBLIC_CDN_HOSTNAME,
            },
          ]
        : []),
    ],
  },
  // Next.js dev security hardening: allow internal /_next assets to be requested
  // from additional local origins (e.g. Playwright uses 127.0.0.1 by default).
  // This only affects development.
  allowedDevOrigins: [...localDevOrigins, "localhost:3100", "127.0.0.1:3100"],
  turbopack: {
    resolveAlias: aliasMap,
    // Mirror the webpack `.web.tsx` extension priority so Turbopack picks the
    // web variant of platform-split modules (e.g. SonnerBridge.web.tsx) before
    // falling through to the bare `.tsx`/`.ts`. Without this Turbopack can't
    // resolve `./SonnerBridge` to its web sibling and the build fails.
    resolveExtensions: [
      ".web.tsx",
      ".web.ts",
      ".web.jsx",
      ".web.js",
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".mjs",
      ".cjs",
      ".json",
    ],
    rules: {
      "**/node_modules/react-native/**/*.js": turbopackFlowLoader,
      "**/node_modules/react-native/**/*.mjs": turbopackFlowLoader,
    },
  },
  experimental: {
    // Required by <PageTransition> (app/_components/PageTransition.tsx), which
    // enables React's <ViewTransition> on the PUBLIC surface only — the dense
    // admin/platform/moderate shells opt out because the boundary replays its
    // animation on every streaming navigation. See that file for the full why.
    viewTransition: true,
    // Persist Turbopack's dev compile cache to .next/cache so memory eviction
    // (turbopackMemoryEviction, default 'auto') can drop idle routes from RAM.
    // Without this the dev server retains ~150-200MB per compiled route forever.
    turbopackFileSystemCacheForDev: true,
    // We run our own Flow-aware babel-loader for React Native packages so Turbopack
    // shouldn’t inject its default loader (which also spams warnings).
    turbopackUseBuiltinBabel: false,
    // Each entry tells Turbopack to inline a per-named-export module
    // resolver instead of pulling the whole barrel — drastically cuts
    // the dev module graph for libraries we only use a slice of.
    optimizePackageImports: [
      "lucide-react",
      "@th/ui",
      "tamagui",
      "@tanstack/react-query",
      "@stripe/react-stripe-js",
      "date-fns",
    ],
  },
  transpilePackages: [
    "@th/ui",
    "country-state-city",
    "react-native",
    "react-native-web",
    "react-native-gesture-handler",
    "react-native-reanimated",
    "@shopify/react-native-skia",
    "tamagui",
  ],
  webpack: (config: WebpackConfiguration) => {
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      ...webpackAliasMap,
    };
    config.resolve.extensions = Array.from(
      new Set([
        ".web.ts",
        ".web.tsx",
        ".web.js",
        ".web.jsx",
        ...(config.resolve.extensions ?? []),
      ]),
    );

    config.optimization ??= {};
    config.optimization.concatenateModules = false;

    config.module ??= { rules: [] };
    config.module.rules ??= [];
    config.module.rules.push(
      {
        test: /node_modules[\\/]+react-native-reanimated[\\/].*\.mjs$/,
        type: "javascript/auto",
      },
      {
        test: trpcDistResourcePattern,
        type: "javascript/auto",
        parser: {
          javascript: {
            exportsPresence: "warn",
          },
        },
      },
      {
        test: /node_modules[\\/]+react-native[\\/].*\.[mc]?js$/,
        use: {
          loader: require.resolve("babel-loader"),
          options: flowBabelOptions,
        },
      },
    );

    return config;
  },

  rewrites() {
    const staticRewrites = [
      {
        source: "/apple-touch-icon.png",
        destination: "/icons/icon-192.png",
      },
      {
        source: "/apple-touch-icon-precomposed.png",
        destination: "/icons/icon-192.png",
      },
    ];
    const apiOrigin =
      process.env.WEB_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
    if (!apiOrigin) {
      return staticRewrites;
    }

    // Optional fallback: allow the web app to proxy /trpc to the API.
    // This can help local dev when the browser is pointed at the Next origin.
    return [
      ...staticRewrites,
      {
        source: "/trpc/:path*",
        destination: `${apiOrigin.replace(/\/+$/, "")}/trpc/:path*`,
      },
    ];
  },
};

// `@tamagui/next-plugin` only hooks into webpack — it is a no-op when
// Next.js runs with `--turbopack` (the default for our `pnpm build` /
// `pnpm dev`). Wiring it here means the `pnpm smoke` webpack build path
// (and any future Turbopack→webpack fallback) gets compile-time CSS
// extraction without further config. When/if Tamagui ships an SWC plugin,
// we can swap this for that and finally extract under Turbopack too.
const withTamaguiPlugin = withTamagui({
  components: ["@th/ui", "tamagui"],
  config: "./tamagui.config.ts",
  appDir: true,
  disableExtraction: process.env.NODE_ENV === "development",
  disableOptimizeLucideIcons: true,
});

const configWithTamagui = withTamaguiPlugin(nextConfig);

// Importing `@tamagui/next-plugin` transitively loads `tamagui-loader`, whose
// module side effect sets `process.env.IS_STATIC = "is_static"` — a flag meant
// only for Tamagui's static-extraction compiler. Under webpack the plugin
// masks this by inlining `process.env.IS_STATIC = ""` into both bundles, but
// under Turbopack the webpack hook never runs and the SSR runtime shares this
// process's env. With the flag set, `@tamagui/web`'s getSplitStyles skips
// stripping inline styles on the server while the client (where the flag is
// undefined) strips them — making every Tamagui element a React hydration
// attribute mismatch in dev. Clear it so SSR and client both take the same
// className-only path.
delete process.env.IS_STATIC;

export default withSentryConfig(configWithTamagui, {
  // Sentry org + project slugs (also settable via SENTRY_ORG / SENTRY_PROJECT env)
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Source map upload auth token — reads from .env.sentry-build-plugin or CI env
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload a wider set of client source files for better stack trace resolution
  widenClientFileUpload: true,

  // Proxy route that tunnels Sentry events to bypass ad-blockers
  tunnelRoute: "/monitoring",

  // Suppress noisy build output outside CI
  silent: !process.env.CI,
});
