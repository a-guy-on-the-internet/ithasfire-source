"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { TamaguiElement } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { settingsSectionHref } from "@/app/account/settings/_lib/settings-routes";

import {
  INVITE_BLOCKED_REASON_KEYS,
  PASS_REASON_MAX_LENGTH,
  asOrgIdFor,
  identityKey,
  passReasonInput,
  refusalReasonOf,
  waitingNoteKey,
  type ActInvite,
  type InviteBlockedReason,
  type InviteIdentity,
  type InviteState,
} from "../_lib/invite-view";
import styles from "./act-invite.module.css";
import { InlineLink } from "./InlineLink";

// ─────────────────────────────────────────────────────────────────────────────
// The answer half of board I1. Renders ONLY the current state of the identity
// being answered (the desktop board's "Other states" strip is a design
// exhibit, not product). Every button shown is one the server allows
// (`canConfirm` / `canDecline` come from the same `judgeActAnswer` the
// mutations run); a refused answer is said in words instead.
// ─────────────────────────────────────────────────────────────────────────────

type Translate = ReturnType<typeof useTranslations>;

/** Focus a Tamagui element ref on web. Native has no `.focus()` on a frame. */
function focusRef(ref: React.RefObject<TamaguiElement | null>): void {
  (ref.current as unknown as { focus?: () => void } | null)?.focus?.();
}

function blockedText(t: Translate, reason: InviteBlockedReason): string {
  return String(t(INVITE_BLOCKED_REASON_KEYS[reason]));
}

function BlockedNote({
  t,
  reason,
}: {
  t: Translate;
  reason: InviteBlockedReason | null;
}) {
  if (!reason) return null;
  return (
    <Text variant="bodySmall" tone="muted" data-testid="act-invite-blocked">
      {blockedText(t, reason)}
    </Text>
  );
}

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Text
      variant="bodySmall"
      tone="error"
      role="alert"
      data-testid="act-invite-answer-error"
    >
      {message}
    </Text>
  );
}

// ── Pass / leave form ────────────────────────────────────────────────────────

type PassMode = "pass" | "leave";

/**
 * Not a `<form>`: nothing here submits natively (the buttons act on press),
 * and a form that unmounts on Back / on success logged "Form submission
 * canceled because the form is not connected".
 */
