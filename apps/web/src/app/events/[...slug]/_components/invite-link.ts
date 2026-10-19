"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { traceIgnoredError } from "@/lib/trace-ignored-error";
import {
  clearStashedInviteToken,
  readStashedInviteToken,
  stashInviteToken,
  stripInviteParam,
  syncRouterToCleanUrl,
} from "./invite-url";

/**
 * The guest half of a gated-event invite link (docs/specs/2026-10-02/
 * gated-event-invite-links.spec.yaml FR-004 / FR-005 / FR-010, NFR-002).
 *
 * The event document is the same bytes for everyone, so the server never
 * looks at `?invite=`. This hook does, in the browser:
 *
 *   1. reads the token and strips it from the address bar BEFORE any fetch
 *      (a layout effect, so it runs ahead of the shell's access probe), so the
 *      token is not in the visible URL, the history entry's URL or a later
 *      request's Referer. ACCEPTED RESIDUAL: it is still inside the entry's
 *      `history.state`, because Next keys the page segment by its search
 *      params (`__PAGE__?{"invite":…}`) and invite-url.ts deliberately keeps
 *      that state (dropping it breaks Back). That copy stays in this browser
 *      and is never sent over the network. The token is also stashed in
 *      sessionStorage (`th:invite:<eventId>`) so a reload before the tap
 *      keeps the invite; that adds no exposure (same tab, same origin, never
 *      sent to the server, like history.state) and is cleared on redeem, on
 *      a dead verdict, when the viewer is already through, and on give-up;
 *   2. waits for the shell's access verdict: a viewer who can already see the
 *      event never peeks or redeems;
 *   3. peeks (`POST /api/events/<id>/invite/peek`, read-only) to learn whether
 *      the link is live and who it is from;
 *   4. on "Open the event", redeems (`POST /api/events/<id>/invite`), which
 *      sets the grant cookie, then hands over to the shell's reveal.
 *
 * The token lives in a ref for the life of the page and nowhere else: never
 * in state, never in a log line, never in an error report.
 */

/** Per request: a hung peek must not leave the gate veiled. */
export const INVITE_FETCH_TIMEOUT_MS = 8_000;
/** One automatic second try after an unanswered peek. */
export const PEEK_RETRY_DELAY_MS = 800;

export type InviteKind = "SHARED" | "PERSONAL";

export type InviteState =
  /** No token, the viewer is already through, or the peek could not answer. */
  | { status: "none" }
  /** Token in hand; waiting on the access verdict and then the peek. */
  | { status: "pending" }
  | {
      status: "live";
      kind: InviteKind;
      inviteeShortName: string | null;
      organizerName: string | null;
    }
  /**
   * Revoked, ended, unknown, or for another event: the normal gate + a line.
   * `from`: the landing's peek, or the guest's own tap (which moves focus).
   */
  | { status: "dead"; from: "peek" | "redeem" };

export type PeekOutcome =
  | {
      kind: "live";
      inviteKind: InviteKind;
      inviteeShortName: string | null;
      organizerName: string | null;
    }
  | { kind: "dead" }
  /** No usable answer: say nothing about the invite. `why` is for the trace. */
  | { kind: "unavailable"; why: PeekUnavailableWhy };

/** Why a peek gave no answer. Kinds only: never a token, never a URL. */
export type PeekUnavailableWhy =
  | "timeout"
  | "network"
  | "403"
  | "429"
  | "5xx"
  | "malformed";

export type RedeemOutcome =
  | { kind: "ok" }
  | { kind: "dead" }
  | { kind: "rateLimited" }
  | { kind: "failed" };

const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const post = (url: string, token: string) =>
  fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    // The token rides in the body only — never a URL, never a header.
    body: JSON.stringify({ token }),
    referrerPolicy: "no-referrer",
    // Aborts the body read too; a timeout lands in the callers' catch.
    signal: AbortSignal.timeout(INVITE_FETCH_TIMEOUT_MS),
  });

