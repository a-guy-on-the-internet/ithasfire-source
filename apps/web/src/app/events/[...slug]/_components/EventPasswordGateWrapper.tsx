"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { useRouter } from "@bprogress/next/app";
import { useTranslations } from "@th/ui";

import { TURNSTILE_SITE_KEY } from "@/app/embed/[embedId]/_components/embed-helpers";
import { WaitlistJoinForm } from "@/components/events/WaitlistJoinForm";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { PasswordDoor } from "./PasswordDoor";

/** Body the unlock route sends with a 403 when it wants a Turnstile token. */
const CHALLENGE_REQUIRED = "event_password_challenge_required";

/**
 * Distinct from the waitlist form's widget, which can share this page and
 * would otherwise claim the library's default `cf-turnstile` container id.
 */
const TURNSTILE_CONTAINER_ID = "event-password-turnstile";
/** Cloudflare analytics label; the server does not check it. */
const TURNSTILE_ACTION = "event-password";
/**
 * The widget never rendered in this long → the script is blocked or dead.
 * `scriptOptions.onError` catches most blocked loads immediately, but the
 * library only attaches it when IT injects the script; a tag another widget
 * already injected (and that already failed) never reports.
 */
const WIDGET_LOAD_TIMEOUT_MS = 20_000;
/** Widget errors without a success in between before we stop waiting on it. */
const WIDGET_MAX_ERRORS = 3;
/**
 * Error-code families that no retry can fix: 110xxx is widget configuration
 * (bad sitekey, domain not allowed); 400xxx is a rejected sitekey/parameter.
 * https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/
 */
const isConfigErrorCode = (code: string) =>
  code.startsWith("110") || code.startsWith("400");
/**
 * The fixed 300px `normal` widget overflows the card below ~332px (card border
 * box = viewport − 32px of overlay padding). Chosen ONCE, when the challenge
 * first appears: `size` sits in the library's render-params memo, so changing
 * it later re-renders the widget and throws away any token.
 */
const pickWidgetSize = (): "normal" | "compact" =>
  typeof window !== "undefined" && window.innerWidth < 360
    ? "compact"
    : "normal";

/**
 * What the line under the field is saying, separate from its words. Only
 * `invalid` marks the field `aria-invalid` and paints in the error tone: a
 * challenge is decided BEFORE the password is checked, so its prompt says
 * nothing about whether what the guest typed is wrong.
 */
type GateMessageKind =
  | "invalid"
  | "challenge"
  | "unavailable"
  | "rateLimited"
  | "generic";
type GateMessage = { kind: GateMessageKind; text: string };

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export type EventPasswordGateWrapperProps = {
  eventId: string;
  slug: string;
  title: string;
  heroImageUrl: string | null;
  /**
   * The event's local day the gate may show, `YYYY-MM-DD` (`null` = none).
   * Never a place, and so never a zone.
   */
  gateDate?: string | null;
  /** When true, a "Notify me" sign-up form is shown below the gate card. */
  waitlistOpen?: boolean;
  /** Organizer-provided blurb for the notify-me form. */
  waitlistDescription?: string | null;
  /**
   * Called after the unlock cookie has been set, INSTEAD of `router.refresh()`.
   *
   * A gated event page is edge-cached and identity-free by design, so a refresh
   * refetches the very same gate wall. `GatedEventShell` passes its access probe
   * here so the unlock reveals the event without a round trip through a shared
   * cache. Omitted (e.g. a standalone/test mount) → falls back to refresh.
   */
  onUnlocked?: () => void;
  /**
   * The shell is fetching the event after a successful unlock (and will play
   * the reveal). The Door stays in its checking state until it swaps out.
   */
  revealing?: boolean;
  /**
   * Counts probes that came back closed after the server accepted the password.
   * Each increase prints the generic error line in the Door.
   */
  unlockFailures?: number;
  /** A line above the field (a dead invite link). See `PasswordDoor.notice`. */
  notice?: ReactNode;
};

/**
 * Client component that shows the password gate UI.
 *
 * When password is validated successfully, it:
 * 1. Stores the unlocked state in sessionStorage
 * 2. Reloads the page (which will now bypass the gate server-side)
 *
 * Security note: The server only sends preview data (title + hero) to this
 * component. Full event details are never exposed until password is validated.
 * After repeated wrong passwords the server answers 403 until the request
 * carries a Turnstile token; the widget appears only from that point on.
 */
