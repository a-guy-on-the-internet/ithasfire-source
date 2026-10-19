"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useDoorTop } from "@/app/events/[...slug]/_components/PasswordDoor";
import {
  clearStashedInviteToken,
  readStashedInviteToken,
  stashInviteToken,
  stripInviteParam,
  syncRouterToCleanUrl,
} from "@/app/events/[...slug]/_components/invite-url";

import "@/app/events/[...slug]/_components/password-door.css";
import "@/app/events/[...slug]/_components/invite-door.css";
import "./invite-stop.css";

/**
 * "Stop invites from this organiser" (`/invites/stop?token=<opt-out token>`),
 * the page the invite email's footer link opens. Design: invite opt-out board,
 * owner ruling 2026-10-06 (the invite Door with no photo: kicker, title,
 * lede, one button, message strip). "Stop invites from every organiser"
 * (owner ruling 3(b) 2026-10-06; board option A, owner pick 2026-10-07) is
 * the smaller second choice: one mono line under the button, and under the
 * lede once this organiser is stopped. When the organiser has left, it is
 * the page's only button.
 *
 * Security (review W4):
 *  - Opening the page changes NOTHING: mail scanners open links. The mount
 *    only calls the read-only `peekInviteOptOut`; a tap is the one thing
 *    that calls `stopOrganiserInvites` or `stopAllInvites`.
 *  - The token leaves the address bar in a LAYOUT effect, before any other
 *    effect (analytics, the last-visited tracker) reads `location`, and lives
 *    on in a ref, plus a sessionStorage copy (the invite Door's stash, key
 *    `th:invite:stop`) so a reload before the tap still asks. The copy goes
 *    once the answer is final (every organiser stopped, or invalid) and when
 *    the page unmounts. While "stop every organiser" is still on offer the
 *    copy stays, so a reload can still offer it.
 *    Same-tab and never sent anywhere; the `th:invite:` prefix also keeps
 *    the analytics guard off while it is held.
 *  - No third-party script loads on this route (`analytics-excluded-paths`).
 */

/** Stands in for the link inside a translated sentence (see `withLink`). */
const LINK_SLOT = "@@link@@";

/** The text before and after a sentence's `{link}` slot (all before if none). */
function splitAtLink(text: string): [string, string] {
  const at = text.indexOf(LINK_SLOT);
  if (at < 0) return [text, ""];
  return [text.slice(0, at), text.slice(at + LINK_SLOT.length)];
}

/** Splits a sentence at its `{link}` slot and puts `link` there. */
function withLink(text: string, link: ReactNode): ReactNode {
  if (!text.includes(LINK_SLOT)) return text;
  const [before, after] = splitAtLink(text);
  return (
    <>
      {before}
      {link}
      {after}
    </>
  );
}

type View =
  | { kind: "checking" }
  | { kind: "confirm"; organiser: string | null }
  /** The organiser has left: only "stop every organiser" is on offer. */
  | { kind: "gone" }
  /** This organiser is stopped (`already`: before this visit). */
  | { kind: "done"; organiser: string | null; already: boolean }
  /** Every organiser is stopped (`already`: before this visit). */
  | { kind: "doneAll"; already: boolean }
  | { kind: "invalid" }
  /**
   * Back/Forward brought the guest to a fresh copy of this page with no
   * token left: whatever they stopped here is still stopped, so this is not
   * the dead-link page.
   */
  | { kind: "expired" };

/** Which stop is running, if any. */
type Busy = "organiser" | "all" | null;

/**
 * True when this document was loaded by Back/Forward (a fresh load: the
 * route is `no-store`, so the back/forward cache rarely keeps it). False
 * when the Navigation Timing entry is unavailable.
 */
function arrivedByBackForward(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type === "back_forward";
  } catch {
    return false;
  }
}

/** How long a stop must run before the live region says it is busy. */
const BUSY_ANNOUNCE_DELAY_MS = 300;

const TOKEN_PARAM = "token";
/** The stash id: `th:invite:stop` (invite-url.ts adds the prefix). */
const STASH_ID = "stop";

/**
 * "This tab has used a working stop link." Holds no token, only "1", and its
 * key sits OUTSIDE the `th:invite:` stash prefix on purpose: a key under it
 * would make `sessionHoldsInviteToken()` keep analytics off for the tab.
 * With no token left in the URL or the stash, it turns a soft Back (a Next
 * navigation away ran the unmount cleanup, so the type is `navigate`) into
 * the `expired` view instead of the dead link. A broken link opened later in
 * the same tab then also reads "expired", which still points to the email.
 */
