"use client";

import { useCallback, useState, type ReactNode } from "react";
import { YStack, XStack } from "tamagui";
import {
  Text,
  Button,
  Badge,
  Spinner,
  CharCountTextarea,
  NextLinkAnchor,
  useTranslations,
} from "@th/ui";
import {
  CheckCircle2,
  ExternalLink,
  RotateCcw,
  Send,
  ShoppingCart,
  Ticket,
  User as UserIcon,
} from "lucide-react";

import { trpc } from "@/trpc";
import { SupportThreadView } from "@/components/support/SupportThreadView";
import { SUPPORT_MESSAGE_MAX } from "@/components/support/constants";
import type { SupportThreadStatus } from "@/components/support/types";
import type { SupportThreadStaffDto } from "@th/core/use-cases/support";
import { resolveThreadIdentity } from "./identity";

function statusTone(status: SupportThreadStatus) {
  switch (status) {
    case "AWAITING_HUMAN":
      return "warning" as const;
    case "RESOLVED":
      return "success" as const;
    default:
      return "info" as const;
  }
}

function statusLabelKey(status: SupportThreadStatus): string {
  switch (status) {
    case "AWAITING_HUMAN":
      return "supportInbox.statusAwaiting";
    case "RESOLVED":
      return "supportInbox.statusResolved";
    default:
      return "supportInbox.statusOpen";
  }
}

export interface SupportThreadDetailProps {
  thread: SupportThreadStaffDto;
  onResolved: () => void;
}

