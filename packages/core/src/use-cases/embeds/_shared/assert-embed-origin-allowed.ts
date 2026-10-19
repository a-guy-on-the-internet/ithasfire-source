import type { LoggerPort } from "@th/ports/logger";
import { fail } from "@th/errors";

import { coerceEmbedDomainToHostname } from "./embed-domain";

/**
 * Enforce the embed's per-domain allowlist on the LIVE widget path.
 *
 * Every public embed procedure (reads AND guest checkout) receives a
 * client-computed `hostOrigin` — the origin of the page hosting the iframe
 * (`window.location.ancestorOrigins[0]`, falling back to `document.referrer`,
 * or the widget's own origin when it is the top-level document). The embed
 * record stores exactly one allowlisted hostname (`Embed.domain`, lowercased).
 *
 * Rules (fail closed — there is no lenient tier):
 * - `hostOrigin` must parse as a URL; its hostname must equal `embed.domain`
 *   exactly, case-insensitively, treating `www.X` and `X` as equivalent on
 *   both sides.
 * - The platform's own web origin (derived from `publicAppUrl`) is ALWAYS
 *   allowed so admin preview and direct top-level viewing keep working.
 * - A null / missing / unparseable `hostOrigin` is REJECTED.
 *
 * Rejections throw `EMBED_ORIGIN_NOT_ALLOWED` (mapped to FORBIDDEN at the
 * tRPC boundary) and log a structured warn including the embed id and the
 * received origin so legitimate-customer mismatches are diagnosable
 * post-deploy.
 *
 * Note: `hostOrigin` is computed by OUR script running inside the iframe, so
 * a hosting page cannot spoof it in a browser. A non-browser caller can lie,
 * but the allowlist's job is to stop unauthorized *website embedding* — API
 * scripting is bounded by the same rate limits / Turnstile as the rest of the
 * public surface.
 */

export type AssertEmbedOriginAllowedArgs = {
  embed: { id: string; domain: string };
  /** Origin of the embedding page, as computed by the widget client. */
  hostOrigin: string | null | undefined;
  /**
   * Base URL of our own web app (threaded from transport deps — core never
   * reads process.env). When absent, the own-origin allowance simply does not
   * apply (still fail closed).
   */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
};

/** Lowercase and strip a single leading `www.` label. */
function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** Hostname of an origin/URL string, or null when unparseable/empty. */
function parseHostname(value: string): string | null {
  try {
    const hostname = new URL(value).hostname;
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

export function assertEmbedOriginAllowed(
  args: AssertEmbedOriginAllowedArgs,
): void {
  const { embed, hostOrigin, publicAppUrl, logger } = args;

  const reject = (reason: string): never => {
    logger?.warn("embed.originRejected", {
      embedId: embed.id,
      embedDomain: embed.domain,
      hostOrigin: hostOrigin ?? null,
      reason,
    });
    throw fail("EMBED_ORIGIN_NOT_ALLOWED", {
      meta: { embedId: embed.id },
    });
  };

  if (!hostOrigin) {
    reject("missing_host_origin");
    return;
  }

  const hostname = parseHostname(hostOrigin);
  if (!hostname) {
    reject("unparseable_host_origin");
    return;
  }

  const normalized = normalizeHostname(hostname);

  // Lenient on the STORED side: legacy rows may carry scheme/path junk
  // ("https://example.com", "example.com/") from before upsertEmbed
  // normalized input — coerce to the intended hostname so enforcement
  // doesn't brick them. A stored value that can't yield a hostname can
  // never match anything.
  const storedHostname = coerceEmbedDomainToHostname(embed.domain);
  if (!storedHostname) {
    reject("stored_domain_unparseable");
    return;
  }

  // Allowlisted embed domain (www-equivalent, case-insensitive, exact match).
  if (normalized === normalizeHostname(storedHostname)) return;

  // Our own web origin — admin preview and direct top-level viewing.
  const ownHostname = publicAppUrl ? parseHostname(publicAppUrl) : null;
  if (ownHostname && normalized === normalizeHostname(ownHostname)) return;

  reject("host_origin_mismatch");
}