const SEEN_KEY = "th:stop-invites-seen";

function markSeen(): void {
  try {
    window.sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Storage blocked: Back falls back to the back_forward check.
  }
}

function seenBefore(): boolean {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The Door's four stepped blocks, shown while a primary button runs. */
function DoorSpinner() {
  return (
    <span
      className="th-door__spin"
      aria-hidden
      data-testid="invite-stop-spinner"
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export function InviteStopPage() {
  const rawT = useTranslations();
  const t = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      String(rawT(key, values)),
    [rawT],
  );
  const uid = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useDoorTop(rootRef);

  // Silent: a failed peek falls back quietly by design, and a failed stop
  // has its own error strip; the global toast would add a second alert.
  const peek = trpc.events.peekInviteOptOut.useMutation({
    meta: { silent: true },
  });
  const stop = trpc.events.stopOrganiserInvites.useMutation({
    meta: { silent: true },
  });
  const stopAll = trpc.events.stopAllInvites.useMutation({
    meta: { silent: true },
  });

  const tokenRef = useRef<string | null>(null);
  const strippedRef = useRef(false);
  const peekStarted = useRef(false);
  const focusTitleNext = useRef(false);
  /**
   * A stop (either one) is running. A ref, not state: two presses in one
   * tick both see it, and it refuses the other action too.
   */
  const inFlight = useRef(false);
  /** Every organiser stopped, or invalid: the stash must not come back. */
  const finished = useRef(false);

  const [view, setView] = useState<View>({ kind: "checking" });
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ n: number } | null>(null);
  /**
   * The polite live region's text. Every stop says "busy" here (both
   * handlers, every trigger), with no `aria-busy` on the focused control:
   * VoiceOver rarely re-reads a focused element's changed name, and
   * `aria-busy` can hold its updates back (orchestrator ruling, 2026-10-07:
   * a double read on NVDA is the smaller harm than silence on VoiceOver).
   * The busy text waits BUSY_ANNOUNCE_DELAY_MS: clearing the region does not
   * cancel a queued polite utterance, so on a fast failure VoiceOver could
   * say "Stopping…" after the assertive error alert. A fast answer never
   * queues it (which also spares NVDA the double read). The button's own
   * name and text still change at once. Known, accepted limit: a failure
   * that lands after the delay can still be read after the alert.
   */
  const [live, setLive] = useState("");
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearBusyAnnouncement = useCallback(() => {
    if (busyTimer.current !== null) {
      clearTimeout(busyTimer.current);
      busyTimer.current = null;
    }
  }, []);
  const announceBusySoon = useCallback(
    (text: string) => {
      clearBusyAnnouncement();
      busyTimer.current = setTimeout(() => {
        busyTimer.current = null;
        setLive(text);
      }, BUSY_ANNOUNCE_DELAY_MS);
    },
    [clearBusyAnnouncement],
  );
  useEffect(() => clearBusyAnnouncement, [clearBusyAnnouncement]);

  // Before anything else reads the URL. Set only: StrictMode re-runs this on
  // an address bar that is already clean, and must not drop the token.
  useLayoutEffect(() => {
    const { stripped, token } = stripInviteParam(TOKEN_PARAM);
    if (stripped) {
      strippedRef.current = true;
      tokenRef.current = token;
    } else if (tokenRef.current === null) {
      // A reload: the URL is clean, the stash is not.
      tokenRef.current = readStashedInviteToken(STASH_ID);
    }
  }, []);

  // Stash for a reload; drop it when the page goes. Re-stashed on StrictMode's
  // re-run (its cleanup cleared it); a reload runs no cleanup, so it survives.
  useEffect(() => {
    const token = tokenRef.current;
    if (token && !finished.current) stashInviteToken(STASH_ID, token);
    return () => clearStashedInviteToken(STASH_ID);
  }, []);

  const finish = useCallback(() => {
    finished.current = true;
    clearStashedInviteToken(STASH_ID);
  }, []);

  // A same-tab click on "Contact us" is a full page load, which runs no
  // unmount cleanup, so the click clears the stash itself (a held stash keeps
  // analytics off for the whole tab). If Back then restores this page from
  // the back/forward cache, the stash comes back for a reload. Best-effort
  // only: the route is `no-store`, so most browsers load it fresh instead
  // (that case is the `expired` view). Not cleared on `pagehide`: that also
  // fires on a reload, which must still restore.
  // The restash does not dispatch ANALYTICS_URL_SCRUBBED_EVENT on purpose:
  // this document loaded on an excluded route, so `documentLoadedWithSecret()`
  // keeps analytics off for it either way.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      const token = tokenRef.current;
      if (e.persisted && token && !finished.current) {
        stashInviteToken(STASH_ID, token);
      }
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  useEffect(
    () => (strippedRef.current ? syncRouterToCleanUrl(TOKEN_PARAM) : undefined),
    [],
  );

  // Read-only: who sent it, what is already stopped, or "this link is
  // broken". Once per page.
  useEffect(() => {
    if (peekStarted.current) return;
    peekStarted.current = true;
    const token = tokenRef.current;
    if (!token) {
      finish();
      setView({
        kind: arrivedByBackForward() || seenBefore() ? "expired" : "invalid",
      });
      return;
    }
    peek
      .mutateAsync({ token })
      .then((out) => {
        if (out.ok) markSeen();
        let next: View;
        if (!out.ok) {
          next = { kind: "invalid" };
        } else if (out.alreadyStopped === "ALL") {
          next = { kind: "doneAll", already: true };
        } else if (out.organiserGone) {
          // Stopping a deleted organiser alone answers INVALID; stopping
          // every organiser still works.
          next = { kind: "gone" };
        } else {
          const organiser = out.organiserName?.trim() || null;
          next =
            out.alreadyStopped === "ORGANISER"
              ? { kind: "done", organiser, already: true }
              : { kind: "confirm", organiser };
        }
        if (next.kind === "invalid" || next.kind === "doneAll") finish();
        setView((prev) => (prev.kind !== "checking" ? prev : next));
      })
      .catch(() => {
        // The peek only fetches a name. Without it the page still asks, about
        // "this organiser"; the button's own call decides if the link works.
        setView((prev) =>
          prev.kind === "checking" ? { kind: "confirm", organiser: null } : prev,
        );
      });
    // `peek` is a new object per render; this runs once by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The button is gone or its question answered after a stop: focus the new
  // title.
  useEffect(() => {
    if (!focusTitleNext.current) return;
    focusTitleNext.current = false;
    titleRef.current?.focus({ preventScroll: true });
  }, [view]);

  const organiserFallback = t("invitesStop.thisOrganiser");

  /** No token to send: the link is no good. */
  const landInvalid = useCallback(() => {
    finish();
    focusTitleNext.current = true;
    setView({ kind: "invalid" });
    setLive("");
  }, [finish]);

  const handleStop = useCallback(async () => {
    if (inFlight.current || view.kind !== "confirm") return;
    const token = tokenRef.current;
    if (!token) {
      landInvalid();
      return;
    }
    inFlight.current = true;
    setBusy("organiser");
    setError(null);
    setLive("");
    announceBusySoon(t("invitesStop.confirmBusy"));
    try {
      const out = await stop.mutateAsync({ token });
      if (out.ok) markSeen();
      focusTitleNext.current = true;
      if (!out.ok) {
        // The organiser stop also answers INVALID when the organiser has left
        // (deleted after the peek, or the peek failed). Ask once more: if
        // they are gone, stopping every organiser still works.
        let again: Awaited<ReturnType<typeof peek.mutateAsync>>;
        try {
          again = await peek.mutateAsync({ token });
        } catch {
          // Unknown, not invalid: keep the question and the stash, and show
          // the error strip, so a retry runs the stop again.
          focusTitleNext.current = false;
          setError((prev) => ({ n: (prev?.n ?? 0) + 1 }));
          setLive("");
          return;
        }
        if (again.ok) markSeen();
        if (again.ok && again.alreadyStopped === "ALL") {
          finish();
          setView({ kind: "doneAll", already: true });
          setLive(t("invitesStop.alreadyAllBody"));
        } else if (again.ok && again.organiserGone) {
          // Keep the stash: "Stop all invites" still needs the token.
          setView({ kind: "gone" });
          setLive(t("invitesStop.goneBody"));
        } else {
          finish();
          setView({ kind: "invalid" });
          setLive("");
        }
      } else if (out.alreadyStopped === "ALL") {
        finish();
        setView({ kind: "doneAll", already: true });
        setLive(t("invitesStop.alreadyAllBody"));
      } else {
        // "Stop every organiser" is still on offer: keep the stash.
        const organiser = out.organiserName?.trim() || view.organiser;
        const already = out.alreadyStopped === "ORGANISER";
        setView({ kind: "done", organiser, already });
        setLive(
          t(already ? "invitesStop.alreadyBody" : "invitesStop.doneBody", {
            organiser: organiser ?? organiserFallback,
          }),
        );
      }
    } catch {
      setError((prev) => ({ n: (prev?.n ?? 0) + 1 }));
      setLive("");
    } finally {
      clearBusyAnnouncement();
      inFlight.current = false;
      setBusy(null);
    }
  }, [
    announceBusySoon,
    clearBusyAnnouncement,
    finish,
    landInvalid,
    organiserFallback,
    peek,
    stop,
    t,
    view,
  ]);

  // Busy cue: see `live` above.
  const handleStopAll = useCallback(async () => {
    if (
      inFlight.current ||
      (view.kind !== "confirm" && view.kind !== "done" && view.kind !== "gone")
    ) {
      return;
    }
    const token = tokenRef.current;
    if (!token) {
      landInvalid();
      return;
    }
    inFlight.current = true;
    setBusy("all");
    setError(null);
    setLive("");
    announceBusySoon(t("invitesStop.allBusy"));
    try {
      const out = await stopAll.mutateAsync({ token });
      if (out.ok) markSeen();
      // Final either way: every organiser stopped, or the link is no good.
      finish();
      focusTitleNext.current = true;
      if (!out.ok) {
        setView({ kind: "invalid" });
        setLive("");
      } else {
        const already = out.alreadyStopped === "ALL";
        setView({ kind: "doneAll", already });
        setLive(
          t(already ? "invitesStop.alreadyAllBody" : "invitesStop.doneAllBody"),
        );
      }
    } catch {
      setError((prev) => ({ n: (prev?.n ?? 0) + 1 }));
      setLive("");
    } finally {
      clearBusyAnnouncement();
      inFlight.current = false;
      setBusy(null);
    }
  }, [
    announceBusySoon,
    clearBusyAnnouncement,
    finish,
    landInvalid,
    stopAll,
    t,
    view,
  ]);

  const organiser =
    view.kind === "confirm" || view.kind === "done" ? view.organiser : null;
  const kicker = organiser
    ? t("invitesStop.kickerConfirm", { organiser })
    : t("invitesStop.kicker");
  const named = organiser ?? organiserFallback;

  // A plain anchor: the strip's mono idiom must not pick up the DS link's
  // text styles. Its full load of /contact runs no unmount cleanup, so a
  // same-tab click clears the stash here (a new tab leaves this page, and
  // its stash, as they were).
  const contactLink = (label: string) => (
    <a
      href="/contact"
      data-testid="invite-stop-contact"
      onClick={(e) => {
        if (
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        clearStashedInviteToken(STASH_ID);
      }}
    >
      {label}
    </a>
  );

  /**
   * The Door's lg primary button, with its four busy blocks. Busy is refused
   * in the handler rather than `disabled`, as on the invite Door: a disabled
   * button dims the blocks.
   */
  const primaryButton = (opts: {
    testID: string;
    label: string;
    busyLabel: string;
    running: boolean;
    onPress: () => void;
  }) => (
    <Button
      variant="primary"
      size="$5"
      testID={opts.testID}
      // No aria-busy: the live region carries "busy" (see `live`).
      aria-label={opts.running ? opts.busyLabel : opts.label}
      onPress={opts.onPress}
    >
      <span
        className="th-door__enter-label th-door__enter-label--lg"
        data-busy={opts.running ? "true" : "false"}
      >
        <span className="th-door__enter-text">{opts.label}</span>
        {opts.running ? <DoorSpinner /> : null}
      </span>
    </Button>
  );

  // "Or stop invites from every organiser." A real button: it acts. The
  // WHOLE sentence sits inside it: a button is an atomic box in every engine
  // (`display: inline` is not honoured), so a button around the link words
  // alone, once too long for one line, pushed "Or" and "." onto lines of
  // their own. Inside it the sentence wraps like running text. "Or " and "."
  // are hidden from the accessible name, which stays the link words. Its
  // node stays put while it runs (only its text changes), so a keyboard
  // user's focus stays on it.
  const allRunning = busy === "all";
  const [allBefore, allAfter] = splitAtLink(
    t("invitesStop.allLine", { link: LINK_SLOT }),
  );
  const stopAllLine = (
    <p className="th-invite-stop__all" data-testid="invite-stop-all">
      <button
        type="button"
        className="th-invite-stop__all-button"
        data-testid="invite-stop-all-link"
        data-busy={allRunning ? "true" : undefined}
        onClick={() => {
          void handleStopAll();
        }}
      >
        {allRunning ? null : <span aria-hidden>{allBefore}</span>}
        <span className={allRunning ? undefined : "th-invite-stop__all-link"}>
          {allRunning ? t("invitesStop.allBusy") : t("invitesStop.allLink")}
        </span>
        {allRunning ? null : <span aria-hidden>{allAfter}</span>}
      </button>
    </p>
  );

  const undoStrip = (
    <p className="th-door__message" data-testid="invite-stop-undo">
      {withLink(
        t("invitesStop.doneUndo", { link: LINK_SLOT }),
        contactLink(t("invitesStop.doneUndoLink")),
      )}
    </p>
  );

  const title =
    view.kind === "confirm" || view.kind === "gone"
      ? t("invitesStop.confirmTitle")
      : view.kind === "done" || view.kind === "doneAll"
        ? t("invitesStop.doneTitle")
        : view.kind === "invalid"
          ? t("invitesStop.invalidTitle")
          : view.kind === "expired"
            ? t("invitesStop.expiredTitle")
            : null;

  const canAct =
    view.kind === "confirm" || view.kind === "done" || view.kind === "gone";

  return (
    <section
      ref={rootRef}
      className="th-door th-invite-stop"
      data-testid="invite-stop"
      data-state={view.kind}
      aria-labelledby={title ? `${uid}-title` : undefined}
      aria-busy={view.kind === "checking" || undefined}
    >
      <div className="th-door__body">
        {title ? (
          <>
            <p className="th-door__kicker" data-testid="invite-stop-kicker">
              {kicker}
            </p>
            <h1
              ref={titleRef}
              id={`${uid}-title`}
              tabIndex={-1}
              className="th-door__title"
            >
              {title}
            </h1>
          </>
        ) : null}

        <div className="th-door__rest">
          {view.kind === "confirm" ? (
            <>
              <p className="th-door__lede" data-testid="invite-stop-lede">
                {t("invitesStop.confirmBody", { organiser: named })}
              </p>
              <div className="th-door__cta">
                {primaryButton({
                  testID: "invite-stop-button",
                  label: t("invitesStop.confirmButton"),
                  busyLabel: t("invitesStop.confirmBusy"),
                  running: busy === "organiser",
                  onPress: () => {
                    void handleStop();
                  },
                })}
                {stopAllLine}
              </div>
            </>
          ) : null}

          {view.kind === "gone" ? (
            <>
              <p className="th-door__lede" data-testid="invite-stop-lede">
                {t("invitesStop.goneBody")}
              </p>
              <div className="th-door__cta">
                {primaryButton({
                  testID: "invite-stop-all-button",
                  label: t("invitesStop.allButton"),
                  busyLabel: t("invitesStop.allBusy"),
                  running: allRunning,
                  onPress: () => {
                    void handleStopAll();
                  },
                })}
              </div>
            </>
          ) : null}

          {view.kind === "done" ? (
            <>
              <p className="th-door__lede" data-testid="invite-stop-lede">
                {t(
                  view.already
                    ? "invitesStop.alreadyBody"
                    : "invitesStop.doneBody",
                  { organiser: named },
                )}
              </p>
              {stopAllLine}
              {undoStrip}
            </>
          ) : null}

          {view.kind === "doneAll" ? (
            <>
              <p className="th-door__lede" data-testid="invite-stop-lede">
                {t(
                  view.already
                    ? "invitesStop.alreadyAllBody"
                    : "invitesStop.doneAllBody",
                )}
              </p>
              {undoStrip}
            </>
          ) : null}

          {view.kind === "expired" ? (
            <p className="th-door__lede" data-testid="invite-stop-lede">
              {t("invitesStop.expiredBody")}
            </p>
          ) : null}

          {view.kind === "invalid" ? (
            <p
              className="th-invite-dead"
              data-surface="door"
              data-testid="invite-stop-invalid"
            >
              {withLink(
                t("invitesStop.invalidBody", { link: LINK_SLOT }),
                contactLink(t("invitesStop.invalidBodyLink")),
              )}
            </p>
          ) : null}

          {/* Mounted empty from the first paint, so its later text is read as
              a change (a region that mounts with its text often is not). */}
          <p className="th-invite-sr" role="status" aria-live="polite">
            {live}
          </p>

          {error && canAct ? (
            <p
              // A fresh node per failure, so a repeated error re-announces.
              key={error.n}
              role="alert"
              className="th-door__message"
              data-tone="error"
              data-testid="invite-stop-error"
            >
              {t("invitesStop.error")}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

InviteStopPage.displayName = "InviteStopPage";
