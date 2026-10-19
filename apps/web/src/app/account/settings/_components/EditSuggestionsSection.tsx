"use client";

import { useMemo } from "react";
import { XStack, YStack } from "tamagui";
import { Pencil } from "lucide-react";
import {
  Badge,
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { SuggestionDiffCard } from "@/components/community/SuggestionDiffCard";
import {
  MATERIAL_SUGGESTION_FIELDS,
  SUGGESTION_FIELD_LABEL_KEYS,
  orderedSuggestionFieldKeys,
} from "@/components/community/suggestion-fields-display";
import { SectionCard } from "./settings-primitives";

const PAGE_LIMIT = 20;

type SuggestionStatus = "PENDING" | "APPROVED" | "REJECTED";

/** Contract shape from `trpc.eventSuggestions.listMine` (built in parallel). */
type EditSuggestionItem = {
  id: string;
  eventId: string;
  eventTitle: string;
  eventSlug: string | null;
  status: SuggestionStatus;
  fields: Record<string, unknown>;
  baseVersion: Record<string, unknown>;
  conflictedFields: string[] | null;
  reviewNote: string | null;
  createdAt: string | Date;
  reviewedAt: string | Date | null;
};

const STATUS_TONE: Record<SuggestionStatus, "warning" | "success" | "danger"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
};

// NEW copy: only PENDING has an existing noun key (moderation.pendingBadge);
// APPROVED/REJECTED are inline until real keys land (see report).
const STATUS_INLINE_LABEL: Record<SuggestionStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Account-settings "Edit suggestions" section: the signed-in user's OWN
 * proposed edits to community listings, newest first, with per-field
 * before/after diffs and the moderator's decision. Read-only — mirrors the
 * moderator queue's diff rendering (SuggestionDiffCard) without any review
 * controls. Cursor-paginated via `eventSuggestions.listMine`.
 */
export function EditSuggestionsSection() {
  const t = useTranslations();
  const fmt = useFormatters();

  const listQuery = trpc.eventSuggestions.listMine.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      staleTime: 15_000,
      retry: false,
      meta: { silent: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo<EditSuggestionItem[]>(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );

  const statusLabel = (status: SuggestionStatus): string =>
    status === "PENDING"
      ? String(t("moderation.pendingBadge"))
      : STATUS_INLINE_LABEL[status];

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Pencil size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("moderation.suggestionsTitle"))}
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        Edits you proposed to community listings and where each one stands.
      </Text>

      <SectionBody
        listQuery={listQuery}
        items={items}
        statusLabel={statusLabel}
        t={t}
        fmt={fmt}
      />
    </SectionCard>
  );
}

function SectionBody({
  listQuery,
  items,
  statusLabel,
  t,
  fmt,
}: {
  listQuery: ReturnType<
    typeof trpc.eventSuggestions.listMine.useInfiniteQuery
  >;
  items: EditSuggestionItem[];
  statusLabel: (status: SuggestionStatus) => string;
  t: ReturnType<typeof useTranslations>;
  fmt: ReturnType<typeof useFormatters>;
}) {
  if (listQuery.isLoading) {
    return (
      <YStack alignItems="center" paddingVertical="$4" aria-busy>
        <Spinner size="sm" />
      </YStack>
    );
  }

  if (listQuery.isError) {
    return (
      <Text variant="caption" tone="muted" role="status">
        We couldn’t load your suggestions.
      </Text>
    );
  }

  if (items.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        You haven’t suggested any edits yet.
      </Text>
    );
  }

  return (
    <YStack gap="$3">
      {items.map((item) => {
        const fieldKeys = orderedSuggestionFieldKeys(item.fields);
        const conflicted = new Set(item.conflictedFields ?? []);
        const createdAt = toDate(item.createdAt);
        const reviewedAt = item.reviewedAt ? toDate(item.reviewedAt) : null;
        const eventHref = `/events/${item.eventSlug ?? item.eventId}`;
        return (
          <YStack
            key={item.id}
            gap="$3"
            padding="$3"
            borderWidth={2}
            borderColor="$borderColor"
            backgroundColor="$surface"
          >
            {/* Header: event link + status */}
            <XStack
              justifyContent="space-between"
              alignItems="flex-start"
              gap="$2"
              flexWrap="wrap"
            >
              <YStack gap="$1" flex={1} minWidth={180}>
                <NextLinkAnchor href={eventHref} textDecorationLine="none">
                  <Text variant="body" weight="bold" tone="accent">
                    {item.eventTitle}
                  </Text>
                </NextLinkAnchor>
                <Text variant="caption" tone="muted">
                  {`Suggested ${fmt.dateTime(createdAt, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}`}
                  {reviewedAt
                    ? ` · Reviewed ${fmt.dateTime(reviewedAt, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}`
                    : ""}
                </Text>
              </YStack>
              <Badge tone={STATUS_TONE[item.status]} size="sm">
                {statusLabel(item.status).toUpperCase()}
              </Badge>
            </XStack>

            {/* Moderator's note, when present */}
            {item.reviewNote ? (
              <YStack gap="$1">
                <Text
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(t("moderation.reviewNoteLabel"))}
                </Text>
                <Text variant="bodySmall">{item.reviewNote}</Text>
              </YStack>
            ) : null}

            {/* Per-field before/after diffs (read-only) */}
            <YStack gap="$2">
              {fieldKeys.map((key) => (
                <SuggestionDiffCard
                  key={key}
                  fieldKey={key}
                  label={
                    SUGGESTION_FIELD_LABEL_KEYS[key]
                      ? String(t(SUGGESTION_FIELD_LABEL_KEYS[key]))
                      : key
                  }
                  before={item.baseVersion[key] ?? null}
                  after={item.fields[key] ?? null}
                  conflicted={conflicted.has(key)}
                  material={MATERIAL_SUGGESTION_FIELDS.has(key)}
                />
              ))}
            </YStack>
          </YStack>
        );
      })}

      {listQuery.hasNextPage ? (
        <XStack justifyContent="center" paddingVertical="$2">
          <Button
            variant="outlined"
            size="$3"
            onPress={() => void listQuery.fetchNextPage()}
            disabled={listQuery.isFetchingNextPage}
          >
            {listQuery.isFetchingNextPage ? <Spinner size="sm" /> : null}
            {String(t("moderation.loadMore"))}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
}
