"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Bookmark, BookmarkCheck, BookmarkX, Timer } from "lucide-react";

import { trpc } from "@/trpc";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { formatErrorMessage } from "@/lib/format-error-message";
import { isoDateToLocal } from "@/lib/booking-requests";
import { HOLD_ACTION_TOUCH, holdCountdown, holdPositionKey, liveHolds } from "./booking-holds";
import {
  actKeepView,
  isKeepChangedError,
  keepAnswerInput,
  type ActChallengeFacts,
  type ActKeepView,
} from "./act-keep-will";

// ─────────────────────────────────────────────────────────────────────────────
// THE ACT'S HOLDS (booking-holds spec 2026-08-25, FR-013).
//
// What the act sees of a line is ITS OWN PLACE in it — "Oct 13 — 2nd hold" —
// and nothing else: no calendar, no space, no other act, no length of line.
// The wire already enforces that (the performer-scope list row and
// `bookingHolds.listForRequest` viewer=act both project `{id, date, position,
// status, respondBy, lapsed}` and not one field more), and this component
// renders only what arrives. Do not add a calendar or space read here.
//
// ONE ACTION, TWO ANSWERS. When the venue challenges a hold the act has until
// `respondBy` to KEEP it (the clock stops, the hold stays) or RELEASE it (the
// line moves up). Nothing else is the act's to do: an unchallenged hold has
// no buttons, and a lapsed one reads as released, which is what the server
// will make it. Release is destructive, so it confirms first.
//
// ROW DATA IS THE LIST ROW'S, as on the venue side: `holds` arrive on the
// `bookingRequests.list` row, so opening a request issues no extra read.
// Answering invalidates that list, the act-side reader
// (`bookingHolds.listForRequest`) and the thread — the answer writes a ledger
// line the thread must show.
//
// KEEP IS A COMMIT (booking-the-night N19 / FR-014). What Keep does is the
// server's answer, read per challenged hold from `bookingHolds.listForRequest`
// (viewer "act": `keepWill` / `kept` / `respondBy`) — the list row does not
// carry it. book_now: "Keep — agree & book" (keeping agrees the terms the act
// was sent and books the night); ask_for_terms: Keep asks the place for
// terms. The panel sends back `expectedKeepWill` equal to what it showed (the
// server refuses a booking keep without it), and a "Keep changed" refusal
// refetches and shows the new choice instead of retrying. See act-keep-will.ts.
//
// RENDERS NOTHING WITH NO HOLDS. A "no holds" line on every sent request would
// read as a status rather than an absence.
// ─────────────────────────────────────────────────────────────────────────────

/** The act-side projection: what the list row and `listForRequest` both carry. */
export type ActHold = {
  id: string;
  /** ISO `YYYY-MM-DD`, place-local. */
  date: string;
  position: number;
  status: "ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED";
  respondBy: Date | null;
  lapsed: boolean;
};

/** Codes that mean "the hold moved on without you" — refresh, don't scold. */
const STALE_CODES = new Set([
  "BOOKING_HOLD_NOT_LIVE",
  "BOOKING_HOLD_NOT_CHALLENGED",
  "BOOKING_HOLD_CHALLENGE_LAPSED",
  "HOLD_LINE_CHANGED",
]);

