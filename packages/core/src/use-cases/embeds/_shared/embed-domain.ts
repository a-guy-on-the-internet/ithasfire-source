/**
 * Coerce free-form domain input to a bare lowercase hostname.
 *
 * Organisers paste all sorts of things into the "domain" field —
 * `https://Example.com/path`, `example.com/`, `www.example.com` — and the
 * Embed row stores whatever survived trim/lowercase. The origin allowlist
 * compares HOSTNAMES, so both the write path (`upsertEmbed`) and the read
 * path (`assertEmbedOriginAllowed`, for legacy rows stored before
 * normalization existed) funnel through this single coercion:
 *
 * - has a scheme → parse as URL, take `.hostname`
 * - no scheme → parse as `https://<raw>`, take `.hostname` (drops any
 *   path/port/trailing slash)
 * - unparseable / empty hostname → `null` (caller decides: typed error at
 *   upsert, fail-closed rejection at the guard)
 *
 * Lowercasing is handled by `URL` itself (hostnames are canonicalized).
 */
export function coerceEmbedDomainToHostname(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const hostname = new URL(candidate).hostname;
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}
