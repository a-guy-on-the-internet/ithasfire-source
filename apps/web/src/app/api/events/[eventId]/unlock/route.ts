import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getTrpcHttpUrl } from "@/config/trpc";
import { webEnv } from "@/config/env.server";
import { buildEventUnlockSetCookie } from "@/lib/event-unlock-cookie";
import { signedClientIpHeaders } from "@/server/client-ip-forward";

/**
 * Sets a signed, HttpOnly cookie that proves the viewer entered the
 * correct password for a gated event. The actual validation is delegated
 * to the existing `events.validatePassword` tRPC mutation — this route
 * just turns its success result into a cookie that survives
 * `router.refresh()` for anonymous viewers.
 *
 * For signed-in viewers the unlock is also persisted server-side in
 * `event_unlocks` (via humanId in the same mutation). The cookie is
 * still useful for them as a fast-path that skips the DB lookup, but
 * isn't load-bearing.
 *
 * Security:
 *   - Origin check: rejects cross-site POSTs even though SameSite=Lax
 *     also blocks them; belt + suspenders.
 *   - Structured log on success and failure for abuse detection.
 *   - After repeated wrong passwords the API asks for a Turnstile token
 *     (EVENT_PASSWORD_CHALLENGE_REQUIRED). The widget's token rides in
 *     `turnstileToken`; the challenge comes back as a 403
 *     `event_password_challenge_required` so the client can render it.
 */

const bodySchema = z
  .object({
    password: z.string().min(1).max(256),
    turnstileToken: z.string().min(1).max(4096).optional(),
  })
  .strict();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function log(
  outcome:
    | "success"
    | "invalid_password"
    | "challenge_required"
    | "upstream_error"
    | "rejected",
  fields: Record<string, unknown>,
): void {
  // Single-line JSON keeps grep + ingestion simple. Structured logging
  // surface is intentionally minimal here — pino lives in apps/api.
  console.log(
    JSON.stringify({
      event: "event_unlock_attempt",
      outcome,
      ...fields,
    }),
  );
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;

  // ── Origin check ────────────────────────────────────────────────────
  // SameSite=Lax already blocks most cross-site POSTs, but a stale
  // tab or a misconfigured CDN can still leak. Require the Origin
  // header to match the configured site origin (dev / preview / prod).
  const origin = req.headers.get("origin");
  const siteOrigin = (() => {
    try {
      return new URL(webEnv.siteUrl).origin;
    } catch {
      return null;
    }
  })();
  if (origin && siteOrigin && origin !== siteOrigin) {
    log("rejected", { reason: "origin_mismatch", origin, eventId });
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  if (!UUID_RE.test(eventId)) {
    log("rejected", { reason: "invalid_event_id", eventId });
    return NextResponse.json({ error: "invalid_event_id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    log("rejected", { reason: "invalid_body", eventId });
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    log("rejected", { reason: "invalid_body", eventId });
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Proxy to the API's tRPC endpoint via a plain fetch. We deliberately
  // skip the SSR tRPC client (which uses React.cache + headers()) because
  // its lifecycle is fragile inside Route Handlers — the cached client
  // hangs when invoked outside an RSC render.
  const trpcUrl = `${getTrpcHttpUrl()}/events.validatePassword?batch=1`;
  // Forward the viewer's cookie so the API can identify a signed-in
  // session (lets the persisted EventUnlock row carry humanId for
  // authed viewers).
  //
  // The visitor's IP rides as a SIGNED forward (x-th-client-ip*), never as a
  // copied proxy header. This fetch leaves from the web server, so the API
  // would otherwise resolve every guest to our egress IP and put them all in
  // one 5/min bucket per event. The API verifies the HMAC and ignores
  // anything it can't. We sign the inbound `cf-connecting-ip`, trusting it no
  // more than the API already does, and require the Cloudflare-stamped origin
  // secret once ENFORCE_ORIGIN_SECRET is on (see client-ip-forward.ts).
  const cookie = req.headers.get("cookie");
  let upstream: Response;
  try {
    upstream = await fetch(trpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...signedClientIpHeaders(req.headers),
      },
      cache: "no-store",
      body: JSON.stringify({
        "0": {
          json: {
            eventId,
            password: parsed.data.password,
            ...(parsed.data.turnstileToken
              ? { turnstileToken: parsed.data.turnstileToken }
              : {}),
          },
        },
      }),
    });
  } catch (err) {
    log("upstream_error", {
      reason: "fetch_threw",
      eventId,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "unlock_failed" }, { status: 502 });
  }

  // 429 from the rate-limiter passes through with a friendlier code so
  // the client can render dedicated "too many attempts" copy.
  if (upstream.status === 429) {
    log("rejected", { reason: "rate_limited", eventId });
    return NextResponse.json(
      { error: "too_many_attempts" },
      { status: 429 },
    );
  }

  // The API returns a tRPC v11 batch response: `[{result: {data: {json: T}}}]`
  // for success, or `[{error: {...}}]` for procedure errors.
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    log("upstream_error", { reason: "non_json", eventId });
    return NextResponse.json({ error: "unlock_failed" }, { status: 502 });
  }
  const entry = Array.isArray(body) ? body[0] : null;
  if (entry && typeof entry === "object" && "error" in entry) {
    const errBody = (
      entry as {
        error: { json?: { message?: string; data?: { appCode?: string } } };
      }
    ).error?.json;
    // The error-contract migration carries the canonical SCREAMING_SNAKE code in
    // both `data.appCode` (preferred) and `message`. Prefer the structured field.
    const upstreamCode = errBody?.data?.appCode ?? errBody?.message;
    if (upstreamCode === "EVENT_PASSWORD_INVALID") {
      log("invalid_password", { eventId });
      return NextResponse.json(
        { error: "event_password_invalid" },
        { status: 401 },
      );
    }
    if (upstreamCode === "EVENT_PASSWORD_CHALLENGE_REQUIRED") {
      log("challenge_required", {
        eventId,
        tokenPresent: Boolean(parsed.data.turnstileToken),
      });
      return NextResponse.json(
        { error: "event_password_challenge_required" },
        { status: 403 },
      );
    }
    log("upstream_error", {
      reason: "trpc_error",
      eventId,
      message: errBody?.message ?? null,
    });
    return NextResponse.json({ error: "unlock_failed" }, { status: 502 });
  }
  const result = (
    entry as {
      result?: {
        data?: {
          json?: { unlocked?: boolean; bypassed?: boolean; persisted?: boolean };
        };
      };
    }
  )?.result?.data?.json;
  if (!result?.unlocked) {
    log("invalid_password", { eventId });
    return NextResponse.json(
      { error: "event_password_invalid" },
      { status: 401 },
    );
  }

  const setCookie = buildEventUnlockSetCookie(eventId);
  if (!setCookie && !result.persisted && !result.bypassed) {
    log("upstream_error", { reason: "cookie_signing_unavailable", eventId });
    return NextResponse.json({ error: "unlock_failed" }, { status: 500 });
  }

  log("success", {
    eventId,
    bypassed: Boolean(result.bypassed),
    persisted: Boolean(result.persisted),
  });
  const res = NextResponse.json({
    unlocked: true,
    bypassed: Boolean(result.bypassed),
  });
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}
