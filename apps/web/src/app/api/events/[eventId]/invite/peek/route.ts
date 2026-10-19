import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { webEnv } from "@/config/env.server";
import { getTrpcHttpUrl } from "@/config/trpc";
import { signedClientIpHeaders } from "@/server/client-ip-forward";

/**
 * READ-ONLY look at a gated-event invite link, for the `?invite=<token>`
 * landing BEFORE the guest taps "Open the event" (gated-event invite links
 * FR-010; approved landing design). It says who the link is for and from
 * whom, or why it is dead, so the page can show "This invite link doesn't
 * work anymore." above the gate straight away.
 *
 * Mirrors the redeem route next door (`../route.ts`): same origin check,
 * strict body, `private, no-store` and `no-referrer` on every response, the
 * token never echoed or logged. It proxies to `events.peekInvite`, which
 * writes nothing and counts nothing, so this route sets NO cookie and does
 * NOT forward the browser's cookies: the answer is the same for everyone
 * holding the token. Rate limiting is the procedure's (per IP, its own
 * bucket); the visitor's IP rides as a signed forward.
 *
 * Contract:
 *
 *   200 `{ ok: true, kind, inviteeShortName, organizerName }`
 *         kind: "SHARED" | "PERSONAL"; inviteeShortName: "Maya R." | null
 *         (PERSONAL only); organizerName: string | null
 *   200 `{ ok: false, reason }`   reason: INVALID | REVOKED | EVENT_ENDED |
 *                                 EVENT_CANCELLED | EVENT_UNAVAILABLE | NOT_GATED
 *   400 `{ ok: false, error: "invalid_body" | "invalid_event_id" | "event_mismatch" }`
 *   403 `{ ok: false, error: "invalid_origin" }`
 *   429 `{ ok: false, error: "too_many_attempts" }`
 *   5xx `{ ok: false, error: "peek_failed" }`
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same bound as core's `peekEventInviteInputSchema.token`. */
const bodySchema = z
  .object({
    token: z.string().min(1).max(256),
  })
  .strict();

const DEAD_REASONS = new Set([
  "INVALID",
  "REVOKED",
  "EVENT_ENDED",
  "EVENT_CANCELLED",
  "EVENT_UNAVAILABLE",
  "NOT_GATED",
]);

const KINDS = new Set(["SHARED", "PERSONAL"]);

function log(
  outcome: "live_link" | "dead_link" | "upstream_error" | "rejected",
  fields: Record<string, unknown>,
): void {
  // Never pass the token in `fields`.
  console.log(
    JSON.stringify({
      event: "event_invite_peek",
      outcome,
      ...fields,
    }),
  );
}

/**
 * A failing peek would hide every invite landing's message (a missing secret
 * in prod, a contract drift). Codes and the event id only, never the token.
 * Guarded so a throwing reporter never changes the response.
 */
function report(reason: string, extra: Record<string, unknown>): void {
  try {
    Sentry.captureException(new Error(`event invite peek: ${reason}`), {
      tags: { route: "event-invite-peek", reason },
      extra,
    });
  } catch {
    // Sentry unavailable: the log line still records it.
  }
}

function respond(body: Record<string, unknown>, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  // The token arrived from a URL: no Referer, no shared cache.
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

const failed = (status = 502) =>
  respond({ ok: false, error: "peek_failed" }, status);

type UpstreamResult = {
  ok?: unknown;
  reason?: unknown;
  eventId?: unknown;
  kind?: unknown;
  inviteeShortName?: unknown;
  organizerName?: unknown;
};

const stringOrNull = (v: unknown): string | null =>
  typeof v === "string" ? v : null;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;

  // ── Origin check, mirroring ../route.ts ─────────────────────────────────
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
    return respond({ ok: false, error: "invalid_origin" }, 403);
  }

  if (!UUID_RE.test(eventId)) {
    log("rejected", { reason: "invalid_event_id" });
    return respond({ ok: false, error: "invalid_event_id" }, 400);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    log("rejected", { reason: "invalid_body", eventId });
    return respond({ ok: false, error: "invalid_body" }, 400);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    log("rejected", { reason: "invalid_body", eventId });
    return respond({ ok: false, error: "invalid_body" }, 400);
  }

  // A tRPC MUTATION (POST body), so the token never lands in a URL. No
  // cookies forwarded: the peek is identity-free.
  const trpcUrl = `${getTrpcHttpUrl()}/events.peekInvite?batch=1`;
  let upstream: Response;
  try {
    upstream = await fetch(trpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedClientIpHeaders(req.headers),
      },
      cache: "no-store",
      // `expectedEventId`: a token for another event dies upstream as
      // INVALID before anything is counted or written (the mismatch check
      // below stays as a backstop).
      body: JSON.stringify({
        "0": { json: { token: parsed.data.token, expectedEventId: eventId } },
      }),
    });
  } catch (err) {
    log("upstream_error", {
      reason: "fetch_threw",
      eventId,
      message: err instanceof Error ? err.message : String(err),
    });
    // The reason code only: an error message could carry the request.
    report("fetch_threw", { eventId });
    return failed();
  }

  if (upstream.status === 429) {
    log("rejected", { reason: "rate_limited", eventId });
    return respond({ ok: false, error: "too_many_attempts" }, 429);
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    log("upstream_error", { reason: "non_json", eventId });
    report("non_json", { eventId, status: upstream.status });
    return failed();
  }

  const entry = Array.isArray(body) ? body[0] : null;
  if (!entry || typeof entry !== "object" || "error" in entry) {
    const errBody = (
      entry as {
        error?: { json?: { data?: { appCode?: string } } };
      } | null
    )?.error?.json;
    log("upstream_error", {
      reason: "trpc_error",
      eventId,
      code: errBody?.data?.appCode ?? null,
    });
    report("trpc_error", {
      eventId,
      status: upstream.status,
      code: errBody?.data?.appCode ?? null,
    });
    return failed();
  }

  const result = (entry as { result?: { data?: { json?: UpstreamResult } } })
    .result?.data?.json;
  if (!result || typeof result !== "object") {
    log("upstream_error", { reason: "no_result", eventId });
    report("no_result", { eventId });
    return failed();
  }

  // The invite must belong to the event whose URL the visitor is on. A token
  // for another event says nothing about it here.
  if (result.eventId != null && result.eventId !== eventId) {
    log("rejected", { reason: "event_mismatch", eventId });
    return respond({ ok: false, error: "event_mismatch" }, 400);
  }

  if (result.ok === false) {
    const reason =
      typeof result.reason === "string" && DEAD_REASONS.has(result.reason)
        ? result.reason
        : "INVALID";
    log("dead_link", { eventId, reason });
    return respond({ ok: false, reason });
  }

  if (
    result.ok !== true ||
    result.eventId !== eventId ||
    typeof result.kind !== "string" ||
    !KINDS.has(result.kind)
  ) {
    log("upstream_error", { reason: "malformed_result", eventId });
    report("malformed_result", { eventId });
    return failed();
  }

  log("live_link", { eventId, kind: result.kind });
  return respond({
    ok: true,
    kind: result.kind,
    inviteeShortName:
      result.kind === "PERSONAL" ? stringOrNull(result.inviteeShortName) : null,
    organizerName: stringOrNull(result.organizerName),
  });
}
