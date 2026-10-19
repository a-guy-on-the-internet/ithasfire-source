import "server-only";

import { headers as getRequestHeaders } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { TRPCClientError } from "@trpc/client";

import { hasSessionCookie } from "@/lib/auth/session-cookie";
import type { ThemeMode } from "@/lib/theme-mode";
import { getServerTrpcClient } from "@/server/trpc-client";

/**
 * Signed-out viewers make `humans.getMyThemePreference` throw UNAUTHORIZED —
 * that's the common, expected case, so we must NOT report it (it would flood
 * Sentry on every anonymous page load). Everything else is unexpected.
 */
const isExpectedUnauthorized = (err: unknown): boolean =>
  err instanceof TRPCClientError &&
  (err.data as { code?: unknown } | undefined)?.code === "UNAUTHORIZED";

/**
 * Server-only helper: reads the signed-in user's account-synced web light/dark
 * preference (via `humans.getMyThemePreference`, which resolves the viewer from
 * the forwarded session cookie) so SSR can resolve the initial theme as
 * account → cookie → DEFAULT_THEME_MODE.
 *
 * Returns `'light' | 'dark'` when the user is signed in AND has set an explicit
 * account preference; otherwise `null` (signed out, no preference set, or any
 * error). Fails SOFT: a down API or missing session resolves to `null` so the
 * layout simply falls back to the cookie/default — the preference read must
 * never crash the page.
 */
export async function getServerThemeMode(): Promise<ThemeMode | null> {
  try {
    const reqHeaders = await getRequestHeaders();
    const cookie = reqHeaders.get("cookie");
    if (!hasSessionCookie(cookie)) {
      // No session cookie → signed out. The root layout runs on EVERY request,
      // so skip both internal round trips rather than pay them for anonymous
      // viewers who can never have an account preference.
      return null;
    }
    const client = getServerTrpcClient();
    const { mode } = await client.humans.getMyThemePreference.query();
    return mode;
  } catch (err) {
    // Any failure resolves to "no account preference" — the layout falls back
    // to the cookie/default, so the preference read never crashes the page.
    // Signed-out UNAUTHORIZED is expected and stays out of Sentry; genuine
    // network/backend failures are reported so a persistently-failing read
    // doesn't silently pin every signed-in user to their cookie.
    if (!isExpectedUnauthorized(err)) {
      Sentry.captureException(err, {
        tags: { area: "theme", check: "get-server-theme-mode" },
      });
    }
    return null;
  }
}