function PassForm({
  mode,
  pending,
  error,
  onSubmit,
  onBack,
}: {
  mode: PassMode;
  pending: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
  onBack: () => void;
}) {
  const t = useTranslations();
  const id = useId();
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const textareaId = `${id}-reason`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const finalId = `${id}-final`;

  return (
    <div
      role="group"
      aria-label={String(
        t(
          mode === "leave"
            ? "bookingActInvite.leave"
            : "bookingActInvite.passGroupLabel",
        ),
      )}
      className={styles.passForm}
      data-testid="act-invite-pass-form"
    >
      <label htmlFor={textareaId} className={styles.reasonLabel}>
        <Text variant="overline">
          {String(t("bookingActInvite.reasonLabel"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("bookingActInvite.optional"))}
        </Text>
      </label>
      {/* The server folds line breaks into spaces; a textarea still reads
          better for a sentence or two. */}
      <textarea
        ref={textareaRef}
        id={textareaId}
        className={styles.textarea}
        value={reason}
        maxLength={PASS_REASON_MAX_LENGTH}
        onChange={(event) => setReason(event.target.value)}
        aria-describedby={`${hintId} ${countId} ${finalId}`}
        disabled={pending}
        data-testid="act-invite-reason"
      />
      <div className={styles.reasonMeta}>
        <Text variant="bodySmall" tone="muted" id={hintId}>
          {String(t("bookingActInvite.reasonHint"))}
        </Text>
        <Text variant="overline" tone="muted" id={countId}>
          {String(
            t("bookingActInvite.reasonCounter", {
              count: reason.length,
              max: PASS_REASON_MAX_LENGTH,
            }),
          )}
        </Text>
      </div>
      <Text variant="body" weight="bold" id={finalId}>
        {String(
          t(
            mode === "leave"
              ? "bookingActInvite.leaveFinal"
              : "bookingActInvite.passFinal",
          ),
        )}
      </Text>
      <ErrorNote message={error} />
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="$4"
          disabled={pending}
          aria-busy={pending || undefined}
          data-testid="act-invite-pass-confirm"
          onPress={() => onSubmit(reason)}
        >
          {String(
            t(
              mode === "leave"
                ? "bookingActInvite.leave"
                : "bookingActInvite.pass",
            ),
          )}
        </Button>
        <Button
          variant="secondary"
          size="$4"
          disabled={pending}
          onPress={onBack}
          data-testid="act-invite-pass-back"
        >
          {String(t("bookingActInvite.back"))}
        </Button>
      </div>
    </div>
  );
}

// ── State panels ─────────────────────────────────────────────────────────────

function StatePanel({
  title,
  body,
  testId,
  panelRef,
  children,
}: {
  title: string;
  body: string;
  testId: string;
  panelRef: React.RefObject<HTMLDivElement | null>;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={styles.state}
      data-testid={testId}
      ref={panelRef}
      tabIndex={-1}
    >
      <Text variant="overline">{title}</Text>
      <Text variant="body">{body}</Text>
      {children}
    </div>
  );
}

// ── The answer block ─────────────────────────────────────────────────────────

export function InviteAnswer({
  invite,
  identity,
  state,
  placeName,
  senderName,
  onSelectIdentity,
}: {
  invite: ActInvite;
  identity: InviteIdentity;
  state: InviteState;
  placeName: string;
  senderName: string;
  onSelectIdentity: (key: string) => void;
}) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const selectId = useId();

  const [passMode, setPassMode] = useState<PassMode | null>(null);
  // A failure that is not a refusal (network, rate limit, …).
  const [error, setError] = useState<string | null>(null);
  // A refusal the server gave (the data moved under the page).
  const [refusal, setRefusal] = useState<InviteBlockedReason | null>(null);
  const passButtonRef = useRef<TamaguiElement | null>(null);
  const leaveButtonRef = useRef<TamaguiElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Set when an answer lands, so the new state's panel takes focus once the
  // refetched invite renders it (screen readers hear the outcome).
  const focusPanelOnStateChange = useRef(false);

  const currentKey = identityKey(identity);

  const clearFeedback = () => {
    setError(null);
    setRefusal(null);
  };

  // A different identity is a different answer: drop any open form / error.
  useEffect(() => {
    setPassMode(null);
    setError(null);
    setRefusal(null);
    focusPanelOnStateChange.current = false;
  }, [currentKey]);

  useEffect(() => {
    if (focusPanelOnStateChange.current && panelRef.current) {
      focusPanelOnStateChange.current = false;
      panelRef.current.focus();
    }
  }, [state]);

  const refetchInvite = () =>
    utils.bookingRequests.getActInvite.invalidate({
      bookingRequestId: invite.bookingRequestId,
    });

  const onAnswered = async (data: { changed: boolean }) => {
    // An idempotent repeat writes nothing, so no state change will come to
    // move focus; don't leave the flag armed for some later change.
    focusPanelOnStateChange.current = data.changed;
    clearFeedback();
    await refetchInvite();
    // Close the form only once the new state is in, so the old buttons don't
    // flash back and focus doesn't fall to <body> in between.
    setPassMode(null);
  };
  const onFailed = (err: unknown) => {
    const reason = refusalReasonOf(err);
    if (reason) {
      // A refusal usually flips the state (closed / passed / booked), which
      // unmounts the pressed button: let the new panel take focus.
      focusPanelOnStateChange.current = true;
      setError(null);
      setRefusal(reason);
    } else {
      setRefusal(null);
      setError(formatErrorMessage(err, (key) => String(t(key))));
    }
    // Whatever was refused, the page's copy of the invite is stale: refetch
    // so the buttons match what the server will accept.
    void refetchInvite();
  };

  // Synchronous double-submit guard: `isPending` only flips on the next
  // render, so a fast double tap would otherwise send two answers.
  const inFlight = useRef(false);
  const joinMutation = trpc.bookingRequests.joinAct.useMutation({
    onSuccess: onAnswered,
    onError: onFailed,
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const passMutation = trpc.bookingRequests.passAct.useMutation({
    onSuccess: onAnswered,
    onError: onFailed,
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const pending = joinMutation.isPending || passMutation.isPending;

  const asOrgId = asOrgIdFor(identity);
  const join = () => {
    if (pending || inFlight.current) return;
    inFlight.current = true;
    clearFeedback();
    joinMutation.mutate({
      bookingRequestId: invite.bookingRequestId,
      ...(asOrgId ? { asOrgId } : {}),
    });
  };
  const pass = (reason: string) => {
    if (pending || inFlight.current) return;
    inFlight.current = true;
    clearFeedback();
    const declineReason = passReasonInput(reason);
    passMutation.mutate({
      bookingRequestId: invite.bookingRequestId,
      ...(asOrgId ? { asOrgId } : {}),
      ...(declineReason ? { declineReason } : {}),
    });
  };
  const openForm = (mode: PassMode) => {
    clearFeedback();
    setPassMode(mode);
  };
  const closeForm = (mode: PassMode) => {
    setPassMode(null);
    clearFeedback();
    // Return focus to the control that opened the form.
    requestAnimationFrame(() =>
      focusRef(mode === "leave" ? leaveButtonRef : passButtonRef),
    );
  };

  // A refusal is shown unless the refetched data already says the same
  // thing through a blocked note.
  const shownBlocked = new Set<InviteBlockedReason | null>([
    identity.canConfirm ? null : identity.confirmBlockedReason,
    identity.canDecline ? null : identity.declineBlockedReason,
  ]);
  const refusalText =
    refusal && !shownBlocked.has(refusal) ? blockedText(t, refusal) : null;
  const formError = error ?? (refusal ? blockedText(t, refusal) : null);

  const settingsLink = (
    <Text variant="bodySmall" tone="muted">
      {String(t("bookingActInvite.noteNews"))}{" "}
      <InlineLink
        href={settingsSectionHref("notifications")}
        variant="bodySmall"
      >
        {String(t("bookingActInvite.notificationSettings"))}
      </InlineLink>
    </Text>
  );

  const identityLabel = (option: InviteIdentity): string => {
    const name =
      option.answeringAs.displayName ?? String(t("bookingActInvite.unnamed"));
    // The person row says "(you)", so it can't be mistaken for a group that
    // happens to share the name.
    return option.answeringAs.ownerType === "human"
      ? String(t("bookingActInvite.answeringAsYou", { name }))
      : name;
  };

  return (
    <div className={styles.answer} data-testid="act-invite-answer">
      {invite.identities.length > 1 && (
        <div className={styles.answeringAs}>
          <label htmlFor={selectId}>
            <Text variant="bodySmall">
              {String(t("bookingActInvite.answeringAs"))}
            </Text>
          </label>
          <select
            id={selectId}
            className={styles.select}
            value={currentKey}
            disabled={pending}
            onChange={(event) => onSelectIdentity(event.target.value)}
            data-testid="act-invite-identity"
          >
            {invite.identities.map((option) => (
              <option key={identityKey(option)} value={identityKey(option)}>
                {identityLabel(option)}
              </option>
            ))}
          </select>
        </div>
      )}

      {state === "waiting" && (
        <>
          {passMode === "pass" ? (
            <PassForm
              mode="pass"
              pending={pending}
              error={formError}
              onSubmit={pass}
              onBack={() => closeForm("pass")}
            />
          ) : (
            <>
              {(identity.canConfirm || identity.canDecline) && (
                <div className={styles.actions}>
                  {identity.canConfirm && (
                    <Button
                      variant="primary"
                      size="$5"
                      disabled={pending}
                      aria-busy={joinMutation.isPending || undefined}
                      onPress={join}
                      data-testid="act-invite-join"
                    >
                      {String(t("bookingActInvite.countMeIn"))}
                    </Button>
                  )}
                  {identity.canDecline && (
                    <Button
                      ref={passButtonRef}
                      variant="secondary"
                      size="$5"
                      disabled={pending}
                      onPress={() => openForm("pass")}
                      data-testid="act-invite-pass"
                    >
                      {String(t("bookingActInvite.pass"))}
                    </Button>
                  )}
                </div>
              )}
              <ErrorNote message={error ?? refusalText} />
              {!identity.canConfirm && (
                <BlockedNote t={t} reason={identity.confirmBlockedReason} />
              )}
              {!identity.canDecline &&
                identity.declineBlockedReason !==
                  identity.confirmBlockedReason && (
                  <BlockedNote t={t} reason={identity.declineBlockedReason} />
                )}
            </>
          )}
          <div className={styles.notes}>
            {/* While the pass form is open it already says passing is final. */}
            {passMode !== "pass" && (
              <Text variant="bodySmall" tone="muted">
                {String(t(waitingNoteKey(invite)))}
              </Text>
            )}
            {settingsLink}
          </div>
        </>
      )}

      {state === "joined" && (
        <>
          <StatePanel
            title={String(t("bookingActInvite.joinedTitle"))}
            body={String(t("bookingActInvite.joinedBody", { place: placeName }))}
            testId="act-invite-state-joined"
            panelRef={panelRef}
          >
            {passMode === "leave" ? null : identity.canDecline &&
              !identity.declineBlockedReason ? (
              <>
                <div className={styles.actions}>
                  <Button
                    ref={leaveButtonRef}
                    variant="secondary"
                    size="$4"
                    disabled={pending}
                    onPress={() => openForm("leave")}
                    data-testid="act-invite-leave"
                  >
                    {String(t("bookingActInvite.leave"))}
                  </Button>
                </div>
                <Text variant="bodySmall" tone="muted">
                  {String(t("bookingActInvite.leaveFinal"))}
                </Text>
                <ErrorNote message={error ?? refusalText} />
              </>
            ) : (
              <>
                <BlockedNote t={t} reason={identity.declineBlockedReason} />
                <ErrorNote message={error ?? refusalText} />
              </>
            )}
          </StatePanel>
          {passMode === "leave" && (
            <PassForm
              mode="leave"
              pending={pending}
              error={formError}
              onSubmit={pass}
              onBack={() => closeForm("leave")}
            />
          )}
          <div className={styles.notes}>{settingsLink}</div>
        </>
      )}

      {state === "passed" && (
        <StatePanel
          title={String(t("bookingActInvite.passedTitle"))}
          body={String(t("bookingActInvite.passedBody"))}
          testId="act-invite-state-passed"
          panelRef={panelRef}
        />
      )}

      {state === "closed" && (
        <StatePanel
          title={String(t("bookingActInvite.closedTitle"))}
          body={String(t("bookingActInvite.closedBody"))}
          testId="act-invite-state-closed"
          panelRef={panelRef}
        />
      )}

      {state === "booked" && (
        <>
          <StatePanel
            title={String(t("bookingActInvite.bookedTitle"))}
            body={String(
              t("bookingActInvite.bookedBody", {
                place: placeName,
                sender: senderName,
              }),
            )}
            testId="act-invite-state-booked"
            panelRef={panelRef}
          />
          <div className={styles.notes}>{settingsLink}</div>
        </>
      )}
    </div>
  );
}
