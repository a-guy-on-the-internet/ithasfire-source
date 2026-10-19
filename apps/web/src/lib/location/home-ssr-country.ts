/**
 * The country the home page is SERVER-rendered for, always — deliberately not
 * the viewer's.
 *
 * The rendered HTML is cached at the Cloudflare edge, and the cache key does
 * NOT include the country. (`cloudflare-cache` sets no custom cache key, and
 * custom cache keys in Cache Rules are Enterprise-only, so it cannot.) Varying
 * the HTML on `CF-IPCountry` therefore did not personalize anything — it just
 * meant whichever viewer warmed a given Cloudflare colo decided what everyone
 * else hitting that colo saw until the entry expired.
 *
 * Rendering one fixed country makes the cached HTML correct for every viewer by
 * construction, and collapses N per-country entries per colo into one, which
 * raises the hit rate. Crawlers still index a page full of real events, so this
 * costs nothing in SEO.
 *
 * Viewers are personalized CLIENT-side, but only AFTER mount: `HomeLayout`
 * queries with this exact value on the first client render so the react-query
 * key matches what `prefetchHomeDiscovery` seeded, then swaps in the country
 * derived from `navigator.language` (`inferCountryCodeFromNavigator`) in a
 * mount effect and the hooks in `useHomeEventSections.ts` refetch. Deriving it
 * during the first render forked the query key and failed hydration for every
 * non-US locale — see the comment at the `usePopularEvents` call site.
 *
 * Lives here, not in `@/server/home-discovery`, because that module is
 * `server-only` and `HomeLayout` is a client component: both sides of the
 * SSR/hydration contract have to read the SAME literal, so it cannot live
 * behind a server boundary. `@/server/home-discovery` re-exports it.
 */
export const HOME_SSR_COUNTRY = "US";
