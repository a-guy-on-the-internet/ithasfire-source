"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { fmtCurrency } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  BOOKING_FEE_TYPE_LABEL_KEYS,
  BOOKING_STATUS_LABEL_KEYS,
  OPEN_BOOKING_STATUSES,
  bookingStatusTone,
  isoDateToLocal,
} from "@/lib/booking-requests";
import { adminAgreementHref } from "@/lib/agreement-routes";

export interface SentToActsListProps {
  /** The org whose outbound requests are listed (list scope "organizer"). */
  orgId: string;
  /** Admin slug of the shell this list runs under — agreement links. */
  slug: string;
}

/**
 * "Sent to acts" — the org's outbound booking requests
 * (organizer-booking-requests FR-008), lifted verbatim out of the old
 * `BookingsHub` into its own tab panel by booking-inbox-placement FR-002.
 * BEHAVIOUR IS UNCHANGED: same `organizer`-scope query, same optimistic
 * withdraw, same agreement link on ACCEPTED rows.
 *
 * Withdraw lives HERE and only here — it is the sender's action. Neither
 * inbound tab (`OrgVenueRequestsInbox`, `OrgReceivedRequestsTable`) may grow
 * one.
 */
export function SentToActsList({ orgId, slug }: SentToActsListProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const sentQuery = trpc.bookingRequests.list.useQuery(
    { scope: "organizer", organizerOrgId: orgId },
    { staleTime: 15_000, retry: false },
  );

  // Optimistic withdraw, mirroring SentBookingRequestsList.
  const [withdrawnIds, setWithdrawnIds] = useState<Set<string>>(new Set());
  const [pendingWithdrawId, setPendingWithdrawId] = useState<string | null>(
    null,
  );
  const withdrawMutation = trpc.bookingRequests.withdraw.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const handleWithdraw = (bookingRequestId: string) => {
    if (pendingWithdrawId) return;
    setPendingWithdrawId(bookingRequestId);
    setWithdrawnIds((prev) => new Set(prev).add(bookingRequestId));
    withdrawMutation.mutate(
      { bookingRequestId },
      {
        onError: (err) => {
          setWithdrawnIds((prev) => {
            const next = new Set(prev);
            next.delete(bookingRequestId);
            return next;
          });
          toast.danger({
            id: "hub-withdraw-failed",
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

  if (sentQuery.isLoading) {
    return (
      <YStack alignItems="center" paddingVertical="$4">
        <Spinner size="sm" />
      </YStack>
    );
  }

  if (sentQuery.isError) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.bkHubLoadFailed"))}
      </Text>
    );
  }

  const rows = (sentQuery.data?.requests ?? []).map((r) =>
    withdrawnIds.has(r.id) ? { ...r, status: "WITHDRAWN" as const } : r,
  );

  if (rows.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.bkHubActsEmpty"))}
      </Text>
    );
  }

  return (
    <YStack gap="$2">
      {rows.map((row) => {
        const isOpen = OPEN_BOOKING_STATUSES.includes(row.status);
        const firstDate = row.preferredDates[0];
        return (
          <XStack
            key={row.id}
            gap="$3"
            padding="$3"
            borderWidth={1}
            borderColor="$borderColor"
            borderRadius={0}
            alignItems="center"
            justifyContent="space-between"
            flexWrap="wrap"
          >
            <YStack gap="$1" flex={1} minWidth={180}>
              <Text variant="bodySmall" weight="bold">
                {row.performerDisplayName ??
                  String(t("admin.bkHubActFallback"))}
              </Text>
              <Text variant="caption" tone="muted">
                {row.attachedEventTitle
                  ? `${row.attachedEventTitle}${
                      row.attachedEventStartsAt
                        ? ` · ${fmt.dateTime(row.attachedEventStartsAt, {
                            dateStyle: "medium",
                          })}`
                        : ""
                    }`
                  : firstDate
                    ? `${fmt.dateTime(isoDateToLocal(firstDate), {
                        dateStyle: "medium",
                      })}${
                        row.preferredDates.length > 1
                          ? ` +${row.preferredDates.length - 1}`
                          : ""
                      }`
                    : ""}
                {row.feeType
                  ? ` · ${String(t(BOOKING_FEE_TYPE_LABEL_KEYS[row.feeType]))}${
                      row.feeAmountCents != null
                        ? ` ${fmtCurrency(
                            fmt,
                            row.feeAmountCents,
                            row.feeCurrency ?? "usd",
                          )}`
                        : ""
                    }`
                  : ""}
              </Text>
              {row.status === "DECLINED" && row.declineReason && (
                <Text variant="caption" tone="muted">
                  {String(
                    t("admin.bkHubDeclined", { reason: row.declineReason }),
                  )}
                </Text>
              )}
            </YStack>
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <Badge tone={bookingStatusTone(row.status)} size="sm">
                {String(t(BOOKING_STATUS_LABEL_KEYS[row.status]))}
              </Badge>
              {row.status === "ACCEPTED" && row.agreementId && (
                // The ANCHOR is the control and carries the accessible name;
                // the Button inside is decoration. A Tamagui Button emits
                // `role="button" tabindex="0"` even as a span, so without
                // `aria-hidden` AND `tabIndex={-1}` this ships an interactive
                // element nested inside a link, two tab stops on one
                // rectangle, and the label announced twice. The name also
                // carries the ACT, because the visible label repeats
                // identically on every accepted row.
                <NextLinkAnchor
                  href={adminAgreementHref(slug, row.agreementId)}
                  aria-label={`${String(
                    t("account.sPerformerViewAgreement"),
                  )} — ${
                    row.performerDisplayName ??
                    String(t("admin.bkHubActFallback"))
                  }`}
                >
                  <Button
                    tag="span"
                    variant="outlined"
                    size="$2"
                    aria-hidden
                    tabIndex={-1}
                    testID={`hub-view-agreement-${row.id}`}
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
                  onPress={() => handleWithdraw(row.id)}
                  testID={`hub-withdraw-${row.id}`}
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
        );
      })}
    </YStack>
  );
}
