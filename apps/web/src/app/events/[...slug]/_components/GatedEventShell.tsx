"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import superjson from "superjson";
import { Spinner, Text, useTranslations } from "@th/ui";

import type { EventPageData } from "@/server/event-page-data";
import type { PublicApplicationFormSeed } from "@/server/events";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { trpc } from "@/trpc";
import { EventApplicationGateWrapper } from "./EventApplicationGateWrapper";
import { EventPageBody } from "./EventPageBody";
import { EventPasswordGateWrapper } from "./EventPasswordGateWrapper";
import { InviteDeadNotice, InviteDoor } from "./InviteDoor";
import { useInviteLink } from "./invite-link";

export type GatedEventShellProps = {
  eventId: string;
  slug: string;
  /** From the gated PREVIEW endpoint — title + hero are all a gated page may show. */
  title: string;
  heroImageUrl: string | null;
  /**
   * The date the gate shows, the event's local day as `YYYY-MM-DD` (`null` =
   * no date to show). From the same PREVIEW endpoint: a gate says WHEN, never
   * WHERE, so neither the instant nor the zone is sent.
   */
  gateDate: string | null;
  /** Event-intrinsic. `NONE` never reaches this component. */
  gateType: "PASSWORD" | "APPLICATION";
  waitlistOpen: boolean;
  waitlistDescription: string | null;
  /**
   * The request carried a non-empty `?invite=` (presence only, never the
   * value; page.tsx). The `?invite=` variant is served `private, no-store`
   * (next.config.ts), so this boolean never reaches a shared cache. Starts
   * the shell veiled so the plain gate does not flash while it hydrates.
   */
  inviteParamPresent?: boolean;
  /**
   * An APPLICATION gate's public form definition, read on the server so the
   * form is the first paint (page.tsx). Event-level, never viewer-specific.
   * Null/omitted: the gate fetches it after paint.
   */
  applicationFormSeed?: PublicApplicationFormSeed | null;
};

type AccessResponse =
  /**
   * `removedByInviteReset`: only for a viewer whose OWN access was removed
   * when the organiser reset the shared invite link with "Remove them too".
   * Every other locked answer is bare.
   */
  | { access: "locked"; removedByInviteReset?: boolean }
  | { access: "unlocked"; data: ReturnType<typeof superjson.serialize> };

/**
 * On <html> for the length of the unlock reveal. `password-door.css` only
 * hands out the shared `view-transition-name`s under it, so they never leak
 * into the page-level React <ViewTransition> (PageTransition.tsx).
 */
const REVEALING_CLASS = "th-door-revealing";
/** The longest the reveal holds the old frame waiting for the poster to decode. */
const POSTER_WAIT_MS = 600;

/**
 * The flag `EventPasswordGateWrapper` (accepted password) and
 * `EventApplicationGateWrapper` (`handleViewEvent`) set in this tab right
 * before they call `onUnlocked`. `EventDetail` clears it once the event is
 * revealed; the shell clears it when the probe that follows does not open the
 * event (`forgetJustUnlocked`).
 */
function justUnlockedHere(eventId: string): boolean {
  try {
    return sessionStorage.getItem(`th-event-just-unlocked:${eventId}`) === "1";
  } catch {
    return false;
  }
}

/**
 * Drop the flag when an unlock-triggered probe did not open the event.
 * `EventDetail` is the only other place that clears it and it never mounts for
 * a locked verdict, so a stale flag would make a LATER reveal in this tab (a
 * return visit after the cookie is granted) animate and steal focus.
 */
function forgetJustUnlocked(eventId: string): void {
  try {
    sessionStorage.removeItem(`th-event-just-unlocked:${eventId}`);
  } catch {
    // sessionStorage can throw (privacy modes); nothing to clear then.
  }
}

/** Resolve once the event page's poster can paint, or after a short cap. */
async function posterReady(): Promise<void> {
  const img = document.querySelector<HTMLImageElement>(
    '[data-gate-reveal="poster"]',
  );
  if (!img || (img.complete && img.naturalWidth > 0)) return;
  await Promise.race([
    img.decode().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, POSTER_WAIT_MS)),
  ]);
}

