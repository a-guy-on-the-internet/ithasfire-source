"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/calendar/calendar-actions";

import {
  inviteErrorMessage,
  type InviteGateType,
  type InviteTranslate,
} from "./event-invite-helpers";
import {
  InvitePanel,
  InviteSection,
  InviteSectionTitle,
  MONO_META_STYLE,
  VISUALLY_HIDDEN_STYLE,
  wrappingButtonProps,
} from "./_invite-styled";
import {
  SharedInviteResetDialog,
  type SharedInviteResetChoice,
} from "./SharedInviteResetDialog";

/**
 * "Invite link" in Settings → Access Gate (FR-001, R5, R6): the event's one
 * SHARED invite link. Off by default; Turn on mints it, Reset swaps it for a
 * new one, Turn off stops it. Turn off keeps everyone the old link let in
 * (FR-007). Reset asks first (SharedInviteResetDialog, board option B):
 * keep them (RESET, preselected) or remove them too (RESET_AND_REMOVE).
 */

export type SharedInvite = {
  id: string;
  url: string;
  redemptionCount: number;
};

type SharedAction = "ENABLE" | "RESET" | "RESET_AND_REMOVE" | "DISABLE";

const ANNOUNCE: Record<SharedAction, string> = {
  ENABLE: "admin.ginLinkTurnedOn",
  RESET: "admin.ginLinkWasReset",
  RESET_AND_REMOVE: "admin.ginLinkWasResetRemoved",
  DISABLE: "admin.ginLinkTurnedOff",
};

export type EventSharedInviteLinkProps = {
  eventId: string;
  gateType: InviteGateType;
  shared: SharedInvite | null;
};

const COPIED_RESET_MS = 2000;

