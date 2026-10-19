"use client";

import { use } from "react";

import { useTranslations } from "@th/ui";

import { EventAdminPageShell } from "../_components/EventAdminPageShell";
import { EventOpsShell } from "../_components/EventOpsShell";
import { SeatPriceEditor } from "./_components/SeatPriceEditor";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Seat prices: the organizer gives single seats a custom price (spec
 * docs/specs/2026-08-12/seat-price-overrides.spec.yaml, FR-006 / FR-008).
 *
 * Gate: edit rights, the role set `setSeatPriceOverrides` and its read
 * enforce. NOT `requirePublished`: a DRAFT is priced before it goes on sale,
 * a PUBLISHED event stays editable after tickets sell (the write skips sold
 * and held seats), and an ended event opens read-only. A community listing
 * sells nothing, so it has no seats to price.
 */
export default function AdminEventSeatPricesPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);
  const t = useTranslations();

  return (
    <EventAdminPageShell slug={slug} eventId={eventId} requireEdit forbidCommunity>
      {() => (
        <EventOpsShell
          title={String(t("admin.seatPricesTitle"))}
          purpose={String(t("admin.seatPricesPurpose"))}
        >
          <SeatPriceEditor slug={slug} eventId={eventId} />
        </EventOpsShell>
      )}
    </EventAdminPageShell>
  );
}