export function ActHoldsPanel({
  bookingRequestId,
  holds,
  testIdBase = "act-holds",
}: {
  bookingRequestId: string;
  holds: readonly ActHold[];
  testIdBase?: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // `liveHolds` wants the venue summary shape; `calendarId` is null for the
  // act by contract, so it is supplied here rather than widened on the wire.
  const live = useMemo(
    () => liveHolds(holds.map((h) => ({ ...h, calendarId: null }))),
    [holds],
  );
  // A lapsed challenge is released in every sense that matters; it is shown
  // once, muted, so the act learns WHY the hold went rather than watching it
  // vanish. Server-projected `lapsed` only — no local clock arithmetic.
  const lapsed = useMemo(
    () => holds.filter((h) => h.status === "CHALLENGED" && h.lapsed),
    [holds],
  );

  // Minute tick while a challenge clock is running (same as the venue strip).
  const [now, setNow] = useState(() => new Date());
  const hasClock = live.some((h) => h.status === "CHALLENGED");
  useEffect(() => {
    if (!hasClock) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [hasClock]);

  const invalidateAll = useCallback(() => {
    void utils.bookingRequests.list.invalidate();
    void utils.bookingHolds.listForRequest.invalidate({ bookingRequestId });
    void utils.bookingRequests.messages.list.invalidate({ bookingRequestId });
  }, [bookingRequestId, utils]);

  // The act's own read, only while a challenge is live: it is the one that
  // says what Keep will do. Every answer invalidates it (invalidateAll).
  const challengeRead = trpc.bookingHolds.listForRequest.useQuery(
    { bookingRequestId, viewer: "act" },
    { enabled: hasClock, retry: false, meta: { silent: true } },
  );
  const challengeFacts = useMemo(() => {
    const data = challengeRead.data;
    if (data?.viewer !== "act") return null;
    const map = new Map<string, ActChallengeFacts & { respondBy: Date | null }>();
    for (const h of data.holds) {
      map.set(h.id, { keepWill: h.keepWill, kept: h.kept, respondBy: h.respondBy });
    }
    return map;
  }, [challengeRead.data]);
  const readStatus: "loading" | "error" | "success" = challengeRead.isError
    ? "error"
    : challengeRead.isSuccess
      ? "success"
      : "loading";

  const [pendingHoldId, setPendingHoldId] = useState<string | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<ActHold | null>(null);

  // The callbacks live on `useMutation`, NOT on `mutate()`. Callbacks handed
  // to `mutate()` are dropped once the observer unmounts, and this panel DOES
  // unmount mid-flight: SentBookingRequestsList moves it between two slots
  // when the thread opens or closes. Mutation-level callbacks run on the
  // Mutation itself, so the toast and the invalidation still land. The state
  // setters are React's own and are no-ops on an unmounted component.
  const answerMutation = trpc.bookingHolds.answer.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: (data, { answer: choice }) => {
      const outcome = (data as { keepOutcome?: string | null } | undefined)?.keepOutcome;
      toast.success({
        id: `act-hold-${choice}`,
        title: String(
          t(
            choice === "release"
              ? "booking.actHoldReleasedToast"
              : outcome === "booked"
                ? "booking.actHoldKeptBookedToast"
                : outcome === "awaiting_terms"
                  ? "booking.actHoldKeptAskedToast"
                  : "booking.actHoldKeptToast",
          ),
        ),
      });
    },
    onError: (err) => {
      const appCode = (err as { data?: { appCode?: string } | null })?.data?.appCode;
      if (isKeepChangedError(err)) {
        // What Keep does changed after the act looked (terms arrived, were
        // pulled back, or were agreed). Never retried: the refetch below
        // (onSettled) puts the new choice on screen for the act to read.
        toast.warning({
          id: "act-hold-keep-changed",
          title: String(t("booking.actHoldKeepChanged")),
        });
      } else if (appCode && STALE_CODES.has(appCode)) {
        toast.warning({
          id: "act-hold-stale",
          title: String(t("booking.actHoldChanged")),
        });
      } else {
        // FORBIDDEN and everything else: the code's own `errors.*` copy.
        toast.danger({
          id: "act-hold-failed",
          title: String(t("booking.actHoldAnswerFailed")),
          message: formatErrorMessage(err, t),
        });
      }
    },
    onSettled: () => {
      setPendingHoldId(null);
      setReleaseTarget(null);
      // Success and failure both refresh: a stale error means the row on
      // screen is wrong, and a success wrote a ledger line.
      invalidateAll();
    },
  });
  const busy = answerMutation.isPending;

  const release = useCallback(
    (hold: ActHold) => {
      if (busy) return;
      setPendingHoldId(hold.id);
      answerMutation.mutate({ holdId: hold.id, answer: "release" });
    },
    [answerMutation, busy],
  );
  /** Keep sends back exactly the choice on screen; no choice, no call. */
  const keep = useCallback(
    (hold: ActHold, view: ActKeepView) => {
      const input = keepAnswerInput(hold.id, view);
      if (busy || !input) return;
      setPendingHoldId(hold.id);
      answerMutation.mutate(input);
    },
    [answerMutation, busy],
  );

  if (live.length === 0 && lapsed.length === 0) return null;

  const dayLabel = (iso: string) =>
    fmt.dateTime(isoDateToLocal(iso), { dateStyle: "medium" });
  const stampLabel = (d: Date) =>
    fmt.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const ordinal = (position: number) =>
    String(t(holdPositionKey(position), { position: String(position) }));

  return (
    <YStack gap="$2" minWidth={0} data-testid={testIdBase}>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Bookmark
          size={13}
          strokeWidth={2}
          aria-hidden
          style={{ opacity: 0.7, flexShrink: 0 }}
        />
        <Text variant="overline" tone="muted">
          {String(t("booking.actHoldsHeading"))}
        </Text>
      </XStack>

      <YStack
        gap={0}
        borderWidth={1}
        borderColor="$borderColor"
        backgroundColor="$surface"
        role="list"
        aria-label={String(t("booking.actHoldsHeading"))}
        data-testid={`${testIdBase}-list`}
      >
        {live.map((hold, index) => {
          const countdown = holdCountdown(hold, now);
          const challenged = hold.status === "CHALLENGED" && countdown && countdown.kind !== "lapsed";
          const isPending = pendingHoldId === hold.id;
          return (
            <YStack
              key={hold.id}
              role="listitem"
              gap="$2"
              padding="$3"
              borderTopWidth={index === 0 ? 0 : 1}
              borderTopColor="$borderColor"
              minWidth={0}
              data-testid={`${testIdBase}-row-${hold.id}`}
              data-status={hold.status}
            >
              <XStack gap="$2" alignItems="center" flexWrap="wrap" minWidth={0}>
                <Text
                  variant="bodySmall"
                  weight="bold"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {String(
                    t("booking.actHoldLine", {
                      date: dayLabel(hold.date),
                      position: ordinal(hold.position),
                    }),
                  )}
                </Text>
                {challenged ? (
                  <XStack
                    gap="$1"
                    alignItems="center"
                    paddingHorizontal="$2"
                    minHeight={22}
                    borderWidth={1}
                    borderColor="$warning"
                    data-testid={`${testIdBase}-clock-${hold.id}`}
                  >
                    <Timer size={11} strokeWidth={2} aria-hidden color="currentColor" />
                    <Text
                      variant="caption"
                      weight="bold"
                      fontSize={10}
                      letterSpacing={0.6}
                      textTransform="uppercase"
                      color="$warning"
                    >
                      {countdown.kind === "hours"
                        ? String(t("admin.bkHoldHoursLeft", { hours: countdown.hours }))
                        : String(t("admin.bkHoldMinutesLeft", { minutes: countdown.minutes }))}
                    </Text>
                  </XStack>
                ) : null}
              </XStack>

              {challenged ? (
                <ChallengedHoldActions
                  hold={hold}
                  view={actKeepView({ holdId: hold.id, status: readStatus, facts: challengeFacts })}
                  respondBy={challengeFacts?.get(hold.id)?.respondBy ?? hold.respondBy}
                  busy={busy}
                  keepPending={isPending && releaseTarget === null}
                  stampLabel={stampLabel}
                  dayLabel={dayLabel}
                  onKeep={keep}
                  onRelease={() => setReleaseTarget(hold)}
                  onRecheck={() => void challengeRead.refetch()}
                  testIdBase={testIdBase}
                />
              ) : null}
            </YStack>
          );
        })}

        {lapsed.map((hold, index) => (
          <YStack
            key={hold.id}
            role="listitem"
            gap="$1"
            padding="$3"
            borderTopWidth={index === 0 && live.length === 0 ? 0 : 1}
            borderTopColor="$borderColor"
            minWidth={0}
            data-testid={`${testIdBase}-row-${hold.id}`}
            data-status="LAPSED"
          >
            <Text
              variant="bodySmall"
              tone="muted"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {String(
                t("booking.actHoldLine", {
                  date: dayLabel(hold.date),
                  position: ordinal(hold.position),
                }),
              )}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("booking.actHoldLapsedLine"))}
            </Text>
          </YStack>
        ))}
      </YStack>

      <ConfirmDialog
        open={releaseTarget !== null}
        tone="danger"
        onConfirm={() => releaseTarget && release(releaseTarget)}
        onCancel={() => setReleaseTarget(null)}
        title={String(t("booking.actHoldReleaseConfirmTitle"))}
        description={
          releaseTarget
            ? String(
                t("booking.actHoldReleaseConfirmBody", {
                  date: dayLabel(releaseTarget.date),
                }),
              )
            : ""
        }
        confirmLabel={String(t("booking.actHoldRelease"))}
        cancelLabel={String(t("common.cancel"))}
        loading={busy}
        loadingLabel={String(t("common.loading"))}
      />
    </YStack>
  );
}

