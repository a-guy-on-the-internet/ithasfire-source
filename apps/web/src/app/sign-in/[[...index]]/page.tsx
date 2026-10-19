"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import * as Sentry from "@sentry/nextjs";

import { StandaloneAuthPageShell } from "@/components/auth/StandaloneAuthPageShell";
import { signInErrorNotice } from "@/components/auth/sign-in-error-notice";
import type { StandaloneAuthSessionNotice } from "@/components/auth/StandaloneAuthPageShell";
import { authClient } from "@/lib/auth/auth-client";
import { readRedirectParam } from "@/lib/redirect";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

/**
 * How long to wait after kicking off the "already signed in → go to your
 * destination" redirect before we stop believing the navigation is in flight.
 *
 * A successful redirect navigates away and unmounts this component, so the
 * timer is cleared by the effect cleanup and never fires. Surviving it means
 * one of two things, and THE TIMER CANNOT TELL THEM APART:
 *   (a) the destination's middleware bounced us straight back here, or
 *   (b) the navigation is simply still running — the destination route is cold
 *       (first compile in dev, cold serverless instance in prod), the network
 *       is slow, or it's a heavy admin shell doing its own data fetching.
 *
 * Treating (b) as (a) is what made this a login-destroying bug: the page
 * signed the user out ~2.5s after a *successful* sign-in and told them their
 * session was stale. So the timeout no longer authorises anything
 * destructive — it only stops us rendering `null` (see `bounced` below), and
 * the actual stale-vs-slow question is answered by asking the server
 * (`useEffect` on `bounced`, further down).
 *
 * 9s rather than 2.5s: 2.5s is under a cold Next route compile in dev and
 * under a cold-start + render for a heavy authenticated page in prod, so it
 * fired constantly on the happy path. 9s sits above realistic cold-navigation
 * latency while still bounding how long a genuinely-wedged user stares at a
 * blank page before they get a usable form. It is a UX bound now, not a
 * correctness one — the server re-check is what protects the session — so
 * erring long is cheap and erring short is not.
 */
const BOUNCE_DETECT_MS = 9_000;

/**
 * What the server re-check OBSERVED. Deliberately named after the observation
 * rather than a conclusion, because one of these answers does not mean what it
 * looks like — see `noSessionReturned`.
 *
 *  - `checking`            — re-check in flight, or it failed at the transport
 *                            layer. We know nothing.
 *  - `sessionConfirmed`    — the server handed back a real user. This is the
 *                            one answer that IS conclusive: the session works.
 *  - `noSessionReturned`   — the server answered `200` with a `null` body. That
 *                            is NOT proof the session is gone; see below.
 */
type BounceVerdict = "checking" | "sessionConfirmed" | "noSessionReturned";

/**
 * Which explanation the user gets once the bounce is over.
 *
 * `sessionConfirmed` deliberately shows a notice too, and a DIFFERENT one. The
 * production incident this whole file exists for lands there every time: a
 * host-only cookie is sent browser→api host, so the re-check (same call, same
 * host) always confirms the session even though the page the user asked for
 * refused it. Treating `sessionConfirmed` as "nothing to explain" gave the one
 * user who actually hit the bug nine seconds of blank page followed by a bare
 * form. Saying "expired" there would be false — the session is fine, it just
 * isn't usable where they were going.
 */
const NOTICE_FOR_VERDICT: Record<BounceVerdict, StandaloneAuthSessionNotice> = {
  checking: "none",
  sessionConfirmed: "unverified",
  noSessionReturned: "expired",
};

/** Sentry tag for the two silent-swallow branches in the re-check. */
const BOUNCE_RECHECK_LABEL = "signIn.bounceRecheck";

