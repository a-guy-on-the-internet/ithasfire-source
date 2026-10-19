"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  Spinner,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
  type DataTableColumn,
} from "@th/ui";
import { Inbox } from "lucide-react";

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
  type BookingFeeType,
  type BookingRequestStatus,
} from "@/lib/booking-requests";

import { adminAgreementHref } from "@/lib/agreement-routes";

import { OpenAgreementButton } from "./OpenAgreementButton";
import { StatusSegments } from "./StatusSegments";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A TO_PERFORMER row as this table needs it — the subset of
 * `bookingRequestSummarySchema` (list-booking-requests.ts) that is populated
 * for the `performer-inbox` scope. The venue table's pitch fields (genre,
 * expectedDraw, links, techNeeds, contact*, verifiedStatsSnapshot) belong to
 * the OTHER direction and are deliberately absent here: TO_PERFORMER rows carry
 * `placeId: null` / `placeName: null` and an organizer org instead.
 */
type ReceivedRow = {
  id: string;
  organizerOrgId: string | null;
  organizerOrgName: string | null;
  attachedEventId: string | null;
  attachedEventTitle: string | null;
  attachedEventStartsAt: Date | null;
  message: string;
  preferredDates: string[];
  setLengthMinutes: number | null;
  feeType: BookingFeeType | null;
  feeAmountCents: number | null;
  feeCurrency: string | null;
  status: BookingRequestStatus;
  declineReason: string | null;
  agreementId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
};

/**
 * Three views over the SAME list, in the order a request moves through them:
 * `open` (still needs an answer) → `accepted` (answered yes) → `all` (the
 * archive, including declined / withdrawn / expired).
 *
 * `accepted` exists because accepting used to make the row VANISH: `open`
 * filters on the shared {@link OPEN_BOOKING_STATUSES} — which ACCEPTED is
 * deliberately NOT part of — so the one row that led to the freshly-created
 * agreement dropped off the view being looked at, leaving a success toast
 * pointing at nothing.
 *
 * The fix is a view, NOT a wider open-set. `OPEN_BOOKING_REQUEST_STATUSES`
 * also drives `bookingRequests.countOpen`, which feeds the admin rail badge
 * and this page's tab counts; those mean "needs your attention", which an
 * accepted request does not. Widening the shared constant would inflate every
 * one of them.
 */
type InboxView = "open" | "accepted" | "all";

const ACCEPTED_STATUSES: BookingRequestStatus[] = ["ACCEPTED"];

/** Single source for view filtering AND the counts, so the two cannot drift. */
function rowsForView(rows: ReceivedRow[], view: InboxView): ReceivedRow[] {
  switch (view) {
    case "open":
      return rows.filter((r) => OPEN_BOOKING_STATUSES.includes(r.status));
    case "accepted":
      return rows.filter((r) => ACCEPTED_STATUSES.includes(r.status));
    case "all":
      return rows;
  }
}

export interface OrgReceivedRequestsTableProps {
  /** The org whose act-inbox is rendered (list scope "performer-inbox"). */
  orgId: string;
  /** Admin slug of the shell this table runs under — agreement links. */
  slug: string;
}

/** Uppercase field label inside the expanded detail panel. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Requests to you" — the org-as-act inbox (booking-inbox-placement FR-003),
 * moved out of org settings onto the Bookings workspace and re-presented on the
 * venue `BookingInbox` DataTable pattern.
 *
 * FEATURE BEHAVIOUR IS PARITY with the account-settings
 * `ReceivedBookingRequestsList`; only presentation and placement change:
 * the same `performer-inbox` query, the same two mutations (`markViewed` on
 * expand, `respond`), the same open-status set, the same agreement link on
 * ACCEPTED rows.
 *
 * DECLINE REASON IS OPTIONAL HERE — do not "fix" this to match
 * `BookingInbox.tsx`, which hard-gates decline on a ≥3-char reason. That gate
 * is correct for TO_VENUE only: `respond-to-booking-request.ts` requires
 * `declineReason` on the TO_VENUE branch and states plainly that TO_PERFORMER
 * declines need no reason. These are TO_PERFORMER rows. A typed reason is still
 * floored at 3 chars (the server's schema minimum); an empty one is omitted
 * from the mutation input rather than sent as "".
 *
 * The helpers below duplicate `ReceivedBookingRequestsList`'s flow rather than
 * extracting a shared hook: that component is the live account-settings surface
 * and must keep working byte-identically (NFR-001), so it is not edited here.
 */
