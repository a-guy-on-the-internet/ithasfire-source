"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  DateTime,
  Money,
  NextLinkAnchor,
  Text,
  useLocale,
  useTranslations,
  type DataTableColumn,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";

import { usePlatformTimeZone } from "../../settlements/_components/PayoutOwner";
import {
  ATTENTION_STATUS_LABEL_KEY,
  benefitsDenied,
  formatDurationBetween,
  membershipOwnerHref,
  membershipOwnerName,
} from "./membership-visibility.helpers";

// ─────────────────────────────────────────────────────────────────────────────
// "Needs attention" and "Leaving" — the two row lists on /platform/memberships.
//
// ONE COMPONENT, TWO BUCKETS, because they are the same join asked two
// questions and a second copy would drift. What differs is the last column and
// the copy, both of which are parameterised.
//
//   * ATTENTION — `past_due` / `unpaid` (Stripe is retrying a failing card and
//     the member is ALREADY DENIED every benefit at checkout), plus signups
//     stuck at `incomplete`. Longest-stuck first.
//   * LEAVING   — set to end when the period does, inside the window. Soonest
//     first, because it is a deadline.
//
// "FOR HOW LONG" IS APPROXIMATE AND SAYS SO. Nothing on `Membership` records
// when a row entered `past_due`; `updatedAt` is the closest proxy and it moves
// on any write. The server sends a `sinceBasis` naming what was measured, and
// this component renders "about 9 days" for a last-change measurement and a
// bare "9 days" for a signup one. Presenting a proxy as an exact age is how a
// support conversation starts with a wrong fact.
//
// DURATIONS ARE MEASURED AGAINST THE SERVER'S `asOf`, never the browser clock:
// the server is what decided a row belongs in this bucket, so a countdown
// derived from a different clock could contradict the list it sits in.
//
// Cursor-paged by hand (`utils.fetch` + accumulated pages), not
// `useInfiniteQuery`: the procedure's strict input rejects the `direction` key
// the infinite hook injects. Same pattern as the settlements sections.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const MONO = { fontFamily: "$mono" } as const;
const NOWRAP = { whiteSpace: "nowrap" } as const;

type Bucket = "attention" | "leaving";

export interface MembershipPositionRow {
  id: string;
  status: string;
  memberHumanId: string;
  memberName: string | null;
  tierId: string;
  tierName: string;
  tierPriceCents: number;
  tierCurrency: string;
  tierInterval: "MONTH" | "YEAR";
  ownerType: "ORG" | "HUMAN";
  ownerId: string;
  ownerLabel: string | null;
  ownerSlug: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  startedAt: Date;
  sinceAt: Date;
  sinceBasis: "signup" | "lastChange";
}

type PositionsPage = {
  items: Array<
    Omit<
      MembershipPositionRow,
      "currentPeriodStart" | "currentPeriodEnd" | "startedAt" | "sinceAt"
    > & {
      currentPeriodStart: Date | string;
      currentPeriodEnd: Date | string;
      startedAt: Date | string;
      sinceAt: Date | string;
    }
  >;
  nextCursor: string | null;
  total: number;
  asOf: Date | string;
};

const toDate = (v: Date | string): Date => new Date(v);

function MemberCell({ row }: { row: MembershipPositionRow }) {
  const t = useTranslations();
  const name = row.memberName?.trim();
  return (
    <YStack minWidth={0}>
      <Text variant="bodySmall" weight="bold">
        {name || String(t("platformMemberships.mvUnnamedMember"))}
      </Text>
      <Text variant="caption" tone="muted">
        {row.tierName}
      </Text>
    </YStack>
  );
}

