/**
 * Is this hero-image URL one we are willing to REDIRECT a crawler to?
 *
 * The OG route's healing arm 302s to `Image.publicUrl` straight out of the
 * database. Nothing exploitable stands behind that today — `publicUrl` is
 * server-composed from the storage adapter's configured public base, never
 * client-supplied — but "not exploitable because of what some other subsystem
 * happens to write" is not a property of THIS code, and an open redirect out of
 * a public, cacheable GET is worth closing by construction rather than by
 * argument.
 *
 * Deliberately NOT reusing `next.config.ts`'s `images.remotePatterns`: importing
 * the Next config into a route handler drags the whole build config into the
 * server bundle. The overlap is intentional and the comment in each place names
 * the other.
 *
 * WHEN IT REJECTS the route serves the static poster and REPORTS, because the
 * only realistic way to get here is a storage origin nobody added to the list —
 * a misconfiguration that should be visible rather than a silent downgrade of
 * every healed poster.
 */

/** Hosts that serve event artwork in every environment we run. */
const BUILTIN_HOSTS: readonly string[] = [
  // Seed / test-data hero images; also listed in next.config remotePatterns.
  "images.unsplash.com",
];

const hostOf = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * The allowlist, resolved per call so an env change does not need a redeploy of
 * this module's module-scope state.
 *
 * `OG_HERO_ALLOWED_HOSTS` is a comma-separated escape hatch for a storage origin
 * that is neither the site nor the configured CDN.
 */
const allowedHosts = (siteUrl: string): Set<string> => {
  const hosts = new Set<string>(BUILTIN_HOSTS);
  const add = (value: string | null | undefined) => {
    const host = hostOf(value);
    if (host) hosts.add(host);
  };

  // Our own origin: the static-poster degrade target lives here.
  add(siteUrl);
  add(process.env.NEXT_PUBLIC_CDN_HOSTNAME);
  for (const entry of (process.env.OG_HERO_ALLOWED_HOSTS ?? "").split(",")) {
    add(entry);
  }
  return hosts;
};

/**
 * True when `url` is an absolute http(s) URL on an allowed host and carries no
 * embedded credentials (`https://evil@host/…` renders one host and resolves
 * another).
 */
export const isAllowedHeroImageUrl = (
  url: string,
  siteUrl: string,
): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  return allowedHosts(siteUrl).has(parsed.hostname.toLowerCase());
};
