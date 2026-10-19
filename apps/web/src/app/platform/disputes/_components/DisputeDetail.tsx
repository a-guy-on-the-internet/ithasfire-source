"use client";

// i18n: key pending — every user-facing string in this file is an English
// literal; the locale catalogs are off-limits for this change (see the
// "Roles" nav item precedent in platform/layout.tsx).

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
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
import { MoneyText } from "../../_components/MoneyText";
import { DateTimeText } from "../../_components/DateTimeText";
import { ArrowLeft, Copy, ExternalLink, Ticket, X } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { formatOrderCode } from "@th/types/order-identifier";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate } from "@/lib/format";
import { EvidenceEditor } from "./EvidenceEditor";
import {
  disputeReasonLabel,
  disputeStatusLabel,
  disputeStatusTone,
  dueTreatment,
  evidenceStatusLabel,
  evidenceStatusTone,
  type DueTreatment,
} from "./dispute-desk.helpers";

export type DisputeDetailData =
  inferRouterOutputs<AppRouter>["platform"]["disputes"]["get"];

export interface DisputeDetailProps {
  disputeId: string;
  canWrite: boolean;
  isMobile: boolean;
  now: Date;
  /** Receives focus when a row is selected. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Move focus to the heading once the dispute has loaded. */
  focusOnLoad: boolean;
  onClose: () => void;
  /** Fired after any successful write so the queue re-syncs. */
  onChanged: () => void;
}

/**
 * Focus the heading when the loaded/error view MOUNTS — the loading view's
 * placeholder heading is replaced when the query resolves, so focusing on
 * selection alone lands on a node that is about to unmount.
 */
function useFocusOnMount(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const raf = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(raf);
    // Mount-only by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function dueColor(intent: DueTreatment["intent"]): string {
  switch (intent) {
    case "danger":
      return "$dangerSoft";
    case "warning":
      return "$warningSoft";
    default:
      return "$color";
  }
}

export function DisputeDetail({
  disputeId,
  canWrite,
  isMobile,
  now,
  headingRef,
  focusOnLoad,
  onClose,
  onChanged,
}: DisputeDetailProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // Unsaved edits in the evidence editor pause the poll: a refetch that
  // moves `updatedAt` would otherwise flag the editor as stale mid-edit.
  const [dirty, setDirty] = useState(false);

  const query = trpc.platform.disputes.get.useQuery(
    { disputeId },
    {
      // Status can move under us (webhooks); keep it honest while visible.
      refetchInterval: dirty ? false : 30_000,
      refetchIntervalInBackground: false,
      staleTime: 10_000,
    },
  );

  const handleChanged = useCallback(() => {
    void utils.platform.disputes.get.invalidate({ disputeId });
    onChanged();
  }, [utils, disputeId, onChanged]);

  const copyId = useCallback(
    (value: string) => {
      const clipboard =
        typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      if (!clipboard?.writeText) return;
      void clipboard.writeText(value).then(
        () => toast.success({ title: "Dispute ID copied" }),
        () => toast.danger({ title: "Could not copy the dispute ID" }),
      );
    },
    [toast],
  );

  const data = query.data;

  return (
    <YStack
      tag="section"
      aria-labelledby="dispute-detail-heading"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
      minWidth={0}
      gap={0}
    >
      {/* Panel chrome: back (mobile) / close (desktop) */}
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        alignItems="center"
        justifyContent="space-between"
        gap="$2"
      >
        {isMobile ? (
          <Button variant="ghost" size="$4" onPress={onClose}>
            <ArrowLeft size={16} aria-hidden />
            {String(t("common.back"))}
          </Button>
        ) : (
          <Text variant="overline" tone="muted">
            Dispute
          </Text>
        )}
        {!isMobile && (
          <Button
            variant="ghost"
            size="$3"
            icon
            onPress={onClose}
            aria-label="Close details"
          >
            <X size={16} aria-hidden />
          </Button>
        )}
      </XStack>

      {query.isLoading ? (
        <YStack padding="$6" alignItems="center" gap="$2">
          <Spinner size="small" />
          <Text variant="bodySmall" tone="muted">
            Loading dispute…
          </Text>
          {/* The heading must exist for focus even while loading. */}
          <h2
            ref={headingRef}
            id="dispute-detail-heading"
            tabIndex={-1}
            style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", margin: 0 }}
          >
            Dispute details
          </h2>
        </YStack>
      ) : query.isError || !data ? (
        <DisputeDetailError
          message={
            query.error
              ? formatErrorMessage(query.error, (key) => String(t(key)))
              : "Something went wrong."
          }
          headingRef={headingRef}
          focusOnLoad={focusOnLoad}
          isMobile={isMobile}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <DisputeDetailBody
          data={data}
          canWrite={canWrite}
          isMobile={isMobile}
          now={now}
          headingRef={headingRef}
          focusOnLoad={focusOnLoad}
          onCopyId={copyId}
          onChanged={handleChanged}
          onDirtyChange={setDirty}
        />
      )}
    </YStack>
  );
}

