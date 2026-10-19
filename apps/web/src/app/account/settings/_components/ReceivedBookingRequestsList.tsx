"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtCurrency } from "@/lib/format";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import {
  BOOKING_FEE_TYPE_LABEL_KEYS,
  BOOKING_STATUS_LABEL_KEYS,
  OPEN_BOOKING_STATUSES,
  bookingStatusTone,
  formatSetLength,
  isoDateToLocal,
} from "@/lib/booking-requests";

/** The act whose received organizer requests are listed (FR-007). */
export type ReceivedRequestsOwner =
  | { ownerType: "human" }
  | { ownerType: "org"; ownerId: string };

export interface ReceivedBookingRequestsListProps {
  owner: ReceivedRequestsOwner;
}

/** Uppercase field label used inside the expanded detail panel. */
function DetailLabel({ children }: { children: string }) {
  return (
    <Text
      variant="caption"
      weight="bold"
      tone="muted"
      textTransform="uppercase"
      letterSpacing={0.6}
    >
      {children}
    </Text>
  );
}

/**
 * "Requests to you" — the act's received organizer booking requests
 * (organizer-booking-requests FR-007), newest first. Mirrors
 * {@link SentBookingRequestsList}'s row composition with BookingInbox's
 * expand → mark-viewed → accept/decline flow on open rows. Mounted in the
 * account-settings Performer section (human act) and the org-settings
 * performer section (org act).
 */
