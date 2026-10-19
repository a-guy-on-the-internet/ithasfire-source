# Home Discovery — Consolidate to 1 API call + 1 Meilisearch round trip + edge cache

**Date:** 2026-04-27
**Status:** superseded/abandoned — this spec's consolidation plan builds further on `trendingEvents`/`HotEventsPort`, which were fully removed per `docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml` (FR-005). Do not implement as written.
**Priority:** P1 (perf, simplification)
**Depends on:** `MultiSearchQueryPort`, `HotEventsPort`, existing `featuredEvents` / `tieredPopularEvents` / `trendingEvents` use cases, Cloudflare cache module (`infra/terraform/modules/cloudflare-cache`)
**Supersedes:** N/A (new)

---

## Problem

The home page (`apps/web/src/app/_components/HomeLayout.tsx`) fires 3 search-related tRPC queries on mount, plus 2 non-search queries:

| Call | Backend | Real cost |
|------|---------|-----------|
| `search.tieredPopularEvents` | Meilisearch | **1–4 sequential `index.search()`** (loops geo tiers until `minResults` met) |
| `search.featuredEvents` | Meilisearch | 1 `index.search()` |
| `search.trendingEvents` | Redis + Postgres | 1 Redis ZRANGE + 1 batch DB lookup |
| `featuredItems.list` | Postgres | 1 query (not search, leave alone) |
| `platform.getPublicSettings` | Postgres | 1 query, cached (leave alone) |

Worst case: **5 tRPC round trips, ~6 Meilisearch HTTP calls**, all serialized at the network layer.

The page itself is `dynamic = "force-dynamic"`, `revalidate = 0` — opted entirely out of caching, so every visit hits origin.

## Goal

Collapse the home page's discovery payload into **1 tRPC call** that internally performs **1 Meilisearch `/multi-search` request** (federated server-side parallelism) plus **1 Redis call** for trending. Make the resulting page cacheable at the Cloudflare edge for unauthenticated visitors so most home page loads never hit our origin at all.

---

## Context

| What exists | Where |
|---|---|
| Home page entry | `apps/web/src/app/page.tsx` |
| Home layout (5 useQuery calls) | `apps/web/src/app/_components/HomeLayout.tsx:60-219` |
| `usePopularEvents` / `useFeaturedEvents` / `useTrendingEvents` hooks | `apps/web/src/hooks/` |
| `MultiSearchQueryPort` (only `autocomplete` + `health` today) | `packages/ports/src/search/multi-index.port.ts:22-35` |
| Meilisearch adapter (`autocomplete` only, no `multiSearch`) | `packages/adapters/src/search/multi-index-meilisearch-adapter.ts:231-286` |
| `featuredEvents` use case | `packages/core/src/use-cases/search/featured-events.ts` |
| `tieredPopularEvents` use case (loop of 1–4 searches) | `packages/core/src/use-cases/search/tiered-popular-events.ts:57-131` |
| `trendingEvents` use case (Redis-backed) | `packages/core/src/use-cases/search/trending-events.ts` |
| `HotEventsPort` (Redis ZRANGE) | `packages/ports/src/hot-events.ts:94-124` |
| tRPC router | `packages/transport/trpc/src/routers/unified-search.ts:254-368` |
| **Cloudflare cache module — already respects origin `Cache-Control` on `web_host`** | `infra/terraform/modules/cloudflare-cache/main.tf:172-192` |
| `meilisearch` npm package supports `client.multiSearch({ queries: [...] })` | npm `meilisearch` SDK |

The Cloudflare config is **already wired** to honor `Cache-Control: s-maxage=N` from the Next.js origin for any path on `web_host` that isn't `/admin`, `/platform`, `/api`, `/_next/`, or auth paths. We don't need new Terraform — only Next.js needs to start emitting the right headers.

---

## Design

### A. Search port: add `multiSearch`

**File:** `packages/ports/src/search/multi-index.port.ts`

```ts
export interface MultiSearchQueryPort {
  autocomplete(input: MultiSearchAutocompleteInput): Promise<...>;

  /**
   * Run N searches in a single Meilisearch `/multi-search` request.
   * Server-side parallelism — N queries, 1 HTTP round trip, 1 TLS handshake.
   * Each query carries an `id` so callers can map results back without
   * relying on array order.
   */
  multiSearch(input: {
    queries: Array<MultiSearchAutocompleteInput & { id: string }>;
  }): Promise<Result<MultiSearchBatchOutput, SearchPortError>>;

  health?(): Promise<SearchHealthStatus>;
}

export interface MultiSearchBatchOutput {
  results: Record<string, MultiSearchAutocompleteOutput>;
  latencyMs: number;
}
```

### B. Meilisearch adapter

**File:** `packages/adapters/src/search/multi-index-meilisearch-adapter.ts`

Implement using `client.multiSearch({ queries: [...] })`. Reuse `buildSearchParams()` to translate each query's filters. Map response back into `Record<string, MultiSearchAutocompleteOutput>` keyed by the caller-supplied `id`.

Per-query failures are returned as `{ ok: false }` results in the record so callers can render an empty section without failing the whole response.

### C. New use case: `getHomeDiscovery`

**File (new):** `packages/core/src/use-cases/search/get-home-discovery.ts`

Input:
```ts
{
  lat?: number;
  lng?: number;
  regionCode?: string;     // e.g. "us-tx"
  countryCode?: string;    // e.g. "us"
  geohashPrefix?: string;  // for trending bucket
  limit?: number;          // per-section, default 12
}
```

Output (mirrors what HomeLayout consumes today):
```ts
{
  featured: EventSummary[];
  popular: { events: EventSummary[]; tier: "local" | "regional" | "country" | "global" };
  trending: { events: EventSummary[]; bucket: string; asOf: Date };
  asOf: Date;
}
```

