"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import Image from "next/image";
import { formatDateTimeAs } from "@th/types";
import { Button, PasswordInput, useLocale, useTranslations } from "@th/ui";

import "./password-door.css";

/**
 * What the line under the field is saying. Only `invalid` marks the field
 * `aria-invalid`, turns its border to danger and runs the wrong-password
 * motion; `challenge` / `unavailable` are neutral (they say nothing about the
 * password), the rest print in the error tone without touching the field.
 */
export type PasswordDoorMessageKind =
  | "invalid"
  | "challenge"
  | "unavailable"
  | "rateLimited"
  | "generic";
export type PasswordDoorMessage = {
  kind: PasswordDoorMessageKind;
  text: string;
};

const NEUTRAL_KINDS: ReadonlySet<PasswordDoorMessageKind> = new Set([
  "challenge",
  "unavailable",
]);

/** The id the field's `aria-describedby` points at (tests and e2e use it). */
export const PASSWORD_DOOR_MESSAGE_ID = "password-error";

/** More squares than this is a paste, not a password; the row shows its tail. */
const MAX_BLOCKS = 64;
/** The whole right-to-left clear fits in one 240ms step budget. */
const CLEAR_BUDGET_MS = 240;
const CLEAR_STEP_MAX_MS = 45;
/** The nudge runs first; the squares clear after it. */
const NUDGE_MS = 240;

export type PasswordDoorProps = {
  title: string;
  heroImageUrl: string | null;
  /**
   * The event's LOCAL calendar day, `YYYY-MM-DD`, already resolved in the
   * event's zone on the server. No instant and no zone reach the gate: the
   * zone ("America/Boise") names a place. Without it there is no date.
   */
  gateDate?: string | null;

  password: string;
  /** A keystroke, paste or autofill. */
  onPasswordChange: (value: string) => void;
  /**
   * Empties the field WITHOUT the side effects of a keystroke (the wrong-
   * password line has to stay up while the squares clear).
   */
  onPasswordClear: () => void;
  onSubmit: () => void;
  /** A request is in flight (or the unlock is being revealed). Locks the field. */
  submitting: boolean;
  /** Nothing to send yet (empty field, or waiting on the security check). */
  submitDisabled: boolean;
  message: PasswordDoorMessage | null;

  /** The Turnstile widget, when the server has asked for it. */
  challenge?: ReactNode;
  /** One line under the widget while it still needs solving. */
  challengeCaption?: string | null;
  /** The notify-me form. When given, the Door offers it behind a link. */
  waitlist?: ReactNode;
  /**
   * One line between the title and the field: a dead invite link's
   * "This invite link doesn't work anymore." (`InviteDeadNotice`).
   */
  notice?: ReactNode;
};

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const inputIn = (root: HTMLElement | null) =>
  root?.querySelector<HTMLInputElement>("input") ?? null;

/**
 * `Sat, Oct 18` for a `YYYY-MM-DD` day, or null when it cannot be said. The
 * day is already the event's local day, so it is formatted as a UTC date:
 * the viewer's own zone must not shift it.
 */
export function formatDoorDate(
  gateDate: string | null | undefined,
  locale: string | undefined,
): { text: string; iso: string } | null {
  const match = gateDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(gateDate) : null;
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  // Reject a day that rolls over (`2026-02-30`).
  if (date.toISOString().slice(0, 10) !== gateDate) return null;
  return {
    text: formatDateTimeAs(date, "dateShort", { timeZone: "UTC", locale }),
    iso: gateDate as string,
  };
}

/**
 * The navbar's height decides how tall "one screen" is. CSS carries the
 * measured first-paint value; this follows whatever actually sits above the
 * Door. MEASURED: measuring once at mount read 69px on a phone whose navbar
 * settles at 65px when its logo loads, leaving a 4px sliver of paper above
 * the bottom nav — so the elements above `main` are watched for size.
 * Shared with the invite Door (`InviteDoor.tsx`).
 */
export function useDoorTop(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      if (top > 0) {
        el.style.setProperty("--th-door-top", `${Math.round(top)}px`);
      }
    };
    sync();
    const ro =
      typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    const main = el.closest('[role="main"], main');
    for (
      let above = main?.previousElementSibling ?? null;
      above;
      above = above.previousElementSibling
    ) {
      ro?.observe(above);
    }
    window.addEventListener("resize", sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [ref]);
}

/**
 * The password gate's look ("Door"). Purely presentational: the unlock flow,
 * the Turnstile challenge and the waitlist rules all stay in
 * `EventPasswordGateWrapper`, which feeds this component state and handlers.
 *
 * The field is ONE real `<input type="password">` (the DS `PasswordInput`, so
 * its reveal toggle, autofill and paste all work). In "Blocks" the typed
 * characters are painted over it as flame squares; revealing the password
 * shows the real text instead.
 */
