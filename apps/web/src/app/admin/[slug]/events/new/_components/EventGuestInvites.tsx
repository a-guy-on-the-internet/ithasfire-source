"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  Modal,
  StyledSelect,
  Text,
  TextInput,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/calendar/calendar-actions";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";

import {
  guestDisplayName,
  inviteErrorMessage,
  isStaleInviteError,
  looksLikeEmail,
  summarizeListSend,
  summarizeSingleSend,
  type InviteFeedbackTone,
  type InviteTranslate,
} from "./event-invite-helpers";
import type { TemplateOwnerRef } from "./ticket-type-template-helpers";
import {
  InvitePanel,
  InviteSection,
  InviteSectionTitle,
  VISUALLY_HIDDEN_STYLE,
  wrappingButtonProps,
} from "./_invite-styled";
import { FieldLabel } from "./_form-bits";
import { InvitePauseLiftedLine, InvitePauseNotice, useInvitePauseGate } from "./InvitePauseNotice";
import { isInvitesPausedError } from "./invite-pause-helpers";

/**
 * "Invited guests" in Settings → Access Gate (FR-002, FR-003, FR-006, R7–R9,
 * R13): add one guest by name + email, or send to a contact list; each guest
 * gets a personal link by email. Rows offer Copy link, Resend and Revoke; a
 * revoked row offers Invite again, which mints a fresh invite.
 */

export type GuestInviteStatus = "SENT" | "USED" | "REVOKED" | "UNSENT";

export type GuestInvite = {
  id: string;
  name: string | null;
  email: string;
  status: GuestInviteStatus;
  copyUrl: string | null;
};

export type EventGuestInvitesProps = {
  eventId: string;
  /** The EVENT's owner: whose contact lists the list picker offers. */
  owner: TemplateOwnerRef;
  guests: GuestInvite[];
};

type RowAction = "copy" | "resend" | "revoke" | "reinvite";
/** `info` renders muted like success (nothing went wrong, nothing was sent). */
type Feedback = { message: string; tone: InviteFeedbackTone } | null;

const STATUS_KEY: Record<GuestInviteStatus, string> = {
  SENT: "admin.ginStatusSent",
  USED: "admin.ginStatusUsed",
  REVOKED: "admin.ginStatusRevoked",
  UNSENT: "admin.ginStatusUnsent",
};

const STATUS_TONE: Record<
  GuestInviteStatus,
  "neutral" | "success" | "danger"
> = {
  SENT: "neutral",
  UNSENT: "neutral",
  USED: "success",
  REVOKED: "danger",
};

const COPIED_RESET_MS = 2000;

