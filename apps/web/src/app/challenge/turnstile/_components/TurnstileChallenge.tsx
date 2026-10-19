"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { YStack, styled } from "tamagui";
import { CardSurface, Text, useTranslations } from "@th/ui";

import { TURNSTILE_SITE_KEY } from "@/app/embed/[embedId]/_components/embed-helpers";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

import { replaceLocation } from "../_lib/navigate";
import { appendReturnParam } from "../_lib/return-url";
import styles from "./challenge.module.css";

/**
 * Distinct from the event gate's widget id so the two never share a
 * container if this ever renders beside it.
 */
const TURNSTILE_CONTAINER_ID = "mobile-challenge-turnstile";
/**
 * Cloudflare analytics label; the server does not check it. Same as the web
 * gate: both mint a token for `events.validatePassword`.
 */
const TURNSTILE_ACTION = "event-password";
/**
 * The widget never rendered in this long → the script is blocked or dead.
 * `scriptOptions.onError` catches most blocked loads immediately, but the
 * library only attaches it when IT injects the script.
 */
const WIDGET_LOAD_TIMEOUT_MS = 20_000;
/** Widget errors without a success in between before we stop waiting on it. */
const WIDGET_MAX_ERRORS = 3;
/**
 * Error-code families no retry can fix: 110xxx is widget configuration (bad
 * sitekey, domain not allowed); 400xxx is a rejected sitekey/parameter.
 * https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/
 */
const isConfigErrorCode = (code: string) =>
  code.startsWith("110") || code.startsWith("400");
/**
 * The card's content box is the viewport − 84px (16px page padding, 2px card
 * border and 24px card padding, each side), so the fixed 300px `normal`
 * widget fits only from 384px. Chosen ONCE, after mount: `size` sits in the
 * library's render-params memo (so a later change re-renders the widget and
 * drops any token), and the library writes the size into an inline style, so
 * it cannot be decided on the server.
 */
const COMPACT_BELOW_PX = 384;
const pickWidgetSize = (): "normal" | "compact" =>
  window.innerWidth < COMPACT_BELOW_PX ? "compact" : "normal";

const TRACE_LABEL = "mobile.challenge.unavailable";

const Page = styled(YStack, {
  name: "MobileChallengePage",
  minHeight: "100vh",
  width: "100%",
  justifyContent: "center",
  alignItems: "center",
  paddingHorizontal: "$4",
  paddingVertical: "$6",
});

const Card = styled(CardSurface, {
  name: "MobileChallengeCard",
  maxWidth: 420,
  width: "100%",
  // `surface`, not CardSurface's inherited `$background` (the page colour):
  // otherwise the card reads as a bare border on cream. Same fix as EventCard.
  backgroundColor: "$surface",
  padding: "$5",
  gap: "$4",
  alignItems: "center",
});

/**
 * Plain anchor, not `next/link`: the destination is the app's own URL scheme,
 * which the client router must not try to resolve or prefetch.
 */
type AppLinkProps = {
  href: string;
  label: string;
  /** The post-pass "Return to the app": the page's one primary action. */
  primary?: boolean;
};
const AppLink = ({ href, label, primary = false }: AppLinkProps) => (
  <a
    href={href}
    className={
      primary ? `${styles.backLink} ${styles.returnLink}` : styles.backLink
    }
    data-testid={primary ? "challenge-return-link" : "challenge-back-link"}
  >
    {label}
  </a>
);

export type TurnstileChallengeProps = {
  /**
   * The deep link to send the token to, ALREADY validated on the server by
   * `parseChallengeReturn`. `null` = the link was refused: render the error
   * state, never a widget, never a redirect.
   */
  returnUrl: string | null;
};

/**
 * Turnstile for the native app. The app opens this page in the system
 * browser after `events.validatePassword` answers
 * `EVENT_PASSWORD_CHALLENGE_REQUIRED`; on success the page hands the token
 * back by navigating to `returnUrl?turnstileToken=…`, which closes the
 * browser session. If the check cannot run, the guest gets a way back with
 * `turnstileError=unavailable` so the app can say so.
 */
