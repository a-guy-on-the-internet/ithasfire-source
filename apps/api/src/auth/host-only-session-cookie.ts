// ── Shadow (host-only) session-cookie clearing ──────────────────────────────
//
// `SESSION_COOKIE_DOMAIN` (see `cookie-domain.ts`) broadens the Better Auth
// session cookie to `Domain=.ithasfire.com` so the web origin can see it. Every
// session minted BEFORE that config shipped is still carried by a **host-only**
// cookie (no `Domain=` attribute), bound to the API host.
//
// Per RFC 6265 §5.3 a cookie is keyed on (name, domain, path), and the
// host-only flag is part of the domain key: `__Secure-better-auth.session_token`
// with `Domain=.ithasfire.com` and the same name WITHOUT a `Domain=` are two
// DISTINCT entries in the jar. Better Auth's `deleteSessionCookie` re-serializes
// the cookie from its CURRENT config, so on prod it only expires the
// domain-scoped entry — the host-only shadow survives sign-out untouched.
//
// That shadow is what wedges users: the browser still sends it to
// `api.ithasfire.com` (so `/get-session` succeeds client-side) but never to the
// apex `ithasfire.com` (so every server-side gate fails closed). Signing out
// must therefore ALSO emit an expired copy with no `Domain=` attribute, which
// is the only way to address the host-only entry.
//
// Deliberately scoped to the cross-subdomain (prod) case only: when
// `SESSION_COOKIE_DOMAIN` is unset the cookie is ALREADY host-only, Better Auth
// clears exactly the right entry, and a duplicate `Set-Cookie` would be noise.

/**
 * Attributes for the extra expired cookie. `maxAge: 0` is the expiry; the rest
 * mirror what Better Auth sets so the header is well-formed and, critically,
 * so a `__Secure-`-prefixed name is accepted by the browser at all (that prefix
 * REQUIRES `Secure`). Note there is deliberately NO `domain` key — its absence
 * is the entire point.
 *
 * Cookie *matching* for replacement is (name, domain, path) only, so
 * `sameSite` / `httpOnly` don't affect which entry gets overwritten; they're
 * set for parity and to avoid tripping cookie-policy lint.
 */
type HostOnlyClearCookieAttributes = {
  maxAge: 0;
  path: "/";
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  /**
   * `never` on purpose: adding a `Domain=` here would silently re-target the
   * SAME entry Better Auth already expires and re-open the bug. The compiler
   * now rejects it outright, which is a stronger guarantee than any runtime
   * assertion (the actual serialization is better-call's `serializeCookie`,
   * which only emits `Domain=` when `domain` is truthy).
   */
  domain?: never;
};

export const HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES: HostOnlyClearCookieAttributes =
  {
    maxAge: 0,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  };

/**
 * Does the outgoing response already write a `Set-Cookie` for `name`?
 *
 * This is the predicate that decides when to emit the host-only shadow clear.
 * Gating on *"this response touches the session-token cookie"* rather than on a
 * hand-maintained list of paths means every flow that establishes OR clears a
 * session is covered by one condition — sign-out, password sign-in, passkey
 * verify, OAuth callback, magic-link verify, 2FA verify — with nothing to keep
 * in sync as endpoints are added. That matters because `/sign-in` is
 * passkey-first in this product, so a path allowlist built around
 * `/sign-out` + `/sign-in/email` misses most real users.
 *
 * `getSetCookie()` is the only correct way to read this: `Set-Cookie` is the
 * one header that legitimately repeats, `Headers.get()` joins repeats with
 * ", ", and cookie values (`Expires=Wed, 21 Oct 2026 …`) contain commas — so
 * splitting the joined form is ambiguous. Node ≥ 20 (this runtime) always has
 * `getSetCookie`; the `get()` fallback exists only so an exotic Headers
 * polyfill degrades to "probably yes" instead of throwing.
 */
export function responseSetsCookieNamed(
  responseHeaders: Headers | null | undefined,
  name: string,
): boolean {
  if (!responseHeaders || !name) return false;

  if (typeof responseHeaders.getSetCookie === "function") {
    return responseHeaders
      .getSetCookie()
      .some((cookie) => cookie.slice(0, cookie.indexOf("=")).trim() === name);
  }

  const joined = responseHeaders.get("set-cookie");
  if (!joined) return false;
  // Tolerant fallback: a cookie name may only start the header or follow a
  // comma-separated join, so anchor on those positions.
  return new RegExp(
    `(?:^|,\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`,
  ).test(joined);
}

