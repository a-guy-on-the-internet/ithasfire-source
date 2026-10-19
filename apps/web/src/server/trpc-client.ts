import "server-only";

import { cache } from "react";
import { headers as getRequestHeaders } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "@th/trpc";

import { getServerTrpcHttpUrl } from "@/config/trpc";
import { hasSessionCookie } from "@/lib/auth/session-cookie";
import {
  signedClientIpHeaders,
  type IncomingHeaderReader,
} from "@/server/client-ip-forward";
import { originSecretHeaders } from "@/server/origin-secret";

/**
 * Mint a Bearer token from the forwarded session cookie so SSR tRPC calls
 * can identify the viewer (e.g. for gate-state checks).
 *
 * Deliberately NOT memoized — callers outside a React request scope (route
 * handlers) get the raw helper. The SSR tRPC client uses the `cache()`d
 * `mintTokenForRequest` wrapper below instead.
 *
 * `incoming`: the visitor's request headers, so the call carries the signed
 * visitor IP (x-th-client-ip*). `/api/auth/token` is rate-limited per IP by
 * Better Auth, and this call leaves from the web server, so without the
 * forward every signed-in visitor shares one bucket. Omitted → no forward
 * (the call keys on the web server, as before).
 */
export async function mintTokenFromCookie(
  cookie: string,
  incoming?: IncomingHeaderReader | null,
): Promise<string | null> {
  try {
    // Better Auth's JWT plugin exposes GET /api/auth/token which reads the
    // session cookie and returns a short-lived JWT.
    const apiUrl = getServerTrpcHttpUrl().replace(/\/trpc$/, "");
    const url = `${apiUrl}/api/auth/token`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        cookie,
        ...originSecretHeaders(),
        ...(incoming ? signedClientIpHeaders(incoming) : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      token?: unknown;
      data?: { token?: unknown };
    };
    const token = json.token ?? json.data?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch (err) {
    // Transport failure only — an absent/expired session comes back as a
    // non-ok response above, not as a throw. Swallowing degrades SSR to an
    // anonymous request, so without a report a persistently-failing mint would
    // silently sign every viewer out with no signal. Mirrors the reporting in
    // `middleware/staff-route-gate.ts`'s `mintToken`.
    Sentry.captureException(err, {
      tags: { area: "ssr-auth", check: "mint-token" },
    });
    return null;
  }
}

/**
 * Per-request memo of the token mint.
 *
 * `httpBatchLink` invokes `headers()` once per HTTP batch and a single page
 * render issues several batches, so an unmemoized mint cost one
 * `GET /api/auth/token` round trip per batch. `getServerTrpcClient` below is
 * already `cache()`d, but that memoizes client *construction*, not this fetch.
 *
 * Kept as a separate wrapper rather than caching `mintTokenFromCookie` itself:
 * `cache()` only memoizes inside a React request scope, and the exported helper
 * is also called from a route handler
 * (`app/api/events/[eventId]/sync-unlock/route.ts`), which should keep the
 * plain, uncached behaviour.
 *
 * Keyed on the cookie ALONE: the request headers are read inside rather than
 * passed in, because `cache()` compares arguments by identity and a headers
 * object that is not the same instance on every batch would defeat the memo.
 */
const mintTokenForRequest = cache(async (cookie: string) => {
  let incoming: IncomingHeaderReader | null = null;
  try {
    incoming = await getRequestHeaders();
  } catch {
    // Outside a request scope: no visitor, so no forwarded IP.
  }
  return mintTokenFromCookie(cookie, incoming);
});

/**
 * The gate cookies the API may need from an anonymous viewer, and nothing
 * else: password unlocks (`th_eu_*`), application grants (`th_ea_*`) and
 * invite grants (`th_ei_*`). The API verifies all three; forwarding them only
 * ever reaches identity-scoped, uncacheable requests (the de-identified client
 * sends no cookies).
 */
export function filterEventUnlockCookies(cookie: string): string | null {
  const unlockCookies = cookie
    .split(";")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.startsWith("th_eu_") ||
        part.startsWith("th_ea_") ||
        part.startsWith("th_ei_"),
    );
  return unlockCookies.length > 0 ? unlockCookies.join("; ") : null;
}

/**
 * Builds the SSR tRPC client.
 *
 * `identity: false` produces a client that CANNOT see the viewer: no
 * `Authorization`, no forwarded cookies, only the origin-secret header. It is
 * the transport half of the edge-cache safety story — `/events/[...slug]` is
 * served `public, s-maxage=120, stale-while-revalidate=300` with a `Vary`
 * carrying no `Cookie`, so any answer the API gives that DEPENDS on who asked
 * gets stored at a colo and handed to everyone behind it. Stripping fields
 * after the fact cannot fix that for `getEventSeo`'s `location`: once the API
 * has resolved the exact street address for a ticket holder, the obscured form
 * is unrecoverable (the obfuscation inputs never cross the wire). So the
 * cacheable render asks anonymously and gets the redacted answer by
 * construction.
 */
