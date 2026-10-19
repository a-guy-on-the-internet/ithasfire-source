"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import { AlertCircle, ArrowLeft, Search, Ticket } from "lucide-react";

import { Button, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { useEmailGateLatch } from "@/hooks/useEmailGateLatch";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { SavedEventCard, SavedEventCardSkeleton } from "@/components/saves/SavedEventCard";
import {
  useSavedEventList,
  type SavedScope,
} from "@/components/saves/useSavedEventList";

import { OrderCard, OrderCardSkeleton, type OrderItem } from "./OrderCard";
import { NumberedSection, SkeletonPulse } from "./primitives";
import { SCOPE_PANEL_ID, ScopeTabs, scopeTabId } from "./ScopeTabs";

/**
 * `/my-tickets` — the attendee's own events, ticketed and saved.
 *
 * The `/saved` watchlist folded in here on 2026-08-31. It was unreachable on a
 * phone: the consumer bottom bar is Home/Search/Tickets/Support with no Saved
 * tab, and the navbar sheds its saved-heart below 600px, so the only way in was
 * typing the URL. Tickets is already a bottom-bar tab, so merging fixes that
 * for free. `/saved` is now a redirect here.
 *
 * **The axis is flipped, not nested.** Both pages used to split Upcoming/Past
 * themselves, which would have stacked the same axis twice. Upcoming/Past is
 * now the ONE top-level control, and Tickets / Saved are numbered sections
 * inside it.
 *
 * The route keeps the `/my-tickets` URL — bookmarks, the bottom-bar tab and a
 * dozen e2e specs point at it, and renaming it is a separate move. Only the
 * heading and document title become "My events", because the page now holds
 * events with no ticket attached.
 *
 * The two halves read from two independent queries and are rendered
 * independently: a slow or failed watchlist never blanks tickets that already
 * arrived, and vice versa.
 */

const SECTION_ORDER = ["tickets", "saved"] as const;
type SectionKey = (typeof SECTION_ORDER)[number];

/**
 * Index numbers are assigned top-to-bottom over the sections that ACTUALLY
 * render (design-system-v2 §8) — never hardcoded. A tab holding saved events
 * and no tickets reads "01 SAVED", not a lone "02".
 *
 * Exported for its own test: this exact rule regressed once already, when a
 * past-only wallet shipped a lone "02 PAST" with no 01 above it.
 */
export const deriveSectionNumbers = (
  present: Record<SectionKey, boolean>,
): Partial<Record<SectionKey, string>> => {
  const visible = SECTION_ORDER.filter((key) => present[key]);
  return Object.fromEntries(
    visible.map((key, index) => [key, String(index + 1).padStart(2, "0")]),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared small states
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A section-scoped failure. Deliberately NOT a page takeover: when one of the
 * two queries fails the other half is still real, still useful, and still on
 * screen.
 */
const SectionError = ({
  message,
  onRetry,
  testId,
}: {
  message: string;
  onRetry: () => void;
  testId: string;
}) => {
  const t = useTranslations();
  return (
    <YStack
      gap="$3"
      padding="$4"
      borderWidth={2}
      borderColor="$borderColorSoft"
      borderRadius={0}
      alignItems="flex-start"
      data-testid={testId}
    >
      <XStack gap="$2" alignItems="center">
        <AlertCircle size={18} color="var(--danger, #B91C1C)" aria-hidden />
        <Text variant="body" weight="bold">
          {message}
        </Text>
      </XStack>
      <Button variant="secondary" size="$2" onPress={onRetry}>
        {String(t("myTickets.tryAgain"))}
      </Button>
    </YStack>
  );
};

const PageSkeleton = () => (
  <YStack gap="$4" data-testid="my-tickets-loading">
    {/* Header */}
    <XStack gap="$3" alignItems="center">
      <SkeletonPulse height={36} width={36} borderRadius={0} />
      <YStack gap="$2" flex={1}>
        <SkeletonPulse height={24} width="50%" />
        <SkeletonPulse height={16} width="30%" />
      </YStack>
    </XStack>
    {/* Tab strip */}
    <SkeletonPulse height={44} width={200} />
    {/* Section label + rows */}
    <SkeletonPulse height={14} width={100} />
    <YStack gap="$2">
      <OrderCardSkeleton />
      <OrderCardSkeleton />
      <OrderCardSkeleton />
    </YStack>
  </YStack>
);

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export const MyEvents = () => {
  const t = useTranslations();
  const router = useRouter();

  const [scope, setScope] = useState<SavedScope>("upcoming");

  const ordersQuery = trpc.orders.listMyOrders.useQuery(
    { limit: 50 },
    {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  );

  // The page is behind `AppAuthGate` (AppChrome's full-auth branch) AND the
  // edge `PRIVATE_ROUTE_PREFIXES` gate, so it never renders for a signed-out
  // visitor. That is the ONE signed-out story for this destination — the
  // in-page "sign in to save events" promo `/saved` carried was already dead
  // code behind the same gate, so it did not survive the merge.
  const saved = useSavedEventList({ scope, enabled: true });

  const orderItems = ordersQuery.data?.items as OrderItem[] | undefined;

  // Soonest at the top. Nobody opens a wallet to find last year — the next
  // gate they have to walk through is the only row that matters on arrival.
  // Undated orders sort last: they cannot be "soonest" and pushing them above
  // a show tonight would bury it.
  const upcomingOrders = useMemo(() => {
    if (!orderItems) return [];
    const now = new Date();
    return orderItems
      .filter((order) => {
        if (!order.eventStartsAt) return true;
        return new Date(order.eventStartsAt) >= now;
      })
      .sort((a, b) => {
        if (!a.eventStartsAt) return 1;
        if (!b.eventStartsAt) return -1;
        return (
          new Date(a.eventStartsAt).getTime() -
          new Date(b.eventStartsAt).getTime()
        );
      });
  }, [orderItems]);

  // Past runs the other way — most recently attended first, because the thing
  // someone looks up in the past half of a wallet is the show they just left.
  const pastOrders = useMemo(() => {
    if (!orderItems) return [];
    const now = new Date();
    return orderItems
      .filter((order) => {
        if (!order.eventStartsAt) return false;
        return new Date(order.eventStartsAt) < now;
      })
      .sort(
        (a, b) =>
          new Date(b.eventStartsAt as Date).getTime() -
          new Date(a.eventStartsAt as Date).getTime(),
      );
  }, [orderItems]);

  const orders = scope === "upcoming" ? upcomingOrders : pastOrders;

  const ordersLoading = ordersQuery.isLoading;
  const ordersFailed = Boolean(ordersQuery.error);
  // B2: an unverified account's orders are withheld, not broken. "Try again"
  // can never fix that, so the tickets section asks for the code instead.
  // Latched, so a focus refetch cannot unmount the open code card.
  const ordersNeedVerification = useEmailGateLatch(ordersQuery);

  // A section is on screen when it has rows, is still fetching them, or has
  // something to say about why it has none. An EMPTY section renders nothing —
  // an empty section must never read as an empty page.
  const present: Record<SectionKey, boolean> = {
    tickets: orders.length > 0 || ordersLoading || ordersFailed,
    saved: saved.items.length > 0 || saved.isLoading || saved.isError,
  };
  const num = deriveSectionNumbers(present);

  // Nothing has resolved yet — the only moment a page-level skeleton is
  // honest. Once EITHER query lands, its half renders and the other shows its
  // own inline skeleton.
  const firstPaint =
    ordersLoading && !ordersNeedVerification && saved.isLoading;
  const showPageSkeleton = useDelayedFlag(firstPaint, 200);

  if (firstPaint) {
    // Loading, but too soon to flash the skeleton — render nothing briefly so
    // a fast resolution swaps straight to real content.
    return showPageSkeleton ? (
      <PageSkeleton />
    ) : (
      <YStack gap="$4" data-testid="my-tickets-loading" />
    );
  }

  // Both halves down — one message beats two identical error cards.
  if (ordersFailed && saved.isError && !ordersNeedVerification) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$8"
        gap="$4"
        data-testid="my-tickets-error"
      >
        <YStack
          width={64}
          height={64}
          borderRadius={0}
          backgroundColor="$surfaceMuted"
          justifyContent="center"
          alignItems="center"
        >
          <AlertCircle size={28} color="var(--danger, #B91C1C)" aria-hidden />
        </YStack>
        <Text variant="h4" tag="h1">
          {String(t("myEvents.unableToLoad"))}
        </Text>
        <Button
          variant="secondary"
          onPress={() => {
            void ordersQuery.refetch();
            saved.refetch();
          }}
        >
          {String(t("myTickets.tryAgain"))}
        </Button>
      </YStack>
    );
  }

  // ── Header count line ──────────────────────────────────────────────────────
  // Scoped to the ACTIVE tab, because a number that does not match the rows
  // under it is a lie. The saved half is paginated and the API has no count
  // endpoint, so an unexhausted list reads "20+ saved" rather than claiming a
  // total it cannot know.
  const countParts: string[] = [];
  if (!ordersLoading && !ordersFailed) {
    countParts.push(String(t("myTickets.nOrders", { count: orders.length })));
  }
  if (!saved.isLoading && !saved.isError) {
    countParts.push(
      String(
        saved.hasNextPage
          ? t("myEvents.nSavedMore", { count: saved.items.length })
          : t("myEvents.nSaved", { count: saved.items.length }),
      ),
    );
  }

  const sectionsShown = SECTION_ORDER.filter((key) => present[key]);

  const ticketsBody: ReactNode = ordersNeedVerification ? (
    <EmailVerificationRequired context="tickets" headingTag="h3" />
  ) : ordersFailed ? (
    <SectionError
      message={String(t("myTickets.unableToLoad"))}
      onRetry={() => void ordersQuery.refetch()}
      testId="my-tickets-tickets-error"
    />
  ) : ordersLoading ? (
    <YStack gap="$2">
      <OrderCardSkeleton />
      <OrderCardSkeleton />
    </YStack>
  ) : (
    <YStack gap="$2" className="th-card-stagger">
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} isPast={scope === "past"} />
      ))}
    </YStack>
  );

  const savedBody: ReactNode = saved.isError ? (
    <SectionError
      message={String(t("saves.unableToLoad"))}
      onRetry={saved.refetch}
      testId="my-tickets-saved-error"
    />
  ) : saved.isLoading ? (
    <YStack gap="$2">
      <SavedEventCardSkeleton />
      <SavedEventCardSkeleton />
    </YStack>
  ) : (
    <YStack gap="$3">
      <YStack
        gap="$2"
        role="list"
        aria-label={String(t("myEvents.sectionSaved"))}
      >
        {saved.items.map((item) => (
          <SavedEventCard
            key={item.saveId}
            item={item}
            onUnsave={saved.unsave}
          />
        ))}
      </YStack>
      {saved.hasNextPage ? (
        <XStack justifyContent="center" paddingVertical="$2">
          <Button
            variant="secondary"
            size="$3"
            disabled={saved.isFetchingNextPage}
            onPress={saved.fetchNextPage}
            data-testid="saved-load-more"
          >
            {String(
              t(
                saved.isFetchingNextPage ? "common.loading" : "saves.loadMore",
              ),
            )}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );

  return (
    <YStack gap="$4" data-testid="my-tickets-content">
      {/* `flexWrap` + a real `minWidth` on the title column: at 320 the back
          button claims ~200px of the row, which left the h1 ~100px and broke
          "EVENTS" mid-word ("MY / EVE / NTS"). Below ~200px of remaining space
          the title now takes its own full-width row instead of being squeezed. */}
      <XStack gap="$3" alignItems="center" flexWrap="wrap">
        {/* Accent lives on the Button frame (not an inner Text override) so
            the icon + label ride currentColor per the v2 atom grammar.
            `$accentText` rather than `$accent`: this is a control's label, and
            `accent` as small text is 3.57:1 on the Stub canvas. */}
        <Button
          variant="ghost"
          size="$3"
          color="$accentText"
          onPress={() => router.push("/")}
          aria-label={t("common.backToHome") as string}
          paddingHorizontal="$2"
          paddingVertical="$2"
        >
          <ArrowLeft size={16} strokeWidth={2.5} aria-hidden />
          {String(t("common.backToHome"))}
        </Button>
        <YStack gap="$1" flex={1} minWidth={200}>
          <Text
            variant="h2"
            tag="h1"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {String(t("myEvents.title"))}
          </Text>
          {countParts.length > 0 ? (
            <Text variant="body" tone="muted" data-testid="my-events-counts">
              {countParts.join(" · ")}
            </Text>
          ) : null}
        </YStack>
      </XStack>

      <ScopeTabs
        scope={scope}
        onChange={setScope}
        ariaLabel={String(t("myEvents.tabsLabel"))}
        labels={{
          upcoming: String(t("myTickets.upcoming")),
          past: String(t("myTickets.past")),
        }}
      />

      <YStack
        gap="$4"
        id={SCOPE_PANEL_ID}
        role="tabpanel"
        aria-labelledby={scopeTabId(scope)}
        tabIndex={0}
      >
        {sectionsShown.length === 0 ? (
          // The ONLY true empty state: this tab holds neither tickets nor
          // saved events. An empty SECTION never gets here — it simply does
          // not render, so "no tickets yet" can no longer appear above a
          // stack of saved events.
          <YStack
            alignItems="center"
            justifyContent="center"
            padding="$8"
            gap="$5"
            data-testid="my-tickets-empty"
          >
            <YStack
              width={80}
              height={80}
              borderRadius={0}
              backgroundColor="$surfaceMuted"
              justifyContent="center"
              alignItems="center"
            >
              <Ticket size={36} color="var(--colorMuted, #5C544A)" aria-hidden />
            </YStack>
            <YStack gap="$2" alignItems="center">
              <Text variant="h3" weight="bold" textAlign="center">
                {String(
                  t(
                    scope === "upcoming"
                      ? "myEvents.emptyUpcomingTitle"
                      : "myEvents.emptyPastTitle",
                  ),
                )}
              </Text>
              <Text
                variant="body"
                tone="muted"
                textAlign="center"
                maxWidth={320}
              >
                {String(
                  t(
                    scope === "upcoming"
                      ? "myEvents.emptyUpcomingDescription"
                      : "myEvents.emptyPastDescription",
                  ),
                )}
              </Text>
            </YStack>
            {scope === "upcoming" ? (
              <XStack gap="$3" flexWrap="wrap" justifyContent="center">
                <Link href="/search">
                  <Button tag="span" variant="primary" size="$4">
                    <Search size={16} aria-hidden />
                    {String(t("myTickets.browseEvents"))}
                  </Button>
                </Link>
                {/* A past-only wallet is the common case for anyone who has
                    been here a while, and with a top-level tab their whole
                    history is one tap away but invisible. Offered only on
                    positive evidence that the other tab has something. */}
                {pastOrders.length > 0 ? (
                  <Button
                    variant="secondary"
                    size="$4"
                    onPress={() => setScope("past")}
                    data-testid="my-events-see-past"
                  >
                    {String(t("myEvents.seePast"))}
                  </Button>
                ) : null}
              </XStack>
            ) : null}
          </YStack>
        ) : (
          <>
            {present.tickets ? (
              <NumberedSection
                num={num.tickets ?? "01"}
                label={String(t("myEvents.sectionTickets"))}
                testId="my-events-section-tickets"
              >
                {ticketsBody}
              </NumberedSection>
            ) : null}
            {present.saved ? (
              <NumberedSection
                num={num.saved ?? "01"}
                label={String(t("myEvents.sectionSaved"))}
                testId="my-events-section-saved"
              >
                {savedBody}
              </NumberedSection>
            ) : null}
          </>
        )}
      </YStack>
    </YStack>
  );
};

MyEvents.displayName = "MyEvents";
