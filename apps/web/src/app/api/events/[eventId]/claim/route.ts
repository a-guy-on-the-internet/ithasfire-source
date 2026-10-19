import { NextResponse, type NextRequest } from "next/server";

import { getTrpcHttpUrl } from "@/config/trpc";
import { buildEventApplicationGrantSetCookie } from "@/lib/event-unlock-cookie";
import { signedClientIpHeaders } from "@/server/client-ip-forward";

/**
 * GET endpoint for the applicant's approval-claim link (emailed by the
 * organizer's approval decision). Unlike the password `unlock` route this is a
 * GET — email clients issue cross-site GETs — so there is deliberately NO
 * Origin check.
 *
 * It proxies to the `events.redeemApplicationToken` tRPC mutation (forwarding
 * the viewer's cookie so the API can tell whether the clicker IS the applicant
 * — only the applicant, or a guest whose email matches and gets attached, gets
 * a persisted humanId unlock; a forwarded link never does), then sets the
 * APPLICATION grant cookie `th_ea_<eventId>` (carrying the approved
 * `submissionId` and the `approvedAt` of that approval) and 302-redirects to
 * the event page.
 *
 * The grant is what lets an approved guest who never signs in through the
 * gate. It is NOT a bearer pass: the API re-reads the submission on every
 * check and requires it to be APPROVED for this event under the same
 * approval, so a rescind or withdrawal ends access on the next request and a
 * later re-approval does not revive it (see
 * `packages/core/src/use-cases/events/_shared/application-gate-grant.ts`).
 *
 * This route deliberately no longer sets the password cookie `th_eu_`: no
 * reader honours it on an APPLICATION gate, two readers (sync-unlock and the
 * orders-router persist) reject it there with EVENT_NOT_PASSWORD_GATED, and
 * if the organizer later switched the event to a PASSWORD gate it would have
 * opened that gate without the password.
 *
 * On any failure (invalid / expired token, upstream error) it redirects to a
 * benign destination with a `?claim=...` flag rather than surfacing an error —
 * the event page just shows the gate again.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LEN = 128;

function log(
  outcome: "success" | "invalid_token" | "expired" | "upstream_error" | "rejected",
  fields: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      event: "event_application_claim",
      outcome,
      ...fields,
    }),
  );
}

function redirect(req: NextRequest, path: string, setCookie?: string | null) {
  const res = NextResponse.redirect(new URL(path, req.url));
  // The bearer token rides the inbound URL (`?token=`); a bare 302 would leak
  // it downstream via the Referer header. Suppress it on every response.
  res.headers.set("Referrer-Policy", "no-referrer");
  // Never cache: the URL carries that bearer token and the success redirect
  // sets the viewer's grant cookie. Every exit goes through here.
  res.headers.set("Cache-Control", "private, no-store, max-age=0");
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;
  const token = req.nextUrl.searchParams.get("token") ?? "";

  // Bad input from a human clicking a link → send them home, don't 400.
  if (!UUID_RE.test(eventId) || token.length === 0 || token.length > MAX_TOKEN_LEN) {
    log("rejected", { reason: "invalid_input", eventId });
    return redirect(req, "/");
  }

  // Proxy to the API's tRPC endpoint via a plain fetch (see unlock/route.ts
  // for why we avoid the SSR tRPC client inside Route Handlers). Forward the
  // viewer's cookie so the API can persist a humanId unlock when the clicker is
  // the applicant (never for a forwarded link), and the
  // visitor's IP as a signed forward so the API's rate limits key on the
  // clicker rather than on this server (see unlock/route.ts).
  const trpcUrl = `${getTrpcHttpUrl()}/events.redeemApplicationToken?batch=1`;
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
          json: { eventId, token },
        },
      }),
    });
  } catch (err) {
    log("upstream_error", {
      reason: "fetch_threw",
      eventId,
      message: err instanceof Error ? err.message : String(err),
    });
    return redirect(req, "/?claim=error");
  }

  if (upstream.status === 429) {
    log("rejected", { reason: "rate_limited", eventId });
    return redirect(req, "/?claim=error");
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    log("upstream_error", { reason: "non_json", eventId });
    return redirect(req, "/?claim=error");
  }

  const entry = Array.isArray(body) ? body[0] : null;
  if (entry && typeof entry === "object" && "error" in entry) {
    const errBody = (
      entry as {
        error: { json?: { message?: string; data?: { appCode?: string } } };
      }
    ).error?.json;
    const upstreamCode = errBody?.data?.appCode ?? errBody?.message;
    if (upstreamCode === "APPLICATION_TOKEN_EXPIRED") {
      log("expired", { eventId });
      return redirect(req, "/?claim=expired");
    }
    log("invalid_token", { eventId, code: upstreamCode ?? null });
    return redirect(req, "/?claim=invalid");
  }

  const result = (
    entry as {
      result?: {
        data?: {
          json?: {
            slug?: string;
            submissionId?: string;
            /** superjson carries a Date as its ISO string in `json`. */
            approvedAt?: string;
            unlocked?: boolean;
            persisted?: boolean;
          };
        };
      };
    }
  )?.result?.data?.json;

  if (!result?.unlocked || !result.slug) {
    log("invalid_token", { eventId });
    return redirect(req, "/?claim=invalid");
  }

  // Setting the cookie + redirect must ride the SAME response. The submission
  // id and approval stamp are re-validated before they are signed — they come
  // from upstream JSON.
  const submissionId =
    typeof result.submissionId === "string" && UUID_RE.test(result.submissionId)
      ? result.submissionId
      : null;
  const approvedAtMs =
    typeof result.approvedAt === "string" ? Date.parse(result.approvedAt) : NaN;
  const setCookie =
    submissionId && Number.isSafeInteger(approvedAtMs) && approvedAtMs >= 0
      ? buildEventApplicationGrantSetCookie(eventId, submissionId, approvedAtMs)
      : null;
  if (!setCookie && !result.persisted) {
    // No signing secret and no persisted row means the redirect wouldn't
    // actually unlock — surface a benign error rather than a broken loop.
    log("upstream_error", { reason: "cookie_signing_unavailable", eventId });
    return redirect(req, "/?claim=error");
  }

  log("success", {
    eventId,
    persisted: Boolean(result.persisted),
  });
  return redirect(req, `/events/${result.slug}`, setCookie);
}
