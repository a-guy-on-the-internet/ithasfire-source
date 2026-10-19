import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";

import { isInvalidAttemptsRateLimited } from "@th/trpc/rate-limit-markers";

import { getTrpcHttpUrl } from "@/config/trpc";
import { signedClientIpHeaders } from "@/server/client-ip-forward";

/**
 * RFC 8058 one-click "Stop invites from this organiser" (gated-event invite
 * links, owner ruling 2026-10-05).
 *
 * Every invite email carries
 *   List-Unsubscribe: <https://<site>/api/invites/stop?token=…>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * and a mail client's "Unsubscribe" button makes the PROVIDER's server POST
 * `List-Unsubscribe=One-Click` (application/x-www-form-urlencoded, or
 * multipart/form-data) to that URL. This route proxies the token to the
 * `events.stopOrganiserInvites` mutation, which verifies it and records the
 * opt-out (idempotent).
 *
 * - POST only. Next answers any other method 405, so a link scanner's GET
 *   prefetch can never change anything.
 * - No Origin check: the POST comes from the mail provider's servers, not a
 *   browser on this site, and the signed token is the whole credential (it
 *   can only opt that one address out of invites: from that organiser, or,
 *   from the stop page, from every organiser; this route only ever does the
 *   first).
 * - The body must carry `List-Unsubscribe=One-Click` (RFC 8058 §3.2); the
 *   human confirmation page calls the tRPC procedure itself, not this route.
 * - The token is never logged or echoed.
 *
 * Contract (every response `Cache-Control: private, no-store`):
 *   200 `{ ok: true }`                         opted out (or already was)
 *   400 `{ ok: false, error: "invalid_request" }` no token / not one-click
 *   400 `{ ok: false, error: "invalid_token" }`   forged, malformed, or the
 *                                                 organiser no longer exists
 *   429 `{ ok: false, error: "too_many_requests" }` (reported to Sentry only
 *       when it is the default floor, not the invalid-token bucket)
 *   502 `{ ok: false, error: "stop_failed" }`
 */

/** Generous over a real token (always 158 chars); input is bounded upstream too. */
const TOKEN_MAX = 1024;

function respond(body: Record<string, unknown>, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

function log(outcome: string, fields: Record<string, unknown> = {}): void {
  // Never the token.
  console.log(JSON.stringify({ event: "invite_opt_out_one_click", outcome, ...fields }));
}

/** Silent failures go to Sentry too; codes only, never the token or body. */
function report(reason: string, extra: Record<string, unknown> = {}): void {
  try {
    Sentry.captureException(new Error(`invite opt-out one-click: ${reason}`), {
      tags: { route: "invite-opt-out", reason },
      extra,
    });
  } catch {
    // Sentry unavailable: the log line still records it.
  }
}

/** The first batch entry's tRPC error message, or null (never throws). */
async function upstreamErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as unknown;
    const entry = Array.isArray(body) ? body[0] : null;
    const message = (entry as { error?: { json?: { message?: unknown } } } | null)
      ?.error?.json?.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

const invalidRequest = () =>
  respond({ ok: false, error: "invalid_request" }, 400);
const failed = () => respond({ ok: false, error: "stop_failed" }, 502);

async function isOneClickBody(req: NextRequest): Promise<boolean> {
  const type = req.headers.get("content-type") ?? "";
  if (
    !type.startsWith("application/x-www-form-urlencoded") &&
    !type.startsWith("multipart/form-data")
  ) {
    return false;
  }
  try {
    if (type.startsWith("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(await req.text());
      return params.get("List-Unsubscribe") === "One-Click";
    }
    // This app's TS lib set types FormData without its accessors; the
    // runtime object is the standard one.
    const form = (await req.formData()) as unknown as {
      get(name: string): unknown;
    };
    return form.get("List-Unsubscribe") === "One-Click";
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || token.length > TOKEN_MAX) {
    log("rejected", { reason: "token_missing_or_long" });
    return invalidRequest();
  }
  if (!(await isOneClickBody(req))) {
    log("rejected", { reason: "not_one_click" });
    return invalidRequest();
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${getTrpcHttpUrl()}/events.stopOrganiserInvites?batch=1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The per-IP limit keys on the caller (the mail provider), not on
          // this server. No cookies: the provider has none, and none are
          // needed.
          ...signedClientIpHeaders(req.headers),
        },
        cache: "no-store",
        body: JSON.stringify({ "0": { json: { token } } }),
      },
    );
  } catch {
    log("upstream_error", { reason: "fetch_threw" });
    report("fetch_threw");
    return failed();
  }

  if (upstream.status === 429) {
    // Two limiters can refuse upstream. The invalid-attempts bucket
    // (`chargeFailedAttempt`) only charges BAD tokens, so it can never drop a
    // real opt-out: logged, not reported (it would only drain Sentry quota
    // under a guessing run). Anything else is the default floor, which can
    // drop a valid opt-out from a busy provider IP: reported.
    const invalidOnly = isInvalidAttemptsRateLimited(
      await upstreamErrorMessage(upstream),
    );
    log("rejected", {
      reason: invalidOnly ? "invalid_attempts_rate_limited" : "rate_limited",
    });
    if (!invalidOnly) report("rate_limited", { status: 429 });
    return respond({ ok: false, error: "too_many_requests" }, 429);
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    log("upstream_error", { reason: "non_json", status: upstream.status });
    report("non_json", { status: upstream.status });
    return failed();
  }

  const entry = Array.isArray(body) ? body[0] : null;
  if (!entry || typeof entry !== "object" || "error" in entry) {
    const code =
      (entry as { error?: { json?: { data?: { appCode?: string } } } } | null)
        ?.error?.json?.data?.appCode ?? null;
    // A bad token never gets here (it is an `ok: false` OUTCOME); a tRPC
    // input error would mean the token failed the schema bound.
    if (upstream.status === 400) {
      log("rejected", { reason: "invalid_input", code });
      return respond({ ok: false, error: "invalid_token" }, 400);
    }
    log("upstream_error", { reason: "trpc_error", status: upstream.status, code });
    report("trpc_error", { status: upstream.status, code });
    return failed();
  }

  const result = (
    entry as { result?: { data?: { json?: { ok?: unknown } } } }
  ).result?.data?.json;
  if (result?.ok === true) {
    log("success");
    return respond({ ok: true });
  }
  if (result?.ok === false) {
    log("rejected", { reason: "invalid_token" });
    return respond({ ok: false, error: "invalid_token" }, 400);
  }
  log("upstream_error", { reason: "malformed_result" });
  report("malformed_result");
  return failed();
}
