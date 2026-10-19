"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth/auth-client";

/**
 * How long the hook keeps answering "not yet known" after the FIRST settled
 * lookup that found nobody, so the one re-check below has a window to land.
 *
 * A BACKSTOP, not the normal path: the window normally closes as soon as the
 * re-check answers (see `recheckRequestSeenRef`), so this only bites when the
 * refetch never starts or never flips `isPending`. A slow re-check still keeps
 * the verdict unknown PAST the deadline rather than racing it — the verdict
 * needs `settled` too, and Better Auth holds `isPending` true for the duration
 * of a refetch while `data === null`.
 */
export const SESSION_RECHECK_DELAY_MS = 1_000;

/**
 * - `"signedIn"` — a user has been observed. Render the account surface.
 * - `"signedOut"` — two settled lookups agree nobody is here. Say so.
 * - `"unknown"` — do not conclude anything yet. Render the loading state.
 */
export type SessionVerdict = "unknown" | "signedIn" | "signedOut";

type SessionQuery = ReturnType<typeof authClient.useSession>;
type SessionUser = NonNullable<SessionQuery["data"]>["user"];

export type SessionVerdictResult = {
  verdict: SessionVerdict;
  /**
   * The last user actually observed, held across a transient null. `undefined`
   * whenever the verdict is not `"signedIn"`.
   */
  user: SessionUser | undefined;
  /** True while the verdict is unknown BECAUSE the one re-check is outstanding. */
  isRechecking: boolean;
  /**
   * Call this from a sign-out handler. It is the ONLY thing that takes a
   * signed-in verdict away — see the latch note below.
   */
  markSignedOut: () => void;
  /** The raw Better Auth session, for callers that need `refetch` or `error`. */
  session: SessionQuery;
};

/**
 * A three-way read of the Better Auth session that will not call somebody
 * signed out on the strength of one answer.
 *
 * ## The bug this exists for
 *
 * Better Auth's `useAuthQuery` sets `isPending: currentValue.data === null` on
 * request (see `better-auth/dist/client/query.mjs`), so `isPending === false`
 * with `data === null` covers two completely different situations: a
 * `/get-session` that answered "nobody", and a `/get-session` that answered
 * "nobody" because it went out before the freshly-set cookie was readable.
 * Reading that single settled null as a verdict is how `/account/settings`
 * greeted a user who had just typed their password with a full "NOT SIGNED IN"
 * page whose only call to action was to sign in again. Nothing re-checked:
 * Better Auth refetches on `visibilitychange`, so sitting still stayed stuck.
 *
 * ## What this adds over reading `isPending` / `data` inline
 *
 * 1. **One bounded re-check before concluding signed-out.** The first settled
 *    lookup with no user fires exactly one refetch. The window closes when
 *    that refetch answers, or after `SESSION_RECHECK_DELAY_MS`, whichever
 *    comes first — the timer is the backstop for a refetch that never starts.
 *    Latched on a ref so React's dev-mode double-invoke cannot make it two,
 *    and the deadline lives in state so the double-invoke's teardown cannot
 *    cancel it either. If the re-check also finds nobody, signed-out is the
 *    honest answer and the caller renders it.
 * 2. **Signed-in latches.** Once a user has been observed, a later null — a
 *    refetch racing a cookie, a broadcast from another tab, a dropped
 *    request — does not downgrade the page. Two things clear the latch:
 *    `markSignedOut()`, which a sign-out handler calls, and an unmount (every
 *    sign-out path here navigates away). A live user always outranks the flag,
 *    so signing back in without a remount still works.
 * 3. **An error is not a verdict.** A failed lookup reads as `"unknown"`, never
 *    as signed-out, matching how the settings surface already treats an
 *    undefined summary as "still unknown".
 *
 * This is page CHROME only. The API remains the authorization boundary, and the
 * latch only ever holds a state a real `/get-session` already granted — no
 * privileged data is rendered on an optimistic guess.
 *
 * 4. **It gates on hydration itself.** The verdict is `"unknown"` on the server
 *    and on the first client render, so a surface whose markup forks on the
 *    session is hydration-safe without doing anything. See the gate's own note
 *    below for the three routes that proved this cannot be left to callers.
 */