/** `POST /api/events/<id>/invite/peek` mapped onto what the page shows. */
export async function peekInvite(
  eventId: string,
  token: string,
): Promise<PeekOutcome> {
  let res: Response;
  try {
    res = await post(`/api/events/${eventId}/invite/peek`, token);
  } catch (err) {
    // By name, not `instanceof Error`: a DOMException is not one in every
    // realm.
    const name = (err as { name?: unknown } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { kind: "unavailable", why: timedOut ? "timeout" : "network" };
  }
  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (res.status === 400 && body?.error === "event_mismatch") {
    // A link for another event pasted onto this one: as dead as a revoked one.
    return { kind: "dead" };
  }
  if (!res.ok || !body) {
    const why: PeekUnavailableWhy =
      res.status === 403
        ? "403"
        : res.status === 429
          ? "429"
          : res.status >= 500
            ? "5xx"
            : "malformed";
    return { kind: "unavailable", why };
  }
  if (body.ok === true) {
    const inviteKind = body.kind;
    if (inviteKind !== "SHARED" && inviteKind !== "PERSONAL") {
      return { kind: "unavailable", why: "malformed" };
    }
    return {
      kind: "live",
      inviteKind,
      inviteeShortName:
        inviteKind === "PERSONAL" ? nonEmpty(body.inviteeShortName) : null,
      organizerName: nonEmpty(body.organizerName),
    };
  }
  if (body.ok === false && typeof body.reason === "string") {
    return { kind: "dead" };
  }
  return { kind: "unavailable", why: "malformed" };
}

/** `POST /api/events/<id>/invite` mapped onto what the Door does next. */
export async function redeemInvite(
  eventId: string,
  token: string,
): Promise<RedeemOutcome> {
  let res: Response;
  try {
    res = await post(`/api/events/${eventId}/invite`, token);
  } catch {
    return { kind: "failed" };
  }
  if (res.status === 429) return { kind: "rateLimited" };
  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (res.status === 400 && body?.error === "event_mismatch") {
    return { kind: "dead" };
  }
  if (!res.ok || !body) return { kind: "failed" };
  if (body.ok === true) return { kind: "ok" };
  if (body.ok === false && typeof body.reason === "string") {
    return { kind: "dead" };
  }
  return { kind: "failed" };
}

/** Why the Door's last tap did not open the event. */
export type InviteDoorError = "rateLimited" | "generic";

export type UseInviteLink = {
  state: InviteState;
  /** The redeem (or the reveal after it) is running. */
  opening: boolean;
  /** Bumped per failed tap so the Door re-announces a repeated error. */
  error: { kind: InviteDoorError; n: number } | null;
  /** The shell's mount probe has answered. `opened` = the event is showing. */
  onAccessVerdict: (opened: boolean) => void;
  /** "Open the event". */
  open: () => Promise<void>;
};

/**
 * @param reveal The shell's post-unlock probe: resolves `true` once the event
 *   is on screen. Called after a successful redeem, exactly as the password
 *   gate calls it after an accepted password.
 */
export function useInviteLink(
  eventId: string,
  reveal: () => Promise<boolean>,
  /**
   * The server saw a non-empty `?invite=` (presence only, never the value).
   * Then the server render and the first client render both start veiled
   * ("pending"), so hydration matches and the plain gate never flashes while
   * the page hydrates. The layout effect confirms it or drops to "none".
   */
  inviteParamPresent = false,
): UseInviteLink {
  // `undefined` = not read yet; `null` = read, none (or dropped).
  const tokenRef = useRef<string | null | undefined>(undefined);
  const [state, setState] = useState<InviteState>(
    inviteParamPresent ? { status: "pending" } : { status: "none" },
  );
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<UseInviteLink["error"]>(null);
  const verdictSeen = useRef(false);
  const openingRef = useRef(false);
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  // Layout effect: runs before every passive effect on the page, so the token
  // is out of the address bar before the shell's probe (or anything else)
  // fetches. Read ONCE: StrictMode re-runs this, and by then the URL is clean.
  const strippedRef = useRef(false);
  useLayoutEffect(() => {
    if (tokenRef.current !== undefined) return;
    const { stripped, token: fromUrl } = stripInviteParam();
    strippedRef.current = stripped;
    // A clean URL may be a RELOAD of a landing whose token was stashed.
    const token = fromUrl ?? readStashedInviteToken(eventId);
    if (fromUrl) stashInviteToken(eventId, fromUrl);
    tokenRef.current = token;
    // Before paint: veiled (pending) instead of flashing the password field
    // the invite Door is about to replace — or, when the server guessed
    // "pending" from the param and there is no usable token, un-veiled.
    setState(token ? { status: "pending" } : { status: "none" });
    // Mount only; `eventId` is fixed for a mount (the shell is keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An unmounted landing stops asking (the retry below waits a beat).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Then tell the App Router (see invite-url.ts for why this is a second,
  // passive step). The layout effect above has already run. Whenever the URL
  // was stripped — an empty `?invite=` included — not only when a token came
  // back: the router's URL must not keep the param either way.
  useEffect(
    () => (strippedRef.current ? syncRouterToCleanUrl() : undefined),
    [],
  );

  const onAccessVerdict = useCallback(
    (opened: boolean) => {
      const token = tokenRef.current;
      if (!token || verdictSeen.current) return;
      verdictSeen.current = true;
      if (opened) {
        // Already through: the link has nothing to do. Drop it unused.
        tokenRef.current = null;
        clearStashedInviteToken(eventId);
        setState({ status: "none" });
        return;
      }
      const settle = (outcome: PeekOutcome) => {
        if (outcome.kind === "live") {
          setState({
            status: "live",
            kind: outcome.inviteKind,
            inviteeShortName: outcome.inviteeShortName,
            organizerName: outcome.organizerName,
          });
        } else if (outcome.kind === "dead") {
          tokenRef.current = null;
          clearStashedInviteToken(eventId);
          setState({ status: "dead", from: "peek" });
        } else {
          // Asked twice, no answer. The plain gate, with no invite UI: the
          // board has no "couldn't check this link" state, and a Door shown
          // in place of the gate with a redeem that is likely down too would
          // leave the guest with no password field. The token is dropped
          // because nothing on this page can use it.
          //
          // Traced, kind only (no token, no URL): a peek route that hangs or
          // fails in prod would otherwise drop every invite silently.
          traceIgnoredError("event.invite.peek")(
            new Error(`invite peek unavailable after retry: ${outcome.why}`),
          );
          tokenRef.current = null;
          clearStashedInviteToken(eventId);
          setState({ status: "none" });
        }
      };
      void (async () => {
        let outcome = await peekInvite(eventId, token);
        if (outcome.kind === "unavailable") {
          // One blip must not lose a live invite (the URL is already clean,
          // so a reload cannot recover it): try once more.
          await new Promise((r) => setTimeout(r, PEEK_RETRY_DELAY_MS));
          if (!alive.current) return;
          outcome = await peekInvite(eventId, token);
        }
        if (alive.current) settle(outcome);
      })();
    },
    [eventId],
  );

  const open = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    const fail = (kind: InviteDoorError) =>
      setError((prev) => ({ kind, n: (prev?.n ?? 0) + 1 }));
    try {
      const outcome = await redeemInvite(eventId, token);
      if (outcome.kind === "dead") {
        tokenRef.current = null;
        clearStashedInviteToken(eventId);
        setState({ status: "dead", from: "redeem" });
        return;
      }
      if (outcome.kind === "rateLimited") {
        fail("rateLimited");
        return;
      }
      if (outcome.kind === "failed") {
        fail("generic");
        return;
      }
      // Redeemed: the grant cookie (or the account unlock) carries it now.
      // The ref keeps the token so a failed reveal can tap again.
      clearStashedInviteToken(eventId);
      // The flag the password gate sets on unlock: the reveal animates and
      // `EventDetail` hands focus to the event's headline.
      try {
        sessionStorage.setItem(`th-event-just-unlocked:${eventId}`, "1");
      } catch {
        // sessionStorage may be unavailable (private window quirks).
      }
      const opened = await revealRef.current();
      // Redeeming again is a no-op server-side, so the Door stays and retries.
      if (!opened) fail("generic");
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [eventId]);

  return { state, opening, error, onAccessVerdict, open };
}
