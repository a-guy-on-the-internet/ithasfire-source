"use client";

import { useId, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  DateTime,
  NextLinkAnchor,
  Text,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getInvalidFieldsMeta } from "@/lib/suggestion-error";

/** Writers named before "and N more". The notice stays a few lines long. */
const MAX_WRITERS_SHOWN = 3;

export interface CommunityHandoverNoticeProps {
  placeId: string;
  /**
   * Called after Keep or Clear lands, once the handover and page reads are
   * invalidated. The block canvas remounts here: Clear rewrites the main
   * section, and the canvas keeps local undo history the refetch can't reach.
   */
  onResolved?: () => void;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The new owner's first look at what community moderators wrote on their
 * place's page before the claim (moderator-place-page D6, FR-007/FR-008):
 * who, how many changes, when, and the two choices. Renders nothing until the
 * handover read says something is pending, so owners without moderator
 * history (and every non-owner, who gets FORBIDDEN) see no trace of it.
 *
 * The read only runs in the browser, so the dates in it never meet the
 * server render and cannot mismatch on hydration.
 */
export function CommunityHandoverNotice({
  placeId,
  onResolved,
}: CommunityHandoverNoticeProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refusal, setRefusal] = useState<
    { kind: "draft" } | { kind: "message"; text: string } | null
  >(null);
  const titleId = useId();

  const handoverQuery = trpc.entityPages.communityHandover.useQuery(
    { placeId },
    { retry: false, staleTime: 30_000, meta: { silent: true } },
  );
  const pending = handoverQuery.data?.pending ?? null;

  const resolve = trpc.entityPages.resolveCommunityHandover.useMutation({
    // Said inline beside the buttons, not as the global toast.
    meta: { silent: true },
    onSuccess: async (result) => {
      setConfirmOpen(false);
      setRefusal(null);
      await Promise.all([
        utils.entityPages.communityHandover.invalidate({ placeId }),
        utils.entityPages.getMyPage.invalidate({
          ownerType: "PLACE",
          ownerId: placeId,
        }),
      ]);
      if (result.outcome === "kept") {
        toast.success(String(t("communityPlacePage.handoverKeptToast")));
      } else if (result.outcome === "cleared") {
        toast.success(String(t("communityPlacePage.handoverClearedToast")));
      }
      onResolved?.();
    },
    onError: (err) => {
      setConfirmOpen(false);
      setRefusal(
        getInvalidFieldsMeta(err)?.reason === "handover_draft_pending"
          ? { kind: "draft" }
          : { kind: "message", text: formatErrorMessage(err, t) },
      );
    },
  });

  const timeZone = useMemo(() => browserTimeZone(), []);

  if (!pending) return null;

  const shown = pending.writers.slice(0, MAX_WRITERS_SHOWN);
  const hidden = pending.writers.length - shown.length;
  const working = resolve.isPending;

  return (
    <>
      {/* A standing notice, not a live region: it is on the page before the
          owner does anything, so there is nothing to announce. The one live
          region is the refusal line below, which appears after a press. The
          treatment is the muted band with an accent rule the place dialog's
          second-factor notice already uses. */}
      <YStack
        tag="section"
        aria-labelledby={titleId}
        gap="$3"
        padding="$3"
        backgroundColor="$surfaceMuted"
        borderLeftWidth={3}
        borderLeftColor="$accent"
        borderRadius={0}
        data-testid="community-handover-notice"
      >
        <YStack gap="$1">
          <Text id={titleId} tag="h2" variant="body" weight="bold">
            {String(t("communityPlacePage.handoverTitle"))}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {String(t("communityPlacePage.handoverBody"))}
          </Text>
        </YStack>

        <YStack gap="$1" tag="ul" margin={0} padding={0}>
          {shown.map((writer) => (
            <Text
              key={writer.humanId}
              tag="li"
              variant="bodySmall"
              style={{ listStyle: "none" }}
            >
              {String(
                t("communityPlacePage.handoverWriter", {
                  name:
                    writer.name ??
                    String(t("communityPlacePage.handoverWriterUnknown")),
                  count: writer.updateCount,
                  date: DateTime.format(writer.lastUpdatedAt, "date", {
                    timeZone,
                    locale,
                  }),
                }),
              )}
            </Text>
          ))}
          {hidden > 0 ? (
            <Text
              tag="li"
              variant="bodySmall"
              tone="muted"
              style={{ listStyle: "none" }}
            >
              {String(
                t("communityPlacePage.handoverMoreWriters", { count: hidden }),
              )}
            </Text>
          ) : null}
        </YStack>

        <XStack gap="$2" flexWrap="wrap">
          <Button
            variant="primary"
            size="$3"
            disabled={working}
            onPress={() => resolve.mutate({ placeId, choice: "keep" })}
            data-testid="community-handover-keep"
          >
            {String(t("communityPlacePage.handoverKeep"))}
          </Button>
          <Button
            variant="secondary"
            size="$3"
            disabled={working}
            onPress={() => {
              setRefusal(null);
              setConfirmOpen(true);
            }}
            data-testid="community-handover-clear"
          >
            {String(t("communityPlacePage.handoverClear"))}
          </Button>
        </XStack>

        {refusal ? (
          <YStack gap="$1" role="alert" data-testid="community-handover-error">
            <Text variant="bodySmall" tone="error">
              {refusal.kind === "draft"
                ? String(t("communityPlacePage.handoverDraftPending"))
                : refusal.text}
            </Text>
            {refusal.kind === "draft" ? (
              // Nothing in the editor publishes or discards the page draft
              // yet, so the way out is support.
              <NextLinkAnchor href="/support">
                <Text variant="bodySmall" weight="bold" tone="inherit">
                  {String(t("communityPlacePage.handoverContactSupport"))}
                </Text>
              </NextLinkAnchor>
            ) : null}
          </YStack>
        ) : null}
      </YStack>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => resolve.mutate({ placeId, choice: "clear" })}
        title={String(t("communityPlacePage.handoverConfirmTitle"))}
        description={String(t("communityPlacePage.handoverConfirmBody"))}
        confirmLabel={String(t("communityPlacePage.handoverClear"))}
        cancelLabel={String(t("communityPlacePage.handoverCancel"))}
        tone="danger"
        loading={working}
        loadingLabel={String(t("communityPlacePage.handoverWorking"))}
      />
    </>
  );
}