export function useSessionVerdict(): SessionVerdictResult {
  const session = authClient.useSession();
  const liveUser = session.data?.user ?? undefined;
  const settled = !session.isPending;
  // `error` is part of the atom's shape in better-auth 1.6.9 (`{ data, error,
  // isPending, isRefetching, refetch }`), but read defensively: a mocked client
  // in a test, or a future version, may not carry it.
  const hasError = (session as { error?: unknown }).error != null;
  const refetch = (session as { refetch?: () => unknown }).refetch;

  /**
   * Last user a real lookup returned. The latch.
   *
   * A REF, written during render, not state. Better Auth hands back a fresh
   * `data` object on every fetch, and some callers (and every test mock that
   * returns a literal) hand back a fresh one on every RENDER — so latching this
   * with `useState` inside an effect keyed on the user's identity is an
   * infinite render loop: new object → effect → setState → render → new object.
   * Verified by `PageEditorView.test.tsx` hanging before a single test ran.
   *
   * Writing it in render is safe here: the value is a pure cache of something a
   * `/get-session` already reported, the write is idempotent under React's
   * double-render, and it is only ever READ as a fallback for a live user.
   */
  const seenUserRef = useRef<SessionUser | undefined>(undefined);
  const [deliberatelySignedOut, setDeliberatelySignedOut] = useState(false);
  /** Non-null once the re-check has been fired; the value is unused. */
  const [recheckArmedAt, setRecheckArmedAt] = useState<number | null>(null);
  const [recheckElapsed, setRecheckElapsed] = useState(false);
  /**
   * The once-only guard. A ref, not state: refs survive React's dev-mode
   * effect double-invoke, which is exactly the loop this has to not become.
   */
  const recheckFiredRef = useRef(false);

  if (liveUser && !deliberatelySignedOut) seenUserRef.current = liveUser;

  // A fresh sign-in in the same mount clears a previous deliberate sign-out.
  // Keyed on a BOOLEAN, never on the user's object identity — see the ref note.
  const hasLiveUser = Boolean(liveUser);
  useEffect(() => {
    if (hasLiveUser) setDeliberatelySignedOut(false);
  }, [hasLiveUser]);

  // Decide to re-check — at most once for the life of this hook.
  //
  // Keyed on whether a user is LIVE, not on the latched one: a null arriving
  // after a user was seen also earns the quiet re-verify, it just cannot move
  // the verdict either way.
  useEffect(() => {
    if (recheckFiredRef.current) return;
    if (deliberatelySignedOut) return;
    if (!settled || hasLiveUser) return;
    recheckFiredRef.current = true;
    setRecheckArmedAt(Date.now());
    try {
      void refetch?.();
    } catch {
      // A refetch that refuses to start is not a verdict either — the deadline
      // below still runs, and a lookup that never answers stays "unknown".
    }
  }, [deliberatelySignedOut, hasLiveUser, refetch, settled]);

  // Close the window the moment the re-check ANSWERS, rather than sitting out
  // the full delay. Better Auth flips `isPending` back to true for the
  // duration of a refetch while `data === null`, so a false→true→false round
  // trip after arming IS the re-check completing.
  //
  // This matters because the window is not free: the navbar renders on every
  // page, and a signed-out visitor should not wait a fixed second to be told
  // where the sign-in button is. The timer below stays as the backstop for a
  // refetch that never starts or never flips `isPending`.
  const recheckRequestSeenRef = useRef(false);
  useEffect(() => {
    if (recheckArmedAt === null || recheckElapsed) return;
    if (!settled) {
      recheckRequestSeenRef.current = true;
      return;
    }
    if (recheckRequestSeenRef.current) setRecheckElapsed(true);
  }, [recheckArmedAt, recheckElapsed, settled]);

  // The deadline. Keyed on `recheckArmedAt` so a torn-down-and-re-run effect
  // re-arms the timer instead of silently dropping it.
  useEffect(() => {
    if (recheckArmedAt === null || recheckElapsed) return;
    const id = window.setTimeout(
      () => setRecheckElapsed(true),
      SESSION_RECHECK_DELAY_MS,
    );
    return () => window.clearTimeout(id);
  }, [recheckArmedAt, recheckElapsed]);

  const markSignedOut = useCallback(() => {
    seenUserRef.current = undefined;
    setDeliberatelySignedOut(true);
  }, []);

  // A LIVE user outranks the deliberate-sign-out flag: if `/get-session` says
  // somebody is here right now, somebody is here. The flag only suppresses the
  // latch, which is the thing that would otherwise outlive the sign-out.
  const resolvedUser =
    liveUser ?? (deliberatelySignedOut ? undefined : seenUserRef.current);

  /**
   * Hydration gate, held INSIDE the hook rather than asked of every caller.
   *
   * The server can only ever render `"unknown"` (auth is client-side), so the
   * first client render has to produce `"unknown"` too or React throws the
   * tree away. This used to be the caller's job — and three of the five
   * callers did not do it, which cost three routes a real hydration failure
   * ("the server rendered HTML didn't match the client" on `/account`,
   * `/account/memberships` and `/account/credits`: the server painted the
   * spinner, the client painted the content). MEASURED in a browser, not
   * reasoned.
   *
   * A hook whose contract is "remember to add a mount latch or your page
   * breaks" is a footgun; it does the latch itself now. `user` is withheld
   * alongside the verdict so markup cannot fork on it either.
   *
   * Callers keeping their own gate (`SettingsSurface`, `AppNavbar`) are now
   * redundant, not wrong — leave them; two latches agree by construction.
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const user = hydrated ? resolvedUser : undefined;

  const verdict: SessionVerdict = !hydrated
    ? "unknown"
    : user
      ? "signedIn"
      : deliberatelySignedOut
        ? "signedOut"
        : !settled || hasError || !recheckElapsed
          ? "unknown"
          : "signedOut";

  return {
    verdict,
    user,
    // "Still unknown, and it is the re-check we are waiting on" — not merely
    // "a refetch is armed", which stays true after the verdict has landed.
    isRechecking:
      verdict === "unknown" && recheckArmedAt !== null && !recheckElapsed,
    markSignedOut,
    session,
  };
}