export const EventPasswordGateWrapper = ({
  eventId,
  slug,
  title,
  heroImageUrl,
  gateDate = null,
  waitlistOpen = false,
  waitlistDescription,
  onUnlocked,
  revealing = false,
  unlockFailures = 0,
  notice,
}: EventPasswordGateWrapperProps) => {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<GateMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const t = useTranslations();
  // Accepted password, but the shell's probe did not open the event.
  useEffect(() => {
    if (unlockFailures > 0) {
      setMessage({ kind: "generic", text: String(t("eventDetail.pwError")) });
    }
    // Only a NEW failure prints; `t` changing must not re-print a cleared line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockFailures]);
  // `waitlists` gate — fail-CLOSED, matching EventContent's join affordance.
  const { gates } = useFeatureGates();
  const waitlistsGateOn = gates?.waitlists === true;

  // ── Turnstile challenge ──────────────────────────────────────────────
  // Hidden until the server asks for it (a 403 `event_password_challenge_
  // required` after repeated wrong passwords), so most guests never see it.
  // Once asked, challenge mode stays on for the rest of this mount.
  const [challengeRequired, setChallengeRequired] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [widgetSize, setWidgetSize] = useState<"normal" | "compact" | null>(
    null,
  );
  const [widgetLoaded, setWidgetLoaded] = useState(false);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const widgetErrorCountRef = useRef(0);
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const hasSiteKey = Boolean(TURNSTILE_SITE_KEY);
  // A missing site key or a widget that cannot run: never leave an empty box
  // and a dead button — say "try again later" and keep submit usable, since
  // the server's failure window does expire.
  const showChallenge = challengeRequired && hasSiteKey && !widgetFailed;
  const challengeUnavailable =
    challengeRequired && (!hasSiteKey || widgetFailed);
  const awaitingToken = showChallenge && !turnstileToken;
  const unavailableTracedRef = useRef(false);
  // Set when a token-less submit was answered with the challenge: the next
  // token resubmits the password the guest already entered. Only a
  // token-LESS 403 arms it — a 403 on a tokened submit means the token itself
  // failed, and re-arming there could loop on a widget that auto-passes.
  const autoSubmitPendingRef = useRef(false);
  // Synchronous twin of `submitting`: the state flag lags a render, so a
  // button press landing in the same tick as the auto-resubmit would pass it.
  const inFlightRef = useRef(false);

  // We POST to a Next.js Route Handler instead of calling the tRPC mutation
  // directly. The handler proxies the validation to tRPC AND, on success,
  // sets a signed HttpOnly cookie that survives `router.refresh()` for
  // anonymous viewers. The page.tsx server component reads that cookie and
  // treats it as an unlock — the previous sessionStorage-only path broke
  // because the server re-rendered without any client state.
  //
  // `tokenOverride` lets the Turnstile success callback submit with the token
  // it just received, before `turnstileToken` state has re-rendered.
  const handleSubmit = useCallback(
    async (tokenOverride?: string) => {
      if (submitting || inFlightRef.current) return;
      const say = (kind: GateMessageKind, key: string) =>
        setMessage({ kind, text: String(t(key)) });
      const trimmed = password.trim();
      if (!trimmed) {
        say("invalid", "eventDetail.pwEnterPassword");
        return;
      }
      const sentToken = tokenOverride ?? turnstileToken ?? undefined;
      if (showChallenge && !sentToken) {
        // Enter in the field skips the disabled button. Don't spend a
        // request the server will refuse; send it once the token lands.
        autoSubmitPendingRef.current = true;
        say("challenge", "eventDetail.pwChallengeRequired");
        return;
      }
      setMessage(null);
      setSubmitting(true);
      inFlightRef.current = true;
      try {
        const res = await fetch(`/api/events/${eventId}/unlock`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            password: trimmed,
            ...(sentToken ? { turnstileToken: sentToken } : {}),
          }),
        });
        if (res.status === 403) {
          const body = (await res.json().catch(() => null)) as {
            error?: unknown;
          } | null;
          if (body?.error === CHALLENGE_REQUIRED) {
            // Size is fixed the first time the widget is about to appear.
            setWidgetSize((prev) => prev ?? pickWidgetSize());
            setChallengeRequired(true);
            if (!hasSiteKey || widgetFailed) {
              // The persistent "unavailable" line (below) takes it from here.
              if (!hasSiteKey && !unavailableTracedRef.current) {
                // The site key is inlined at build time and the deploy
                // workflows only pass it when set, so an empty one here is a
                // config gap nobody else would see.
                unavailableTracedRef.current = true;
                traceIgnoredError("event.gate.challengeUnavailable")(
                  new Error("NEXT_PUBLIC_TURNSTILE_SITE_KEY is empty"),
                );
              }
              return;
            }
            autoSubmitPendingRef.current = !sentToken;
            say(
              "challenge",
              sentToken
                ? "eventDetail.pwChallengeFailed"
                : "eventDetail.pwChallengeRequired",
            );
            return;
          }
          // Any other 403 (e.g. `invalid_origin`) is not ours to explain.
          say("generic", "eventDetail.pwError");
          return;
        }
        if (res.status === 401) {
          say("invalid", "eventDetail.pwIncorrect");
          return;
        }
        if (res.status === 429) {
          // Rate-limited: tell the user to back off instead of silently
          // showing the generic "something went wrong" copy.
          say("rateLimited", "eventDetail.pwTooManyAttempts");
          return;
        }
        if (!res.ok) {
          say("generic", "eventDetail.pwError");
          return;
        }
        // No toast: the reveal (GatedEventShell) is the confirmation.
        // Mark this tab so the post-refresh page can move focus to the
        // h1. Without this, keyboard users land in nowhere-land after the
        // gate disappears.
        try {
          sessionStorage.setItem(`th-event-just-unlocked:${eventId}`, "1");
        } catch {
          // sessionStorage may be unavailable (private window quirks).
        }
        if (onUnlocked) {
          onUnlocked();
        } else {
          router.refresh();
        }
      } catch {
        say("generic", "eventDetail.pwError");
      } finally {
        // Turnstile tokens are single-use: whatever the outcome, a token that
        // rode this request is spent. Fresh widget, fresh token next time.
        if (sentToken) {
          setTurnstileToken(null);
          turnstileRef.current?.reset();
        }
        inFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [
      eventId,
      hasSiteKey,
      onUnlocked,
      password,
      router,
      showChallenge,
      submitting,
      t,
      turnstileToken,
      widgetFailed,
    ],
  );

  const handleTurnstileSuccess = useCallback(
    (token: string) => {
      widgetErrorCountRef.current = 0;
      setTurnstileToken(token);
      if (autoSubmitPendingRef.current && !inFlightRef.current) {
        autoSubmitPendingRef.current = false;
        void handleSubmit(token);
      }
    },
    [handleSubmit],
  );

  // Give up on the widget: drop it, stop any pending auto-resubmit, and let
  // the persistent "unavailable" line replace a "complete the check below"
  // prompt that no longer has anything below it.
  const failWidget = useCallback(() => {
    autoSubmitPendingRef.current = false;
    setTurnstileToken(null);
    setWidgetFailed(true);
    setMessage((m) => (m?.kind === "challenge" ? null : m));
  }, []);

  const handleWidgetError = useCallback(
    (code: string) => {
      setTurnstileToken(null);
      if (isConfigErrorCode(code)) {
        // Ours, not the guest's network: make it visible.
        traceIgnoredError("event.gate.challengeUnavailable")(
          new Error(`turnstile widget config error ${code}`),
        );
        failWidget();
        return;
      }
      widgetErrorCountRef.current += 1;
      if (widgetErrorCountRef.current >= WIDGET_MAX_ERRORS) {
        failWidget();
        return;
      }
      // Handled: Turnstile's own retry (`retry: "auto"`) runs, without its
      // console warning.
      return true;
    },
    [failWidget],
  );

  // Stable across renders: the library re-runs its script-injection effect
  // whenever this object's identity changes.
  const turnstileScriptOptions = useMemo(
    () => ({ onError: failWidget }),
    [failWidget],
  );

  // Backstop for a script that never loads and never reports (see
  // WIDGET_LOAD_TIMEOUT_MS). `onWidgetLoad` fires once the widget rendered.
  useEffect(() => {
    if (!showChallenge || widgetLoaded) return;
    const timer = setTimeout(failWidget, WIDGET_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [showChallenge, widgetLoaded, failWidget]);

  // A persistent line while the challenge cannot run. Hidden during a
  // request so it re-mounts afterwards and `role="alert"` announces the
  // unchanged answer to a guest who pressed the button again.
  const shownMessage: GateMessage | null =
    message ??
    (challengeUnavailable && !submitting
      ? {
          kind: "unavailable",
          text: String(t("eventDetail.pwChallengeUnavailable")),
        }
      : null);

  // The Turnstile widget rides the Door's challenge slot, under the field.
  // Theme stays "light": the widget is its own white box on the scrim.
  const challengeWidget = showChallenge ? (
    <Turnstile
      ref={turnstileRef}
      id={TURNSTILE_CONTAINER_ID}
      siteKey={TURNSTILE_SITE_KEY}
      options={{
        theme: "light",
        size: widgetSize ?? "normal",
        action: TURNSTILE_ACTION,
      }}
      scriptOptions={turnstileScriptOptions}
      onWidgetLoad={() => setWidgetLoaded(true)}
      onSuccess={handleTurnstileSuccess}
      onExpire={() => setTurnstileToken(null)}
      onError={handleWidgetError}
      onUnsupported={failWidget}
    />
  ) : null;

  return (
    <PasswordDoor
      title={title}
      heroImageUrl={heroImageUrl}
      gateDate={gateDate}
      password={password}
      onPasswordChange={(v) => {
        setPassword(v);
        setMessage(null);
        // Editing means the guest is mid-thought: don't fire a half-typed
        // password the moment the challenge passes.
        autoSubmitPendingRef.current = false;
      }}
      onPasswordClear={() => {
        // The wrong-password clear: keep the message up while it runs.
        setPassword("");
        autoSubmitPendingRef.current = false;
      }}
      onSubmit={() => void handleSubmit()}
      submitting={submitting || revealing}
      submitDisabled={!password.trim() || awaitingToken}
      // Challenge / unavailable prompts print neutral, not error red: they
      // say nothing about the password.
      message={shownMessage}
      challenge={challengeWidget}
      notice={notice}
      challengeCaption={
        showChallenge && !turnstileToken
          ? String(t("eventDetail.pwChallengeCaption"))
          : null
      }
      waitlist={
        waitlistsGateOn && waitlistOpen ? (
          <WaitlistJoinForm
            eventId={eventId}
            description={waitlistDescription}
          />
        ) : undefined
      }
    />
  );
};

EventPasswordGateWrapper.displayName = "EventPasswordGateWrapper";
