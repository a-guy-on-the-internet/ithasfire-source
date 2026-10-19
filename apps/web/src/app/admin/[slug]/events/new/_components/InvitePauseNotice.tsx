"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { YStack } from "tamagui";
import {
  Button,
  CharCountTextarea,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import {
  canSendInvites,
  deriveInvitePauseView,
  isStaleReviewRequestError,
  type InvitePauseView,
} from "./invite-pause-helpers";
import { wrappingButtonProps } from "./_invite-styled";

/**
 * Invite complaint auto-pause (W4, board option A) on the "Invited guests"
 * panel. When too many people mark this organiser's invite emails as spam,
 * the server stops sending them; this notice takes the place of the send
 * controls, says why in plain numbers, and offers "Ask for a review". Guest
 * rows stay (copy link, revoke); resend goes. No email tells the organiser:
 * this panel and in-app notifications are the whole channel.
 *
 * `useInvitePauseGate` owns the status read; EventGuestInvites uses its
 * `canSend` to hide every control that would send an invite email.
 */

/** Server cap on the organiser's review note (REVIEW_NOTE_MAX in core). */
const REVIEW_NOTE_MAX = 1000;

const PRE_WRAP = { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const };

export type InvitePauseGate = {
  eventId: string;
  view: InvitePauseView;
  /** False while paused AND while the status is still loading. */
  canSend: boolean;
  /**
   * True on the render where sending was possible and no longer is (a send
   * raced a new pause): the send controls unmount, so a notice that mounts
   * now takes focus if it was lost. Never on first load.
   */
  justPaused: boolean;
};

export function useInvitePauseGate(eventId: string): InvitePauseGate {
  const statusQuery = trpc.invitePauses.status.useQuery(
    { eventId },
    { staleTime: 30_000 },
  );
  const { isPending, isError, data } = statusQuery;
  const view = useMemo(
    () => deriveInvitePauseView({ isPending, isError, data }, new Date()),
    [isPending, isError, data],
  );
  const canSend = canSendInvites(view);
  // Compared during render: the notice's mount effect (a child) runs before
  // any effect of the panel that owns this hook.
  const lastCanSend = useRef<boolean | null>(null);
  const justPaused = lastCanSend.current === true && !canSend;
  useEffect(() => {
    lastCanSend.current = canSend;
  }, [canSend]);
  return useMemo(
    () => ({ eventId, view, canSend, justPaused }),
    [eventId, view, canSend, justPaused],
  );
}

/** Focus fell to <body> because the focused control just unmounted. */
function focusWasLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/** A calendar date in the viewer's locale ("October 7, 2026"). */
function useDateLabel() {
  const fmt = useFormatters();
  return useCallback(
    (date: Date) => fmt.dateTime(date, { dateStyle: "long" }),
    [fmt],
  );
}

/** "Our team lifted the pause on {date}": one muted line, top of the panel. */
export function InvitePauseLiftedLine({ gate }: { gate: InvitePauseGate }) {
  if (gate.view.kind !== "lifted") return null;
  return <LiftedLine liftedAt={gate.view.liftedAt} />;
}

function LiftedLine({ liftedAt }: { liftedAt: Date }) {
  const t = useTranslations();
  const formatDate = useDateLabel();
  return (
    <Text
      role="status"
      tone="muted"
      style={{ fontSize: 12 }}
      data-testid="invite-pause-lifted"
    >
      {String(
        t("admin.ginPauseLifted", { date: formatDate(liftedAt) }),
      )}
    </Text>
  );
}

export function InvitePauseNotice({
  gate,
  fallbackFocusId,
}: {
  gate: InvitePauseGate;
  /**
   * Id of a focusable element that outlives the notice (the panel heading).
   * When the pause ends while focus is inside the notice, focus moves there
   * instead of falling to <body>.
   */
  fallbackFocusId?: string;
}) {
  const { view } = gate;
  if (view.kind !== "paused" && view.kind !== "requested" && view.kind !== "kept") {
    return null;
  }
  return (
    <PausedNotice
      eventId={gate.eventId}
      view={view}
      takeFocus={gate.justPaused}
      fallbackFocusId={fallbackFocusId}
    />
  );
}

type PausedView = Extract<InvitePauseView, { kind: "paused" | "requested" | "kept" }>;

function PausedNotice({
  eventId,
  view,
  takeFocus,
  fallbackFocusId,
}: {
  eventId: string;
  view: PausedView;
  takeFocus: boolean;
  fallbackFocusId?: string;
}) {
  const t = useTranslations();
  const formatDate = useDateLabel();
  const utils = trpc.useUtils();
  const titleId = useId();
  const noteId = useId();
  const errorId = useId();
  const sectionId = useId();
  const titleRef = useRef<HTMLElement | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A send / resend / list send raced a new pause: the pressed control is
  // gone, so land on the title that says why.
  const takeFocusOnMount = useRef(takeFocus);
  useEffect(() => {
    if (takeFocusOnMount.current && focusWasLost()) titleRef.current?.focus();
  }, []);

  // The pause ended (lift, or a stale review request refetched to "open")
  // while focus sat inside the notice: the title or the pressed button. A
  // layout cleanup runs before the notice leaves the DOM, so focus can still
  // be seen inside it; move it to the panel heading rather than <body>. The
  // move waits a microtask and only happens if the section really left the
  // DOM: StrictMode's dev-only simulated unmount keeps it connected, and
  // focus must stay on the title there.
  const fallbackFocusIdRef = useRef(fallbackFocusId);
  useEffect(() => {
    fallbackFocusIdRef.current = fallbackFocusId;
  }, [fallbackFocusId]);
  useLayoutEffect(
    () => () => {
      const section = document.getElementById(sectionId);
      if (!section?.contains(document.activeElement)) return;
      queueMicrotask(() => {
        if (section.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const fallbackId = fallbackFocusIdRef.current;
        if (fallbackId) document.getElementById(fallbackId)?.focus();
      });
    },
    [sectionId],
  );

  // Silent: the failure shows inline under the button (role="alert").
  const requestReview = trpc.invitePauses.requestReview.useMutation({
    meta: { silent: true },
  });
  const sending = requestReview.isPending;

  const handleRequest = useCallback(async () => {
    if (sending) return;
    setError(null);
    try {
      const trimmed = note.trim();
      const next = await requestReview.mutateAsync({
        eventId,
        note: trimmed ? trimmed : null,
      });
      utils.invitePauses.status.setData({ eventId }, next);
      setNote("");
      // The button is gone after this; land on the notice's title, which now
      // says a review was asked for.
      titleRef.current?.focus();
    } catch (err) {
      if (isStaleReviewRequestError(err)) {
        // Another editor asked, or the pause ended: the fresh status says so.
        // The button is gone after the refetch; land on the title. If the
        // pause ended, the notice unmounts and its layout cleanup above moves
        // focus on to the panel heading.
        await utils.invitePauses.status.invalidate({ eventId });
        titleRef.current?.focus();
        return;
      }
      setError(formatErrorMessage(err, (key) => String(t(key))));
    }
  }, [eventId, note, requestReview, sending, t, utils]);

  const title =
    view.kind === "kept"
      ? t("admin.ginPauseTitleKept")
      : t("admin.ginPauseTitle");
  const canAsk = view.kind !== "requested";

  return (
    <YStack
      tag="section"
      id={sectionId}
      aria-labelledby={titleId}
      borderWidth={2}
      borderColor="$borderColor"
      borderLeftWidth={6}
      borderLeftColor="$accent"
      backgroundColor="$surface"
      borderRadius={0}
      padding={14}
      gap={10}
      minWidth={0}
      data-testid="invite-pause-notice"
      data-state={view.kind}
    >
      {/* The live region holds the words only: a textarea inside it would
          have its typing re-announced. */}
      <YStack role="status" gap={10} minWidth={0}>
        <Text
          id={titleId}
          tabIndex={-1}
          ref={(node) => {
            titleRef.current = node as unknown as HTMLElement | null;
          }}
          color="$color"
          style={{ fontSize: 15, fontWeight: "700", overflowWrap: "anywhere" }}
        >
          {String(title)}
        </Text>

        {view.kind === "paused" ? (
          <Text color="$color" style={{ fontSize: 13 }}>
            {String(
              // Same guard as the core copy: "1 of the 0 people" reads as
              // nonsense when the sends behind the rate aren't countable.
              view.reason === "COMPLAINT_RATE" &&
                view.recipientCount > view.complaintCount
                ? t("admin.ginPauseBodyRate", {
                    count: view.complaintCount,
                    invited: view.recipientCount,
                    days: view.windowDays,
                  })
                : t("admin.ginPauseBodyCount", {
                    count: view.complaintCount,
                    days: view.windowDays,
                  }),
            )}
          </Text>
        ) : null}

        {view.kind === "requested" ? (
          <Text color="$color" style={{ fontSize: 13 }}>
            {String(
              t("admin.ginPauseRequested", {
                date: formatDate(view.requestedAt),
              }),
            )}
          </Text>
        ) : null}

        {view.kind === "kept" ? (
          <YStack gap={8} minWidth={0}>
            <Text color="$color" style={{ fontSize: 13 }}>
              {String(
                t("admin.ginPauseKeptIntro", {
                  date: formatDate(view.decidedAt),
                }),
              )}
            </Text>
            {view.note ? (
              <YStack
                tag="blockquote"
                borderLeftWidth={3}
                borderLeftColor="$borderColor"
                paddingLeft={10}
                margin={0}
                minWidth={0}
                data-testid="invite-pause-staff-note"
              >
                <Text color="$color" style={{ fontSize: 13, ...PRE_WRAP }}>
                  {view.note}
                </Text>
              </YStack>
            ) : null}
          </YStack>
        ) : null}

        <Text tone="muted" style={{ fontSize: 13 }}>
          {String(t("admin.ginPauseStillWorks"))}
        </Text>
      </YStack>

      {canAsk ? (
        <YStack gap={10} alignItems="flex-start" minWidth={0}>
          <YStack gap={6} alignSelf="stretch" minWidth={0}>
            <label htmlFor={noteId} style={{ display: "block" }}>
              <Text variant="overline" tag="span">
                {String(t("admin.ginPauseNoteLabel"))}
              </Text>
            </label>
            <CharCountTextarea
              id={noteId}
              value={note}
              onChange={setNote}
              maxLength={REVIEW_NOTE_MAX}
              minHeight={72}
              disabled={sending}
              testIdBase="invite-pause-note"
            />
          </YStack>
          <Button
            variant="primary"
            size="$4"
            {...wrappingButtonProps(44)}
            onPress={() => {
              void handleRequest();
            }}
            disabled={sending}
            aria-busy={sending || undefined}
            aria-describedby={error ? errorId : undefined}
            data-testid="invite-pause-request"
          >
            {String(
              sending
                ? t("admin.ginPauseRequesting")
                : view.kind === "kept"
                  ? t("admin.ginPauseAskAgain")
                  : t("admin.ginPauseAsk"),
            )}
          </Button>
          {error ? (
            <Text
              id={errorId}
              role="alert"
              tone="error"
              style={{ fontSize: 12 }}
              data-testid="invite-pause-request-error"
            >
              {error}
            </Text>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  );
}

export default InvitePauseNotice;
