"use client";

import { useMemo } from "react";
import { XStack, YStack } from "tamagui";
import { Building2 } from "lucide-react";
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
import { SectionCard } from "./settings-primitives";

const PAGE_LIMIT = 20;

type ClaimSource = "OWNERSHIP_CLAIM" | "OWNERSHIP_DISPUTE";
type ClaimStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN";
type ClaimOwnerType = "HUMAN" | "ORGANIZATION";

/** Contract shape from `trpc.places.listMyPlaceClaims`. */
type VenueClaimItem = {
  requestId: string;
  placeId: string;
  placeName: string;
  /** `EntityPage.slug` — what `/p/[slug]` resolves on. */
  placePageSlug: string | null;
  source: ClaimSource;
  status: ClaimStatus;
  ownerType: ClaimOwnerType;
  ownerId: string;
  createdAt: string | Date;
  reviewedAt: string | Date | null;
  reviewerNotes: string | null;
};

const STATUS_TONE: Record<
  ClaimStatus,
  "warning" | "success" | "danger" | "neutral"
> = {
  PENDING: "warning",
  IN_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  WITHDRAWN: "neutral",
};

// PENDING reuses the existing noun key (moderation.pendingBadge); the rest
// have dedicated account.sVenueClaimsStatus* keys.
const STATUS_LABEL_KEYS: Record<ClaimStatus, string> = {
  PENDING: "moderation.pendingBadge",
  IN_REVIEW: "account.sVenueClaimsStatusInReview",
  APPROVED: "account.sVenueClaimsStatusApproved",
  REJECTED: "account.sVenueClaimsStatusRejected",
  WITHDRAWN: "account.sVenueClaimsStatusWithdrawn",
};

const SOURCE_LABEL_KEYS: Record<ClaimSource, string> = {
  OWNERSHIP_CLAIM: "account.sVenueClaimsSourceClaim",
  OWNERSHIP_DISPUTE: "account.sVenueClaimsSourceDispute",
};

// "Claimed as" identity — deliberately simple; we don't resolve org names
// here. Whole-sentence keys so Spanish word order isn't glued together.
const SUBMITTED_LINE_KEYS: Record<ClaimOwnerType, string> = {
  HUMAN: "account.sVenueClaimsSubmittedSelf",
  ORGANIZATION: "account.sVenueClaimsSubmittedOrg",
};

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Account-settings "Place claims" section: the signed-in user's OWN
 * place-ownership claims and disputes, newest first, with the platform's
 * decision. Read-only status view — reviewer identity is deliberately never
 * shown (only "Reviewed <date>" + the reviewer's note). Cursor-paginated via
 * `places.listMyPlaceClaims`. Mirrors EditSuggestionsSection.
 */
export function VenueClaimsSection() {
  const t = useTranslations();
  const fmt = useFormatters();

  const listQuery = trpc.places.listMyPlaceClaims.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      staleTime: 15_000,
      retry: false,
      meta: { silent: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo<VenueClaimItem[]>(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );

  const statusLabel = (status: ClaimStatus): string =>
    String(t(STATUS_LABEL_KEYS[status]));

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Building2 size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sVenueClaimsTitle"))}
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        {String(t("account.sVenueClaimsDesc"))}
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
  listQuery: ReturnType<typeof trpc.places.listMyPlaceClaims.useInfiniteQuery>;
  items: VenueClaimItem[];
  statusLabel: (status: ClaimStatus) => string;
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
        {String(t("account.sVenueClaimsLoadError"))}
      </Text>
    );
  }

  if (items.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("account.sVenueClaimsEmpty"))}
      </Text>
    );
  }

  return (
    <YStack gap="$3">
      {items.map((item) => {
        const createdAt = toDate(item.createdAt);
        const reviewedAt = item.reviewedAt ? toDate(item.reviewedAt) : null;
        // `/p/[slug]` resolves on the venue's ENTITY PAGE slug — a venue's
        // only slug. (This used to read a `placeSlug` field carrying the
        // deprecated `Place.slug`, a multi-segment directory key that route
        // cannot match, so every claimed venue linked to a 404.) The id page
        // is the working fallback for venues with no entity page.
        const placeHref = item.placePageSlug
          ? `/p/${item.placePageSlug}`
          : `/places/id/${item.placeId}`;
        return (
          <YStack
            key={item.requestId}
            gap="$3"
            padding="$3"
            borderWidth={2}
            borderColor="$borderColor"
            backgroundColor="$surface"
          >
            {/* Header: venue link + claim/dispute tag + status */}
            <XStack
              justifyContent="space-between"
              alignItems="flex-start"
              gap="$2"
              flexWrap="wrap"
            >
              <YStack gap="$1" flex={1} minWidth={180}>
                <XStack gap="$2" alignItems="center" flexWrap="wrap">
                  <NextLinkAnchor href={placeHref} textDecorationLine="none">
                    <Text variant="body" weight="bold" tone="accent">
                      {item.placeName}
                    </Text>
                  </NextLinkAnchor>
                  <Badge
                    tone={item.source === "OWNERSHIP_DISPUTE" ? "info" : "neutral"}
                    variant="outline"
                    size="xs"
                  >
                    {String(t(SOURCE_LABEL_KEYS[item.source])).toUpperCase()}
                  </Badge>
                </XStack>
                <Text variant="caption" tone="muted">
                  {String(
                    t(SUBMITTED_LINE_KEYS[item.ownerType], {
                      date: fmt.dateTime(createdAt, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    }),
                  )}
                  {reviewedAt
                    ? ` · ${String(
                        t("account.sVenueClaimsReviewed", {
                          date: fmt.dateTime(reviewedAt, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          }),
                        }),
                      )}`
                    : ""}
                </Text>
              </YStack>
              <Badge tone={STATUS_TONE[item.status]} size="sm">
                {statusLabel(item.status).toUpperCase()}
              </Badge>
            </XStack>

            {/* Reviewer's note, when present (never the reviewer's identity) */}
            {item.reviewerNotes ? (
              <YStack gap="$1">
                <Text
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(t("moderation.reviewNoteLabel"))}
                </Text>
                <Text variant="bodySmall">{item.reviewerNotes}</Text>
              </YStack>
            ) : null}
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
