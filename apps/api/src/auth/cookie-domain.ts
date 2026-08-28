// ── Cross-subdomain cookie domain resolution ────────────────────────────────
//
// The Better Auth session cookie is host-only by default (no `Domain=`
// attribute), so it is bound to the API host (prod: `api.ithasfire.com`) and
// invisible to the web origin (`ithasfire.com`). That breaks every server-side
// session check on the web app. To fix it we scope the cookie to the shared
// parent domain of the web + api hosts (prod: `.ithasfire.com`), which is
// same-site for both origins so `SameSite=Lax` still sends it.
//
// The domain is NOT derived from URLs — an earlier attempt computed the longest
// common dotted suffix of the web/api hosts, which yielded the SAME
// `.ithasfire.com` for both prod (`ithasfire.com` / `api.ithasfire.com`) AND
// dev (`web-dev.ithasfire.com` / `api-dev.ithasfire.com`). Because dev and prod
// both live under the single registrable domain `ithasfire.com`, a shared
// `Domain=.ithasfire.com` cookie collides across environments: the two envs
// clobber each other's session cookie AND a prod-issued token is transmitted to
// dev services (and vice versa). No `.dev.ithasfire.com`-style isolation label
// is actually deployed, so the suffix heuristic can't distinguish them.
//
// Instead the domain is an EXPLICIT, per-environment env var
// (`SESSION_COOKIE_DOMAIN`), set ONLY where a shared parent is both safe and
// unique to that environment (prod). `resolveCookieDomain` is a pure validator:
// it never invents a domain, only accepts/rejects the operator-supplied one.

function parseHostname(url: string | undefined | null): string | null {
  if (!url || typeof url !== "string" || url.trim().length === 0) return null;
  try {
    const host = new URL(url).hostname.trim().toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

// Pragmatic denylist of public / multi-label suffixes a cookie must never be
// scoped to. This is intentionally NOT a full Public Suffix List — it's a small
// belt-and-suspenders guard against the most likely misconfigurations for THIS
// deployment (Cloud Run, Cloudflare/GitHub Pages, Firebase/GCP hosting). The
// real safety net is that `SESSION_COOKIE_DOMAIN` is operator-set per env, not
// user-derived. Entries are matched against the domain's labels-after-the-dot.
const DENYLISTED_SUFFIXES = [
  "run.app",
  "a.run.app",
  "pages.dev",
  "github.io",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
];

// Two-label ccTLD shapes (e.g. `co.uk`, `com.au`, `com.br`). We reject any
// domain whose registrable part collapses to `co.<tld>` or `com.<tld>` with
// nothing more specific in front — scoping a cookie there is as broad as
// scoping to a public suffix. Pragmatic, not exhaustive.
const CC_SLD_PREFIXES = ["co", "com"];

/**
 * Validate an operator-supplied cookie `Domain=` value.
 *
 * Pure function — it never derives or invents a domain. It only accepts the
 * explicit `explicit` value when it is a safe, registrable, leading-dot domain
 * that the API host can actually set a cookie on.
 *
 * @param explicit the `SESSION_COOKIE_DOMAIN` env value (or undefined)
 * @param apiUrl   the API base URL, used to sanity-bind the domain to the host
 *   that will set the cookie (prod: `https://api.ithasfire.com`)
 * @returns the normalized leading-dot domain (e.g. `.ithasfire.com`), or `null`
 *   when unset/invalid — in which case the caller MUST omit
 *   `crossSubDomainCookies` so the cookie stays host-only.
 */
export function resolveCookieDomain(
  explicit: string | undefined,
  apiUrl: string | undefined,
): string | null {
  if (!explicit || typeof explicit !== "string") return null;
  const domain = explicit.trim().toLowerCase();
  if (domain.length === 0) return null;

  // Must be a leading-dot domain (`.ithasfire.com`), never a bare host.
  if (!domain.startsWith(".")) return null;

  const labels = domain.slice(1).split(".");
  // Reject empty labels (e.g. `.ithasfire..com`, `..com`, trailing dot).
  if (labels.some((label) => label.length === 0)) return null;
  // Need at least 2 labels after the leading dot — reject bare TLDs like `.com`.
  if (labels.length < 2) return null;

  const suffix = labels.join(".");

  // Reject known public / multi-label hosting suffixes.
  if (DENYLISTED_SUFFIXES.includes(suffix)) return null;

  // Reject two-label ccTLD shapes (`.co.uk`, `.com.au`, …) with nothing more
  // specific in front of them.
  if (labels.length === 2 && CC_SLD_PREFIXES.includes(labels[0]!)) return null;

  // Sanity-bind to the API host: the host that sets the cookie must live under
  // the domain, otherwise the browser rejects the `Domain=` attribute outright.
  const apiHost = parseHostname(apiUrl);
  if (!apiHost) return null;
  // `endsWith(domain)` where domain has the leading dot means apiHost is a
  // strict sub-host (e.g. `api.ithasfire.com`.endsWith(`.ithasfire.com`)). Also
  // allow the apex itself (`ithasfire.com` === `ithasfire.com`).
  if (apiHost !== suffix && !apiHost.endsWith(domain)) return null;

  return domain;
}
