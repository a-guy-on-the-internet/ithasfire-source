import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { webEnv } from "@/config/env.server";
import { getTrpcHttpUrl } from "@/config/trpc";
import {
  buildEventApplicationGrantSetCookie,
  buildEventInviteGrantSetCookie,
} from "@/lib/event-unlock-cookie";
import { signedClientIpHeaders } from "@/server/client-ip-forward";

/**
 * Redeems a gated-event invite link (docs/specs/2026-10-02/
 * gated-event-invite-links.spec.yaml, FR-004 / FR-005 / FR-008 / FR-010,
 * NFR-002 / NFR-003).
 *
 * The event page's `?invite=<token>` landing POSTs the token here (a POST, so
 * no CDN caches it and the edge-cached event document stays identity-free).
 * This route proxies to the `events.redeemInvite` tRPC mutation and turns its
 * answer into the web-host cookie the grant needs:
 *
 *   - `INVITE_GRANT`      → `th_ei_<eventId>`, valid until the event ends;
 *   - `APPLICATION_GRANT` → `th_ea_<eventId>` (the approved guest submission),
 *                           the same writer the approval-claim route uses;
 *   - `UNLOCK`            → nothing: the unlock is persisted on the account.
 *
 * Contract (every response `Cache-Control: private, no-store` and
 * `Referrer-Policy: no-referrer`; the token is never echoed or logged):
 *
 *   200 `{ ok: true, grant, slug }`            redeemed; cookie set per grant
 *   200 `{ ok: false, reason, slug }`          dead link (FR-010); no cookie
 *   400 `{ ok: false, error: "invalid_body" | "invalid_event_id" | "event_mismatch" }`
 *   403 `{ ok: false, error: "invalid_origin" }`
 *   429 `{ ok: false, error: "too_many_attempts" }`
 *   5xx `{ ok: false, error: "redeem_failed" }`
 *
 * The browser's whole Cookie header is forwarded, as the sibling routes do:
 * the session lets a signed-in redeem persist an EventUnlock, and an existing
 * `th_ei_` grant for the same invite makes a re-redeem a no-op that is not
 * counted twice. Rate limiting is the procedure's (per IP); the visitor's IP
 * rides as a signed forward so the limit keys on them, not on this server.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same bound as core's `redeemEventInviteInputSchema.token`. */
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

const GRANTS = new Set(["UNLOCK", "APPLICATION_GRANT", "INVITE_GRANT"]);

function log(
  outcome: "success" | "dead_link" | "upstream_error" | "rejected",
  fields: Record<string, unknown>,
): void {
  // Never pass the token in `fields`.
  console.log(
    JSON.stringify({
      event: "event_invite_redeem",
      outcome,
      ...fields,
    }),
  );
}

/**
 * Failures that would otherwise fail every redeem silently (a missing signing
 * secret in prod, a contract drift with the API) go to Sentry as well as the
 * log. Only codes and the event id ride along: never the token or the body.
 * Guarded so a throwing reporter never changes the response.
 */
function report(reason: string, extra: Record<string, unknown>): void {
  try {
    Sentry.captureException(new Error(`event invite redeem: ${reason}`), {
      tags: { route: "event-invite", reason },
      extra,
    });
  } catch {
    // Sentry unavailable: the log line above still records it.
  }
}

function respond(
  body: Record<string, unknown>,
  status = 200,
  setCookie?: string | null,
): NextResponse {
  const res = NextResponse.json(body, { status });
  // The token arrived from a URL; keep it out of any Referer this response
  // could trigger, and never let a shared cache keep a cookie-setting answer.
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  res.headers.set("Referrer-Policy", "no-referrer");
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

const failed = (status = 502) =>
  respond({ ok: false, error: "redeem_failed" }, status);

type UpstreamResult =
  | {
      ok: false;
      reason?: unknown;
      eventId?: unknown;
      slug?: unknown;
    }
  | {
      ok: true;
      eventId?: unknown;
      slug?: unknown;
      grant?: unknown;
      inviteId?: unknown;
      submissionId?: unknown;
      approvedAtMs?: unknown;
      expiresAtMs?: unknown;
    };

const isNonNegInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;

  // ── Origin check, mirroring ../unlock/route.ts ──────────────────────────
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

  // Plain fetch, not the SSR tRPC client (see ../unlock/route.ts).
  const trpcUrl = `${getTrpcHttpUrl()}/events.redeemInvite?batch=1`;
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
        error?: { json?: { message?: string; data?: { appCode?: string } } };
      } | null
    )?.error?.json;
    // tRPC/Zod messages are code-like here, never the token: the procedure
    // never puts the input in an error message.
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
  // for another event sets nothing here and returns nothing about it.
  if (result.eventId != null && result.eventId !== eventId) {
    log("rejected", { reason: "event_mismatch", eventId });
    return respond({ ok: false, error: "event_mismatch" }, 400);
  }

  const slug = typeof result.slug === "string" ? result.slug : null;

  if (result.ok === false) {
    const reason =
      typeof result.reason === "string" && DEAD_REASONS.has(result.reason)
        ? result.reason
        : "INVALID";
    log("dead_link", { eventId, reason });
    return respond({ ok: false, reason, slug });
  }

  if (
    result.ok !== true ||
    result.eventId !== eventId ||
    typeof result.grant !== "string" ||
    !GRANTS.has(result.grant)
  ) {
    log("upstream_error", { reason: "malformed_result", eventId });
    report("malformed_result", { eventId });
    return failed();
  }
  const grant = result.grant;

  // Upstream values are re-validated before they are signed.
  let setCookie: string | null = null;
  if (grant === "INVITE_GRANT") {
    const inviteId =
      typeof result.inviteId === "string" && UUID_RE.test(result.inviteId)
        ? result.inviteId
        : null;
    setCookie =
      inviteId && isNonNegInt(result.expiresAtMs)
        ? buildEventInviteGrantSetCookie(eventId, inviteId, result.expiresAtMs)
        : null;
  } else if (grant === "APPLICATION_GRANT") {
    const submissionId =
      typeof result.submissionId === "string" &&
      UUID_RE.test(result.submissionId)
        ? result.submissionId
        : null;
    setCookie =
      submissionId && isNonNegInt(result.approvedAtMs)
        ? buildEventApplicationGrantSetCookie(
            eventId,
            submissionId,
            result.approvedAtMs,
          )
        : null;
  }

  if (grant !== "UNLOCK" && !setCookie) {
    // No signing secret, or a result the cookie can't carry: a "success" here
    // would leave the visitor at the gate, so say it failed.
    log("upstream_error", { reason: "cookie_signing_unavailable", eventId, grant });
    report("cookie_signing_unavailable", { eventId, grant });
    return failed(500);
  }

  log("success", { eventId, grant });
  return respond({ ok: true, grant, slug }, 200, setCookie);
}