const createClient = (identity: boolean) =>
  createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        // SSR data path talks to the API's internal Cloud Run origin
        // (WEB_API_BASE_URL) so requests stay inside Google's network instead
        // of hairpinning out through Cloudflare — see getServerTrpcHttpUrl.
        url: getServerTrpcHttpUrl(),
        transformer: superjson,
        async headers() {
          let reqHeaders: Awaited<ReturnType<typeof getRequestHeaders>> | null =
            null;
          try {
            reqHeaders = await getRequestHeaders();
          } catch {
            // headers() throws when called outside a request context; such
            // calls have no visitor, so they forward no IP and no identity.
          }
          // Origin-secret header — the API's origin-guard expects this on
          // every request; Cloudflare normally injects it, but these internal
          // calls bypass the edge, so we set it ourselves. Always present
          // (independent of the viewer's session).
          //
          // Plus the signed visitor IP (x-th-client-ip*). This client calls
          // the API's internal origin, so without it every SSR request
          // resolves to one address and shares one rate-limit bucket. Empty
          // without a signing secret or a valid cf-connecting-ip, and (once
          // ENFORCE_ORIGIN_SECRET is on) without the inbound origin secret —
          // see client-ip-forward.ts.
          const baseHeaders: Record<string, string> = {
            ...originSecretHeaders(),
            ...(reqHeaders ? signedClientIpHeaders(reqHeaders) : {}),
          };
          // The de-identified client stops here — see `createClient`'s note.
          // The forwarded IP is NOT viewer identity in that sense: the API
          // uses `ctx.clientIp` only for rate-limit keys, Turnstile remoteip
          // and abuse/audit fields. It can change a rate-limit OUTCOME (a
          // per-visitor 429) but never response content, so it cannot vary
          // what an edge cache stores for a successful read.
          if (!identity) return baseHeaders;
          // Forward auth context from the incoming request so the API
          // can resolve the viewer's session during SSR.
          try {
            const cookie = reqHeaders?.get("cookie");
            if (cookie) {
              const forwardedHeaders: Record<string, string> = {
                ...baseHeaders,
              };

              // Only a viewer with a session cookie can be minted a token.
              // Anonymous visitors still carry cookies (theme, consent, event
              // unlocks), so gating on `cookie` alone fired a
              // `GET /api/auth/token` per batch that could only ever 401.
              if (hasSessionCookie(cookie)) {
                const token = await mintTokenForRequest(cookie);
                if (token) {
                  forwardedHeaders.Authorization = `Bearer ${token}`;
                }
              }

              // Independent of auth on purpose: anonymous viewers rely on
              // `th_eu_*` unlock cookies to view password-gated events and
              // `th_ea_*` grants to view application-gated ones (and `th_ei_*`
              // invite grants for either), so this must NOT sit behind the
              // session check.
              const eventUnlockCookies = filterEventUnlockCookies(cookie);
              if (eventUnlockCookies) {
                forwardedHeaders.cookie = eventUnlockCookies;
              }

              return forwardedHeaders;
            }
          } catch {
            // Degrade to the identity-free headers rather than fail the render.
          }
          return baseHeaders;
        },
        fetch(url, options) {
          return fetch(url, {
            ...options,
            cache: "no-store",
          });
        },
      }),
    ],
  });

export const getServerTrpcClient = cache(() => createClient(true));

/**
 * SSR tRPC client that carries NO viewer identity — see {@link createClient}.
 *
 * Use it for every read that lands in an edge-cached document. Anything it
 * returns is a property of the RESOURCE, never of the caller, because the API
 * resolves it against an anonymous context.
 *
 * It is a distinct memo from {@link getServerTrpcClient} on purpose: sharing
 * one client and toggling headers per call would make the de-identification a
 * per-call-site convention instead of a property of the transport.
 *
 * Rendering-mode note: like the identity client, it calls `headers()` from
 * `next/headers` on every request (to sign the visitor's IP), and `headers()`
 * opts a route into DYNAMIC rendering. Today's callers (`/events/[...slug]`,
 * the OG image route) are dynamic anyway. A future static / ISR caller must
 * NOT use this client, or it silently turns dynamic.
 */
export const getPublicTrpcClient = cache(() => createClient(false));
