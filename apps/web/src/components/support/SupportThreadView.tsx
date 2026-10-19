"use client";

import { useEffect, useMemo, useRef } from "react";
import { YStack, XStack, useTheme } from "tamagui";
import { Text, Spinner, Button, useTranslations, useLocale } from "@th/ui";
import { MessagesSquare } from "lucide-react";

import type { SupportMessageDto, SupportAuthorType } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// SupportThreadView — shared message list, used by the consumer widget and the
// operator inbox. The composer itself lives in the parent (widget vs inbox have
// different submit semantics), so this component focuses on rendering history,
// the empty/loading/error states, and a screen-reader-friendly live region.
// ─────────────────────────────────────────────────────────────────────────────

export type ThreadPerspective = "user" | "agent";

export interface SupportThreadViewProps {
  messages: SupportMessageDto[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /**
   * Whose side "USER" sits on. In the widget the signed-in attendee is the
   * USER (right-aligned); in the inbox the operator (HUMAN_AGENT) is "us"
   * (right-aligned) and the attendee's USER messages are left-aligned.
   */
  perspective: ThreadPerspective;
  /** Optimistic message being sent (rendered with reduced opacity). */
  pendingBody?: string | null;
  testIdBase?: string;
}

function isOwnMessage(
  authorType: SupportAuthorType,
  perspective: ThreadPerspective,
): boolean {
  return perspective === "user"
    ? authorType === "USER"
    : authorType === "HUMAN_AGENT";
}

function authorLabelKey(authorType: SupportAuthorType): string {
  switch (authorType) {
    case "USER":
      return "supportChat.you";
    case "HUMAN_AGENT":
      return "supportChat.agent";
    case "AI_CLERK":
      return "supportChat.assistant";
    case "SYSTEM":
    default:
      return "supportChat.system";
  }
}

export function SupportThreadView({
  messages,
  isLoading,
  isError,
  onRetry,
  perspective,
  pendingBody,
  testIdBase = "support-thread",
}: SupportThreadViewProps) {
  const t = useTranslations();
  const locale = useLocale();
  const theme = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the conversation grows / arrives, and
  // re-pin to the bottom when the mobile keyboard opens/closes (visualViewport
  // resize) so the latest message stays visible above the keyboard.
  useEffect(() => {
    const scrollToBottom = () => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    };
    scrollToBottom();

    if (typeof window === "undefined" || !window.visualViewport) {
      return;
    }
    const vv = window.visualViewport;
    vv.addEventListener("resize", scrollToBottom);
    return () => vv.removeEventListener("resize", scrollToBottom);
  }, [messages.length, pendingBody]);

  const ownBg = theme.brandSecondary?.val ?? "#E2481D";
  const ownText = theme.colorInverted?.val ?? "#FFFFFF";
  // Fallbacks are the STUB (shipped default) values — the incoming bubble must
  // degrade to paper-and-ink, not the retired dark theme's white alphas.
  const otherBg = theme.surfaceMuted?.val ?? "#EFE7D6";
  const otherBorder = theme.borderColor?.val ?? "#211C16";

  const hasMessages = messages.length > 0 || Boolean(pendingBody);

  const timeFormatter = useMemo(
    () => (date: Date) =>
      date.toLocaleTimeString(locale, {
        hour: "numeric",
        minute: "2-digit",
      }),
    [locale],
  );

  return (
    <YStack
      flex={1}
      minHeight={0}
      ref={scrollRef as never}
      // The message history is a polite live region so screen readers announce
      // operator replies that arrive via polling without stealing focus.
      role="log"
      aria-live="polite"
      aria-label={String(t("supportChat.messagesRegionLabel"))}
      aria-busy={isLoading || undefined}
      style={{
        overflowY: "auto",
        overflowX: "hidden",
        // Keep touch-scrolling the message list from chaining into the page
        // behind the sheet (rubber-band / scroll-through) on mobile.
        overscrollBehavior: "contain",
      }}
      padding="$3"
      gap="$2"
      data-testid={`${testIdBase}-list`}
    >
      {isLoading && !hasMessages ? (
        // aria-hidden: keep the polite live region from announcing transient
        // loading/empty/error placeholders on poll churn — it should only
        // announce real messages as they arrive.
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          gap="$2"
          padding="$4"
          aria-hidden
        >
          <Spinner size="small" />
          <Text variant="bodySmall" tone="muted">
            {String(t("supportChat.loading"))}
          </Text>
        </YStack>
      ) : isError && !hasMessages ? (
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          gap="$3"
          padding="$4"
          aria-hidden
        >
          <Text variant="bodySmall" tone="error" textAlign="center">
            {String(t("supportChat.loadError"))}
          </Text>
          <Button variant="outlined" size="$2" onPress={onRetry}>
            {String(t("supportChat.retry"))}
          </Button>
        </YStack>
      ) : !hasMessages ? (
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          gap="$2"
          padding="$5"
          aria-hidden
        >
          <MessagesSquare size={28} color={theme.colorMuted?.val ?? "#888"} />
          <Text variant="label" weight="bold" textAlign="center">
            {String(t("supportChat.emptyTitle"))}
          </Text>
          <Text variant="bodySmall" tone="muted" textAlign="center" maxWidth={260}>
            {String(t("supportChat.emptyBody"))}
          </Text>
        </YStack>
      ) : (
        <>
          {messages.map((message) => {
            const own = isOwnMessage(message.authorType, perspective);
            const created = new Date(message.createdAt);
            return (
              <XStack
                key={message.id}
                justifyContent={own ? "flex-end" : "flex-start"}
                width="100%"
              >
                <YStack
                  maxWidth="85%"
                  gap={2}
                  backgroundColor={own ? ownBg : otherBg}
                  borderColor={own ? ownBg : otherBorder}
                  borderWidth={1}
                  paddingHorizontal="$3"
                  paddingVertical="$2"
                >
                  {!own && (
                    <Text
                      variant="overline"
                      weight="bold"
                      tone="muted"
                      fontSize={10}
                    >
                      {String(t(authorLabelKey(message.authorType)))}
                    </Text>
                  )}
                  <Text
                    variant="bodySmall"
                    color={own ? ownText : undefined}
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {message.body}
                  </Text>
                  <Text
                    variant="caption"
                    fontSize={10}
                    color={own ? ownText : undefined}
                    tone={own ? "default" : "muted"}
                    style={{ opacity: 0.75 }}
                  >
                    {timeFormatter(created)}
                  </Text>
                </YStack>
              </XStack>
            );
          })}

          {pendingBody ? (
            <XStack justifyContent="flex-end" width="100%">
              <YStack
                maxWidth="85%"
                gap={2}
                backgroundColor={ownBg}
                borderColor={ownBg}
                borderWidth={1}
                paddingHorizontal="$3"
                paddingVertical="$2"
                opacity={0.6}
                data-testid={`${testIdBase}-pending`}
              >
                <Text
                  variant="bodySmall"
                  color={ownText}
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                >
                  {pendingBody}
                </Text>
                <Text variant="caption" fontSize={10} color={ownText} style={{ opacity: 0.8 }}>
                  {String(t("supportChat.sending"))}
                </Text>
              </YStack>
            </XStack>
          ) : null}
        </>
      )}
    </YStack>
  );
}

SupportThreadView.displayName = "SupportThreadView";
