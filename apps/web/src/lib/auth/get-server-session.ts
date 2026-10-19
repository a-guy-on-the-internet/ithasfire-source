import "server-only";

import { headers as getRequestHeaders } from "next/headers";
import * as Sentry from "@sentry/nextjs";

import { getTrpcHttpUrl } from "@/config/trpc";
import { signedClientIpHeaders } from "@/server/client-ip-forward";

export type ServerSessionUser = {
  id: string;
} & Record<string, unknown>;

export type ServerSession = {
  user: ServerSessionUser;
  session: Record<string, unknown>;
};

const isServerSession = (value: unknown): value is ServerSession => {
  if (!value || typeof value !== "object") return false;
  const user = (value as { user?: unknown }).user;
  return (
    !!user &&
    typeof user === "object" &&
    typeof (user as { id?: unknown }).id === "string"
  );
};

/**
 * Server-only helper: forwards the incoming request's `cookie` header to
 * Better Auth's `/api/auth/get-session` REST endpoint (mounted on the API,
 * `apps/api/src/auth/better-auth.ts` — deliberately exempt from rate
 * limiting since it's polled on virtually every page load) to answer "does
 * ANY valid session exist for this request?".
 *
 * This is a coarse existence check only — it does NOT resolve org
 * membership role or any other authorization detail. Use it to gate
 * SSR-rendered pages (e.g. `/admin`, `/moderate`) against anonymous access
 * before any HTML ships; role/permission checks still happen downstream
 * (client-side AdminShell, or `checkModeratorAccessServer` for
 * `/moderate`).
 *
 * Fails CLOSED for the caller: any network error, non-2xx response, or
 * malformed body resolves to `null` ("no session") rather than throwing —
 * a down API must not crash these pages, and it must not grant access
 * either. Callers should `redirect()` to sign-in on `null`.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  try {
    const reqHeaders = await getRequestHeaders();
    const cookie = reqHeaders.get("cookie");
    if (!cookie) return null;

    const apiBaseUrl = getTrpcHttpUrl().replace(/\/trpc$/, "");
    const res = await fetch(`${apiBaseUrl}/api/auth/get-session`, {
      method: "GET",
      // Signed visitor IP: this call leaves from the web server, so without
      // it Better Auth keys every visitor on our address (see
      // server/client-ip-forward.ts).
      headers: { cookie, ...signedClientIpHeaders(reqHeaders) },
      cache: "no-store",
    });

    if (!res.ok) return null;

    const json: unknown = await res.json();
    return isServerSession(json) ? json : null;
  } catch (err) {
    // headers() throws outside a request context; fetch throws on network
    // errors; res.json() throws on malformed bodies. All treated as "no
    // session" — see fail-closed note above. Reported so a down/misbehaving
    // auth endpoint doesn't silently mask itself as "everyone signed out"
    // (see the Jun 2026 silent-search-outage postmortem in CLAUDE.md).
    Sentry.captureException(err, {
      // `ssr-auth-gate`, not `admin-auth-gate`: this is the Server Component
      // layer. The edge middleware gate reports under `staff-route-gate`
      // (`middleware/staff-route-gate.ts`). Keeping the two tags distinct is
      // what lets an alert tell "the edge gate is failing" from "SSR is".
      tags: { area: "ssr-auth-gate", check: "get-server-session" },
    });
    return null;
  }
}