export type HostOnlyClearCookieInput = {
  /**
   * The validated `SESSION_COOKIE_DOMAIN` (`resolveCookieDomain` output).
   * `null` on dev/localhost, where the cookie is already host-only.
   */
  crossSubDomainCookieDomain: string | null;
  /** `ctx.context.authCookies.sessionToken.name` — varies with env prefix. */
  sessionTokenName: string;
  /** `ctx.context.authCookies.sessionData.name` (the cookie-cache cookie). */
  sessionDataName: string;
  /** Whether `session.cookieCache` is enabled — it is not, today. */
  cookieCacheEnabled: boolean;
};

/**
 * Which cookie names need an extra host-only expiry emitted on sign-out.
 *
 * Returns `[]` whenever the deployment isn't using a cross-subdomain cookie —
 * there is no shadow entry to kill in that case.
 *
 * `session_data` is only included when the cookie cache is enabled: with it
 * off (the current config) Better Auth's `setCookieCache` early-returns and the
 * cookie is never written, so no host-only shadow of it can exist. Including it
 * conditionally keeps this correct if the cache is ever turned on, without
 * emitting a pointless header on every sign-out today. `dont_remember` is
 * omitted for the same reason plus one more: it is inert without a session
 * token, so a surviving shadow of it can't wedge anyone.
 */
export function hostOnlySessionCookiesToClear(
  input: HostOnlyClearCookieInput,
): string[] {
  if (!input.crossSubDomainCookieDomain) return [];
  const names = [input.sessionTokenName];
  if (input.cookieCacheEnabled) names.push(input.sessionDataName);
  return names.filter((name) => typeof name === "string" && name.length > 0);
}

export type HostOnlyClearHookInput = HostOnlyClearCookieInput & {
  /** `ctx.path`, e.g. `/sign-out`. Optional so direct `auth.api` calls work. */
  path?: string;
  /**
   * `ctx.context.responseHeaders` — the headers the endpoint handler produced,
   * before this hook's own headers are merged in.
   */
  responseHeaders: Headers | null | undefined;
};

/**
 * Names to emit a host-only expiry for, given a specific outgoing response.
 *
 * Fires whenever the response is ALREADY writing the session-token cookie —
 * i.e. any flow that establishes or clears a session — plus `/sign-out`
 * unconditionally.
 *
 * Why sign-out is also matched by path: it is the one endpoint whose entire
 * job is "leave this browser with no session", so it must clear the shadow
 * even in the edge case where Better Auth returns without writing a cookie
 * (e.g. no session was found for the presented token). Everywhere else the
 * response-shape predicate is strictly better than a path list — see
 * `responseSetsCookieNamed`.
 *
 * Emitting on session-ESTABLISHING responses is safe and is the whole point of
 * the broadening: RFC 6265 keys the jar on (name, domain, path) with the
 * host-only flag part of the domain key, so the `Max-Age=0` host-only entry
 * and the freshly minted `Domain=.ithasfire.com` entry are different rows. The
 * clear cannot clobber the new session cookie. Verified against a real
 * `betterAuth()` instance in `test/host-only-session-cookie-wire.test.ts`.
 *
 * Without this, a shared browser holding user A's pre-deploy ghost cookie
 * resolves API requests as A after user B signs in with a passkey — the apex
 * (and therefore middleware) sees B, `api.ithasfire.com` sees A, because
 * better-call's `parseCookies` keeps the FIRST occurrence and RFC 6265 orders
 * equal-path cookies oldest-first.
 */
export function hostOnlySessionCookiesToClearForResponse(
  input: HostOnlyClearHookInput,
): string[] {
  // Domain check first: this now runs on EVERY auth endpoint, and on dev
  // (`crossSubDomainCookieDomain === null`) the answer is always `[]`, so
  // there is no reason to scan response headers to get there.
  if (!input.crossSubDomainCookieDomain) return [];

  const touchesSessionCookie =
    input.path === "/sign-out" ||
    responseSetsCookieNamed(input.responseHeaders, input.sessionTokenName);
  if (!touchesSessionCookie) return [];

  return hostOnlySessionCookiesToClear(input);
}
