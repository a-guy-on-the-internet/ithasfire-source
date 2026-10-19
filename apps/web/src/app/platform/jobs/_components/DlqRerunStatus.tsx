"use client";

import { Text } from "@th/ui";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useTheme, XStack, YStack } from "tamagui";

import type { DlqRerunNotice, DlqRerunTone } from "./dlq-rerun-outcome";

// Text colours are the status tokens tuned for TEXT in all three themes
// (`$dangerSoft` / `$warningSoft`); the bare `$danger` / `$warning` fills are
// below AA as small type on swiss and ember. A run that happened reads in ink,
// with the icon carrying the green.
const TEXT_COLOR = {
  success: "$color",
  warning: "$warningSoft",
  danger: "$dangerSoft",
} as const satisfies Record<DlqRerunTone, string>;

const ICON_TOKEN = {
  success: "success",
  warning: "warningSoft",
  danger: "dangerSoft",
} as const satisfies Record<DlqRerunTone, string>;

const ICON = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const satisfies Record<DlqRerunTone, typeof CheckCircle2>;

/**
 * The outcome of the last rerun in a DLQ panel.
 *
 * The `role="status"` element stays mounted while the panel is open and only
 * its contents change: a live region that arrives in the DOM already holding
 * its message is not announced reliably. Empty, it has no height and no gap of
 * its own (the spacing sits on the message), so the panel does not shift.
 */
export function DlqRerunStatus({ notice }: { notice: DlqRerunNotice | null }) {
  const theme = useTheme();
  const Icon = notice ? ICON[notice.tone] : null;

  return (
    <div role="status" data-testid="dlq-rerun-status">
      {notice && Icon ? (
        <XStack
          gap="$2"
          paddingTop="$3"
          alignItems="flex-start"
          data-tone={notice.tone}
        >
          {/* Nudged onto the first line of a message that may wrap. */}
          <YStack paddingTop={2} flexShrink={0}>
            <Icon
              size={14}
              color={theme[ICON_TOKEN[notice.tone]]?.val}
              aria-hidden
            />
          </YStack>
          <YStack flex={1} minWidth={0} gap={2}>
            {/* `anywhere`: a job error can be one unbroken token (a URL, a
                JSON blob) and must wrap inside a 320px panel, not widen it. */}
            <Text
              variant="bodySmall"
              color={TEXT_COLOR[notice.tone]}
              style={{ overflowWrap: "anywhere" }}
            >
              {notice.message}
              {/* The code sits in its own element right after this one, and a
                  live region is read as one run of text: without a space the
                  two join as "here.invalid_input". A trailing space does not
                  render. */}
              {notice.code ? " " : null}
            </Text>
            {notice.code ? (
              <Text
                fontFamily="$mono"
                fontSize={12}
                color="$colorMuted"
                style={{ overflowWrap: "anywhere" }}
              >
                {notice.code}
              </Text>
            ) : null}
          </YStack>
        </XStack>
      ) : null}
    </div>
  );
}