export function SupportThreadDetail({
  thread,
  onResolved,
}: SupportThreadDetailProps) {
  const t = useTranslations();
  const [draft, setDraft] = useState("");
  const [pendingBody, setPendingBody] = useState<string | null>(null);

  const identity = resolveThreadIdentity(thread, {
    unknown: String(t("supportInbox.unknownAttendee")),
    fallback: (id) => String(t("supportInbox.attendeeFallback", { id })),
  });

  // Operator pivots. The orders pivot scopes /platform/orders to this exact
  // buyer via the new humanId filter — the UUID is the only identifier we put
  // in a URL (never the attendee's email).
  // Null humanId = an owner-less (GDPR/CCPA-erased) thread — no buyer to pivot
  // the orders filter to, so skip the link (same pattern as orderHref below).
  const ordersHref = thread.humanId
    ? `/platform/orders?humanId=${encodeURIComponent(thread.humanId)}`
    : null;
  const orderHref = thread.orderId
    ? `/platform/orders?orderId=${encodeURIComponent(thread.orderId)}`
    : null;
  // "View profile" deep-links /platform/humans prefilled by display name. We
  // deliberately skip this link when only an email is known: the humans search
  // would otherwise require the email in the URL, which we don't expose.
  const userSearchHref = thread.humanDisplayName?.trim()
    ? `/platform/humans?q=${encodeURIComponent(thread.humanDisplayName.trim())}`
    : null;

  // Deliberate full-fetch (no `since` cursor). The attendee widget polls
  // incrementally to keep the always-on 4s poll cheap, but the operator detail
  // must always render FULL history — including after the optimistic
  // `pendingBody` reply — and an operator session is short and deliberate, so
  // the steady-state cost problem (the always-on widget) doesn't apply here.
  // Passing `since` would force us to merge + preserve full history locally for
  // no real win, so we keep fetching the whole thread every 8s.
  const messagesQuery = trpc.support.getMessages.useQuery(
    { threadId: thread.id },
    {
      // Operator is actively reading; poll for the attendee's new messages.
      refetchInterval: 8_000,
      staleTime: 3_000,
    },
  );

  const reply = trpc.support.replyToThread.useMutation();
  const setStatus = trpc.support.setThreadStatus.useMutation();

  const liveStatus = messagesQuery.data?.thread.status ?? thread.status;
  const isResolved = liveStatus === "RESOLVED";

  const resolveLabelKey = setStatus.isPending
    ? "supportInbox.resolving"
    : isResolved
      ? "supportInbox.reopen"
      : "supportInbox.resolve";

  const handleReply = useCallback(async () => {
    const body = draft.trim();
    if (!body || reply.isPending) {
      return;
    }
    setPendingBody(body);
    setDraft("");
    try {
      await reply.mutateAsync({ threadId: thread.id, body });
      await messagesQuery.refetch();
    } catch {
      setDraft(body);
    } finally {
      setPendingBody(null);
    }
  }, [draft, reply, thread.id, messagesQuery]);

  const handleResolve = useCallback(async () => {
    if (setStatus.isPending) {
      return;
    }
    try {
      await setStatus.mutateAsync({
        threadId: thread.id,
        status: isResolved ? "OPEN" : "RESOLVED",
      });
      await messagesQuery.refetch();
      onResolved();
    } catch {
      // Surfaced via the global mutation error notifier.
    }
  }, [setStatus, thread.id, isResolved, messagesQuery, onResolved]);

  return (
    <YStack flex={1} minHeight={0}>
      {/* Detail header */}
      <YStack
        gap="$3"
        padding="$3"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        backgroundColor="$surfaceMuted"
      >
        {/* Status + identity + resolve action */}
        <XStack
          alignItems="flex-start"
          justifyContent="space-between"
          gap="$3"
          flexWrap="wrap"
        >
          <YStack gap="$2" flex={1} minWidth={0}>
            <XStack alignItems="center" gap="$2" flexWrap="wrap">
              <Badge tone={statusTone(liveStatus)} size="sm">
                {String(t(statusLabelKey(liveStatus)))}
              </Badge>
              <Text variant="caption" tone="muted">
                {String(t("supportInbox.threadHuman"))}
              </Text>
            </XStack>
            <Text
              variant="body"
              weight="bold"
              tone={identity.isFallback ? "muted" : "default"}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {identity.primary}
            </Text>
            {identity.secondary && (
              <Text
                variant="bodySmall"
                tone="muted"
                style={{
                  // Email is selectable so operators can copy it; never logged
                  // or placed in a URL.
                  userSelect: "all",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {identity.secondary}
              </Text>
            )}
          </YStack>
          <Button
            variant={isResolved ? "ghost" : "secondary"}
            size="$2"
            onPress={() => void handleResolve()}
            disabled={setStatus.isPending}
          >
            {setStatus.isPending ? (
              <Spinner size="small" />
            ) : isResolved ? (
              <RotateCcw size={14} aria-hidden />
            ) : (
              <CheckCircle2 size={14} aria-hidden />
            )}
            {String(t(resolveLabelKey))}
          </Button>
        </XStack>

        {/* Operator pivots + context */}
        <XStack alignItems="center" gap="$2" flexWrap="wrap">
          {ordersHref && (
            <PivotLink
              href={ordersHref}
              label={String(t("supportInbox.viewOrders"))}
              icon={<ShoppingCart size={13} aria-hidden />}
            />
          )}
          {userSearchHref && (
            <PivotLink
              href={userSearchHref}
              label={String(t("supportInbox.viewUser"))}
              icon={<UserIcon size={13} aria-hidden />}
            />
          )}
          {orderHref && (
            <PivotLink
              href={orderHref}
              label={
                thread.orderRef
                  ? `#${thread.orderRef}`
                  : String(t("supportInbox.viewOrder"))
              }
              icon={<Ticket size={13} aria-hidden />}
            />
          )}
          {thread.eventId && thread.eventTitle && (
            <Badge
              tone="neutral"
              size="xs"
              leadingIcon={<Ticket aria-hidden />}
              maxWidth={220}
            >
              {thread.eventTitle}
            </Badge>
          )}
        </XStack>
      </YStack>

      <SupportThreadView
        messages={messagesQuery.data?.messages ?? []}
        isLoading={messagesQuery.isLoading}
        isError={messagesQuery.isError}
        onRetry={() => void messagesQuery.refetch()}
        perspective="agent"
        pendingBody={pendingBody}
        testIdBase="support-inbox-thread"
      />

      {/* Reply composer */}
      <YStack
        borderTopWidth={2}
        borderTopColor="$borderColor"
        padding="$3"
        gap="$2"
        backgroundColor="$surface"
      >
        <CharCountTextarea
          value={draft}
          onChange={setDraft}
          maxLength={SUPPORT_MESSAGE_MAX}
          minHeight={56}
          maxLines={6}
          placeholder={String(t("supportInbox.replyPlaceholder"))}
          enterKeyHint="send"
          testIdBase="support-reply"
        />
        <XStack justifyContent="flex-end">
          <Button
            variant="primary"
            size="$2"
            onPress={() => void handleReply()}
            disabled={!draft.trim() || reply.isPending}
            data-testid="support-reply-send"
          >
            {reply.isPending ? (
              <Spinner size="small" />
            ) : (
              <Send size={14} aria-hidden />
            )}
            {String(t("supportInbox.reply"))}
          </Button>
        </XStack>
      </YStack>
    </YStack>
  );
}

SupportThreadDetail.displayName = "SupportThreadDetail";

/**
 * A compact, accessible operator pivot rendered as a real navigation link
 * (so middle-click / open-in-new-tab work). Styled as an outlined chip from
 * theme tokens — no hardcoded colors.
 */
function PivotLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <NextLinkAnchor href={href} aria-label={label}>
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
        maxWidth={240}
      >
        {icon}
        <Text
          variant="caption"
          weight="semibold"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </Text>
        <ExternalLink size={11} aria-hidden />
      </XStack>
    </NextLinkAnchor>
  );
}