export function EventGuestInvites({
  eventId,
  owner,
  guests,
}: EventGuestInvitesProps) {
  const rawT = useTranslations();
  const t: InviteTranslate = useCallback(
    (key, values) => String(rawT(key, values)),
    [rawT],
  );
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();
  // Silent: every failure below is shown inline, next to what was pressed;
  // the global "Action failed" toast would say it a second time.
  const createGuestInvites = trpc.events.createGuestInvites.useMutation(
    { meta: { silent: true } },
  );
  const resendGuestInvite = trpc.events.resendGuestInvite.useMutation(
    { meta: { silent: true } },
  );
  const revokeGuestInvite = trpc.events.revokeGuestInvite.useMutation(
    { meta: { silent: true } },
  );
  const pause = useInvitePauseGate(eventId);

  const nameId = useId();
  const emailId = useId();
  const nameErrorId = useId();
  const emailErrorId = useId();
  const sendFeedbackId = useId();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<Feedback>(null);

  const [listDialogOpen, setListDialogOpen] = useState(false);
  const [listSummary, setListSummary] = useState<Feedback>(null);
  // A refetch that pauses invites unmounts the open list dialog (render gate
  // below). Close it for real too, or it would pop back open after a lift.
  useEffect(() => {
    if (!pause.canSend) setListDialogOpen(false);
  }, [pause.canSend]);

  const [rowPending, setRowPending] = useState<
    Record<string, RowAction | undefined>
  >({});
  const [rowFeedback, setRowFeedback] = useState<Record<string, Feedback>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<GuestInvite | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const refresh = useCallback(() => {
    void utils.invitePauses.status.invalidate({ eventId });
    return utils.events.listInvites.invalidate({ eventId });
  }, [eventId, utils]);

  const setRowState = useCallback(
    (id: string, action: RowAction | undefined) =>
      setRowPending((prev) => ({ ...prev, [id]: action })),
    [],
  );

  // Revoke swaps a row's buttons for "Invite again", and Invite again swaps
  // the whole row for the guest's new invite (the list keeps one row per
  // email, its newest invite). Either way the pressed button is gone after
  // the refetch, so focus moves to the first control of that email's row,
  // or to the section heading if the row is gone.
  const headingId = useId();
  const focusEmailAfterRefresh = useRef<string | null>(null);
  useEffect(() => {
    const email = focusEmailAfterRefresh.current;
    if (!email) return;
    focusEmailAfterRefresh.current = null;
    const row = guests.find((g) => g.email === email);
    const control = row
      ? document.querySelector<HTMLElement>(
          `[data-testid="guest-invite-row-${row.id}"] button:not([disabled])`,
        )
      : null;
    (control ?? document.getElementById(headingId))?.focus();
  }, [guests, headingId]);

  /**
   * Refetch, then let the effect above focus `email`'s row. The target is
   * dropped in `finally` when the refetch failed or left the list unchanged,
   * so it can't fire later on an unrelated update. It is NOT dropped
   * unconditionally: `invalidate()` can resolve before React commits the new
   * rows, and clearing then would cancel the focus move every time.
   */
  const refreshThenFocus = useCallback(
    async (email: string) => {
      const before = utils.events.listInvites.getData({ eventId })?.guests;
      focusEmailAfterRefresh.current = email;
      let changed = false;
      try {
        await refresh();
        changed =
          utils.events.listInvites.getData({ eventId })?.guests !== before;
      } finally {
        if (!changed) focusEmailAfterRefresh.current = null;
      }
    },
    [eventId, refresh, utils],
  );

  // ── Add one guest ─────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (sending) return;
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const nextNameError = trimmedName ? null : t("admin.ginNameRequired");
    const nextEmailError = looksLikeEmail(trimmedEmail)
      ? null
      : t("admin.ginEmailInvalid");
    setNameError(nextNameError);
    setEmailError(nextEmailError);
    setSendFeedback(null);
    if (nextNameError || nextEmailError) {
      document.getElementById(nextNameError ? nameId : emailId)?.focus();
      return;
    }
    setSending(true);
    try {
      const result = await createGuestInvites.mutateAsync({
        eventId,
        guests: [{ name: trimmedName, email: trimmedEmail }],
      });
      const feedback = summarizeSingleSend(result, trimmedEmail, t);
      setSendFeedback(feedback);
      if (feedback.tone === "success") {
        setName("");
        setEmail("");
        document.getElementById(nameId)?.focus();
      }
      await refresh();
    } catch (err) {
      setSendFeedback({ message: inviteErrorMessage(err, t), tone: "error" });
      if (isStaleInviteError(err)) void refresh();
    } finally {
      setSending(false);
    }
  }, [
    createGuestInvites,
    email,
    emailId,
    eventId,
    name,
    nameId,
    refresh,
    sending,
    t,
  ]);

  // ── Row actions ───────────────────────────────────────────────────────────

  const handleCopy = useCallback(
    (guest: GuestInvite) => {
      if (!guest.copyUrl) return;
      void copyText(guest.copyUrl).then((ok) => {
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        if (!ok) {
          setCopiedId(null);
          setRowFeedback((prev) => ({
            ...prev,
            [guest.id]: { message: t("admin.ginCopyFailed"), tone: "error" },
          }));
          return;
        }
        setRowFeedback((prev) => ({ ...prev, [guest.id]: null }));
        setCopiedId(guest.id);
        setAnnouncement(
          t("admin.ginGuestLinkCopied", { name: guestDisplayName(guest) }),
        );
        copiedTimer.current = setTimeout(
          () => setCopiedId(null),
          COPIED_RESET_MS,
        );
      });
    },
    [t],
  );

  const handleResend = useCallback(
    async (guest: GuestInvite) => {
      if (rowPending[guest.id]) return;
      setRowState(guest.id, "resend");
      setRowFeedback((prev) => ({ ...prev, [guest.id]: null }));
      try {
        const result = await resendGuestInvite.mutateAsync({
          eventId,
          inviteId: guest.id,
        });
        const feedback: Feedback = result.optedOut
          ? { message: t("admin.ginOptedOut"), tone: "info" }
          : result.sent
            ? {
                message: t("admin.ginResent", { email: guest.email }),
                tone: "success",
              }
            : { message: t("admin.ginSendFailedEmail"), tone: "error" };
        setRowFeedback((prev) => ({ ...prev, [guest.id]: feedback }));
        await refresh();
      } catch (err) {
        setRowFeedback((prev) => ({
          ...prev,
          [guest.id]: { message: inviteErrorMessage(err, t), tone: "error" },
        }));
        if (isStaleInviteError(err)) void refresh();
      } finally {
        setRowState(guest.id, undefined);
      }
    },
    [eventId, refresh, resendGuestInvite, rowPending, setRowState, t],
  );

  const handleReinvite = useCallback(
    async (guest: GuestInvite) => {
      if (rowPending[guest.id]) return;
      setRowState(guest.id, "reinvite");
      setRowFeedback((prev) => ({ ...prev, [guest.id]: null }));
      try {
        const result = await createGuestInvites.mutateAsync({
          eventId,
          guests: [{ name: guestDisplayName(guest), email: guest.email }],
        });
        const feedback = summarizeSingleSend(result, guest.email, t);
        // The new invite REPLACES the revoked row (one row per email, the
        // newest invite), so this row's feedback slot goes with it: the
        // message goes in the section's shared status line instead.
        setAnnouncement(feedback.message);
        setListSummary(feedback);
        await refreshThenFocus(guest.email);
      } catch (err) {
        setRowFeedback((prev) => ({
          ...prev,
          [guest.id]: { message: inviteErrorMessage(err, t), tone: "error" },
        }));
        if (isStaleInviteError(err)) void refresh();
      } finally {
        setRowState(guest.id, undefined);
      }
    },
    [
      createGuestInvites,
      eventId,
      refresh,
      refreshThenFocus,
      rowPending,
      setRowState,
      t,
    ],
  );

  const handleConfirmRevoke = useCallback(async () => {
    const guest = revokeTarget;
    if (!guest) return;
    setRowState(guest.id, "revoke");
    setRowFeedback((prev) => ({ ...prev, [guest.id]: null }));
    try {
      await revokeGuestInvite.mutateAsync({ eventId, inviteId: guest.id });
      setAnnouncement(
        t("admin.ginRevoked", { name: guestDisplayName(guest) }),
      );
      setRevokeTarget(null);
      await refreshThenFocus(guest.email);
    } catch (err) {
      setRevokeTarget(null);
      setRowFeedback((prev) => ({
        ...prev,
        [guest.id]: { message: inviteErrorMessage(err, t), tone: "error" },
      }));
      if (isStaleInviteError(err)) void refresh();
    } finally {
      setRowState(guest.id, undefined);
    }
  }, [
    eventId,
    refresh,
    refreshThenFocus,
    revokeGuestInvite,
    revokeTarget,
    setRowState,
    t,
  ]);

  const handleListSent = useCallback(
    (summary: Feedback) => {
      setListDialogOpen(false);
      setListSummary(summary);
      if (summary) setAnnouncement(summary.message);
      void refresh();
    },
    [refresh],
  );

  const buttonSize = isMobile ? "$4" : "$3";
  const rowButtonHeight = isMobile ? 44 : 36;

  return (
    <InviteSection data-testid="invited-guests-section">
      <InviteSectionTitle id={headingId} tabIndex={-1}>
        {t("admin.ginGuestsTitle")}
      </InviteSectionTitle>
      <InvitePanel>
        <InvitePauseLiftedLine gate={pause} />
        <Text style={{ fontSize: 13 }} tone="muted">
          {t("admin.ginGuestsDesc")}
        </Text>
        <InvitePauseNotice gate={pause} fallbackFocusId={headingId} />

        {/* Add one guest */}
        <YStack gap={8}>
          {pause.canSend ? (
          <XStack gap={8} alignItems="flex-end" flexWrap="wrap">
            <YStack gap={6} flexGrow={1} flexShrink={1} flexBasis={200} minWidth={0}>
              <label htmlFor={nameId} style={{ display: "block" }}>
                <FieldLabel>{t("admin.ginNameLabel")}</FieldLabel>
              </label>
              <TextInput
                id={nameId}
                value={name}
                onChangeText={(v: string) => {
                  setName(v);
                  if (nameError) setNameError(null);
                }}
                autoComplete="off"
                maxLength={120}
                fullWidth
                minHeight={44}
                required
                status={nameError ? "error" : undefined}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? nameErrorId : undefined}
                testId="guest-invite-name"
              />
            </YStack>
            <YStack gap={6} flexGrow={2} flexShrink={1} flexBasis={280} minWidth={0}>
              <label htmlFor={emailId} style={{ display: "block" }}>
                <FieldLabel>{t("admin.ginEmailLabel")}</FieldLabel>
              </label>
              <TextInput
                id={emailId}
                type="email"
                value={email}
                onChangeText={(v: string) => {
                  setEmail(v);
                  if (emailError) setEmailError(null);
                }}
                onSubmitEditing={() => {
                  void handleSend();
                }}
                autoComplete="off"
                inputMode="email"
                autoCapitalize="none"
                maxLength={254}
                fullWidth
                minHeight={44}
                required
                status={emailError ? "error" : undefined}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? emailErrorId : undefined}
                testId="guest-invite-email"
              />
            </YStack>
            <Button
              variant="secondary"
              size="$4"
              {...wrappingButtonProps(44)}
              onPress={() => {
                void handleSend();
              }}
              disabled={sending}
              aria-busy={sending || undefined}
              aria-describedby={sendFeedback ? sendFeedbackId : undefined}
              data-testid="guest-invite-send"
            >
              {sending ? t("admin.ginSending") : t("admin.ginSendInvite")}
            </Button>
          </XStack>
          ) : null}
          {nameError ? (
            <Text id={nameErrorId} style={{ fontSize: 12 }} tone="error">
              {nameError}
            </Text>
          ) : null}
          {emailError ? (
            <Text id={emailErrorId} style={{ fontSize: 12 }} tone="error">
              {emailError}
            </Text>
          ) : null}
          {sendFeedback ? (
            <Text
              id={sendFeedbackId}
              style={{ fontSize: 12 }}
              tone={sendFeedback.tone === "error" ? "error" : "muted"}
              role={sendFeedback.tone === "error" ? "alert" : "status"}
              data-testid="guest-invite-send-feedback"
            >
              {sendFeedback.message}
            </Text>
          ) : null}
        </YStack>

        {/* Send to a contact list */}
        {pause.canSend ? (
        <XStack gap={12} alignItems="center" flexWrap="wrap">
          <Button
            variant="secondary"
            size={buttonSize}
            {...wrappingButtonProps(isMobile ? 44 : 36)}
            onPress={() => {
              setListSummary(null);
              setListDialogOpen(true);
            }}
            data-testid="guest-invite-list-open"
          >
            {t("admin.ginInviteList")}
          </Button>
          <Text style={{ fontSize: 12, flexShrink: 1 }} tone="muted">
            {t("admin.ginInviteListHint")}
          </Text>
        </XStack>
        ) : null}
        {listSummary ? (
          <Text
            style={{ fontSize: 13 }}
            tone={listSummary.tone === "error" ? "error" : "muted"}
            data-testid="guest-invite-list-summary"
          >
            {listSummary.message}
          </Text>
        ) : null}

        {/* Guest rows */}
        {guests.length === 0 ? (
          <Text
            style={{ fontSize: 13 }}
            tone="muted"
            data-testid="guest-invites-empty"
          >
            {t("admin.ginGuestsEmpty")}
          </Text>
        ) : (
          <YStack
            tag="ul"
            borderTopWidth={2}
            borderTopColor="$borderColor"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
            aria-label={t("admin.ginGuestsTitle")}
            data-testid="guest-invites-list"
          >
            {guests.map((guest) => (
              <GuestRow
                key={guest.id}
                guest={guest}
                t={t}
                pending={rowPending[guest.id]}
                copied={copiedId === guest.id}
                feedback={rowFeedback[guest.id] ?? null}
                buttonHeight={rowButtonHeight}
                canSend={pause.canSend}
                onCopy={() => handleCopy(guest)}
                onResend={() => {
                  void handleResend(guest);
                }}
                onRevoke={() => setRevokeTarget(guest)}
                onReinvite={() => {
                  void handleReinvite(guest);
                }}
              />
            ))}
          </YStack>
        )}

        <span role="status" aria-live="polite" style={VISUALLY_HIDDEN_STYLE}>
          {announcement}
        </span>
      </InvitePanel>

      <ConfirmDialog
        open={revokeTarget !== null}
        onConfirm={() => {
          void handleConfirmRevoke();
        }}
        onCancel={() => setRevokeTarget(null)}
        title={t("admin.ginRevokeTitle")}
        description={
          revokeTarget
            ? t("admin.ginRevokeBody", {
                name: guestDisplayName(revokeTarget),
              })
            : ""
        }
        confirmLabel={t("admin.ginRevokeConfirm")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        loading={
          revokeTarget ? rowPending[revokeTarget.id] === "revoke" : false
        }
        loadingLabel={t("admin.ginRevoking")}
      />

      {listDialogOpen && pause.canSend ? (
        <ContactListInviteDialog
          eventId={eventId}
          owner={owner}
          t={t}
          onClose={() => setListDialogOpen(false)}
          onSent={handleListSent}
        />
      ) : null}
    </InviteSection>
  );
}

