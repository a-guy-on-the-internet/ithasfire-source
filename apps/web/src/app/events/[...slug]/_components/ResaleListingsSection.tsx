"use client";

import { useMemo, useState } from "react";
import { YStack, XStack, Card, Spinner } from "tamagui";
import { Repeat, MapPin, Tag } from "lucide-react";
import { Text, Button, useTranslations, useFormatters } from "@th/ui";

import type { ListEventResaleListingsOutput } from "@th/core/use-cases/resale";

import { trpc } from "@/trpc";
import { fmtCurrency } from "@/lib/format";
import { ResaleListingFacts } from "@/components/resale/ResaleListingFacts";

type ResaleListingsSectionProps = {
  eventId: string;
  currency?: string;
};

/**
 * Buyer-facing section that shows available resale tickets for an event.
 * Renders nothing when there are no active listings.
 * Groups listings by section and allows filtering.
 */
export function ResaleListingsSection({
  eventId,
  currency = "usd",
}: ResaleListingsSectionProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const [selectedSectionId, setSelectedSectionId] = useState<
    string | undefined
  >(undefined);

  const listingsQuery = trpc.resale.listEventListings.useQuery(
    { eventId, sectionId: selectedSectionId, limit: 50 },
    { staleTime: 30_000 },
  );

  // Separate unfiltered query to always have the full section list for the filter
  const allSectionsQuery = trpc.resale.listEventListings.useQuery(
    { eventId, limit: 1 },
    { staleTime: 60_000 },
  );

  const listings = listingsQuery.data;
  const sections = allSectionsQuery.data?.sections ?? listings?.sections ?? [];

  // Group listings by section for display
  const grouped = useMemo(() => {
    if (!listings) return [];

    const groups = new Map<string, typeof listings.items>();
    const unsectioned: typeof listings.items = [];

    for (const item of listings.items) {
      if (item.sectionId && item.sectionName) {
        const key = item.sectionId;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
      } else {
        unsectioned.push(item);
      }
    }

    const result: Array<{
      sectionName: string | null;
      items: typeof listings.items;
    }> = [];

    // Named sections first, sorted alphabetically
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const nameA = groups.get(a)![0]?.sectionName ?? "";
      const nameB = groups.get(b)![0]?.sectionName ?? "";
      return nameA.localeCompare(nameB);
    });

    for (const key of sortedKeys) {
      const items = groups.get(key)!;
      result.push({ sectionName: items[0]?.sectionName ?? null, items });
    }

    if (unsectioned.length > 0) {
      result.push({ sectionName: null, items: unsectioned });
    }

    return result;
  }, [listings]);

  // Don't render anything until loaded or when there are no listings
  if (listingsQuery.isLoading) {
    return (
      <YStack padding="$4" alignItems="center">
        <Spinner size="small" />
      </YStack>
    );
  }

  if (!listings || listings.total === 0) {
    return null;
  }

  return (
    <YStack gap="$4" padding="$4" paddingTop="$2">
      <YStack borderBottomWidth={2} borderBottomColor="$borderColor" />

      <XStack gap="$2" alignItems="center">
        <Repeat size={18} color="var(--accent)" aria-hidden />
        {/* Section title on the event page — h2 in the ladder, h4 scale. */}
        <Text variant="h4" tag="h2" weight="bold">
          Resale tickets available
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        These tickets are being resold by other attendees at the prices below.
      </Text>

      {/* Section filter */}
      {sections.length > 1 && (
        <XStack gap="$2" flexWrap="wrap">
          <Button
            variant={selectedSectionId === undefined ? "primary" : "secondary"}
            size="$1"
            onPress={() => setSelectedSectionId(undefined)}
          >
            All sections
          </Button>
          {sections.map((section) => (
            <Button
              key={section.id}
              variant={
                selectedSectionId === section.id ? "primary" : "secondary"
              }
              size="$1"
              onPress={() => setSelectedSectionId(section.id)}
            >
              {section.name}
            </Button>
          ))}
        </XStack>
      )}

      {/* Listings grouped by section */}
      <YStack gap="$4">
        {grouped.map((group, gi) => (
          <YStack key={group.sectionName ?? `unsectioned-${gi}`} gap="$3">
            {group.sectionName && !selectedSectionId && (
              <XStack gap="$2" alignItems="center" paddingTop="$1">
                <MapPin size={14} color="var(--colorMuted)" aria-hidden />
                <Text variant="bodySmall" weight="bold" tone="muted">
                  {group.sectionName}
                </Text>
              </XStack>
            )}

            {group.items.map((listing) => (
              <ResaleListingCard
                key={listing.id}
                listing={listing}
                currency={currency}
                fmt={fmt}
              />
            ))}
          </YStack>
        ))}
      </YStack>

      {listings.total > listings.items.length && (
        <Text variant="bodySmall" tone="muted" textAlign="center">
          Showing {listings.items.length} of {listings.total} listings
        </Text>
      )}
    </YStack>
  );
}