DisputeDetail.displayName = "DisputeDetail";

// ─────────────────────────────────────────────────────────────────────────────

function DisputeDetailError({
  message,
  headingRef,
  focusOnLoad,
  isMobile,
  onRetry,
}: {
  message: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  focusOnLoad: boolean;
  isMobile: boolean;
  onRetry: () => void;
}) {
  useFocusOnMount(headingRef, focusOnLoad);
  return (
    <YStack padding="$6" alignItems="center" gap="$3">
      <h2
        ref={headingRef}
        id="dispute-detail-heading"
        tabIndex={-1}
        style={{ margin: 0, outline: "none" }}
      >
        <Text variant="label" weight="bold">
          Dispute could not be loaded
        </Text>
      </h2>
      <Text variant="bodySmall" tone="error" style={{ textAlign: "center" }}>
        {message}
      </Text>
      <Button variant="secondary" size={isMobile ? "$4" : "$2"} onPress={onRetry}>
        Retry loading dispute
      </Button>
    </YStack>
  );
}

function DisputeDetailBody({
  data,
  canWrite,
  isMobile,
  now,
  headingRef,
  focusOnLoad,
  onCopyId,
  onChanged,
  onDirtyChange,
}: {
  data: DisputeDetailData;
  canWrite: boolean;
  isMobile: boolean;
  now: Date;
  headingRef: RefObject<HTMLHeadingElement | null>;
  focusOnLoad: boolean;
  onCopyId: (value: string) => void;
  onChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const fmt = useFormatters();
  useFocusOnMount(headingRef, focusOnLoad);
  const { dispute, order, buyer, event, owner, evidence, ledger } = data;
  const due = dueTreatment(dispute.evidenceDueBy, now, dispute.evidencePastDue);

  const orderHref = order
    ? `/platform/orders?orderId=${encodeURIComponent(order.id)}`
    : null;
  // The web client has no Stripe publishable key to sniff test/live mode
  // from, so the link is the live dashboard and says so.
  const stripeHref = `https://dashboard.stripe.com/disputes/${encodeURIComponent(dispute.stripeDisputeId)}`;

  return (
    <YStack>
      {/* Header */}
      <YStack
        gap="$3"
        padding="$4"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        backgroundColor="$surfaceMuted"
      >
        <XStack alignItems="center" gap="$2" flexWrap="wrap">
          <Badge tone={disputeStatusTone(dispute.status)} size="sm">
            {disputeStatusLabel(dispute.status)}
          </Badge>
          <Badge tone={evidenceStatusTone(evidence?.status ?? null)} size="sm">
            {evidenceStatusLabel(evidence?.status ?? null)}
          </Badge>
        </XStack>

        <XStack alignItems="center" gap="$2" flexWrap="wrap" minWidth={0}>
          <h2
            ref={headingRef}
            id="dispute-detail-heading"
            tabIndex={-1}
            style={{ margin: 0, minWidth: 0, outline: "none" }}
          >
            <Text
              variant="body"
              weight="bold"
              fontFamily="$mono"
              style={{ overflowWrap: "anywhere", userSelect: "all" }}
            >
              {dispute.stripeDisputeId}
            </Text>
          </h2>
          <Button
            variant="ghost"
            size={isMobile ? "$4" : "$3"}
            icon
            onPress={() => onCopyId(dispute.stripeDisputeId)}
            aria-label="Copy dispute ID"
          >
            <Copy size={14} aria-hidden />
          </Button>
        </XStack>

        <XStack
          justifyContent="space-between"
          alignItems="flex-end"
          gap="$3"
          flexWrap="wrap"
        >
          {/* Tamagui stacks default to flexShrink 0 on web — without these the
              two blocks refuse to shrink and the row overflows at 320px. */}
          <YStack gap="$1" flexShrink={1} minWidth={0}>
            <Text variant="overline" tone="muted">
              Disputed amount
            </Text>
            <MoneyText
              cents={dispute.amountCents}
              currency={dispute.currency}
              weight="bold"
              fontFamily="$mono"
              style={{ fontSize: 22, letterSpacing: 0.4 }}
            />
            {dispute.feeCents > 0 && (
              <Text
                variant="caption"
                tone="muted"
                fontFamily="$mono"
                style={{ overflowWrap: "anywhere" }}
              >
                + {MoneyText.format(dispute.feeCents, { currency: dispute.currency })}{" "}
                Stripe fee
                {dispute.feeBorneBy
                  ? ` · borne by ${dispute.feeBorneBy === "PLATFORM" ? "platform" : "payee"}`
                  : ""}
              </Text>
            )}
          </YStack>
          <YStack
            gap="$1"
            flexShrink={1}
            minWidth={0}
            alignItems={isMobile ? "flex-start" : "flex-end"}
          >
            <Text variant="overline" tone="muted">
              Evidence due
            </Text>
            <Text
              variant="body"
              weight="bold"
              color={dueColor(due.intent)}
              fontFamily="$mono"
            >
              {due.label}
            </Text>
            <Text variant="caption" tone="muted">
              {dispute.evidenceDueBy
                ? fmtDate(fmt, dispute.evidenceDueBy)
                : "No deadline reported"}
            </Text>
          </YStack>
        </XStack>

        <XStack alignItems="center" gap="$2" flexWrap="wrap">
          <Text variant="bodySmall">
            <Text variant="bodySmall" tone="muted">
              Reason:{" "}
            </Text>
            {disputeReasonLabel(dispute.reason)}
          </Text>
          {dispute.triageReason && (
            <Text variant="caption" tone="muted">
              · {dispute.triageReason}
            </Text>
          )}
        </XStack>

        <XStack alignItems="center" gap="$2" flexWrap="wrap">
          <PivotLink href={stripeHref} label="Open in Stripe (live)" external />
          {orderHref && order && (
            <PivotLink
              href={orderHref}
              label={`Order #${formatOrderCode(order.id)}`}
              icon={<Ticket size={13} aria-hidden />}
            />
          )}
        </XStack>
      </YStack>

      {/* Order */}
      <Section title="Order" id="dispute-section-order" isMobile={isMobile}>
        {order ? (
          <Facts
            isMobile={isMobile}
            items={[
              { label: "Order code", value: formatOrderCode(order.id), mono: true },
              {
                label: "Kind",
                value: order.kind === "MEMBERSHIP" ? "Membership" : "Ticketing",
              },
              { label: "Order status", value: order.status },
              { label: "Buyer", value: buyer?.name ?? "Unknown buyer" },
              {
                label: "Buyer email",
                value: buyer?.email ? (
                  <Text
                    variant="bodySmall"
                    style={{ userSelect: "all", overflowWrap: "anywhere" }}
                  >
                    {buyer.email}
                  </Text>
                ) : (
                  "—"
                ),
              },
              { label: "Checkout IP", value: order.checkoutIp ?? "—", mono: true },
              {
                label: "Method",
                value: [order.paymentChannel, order.paymentMethodType]
                  .filter(Boolean)
                  .join(" · "),
              },
              { label: "Descriptor", value: order.billingDescriptor ?? "—", mono: true },
              {
                label: "Gross",
                value: (
                  <MoneyText
                    cents={order.amountGrossCents}
                    currency={order.currency}
                    variant="bodySmall"
                    fontFamily="$mono"
                  />
                ),
              },
              {
                label: "Tax",
                value: (
                  <MoneyText
                    cents={order.taxAmountCents}
                    currency={order.currency}
                    variant="bodySmall"
                    fontFamily="$mono"
                  />
                ),
              },
              { label: "Placed", value: fmtDate(fmt, order.occurredAt) },
            ]}
          />
        ) : (
          <Text variant="bodySmall" tone="muted">
            This dispute is not linked to an order. The charge may predate the
            platform's order records, or the link failed at triage.
          </Text>
        )}
      </Section>

      {/* Event / owner */}
      <Section
        title="Event and owner"
        id="dispute-section-event"
        isMobile={isMobile}
      >
        <Facts
          isMobile={isMobile}
          items={[
            { label: "Event", value: event?.title ?? "—" },
            {
              label: "Starts",
              value: event ? (
                <DateTimeText
                  value={event.startsAt}
                  timeZone={event.timezone}
                  variant="bodySmall"
                />
              ) : (
                "—"
              ),
            },
            {
              label: "Owner",
              value: owner
                ? `${owner.name ?? "Unnamed"} · ${owner.subjectType === "ORGANIZATION" ? "Group" : "Human"}`
                : "—",
            },
          ]}
        />
      </Section>

      {/* Ledger */}
      <Section title="Ledger" id="dispute-section-ledger" isMobile={isMobile}>
        <Facts
          isMobile={isMobile}
          items={[
            {
              label: "Held",
              value: (
                <MoneyText
                  cents={ledger.heldCents}
                  currency={dispute.currency}
                  variant="bodySmall"
                  fontFamily="$mono"
                />
              ),
            },
            {
              label: "Debited",
              value: (
                <MoneyText
                  cents={ledger.debitedCents}
                  currency={dispute.currency}
                  variant="bodySmall"
                  fontFamily="$mono"
                />
              ),
            },
            {
              label: "Active holds",
              value: String(ledger.activeHolds.length),
              mono: true,
            },
            {
              label: "Funds withdrawn",
              value: dispute.fundsWithdrawnAt
                ? fmtDate(fmt, dispute.fundsWithdrawnAt)
                : "Not yet",
            },
            ...(dispute.closedAt
              ? [
                  {
                    label: "Closed",
                    value: `${fmtDate(fmt, dispute.closedAt)}${dispute.outcome ? ` · ${dispute.outcome}` : ""}`,
                  },
                ]
              : []),
          ]}
        />
      </Section>

      {/* Evidence */}
      <Section title="Evidence" id="dispute-section-evidence" isMobile={isMobile}>
        <EvidenceEditor
          // A different PACKAGE remounts; the same package re-syncs its own
          // draft on `updatedAt` (preserving unsaved edits).
          key={evidence ? evidence.id : "none"}
          disputeId={dispute.id}
          evidence={evidence}
          dispute={dispute}
          canWrite={canWrite}
          isMobile={isMobile}
          due={due}
          onChanged={onChanged}
          onDirtyChange={onDirtyChange}
        />
      </Section>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Section({
  title,
  id,
  isMobile,
  children,
}: {
  title: string;
  id: string;
  isMobile: boolean;
  children: ReactNode;
}) {
  return (
    <YStack
      tag="section"
      aria-labelledby={id}
      gap="$3"
      padding={isMobile ? "$3" : "$4"}
      borderBottomWidth={2}
      borderBottomColor="$borderColor"
    >
      <h3 id={id} style={{ margin: 0 }}>
        <Text variant="overline">{title}</Text>
      </h3>
      {children}
    </YStack>
  );
}

/** Label/value rows. Columns must align across rows → grid, not flex. */
function Facts({
  items,
  isMobile,
}: {
  items: Array<{ label: string; value: ReactNode; mono?: boolean }>;
  isMobile: boolean;
}) {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: isMobile
          ? "minmax(0, 1fr)"
          : "minmax(96px, max-content) minmax(0, 1fr)",
        columnGap: 16,
        rowGap: isMobile ? 4 : 8,
        margin: 0,
      }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          <dt style={{ margin: 0 }}>
            <Text variant="overline" tone="muted">
              {item.label}
            </Text>
          </dt>
          <dd
            style={{
              margin: 0,
              minWidth: 0,
              marginBottom: isMobile ? 6 : 0,
            }}
          >
            {typeof item.value === "string" ? (
              <Text
                variant="bodySmall"
                fontFamily={item.mono ? "$mono" : undefined}
                style={{ overflowWrap: "anywhere" }}
              >
                {item.value}
              </Text>
            ) : (
              item.value
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Operator pivot chip — a real link so middle-click / new tab work. */
function PivotLink({
  href,
  label,
  icon,
  external,
}: {
  href: string;
  label: string;
  icon?: ReactNode;
  external?: boolean;
}) {
  const body = (
    <XStack
      tag="span"
      alignItems="center"
      gap="$2"
      paddingHorizontal="$3"
      paddingVertical="$2"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
      hoverStyle={{ backgroundColor: "$surfaceMuted" }}
      maxWidth={260}
    >
      {icon}
      <Text
        variant="caption"
        weight="semibold"
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </Text>
      <ExternalLink size={11} aria-hidden />
    </XStack>
  );
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`${label} (opens in a new tab)`}
        style={{ textDecoration: "none", color: "inherit" }}
      >
        {body}
      </a>
    );
  }
  return (
    <NextLinkAnchor href={href} aria-label={label}>
      {body}
    </NextLinkAnchor>
  );
}