const SignInPageContent = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = readRedirectParam(searchParams);
  // Set by the API when it refuses a sign-in (two-factor account on Google /
  // Apple, banned or inactive account). Unknown values map to "none". Read
  // from the same `useSearchParams` as the redirect, and this page renders
  // nothing before mount, so server and client never disagree about it.
  const errorNotice = signInErrorNotice(searchParams.get("error"));
  const { data: session, isPending } = authClient.useSession();
  const [hasMounted, setHasMounted] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  // BOUNCE latch. Once true it stays true for the life of this mount: the
  // auto-redirect is permanently disabled and we always render the form
  // (never `null`) — that, not the sign-out, is the anti-blank-page fix.
  //
  // The wedge it breaks: a client that HAS a valid session (its `/get-session`
  // call goes browser → api host and succeeds) while the SERVER cannot see it
  // (the middleware forwards the web origin's cookie header, which is missing
  // a host-only cookie bound to the api host). We then ping-pong forever —
  // `/sign-in` → `router.replace(dest)` → middleware 307 → `/sign-in`. Because
  // the bounce lands on the SAME route segment, React preserves this
  // component's state, so `redirecting` stays true and the page renders
  // `null`: a permanently blank page with no way out.
  //
  // Note the middleware only sends us to `/sign-in` when it sees NO session —
  // authorization failures go to `/access-denied` and a moderator missing a
  // second factor goes to `/enroll-2fa` (see
  // `apps/web/src/middleware/staff-route-gate.ts`). So a REAL bounce means
  // the server can't see/validate the session. What we cannot infer from the
  // timer alone is that a real bounce happened at all — see BOUNCE_DETECT_MS.
  const [bounced, setBounced] = useState(false);
  // Verdict of the server re-check that gates the destructive branch. Starts
  // `checking` and stays there unless the server answers definitively, so a
  // failed/hanging re-check can never sign anybody out.
  const [bounceVerdict, setBounceVerdict] = useState<BounceVerdict>("checking");
  // One retry of the navigation, ever. Guards against an effect re-run (or
  // React's dev-mode double-invoke) turning "retry once" into a replace loop.
  const navigationRetriedRef = useRef(false);
  // One Sentry event per mount, ever. The reporting effect re-runs on every
  // verdict change (and on a router-identity change), and a bounce that
  // reports N times is a bounce whose real frequency you can't read.
  const bounceReportedRef = useRef(false);
  // Latches once the FIRST session lookup settles. Better Auth refetches
  // /get-session on every `visibilitychange` → visible (tab/app switch), and
  // while signed out (`data === null`) that refetch flips `isPending` back to
  // true (see better-auth `useAuthQuery`'s onRequest:
  // `isPending: currentValue.data === null`). Gating the render on raw
  // `isPending` therefore unmounted the whole card whenever the user came
  // back from their password manager, wiping everything they'd typed. Only
  // the initial resolve should blank the page.
  const [sessionSettled, setSessionSettled] = useState(false);
  const awaitingFirstSession = isPending && !sessionSettled;

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!isPending) setSessionSettled(true);
  }, [isPending]);

  // The other way to end up permanently blank, and the one the bounce timer
  // does NOT cover: if the FIRST `/get-session` never settles — API down, cold
  // start past the fetch timeout, a hung request — then `isPending` stays
  // true, `session?.user` never appears, `redirecting` is never set, the
  // bounce timer is never armed, and the render below returns `null` forever.
  // Every guarantee in this file is downstream of a session lookup that
  // ANSWERS.
  //
  // So arm a deadline at mount instead of at redirect: after the same window,
  // stop waiting and show the form. This is purely a render gate — a signed-in
  // user whose lookup resolves late is still picked up by the redirect effect
  // above (it keys on `session`, not on this flag), so the cost of firing
  // early is a brief flash of a form, and the cost of not firing is a dead
  // page.
  useEffect(() => {
    const timer = setTimeout(() => setSessionSettled(true), BOUNCE_DETECT_MS);
    return () => clearTimeout(timer);
  }, []);

  // If the user is already signed in, bounce them to their intended
  // destination (or home). Mirrors the old server-side redirect.
  //
  // Guarded on `bounced` so a detected ping-pong can never re-arm the
  // redirect — otherwise setting `bounced` would just start the loop again.
  //
  // Also guarded on `redirecting`: a session refetch (or a fresh `router`
  // identity) re-runs this effect, and re-issuing `replace` for a navigation
  // already in flight is both pointless and noise in the bounce accounting.
  useEffect(() => {
    if (bounced || redirecting) return;
    if (isPending || !session?.user) return;
    setRedirecting(true);
    router.replace(redirectPath ?? "/");
  }, [bounced, isPending, redirecting, redirectPath, router, session]);

  // Bounce detection. Armed whenever we start redirecting; disarmed by the
  // cleanup when this component unmounts, which is exactly what a SUCCESSFUL
  // redirect does. Surviving the timeout means we are still sitting on
  // `/sign-in` — either because the navigation came back to us, or because it
  // has not finished yet. This effect deliberately does not decide which.
  //
  // A timer rather than a sessionStorage breadcrumb on purpose: the bounce
  // returns to the same route segment (state preserved, no remount), and a
  // storage key would need clearing on the success path — where we never get
  // to run again. The timer self-cancels instead.
  useEffect(() => {
    if (!redirecting) return;
    const timer = setTimeout(() => {
      setBounced(true);
      setRedirecting(false);
    }, BOUNCE_DETECT_MS);
    return () => clearTimeout(timer);
  }, [redirecting]);

  // ── Telemetry ──────────────────────────────────────────────────────────
  // Without this the fix is unfalsifiable in production: no way to know how
  // often the bounce fires, whether 9s is the right window, or whether the
  // API-side ghost-cookie clearing actually stopped it. It is reported as a
  // `captureMessage` rather than a log because `logger.warn` is not captured
  // (see the Sentry convention in CLAUDE.md).
  //
  // Reported exactly ONCE per mount, and tagged with the RESOLVED verdict
  // where possible, since "the server confirms this session but the page
  // refused it" (the ghost cookie) and "the server has no session" are
  // different incidents that would otherwise be indistinguishable in Sentry.
  // A re-check that never answers still reports, on its own deadline — the
  // hung case is the one most worth seeing.
  //
  // Strictly non-destructive, and wrapped: a Sentry failure (not initialised,
  // ad-blocked, SSR boundary) may not throw into render.
  useEffect(() => {
    if (!bounced || bounceReportedRef.current) return;

    const report = (verdict: BounceVerdict) => {
      if (bounceReportedRef.current) return;
      bounceReportedRef.current = true;
      try {
        Sentry.captureMessage("sign_in_bounce_detected", {
          level: "warning",
          tags: { bounceVerdict: verdict },
          extra: { hasRedirectTarget: Boolean(redirectPath) },
        });
      } catch {
        // Telemetry is never worth a broken sign-in page.
      }
    };

    if (bounceVerdict !== "checking") {
      report(bounceVerdict);
      return;
    }

    // Verdict still pending: give the re-check the same window, then report
    // the fact that it never answered.
    const timer = setTimeout(() => report("checking"), BOUNCE_DETECT_MS);
    return () => clearTimeout(timer);
  }, [bounced, bounceVerdict, redirectPath]);

  // ───────────────────────────────────────────────────────────────────────
  // INVARIANT: NO PATH IN THIS COMPONENT MAY DESTROY A SESSION.
  //
  // DO NOT re-add `authClient.signOut()` here. It was here twice and was
  // wrong both times, for two different reasons — and the second reason is
  // not fixable from the client:
  //
  //  1. It fired on a stopwatch. Surviving BOUNCE_DETECT_MS was read as "the
  //     redirect bounced", but it equally means "the navigation is still
  //     running". Users whose destination took longer than the timeout were
  //     signed out immediately after a CORRECT login and told their session
  //     was stale.
  //
  //  2. Re-checking the session first looks like it fixes (1). It does not,
  //     because a `200 + null` from `/get-session` does NOT mean "no
  //     session". Our API registers `customSession(...)`
  //     (`apps/api/src/auth/better-auth.ts`), and Better Auth spreads plugin
  //     endpoints AFTER the core ones under the same `getSession` key
  //     (`better-auth/dist/api/index.mjs`), so the plugin's handler is the
  //     one that serves `/get-session`. That handler does:
  //         const session = await getSession()({...}).catch(() => null);
  //         if (!session?.response) return ctx.json(null);
  //     while core `getSession` THROWS `INTERNAL_SERVER_ERROR` on any
  //     internal failure (`better-auth/dist/api/routes/session.mjs`). So a
  //     Neon/Prisma/pool blip is swallowed and surfaces to the client as an
  //     apparently-successful `{ data: null, error: null }` — byte-identical
  //     to a genuine "you are signed out".
  //
  //     The amplification makes this worse, not better: reaching `bounced` at
  //     all requires `useSession()` to have just returned a user, so a
  //     GENUINE revocation would have to land inside the ~9s window (rare),
  //     while an API blip inside that window is comparatively common. A
  //     sign-out gated on that signal is mostly a false-positive detector.
  //     (This repo has history here — see the Neon outage where caught errors
  //     never surfaced.)
  //
  // Nothing is lost by removing it. The sign-out's only job was clearing a
  // ghost cookie, and this component ALREADY declines to do that on the
  // `sessionConfirmed` path.
  //
  // Be precise about what does clear it, because it is not this page:
  // the API's after-hook (`apps/api/src/auth/better-auth.ts`) emits an extra
  // host-only `Max-Age=0` copy of the session cookie on every response that
  // ALREADY writes the session token — sign-out, password sign-in, passkey
  // verify, OAuth callback, magic-link verify, 2FA verify. That covers the
  // passkey-first flow this page actually leads with, which the earlier
  // client-side `signOut()` (password/username submit only, in `LoginCard`)
  // never did.
  //
  // Making the absence of a sign-out STRUCTURAL is the point: "no path can
  // destroy a valid session" becomes a property of this file, not a claim
  // about an endpoint contract we neither own nor can distinguish failures
  // from.
  // ───────────────────────────────────────────────────────────────────────
  //
  // The re-check that remains is non-destructive and exists only to decide
  // whether to show the stale-session notice, and whether to retry the
  // navigation. It goes to the same Better Auth endpoint `useSession` uses,
  // bypassing two caches so a positive answer reflects server state now
  // rather than a snapshot from before the redirect:
  //   - `disableCookieCache: true` makes the API skip Better Auth's signed
  //     session-cookie cache and read the session record itself.
  //   - `cache: "no-store"` keeps the browser's HTTP cache out of it.
  //
  // Outcomes:
  //   - a user comes back → `sessionConfirmed`. This is the only conclusive
  //     answer. Retry the navigation once (the destination may simply have
  //     been slow, or a transient failure may have bounced us). If the retry
  //     lands we unmount; if it doesn't, the user has a working page instead
  //     of a blank one — with the "couldn't verify your session for this page"
  //     notice, NOT the expiry copy: nothing expired, the session just isn't
  //     usable at the destination. This is the branch the real incident took
  //     (the ghost cookie is sent browser→api host, so the re-check always
  //     succeeds), which is why it may not be the silent one.
  //   - `200` with no user → `noSessionReturned`. Show the notice, because
  //     the most useful thing we can offer either way is a sign-in form with
  //     an explanation. Note this is the ambiguous answer: it covers both a
  //     genuinely-ended session and a degraded API. Showing a notice is safe
  //     under both readings; anything destructive is not.
  //   - transport-level failure / never answered → stay in `checking`. The
  //     form is already on screen.
  useEffect(() => {
    if (!bounced) return;
    let cancelled = false;

    const settle = async () => {
      let serverSession: { user?: unknown } | null | undefined;
      try {
        const result = await authClient.getSession({
          query: { disableCookieCache: true },
          fetchOptions: { cache: "no-store" },
        });
        // A transport/HTTP error tells us nothing about the session — but it
        // must not be invisible either. `.catch(() => {})` here is exactly the
        // shape that hid a four-day outage; `traceIgnoredError` keeps the
        // control flow and still reports.
        if (result?.error) {
          traceIgnoredError(BOUNCE_RECHECK_LABEL)(result.error);
          return;
        }
        // Be explicit about the shape rather than letting an unexpected
        // resolve value fall through and read as "no session".
        if (!result || !("data" in result)) {
          traceIgnoredError(BOUNCE_RECHECK_LABEL)(
            new Error("Unexpected getSession resolve shape"),
          );
          return;
        }
        serverSession = result.data ?? null;
      } catch (err) {
        traceIgnoredError(BOUNCE_RECHECK_LABEL)(err);
        return;
      }

      // Unmounted while the check was in flight: the navigation landed after
      // all, so there was never anything wrong with the session.
      if (cancelled) return;

      if (serverSession?.user) {
        setBounceVerdict("sessionConfirmed");
        if (!navigationRetriedRef.current) {
          navigationRetriedRef.current = true;
          // Deliberately does NOT set `redirecting` back to true: that flag
          // drives the `null` render, so re-setting it would blank the page
          // again and re-arm the very loop `bounced` exists to break.
          router.replace(redirectPath ?? "/");
        }
        return;
      }

      setBounceVerdict("noSessionReturned");
    };

    void settle();

    return () => {
      cancelled = true;
    };
  }, [bounced, redirectPath, router]);

  // Don't flash the sign-in form while checking session or redirecting.
  // Deliberately `awaitingFirstSession`, not `isPending` — see above.
  // Once `bounced`, nothing may blank the page again: that state exists
  // precisely because the user was stuck staring at `null`. Note this does NOT
  // wait on `bounceVerdict` — a re-check that hangs must not re-introduce the
  // blank page, so we render the form immediately and let the notice appear
  // only once the server has actually answered.
  if (!bounced && (!hasMounted || awaitingFirstSession || redirecting)) {
    return null;
  }

  return (
    <StandaloneAuthPageShell
      initialPanel="sign-in"
      showReturnHomeAction
      sessionNotice={
        bounced && bounceVerdict !== "checking"
          ? NOTICE_FOR_VERDICT[bounceVerdict]
          : errorNotice
      }
    />
  );
};

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInPageContent />
    </Suspense>
  );
}