// ── Listing card ─────────────────────────────────────────────────────────────

type ListingItem = ListEventResaleListingsOutput["items"][number];

function ResaleListingCard({
  listing,
  currency,
  fmt,
}: {
  listing: ListingItem;
  currency: string;
  fmt: ReturnType<typeof useFormatters>;
}) {
  const t = useTranslations();
  const seatDescription = formatSeatDescription(
    listing.seatLabel,
    listing.seatRow,
    listing.seatNumber,
  );

  return (
    <Card padding="$4" borderRadius={0}>
      <XStack justifyContent="space-between" alignItems="center">
        <YStack gap="$1" flex={1}>
          {/* Ticket type badge */}
          {listing.ticketTypeName && (
            <XStack gap="$1" alignItems="center">
              <Tag size={12} color="var(--colorMuted)" aria-hidden />
              <Text variant="caption" weight="medium">
                {listing.ticketTypeName}
              </Text>
            </XStack>
          )}

          {/* The price the buyer pays comes first, all in before tax (the
              FTC all-in rule), then the original price and the share to the
              people who put on the night. Every figure is the server's. */}
          <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
            <Text variant="body" weight="bold">
              {fmtCurrency(
                fmt,
                listing.buyerTotalBeforeTaxCents ?? listing.askPriceCents,
                listing.currency ?? currency,
              )}
            </Text>
            <Text variant="caption" tone="muted">
              {String(
                t(
                  listing.buyerTotalBeforeTaxCents != null &&
                    listing.processingPassThroughCents > 0
                    ? "resell.plusTaxIncludesProcessing"
                    : "resell.plusTax",
                ),
              )}
            </Text>
          </XStack>

          <ResaleListingFacts
            listing={{
              askPriceCents: listing.askPriceCents,
              currency: listing.currency ?? currency,
              originalPriceCents: listing.originalPriceCents,
              eventShareCents: listing.eventShareCents,
              sharePayer: listing.sharePayer,
              ticketTypePricing: listing.ticketTypePricing,
            }}
          />

          {/* Seat info */}
          {seatDescription && (
            <Text variant="caption" tone="muted">
              {seatDescription}
            </Text>
          )}

          {/* Expiry */}
          {listing.expiresAt && (
            <Text variant="caption" tone="muted">
              Available until {new Date(listing.expiresAt).toLocaleDateString()}
            </Text>
          )}
        </YStack>

        {/* Secondary, not primary: this CTA repeats per listing and the
            page's single primary is the main "Get tickets" CTA. */}
        <Button
          variant="secondary"
          size="$2"
          tag="a"
          href={`/events/resale/${listing.id}`}
        >
          View
        </Button>
      </XStack>
    </Card>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a human-readable seat description from raw seat fields.
 * Examples: "Row G, Seat 12", "Seat A1", null (for GA/unseated).
 */
function formatSeatDescription(
  seatLabel: string | null,
  seatRow: string | null,
  seatNumber: number | null,
): string | null {
  if (!seatLabel && !seatRow && seatNumber == null) return null;

  // If we have row + number, build "Row X, Seat Y"
  if (seatRow && seatNumber != null) {
    return `Row ${seatRow}, Seat ${seatNumber}`;
  }

  // Fall back to the raw label
  if (seatLabel) {
    return `Seat ${seatLabel}`;
  }

  return null;
}