export const TurnstileChallenge = ({ returnUrl }: TurnstileChallengeProps) => {
  const t = useTranslations();
  const hasSiteKey = Boolean(TURNSTILE_SITE_KEY);

  const [widgetSize, setWidgetSize] = useState<"normal" | "compact" | null>(
    null,
  );
  const [widgetLoaded, setWidgetLoaded] = useState(false);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const widgetErrorCountRef = useRef(0);
  const missingKeyTracedRef = useRef(false);

  const canChallenge = returnUrl !== null && hasSiteKey && !widgetFailed;
  const unavailable = returnUrl !== null && (!hasSiteKey || widgetFailed);

  // Size once, after mount (see pickWidgetSize).
  useEffect(() => {
    if (returnUrl === null) return;
    setWidgetSize((prev) => prev ?? pickWidgetSize());
  }, [returnUrl]);

  // The site key is inlined at build time; an empty one is a config gap
  // nobody else would see.
  useEffect(() => {
    if (returnUrl === null || hasSiteKey || missingKeyTracedRef.current) return;
    missingKeyTracedRef.current = true;
    traceIgnoredError(TRACE_LABEL)(
      new Error("NEXT_PUBLIC_TURNSTILE_SITE_KEY is empty"),
    );
  }, [returnUrl, hasSiteKey]);

  const failWidget = useCallback(() => {
    setToken(null);
    setWidgetFailed(true);
  }, []);

  const handleSuccess = useCallback(
    (next: string) => {
      if (returnUrl === null) return;
      widgetErrorCountRef.current = 0;
      setToken(next);
      replaceLocation(appendReturnParam(returnUrl, "turnstileToken", next));
    },
    [returnUrl],
  );

  const handleWidgetError = useCallback(
    (code: string) => {
      setToken(null);
      if (isConfigErrorCode(code)) {
        // Ours, not the guest's network: make it visible.
        traceIgnoredError(TRACE_LABEL)(
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

  // Backstop for a script that never loads and never reports.
  useEffect(() => {
    if (!canChallenge || widgetLoaded) return;
    const timer = setTimeout(failWidget, WIDGET_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [canChallenge, widgetLoaded, failWidget]);

  const title = String(t("challenge.title"));

  if (returnUrl === null) {
    return (
      <Page tag="main">
        <Card data-testid="challenge-invalid">
          <Text tag="h1" fontSize={22} weight="bold" textAlign="center">
            {title}
          </Text>
          <Text fontSize={15} tone="muted" textAlign="center">
            {String(t("challenge.invalidLink"))}
          </Text>
        </Card>
      </Page>
    );
  }

  return (
    <Page tag="main">
      <Card>
        <Text tag="h1" fontSize={22} weight="bold" textAlign="center">
          {title}
        </Text>

        {/* One live line: the prompt, then "unavailable" or "returning" in
            its place. role="status" so a screen reader hears the change
            without the focus moving. */}
        <Text
          role="status"
          fontSize={15}
          tone={unavailable ? "default" : "muted"}
          textAlign="center"
        >
          {unavailable
            ? String(t("challenge.unavailable"))
            : token
              ? String(t("challenge.returning"))
              : String(t("challenge.body"))}
        </Text>

        {canChallenge && widgetSize ? (
          <YStack alignItems="center" data-testid="challenge-turnstile">
            <Turnstile
              id={TURNSTILE_CONTAINER_ID}
              siteKey={TURNSTILE_SITE_KEY}
              options={{
                theme: "light",
                size: widgetSize,
                action: TURNSTILE_ACTION,
              }}
              scriptOptions={turnstileScriptOptions}
              onWidgetLoad={() => setWidgetLoaded(true)}
              onSuccess={handleSuccess}
              onExpire={() => setToken(null)}
              onError={handleWidgetError}
              onUnsupported={failWidget}
            />
          </YStack>
        ) : null}

        {/* Chrome on Android can refuse a custom-scheme navigation that runs
            without a user gesture, which is exactly what the success
            callback's `replace` is after an invisible pass. The same URL as
            a tap, so nobody is stranded here. */}
        {canChallenge && token ? (
          <AppLink
            primary
            href={appendReturnParam(returnUrl, "turnstileToken", token)}
            label={String(t("challenge.returnToApp"))}
          />
        ) : null}

        {unavailable ? (
          <AppLink
            href={appendReturnParam(returnUrl, "turnstileError", "unavailable")}
            label={String(t("challenge.backToApp"))}
          />
        ) : null}
      </Card>
    </Page>
  );
};

TurnstileChallenge.displayName = "TurnstileChallenge";
