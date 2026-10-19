"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Button, useLocale, useTranslations } from "@th/ui";

import type { InviteDoorError, InviteKind } from "./invite-link";
import { formatDoorDate, useDoorTop } from "./PasswordDoor";

import "./password-door.css";
import "./invite-door.css";

export type InviteDoorProps = {
  title: string;
  heroImageUrl: string | null;
  /** The event's local day, `YYYY-MM-DD` (see `PasswordDoor.gateDate`). */
  gateDate: string | null;
  kind: InviteKind;
  /** PERSONAL only: "Maya R." The kicker drops the name when null. */
  inviteeShortName: string | null;
  organizerName: string | null;
  /** The redeem, or the reveal after it, is running. */
  busy: boolean;
  /** The last tap did not open the event; `n` changes per failure. */
  error: { kind: InviteDoorError; n: number } | null;
  onOpen: () => void;
};

/**
 * The invite link's Door ("one tap", invite-options board, owner pick
 * 2026-10-03): the password Door's photo, scrim, kicker and title, with the
 * field swapped for one line saying who sent it and one button. Built on the
 * same `th-door` classes so the unlock reveal (GatedEventShell) moves the
 * photo and the title exactly as it does from the password Door.
 */
export function InviteDoor({
  title,
  heroImageUrl,
  gateDate,
  kind,
  inviteeShortName,
  organizerName,
  busy,
  error,
  onOpen,
}: InviteDoorProps) {
  const t = useTranslations();
  const locale = useLocale();
  const rootRef = useRef<HTMLElement | null>(null);
  const uid = useId();
  useDoorTop(rootRef);

  const date = useMemo(
    () => formatDoorDate(gateDate, locale),
    [gateDate, locale],
  );

  const kicker =
    kind === "SHARED"
      ? String(t("eventDetail.inviteKickerShared"))
      : inviteeShortName
        ? String(t("eventDetail.inviteKickerFor", { name: inviteeShortName }))
        : String(t("eventDetail.inviteKickerYours"));

  const lede =
    kind === "SHARED"
      ? organizerName
        ? String(
            t("eventDetail.inviteBodyShared", { organizer: organizerName }),
          )
        : String(t("eventDetail.inviteBodySharedAnon"))
      : organizerName
        ? String(
            t("eventDetail.inviteBodyPersonal", { organizer: organizerName }),
          )
        : String(t("eventDetail.inviteBodyPersonalAnon"));

  const openLabel = String(t("eventDetail.inviteOpen"));
  const openingLabel = String(t("eventDetail.inviteOpening"));
  const errorText = error
    ? String(
        t(
          error.kind === "rateLimited"
            ? "eventDetail.pwTooManyAttempts"
            : "eventDetail.pwError",
        ),
      )
    : null;

  return (
    <section
      ref={rootRef}
      className="th-door"
      data-testid="invite-door"
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

      <div className="th-door__body" data-gate-reveal="copy">
        <p className="th-door__kicker" data-testid="invite-door-kicker">
          {kicker}
          {date ? (
            <>
              {" · "}
              <time dateTime={date.iso}>{date.text}</time>
            </>
          ) : null}
        </p>

        {/* The gate page's h1, as on the password Door: the reveal moves it
            onto the event's, and the post-unlock focus handoff targets it. */}
        <h1
          id={`${uid}-title`}
          className="th-door__title"
          data-gate-reveal="title"
        >
          {title}
        </h1>

        <div className="th-door__rest">
          <p className="th-door__lede" data-testid="invite-door-lede">
            {lede}
          </p>

          <div className="th-door__cta" aria-busy={busy || undefined}>
            <Button
              variant="primary"
              size="$5"
              testID="invite-door-open"
              // Busy is refused in the handler rather than `disabled`, as on
              // the password Door: Tamagui dims a disabled (or aria-disabled)
              // button to 45%, which would dim the blocks that say "opening".
              {...(busy ? { "aria-busy": true } : {})}
              aria-label={busy ? openingLabel : openLabel}
              onPress={() => {
                if (busy) return;
                onOpen();
              }}
            >
              <span
                className="th-door__enter-label th-door__enter-label--lg"
                data-busy={busy ? "true" : "false"}
              >
                <span className="th-door__enter-text">{openLabel}</span>
                {busy ? (
                  <span
                    className="th-door__spin"
                    aria-hidden
                    data-testid="invite-door-spinner"
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

          {/* Focus stays on the button through a press, so its new name is
              not reliably re-read: say "Opening the event…" here too. */}
          <p className="th-invite-sr" role="status" aria-live="polite">
            {busy ? openingLabel : ""}
          </p>

          {errorText ? (
            <p
              // A fresh node per failure, so a repeated error re-announces.
              key={error?.n}
              role="alert"
              className="th-door__message"
              data-tone="error"
              data-testid="invite-door-error"
            >
              {errorText}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

InviteDoor.displayName = "InviteDoor";

export type InviteDeadNoticeProps = {
  /** Which gate sits under the line: it says what to do instead. */
  gateType: "PASSWORD" | "APPLICATION";
  /** `door` = on the password Door's scrim; `paper` = the application page. */
  surface: "door" | "paper";
  /**
   * The guest's own tap found the link dead: the button they pressed is gone,
   * so the line takes focus. Otherwise (the landing's peek) it takes focus
   * only when nothing has it, and `role="status"` announces it.
   */
  takeFocus?: boolean;
  /**
   * Why there is no way in by link. `dead` (default): the link this guest
   * just opened does not work. `removed`: the guest's earlier access came
   * from the shared link, and the organiser reset it with "Remove them too"
   * (the probe's `removedByInviteReset`). Same strip, same focus rule.
   */
  reason?: "dead" | "removed";
};

/**
 * FR-010: a dead invite link lands on the NORMAL gate with one direct line
 * above it. Focus: see `takeFocus`. A peek that resolves dead never pulls
 * focus out of a field (the password Door autofocuses its input; keystrokes
 * there must keep landing).
 */
export function InviteDeadNotice({
  gateType,
  surface,
  takeFocus = false,
  reason = "dead",
}: InviteDeadNoticeProps) {
  const t = useTranslations();
  const ref = useRef<HTMLParagraphElement | null>(null);
  const message = String(
    t(
      reason === "removed"
        ? gateType === "APPLICATION"
          ? "eventDetail.inviteRemovedApplication"
          : "eventDetail.inviteRemovedPassword"
        : gateType === "APPLICATION"
          ? "eventDetail.inviteDeadApplication"
          : "eventDetail.inviteDeadPassword",
    ),
  );
  // A live region that MOUNTS with its text is often not announced
  // (VoiceOver, NVDA): the region mounts empty and the line arrives on the
  // next frame, as a change inside a region the screen reader already knows.
  const [text, setText] = useState("");
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setText(message));
    return () => window.cancelAnimationFrame(id);
  }, [message]);

  // Focus once the line is there (focus on an empty line reads nothing).
  const focusDecided = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !text || focusDecided.current) return;
    focusDecided.current = true;
    const active = document.activeElement;
    const nothingFocused = !active || active === document.body;
    if (takeFocus || nothingFocused) el.focus({ preventScroll: true });
    // Once: a later focus change is the guest's.
  }, [text, takeFocus]);

  return (
    <p
      ref={ref}
      tabIndex={-1}
      role="status"
      className="th-invite-dead"
      data-surface={surface}
      data-reason={reason}
      data-testid="invite-dead-notice"
    >
      {text}
    </p>
  );
}

InviteDeadNotice.displayName = "InviteDeadNotice";
