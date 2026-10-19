import { NextResponse, type NextRequest } from "next/server";

import { webEnv } from "@/config/env.server";
import { getTrpcHttpUrl } from "@/config/trpc";
import { signedClientIpHeaders } from "@/server/client-ip-forward";
import {
  filterEventUnlockCookies,
  mintTokenFromCookie,
} from "@/server/trpc-client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cookiePresent(cookieHeader: string, name: string): boolean {
  const prefix = `${name}=`;
  return cookieHeader.split(";").some((part) => part.trim().startsWith(prefix));
}

type SyncProcedure =
  | "events.recordSignedPasswordUnlock"
  | "events.recordSignedApplicationUnlock"
  | "events.recordSignedInviteUnlock";

/**
 * The event's gate type as the checkout page saw it (`gateState.gateType`),
 * sent in the POST body. It only picks WHICH proof to sync: each procedure
 * re-verifies its own cookie and gate server-side, so a wrong hint can only
 * make this viewer's own sync come back `persisted: false`.
 */
async function readGateTypeHint(
  req: NextRequest,
): Promise<"PASSWORD" | "APPLICATION" | null> {
  const body: unknown = await req.json().catch(() => null);
  const gateType =
    body && typeof body === "object" && "gateType" in body
      ? (body as { gateType: unknown }).gateType
      : null;
  return gateType === "PASSWORD" || gateType === "APPLICATION"
    ? gateType
    : null;
}

/** Upstream error message → status the checkout client sees. */
const GATE_REQUIRED_MESSAGES = new Set([
  "event_password_required",
  "event_application_required",
  "event_invite_grant_required",
]);

/**
 * Converts the viewer's signed anonymous gate cookie into a durable unlock on
 * their (now signed-in) account before checkout — the buyer's own tRPC calls
 * go to the API's origin, which never receives these web-host cookies.
 *
 *  - `th_ea_<eventId>` (approved application) → `recordSignedApplicationUnlock`.
 *    The API persists only for the submission's subject while it is still
 *    APPROVED; anyone else gets `persisted: false`.
 *  - `th_eu_<eventId>` (password) → `recordSignedPasswordUnlock`, unchanged.
 *  - `th_ei_<eventId>` (invite link) → `recordSignedInviteUnlock`, on EITHER
 *    gate type (an invite opens both). The API re-checks the invite; one that
 *    no longer holds comes back `persisted: false`.
 *
 * Each cookie is synced only on its own gate: the grant on an APPLICATION
 * event, the password cookie on a PASSWORD event (the `gateType` hint from
 * the checkout page). So a grant holder who is not the submission's subject
 * and also carries a stale `th_eu_` gets `persisted: false` (checkout's gate
 * then refuses with FORBIDDEN), not EVENT_NOT_PASSWORD_GATED as a 502.
 * Without a hint (a tab loaded before the hint existed) both are eligible:
 * the grant first, the password path only if it did not persist.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;

  const origin = req.headers.get("origin");
  const siteOrigin = (() => {
    try {
      return new URL(webEnv.siteUrl).origin;
    } catch {
      return null;
    }
  })();
  if (origin && siteOrigin && origin !== siteOrigin) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  if (!UUID_RE.test(eventId)) {
    return NextResponse.json({ error: "invalid_event_id" }, { status: 400 });
  }

  const gateType = await readGateTypeHint(req);
  const cookie = req.headers.get("cookie");
  const tryApplicationGrant =
    !!cookie &&
    gateType !== "PASSWORD" &&
    cookiePresent(cookie, `th_ea_${eventId}`);
  const tryPasswordUnlock =
    !!cookie &&
    gateType !== "APPLICATION" &&
    cookiePresent(cookie, `th_eu_${eventId}`);
  // The invite grant opens EITHER gate type, so the hint never rules it out.
  const tryInviteGrant =
    !!cookie && cookiePresent(cookie, `th_ei_${eventId}`);
  if (
    !cookie ||
    (!tryApplicationGrant && !tryInviteGrant && !tryPasswordUnlock)
  ) {
    return NextResponse.json({ persisted: false });
  }

  const token = await mintTokenFromCookie(cookie, req.headers);
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const eventUnlockCookies = filterEventUnlockCookies(cookie);
  if (!eventUnlockCookies) {
    return NextResponse.json({ persisted: false });
  }

  const sync = async (
    procedure: SyncProcedure,
  ): Promise<NextResponse | { persisted: boolean }> => {
    const trpcUrl = `${getTrpcHttpUrl()}/${procedure}?batch=1`;
    let upstream: Response;
    try {
      upstream = await fetch(trpcUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
          cookie: eventUnlockCookies,
          // Signed visitor IP so the API's per-IP limits key on the viewer, not
          // this server (see unlock/route.ts).
          ...signedClientIpHeaders(req.headers),
        },
        cache: "no-store",
        body: JSON.stringify({
          "0": {
            json: { eventId },
          },
        }),
      });
    } catch {
      return NextResponse.json({ error: "unlock_sync_failed" }, { status: 502 });
    }

    let body: unknown;
    try {
      body = await upstream.json();
    } catch {
      return NextResponse.json({ error: "unlock_sync_failed" }, { status: 502 });
    }

    const entry = Array.isArray(body) ? body[0] : null;
    if (entry && typeof entry === "object" && "error" in entry) {
      const errBody = (entry as { error: { json?: { message?: string } } })
        .error?.json;
      const message = errBody?.message;
      const status = message && GATE_REQUIRED_MESSAGES.has(message) ? 403 : 502;
      return NextResponse.json(
        { error: message ?? "unlock_sync_failed" },
        { status },
      );
    }

    const result = (
      entry as { result?: { data?: { json?: { persisted?: boolean } } } }
    )?.result?.data?.json;
    return { persisted: Boolean(result?.persisted) };
  };

  // Each eligible proof in turn; the first that persists wins. A proof the API
  // refused (or did not persist) only matters if there is nothing else to try,
  // so the LAST attempt's answer is what the client sees.
  const procedures: SyncProcedure[] = [
    ...(tryApplicationGrant
      ? (["events.recordSignedApplicationUnlock"] as const)
      : []),
    ...(tryInviteGrant ? (["events.recordSignedInviteUnlock"] as const) : []),
    ...(tryPasswordUnlock
      ? (["events.recordSignedPasswordUnlock"] as const)
      : []),
  ];
  let last: NextResponse | { persisted: boolean } = { persisted: false };
  for (const procedure of procedures) {
    last = await sync(procedure);
    if (!(last instanceof NextResponse) && last.persisted) break;
  }
  if (last instanceof NextResponse) return last;
  return NextResponse.json({ persisted: last.persisted });
}
