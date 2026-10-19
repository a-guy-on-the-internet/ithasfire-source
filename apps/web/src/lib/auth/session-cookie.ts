/**
 * Better Auth's session cookie base name is `<cookiePrefix>.session_token`,
 * where `cookiePrefix` defaults to `better-auth`. We match the whole
 * `better-auth`-family so BOTH environments are recognized on the shared
 * `.ithasfire.com` domain:
 *  - prod: `better-auth.session_token` (default prefix)
 *  - dev:  `better-auth-dev.session_token` (SESSION_COOKIE_PREFIX="better-auth-dev",
 *          set so dev's cross-subdomain cookie never collides with prod's — see
 *          apps/api/src/auth/better-auth.ts + infra dev.tfvars).
 * Prod (`better-auth.session_token`) matches exactly as it always has.
 */
const SESSION_COOKIE_NAME_PREFIXES = ["__Secure-", "__Host-"] as const;

const stripCookieNamePrefix = (name: string): string => {
  for (const prefix of SESSION_COOKIE_NAME_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
};

/**
 * Whether a single cookie NAME is a Better Auth session token cookie. Tolerant
 * of the environment-specific `cookiePrefix` (`better-auth` / `better-auth-dev`)
 * and the browser's `__Secure-`/`__Host-` name prefix, but still anchored: it
 * must start with `better-auth` AND end with `.session_token`, so sibling
 * Better Auth cookies (e.g. `better-auth.dont_remember`) do NOT match.
 *
 * The `better-auth` stem is guaranteed, not assumed: `SESSION_COOKIE_PREFIX`
 * (apps/api/src/lib/env.ts) is schema-pinned to `.startsWith("better-auth")`
 * precisely because this matcher — and the staff-route gate's pre-filter built
 * on it — would otherwise silently bounce every signed-in user to `/sign-in`.
 *
 * The DASH shape (`better-auth-session_token`) that `private-route-gate.ts`
 * additionally accepts is deliberately NOT matched here, and that asymmetry is
 * correct — do not "fix" it by loosening this. Better Auth only ever WRITES
 * `${prefix}.${name}` (`createCookieGetter`); the dash form exists solely in
 * its READER helper `getSessionCookie`, so no deployment of ours can produce
 * it. `private-route-gate.ts` accepts it because that gate is explicitly not
 * an authorization boundary and errs permissive; this helper gates a real
 * round-trip decision and stays anchored to what the server actually sets.
 */
const isSessionCookieName = (name: string): boolean => {
  const base = stripCookieNamePrefix(name.trim());
  return base.startsWith("better-auth") && base.endsWith(".session_token");
};

/**
 * True when a forwarded `cookie` header carries a Better Auth session cookie.
 *
 * `if (cookie)` is NOT a signed-in check: anonymous visitors still send cookies
 * (theme preference, consent, `th_eu_*` event unlocks), so any server path that
 * pays an internal round trip only signed-in viewers can benefit from — the
 * `GET /api/auth/token` mint in `server/trpc-client.ts`, the account
 * theme-preference query in `get-server-theme-mode.ts` — must gate on this
 * instead. Both run on effectively every request, and for the many anonymous
 * public-ticketing viewers those calls can only ever come back 401.
 *
 * Presence-only, and deliberately so: a stale or forged cookie still fails
 * verification at the API. This is a cheap negative filter, never an
 * authorization decision. Parses cookie NAMES (rather than a raw substring
 * scan) so it can be prefix-tolerant without matching the token inside an
 * unrelated cookie's value.
 */
export function hasSessionCookie(cookie: string | null | undefined): boolean {
  if (!cookie) return false;
  return cookie.split(";").some((pair) => {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    return isSessionCookieName(name);
  });
}