export function PasswordDoor({
  title,
  heroImageUrl,
  gateDate,
  password,
  onPasswordChange,
  onPasswordClear,
  onSubmit,
  submitting,
  submitDisabled,
  message,
  challenge,
  challengeCaption,
  waitlist,
  notice,
}: PasswordDoorProps) {
  const t = useTranslations();
  const locale = useLocale();
  const rootRef = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const uid = useId();

  const [revealed, setRevealed] = useState(false);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  // While the squares clear after a wrong password, how many are left. Null
  // = mirror the real value.
  const [clearingCount, setClearingCount] = useState<number | null>(null);
  const clearTimers = useRef<number[]>([]);

  const date = useMemo(
    () => formatDoorDate(gateDate, locale),
    [gateDate, locale],
  );

  const length = Array.from(password).length;
  const shownBlocks = Math.min(clearingCount ?? length, MAX_BLOCKS);
  const invalid = message?.kind === "invalid";

  const cancelClear = () => {
    for (const id of clearTimers.current) window.clearTimeout(id);
    clearTimers.current = [];
    setClearingCount(null);
  };

  useEffect(
    () => () => {
      for (const id of clearTimers.current) window.clearTimeout(id);
    },
    [],
  );

  useDoorTop(rootRef);

  // ── Wrong password: nudge, then clear the squares right to left ────────
  // Keyed on the message OBJECT: the wrapper sets a fresh one per attempt, so
  // two wrong passwords in a row both run.
  useEffect(() => {
    if (message?.kind !== "invalid") return;
    const form = formRef.current;
    const input = inputIn(fieldRef.current);
    if (reducedMotion()) {
      // Border + message only. Select so the next keystroke replaces it.
      input?.focus({ preventScroll: true });
      input?.select();
      return;
    }
    if (form) {
      form.classList.remove("is-nudging");
      // Restart the animation on a repeat wrong answer.
      void form.offsetWidth;
      form.classList.add("is-nudging");
    }
    const n = Math.min(Array.from(password).length, MAX_BLOCKS);
    if (revealed || n === 0) {
      input?.focus({ preventScroll: true });
      input?.select();
      return;
    }
    const step = Math.max(
      1,
      Math.min(CLEAR_STEP_MAX_MS, Math.floor(CLEAR_BUDGET_MS / n)),
    );
    const timers: number[] = [];
    for (let i = 1; i <= n; i += 1) {
      timers.push(
        window.setTimeout(() => setClearingCount(n - i), NUDGE_MS + i * step),
      );
    }
    timers.push(
      window.setTimeout(
        () => {
          clearTimers.current = [];
          setClearingCount(null);
          onPasswordClear();
          inputIn(fieldRef.current)?.focus({ preventScroll: true });
        },
        NUDGE_MS + n * step + step,
      ),
    );
    clearTimers.current = timers;
    return () => {
      // A new message mid-clear must not strand a partial row of squares.
      for (const id of timers) window.clearTimeout(id);
      clearTimers.current = [];
      setClearingCount(null);
    };
    // Only a NEW message starts this; the password it clears is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  const shownMessageTone =
    message && NEUTRAL_KINDS.has(message.kind) ? "default" : "error";

  const enterLabel = String(t("eventDetail.pwDoorEnter"));
  const checkingLabel = String(t("eventDetail.pwChecking"));

  return (
    <section
      ref={rootRef}
      className="th-door"
      data-testid="password-door"
      aria-labelledby={`${uid}-title`}
    >
      {heroImageUrl ? (
        <>
          <div className="th-door__photo" data-gate-reveal="photo">
            <Image
              src={heroImageUrl}
              alt=""
              fill
              sizes="100vw"
              style={{ objectFit: "cover" }}
              priority
              // A photo that fails to load (a dead URL) leaves the plain
              // colour field rather than a broken-image glyph.
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
            />
          </div>
          <div
            className="th-door__scrim"
            data-gate-reveal="scrim"
            aria-hidden
          />
        </>
      ) : null}

      {/* Named "copy" for the reveal: it steps out while the photo and the
          title (named separately) move to their places on the event page. */}
      <div className="th-door__body" data-gate-reveal="copy">
        <p className="th-door__kicker">
          {String(t("eventDetail.pwDoorKicker"))}
          {date ? (
            <>
              {" · "}
              <time dateTime={date.iso} data-testid="password-door-date">
                {date.text}
              </time>
            </>
          ) : null}
        </p>

        {/* The gate page's h1 — the post-unlock focus handoff targets
            the main region's h1, and the unlock reveal moves this onto the
            event's. */}
        <h1
          id={`${uid}-title`}
          className="th-door__title"
          data-gate-reveal="title"
        >
          {title}
        </h1>

        <div className="th-door__rest">
          {notice}
          {/* No <form>: Enter submits through the input's onSubmitEditing,
                and the button through onPress — a form's own submit would
                fire the request a second time. */}
          <div
            ref={formRef}
            className="th-door__form"
            aria-busy={submitting || undefined}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget) {
                e.currentTarget.classList.remove("is-nudging");
              }
            }}
          >
            <div
              ref={fieldRef}
              className="th-door__field"
              data-blocks={revealed ? "off" : "on"}
            >
              <PasswordInput
                fullWidth
                value={password}
                onChangeText={(v: string) => {
                  if (clearingCount !== null) cancelClear();
                  onPasswordChange(v);
                }}
                onSubmitEditing={() => onSubmit()}
                editable={!submitting}
                autoFocus
                autoComplete="current-password"
                placeholder={String(t("eventDetail.pwPlaceholder"))}
                aria-label={String(t("eventDetail.pwAriaLabel"))}
                aria-invalid={invalid}
                aria-describedby={
                  message ? PASSWORD_DOOR_MESSAGE_ID : undefined
                }
                show={revealed}
                onToggle={() => setRevealed((v) => !v)}
                toggleLabel={String(t("eventDetail.pwTogglePw"))}
                minHeight={44}
                // Fill, ink, border and the invalid red come from the scrim
                // trio via password-door.css (`.th-door__field`): a global
                // input rule outranks Tamagui's colour props on this element.
                placeholderTextColor="$onScrimMuted"
                focusStyle={{ borderColor: "$accent" }}
              />
              {revealed ? null : (
                <span
                  className="th-door__blocks"
                  aria-hidden
                  data-testid="password-door-blocks"
                >
                  <span
                    className="th-door__blocks-row"
                    style={{ "--th-door-n": shownBlocks } as CSSProperties}
                  >
                    {Array.from({ length: shownBlocks }, (_, i) => (
                      <i key={i} className="th-door__block" />
                    ))}
                    <i className="th-door__cursor" />
                  </span>
                </span>
              )}
            </div>

            <Button
              variant="primary"
              size="$4"
              flexShrink={0}
              testID="password-door-enter"
              // Busy is neither `disabled` NOR `aria-disabled`: Tamagui dims
              // the button to 45% for either (measured: 0.45 with
              // aria-disabled alone), which would dim the very blocks that
              // say "checking". The press is refused in the handler, and
              // `aria-busy` + the "Checking…" name tell assistive tech.
              disabled={!submitting && submitDisabled}
              {...(submitting ? { "aria-busy": true } : {})}
              aria-label={submitting ? checkingLabel : enterLabel}
              onPress={() => {
                if (submitting) return;
                onSubmit();
              }}
            >
              <span
                className="th-door__enter-label"
                data-busy={submitting ? "true" : "false"}
              >
                <span className="th-door__enter-text">{enterLabel}</span>
                {submitting ? (
                  <span
                    className="th-door__spin"
                    aria-hidden
                    data-testid="password-door-spinner"
                  >
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                ) : null}
              </span>
            </Button>
          </div>

          {/* role="alert": focus stays in the field, so every message has
                to be announced from here — aria-describedby alone is not
                re-read when it changes. */}
          {message ? (
            <p
              id={PASSWORD_DOOR_MESSAGE_ID}
              role="alert"
              className="th-door__message"
              data-tone={shownMessageTone}
            >
              {message.text}
            </p>
          ) : null}

          {challenge ? (
            <div
              className="th-door__challenge"
              data-testid="password-gate-turnstile"
            >
              {challenge}
              {challengeCaption ? (
                <p className="th-door__caption">{challengeCaption}</p>
              ) : null}
            </div>
          ) : null}

          <p className="th-door__hint">
            {String(t("eventDetail.pwStayUnlockedHint"))}
          </p>

          {waitlist ? (
            <>
              <button
                type="button"
                className="th-door__waitlist-toggle"
                aria-expanded={waitlistOpen}
                aria-controls={`${uid}-waitlist`}
                onClick={() => setWaitlistOpen((v) => !v)}
              >
                {String(t("eventDetail.pwDoorWaitlistLink"))}
              </button>
              <div
                id={`${uid}-waitlist`}
                className="th-door__waitlist"
                hidden={!waitlistOpen}
              >
                {waitlistOpen ? waitlist : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

PasswordDoor.displayName = "PasswordDoor";