/**
 * Apply the reveal, as the Door's one orchestrated moment when it is earned.
 *
 * Animated ONLY right after an unlock in this tab (the wrapper's
 * sessionStorage flag; `EventDetail` consumes it after this read): a returning
 * visitor who is already through gets the instant swap, never a Door that
 * flashes and then plays an unlock they did not just perform. Reduced motion
 * and browsers without View Transitions get the instant swap too.
 *
 * Deliberately the browser API with `flushSync`, NOT React's `startTransition`:
 * a transition would also fire the page-level `<ViewTransition>` boundary
 * (`th-page` fade), which replays on Suspense reveals (PageTransition.tsx).
 * A sync update inside `document.startViewTransition` animates only the
 * elements `password-door.css` names.
 */
function revealWithTransition(eventId: string, apply: () => void): void {
  const canAnimate =
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    justUnlockedHere(eventId) &&
    !(
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  if (!canAnimate) {
    apply();
    return;
  }
  const root = document.documentElement;
  const doc = document as ReactViewTransitionDocument;
  root.classList.add(REVEALING_CLASS);
  try {
    const transition = document.startViewTransition(async () => {
      flushSync(apply);
      await posterReady();
    });
    // Starting a view transition SKIPS any running one, and the event page's
    // first commits include transition-lane updates from libraries, which
    // React's page boundary (PageTransition.tsx) turns into a `th-page` fade.
    // MEASURED: one landed mid-reveal and the browser skipped the Door's
    // transition outright ("Transition was skipped"). React serialises its
    // own view transitions through `document.__reactViewTransition` — a
    // transition-eligible commit waits on that transition's `finished` — so
    // the reveal registers there and React's fade waits its turn. Only
    // claimed when free; released only if still ours. If React ever drops the
    // field, this degrades to the race above, never to a broken page.
    const claimed = doc.__reactViewTransition == null;
    if (claimed) doc.__reactViewTransition = transition;
    const done = () => {
      if (claimed && doc.__reactViewTransition === transition) {
        doc.__reactViewTransition = null;
      }
      root.classList.remove(REVEALING_CLASS);
    };
    // A skipped transition (hidden tab, a duplicate name) rejects `ready`;
    // the DOM update itself still runs. Never an unhandled rejection.
    transition.ready.catch(() => undefined);
    transition.updateCallbackDone.catch(() => undefined);
    transition.finished.then(done, done);
  } catch {
    root.classList.remove(REVEALING_CLASS);
    apply();
  }
}

/** React's (internal) handle on the view transition it is running. */
type ReactViewTransitionDocument = Document & {
  __reactViewTransition?: ViewTransition | null;
};

/**
 * The whole client half of the gated event page.
 *
 * A gated event's document is edge-cached with no `Cookie` in its `Vary`, so
 * the server renders the gate wall and only the gate wall — the same bytes for
 * an organizer, an unlocked attendee and a stranger. This component asks "is
 * THIS viewer through the gate?" after first paint, against
 * `POST /api/events/[eventId]/unlocked-view` (uncacheable, same-origin so the
 * HttpOnly `th_eu_` / `th_ea_` gate cookies ride along), and swaps in the real page when
 * the answer is yes.
 *
 * The gated content is never in the SSR bytes — not hidden, not in a prop, not
 * in the RSC payload. It is fetched here or not at all.
 *
 * Hydration: the first client render must match the server's, so `revealed`
 * starts null and `checking` starts false. The probe is kicked off in an effect.
 */
export function GatedEventShell({
  eventId,
  slug,
  title,
  heroImageUrl,
  gateDate,
  gateType,
  waitlistOpen,
  waitlistDescription,
  inviteParamPresent = false,
  applicationFormSeed = null,
}: GatedEventShellProps) {
  const t = useTranslations();
  // The unlock is in-page (no reload), so the query cache outlives it.
  const utils = trpc.useUtils();
  const utilsRef = useRef(utils);
  utilsRef.current = utils;
  /**
   * TAGGED with the event it was fetched for, and never read without checking
   * that tag (see `revealed` below).
   *
   * App Router does not key a segment by its dynamic params, so a soft nav
   * between two gated events RECONCILES this component in place instead of
   * remounting it — the same mechanism called out on
   * `EventApplicationGateWrapper.onUnlocked`, one level up. Plain
   * `EventPageData | null` state would therefore keep rendering event A's body
   * under event B's URL: the `eventId` prop changes and the probe refires, but
   * the early return wins the very next render, and a subsequent `locked`
   * verdict never re-walls because nothing clears it.
   *
   * The caller passes `key={eventId}` (page.tsx) so this cannot happen from the
   * only route that mounts the shell. The tag is the belt for a future caller
   * who forgets: it is checked during RENDER, so there is not even a
   * single-frame window in which the wrong event's body is on screen.
   */
  const [revealedFor, setRevealedFor] = useState<{
    eventId: string;
    data: EventPageData;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  // The password was just accepted and the probe is fetching the event: the
  // Door keeps its own checking state instead of the generic veil.
  const [revealing, setRevealing] = useState(false);
  // StrictMode double-invokes effects in dev, so probes are de-duplicated. The
  // queue flag is not cosmetic: a viewer can submit the password WHILE the mount
  // probe is still in flight, and dropping that second call would strand them on
  // the gate holding a valid unlock cookie.
  const probeRunning = useRef(false);
  const probeQueued = useRef(false);
  // Callers that arrived while a probe was in flight wait on the QUEUED probe's
  // verdict (not an instant `false`), so `revealing` outlives the whole queue.
  // Each waiter is tagged with the event it asked about, so a late call from a
  // previous event can never be answered with this event's verdict.
  const queuedResolvers = useRef<
    Array<{ eventId: string; resolve: (opened: boolean) => void }>
  >([]);
  // The event this shell currently shows; async continuations check it.
  const currentEventId = useRef(eventId);
  currentEventId.current = eventId;
  // Bumped each time an accepted password is followed by a probe that does not
  // open the event; the Door turns each bump into one visible message.
  const [unlockFailures, setUnlockFailures] = useState(0);
  // The event whose latest locked verdict said this viewer was let in by the
  // shared invite link and removed when the organiser reset it. Tagged like
  // `revealedFor`, so it never carries over to another event. Every locked
  // verdict rewrites it; any way in (password, approval, a new invite)
  // clears it before its probe runs.
  const [removedByResetFor, setRemovedByResetFor] = useState<string | null>(
    null,
  );
  const removedByReset = removedByResetFor === eventId;

  // Only ever the CURRENT event's payload. An in-flight probe for the previous
  // event that lands after the prop changed is rejected here too.
  const revealed = revealedFor?.eventId === eventId ? revealedFor.data : null;
  // The event an unlocked verdict was handed to `revealWithTransition` for,
  // set BEFORE the state lands. On the animated path the state update runs
  // inside the transition's async callback, after the probe's `finally` has
  // already cleared `checking`; without this the drain below saw no reveal,
  // fired a second probe, and its transition skipped the first one.
  const revealingFor = useRef<string | null>(null);

  /** Resolves `true` when this call revealed the event. */
  const probeAccess = useCallback(async (): Promise<boolean> => {
    if (probeRunning.current) {
      probeQueued.current = true;
      return new Promise<boolean>((resolve) => {
        queuedResolvers.current.push({ eventId, resolve });
      });
    }
    probeRunning.current = true;
    setChecking(true);
    try {
      const res = await fetch(`/api/events/${eventId}/unlocked-view`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        // 4xx/5xx from our own endpoint. Fail CLOSED but make it visible: a
        // systematically broken probe walls every legitimate viewer out, and
        // from the outside that looks like "the password stopped working".
        traceIgnoredError("event.gate.accessProbe")(
          new Error(`unlocked-view responded ${res.status}`),
        );
        return false;
      }
      const body = (await res.json()) as AccessResponse;
      if (body.access !== "unlocked") {
        // A late answer for an event this shell has moved off changes
        // nothing: it must neither clear nor replace the CURRENT event's
        // flag. Functional, so it only ever touches this event's own value.
        if (currentEventId.current === eventId) {
          setRemovedByResetFor((prev) =>
            body.removedByInviteReset === true
              ? eventId
              : prev === eventId
                ? null
                : prev,
          );
        }
        return false;
      }
      const next = {
        eventId,
        data: superjson.deserialize(body.data) as EventPageData,
      };
      revealingFor.current = eventId;
      revealWithTransition(eventId, () => setRevealedFor(next));
      // A card hover fetched while this viewer was still gated cached
      // `{ tiers: [] }` (staleTime 2 min); drop it so the grid re-asks.
      // Outside the fail-closed path: a throw here must not undo the reveal.
      try {
        void utilsRef.current.events.ticketTiersForCard
          .invalidate({ eventId })
          .catch(traceIgnoredError("event.gate.invalidateCardTiers"));
      } catch (e) {
        traceIgnoredError("event.gate.invalidateCardTiers")(e);
      }
      return true;
    } catch (err) {
      // Network/parse failure — same fail-closed treatment.
      traceIgnoredError("event.gate.accessProbe")(err);
      return false;
    } finally {
      probeRunning.current = false;
      setChecking(false);
    }
  }, [eventId]);

  // Drop the previous event's payload (and any probe queued against it) the
  // moment the prop changes. The render-time tag above already prevents the
  // stale body from being SHOWN; this stops it from being retained, and stops a
  // queued probe from draining against the wrong event.
  useEffect(() => {
    setRevealedFor(null);
    setRemovedByResetFor(null);
    revealingFor.current = null;
    probeQueued.current = false;
    // On an event change AND on unmount: nothing will run for the event the
    // waiters asked about, so release them rather than leave them pending.
    return () => {
      probeQueued.current = false;
      const stranded = queuedResolvers.current;
      queuedResolvers.current = [];
      for (const waiter of stranded) waiter.resolve(false);
    };
  }, [eventId]);

  // After a successful invite redeem: the password gate's unlock path, but
  // the Door says the failure itself (`useInviteLink` → `error`), so no
  // `unlockFailures` bump that a later password Door would print on mount.
  const onInviteRedeemed = useCallback(async (): Promise<boolean> => {
    const askedFor = eventId;
    setRemovedByResetFor(null);
    setRevealing(true);
    const opened = await probeAccess();
    if (!opened) forgetJustUnlocked(askedFor);
    if (!opened && currentEventId.current === askedFor) setRevealing(false);
    return opened;
  }, [probeAccess, eventId]);

  // `?invite=<token>`: strips the token in a LAYOUT effect, i.e. before the
  // probe below fetches anything, then waits on that probe's verdict.
  const invite = useInviteLink(eventId, onInviteRedeemed, inviteParamPresent);
  const onInviteVerdict = invite.onAccessVerdict;

  useEffect(() => {
    void probeAccess().then(onInviteVerdict);
  }, [probeAccess, onInviteVerdict]);

  // Drain a probe that arrived while another was in flight (see `probeQueued`).
  useEffect(() => {
    if (checking || !probeQueued.current) return;
    probeQueued.current = false;
    const all = queuedResolvers.current;
    queuedResolvers.current = [];
    // A waiter from another event gets `false`: this probe says nothing about it.
    const waiters = all.filter((w) => w.eventId === eventId);
    for (const stale of all) if (stale.eventId !== eventId) stale.resolve(false);
    if (revealed || revealingFor.current === eventId) {
      for (const waiter of waiters) waiter.resolve(true);
      return;
    }
    void probeAccess().then((opened) => {
      for (const waiter of waiters) waiter.resolve(opened);
    });
  }, [checking, revealed, probeAccess, eventId]);

  // The password gate's unlock: hold the Door in its checking state through
  // the probe. Left set on success — the Door is about to swap out, and the
  // reveal's first frame should still show it checking.
  const onPasswordUnlocked = useCallback(() => {
    const askedFor = eventId;
    setRemovedByResetFor(null);
    setRevealing(true);
    void probeAccess().then((opened) => {
      // Before the stale-event check: the flag is keyed per event, so clearing
      // the ASKED event's key is right even if the shell has moved on.
      if (!opened) forgetJustUnlocked(askedFor);
      // A late answer for an event this shell no longer shows changes nothing.
      if (currentEventId.current !== askedFor) return;
      if (!opened) {
        setRevealing(false);
        // The server accepted the password, yet the event did not open: say so
        // instead of leaving the Door idle and silent.
        setUnlockFailures((n) => n + 1);
      }
    });
  }, [probeAccess, eventId]);

  // The application gate's unlock (an approved applicant opening the event).
  // Same flag hygiene as the password path. The gate reads the verdict:
  // `false` makes "View event" say so instead of doing nothing.
  const onApplicationUnlocked = useCallback(async (): Promise<boolean> => {
    const askedFor = eventId;
    setRemovedByResetFor(null);
    const opened = await probeAccess();
    if (!opened) forgetJustUnlocked(askedFor);
    return opened;
  }, [probeAccess, eventId]);

  // The veil is `inert` while an invite is pending, so the password field's
  // own autofocus fired into nothing. When the landing falls back to the
  // plain gate (pending → none: give-up, an empty or unusable token) or
  // the peek finds the link dead (pending → dead), hand that focus back,
  // unless the guest has put focus somewhere themselves. The dead line is a
  // live region, so it is still announced; it takes focus only when nothing
  // has it, and this runs first.
  // The application gate autofocuses nothing on mount, so neither does this.
  const veilRef = useRef<HTMLDivElement | null>(null);
  const prevInviteStatus = useRef(invite.state.status);
  useEffect(() => {
    const was = prevInviteStatus.current;
    prevInviteStatus.current = invite.state.status;
    if (was !== "pending") return;
    if (invite.state.status !== "none" && invite.state.status !== "dead") return;
    if (gateType !== "PASSWORD") return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    veilRef.current
      ?.querySelector<HTMLInputElement>("input")
      ?.focus({ preventScroll: true });
  }, [invite.state.status, gateType]);

  if (revealed) {
    return <EventPageBody data={revealed} />;
  }

  // The generic veil is for the mount probe (and, on an invite link, the
  // peek after it); after an unlock the Door says it.
  const veiled =
    (checking && !revealing) || invite.state.status === "pending";

  // One line at most. An invite landing in progress wins (the Door, or the
  // dead line for THAT link); the reset line shows only with no landing.
  // Same focus rule as the peek's dead line: never pulled out of a field.
  const deadNotice = (surface: "door" | "paper") =>
    invite.state.status === "dead" ? (
      <InviteDeadNotice
        key="dead"
        gateType={gateType}
        surface={surface}
        takeFocus={invite.state.from === "redeem"}
      />
    ) : invite.state.status === "none" && removedByReset ? (
      <InviteDeadNotice
        key="removed"
        gateType={gateType}
        surface={surface}
        reason="removed"
      />
    ) : undefined;

  const gate =
    gateType === "PASSWORD" ? (
      <EventPasswordGateWrapper
        // Keyed by event: challenge mode, a Turnstile token and the typed
        // password all belong to ONE event and must not carry over when the
        // shell is reused for another without a remount.
        key={eventId}
        eventId={eventId}
        slug={slug}
        title={title}
        heroImageUrl={heroImageUrl}
        gateDate={gateDate}
        waitlistOpen={waitlistOpen}
        waitlistDescription={waitlistDescription}
        // Replaces the old `router.refresh()`: refreshing would refetch the
        // SAME edge-cached RSC payload, i.e. the gate again.
        onUnlocked={onPasswordUnlocked}
        revealing={revealing}
        unlockFailures={unlockFailures}
        notice={deadNotice("door")}
      />
    ) : (
      <EventApplicationGateWrapper
        eventId={eventId}
        slug={slug}
        title={title}
        heroImageUrl={heroImageUrl}
        waitlistOpen={waitlistOpen}
        waitlistDescription={waitlistDescription}
        onUnlocked={onApplicationUnlocked}
        notice={deadNotice("paper")}
        formSeed={applicationFormSeed}
      />
    );

  if (invite.state.status === "live") {
    // In place of the password or application gate: one tap opens the event.
    return (
      <InviteDoor
        title={title}
        heroImageUrl={heroImageUrl}
        gateDate={gateDate}
        kind={invite.state.kind}
        inviteeShortName={invite.state.inviteeShortName}
        organizerName={invite.state.organizerName}
        busy={invite.opening || revealing}
        error={invite.error}
        onOpen={() => void invite.open()}
      />
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {/*
        The gate stays mounted and in place while the probe runs — dimmed and
        inert rather than replaced, so nothing moves and a viewer who IS locked
        (the common case) sees no swap at all, just a brief veil.
      */}
      <div
        ref={veilRef}
        aria-busy={checking || undefined}
        // While an invite is being checked the gate underneath is about to be
        // replaced: not focusable, not reachable (the password field's
        // autofocus included), not only dimmed.
        inert={invite.state.status === "pending" || undefined}
        style={{
          transition: "opacity 120ms ease-out",
          ...(veiled ? { opacity: 0.5, pointerEvents: "none" } : {}),
        }}
      >
        {gate}
      </div>
      {veiled ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          {/*
            An OPAQUE chip, not a bare spinner floating over the dimmed card:
            centred on the container, the label lands exactly on the card's own
            copy and the two smear together. Square corners + 2px ink border to
            match the gate card it sits on.
          */}
          <div
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.625rem",
              padding: "0.625rem 1rem",
              backgroundColor: "var(--surface, #FDFAF3)",
              border: "2px solid var(--borderColor, #211C16)",
              color: "var(--color, #211C16)",
            }}
          >
            <Spinner size="sm" />
            <Text fontSize={14}>{String(t("eventDetail.pwChecking"))}</Text>
          </div>
        </div>
      ) : null}
    </div>
  );
}