// ── One guest row ───────────────────────────────────────────────────────────

type GuestRowProps = {
  guest: GuestInvite;
  t: InviteTranslate;
  pending: RowAction | undefined;
  copied: boolean;
  feedback: Feedback;
  buttonHeight: number;
  /** False while invites are paused: Resend / Invite again would send email. */
  canSend: boolean;
  onCopy: () => void;
  onResend: () => void;
  onRevoke: () => void;
  onReinvite: () => void;
};

function GuestRow({
  guest,
  t,
  pending,
  copied,
  feedback,
  buttonHeight,
  canSend,
  onCopy,
  onResend,
  onRevoke,
  onReinvite,
}: GuestRowProps) {
  const display = guestDisplayName(guest);
  const revoked = guest.status === "REVOKED";
  const busy = pending !== undefined;
  const rowButton = {
    variant: "ghost" as const,
    size: "$3" as const,
    height: buttonHeight,
    minHeight: buttonHeight,
    paddingHorizontal: 10,
  };

  return (
    <YStack
      tag="li"
      gap={6}
      paddingVertical={12}
      borderBottomWidth={1}
      borderBottomColor="$borderColorSoft"
      data-testid={`guest-invite-row-${guest.id}`}
    >
      <XStack gap={16} alignItems="center" flexWrap="wrap">
        <YStack flexGrow={1} flexShrink={1} flexBasis={200} gap={2} minWidth={0}>
          <Text
            style={{ fontSize: 15, fontWeight: "600", overflowWrap: "anywhere" }}
            color="$color"
          >
            {guest.name?.trim() || guest.email}
          </Text>
          {guest.name?.trim() ? (
            <Text
              style={{ fontSize: 13, overflowWrap: "anywhere" }}
              tone="muted"
            >
              {guest.email}
            </Text>
          ) : null}
        </YStack>
        <Badge
          variant="outline"
          tone={STATUS_TONE[guest.status]}
          size="sm"
          minWidth={96}
          justifyContent="center"
          data-testid={`guest-invite-status-${guest.id}`}
        >
          {t(STATUS_KEY[guest.status])}
        </Badge>
        <XStack gap={4} flexWrap="wrap" flexShrink={1} minWidth={0}>
          {revoked ? (
            canSend ? (
            <Button
              {...rowButton}
              onPress={onReinvite}
              disabled={busy}
              aria-busy={pending === "reinvite" || undefined}
              aria-label={t("admin.ginInviteAgainFor", { name: display })}
              data-testid={`guest-invite-reinvite-${guest.id}`}
            >
              {pending === "reinvite"
                ? t("admin.ginSending")
                : t("admin.ginInviteAgain")}
            </Button>
            ) : null
          ) : (
            <>
              {guest.copyUrl ? (
                <Button
                  {...rowButton}
                  onPress={onCopy}
                  disabled={busy}
                  aria-label={
                    copied
                      ? t("admin.ginCopiedFor", { name: display })
                      : t("admin.ginCopyLinkFor", { name: display })
                  }
                  data-testid={`guest-invite-copy-${guest.id}`}
                >
                  {copied ? t("admin.ginCopied") : t("admin.ginCopyLink")}
                </Button>
              ) : null}
              {canSend ? (
              <Button
                {...rowButton}
                onPress={onResend}
                disabled={busy}
                aria-busy={pending === "resend" || undefined}
                aria-label={t("admin.ginResendFor", { name: display })}
                data-testid={`guest-invite-resend-${guest.id}`}
              >
                {pending === "resend"
                  ? t("admin.ginSending")
                  : t("admin.ginResend")}
              </Button>
              ) : null}
              <Button
                {...rowButton}
                variant="destructiveGhost"
                onPress={onRevoke}
                disabled={busy}
                aria-label={t("admin.ginRevokeFor", { name: display })}
                data-testid={`guest-invite-revoke-${guest.id}`}
              >
                {t("admin.ginRevoke")}
              </Button>
            </>
          )}
        </XStack>
      </XStack>
      {feedback ? (
        <Text
          style={{ fontSize: 12 }}
          tone={feedback.tone === "error" ? "error" : "muted"}
          role={feedback.tone === "error" ? "alert" : "status"}
          data-testid={`guest-invite-feedback-${guest.id}`}
        >
          {feedback.message}
        </Text>
      ) : null}
    </YStack>
  );
}

