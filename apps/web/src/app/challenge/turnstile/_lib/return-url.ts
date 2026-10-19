/**
 * The `return` parameter of `/challenge/turnstile` — the native app's deep
 * link that receives the Turnstile token.
 *
 * This is the page's open-redirect guard. Whatever passes here is navigated to
 * with a fresh Turnstile token appended, so a loose check would let anyone mint
 * a link that ships our users' tokens (and our domain's credibility) to a page
 * of their choosing. The rule is therefore an allowlist of app schemes, never a
 * blocklist of bad ones:
 *
 *   - `ithasfire://` — the app's own scheme, always. Release AND dev-client
 *     builds send this (`Linking.createURL` resolves to it in both);
 *   - `exp://` — Expo Go — and `exp+ithasfire://`, only outside production
 *     builds. The second is in the fixed contract but nothing sends it today:
 *     the app's slug is `mobile`, so a dev client registers `exp+mobile://`,
 *     which stays refused.
 *
 * Note "production" means the BUILD, not the deployment: the hosted dev
 * environment runs a production build too, so it accepts `ithasfire://` only.
 *
 * Everything else is refused: web schemes, `javascript:`, protocol-relative
 * values, a different letter case, any whitespace or control character
 * (including the ones `URL` would silently strip), non-ASCII, anything
 * longer than {@link MAX_RETURN_LENGTH}, a link whose query already
 * carries `turnstileToken` / `turnstileError`, and a link whose query has a
 * malformed percent-escape.
 */

export const MAX_RETURN_LENGTH = 512;

const APP_PREFIX = "ithasfire://";
const DEV_PREFIXES = ["exp://", "exp+ithasfire://"] as const;

/**
 * Printable ASCII without the space, and without `\` (which `URL` treats as
 * `/` for special schemes and is never part of a deep link we mint).
 * Excludes every control character, so tab/newline tricks that `URL` would
 * strip before parsing never reach it.
 */
const SAFE_CHARS = /^[\x21-\x5b\x5d-\x7e]+$/;

export type ReturnUrlOptions = {
  /** Defaults to `process.env.NODE_ENV === "production"`. */
  production?: boolean;
};

const allowedPrefixes = (production: boolean): readonly string[] =>
  production ? [APP_PREFIX] : [APP_PREFIX, ...DEV_PREFIXES];

/**
 * The validated deep link, or `null` when `raw` must not be redirected to.
 * `raw` is the searchParams value as Next hands it over (already
 * percent-decoded once); an array means the parameter was repeated, which is
 * refused rather than guessed at.
 */
export const parseChallengeReturn = (
  raw: string | string[] | undefined,
  { production = process.env.NODE_ENV === "production" }: ReturnUrlOptions = {},
): string | null => {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_LENGTH) return null;
  if (!SAFE_CHARS.test(raw)) return null;
  // A fragment would swallow the query we append, so the token would ride in
  // the fragment instead of the query string. Deep links we mint never carry
  // one.
  if (raw.includes("#")) return null;

  const prefix = allowedPrefixes(production).find((p) => raw.startsWith(p));
  if (!prefix) return null;
  // Nothing but the scheme is not a destination.
  if (raw.length === prefix.length) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // Belt and braces: the parser must agree on the scheme the prefix implied.
  if (parsed.protocol !== prefix.slice(0, -"//".length)) return null;

  // A link that already carries a result would hand the app a token (or an
  // error) this page never minted. URLSearchParams decodes keys, so the
  // `%74urnstileToken` spelling is caught too.
  const query = new URLSearchParams(parsed.search);
  if (query.has("turnstileToken") || query.has("turnstileError")) return null;

  // URLSearchParams leaves a bad escape in place, but the app's parser refuses
  // the whole link, so the token we would mint for it is wasted.
  if (!queryDecodes(raw)) return null;

  return raw;
};

/**
 * Whether every `&`-separated pair in the query of `raw` (first `?` onward;
 * `raw` has no fragment) decodes with `decodeURIComponent`, key and value
 * separately. It mirrors `parseQuery` in the mobile app
 * (apps/mobile/src/features/events/event-password-challenge.ts), which reads
 * a redirect with any undecodable component (`%ZZ`, a lone `%`, a truncated
 * UTF-8 sequence) as malformed and drops the token.
 */
const queryDecodes = (raw: string): boolean => {
  const queryStart = raw.indexOf("?");
  if (queryStart === -1) return true;
  for (const pair of raw.slice(queryStart + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    try {
      decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
      if (eq !== -1) decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return false;
    }
  }
  return true;
};

/**
 * `returnUrl` with `key=value` appended as a query parameter, using `&` when
 * it already has a query. Only call with a value from
 * {@link parseChallengeReturn} (no fragment, so the append lands in the query).
 */
export const appendReturnParam = (
  returnUrl: string,
  key: string,
  value: string,
): string =>
  `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
