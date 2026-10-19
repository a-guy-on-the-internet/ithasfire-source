# Ithas Fire Web

Next.js (App Router) surface for Ithas Fire. This app renders event detail pages, injects schema.org JSON-LD, and coordinates SEO metadata using the shared helpers in `@th/types/seo`.

## Environment

Set the following variables in `apps/web/.env.local` or your shell:

| Variable                          | Purpose                                                                                                             | Default                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`            | Public origin used for canonical URLs and metadata.                                                                 | `http://localhost:3000`                                         |
| `NEXT_PUBLIC_SITE_NAME`           | Human-readable site name applied to metadata.                                                                       | `Ithas Fire`                                                    |
| `WEB_API_BASE_URL`                | Base URL for the internal API used to load event data.                                                              | `http://localhost:3001` (auto-set by `scripts/run-web-dev.cjs`) |
| `WEB_EVENT_RESOURCE_PATH`         | Path for the events resource on the API; a leading slash is added if missing. Only the URL helpers in `src/config/api.ts` read it, and they have no callers, so setting it changes nothing today. | `/v1/events`                                                    |
| `WEB_SMOKE_BUILD`                 | When set to `true`, skips live API calls and serves fixture sitemap data.                                           | _unset_                                                         |
| `NEXT_PUBLIC_TILESERVER_URL`      | Base URL of the self-hosted TileServer GL instance. Required for map previews, static maps, and coordinate pickers. | _unset_                                                         |
| `NEXT_PUBLIC_GEOAPIFY_API_KEY`    | Geoapify API key for geocoding.                                                                                     | _unset_                                                         |

Example:

```bash
NEXT_PUBLIC_SITE_URL=https://tickets.example.com
WEB_API_BASE_URL=https://api.example.com
NEXT_PUBLIC_TILESERVER_URL=https://tiles.example.com
```

Map previews and the coordinate picker need `NEXT_PUBLIC_TILESERVER_URL`; geocoding needs `NEXT_PUBLIC_GEOAPIFY_API_KEY`. Maps render with MapLibre against the tile server, not Google Maps. Configure both for a realistic editing experience.

## Development

```bash
pnpm -F web dev
```

This starts the Next.js dev server at `http://localhost:3000`.

### Helper script (recommended)

```bash
pnpm web:dev:local
```

The helper wraps `pnpm -F web dev` but guarantees `WEB_API_BASE_URL` is present. By default it points to `http://localhost:3001`; override it with `pnpm web:dev:local --base https://api.dev.example.com` or by exporting `WEB_API_BASE_URL` yourself.

### Smoke builds

```bash
pnpm --filter web smoke
```

The smoke script sets `WEB_SMOKE_BUILD=true`, which short-circuits the sitemap loader to a small list of representative events (Brooklyn Block Party Night, Hollywood Bowl Summer Series, Techstars Demo Day NYC). This keeps the build fast and deterministic—even without API credentials—while still emitting meaningful URLs for QA and SEO tooling.

### TRPC webpack quirk

Some TRPC v11 packages (`@trpc/client`, `@trpc/react-query`, `@trpc/server`) ship hybrid CommonJS helpers inside `.mjs` files. Webpack would previously mis-detect their exports and throw `Attempted import error` during smoke builds. Our `next.config.ts` now forces any `@trpc/*/dist/*.mjs` file to use the `javascript/auto` parser and downgrades missing exports to warnings. If you bump TRPC or reorganise vendor bundling, make sure this rule remains or is updated so smoke builds stay green without hacks.

## Testing

Run web vitest from inside `apps/web` (project rule; other working directories break it):

```bash
cd apps/web && pnpm test:run
```

Typecheck with `pnpm typecheck:web`. Plain `pnpm typecheck` covers `packages/**` only and skips this app. For e2e, see `apps/web/e2e/README.md`: set `E2E_USE_LIVE_STACK=1` or the harness wipes your dev database.

Tests cover the SEO components (`apps/web/src/components/seo`), the server helpers that translate API responses into `SeoEvent` payloads, and the rest of the app.

## Architecture Notes

- Shared SEO logic lives under `packages/types/src/seo`. The web app consumes these helpers for deterministic JSON-LD and metadata output.
- `apps/web/src/components/seo` contains server components that render structured data safely.
- `apps/web/src/server/events.ts` fetches event details and normalises them with `mapEventToSeo`. The sitemap-index plus per-section sub-sitemaps are generated nightly by the `sitemaps.generate` job (`apps/jobs/src/jobs/sitemaps.ts`) and served from the public CDN bucket; `robots.ts` advertises the CDN URL when `SITEMAP_CDN_URL` is configured.
- Event detail pages are served by the catch-all `apps/web/src/app/events/[...slug]/page.tsx` (`/events/<slug>`), revalidating every 60 seconds by default.

For additional guardrails, review `docs/engineering-standards.md` and the SEO helper tests in `packages/types/src/seo/__tests__`.