// ── Contact-list picker ─────────────────────────────────────────────────────

type ContactListInviteDialogProps = {
  eventId: string;
  owner: TemplateOwnerRef;
  t: InviteTranslate;
  onClose: () => void;
  onSent: (summary: Feedback) => void;
};

function ContactListInviteDialog({
  eventId,
  owner,
  t,
  onClose,
  onSent,
}: ContactListInviteDialogProps) {
  const selectId = useId();
  const hintId = useId();
  const [listId, setListId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Silent: the error line under the picker says it (role="alert").
  const createGuestInvites = trpc.events.createGuestInvites.useMutation(
    { meta: { silent: true } },
  );

  // The same contact-list query the announcement composer's picker uses.
  const listsQuery = trpc.comms.listAudiences.useQuery(
    {
      owner: {
        kind: owner.ownerScope === "ORGANIZATION" ? "ORG" : "HUMAN",
        id: owner.ownerId,
      },
    },
    { staleTime: 60_000 },
  );
  const lists = listsQuery.data ?? [];
  const sending = createGuestInvites.isPending;

  const handleSend = useCallback(async () => {
    if (!listId || sending) return;
    setError(null);
    try {
      const result = await createGuestInvites.mutateAsync({
        eventId,
        contactListId: listId,
      });
      onSent({ message: summarizeListSend(result, t), tone: "success" });
    } catch (err) {
      // Paused (W4): close, say it in the panel's summary line under the
      // notice; onSent refreshes, which refetches the pause status.
      if (isInvitesPausedError(err)) {
        onSent({ message: inviteErrorMessage(err, t, "list"), tone: "error" });
        return;
      }
      setError(inviteErrorMessage(err, t, "list"));
    }
  }, [createGuestInvites, eventId, listId, onSent, sending, t]);

  return (
    <Modal open onClose={sending ? () => {} : onClose}>
      <Modal.Panel width={440} data-testid="guest-invite-list-dialog">
        <Modal.Header
          title={t("admin.ginInviteList")}
          onClose={sending ? () => {} : onClose}
        />
        <Modal.Body>
          {listsQuery.isLoading ? (
            <Text style={{ fontSize: 13 }} tone="muted" role="status">
              {t("admin.ginListsLoading")}
            </Text>
          ) : listsQuery.isError ? (
            <YStack gap={8} alignItems="flex-start">
              <Text style={{ fontSize: 13 }} tone="error" role="alert">
                {t("admin.ginListsLoadError")}
              </Text>
              <Button
                variant="secondary"
                size="$3"
                onPress={() => {
                  void listsQuery.refetch();
                }}
              >
                {t("admin.ginRetry")}
              </Button>
            </YStack>
          ) : lists.length === 0 ? (
            <Text style={{ fontSize: 13 }} tone="muted">
              {t("admin.ginListsEmpty")}
            </Text>
          ) : (
            <YStack gap={6}>
              <label htmlFor={selectId} style={{ display: "block" }}>
                <FieldLabel>{t("admin.ginListLabel")}</FieldLabel>
              </label>
              <StyledSelect
                selectId={selectId}
                value={listId}
                options={lists.map((list) => ({
                  value: list.id,
                  label: list.name,
                }))}
                onChange={(value: string) => {
                  setListId(value);
                  setError(null);
                }}
                placeholder={t("admin.ginListPlaceholder")}
                ariaDescribedBy={hintId}
                disabled={sending}
                fullWidth
                borderRadius={0}
                minHeight={44}
                height={44}
                testId="guest-invite-list-select"
              />
              <Text id={hintId} style={{ fontSize: 12 }} tone="muted">
                {t("admin.ginInviteListHint")}
              </Text>
            </YStack>
          )}
          {error ? (
            <Text
              style={{ fontSize: 12 }}
              tone="error"
              role="alert"
              data-testid="guest-invite-list-error"
            >
              {error}
            </Text>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="ghost"
            size="$3"
            onPress={onClose}
            disabled={sending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="secondary"
            size="$3"
            onPress={() => {
              void handleSend();
            }}
            disabled={!listId || sending}
            aria-busy={sending || undefined}
            data-testid="guest-invite-list-send"
          >
            {sending ? t("admin.ginSending") : t("admin.ginListSend")}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

export default EventGuestInvites;
