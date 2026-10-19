// NO `import "server-only"` here, on purpose: this module is also imported by
// `middleware/staff-route-gate.ts`, and middleware cannot import server-only
// modules in this app (see the `getApiBaseUrl` note there). Middleware runs on
// the Node runtime (`runtime = "nodejs"` in src/middleware.ts), so node:crypto
// is available. Every other caller imports `@/server/client-ip-forward`, the
// server-only entry point that re-exports this. Never import it from client
// code: it reads ORIGIN_SHARED_SECRET.
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { signClientIpForward } from "@th/trpc/client-ip";

/**
 * Signed visitor-IP headers for SERVER-SIDE calls into the API made on a
 * guest's behalf (route handlers, the SSR tRPC client).
 *
 * Without these the API sees the WEB SERVER's address on every such call —
 * Cloudflare's `cf-connecting-ip` is our egress IP when the call goes out
 * through the public API hostname, and on the internal *.run.app path (no
 * Cloudflare, so no `cf-connecting-ip`) the API resolves from
 * `x-forwarded-for`, whose leftmost entry is again our egress IP — so every
 * guest shared one rate-limit bucket.
 * The API verifies the HMAC (`verifyClientIpForward` in
 * packages/transport/trpc/src/client-ip.ts) and otherwise ignores the headers.
 *
 * What we sign is the inbound `cf-connecting-ip` (never `x-forwarded-for`),
 * and how strictly we check where it came from follows the origin-secret
 * rollout flag, ENFORCE_ORIGIN_SECRET — the same flag the API and web guards
 * read (Terraform sets it on both services together):
 *
 *  - ENFORCE_ORIGIN_SECRET="true": the inbound request must carry the
 *    Cloudflare-stamped `x-origin-secret`, or we sign nothing. In this mode
 *    `checkOriginSecret` in src/middleware.ts has already 403'd any request
 *    without it before it reaches a route, so this is belt and braces.
 *  - Otherwise (log-only rollout): we sign `cf-connecting-ip` as received.
 *    That header is caller-writable on a request that hit web's *.run.app
 *    origin directly — but the API already trusts `cf-connecting-ip` the same
 *    way on its own *.run.app origin (`resolveClientIp`), so vouching for it
 *    here grants nobody an IP they couldn't already claim. Our trust in the
 *    header equals the API's existing trust in it, and tightens when the flag
 *    flips.
 *
 * Returns `{}` — send nothing — when ORIGIN_SHARED_SECRET is unset (local dev;
 * the API couldn't verify anyway), when enforcement is on and the origin
 * secret is missing or wrong, or when `cf-connecting-ip` is not an IP. Never
 * throws.
 */

const ORIGIN_SECRET_HEADER = "x-origin-secret";
const VISITOR_IP_HEADER = "cf-connecting-ip";

/** The one method we need from `Headers` / `next/headers`' ReadonlyHeaders. */
export type IncomingHeaderReader = { get(name: string): string | null };

const secretsMatch = (provided: string, expected: string): boolean => {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
};

export function signedClientIpHeaders(
  incoming: IncomingHeaderReader,
  nowMs: number = Date.now(),
): Record<string, string> {
  try {
    // Trimmed because Cloudflare stamps the TRIMMED secret
    // (`origin_secret_trimmed` in the Terraform module).
    const secret = process.env.ORIGIN_SHARED_SECRET?.trim();
    if (!secret) return {};

    if (process.env.ENFORCE_ORIGIN_SECRET === "true") {
      const provided = incoming.get(ORIGIN_SECRET_HEADER);
      if (!provided || !secretsMatch(provided, secret)) return {};
    }

    const ip = incoming.get(VISITOR_IP_HEADER)?.trim();
    if (!ip || ip.length > 64 || isIP(ip) === 0) return {};

    return signClientIpForward({
      ip,
      secret,
      nowSeconds: Math.floor(nowMs / 1000),
    });
  } catch {
    return {};
  }
}
