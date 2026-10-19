"use client";

import { useTranslations } from "@th/ui";

import {
  PageContainer,
  SectionTitle,
  MutedText,
  ContentSection,
  MonoText,
  Card,
  TextLink,
} from "@/components/layout/PagePrimitives";
import { ClaimVenueCta } from "@/components/places/claim";

type PlaceEvent = {
  eventId: string;
  title: string;
  slug: string | null;
  startsAt: string;
  endsAt: string | null;
};

type PlaceContentProps = {
  placeId: string;
  place: {
    name: string;
    formattedAddress?: string | null;
    status: string;
    verificationStatus: string;
  };
  upcomingEvents: PlaceEvent[];
};

export function PlaceContent({
  placeId,
  place,
  upcomingEvents,
}: PlaceContentProps) {
  const t = useTranslations();

  return (
    <PageContainer gap={24} padding="32px 0">
      <ContentSection gap={8}>
        <h1
          style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.025em" }}
        >
          {place.name}
        </h1>
        {place.formattedAddress ? (
          <MutedText>{place.formattedAddress}</MutedText>
        ) : null}
        <MutedText size={12}>
          {String(t("places.status"))}: <MonoText>{place.status}</MonoText>
          {" · "}
          {String(t("places.verification"))}:{" "}
          <MonoText>{place.verificationStatus}</MonoText>
        </MutedText>
        {/* Claim-venue affordance (FR-001 / FR-005 / FR-008). Self-hides when
            the place is not eligible to be claimed. */}
        <ClaimVenueCta placeId={placeId} placeName={place.name} />
      </ContentSection>

      <ContentSection gap={12}>
        <SectionTitle>{String(t("places.upcomingEvents"))}</SectionTitle>
        {upcomingEvents.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {upcomingEvents.map((event) => (
              <Card
                key={event.eventId}
                direction="column"
                gap={4}
                padding="12px 16px"
                style={{ borderRadius: 0 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{event.title}</span>
                  {event.slug ? (
                    <TextLink href={`/events/${event.slug}`} size={14}>
                      {String(t("places.view"))}
                    </TextLink>
                  ) : null}
                </div>
                <MutedText size={14}>
                  <MonoText>{event.startsAt}</MonoText>
                  {event.endsAt ? (
                    <>
                      {" "}
                      &mdash; <MonoText>{event.endsAt}</MonoText>
                    </>
                  ) : null}
                </MutedText>
              </Card>
            ))}
          </div>
        ) : (
          <MutedText>{String(t("places.noUpcomingEvents"))}</MutedText>
        )}
      </ContentSection>
    </PageContainer>
  );
}