Implementation:
1. Build the multi-search batch:
   - `featured` — `query: ""`, `publishedOnly: true`, `dateRange.from = now`, optional geo/region
   - `popular_local` — geo filter, smallest radius
   - `popular_regional` — geo filter, larger radius
   - `popular_country` — region filter (country code)
   - `popular_global` — no geo filter (fallback)
2. `Promise.all([search.multiSearch({queries}), trendingEvents(...)])`
3. Pick the first popular tier where `events.length >= minResults` (mirrors today's fallback, but all tiers ran in parallel server-side).
4. Return shaped output.

This collapses today's ~6 Meili calls into **1**, parallelized inside Meilisearch instead of at the Node layer.

### D. tRPC procedure

**File:** `packages/transport/trpc/src/routers/unified-search.ts`

Add `unifiedSearch.homeDiscovery` (`optionalProcedure`):
```ts
homeDiscovery: optionalProcedure
  .input(homeDiscoveryInputSchema)
  .query(({ ctx, input }) =>
    getHomeDiscovery({
      search: ctx.searchQuery,
      hotEvents: ctx.hotEvents,
      repos: ctx.repos,
      logger: ctx.logger,
    }, input),
  ),
```

### E. HomeLayout: 3 hooks → 1

**File:** `apps/web/src/app/_components/HomeLayout.tsx`

Replace `usePopularEvents` / `useFeaturedEvents` / `useTrendingEvents` with:
```ts
const { data } = trpc.unifiedSearch.homeDiscovery.useQuery({
  lat, lng, regionCode, countryCode, geohashPrefix
}, { staleTime: 60_000 });

const featured = data?.featured ?? [];
const popular = data?.popular;
const trending = data?.trending;
```

### F. Edge caching

**File:** `apps/web/src/app/page.tsx`

Today:
```ts
export const dynamic = "force-dynamic";
export const revalidate = 0;
```

Two cache-key strategies — pick one:

**F1. Single global cache (simplest, recommended for v1):**
- Drop personalized "near me" content from the *cached* version. Show globally trending + featured.
- Render the home page as a server component, fetch `homeDiscovery` server-side with no `lat`/`lng`, set:
  ```ts
  export const revalidate = 60;
  // emits: Cache-Control: public, s-maxage=60, stale-while-revalidate=...
  ```
- One CDN cache entry per route, ~30ms p95 for cached hits globally.
- "Show events near me" becomes a client-side toggle that re-fetches uncached.

**F2. Country-level paths (better hit rate, more work):**
- Redirect `/` to `/{countryCode}` based on Cloudflare's `CF-IPCountry` request header.
- Each country page is its own cache entry.
- Personalized to country granularity without per-user cache fragmentation.

We'll start with F1. F2 is a follow-up if analytics show country mix is uneven enough to matter.

---

## Implementation order

1. **Search port + Meili adapter `multiSearch` method** — pure infrastructure, no caller changes.
2. **`getHomeDiscovery` use case + unit test** — logic clean-room, parallel to existing use cases.
3. **`unifiedSearch.homeDiscovery` tRPC procedure.**
4. **HomeLayout swap** — 3 hooks → 1, behind a feature gate or via a quick branch toggle so we can ship+revert quickly if rendering looks off.
5. **Convert `page.tsx` to server component, add `revalidate = 60`.** Verify response headers in prod via `curl -I https://hearthfire.community/`.
6. **Don't delete the old endpoints yet** — `featuredEvents` / `tieredPopularEvents` / `trendingEvents` likely have other callers (mobile, embeds, search page). Audit and remove in a follow-up spec.

---

## Performance expectation

| Scenario | Before | After |
|---|---|---|
| Cold home page load | 5 RTTs to API + ~6 RTTs Node→Meili = ~600ms TTI | 1 RTT to API + 1 Node→Meili + 1 Node→Redis = ~150ms TTI |
| CDN cache hit | N/A (force-dynamic) | ~30ms TTI (edge response, never hits our infra) |

Expected real-world wins:
- ~80–200ms saved on uncached loads from Meili call collapse alone
- 80–95% of home page hits served by Cloudflare edge once caching enabled
- Origin load on home page drops to 1 request per minute per Cloudflare PoP per country

## Risks

- **Multi-search per-query failures.** Meili returns errors per-query, not whole-batch. Use case must render an empty section + log warning rather than throw.
- **Tier short-circuit lost.** Today, `tieredPopularEvents` runs tier 2 only if tier 1 returned `<minResults`. Multi-search runs all 4 tiers always. Worst case is a tiny bit of wasted Meili compute; net win is positive because tiers run in parallel server-side instead of serially over the network.
- **Cache freshness for new events.** A 60s edge cache means a freshly published event won't appear on the home page for up to a minute. Acceptable. If not, drop to 30s or wire purge-on-publish (more complex).
- **Personalization regression.** F1 strategy means the cached home page won't show "near me" by default. Mitigate with an obvious "Switch to nearby" button that bypasses cache.

## Acceptance criteria

- [ ] Visiting `/` triggers exactly 1 `unifiedSearch.homeDiscovery` tRPC call (verify in network tab; non-search calls like `featuredItems.list` still allowed).
- [ ] Server-side that single call results in 1 Meilisearch HTTP request and 1 Redis call (verify with structured logs / Datadog trace).
- [ ] `Cache-Control: public, s-maxage=60, ...` present on `/` response in prod.
- [ ] `cf-cache-status: HIT` after the second visit from the same PoP.
- [ ] Home page renders identical sections (featured / popular / trending) as before.
- [ ] Mobile + embeds + search page unaffected (their callers untouched).