export function OrgReceivedRequestsTable({
  orgId,
  slug,
}: OrgReceivedRequestsTableProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const router = useRouter();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [view, setView] = useState<InboxView>("open");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [acceptTargetId, setAcceptTargetId] = useState<string | null>(null);
  const [declineTargetId, setDeclineTargetId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");

  // The org-as-act inbox: the same scope the retired settings section used to
  // mount, so the move was placement-only (booking-inbox-placement FR-003).
  const listInput = useMemo(
    () => ({
      scope: "performer-inbox" as const,
      performerOwnerType: "org" as const,
      performerOwnerId: orgId,
    }),
    [orgId],
  );

  const listQuery = trpc.bookingRequests.list.useQuery(listInput, {
    staleTime: 15_000,
    retry: false,
    meta: { silent: true },
  });

  const markViewedMutation = trpc.bookingRequests.markViewed.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const respondMutation = trpc.bookingRequests.respond.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const allRows = useMemo<ReceivedRow[]>(
    () =>
      [...((listQuery.data?.requests ?? []) as ReceivedRow[])].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [listQuery.data?.requests],
  );

  const rows = useMemo(() => rowsForView(allRows, view), [allRows, view]);

  // Counts run through the SAME `rowsForView` filter the panel renders, so a
  // segment can never advertise a number it does not show.
  const viewCounts = useMemo<Record<InboxView, number>>(
    () => ({
      open: rowsForView(allRows, "open").length,
      accepted: rowsForView(allRows, "accepted").length,
      all: allRows.length,
    }),
    [allRows],
  );

  // ── Mark viewed (fire-and-forget on expand, optimistic) ────────────────────
  const markViewed = useCallback(
    (rowId: string) => {
      utils.bookingRequests.list.setData(listInput, (prev) =>
        prev
          ? {
              // Spread rather than rebuilding from `requests`: the list payload
              // carries scope-specific siblings (e.g. `ownedPlacesTruncated`)
              // and dropping them here would silently erase them from cache.
              ...prev,
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
    (row: ReceivedRow) => {
      const willExpand = !expandedIds.has(row.id);
      // Fire-and-forget outside the state updater (updaters must stay pure —
      // StrictMode double-invokes them).
      if (willExpand && row.status === "PENDING") markViewed(row.id);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
    },
    [expandedIds, markViewed],
  );

  // ── Respond (accept / decline) ─────────────────────────────────────────────
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
    () => allRows.find((r) => r.id === acceptTargetId) ?? null,
    [allRows, acceptTargetId],
  );

  const handleAccept = useCallback(() => {
    if (!acceptTargetId || respondMutation.isPending) return;
    const acceptedId = acceptTargetId;
    respondMutation.mutate(
      { bookingRequestId: acceptedId, action: "accept" },
      {
        // `result` carries the freshly-minted `agreementId`
        // (respondToBookingRequestOutputSchema). It used to be dropped on the
        // floor, so the toast could only announce that a draft agreement
        // existed without ever saying where — and the row itself left the Open
        // view at the same moment, taking its only agreement link with it.
        onSuccess: (result) => {
          const agreementId = result.agreementId ?? null;
          // Write the answer into the cache before the refetch lands, so the
          // row is ALREADY on the Accepted view we are about to switch to —
          // otherwise that view flashes its empty state for one round trip.
          // Not an optimistic guess: the mutation has already succeeded, so
          // this is the server's answer, early.
          utils.bookingRequests.list.setData(listInput, (prev) =>
            prev
              ? {
                  ...prev,
                  requests: prev.requests.map((r) =>
                    r.id === acceptedId
                      ? {
                          ...r,
                          status: "ACCEPTED" as const,
                          agreementId: agreementId ?? r.agreementId,
                          respondedAt: new Date(),
                        }
                      : r,
                  ),
                }
              : prev,
          );
          // Follow the request to where it now lives, with its detail open —
          // only FROM the Open view, where the row would otherwise vanish. On
          // All the row is already on screen, so moving the view would be a
          // jump nobody asked for. (Accept is unreachable from Accepted.)
          if (view === "open") setView("accepted");
          setExpandedIds((prev) => new Set(prev).add(acceptedId));
          toast.success({
            id: "booking-accepted",
            title: String(t("admin.bkRcvAcceptSuccess")),
            message: String(t("admin.bkInboxAcceptSuccessMessage")),
            // `agreementId` is OPTIONAL on the response schema. No id, no
            // action — never a link to `/agreements/undefined`.
            ...(agreementId
              ? {
                  // Long enough to read the action before auto-dismiss.
                  durationMs: 10_000,
                  action: {
                    label: String(t("admin.baOpenAgreement")),
                    onPress: () =>
                      router.push(adminAgreementHref(slug, agreementId)),
                  },
                }
              : {}),
          });
          void utils.bookingRequests.list.invalidate();
          // `countOpen` is a SEPARATE query key with its own 30s staleTime —
          // `list.invalidate()` does not touch it. Without this the tab label
          // above an emptied inbox still reads "(1)" and the admin rail's
          // Bookings badge keeps its pre-response number for the rest of the
          // session (AdminShell never unmounts on client navigation).
          void utils.bookingRequests.countOpen.invalidate();
        },
        onError: handleRespondError,
        onSettled: () => setAcceptTargetId(null),
      },
    );
  }, [
    acceptTargetId,
    handleRespondError,
    listInput,
    respondMutation,
    router,
    slug,
    t,
    toast,
    utils.bookingRequests.countOpen,
    utils.bookingRequests.list,
    view,
  ]);

  const handleDecline = useCallback(
    (rowId: string) => {
      const reason = declineReason.trim();
      // TO_PERFORMER declines need NO reason — the field is optional. When one
      // IS typed the respond schema still floors it at 3 chars, so 1–2 chars
      // stays blocked; an empty reason is omitted, never sent as "".
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
            // Separate query key — see the note in handleAccept.
            void utils.bookingRequests.countOpen.invalidate();
          },
          onError: handleRespondError,
        },
      );
    },
    [
      declineReason,
      handleRespondError,
      respondMutation,
      utils.bookingRequests.countOpen,
      utils.bookingRequests.list,
    ],
  );

  const orgNameOf = useCallback(
    (row: ReceivedRow) =>
      row.organizerOrgName ?? String(t("admin.bkRcvOrgFallback")),
    [t],
  );

  // ── Columns (adapted to TO_PERFORMER rows) ────────────────────────────────
  const columns = useMemo<DataTableColumn<ReceivedRow>[]>(
    () => [
      {
        id: "from",
        header: String(t("admin.bkInboxColSender")),
        width: 1.5,
        truncate: true,
        cell: (row) => (
          <Text
            variant="bodySmall"
            weight="bold"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {orgNameOf(row)}
          </Text>
        ),
      },
      {
        id: "event",
        header: String(t("admin.bkRcvEventLabel")),
        width: 1.6,
        cell: (row) =>
          row.attachedEventTitle ? (
            <YStack gap="$1" minWidth={0}>
              <Text
                variant="bodySmall"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.attachedEventTitle}
              </Text>
              {row.attachedEventStartsAt ? (
                <Text variant="caption" tone="muted">
                  {fmt.dateTime(new Date(row.attachedEventStartsAt), {
                    dateStyle: "medium",
                  })}
                </Text>
              ) : null}
            </YStack>
          ) : (
            <Text variant="bodySmall" tone="muted">
              —
            </Text>
          ),
      },
      {
        id: "dates",
        header: String(t("admin.bkInboxColDates")),
        width: 1.3,
        cell: (row) => {
          const first = row.preferredDates[0];
          if (!first) {
            return (
              <Text variant="bodySmall" tone="muted">
                —
              </Text>
            );
          }
          const extra = row.preferredDates.length - 1;
          return (
            <Text variant="bodySmall">
              {fmt.dateTime(isoDateToLocal(first), { dateStyle: "medium" })}
              {extra > 0 ? ` +${extra}` : ""}
            </Text>
          );
        },
      },
      {
        id: "fee",
        header: String(t("admin.bkInboxFeeLabel")),
        width: 1,
        align: "right",
        cell: (row) =>
          row.feeType ? (
            <YStack gap="$1" alignItems="flex-end" minWidth={0}>
              {row.feeAmountCents != null ? (
                <Text
                  variant="bodySmall"
                  weight="bold"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {fmtCurrency(
                    fmt,
                    row.feeAmountCents,
                    row.feeCurrency ?? "usd",
                  )}
                </Text>
              ) : null}
              <Text variant="caption" tone="muted">
                {String(t(BOOKING_FEE_TYPE_LABEL_KEYS[row.feeType]))}
              </Text>
            </YStack>
          ) : (
            <Text variant="bodySmall" tone="muted">
              —
            </Text>
          ),
      },
      {
        id: "status",
        header: String(t("admin.bkInboxColStatus")),
        width: 1,
        cell: (row) => (
          <Badge tone={bookingStatusTone(row.status)} size="sm">
            {String(t(BOOKING_STATUS_LABEL_KEYS[row.status]))}
          </Badge>
        ),
      },
      {
        id: "received",
        header: String(t("admin.bkInboxColReceived")),
        width: 1,
        truncate: true,
        tooltipValue: (row) => new Date(row.createdAt).toLocaleString(),
        cell: (row) => (
          <Text variant="bodySmall" tone="muted">
            {fmt.dateTime(new Date(row.createdAt), { dateStyle: "medium" })}
          </Text>
        ),
      },
    ],
    [fmt, orgNameOf, t],
  );

  // ── Row action: the agreement, reachable WITHOUT expanding ────────────────
  // The agreement used to live ONLY inside the expanded detail, so after an
  // accept it took three undocumented steps to reach: notice the row had moved
  // views, find it again, expand it. DataTable stops click propagation inside
  // this cell, so following the link never also toggles the row open. Renders
  // nothing for every other row — an empty cell reads as "no agreement", which
  // is the truth.
  const rowActions = useMemo(
    () => ({
      header: String(t("admin.bkInboxColAgreement")),
      width: 1,
      render: (row: ReceivedRow) =>
        row.status === "ACCEPTED" && row.agreementId ? (
          <OpenAgreementButton
            compact
            slug={slug}
            agreementId={row.agreementId}
            label={String(t("admin.baOpenAgreement"))}
            // The counterparty on THIS direction is the organizer who asked —
            // without it every accepted row's link announces the same three
            // words in a screen reader's links list.
            nameSuffix={orgNameOf(row)}
            testID={`org-rcv-row-agreement-${row.id}`}
          />
        ) : null,
    }),
    [orgNameOf, slug, t],
  );

  // ── Mobile card (DataTable card mode, <600px) ─────────────────────────────
  const renderMobileCard = useCallback(
    (row: ReceivedRow) => {
      const firstDate = row.preferredDates[0];
      const extraDates = row.preferredDates.length - 1;
      return (
        <YStack gap="$2" minWidth={0}>
          <XStack gap="$2" alignItems="center" minWidth={0}>
            <Text
              variant="bodySmall"
              weight="bold"
              flex={1}
              minWidth={0}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {orgNameOf(row)}
            </Text>
            <Badge tone={bookingStatusTone(row.status)} size="sm">
              {String(t(BOOKING_STATUS_LABEL_KEYS[row.status]))}
            </Badge>
          </XStack>
          {row.attachedEventTitle ? (
            <Text
              variant="caption"
              tone="muted"
              minWidth={0}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.attachedEventTitle}
            </Text>
          ) : null}
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="caption" tone="muted">
              {firstDate
                ? `${fmt.dateTime(isoDateToLocal(firstDate), {
                    dateStyle: "medium",
                  })}${extraDates > 0 ? ` +${extraDates}` : ""}`
                : "—"}
            </Text>
            <Text variant="caption" tone="muted" aria-hidden>
              ·
            </Text>
            <Text variant="caption" tone="muted">
              {fmt.dateTime(new Date(row.createdAt), { dateStyle: "medium" })}
            </Text>
          </XStack>
          {/* Card mode renders no `rowActions` column, so the agreement route
              is mirrored here — otherwise it would exist on desktop only. */}
          {row.status === "ACCEPTED" && row.agreementId ? (
            <OpenAgreementButton
              fullWidth
              slug={slug}
              agreementId={row.agreementId}
              label={String(t("admin.baOpenAgreement"))}
              nameSuffix={orgNameOf(row)}
              testID={`org-rcv-card-agreement-${row.id}`}
            />
          ) : null}
        </YStack>
      );
    },
    [fmt, orgNameOf, slug, t],
  );

  // ── Expanded detail panel ─────────────────────────────────────────────────
  const renderExpandedRow = useCallback(
    (row: ReceivedRow) => {
      if (!expandedIds.has(row.id)) return null;
      const isOpenRequest = OPEN_BOOKING_STATUSES.includes(row.status);
      const declining = declineTargetId === row.id;

      return (
        <YStack
          gap="$3"
          padding="$4"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          {row.attachedEventTitle && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkRcvEventLabel"))}</DetailLabel>
              <Text variant="bodySmall" weight="bold">
                {row.attachedEventTitle}
                {row.attachedEventStartsAt
                  ? ` — ${fmt.dateTime(new Date(row.attachedEventStartsAt), {
                      dateStyle: "full",
                    })}`
                  : ""}
              </Text>
            </YStack>
          )}

          {row.preferredDates.length > 0 && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkInboxColDates"))}</DetailLabel>
              <Text variant="bodySmall">
                {row.preferredDates
                  .map((d) =>
                    fmt.dateTime(isoDateToLocal(d), { dateStyle: "full" }),
                  )
                  .join(" · ")}
              </Text>
            </YStack>
          )}

          {row.feeType && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkRcvOfferLabel"))}</DetailLabel>
              <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
                <Text variant="bodySmall">
                  {String(t(BOOKING_FEE_TYPE_LABEL_KEYS[row.feeType]))}
                </Text>
                {row.feeAmountCents != null && (
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
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
            <DetailLabel>{String(t("admin.bkInboxMessageLabel"))}</DetailLabel>
            <Text variant="bodySmall" style={{ whiteSpace: "pre-wrap" }}>
              {row.message}
            </Text>
          </YStack>

          {row.status === "ACCEPTED" && (
            <XStack gap="$3" alignItems="center" flexWrap="wrap">
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.baInboxAcceptedNote"))}
              </Text>
              {row.agreementId ? (
                <OpenAgreementButton
                  slug={slug}
                  agreementId={row.agreementId}
                  label={String(t("admin.baOpenAgreement"))}
                  nameSuffix={orgNameOf(row)}
                  testID={`org-rcv-agreement-${row.id}`}
                />
              ) : null}
            </XStack>
          )}

          {row.status === "DECLINED" && row.declineReason && (
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.bkInboxDeclinedNote", { reason: row.declineReason }),
              )}
            </Text>
          )}

          {isOpenRequest && row.expiresAt && (
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

          {isOpenRequest && !declining && (
            <XStack gap="$2" flexWrap="wrap">
              <Button
                variant="primary"
                size="$2"
                disabled={respondMutation.isPending}
                onPress={() => setAcceptTargetId(row.id)}
                testID={`org-rcv-accept-${row.id}`}
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
                testID={`org-rcv-decline-${row.id}`}
              >
                {String(t("admin.bkInboxDecline"))}
              </Button>
            </XStack>
          )}

          {isOpenRequest && declining && (
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
                placeholder={String(t("admin.bkRcvDeclineReasonPlaceholder"))}
                fullWidth
                aria-label={String(t("admin.bkInboxDeclineReasonLabel"))}
                testId={`org-rcv-decline-reason-${row.id}`}
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.bkRcvDeclineReasonHint"))}
              </Text>
              <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
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
                    // Optional reason: empty submits fine; a typed one must
                    // clear the server's 3-char floor.
                    (declineReason.trim().length > 0 &&
                      declineReason.trim().length < 3) ||
                    respondMutation.isPending
                  }
                  onPress={() => handleDecline(row.id)}
                  testID={`org-rcv-decline-confirm-${row.id}`}
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
      );
    },
    [
      declineReason,
      declineTargetId,
      expandedIds,
      fmt,
      handleDecline,
      orgNameOf,
      respondMutation.isPending,
      slug,
      t,
    ],
  );

  // ── Error state ───────────────────────────────────────────────────────────
  if (listQuery.isError) {
    return (
      <YStack gap="$3" paddingVertical="$4">
        <Text variant="body" tone="error">
          {String(t("admin.bkRcvLoadFailed"))}
        </Text>
        <XStack>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void listQuery.refetch()}
            testID="org-rcv-retry"
          >
            {String(t("admin.placesRetry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  // Two different emptinesses. "Nothing ever received" is an onboarding
  // moment; "nothing on THIS view" is a filter result, and showing the
  // onboarding copy for it would tell an org with five open requests it has
  // none.
  const emptyState =
    allRows.length > 0 ? (
      <YStack
        gap="$2"
        alignItems="center"
        justifyContent="center"
        paddingVertical="$7"
        paddingHorizontal="$4"
        borderWidth={2}
        borderColor="$borderColor"
      >
        <Inbox size={28} aria-hidden style={{ opacity: 0.3 }} />
        <Text variant="body" tone="muted" textAlign="center" maxWidth={380}>
          {String(
            t(
              view === "accepted"
                ? "admin.bkInboxEmptyAccepted"
                : "admin.bkInboxEmptyOpen",
            ),
          )}
        </Text>
      </YStack>
    ) : (
      <YStack
        gap="$3"
        alignItems="center"
        justifyContent="center"
        paddingVertical="$8"
        paddingHorizontal="$4"
        borderWidth={2}
        borderColor="$borderColor"
      >
        <Inbox size={36} aria-hidden style={{ opacity: 0.3 }} />
        <Text variant="h4" weight="bold" textAlign="center">
          {String(t("admin.bkWsRcvEmptyTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={380}>
          {String(t("admin.bkRcvEmpty"))}
        </Text>
      </YStack>
    );

  return (
    <YStack gap="$3">
      <StatusSegments<InboxView>
        value={view}
        onChange={setView}
        ariaLabel={String(t("admin.bkWsFilterLabel"))}
        testIdBase="org-rcv-filter"
        segments={[
          {
            key: "open",
            label: `${String(t("admin.bkInboxTabOpen"))} (${viewCounts.open})`,
          },
          {
            key: "accepted",
            label: `${String(t("admin.bkInboxTabAccepted"))} (${viewCounts.accepted})`,
          },
          {
            key: "all",
            label: `${String(t("admin.bkInboxTabAll"))} (${viewCounts.all})`,
          },
        ]}
      />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        isLoading={listQuery.isLoading}
        emptyState={emptyState}
        onRowPress={toggleExpand}
        renderExpandedRow={renderExpandedRow}
        renderMobileCard={renderMobileCard}
        rowActions={rowActions}
        // Borderless panel with no scrolling ancestor — restore DataTable's own
        // overflow wrapper for scoped horizontal panning.
        scrollContainer
        testIdBase="org-received-table"
      />

      <ConfirmDialog
        open={acceptTargetId !== null}
        onConfirm={handleAccept}
        onCancel={() => setAcceptTargetId(null)}
        title={String(t("admin.bkRcvAcceptConfirmTitle"))}
        description={String(
          t("admin.bkRcvAcceptConfirmBody", {
            org: acceptTarget
              ? orgNameOf(acceptTarget)
              : String(t("admin.bkRcvOrgFallback")),
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