/**
 * A live challenge on one of the act's holds: what Keep will do, the
 * absolute deadline, and the two answers. Keep is the emphasized one;
 * Release is the quieter twin and confirms first. One emphasized button.
 */
function ChallengedHoldActions({
  hold,
  view,
  respondBy,
  busy,
  keepPending,
  stampLabel,
  dayLabel,
  onKeep,
  onRelease,
  onRecheck,
  testIdBase,
}: {
  hold: ActHold;
  view: ActKeepView;
  respondBy: Date | null;
  busy: boolean;
  keepPending: boolean;
  stampLabel: (d: Date) => string;
  dayLabel: (iso: string) => string;
  onKeep: (hold: ActHold, view: ActKeepView) => void;
  onRelease: () => void;
  onRecheck: () => void;
  testIdBase: string;
}) {
  const t = useTranslations();
  const deadline = respondBy ? stampLabel(new Date(respondBy)) : null;
  // Every button is named by its date: two challenged holds otherwise give
  // two identically named buttons (same rule as the venue strip).
  const date = dayLabel(hold.date);
  const canKeep = view.kind === "book_now" || view.kind === "ask_for_terms";

  // The sentence above the buttons: what happens if the act keeps, or why
  // there is no Keep. Always the server's answer, never a guess.
  const line = (() => {
    switch (view.kind) {
      case "book_now":
        return String(t("booking.actHoldKeepWillBook"));
      case "ask_for_terms":
        return String(t("booking.actHoldKeepWillAsk"));
      case "kept":
        return deadline
          ? String(t("booking.actHoldKeptAwaiting", { date: deadline }))
          : String(t("booking.actHoldKeptAwaitingNoDate"));
      case "agreed":
        return String(t("booking.actHoldTermsAgreedLine"));
      case "loading":
        return String(t("booking.actHoldKeepChecking"));
      case "unknown":
        return String(t("booking.actHoldKeepUnknown"));
    }
  })();

  return (
    <>
      {deadline && view.kind !== "kept" ? (
        <Text variant="caption" tone="muted">
          {String(t("booking.actHoldKeepOrReleaseBy", { date: deadline }))}
        </Text>
      ) : null}
      <Text
        variant="bodySmall"
        weight={view.kind === "book_now" ? "bold" : undefined}
        tone={view.kind === "loading" || view.kind === "unknown" ? "muted" : undefined}
        data-testid={`${testIdBase}-keep-will-${hold.id}`}
        data-keep-will={view.kind}
      >
        {line}
      </Text>
      <XStack gap="$2" flexWrap="wrap" alignItems="center">
        {canKeep ? (
          <Button
            variant="secondary"
            size="$2"
            $sm={HOLD_ACTION_TOUCH}
            disabled={busy}
            aria-label={String(
              t(view.kind === "book_now" ? "booking.actHoldKeepAndBookAction" : "booking.actHoldKeepAction", {
                date,
              }),
            )}
            onPress={() => onKeep(hold, view)}
            testID={`${testIdBase}-keep-${hold.id}`}
          >
            {keepPending ? (
              <Spinner size="sm" />
            ) : (
              <>
                <BookmarkCheck size={13} strokeWidth={2} aria-hidden />
                {String(
                  t(view.kind === "book_now" ? "booking.actHoldKeepAndBook" : "booking.actHoldKeep"),
                )}
              </>
            )}
          </Button>
        ) : null}
        {view.kind === "unknown" ? (
          <Button
            variant="ghost"
            size="$2"
            $sm={HOLD_ACTION_TOUCH}
            disabled={busy}
            aria-label={String(t("booking.actHoldKeepRecheckAction", { date }))}
            onPress={onRecheck}
            testID={`${testIdBase}-recheck-${hold.id}`}
          >
            {String(t("booking.actHoldKeepRecheck"))}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="$2"
          $sm={HOLD_ACTION_TOUCH}
          disabled={busy}
          aria-label={String(t("booking.actHoldReleaseAction", { date }))}
          onPress={onRelease}
          testID={`${testIdBase}-release-${hold.id}`}
        >
          <BookmarkX size={13} strokeWidth={2} aria-hidden />
          {String(t("booking.actHoldRelease"))}
        </Button>
      </XStack>
    </>
  );
}