export function ReceivedBookingRequestsList({
  owner,
}: ReceivedBookingRequestsListProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const listInput = useMemo(
    () =>
      owner.ownerType === "org"
        ? {
            scope: "performer-inbox" as const,
            performerOwnerType: "org" as const,
            performerOwnerId: owner.ownerId,
          }
        : { scope: "performer-inbox" as const },
    [owner],
  );

  const listQuery = trpc.bookingRequests.list.useQuery(listInput, {
    staleTime: 15_000,
    retry: false,
    meta: { silent: true },
  });

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [acceptTargetId, setAcceptTargetId] = useState<string | null>(null);
  const [declineTargetId, setDeclineTargetId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");

  const markViewedMutation = trpc.bookingRequests.markViewed.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const respondMutation = trpc.bookingRequests.respond.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const rows = useMemo(
    () =>
      [...(listQuery.data?.requests ?? [])].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [listQuery.data?.requests],
  );

  // ── Mark viewed (fire-and-forget on expand, optimistic) ──────────────────
  const markViewed = useCallback(
    (rowId: string) => {
      utils.bookingRequests.list.setData(listInput, (prev) =>
        prev
          ? {
              requests: prev.requests.map((r) =>
                r.id === rowId && r.status === "PENDING"
                  ? { ...r, status: "VIEWED" as const, viewedAt: new Date() }
                  : r,
              ),
            }
          : prev,
      );
      markViewedMutation.mutate(
        { bookingRequestId: rowId },
        {
          onError: () => {
            // Terminal/raced state — refresh to the server's truth.
            void listQuery.refetch();
          },
        },
      );
    },
    [listInput, listQuery, markViewedMutation, utils.bookingRequests.list],
  );

  const toggleExpand = useCallback(
    (rowId: string, status: string) => {
      const willExpand = !expandedIds.has(rowId);
      // Fire-and-forget outside the state updater (updaters must stay pure).
      if (willExpand && status === "PENDING") markViewed(rowId);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      });
    },
    [expandedIds, markViewed],
  );

  // ── Respond (accept / decline) ───────────────────────────────────────────
  const handleRespondError = useCallback(
    (err: unknown) => {
      const e = err as { data?: { code?: string } | null };
      if (e?.data?.code === "CONFLICT") {
        toast.warning({
          id: "booking-respond-conflict",
          title: String(t("admin.bkInboxConflict")),
        });
      } else {
        toast.danger({
          id: "booking-respond-failed",
          title: String(t("admin.bkInboxActionFailed")),
          message: formatErrorMessage(err, t),
        });
      }
      void listQuery.refetch();
    },
    [listQuery, t, toast],
  );

  const acceptTarget = useMemo(
    () => rows.find((r) => r.id === acceptTargetId) ?? null,
    [rows, acceptTargetId],
  );

  const handleAccept = useCallback(() => {
    if (!acceptTargetId || respondMutation.isPending) return;
    respondMutation.mutate(
      { bookingRequestId: acceptTargetId, action: "accept" },
      {
        onSuccess: () => {
          toast.success({
            id: "booking-accepted",
            title: String(t("admin.bkRcvAcceptSuccess")),
          });
          void utils.bookingRequests.list.invalidate();
        },
        onError: handleRespondError,
        onSettled: () => setAcceptTargetId(null),
      },
    );
  }, [
    acceptTargetId,
    handleRespondError,
    respondMutation,
    t,
    toast,
    utils.bookingRequests.list,
  ]);

  const handleDecline = useCallback(
    (rowId: string) => {
      const reason = declineReason.trim();
      // TO_PERFORMER declines need NO reason (spec) — the field is optional
      // here. When one IS typed, the respond schema still floors it at 3
      // chars, so 1–2 chars stays blocked; an empty reason is simply omitted
      // from the mutation input (never sent as "").
      if ((reason.length > 0 && reason.length < 3) || respondMutation.isPending)
        return;
      respondMutation.mutate(
        {
          bookingRequestId: rowId,
          action: "decline",
          ...(reason.length > 0 ? { declineReason: reason } : {}),
        },
        {
          onSuccess: () => {
            setDeclineTargetId(null);
            setDeclineReason("");
            void utils.bookingRequests.list.invalidate();
          },
          onError: handleRespondError,
        },
      );
    },
    [
      declineReason,
      handleRespondError,
      respondMutation,
      utils.bookingRequests.list,
    ],
  );

  // ── States ───────────────────────────────────────────────────────────────
  if (listQuery.isLoading) {
    return (
      <YStack alignItems="center" paddingVertical="$4">
        <Spinner size="sm" />
      </YStack>
    );
  }

  if (listQuery.isError) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.bkRcvLoadFailed"))}
      </Text>
    );
  }

  if (rows.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.bkRcvEmpty"))}
      </Text>
    );
  }

  return (
    <YStack gap="$2">
      {rows.map((row) => {
        const isOpen = OPEN_BOOKING_STATUSES.includes(row.status);
        const isExpanded = expandedIds.has(row.id);
        const declining = declineTargetId === row.id;
        const orgName =
          row.organizerOrgName ?? String(t("admin.bkRcvOrgFallback"));
        const firstDate = row.preferredDates[0];
        const extraDates = row.preferredDates.length - 1;

        return (
          <YStack
            key={row.id}
            borderWidth={1}
            borderColor="$borderColor"
            borderRadius={0}
          >
            <XStack
              gap="$3"
              padding="$3"
              alignItems="center"
              justifyContent="space-between"
              flexWrap="wrap"
            >
              <YStack gap="$1" flex={1} minWidth={180}>
                <Text variant="bodySmall" weight="bold">
                  {orgName}
                </Text>
                <Text variant="caption" tone="muted">
                  {row.attachedEventTitle
                    ? `${row.attachedEventTitle}${
                        row.attachedEventStartsAt
                          ? ` — ${fmt.dateTime(
                              new Date(row.attachedEventStartsAt),
                              { dateStyle: "medium" },
                            )}`
                          : ""
                      }`
                    : firstDate
                      ? `${fmt.dateTime(isoDateToLocal(firstDate), {
                          dateStyle: "medium",
                        })}${extraDates > 0 ? ` +${extraDates}` : ""}`
                      : ""}
                  {` · ${fmt.dateTime(new Date(row.createdAt), {
                    dateStyle: "medium",
                  })}`}
                </Text>
              </YStack>
              <XStack gap="$2" alignItems="center">
                <Badge tone={bookingStatusTone(row.status)} size="sm">
                  {String(t(BOOKING_STATUS_LABEL_KEYS[row.status]))}
                </Badge>
                {row.status === "ACCEPTED" && row.agreementId && (
                  <NextLinkAnchor href={`/agreements/${row.agreementId}`}>
                    <Button
                      tag="span"
                      variant="outlined"
                      size="$2"
                      testID={`booking-rcv-agreement-${row.id}`}
                    >
                      {String(t("admin.baOpenAgreement"))}
                    </Button>
                  </NextLinkAnchor>
                )}
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => toggleExpand(row.id, row.status)}
                  testID={`booking-rcv-details-${row.id}`}
                  aria-label={`${String(
                    isExpanded
                      ? t("admin.bkRcvHideDetails")
                      : t("admin.bkRcvDetails"),
                  )} — ${orgName}`}
                  {...({ "aria-expanded": isExpanded } as Record<
                    string,
                    unknown
                  >)}
                >
                  {String(
                    isExpanded
                      ? t("admin.bkRcvHideDetails")
                      : t("admin.bkRcvDetails"),
                  )}
                </Button>
              </XStack>
            </XStack>

            {isExpanded && (
              <YStack
                gap="$3"
                padding="$4"
                borderTopWidth={1}
                borderTopColor="$borderColor"
                backgroundColor="$surfaceMuted"
              >
                {row.attachedEventTitle && (
                  <YStack gap="$1">
                    <DetailLabel>
                      {String(t("admin.bkRcvEventLabel"))}
                    </DetailLabel>
                    <Text variant="bodySmall" weight="bold">
                      {row.attachedEventTitle}
                      {row.attachedEventStartsAt
                        ? ` — ${fmt.dateTime(
                            new Date(row.attachedEventStartsAt),
                            { dateStyle: "full" },
                          )}`
                        : ""}
                    </Text>
                  </YStack>
                )}

                {row.preferredDates.length > 0 && (
                  <YStack gap="$1">
                    <DetailLabel>
                      {String(t("admin.bkInboxColDates"))}
                    </DetailLabel>
                    <Text variant="bodySmall">
                      {row.preferredDates
                        .map((d) =>
                          fmt.dateTime(isoDateToLocal(d), {
                            dateStyle: "full",
                          }),
                        )
                        .join(" · ")}
                    </Text>
                  </YStack>
                )}

                {/* Offer — type + formatted amount (mono) when present. */}
                {row.feeType && (
                  <YStack gap="$1">
                    <DetailLabel>
                      {String(t("admin.bkRcvOfferLabel"))}
                    </DetailLabel>
                    <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
                      <Text variant="bodySmall">
                        {String(t(BOOKING_FEE_TYPE_LABEL_KEYS[row.feeType]))}
                      </Text>
                      {row.feeAmountCents != null && (
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          fontFamily="$mono"
                        >
                          {fmtCurrency(
                            fmt,
                            row.feeAmountCents,
                            row.feeCurrency ?? "usd",
                          )}
                        </Text>
                      )}
                    </XStack>
                  </YStack>
                )}

                {row.setLengthMinutes != null && (
                  <YStack gap="$1">
                    <DetailLabel>
                      {String(t("admin.bkInboxSetLengthLabel"))}
                    </DetailLabel>
                    <Text variant="bodySmall">
                      {formatSetLength(row.setLengthMinutes)}
                    </Text>
                  </YStack>
                )}

                <YStack gap="$1">
                  <DetailLabel>
                    {String(t("admin.bkInboxMessageLabel"))}
                  </DetailLabel>
                  <Text variant="bodySmall" style={{ whiteSpace: "pre-wrap" }}>
                    {row.message}
                  </Text>
                </YStack>

                {row.status === "DECLINED" && row.declineReason && (
                  <Text variant="bodySmall" tone="muted">
                    {String(
                      t("admin.bkInboxDeclinedNote", {
                        reason: row.declineReason,
                      }),
                    )}
                  </Text>
                )}

                {isOpen && row.expiresAt && (
                  <Text variant="caption" tone="muted">
                    {String(
                      t("admin.bkInboxExpires", {
                        date: fmt.dateTime(new Date(row.expiresAt), {
                          dateStyle: "medium",
                        }),
                      }),
                    )}
                  </Text>
                )}

                {isOpen && !declining && (
                  <XStack gap="$2">
                    <Button
                      variant="primary"
                      size="$2"
                      disabled={respondMutation.isPending}
                      onPress={() => setAcceptTargetId(row.id)}
                      testID={`booking-rcv-accept-${row.id}`}
                    >
                      {String(t("admin.bkInboxAccept"))}
                    </Button>
                    <Button
                      variant="secondary"
                      size="$2"
                      disabled={respondMutation.isPending}
                      onPress={() => {
                        setDeclineTargetId(row.id);
                        setDeclineReason("");
                      }}
                      testID={`booking-rcv-decline-${row.id}`}
                    >
                      {String(t("admin.bkInboxDecline"))}
                    </Button>
                  </XStack>
                )}

                {isOpen && declining && (
                  <YStack
                    gap="$2"
                    padding="$3"
                    borderWidth={1}
                    borderColor="$borderColor"
                    backgroundColor="$surface"
                  >
                    <Text variant="bodySmall" weight="bold">
                      {`${String(t("admin.bkInboxDeclineReasonLabel"))} · ${String(
                        t("admin.bkFormOptional"),
                      )}`}
                    </Text>
                    <TextInput
                      value={declineReason}
                      onChangeText={setDeclineReason}
                      placeholder={String(
                        t("admin.bkRcvDeclineReasonPlaceholder"),
                      )}
                      fullWidth
                      aria-label={String(t("admin.bkInboxDeclineReasonLabel"))}
                      testId={`booking-rcv-decline-reason-${row.id}`}
                    />
                    <Text variant="caption" tone="muted">
                      {String(t("admin.bkRcvDeclineReasonHint"))}
                    </Text>
                    <XStack gap="$2" justifyContent="flex-end">
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={respondMutation.isPending}
                        onPress={() => {
                          setDeclineTargetId(null);
                          setDeclineReason("");
                        }}
                      >
                        {String(t("common.cancel"))}
                      </Button>
                      <Button
                        variant="destructive"
                        size="$2"
                        disabled={
                          // Optional reason: empty submits fine; a typed one
                          // must clear the server's 3-char floor.
                          (declineReason.trim().length > 0 &&
                            declineReason.trim().length < 3) ||
                          respondMutation.isPending
                        }
                        onPress={() => handleDecline(row.id)}
                        testID={`booking-rcv-decline-confirm-${row.id}`}
                      >
                        {respondMutation.isPending ? (
                          <Spinner size="sm" />
                        ) : (
                          String(t("admin.bkInboxDeclineConfirm"))
                        )}
                      </Button>
                    </XStack>
                  </YStack>
                )}
              </YStack>
            )}
          </YStack>
        );
      })}

      <ConfirmDialog
        open={acceptTargetId !== null}
        onConfirm={handleAccept}
        onCancel={() => setAcceptTargetId(null)}
        title={String(t("admin.bkRcvAcceptConfirmTitle"))}
        description={String(
          t("admin.bkRcvAcceptConfirmBody", {
            org:
              acceptTarget?.organizerOrgName ??
              String(t("admin.bkRcvOrgFallback")),
          }),
        )}
        confirmLabel={String(t("admin.bkInboxAccept"))}
        cancelLabel={String(t("common.cancel"))}
        loading={respondMutation.isPending}
        loadingLabel={String(t("common.loading"))}
      />
    </YStack>
  );
}