/** Whose money this is. Memberships are 0% fee — none of it is ours. */
function OwnerCell({ row }: { row: MembershipPositionRow }) {
  const t = useTranslations();
  const href = membershipOwnerHref(row);
  const name = membershipOwnerName(row);
  const kind =
    row.ownerType === "ORG"
      ? String(t("platformMemberships.mvOwnerOrg"))
      : String(t("platformMemberships.mvOwnerHuman"));
  return (
    <YStack minWidth={0}>
      {href ? (
        <NextLinkAnchor href={href} aria-label={`${name}, ${kind}`}>
          <Text variant="bodySmall" weight="bold" color="$accentText">
            {name}
          </Text>
        </NextLinkAnchor>
      ) : (
        <Text variant="bodySmall" weight="bold">
          {name}
        </Text>
      )}
      <Text variant="caption" tone="muted">
        {kind}
      </Text>
    </YStack>
  );
}

function AmountCell({ row }: { row: MembershipPositionRow }) {
  const t = useTranslations();
  return (
    <YStack alignItems="flex-end" gap={2} minWidth={0}>
      <Money
        cents={row.tierPriceCents}
        currency={row.tierCurrency.toUpperCase()}
        variant="bodySmall"
        weight="bold"
        style={NOWRAP}
        {...MONO}
      />
      {/* The interval is not optional decoration: $120 a MONTH and $120 a YEAR
          are different by a factor of twelve, and the column would otherwise
          invite the reader to assume one of them. */}
      <Text variant="caption" tone="muted" textAlign="right">
        {String(
          t(
            row.tierInterval === "YEAR"
              ? "platformMemberships.mvIntervalYear"
              : "platformMemberships.mvIntervalMonth",
          ),
        )}
      </Text>
    </YStack>
  );
}

/**
 * What is wrong, and whether the member is currently losing benefits.
 *
 * `past_due` and `unpaid` get DIFFERENT labels: one is Stripe still retrying,
 * the other is Stripe having given up, and someone triaging acts differently
 * on each. A status outside the three known ones renders raw rather than
 * guessing a label — `Membership.status` mirrors Stripe's vocabulary verbatim
 * and Stripe has introduced values before.
 */
function StateCell({ row }: { row: MembershipPositionRow }) {
  const t = useTranslations();
  const labelKey = ATTENTION_STATUS_LABEL_KEY[row.status];
  return (
    <YStack gap={4} alignItems="flex-start" minWidth={0}>
      <Badge tone={benefitsDenied(row.status) ? "danger" : "warning"} size="sm">
        {labelKey ? String(t(labelKey)) : row.status}
      </Badge>
      {benefitsDenied(row.status) && (
        <Text variant="caption" tone="muted">
          {String(t("platformMemberships.mvBenefitsDenied"))}
        </Text>
      )}
    </YStack>
  );
}

