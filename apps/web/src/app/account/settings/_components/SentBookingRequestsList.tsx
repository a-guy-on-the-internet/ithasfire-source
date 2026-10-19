"use client";

import { useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { ActHoldsPanel, type ActHold } from "@/components/bookings/ActHoldsPanel";
import { BookingStageRail } from "@/components/bookings/BookingStageRail";
import { BookingThread } from "@/components/bookings/BookingThread";
import { UnreadMessagesBadge } from "@/components/bookings/UnreadMessagesBadge";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import {
  OPEN_BOOKING_STATUSES,
  isoDateToLocal,
  type BookingRequestStatus,
} from "@/lib/booking-requests";

type SentRequestRow = {
  id: string;
  placeName: string | null;
  preferredDates: string[];
  status: BookingRequestStatus;
  createdAt: Date;
  /** Org name when the request was sent on behalf of a group. */
  senderLabel: string | null;
  /** Draft agreement created when the venue accepted (link target). */
  agreementId: string | null;
  /**
   * The stage projection behind {@link BookingStageRail} — the SAME arc the
   * venue sees, from the act's side. All four degrade to null together when
   * the server's batched stage lookup fails, so null means "not there yet OR
   * we could not tell" and is never rendered as a definite negative.
   */
  agreementStatus:
    | "DRAFT"
    | "PROPOSED"
    | "COUNTERED"
    | "ACCEPTED"
    | "DECLINED"
    | "CANCELLED"
    | "FULFILLED"
    | "EXPIRED"
    | "DISPUTED"
    | null;
  eventId: string | null;
  eventStatus:
    | "DRAFT"
    | "PUBLISHED"
    | "ARCHIVED"
    | "CANCELLED"
    | "COMPLETED"
    | null;
  eventStartsAt: Date | null;
  /**
   * The venue's vouch for the event, as the rail shows it on the act's side
   * ("Draft · Confirmed by venue"). Degrades to `none` with the event triple.
   */
  venueConfirmation: {
    state: "none" | "unconfirmed" | "confirmed" | "withdrawn";
    eventId: string | null;
    ownerSide: "place" | "requester" | null;
  };
  /**
   * Viewer-scoped unread thread messages (this is the PERFORMER side). Always
   * a number — 0 covers both "quiet" and "the count lookup degraded", so the
   * badge renders nothing at 0 rather than an empty chip.
   */
  unreadMessageCount: number;
  /**
   * The act's OWN holds on this request (booking-holds FR-013): date,
   * position, status, clock — and by contract nothing else (no calendar,
   * no other act). Empty when the venue has pencilled nothing in.
   */
  holds: ActHold[];
};

export interface SentBookingRequestsListProps {
  /** Admin-org owner ids from `performers.getMyStatus` (may be empty). */
  orgOwnerIds: string[];
}

/**
 * The performer's sent booking requests (human identity + any groups they
 * administer), newest first, with withdraw for open ones. Lives in the
 * account-settings Performer section so withdrawing has an obvious home.
 */
export function SentBookingRequestsList({
  orgOwnerIds,
}: SentBookingRequestsListProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const ownersQuery = useEventOwnerEntities();

  const humanQuery = trpc.bookingRequests.list.useQuery(
    { scope: "performer" },
    { staleTime: 15_000, retry: false, meta: { silent: true } },
  );

  const orgQueries = trpc.useQueries((q) =>
    orgOwnerIds.map((ownerId) =>
      q.bookingRequests.list({
        scope: "performer",
        performerOwnerType: "org",
        performerOwnerId: ownerId,
      }),
    ),
  );

  // Optimistic withdraw: ids flipped locally while the mutation settles.
  const [withdrawnIds, setWithdrawnIds] = useState<Set<string>>(new Set());
  const [pendingWithdrawId, setPendingWithdrawId] = useState<string | null>(
    null,
  );
  /**
   * One thread open at a time. This list is a compact settings section, and N
   * simultaneously-mounted threads would each fire their own cursor walk.
   */
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const withdrawMutation = trpc.bookingRequests.withdraw.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const orgNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const owner of ownersQuery.ownersWithSlugs ?? []) {
      if (owner.kind === "org") map.set(owner.orgId, owner.orgName);
    }
    return map;
  }, [ownersQuery.ownersWithSlugs]);

  const rows = useMemo<SentRequestRow[]>(() => {
    const result: SentRequestRow[] = [];
    for (const r of humanQuery.data?.requests ?? []) {
      result.push({
        id: r.id,
        placeName: r.placeName,
        preferredDates: r.preferredDates,
        status: r.status,
        createdAt: r.createdAt,
        senderLabel: null,
        agreementId: r.agreementId,
        agreementStatus: r.agreementStatus,
        eventId: r.eventId,
        eventStatus: r.eventStatus,
        eventStartsAt: r.eventStartsAt,
        venueConfirmation: r.venueConfirmation,
        unreadMessageCount: r.unreadMessageCount,
        holds: r.holds ?? [],
      });
    }
    orgQueries.forEach((query, index) => {
      const ownerId = orgOwnerIds[index];
      if (!ownerId) return;
      for (const r of query.data?.requests ?? []) {
        result.push({
          id: r.id,
          placeName: r.placeName,
          preferredDates: r.preferredDates,
          status: r.status,
          createdAt: r.createdAt,
          senderLabel:
            orgNameById.get(ownerId) ?? String(t("admin.bkSenderOrgFallback")),
          agreementId: r.agreementId,
          agreementStatus: r.agreementStatus,
          eventId: r.eventId,
          eventStatus: r.eventStatus,
          eventStartsAt: r.eventStartsAt,
          venueConfirmation: r.venueConfirmation,
          unreadMessageCount: r.unreadMessageCount,
          holds: r.holds ?? [],
        });
      }
    });
    return result
      .map((row) =>
        withdrawnIds.has(row.id)
          ? { ...row, status: "WITHDRAWN" as const }
          : row,
      )
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }, [
    humanQuery.data?.requests,
    orgNameById,
    orgOwnerIds,
    orgQueries,
    t,
    withdrawnIds,
  ]);

  const isLoading =
    humanQuery.isLoading || orgQueries.some((query) => query.isLoading);

  // Non-blocking: a failed group query silently drops its rows, so surface
  // an inline notice instead of pretending the list is complete.
  const hasOrgLoadErrors = orgQueries.some((query) => query.isError);

  const handleWithdraw = (row: SentRequestRow) => {
    if (pendingWithdrawId) return;
    setPendingWithdrawId(row.id);
    setWithdrawnIds((prev) => new Set(prev).add(row.id));
    withdrawMutation.mutate(
      { bookingRequestId: row.id },
      {
        onError: (err) => {
          setWithdrawnIds((prev) => {
            const next = new Set(prev);
            next.delete(row.id);
            return next;
          });
          toast.danger({
            id: "booking-withdraw-failed",
            title: String(t("account.sPerformerWithdrawFailed")),
            message: formatErrorMessage(err, t),
          });
        },
        onSettled: () => {
          setPendingWithdrawId(null);
          void utils.bookingRequests.list.invalidate();
        },
      },
    );
  };

  if (isLoading) {
    return (
      <YStack alignItems="center" paddingVertical="$4">
        <Spinner size="sm" />
      </YStack>
    );
  }

  if (humanQuery.isError) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("account.sPerformerRequestsLoadFailed"))}
      </Text>
    );
  }

  const orgErrorNotice = hasOrgLoadErrors ? (
    <Text variant="caption" tone="muted" role="status">
      {String(t("account.sPerformerRequestsPartialFailed"))}
    </Text>
  ) : null;

  if (rows.length === 0) {
    return (
      <YStack gap="$1">
        {orgErrorNotice}
        <Text variant="caption" tone="muted">
          {String(t("account.sPerformerRequestsEmpty"))}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack gap="$2">
      {orgErrorNotice}
      {rows.map((row) => {
        const isOpen = OPEN_BOOKING_STATUSES.includes(row.status);
        const firstDate = row.preferredDates[0];
        const threadOpen = openThreadId === row.id;
        const threadPanelId = `booking-thread-panel-${row.id}`;
        // ONE panel per request, in one of two places. Closed thread: under
        // the stage rail, so a challenged hold is answerable without opening
        // anything. Open thread: in the thread's next-step slot, directly
        // under the ledger line that asked the question. Never both — two
        // Keep buttons for one hold on one page is the collision the
        // run-it rule exists for.
        const holdsPanel = (
          <ActHoldsPanel
            bookingRequestId={row.id}
            holds={row.holds}
            testIdBase={`booking-sent-${row.id}-holds`}
          />
        );
        return (
          <YStack
            key={row.id}
            borderWidth={1}
            borderColor="$borderColor"
            borderRadius={0}
          >
            <YStack gap="$3" padding="$3">
              <XStack
                gap="$3"
                alignItems="center"
                justifyContent="space-between"
                flexWrap="wrap"
              >
                <YStack gap="$1" flex={1} minWidth={180}>
                  <Text variant="bodySmall" weight="bold">
                    {row.placeName ?? "—"}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {firstDate
                      ? fmt.dateTime(isoDateToLocal(firstDate), {
                          dateStyle: "medium",
                        })
                      : ""}
                    {row.preferredDates.length > 1
                      ? ` +${row.preferredDates.length - 1}`
                      : ""}
                    {row.senderLabel
                      ? ` · ${String(
                          t("account.sPerformerRequestsAs", {
                            name: row.senderLabel,
                          }),
                        )}`
                      : ""}
                  </Text>
                </YStack>
                {/* `flexShrink` is explicit because Tamagui defaults it to 0 (RN
                semantics): without it this cluster is pinned at max-content and
                pushes the row past the viewport instead of using the
                `flexWrap` it already declares. */}
                <XStack
                  gap="$2"
                  alignItems="center"
                  flexWrap="wrap"
                  flexShrink={1}
                  minWidth={0}
                >
                  {/* Sits immediately before the control that resolves it — the
                  chip says a reply landed, the next tap opens the thread. */}
                  <UnreadMessagesBadge
                    count={row.unreadMessageCount}
                    testIdBase={`booking-sent-${row.id}`}
                  />
                  {/* Disclosure, not navigation — the thread lives on the request
                  (venue-hierarchy FR-012), and this list is the performer's
                  only route to it. */}
                  <Button
                    variant="outlined"
                    size="$2"
                    onPress={() => setOpenThreadId(threadOpen ? null : row.id)}
                    aria-expanded={threadOpen}
                    aria-controls={threadPanelId}
                    testID={`booking-thread-toggle-${row.id}`}
                  >
                    {String(t("booking.threadHeading"))}
                  </Button>
                  {row.status === "ACCEPTED" && row.agreementId && (
                    <NextLinkAnchor href={`/agreements/${row.agreementId}`}>
                      <Button
                        tag="span"
                        variant="outlined"
                        size="$2"
                        testID={`booking-view-agreement-${row.id}`}
                      >
                        {String(t("account.sPerformerViewAgreement"))}
                      </Button>
                    </NextLinkAnchor>
                  )}
                  {isOpen && (
                    <Button
                      variant="outlined"
                      size="$2"
                      disabled={pendingWithdrawId !== null}
                      onPress={() => handleWithdraw(row)}
                      testID={`booking-withdraw-${row.id}`}
                    >
                      {pendingWithdrawId === row.id ? (
                        <Spinner size="sm" />
                      ) : (
                        String(t("account.sPerformerWithdraw"))
                      )}
                    </Button>
                  )}
                </XStack>
              </XStack>

              {/* The performer's view of the SAME arc the venue sees, and the one
              surface where the act can find out that "accepted" has since
              become an agreement out for review, or a real event on a
              particular night. `full` rather than the list-row `compact`: this
              section holds a handful of requests, not twenty, so there is room
              to show all three legs — and the booked date beside the dates the
              act actually asked for is the whole point of showing it here. */}
              <BookingStageRail
                variant="full"
                status={row.status}
                agreementStatus={row.agreementStatus}
                eventId={row.eventId}
                eventStatus={row.eventStatus}
                eventStartsAt={row.eventStartsAt}
                preferredDates={row.preferredDates}
                venueConfirmation={row.venueConfirmation}
                testIdBase={`booking-sent-${row.id}`}
              />

              {!threadOpen ? holdsPanel : null}
            </YStack>

            {threadOpen && (
              <YStack
                id={threadPanelId}
                gap="$3"
                padding="$3"
                borderTopWidth={1}
                borderTopColor="$borderColor"
                backgroundColor="$surfaceMuted"
              >
                {/* Writable at EVERY status, deliberately — the thread is the
                  request's history, so a declined or withdrawn request is
                  still a place to ask what happened. Who may write is decided
                  server-side by authorization alone (thread-access.ts). */}
                <BookingThread
                  bookingRequestId={row.id}
                  side="PERFORMER"
                  counterpartyLabel={row.placeName}
                  // The act sees the terms it is agreeing to WHILE it types,
                  // not only after opening the agreement page. Null on an
                  // un-accepted pitch, which mounts no strip and issues no
                  // agreement read.
                  agreementId={row.agreementId}
                  // The act's next step (FR-013), when there is one: keep or
                  // release a challenged hold. Renders nothing without holds.
                  nextStep={holdsPanel}
                  testIdBase={`booking-thread-${row.id}`}
                />
              </YStack>
            )}
          </YStack>
        );
      })}
    </YStack>
  );
}
