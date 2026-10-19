"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { YStack, XStack } from "tamagui";
import { Badge, Button, Text, useTranslations } from "@th/ui";
import { BadgeCheck, Clock } from "lucide-react";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";

import { ClaimVenueWizard } from "./ClaimVenueWizard";
import { PlaceOwnerRow } from "./PlaceOwnerRow";

type Props = {
  placeId: string;
  placeName: string;
};

/**
 * Public place-page affordance for the claim-venue flow (FR-001 / FR-005 /
 * FR-008). Driven entirely by `getPlaceClaimEligibility`:
 *
 * - claimable       → primary "Claim this place" button → wizard.
 * - pending         → non-interactive "Claim pending review" status.
 * - already_claimed → the shared `PlaceOwnerRow` ("Owned by {name} · Request
 *                     transfer"), i.e. the exact treatment the canonical
 *                     /places/:slug entity page renders (FR-009).
 * - not_eligible    → renders nothing.
 *
 * The wizard requires authentication; signed-out users are sent to /sign-in
 * with a redirect back to the current page.
 */
export function ClaimVenueCta({ placeId, placeName }: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);

  const [wizardOpen, setWizardOpen] = useState(false);

  const eligibilityQuery = trpc.places.getPlaceClaimEligibility.useQuery(
    { placeId },
    { staleTime: 30_000, retry: false, meta: { silent: true } },
  );

  const eligibility = eligibilityQuery.data;

  // Nothing to show until we know the state, and never for not_eligible.
  if (!eligibility || eligibility.state === "not_eligible") {
    return null;
  }

  const signInHref = `/sign-in?redirect=${encodeURIComponent(pathname ?? "/")}`;

  // ── Pending: non-interactive status (FR-005) ──────────────────────────────
  if (eligibility.state === "pending") {
    return (
      <YStack
        gap="$2"
        padding="$3"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surfaceMuted"
        role="status"
      >
        <XStack gap="$2" alignItems="center">
          <Clock size={15} style={{ opacity: 0.7 }} aria-hidden="true" />
          <Badge tone="info" variant="soft" size="sm">
            {String(t("places.claimPendingBadge"))}
          </Badge>
        </XStack>
        <Text variant="caption" tone="muted">
          {String(t("places.claimPendingBody"))}
        </Text>
      </YStack>
    );
  }

  // ── Already claimed: owner + dispute path (FR-008 / FR-009) ───────────────
  // Delegated to the SAME row the canonical /places/:slug entity page renders.
  // This route used to carry its own badge + "This venue has a verified owner."
  // copy that never named anybody; converging on one component means the two
  // routes cannot drift again, and this route gains the owner name for free.
  if (eligibility.state === "already_claimed") {
    return <PlaceOwnerRow placeId={placeId} placeName={placeName} />;
  }

  // ── Claimable: primary CTA (FR-001) ───────────────────────────────────────
  return (
    <>
      {isSignedIn ? (
        <Button
          variant="primary"
          size="$3"
          alignSelf="flex-start"
          onPress={() => setWizardOpen(true)}
          disabled={session.isPending}
        >
          <BadgeCheck size={16} />
          {String(t("places.claimCta"))}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="$3"
          alignSelf="flex-start"
          href={signInHref}
          aria-label={`${String(t("places.claimCta"))} — ${String(
            t("places.claimSignInNote"),
          )}`}
        >
          <BadgeCheck size={16} />
          {String(t("places.claimCta"))}
        </Button>
      )}

      {isSignedIn ? (
        <ClaimVenueWizard
          placeId={placeId}
          placeName={placeName}
          open={wizardOpen}
          domainProofAvailable={eligibility.domainProofAvailable}
          fastTrackEligible={eligibility.fastTrackEligible}
          onClose={() => setWizardOpen(false)}
          onClaimed={() => {
            void eligibilityQuery.refetch();
          }}
        />
      ) : null}
    </>
  );
}