/** How long, with an honest word about what was measured. */
function SinceCell({
  row,
  asOf,
}: {
  row: MembershipPositionRow;
  asOf: Date;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const duration = formatDurationBetween(row.sinceAt, asOf, locale);
  return (
    <YStack minWidth={0}>
      <Text variant="bodySmall" style={NOWRAP}>
        {row.sinceBasis === "signup"
          ? duration
          : String(
              t("platformMemberships.mvSinceApprox", { duration }),
            )}
      </Text>
      <Text variant="caption" tone="muted">
        {String(
          t(
            row.sinceBasis === "signup"
              ? "platformMemberships.mvSinceBasisSignup"
              : "platformMemberships.mvSinceBasisLastChange",
          ),
        )}
      </Text>
    </YStack>
  );
}

/** The deadline. Both the date and how far away it is. */
function EndsCell({
  row,
  asOf,
  timeZone,
}: {
  row: MembershipPositionRow;
  asOf: Date;
  timeZone: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <YStack minWidth={0}>
      <DateTime
        value={row.currentPeriodEnd}
        timeZone={timeZone}
        format="date"
        variant="bodySmall"
        style={NOWRAP}
      />
      <Text variant="caption" tone="muted">
        {String(
          t("platformMemberships.mvEndsIn", {
            duration: formatDurationBetween(asOf, row.currentPeriodEnd, locale),
          }),
        )}
      </Text>
    </YStack>
  );
}

function MembershipPositionsSection({
  bucket,
  headingId,
  titleKey,
  introKey,
  emptyKey,
  captionKey,
}: {
  bucket: Bucket;
  headingId: string;
  titleKey: string;
  introKey: string;
  emptyKey: string;
  captionKey: string;
}) {
  const t = useTranslations();
  const { timeZone, resolved: timeZoneResolved } = usePlatformTimeZone();
  const utils = trpc.useUtils();

  const query = trpc.platform.listMembershipPositions.useQuery({
    bucket,
    limit: PAGE_SIZE,
  });

  // Extra cursor pages, keyed by the first page's `dataUpdatedAt` so a refetch
  // voids the chain behind it and "Load more" comes back.
  const [extra, setExtra] = useState<{
    dataUpdatedAt: number;
    pages: PositionsPage[];
  }>({ dataUpdatedAt: 0, pages: [] });
  const extraPages = useMemo(
    () => (extra.dataUpdatedAt === query.dataUpdatedAt ? extra.pages : []),
    [extra, query.dataUpdatedAt],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const rows = useMemo<MembershipPositionRow[]>(() => {
    const seen = new Set<string>();
    const out: MembershipPositionRow[] = [];
    for (const page of [query.data, ...extraPages]) {
      for (const item of page?.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({
          ...item,
          currentPeriodStart: toDate(item.currentPeriodStart),
          currentPeriodEnd: toDate(item.currentPeriodEnd),
          startedAt: toDate(item.startedAt),
          sinceAt: toDate(item.sinceAt),
        });
      }
    }
    return out;
  }, [query.data, extraPages]);

  // The FIRST page's clock, deliberately, not the newest. Every visible row was
  // selected against it, and re-basing the durations on a later page's clock
  // would make identical rows read differently depending on which page they
  // arrived in.
  const asOf = useMemo(
    () => (query.data ? toDate(query.data.asOf) : null),
    [query.data],
  );

  const nextCursor =
    extraPages.length > 0
      ? extraPages[extraPages.length - 1]!.nextCursor
      : (query.data?.nextCursor ?? null);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await utils.platform.listMembershipPositions.fetch({
        bucket,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      const dataUpdatedAt = query.dataUpdatedAt;
      setExtra((prev) => ({
        dataUpdatedAt,
        pages:
          prev.dataUpdatedAt === dataUpdatedAt ? [...prev.pages, page] : [page],
      }));
    } catch (err) {
      setLoadMoreError(formatErrorMessage(err, (key) => String(t(key))));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, utils, query.dataUpdatedAt, bucket, t]);

  // `DataTableColumn.width` is a RELATIVE WEIGHT, not pixels: DataTable
  // normalises the weights to percentages of a `width: 100%` table, so widening
  // one column STARVES the rest. These are sized against the widest real
  // content in each.
  const columns = useMemo<DataTableColumn<MembershipPositionRow>[]>(() => {
    const base: DataTableColumn<MembershipPositionRow>[] = [
      {
        id: "member",
        header: String(t("platformMemberships.mvColMember")),
        cell: (row) => <MemberCell row={row} />,
        width: 200,
      },
      {
        id: "owner",
        header: String(t("platformMemberships.mvColOwner")),
        cell: (row) => <OwnerCell row={row} />,
        width: 170,
      },
      {
        id: "amount",
        header: String(t("platformMemberships.mvColAmount")),
        align: "right",
        cell: (row) => <AmountCell row={row} />,
        width: 120,
      },
    ];

    if (bucket === "attention") {
      base.push(
        {
          id: "state",
          header: String(t("platformMemberships.mvColState")),
          cell: (row) => <StateCell row={row} />,
          width: 150,
        },
        {
          id: "since",
          header: String(t("platformMemberships.mvColSince")),
          cell: (row) =>
            asOf ? <SinceCell row={row} asOf={asOf} /> : null,
          width: 160,
        },
      );
    } else {
      base.push({
        id: "ends",
        header: String(t("platformMemberships.mvColEnds")),
        noWrap: true,
        cell: (row) =>
          asOf ? (
            <EndsCell row={row} asOf={asOf} timeZone={timeZone} />
          ) : null,
        width: 180,
      });
    }

    return base;
  }, [t, bucket, asOf, timeZone]);

  const total = query.data?.total ?? null;

  return (
    <YStack gap={12} tag="section" aria-labelledby={headingId}>
      <YStack gap={4}>
        <XStack gap={8} alignItems="center" flexWrap="wrap">
          <Text variant="h3" tag="h2" id={headingId}>
            {String(t(titleKey))}
          </Text>
          {total != null && (
            <Badge tone={total > 0 ? "warning" : "neutral"} size="sm">
              {total}
            </Badge>
          )}
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t(introKey))}
        </Text>
        {/* Only after the zone is resolved client-side. Rendering it during SSR
            would bake the SERVER's zone into the markup and mismatch on
            hydration for every reader outside it. */}
        {bucket === "leaving" && timeZoneResolved && (
          <Text variant="caption" tone="muted">
            {String(
              t("platformMemberships.mvTimeZoneNote", { zone: timeZone }),
            )}
          </Text>
        )}
      </YStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              {String(t("platformMemberships.mvTimedOut"))}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => query.refetch()}
              disabled={query.isFetching}
            >
              {String(t("platformMemberships.mvRetry"))}
            </Button>
          </XStack>
        ) : (
          <Text color="$danger" variant="body" role="alert">
            {formatErrorMessage(query.error)}
          </Text>
        ))}

      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        isLoading={query.isLoading}
        caption={String(t(captionKey))}
        scrollContainer
        renderMobileCard={(row) => (
          <MembershipPositionMobileCard
            row={row}
            bucket={bucket}
            asOf={asOf}
            timeZone={timeZone}
          />
        )}
        emptyState={
          <Text variant="bodySmall" tone="muted">
            {String(t(emptyKey))}
          </Text>
        }
      />

      {loadMoreError && (
        <Text color="$danger" variant="bodySmall">
          {loadMoreError}
        </Text>
      )}

      {nextCursor && (
        <XStack justifyContent="center">
          <Button
            variant="ghost"
            size="$1"
            onPress={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore
              ? String(t("platformMemberships.mvLoading"))
              : String(t("platformMemberships.mvLoadMore"))}
          </Button>
        </XStack>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export function MembershipPositionMobileCard({
  row,
  bucket,
  asOf,
  timeZone,
}: {
  row: MembershipPositionRow;
  bucket: Bucket;
  asOf: Date | null;
  timeZone: string;
}) {
  return (
    <YStack gap="$2" minWidth={0}>
      <XStack
        gap="$2"
        alignItems="flex-start"
        justifyContent="space-between"
        minWidth={0}
      >
        <YStack flex={1} minWidth={0}>
          <MemberCell row={row} />
        </YStack>
        <XStack flexShrink={0}>
          <AmountCell row={row} />
        </XStack>
      </XStack>

      <OwnerCell row={row} />

      {/* Its own line: inside the header row the badge's width squeezed the
          member column to nothing at 320px. */}
      {bucket === "attention" ? (
        <XStack gap="$2" alignItems="flex-start" flexWrap="wrap">
          <StateCell row={row} />
          {asOf && <SinceCell row={row} asOf={asOf} />}
        </XStack>
      ) : (
        asOf && <EndsCell row={row} asOf={asOf} timeZone={timeZone} />
      )}
    </YStack>
  );
}

export function MembershipsNeedingAttentionSection() {
  return (
    <MembershipPositionsSection
      bucket="attention"
      headingId="memberships-attention-heading"
      titleKey="platformMemberships.mvAttentionTitle"
      introKey="platformMemberships.mvAttentionIntro"
      emptyKey="platformMemberships.mvAttentionEmpty"
      captionKey="platformMemberships.mvAttentionCaption"
    />
  );
}

export function MembershipsLeavingSection() {
  return (
    <MembershipPositionsSection
      bucket="leaving"
      headingId="memberships-leaving-heading"
      titleKey="platformMemberships.mvLeavingTitle"
      introKey="platformMemberships.mvLeavingIntro"
      emptyKey="platformMemberships.mvLeavingEmpty"
      captionKey="platformMemberships.mvLeavingCaption"
    />
  );
}