export function EventSharedInviteLink({
  eventId,
  gateType,
  shared,
}: EventSharedInviteLinkProps) {
  const rawT = useTranslations();
  const t: InviteTranslate = useCallback(
    (key, values) => String(rawT(key, values)),
    [rawT],
  );
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();
  // Silent: every failure shows in the panel's error line.
  const setSharedInvite = trpc.events.setSharedInvite.useMutation({ meta: { silent: true } });

  const [pending, setPending] = useState<SharedAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetChoice, setResetChoice] =
    useState<SharedInviteResetChoice>("keep");

  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // The button that was pressed disappears when the link flips on or off, so
  // focus is put on the control that replaced it rather than lost to <body>.
  const turnOnRef = useRef<HTMLElement | null>(null);
  const copyRef = useRef<HTMLElement | null>(null);
  const focusAfter = useRef<"turnOn" | "copy" | null>(null);
  const isOn = shared !== null;
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    const node = target === "copy" ? copyRef.current : turnOnRef.current;
    if (node) {
      node.focus?.();
      focusAfter.current = null;
    }
  }, [isOn]);

  const runAction = useCallback(
    async (action: SharedAction) => {
      if (pending) return;
      setPending(action);
      setError(null);
      setCopied(false);
      setCopyFailed(false);
      try {
        await setSharedInvite.mutateAsync({ eventId, action });
        focusAfter.current =
          action === "DISABLE" ? "turnOn" : action === "ENABLE" ? "copy" : null;
        await utils.events.listInvites.invalidate({ eventId });
        setAnnouncement(t(ANNOUNCE[action]));
      } catch (err) {
        focusAfter.current = null;
        setError(inviteErrorMessage(err, t));
      } finally {
        setPending(null);
      }
    },
    [eventId, pending, setSharedInvite, t, utils],
  );

  const handleConfirmReset = useCallback(async () => {
    await runAction(resetChoice === "remove" ? "RESET_AND_REMOVE" : "RESET");
    // Closed either way: a failure shows in the panel's error line, and the
    // Modal hands focus back to Reset link.
    setResetOpen(false);
  }, [resetChoice, runAction]);

  const handleCopy = useCallback(() => {
    if (!shared) return;
    setCopyFailed(false);
    void copyText(shared.url).then((ok) => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (!ok) {
        setCopied(false);
        setCopyFailed(true);
        return;
      }
      setCopied(true);
      setAnnouncement(t("admin.ginLinkCopied"));
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [shared, t]);

  const busy = pending !== null;
  const buttonSize = isMobile ? "$4" : "$3";
  const isApplication = gateType === "APPLICATION";

  return (
    <InviteSection data-testid="invite-link-section">
      <InviteSectionTitle>{t("admin.ginLinkTitle")}</InviteSectionTitle>
      <InvitePanel>
        {shared ? (
          <>
            <Text style={{ fontSize: 13 }} tone="muted">
              {t(
                isApplication
                  ? "admin.ginLinkOnApplication"
                  : "admin.ginLinkOnPassword",
              )}
            </Text>
            <XStack gap={8} alignItems="stretch" flexWrap="wrap">
              <YStack
                flexGrow={1}
                flexShrink={1}
                flexBasis={isMobile ? 200 : 360}
                minWidth={0}
              >
                {/* Read-only and selectable, the same native-input pattern as
                    the team page's delegate invite link. Long URLs scroll
                    inside the box; the box itself shrinks to the column. */}
                <input
                  readOnly
                  value={shared.url}
                  aria-label={t("admin.ginLinkTitle")}
                  onFocus={(e) => e.currentTarget.select()}
                  data-testid="invite-link-url"
                  style={{
                    width: "100%",
                    minWidth: 0,
                    height: 44,
                    boxSizing: "border-box",
                    padding: "0 12px",
                    // TeamView's delegate-link frame, with the Stub fallback
                    // so first paint never shows the browser default.
                    background: "transparent",
                    border: "1px solid var(--borderColor, #211C16)",
                    borderRadius: 0,
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    color: "var(--color, #211C16)",
                    textOverflow: "ellipsis",
                  }}
                />
              </YStack>
              <Button
                ref={copyRef as never}
                variant="secondary"
                size="$4"
                onPress={handleCopy}
                disabled={busy}
                aria-label={
                  copied
                    ? t("admin.ginCopiedSharedA11y")
                    : t("admin.ginCopySharedA11y")
                }
                data-testid="invite-link-copy"
              >
                {copied ? t("admin.ginCopied") : t("admin.ginCopyLink")}
              </Button>
            </XStack>
            {copyFailed ? (
              <Text
                style={{ fontSize: 12 }}
                tone="error"
                role="alert"
                data-testid="invite-link-copy-failed"
              >
                {t("admin.ginCopyFailed")}
              </Text>
            ) : null}
            <XStack gap={8} alignItems="center" flexWrap="wrap">
              <Button
                variant="secondary"
                size={buttonSize}
                {...wrappingButtonProps(isMobile ? 44 : 36)}
                onPress={() => {
                  setResetChoice("keep");
                  setResetOpen(true);
                }}
                disabled={busy}
                aria-haspopup="dialog"
                data-testid="invite-link-reset"
              >
                {t("admin.ginLinkReset")}
              </Button>
              <Button
                variant="ghost"
                size={buttonSize}
                onPress={() => {
                  void runAction("DISABLE");
                }}
                disabled={busy}
                aria-busy={pending === "DISABLE" || undefined}
                aria-label={
                  pending === "DISABLE"
                    ? t("admin.ginLinkTurningOff")
                    : t("admin.ginLinkTurnOffA11y")
                }
                data-testid="invite-link-turn-off"
              >
                {pending === "DISABLE"
                  ? t("admin.ginLinkTurningOff")
                  : t("admin.ginLinkTurnOff")}
              </Button>
              <Text
                style={{ fontSize: 12, flexBasis: 240, flexGrow: 1 }}
                tone="muted"
              >
                {t("admin.ginLinkResetHint")}
              </Text>
            </XStack>
            <Text
              tone="muted"
              style={MONO_META_STYLE}
              data-testid="invite-link-meta"
            >
              {t("admin.ginLinkUsedMeta", { count: shared.redemptionCount })}
            </Text>
          </>
        ) : (
          <>
            <Text style={{ fontSize: 13 }} tone="muted">
              {t(
                isApplication
                  ? "admin.ginLinkOffApplication"
                  : "admin.ginLinkOffPassword",
              )}
            </Text>
            <XStack>
              <Button
                ref={turnOnRef as never}
                variant="secondary"
                size={buttonSize}
                {...wrappingButtonProps(isMobile ? 44 : 36)}
                onPress={() => {
                  void runAction("ENABLE");
                }}
                disabled={busy}
                aria-busy={pending === "ENABLE" || undefined}
                data-testid="invite-link-turn-on"
              >
                {pending === "ENABLE"
                  ? t("admin.ginLinkTurningOn")
                  : t("admin.ginLinkTurnOn")}
              </Button>
            </XStack>
          </>
        )}
        {error ? (
          <Text
            style={{ fontSize: 12 }}
            tone="error"
            role="alert"
            data-testid="invite-link-error"
          >
            {error}
          </Text>
        ) : null}
        <span role="status" aria-live="polite" style={VISUALLY_HIDDEN_STYLE}>
          {announcement}
        </span>
      </InvitePanel>

      <SharedInviteResetDialog
        open={resetOpen}
        value={resetChoice}
        running={pending === "RESET" || pending === "RESET_AND_REMOVE"}
        t={t}
        onChange={setResetChoice}
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          void handleConfirmReset();
        }}
      />
    </InviteSection>
  );
}

export default EventSharedInviteLink;
