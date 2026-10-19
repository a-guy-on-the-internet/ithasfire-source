"use client";

import { use } from "react";
import { YStack, XStack } from "tamagui";
import {
  Badge,
  Button,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { ArrowRight, Check, ShieldAlert, ShieldCheck } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

type PageProps = {
  params: Promise<{ lineId: string }>;
};

export default function AcknowledgePayoutLinePage({ params }: PageProps) {
  const { lineId } = use(params);
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const lineQuery = trpc.payoutTerms.getPayoutLineForAck.useQuery(
    { payoutTermsLineId: lineId },
    { staleTime: 30_000, retry: false },
  );

  const confirmMutation = trpc.payoutTerms.confirmPayoutLine.useMutation({
    onSuccess: () => {
      toast.success({
        id: "payout-line-confirmed",
        title: String(t("payoutAck.confirmedToastTitle")),
        message: String(t("payoutAck.confirmedToastBody")),
      });
      void utils.payoutTerms.getPayoutLineForAck.invalidate({
        payoutTermsLineId: lineId,
      });
    },
    onError: (err) => {
      toast.danger({
        id: "payout-line-confirm-failed",
        title: String(t("payoutAck.confirmFailed")),
        // CONFLICT: the stored share no longer matches the one this page
        // showed. The refetch below puts the new share on screen.
        message:
          err.data?.code === "CONFLICT"
            ? String(t("payoutAck.confirmConflict"))
            : formatErrorMessage(err, t),
      });
      // The share may have changed since this page loaded (the server
      // refuses an answer to terms it no longer holds): show the current one.
      void utils.payoutTerms.getPayoutLineForAck.invalidate({
        payoutTermsLineId: lineId,
      });
    },
  });

  const ackEventTitle = lineQuery.data?.event.title;
  useDocumentTitle(
    ackEventTitle
      ? String(t("payoutAck.docTitle", { title: ackEventTitle }))
      : String(t("payoutAck.kicker")),
  );

  if (lineQuery.isLoading) {
    return (
      <YStack
        minHeight="100vh"
        alignItems="center"
        justifyContent="center"
        padding="$6"
      >
        <Spinner size="large" />
      </YStack>
    );
  }

  if (lineQuery.error) {
    return (
      <YStack
        minHeight="100vh"
        alignItems="center"
        justifyContent="center"
        padding="$6"
        gap="$3"
        maxWidth={480}
        marginHorizontal="auto"
      >
        <Text variant="h3" textAlign="center">
          {String(t("payoutAck.loadFailed"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {formatErrorMessage(lineQuery.error, t)}
        </Text>
        <Button
          variant="outlined"
          size="$2"
          onPress={() => lineQuery.refetch()}
        >
          {String(t("payoutAck.tryAgain"))}
        </Button>
      </YStack>
    );
  }

  const data = lineQuery.data;
  if (!data) return null;

  const sharePct = (data.percentBps / 100).toFixed(
    data.percentBps % 100 === 0 ? 0 : 2,
  );
  // The whole "of …" phrase per kind, so each language can order it.
  const kindPhrase = String(
    t(
      data.kind === "PRIMARY"
        ? "payoutAck.shareOfTickets"
        : data.kind === "RESALE"
          ? "payoutAck.shareOfResale"
          : "payoutAck.shareOfMerch",
    ),
  );
  const isConfirmed = data.confirmationStatus === "CONFIRMED";
  const eventStartLabel = data.event.startsAt
    ? fmt.dateTime(new Date(data.event.startsAt), {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <YStack
      minHeight="100vh"
      padding="$6"
      gap="$5"
      maxWidth={560}
      marginHorizontal="auto"
      width="100%"
    >
      <YStack gap="$2">
        <Text variant="caption" tone="muted">
          {String(t("payoutAck.kicker"))}
        </Text>
        <Text variant="h2" weight="bold">
          {data.event.title ?? String(t("payoutAck.untitledEvent"))}
        </Text>
        {eventStartLabel ? (
          <Text variant="body" tone="muted">
            {eventStartLabel}
          </Text>
        ) : null}
      </YStack>

      <YStack
        gap="$3"
        padding="$4"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
      >
        <XStack justifyContent="space-between" alignItems="center">
          <Text variant="body">
            <Text variant="body" weight="bold">
              {sharePct}%
            </Text>{" "}
            {kindPhrase}
          </Text>
          {isConfirmed ? (
            <Badge tone="success" size="sm">
              {String(t("payoutAck.statusConfirmed"))}
            </Badge>
          ) : (
            <Badge tone="info" size="sm">
              {String(t("payoutAck.statusPending"))}
            </Badge>
          )}
        </XStack>
        <XStack gap="$2" alignItems="center">
          {data.payeeConnectActive ? (
            <>
              <ShieldCheck size={14} color="var(--success, #166534)" />
              <Text variant="caption" tone="muted">
                {String(t("payoutAck.stripeActive"))}
              </Text>
            </>
          ) : (
            <>
              <ShieldAlert size={14} color="var(--warning, #92400E)" />
              <Text variant="caption" tone="warning">
                {String(t("payoutAck.stripeInactive"))}
              </Text>
            </>
          )}
        </XStack>
      </YStack>

      <YStack gap="$2">
        <Button
          variant="primary"
          size="$3"
          onPress={() =>
            confirmMutation.mutate({
              payoutTermsLineId: lineId,
              decision: "CONFIRM",
              // The share this page displays; the server refuses the answer
              // if the stored line no longer matches it.
              answered: {
                percent: data.percentBps / 100,
                floorCents: data.floorCents,
                capPercent: data.capPercent,
              },
            })
          }
          disabled={isConfirmed || confirmMutation.isPending}
        >
          <Check size={16} />
          {String(
            t(isConfirmed ? "payoutAck.alreadyConfirmed" : "payoutAck.looksGood"),
          )}
        </Button>
        <Text variant="caption" tone="muted">
          {String(t("payoutAck.confirmNote"))}
        </Text>
      </YStack>

      {!data.payeeConnectActive ? (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={1}
          borderColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("payoutAck.finishTitle"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("payoutAck.finishBody"))}
          </Text>
          {/* `/admin`, not a workspace's Payouts page: this read does not
              say which workspace owns the payee (a personal one or an org
              the reader administers), and guessing could open the wrong
              org. `/admin` sends a personal-only reader to their own
              dashboard and anyone else to the workspace picker; each
              workspace's rail has Payouts. (`/dashboard/payments` 404'd.) */}
          <XStack
            tag="a"
            {...{
              href: "/admin",
              style: { display: "inline-flex", alignItems: "center", gap: 4 },
            }}
            alignItems="center"
            gap="$1"
          >
            <Text variant="bodySmall" weight="bold">
              {String(t("payoutAck.openWorkspace"))}
            </Text>
            {/* In-app destination: an arrow, not the external-link glyph. */}
            <ArrowRight size={12} aria-hidden />
          </XStack>
        </YStack>
      ) : null}
    </YStack>
  );
}
