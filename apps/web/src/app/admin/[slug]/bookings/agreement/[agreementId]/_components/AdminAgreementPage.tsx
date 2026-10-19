"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { XStack, YStack, styled } from "tamagui";
import { ArrowLeft } from "lucide-react";
import { Badge, NextLinkAnchor, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import {
  adminAgreementHref,
  adminBookingHref,
  findAgreementPartyOwner,
} from "@/lib/agreement-routes";
import {
  AGREEMENT_STATUS_LABEL_KEYS,
  agreementStatusTone,
} from "@/lib/booking-agreements";
import { AdminPageHeader } from "@/app/admin/[slug]/_components/AdminPageHeader";
import { AgreementEditor } from "@/app/agreements/[agreementId]/_components/AgreementEditor";
import { BookingStageRail } from "@/components/bookings/BookingStageRail";

/** Same frame as the bookings inbox this page is reached from. */
const PageContainer = styled(YStack, {
  name: "AdminAgreementPage",
  gap: "$5",
  padding: "$4",
  width: "100%",
  maxWidth: 1000,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

/** Wrapper carries the 44px touch target; the label stays caption-sized. */
const BackLinkTarget = styled(XStack, {
  gap: "$2",
  alignItems: "center",
  minHeight: 44,
  alignSelf: "flex-start",
});

/**
 * The agreement editor under the admin, framed by the BOOKING it belongs to.
 *
 * This component owns the page's identity — the back link to the booking,
 * the title, the status badge and the stage rail — and hands the editor
 * `chrome="admin"` so it paints none of those a second time. Two title
 * headings or two status badges on one page would be two elements with the
 * same accessible name apiece (the "two Save buttons" lesson).
 *
 * It shares the editor's query key (`bookingAgreements.get` for this id), so
 * the header costs no extra request: React Query dedupes the read and the
 * two render from the same cache entry. Loading and error states are the
 * editor's — this header renders only once the data it describes exists, so
 * the page never shows a rail for a booking it has not read yet.
 *
 * WRONG SHELL: a member of org X who is a party through org Y can type
 * `/admin/X/bookings/agreement/{Y's id}`. The server party gate means nothing
 * leaks, but X's inbox does not hold this booking, so "Back to booking" would
 * point at a row that is not there. Once the read resolves, the actor's party
 * is compared with the shell's owner: on a mismatch the page replaces itself
 * under the party's own slug when the viewer has one, and otherwise the back
 * link falls back to the inbox itself (no `?request=`).
 */
export function AdminAgreementPage({
  slug,
  agreementId,
}: {
  slug: string;
  agreementId: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const query = trpc.bookingAgreements.get.useQuery(
    { agreementId },
    { staleTime: 10_000, retry: false, meta: { silent: true } },
  );
  const data = query.data;
  const request = data?.bookingRequest ?? null;

  const { currentOwner, ownerEntities } = useCurrentAdminOwner(slug);
  const partyOwner = data
    ? findAgreementPartyOwner(data, ownerEntities.ownersWithSlugs)
    : null;
  // Null until BOTH sides are known — never "wrong" on a half-loaded read.
  const inOwnShell =
    data && currentOwner
      ? partyOwner !== null && partyOwner.adminSlug === currentOwner.adminSlug
      : null;
  const relocateHref =
    inOwnShell === false && partyOwner
      ? adminAgreementHref(partyOwner.adminSlug, agreementId)
      : null;

  useEffect(() => {
    if (relocateHref) router.replace(relocateHref);
  }, [relocateHref, router]);

  return (
    <PageContainer data-testid="admin-agreement-page">
      <NextLinkAnchor
        href={adminBookingHref(
          slug,
          inOwnShell === false ? null : (request?.id ?? null),
        )}
        style={{ textDecoration: "none" }}
        data-testid="admin-agreement-back"
      >
        <BackLinkTarget>
          <ArrowLeft size={13} aria-hidden style={{ opacity: 0.6 }} />
          <Text variant="caption" tone="muted">
            {String(t("admin.baAdminBackToBooking"))}
          </Text>
        </BackLinkTarget>
      </NextLinkAnchor>

      {data ? (
        <YStack gap="$4">
          <AdminPageHeader
            title={data.agreement.title}
            subtitle={String(t("admin.baEditorEyebrow"))}
            trailing={
              <Badge
                tone={agreementStatusTone(data.agreement.status)}
                size="sm"
                data-testid="admin-agreement-status"
              >
                {String(t(AGREEMENT_STATUS_LABEL_KEYS[data.agreement.status]))}
              </Badge>
            }
          />
          {/* The arc this agreement sits in. Only a request-born agreement
              has a request leg to draw; a bare agreement gets no rail rather
              than one with an invented first stage. */}
          {request ? (
            <BookingStageRail
              variant="full"
              status={request.status}
              agreementStatus={data.agreement.status}
              eventId={data.event?.id ?? data.agreement.eventId}
              eventStatus={data.event?.status ?? null}
              eventStartsAt={data.event?.startsAt ?? null}
              preferredDates={request.preferredDates}
              testIdBase="admin-agreement"
            />
          ) : null}
        </YStack>
      ) : null}

      <AgreementEditor
        agreementId={agreementId}
        chrome="admin"
        adminSlug={slug}
      />
    </PageContainer>
  );
}
