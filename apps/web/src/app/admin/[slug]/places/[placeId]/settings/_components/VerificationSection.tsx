"use client";

import { useState, useMemo } from "react";
import { YStack, XStack, useTheme } from "tamagui";
import { Text, Button, Badge, useNotify, useTranslations } from "@th/ui";
import { Send, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  VERIFICATION_ICON_MAP,
  VERIFICATION_LABEL_KEY,
  badgeToneForVerification,
  canRequestPlaceVerification,
  type PlaceVerificationStatus,
} from "@/lib/verification-config";
import { getPlaceVerificationEligibility } from "@th/core/use-cases/places";
import { VerificationRequestForm } from "@/app/admin/[slug]/places/_components/VerificationRequestForm";

// ─── Types ───────────────────────────────────────────────────────────────────

// `PlaceVerificationStatus` is imported, not redeclared: the local copy was
// one of four hand-rolled unions for the same four strings.

interface PlaceForVerification {
  placeId: string;
  name: string;
  addressLine1: string | null;
  city: string | null;
  countryCode: string | null;
  verificationStatus: PlaceVerificationStatus;
  access: {
    orgIds: string[];
    humanIds: string[];
  };
}

interface FormState {
  name: string;
  addressLine1: string;
  city: string;
  countryCode: string;
}

interface VerificationSectionProps {
  place: PlaceForVerification;
  formState: FormState;
  isDirty: boolean;
  placeId: string;
  /**
   * Drop the standalone status-tinted card so the control sits cleanly as a
   * subsection inside a host section that already draws the frame — the same
   * prop, with the same meaning, that `AttendeeReviewsPublicToggle` carries.
   *
   * This surface was built as its OWN page (the retired `/verify`), where
   * the bordered `borderWidth={2}` card WAS the page. Dropped inside a
   * `PlaceEditSection` unchanged it would be a card inside a card, which
   * strict Swiss forbids — see LocationSection's notes on the coordinates
   * read-out and the privacy panel, the same decision made twice already.
   *
   * The status TINT rides the badge and the header icon in both variants, so
   * embedding loses no meaning: the border was the least load-bearing carrier
   * of it.
   */
  embedded?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

// The status → label-key map, the status → badge-tone rule and the
// "may this status submit a request?" predicate all moved to
// `@/lib/verification-config`, beside VERIFICATION_ICON_MAP. They had each
// grown a second copy in the place editor's settings aside, and a status
// added (or a request gate flipped) in one file only would have left the two
// surfaces silently disagreeing. Behaviour here is unchanged.

export function VerificationSection({
  place,
  formState,
  isDirty,
  placeId,
  embedded = false,
}: VerificationSectionProps) {
  const { toast } = useNotify();
  const t = useTranslations();
  const utils = trpc.useUtils();
  const theme = useTheme();

  // The document staging / upload / submit machinery lives in the shared
  // `VerificationRequestForm` (spec FR-012) — this section owns only whether
  // that form is expanded here, inline in the settings page's Verification
  // section (`/verify` redirects there).
  const [showUploadForm, setShowUploadForm] = useState(false);

  // Detail query — surfaces queue position, latest rejection notes, active
  // request status (for IN_REVIEW / withdraw) without an extra round-trip.
  const detailQuery = trpc.places.getPlaceDetail.useQuery(
    { placeId },
    { staleTime: 30_000 },
  );
  const detail = detailQuery.data;
  const activeRequest = detail?.verification.activeRequest ?? null;
  const lastRejected = useMemo(
    () =>
      detail?.verification.history.find((h) => h.status === "REJECTED") ?? null,
    [detail?.verification.history],
  );

  // Queue position is derived from the platform queue. Public output: just
  // the count of PENDING requests created before mine. Skips on IN_REVIEW.
  const queueQuery = trpc.places.getPlatformVerificationQueue.useQuery(
    { statuses: ["PENDING"], limit: 100 },
    {
      enabled: place.verificationStatus === "PENDING" && !!activeRequest,
      staleTime: 60_000,
      meta: { silent: true },
    },
  );
  const queuePosition = useMemo(() => {
    if (!activeRequest || !queueQuery.data) return null;
    const idx = queueQuery.data.items.findIndex(
      (i: { requestId: string }) => i.requestId === activeRequest.id,
    );
    return idx >= 0
      ? { position: idx + 1, total: queueQuery.data.queueStats.pending }
      : null;
  }, [activeRequest, queueQuery.data]);

  // Mutations
  const withdrawMutation = trpc.places.withdrawPlaceVerification.useMutation({
    onSuccess: () => {
      toast.success({
        id: "verification-withdrawn",
        title: t("admin.placeVerifWithdrawn") as string,
      });
      void utils.places.getPlaceForEdit.invalidate({ placeId });
      void utils.places.getPlaceDetail.invalidate({ placeId });
      // The rail's danger badge + header chip read getPlaceTitle (staleTime
      // 60s) — invalidate it too or they show the OLD status right after
      // the user acts.
      void utils.places.getPlaceTitle.invalidate({ placeId });
      void utils.places.listHumanPlaces.invalidate();
    },
    onError: (err) => {
      toast.danger({
        id: "verification-withdraw-failed",
        title: t("admin.placeVerifWithdrawFailed") as string,
        message: formatErrorMessage(err, t),
      });
    },
  });

  // Eligibility
  const verificationEligibility = useMemo(
    () =>
      getPlaceVerificationEligibility({
        name: formState.name,
        addressLine1: formState.addressLine1,
        city: formState.city,
        countryCode: formState.countryCode,
        orgIdsWithAccess: place.access.orgIds,
        humanIdsWithAccess: place.access.humanIds,
      }),
    [formState, place.access],
  );

  const canRequestVerification = canRequestPlaceVerification(
    place.verificationStatus,
  );

  const verificationInfo =
    VERIFICATION_ICON_MAP[place.verificationStatus] ??
    VERIFICATION_ICON_MAP.UNVERIFIED;

  // ── Render ─────────────────────────────────────────────────────────────

  const body = (
    <>
      {/* Status header */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        gap="$3"
        flexWrap="wrap"
      >
        <XStack gap="$2" alignItems="center">
          <verificationInfo.Icon
            size={18}
            color={theme[verificationInfo.themeKey]?.val}
          />
          {/* Embedded, the host section's own heading already reads
              "Verification" — a second one directly under it is a stutter.
              The icon + badge carry the state either way. */}
          {!embedded && (
            <Text variant="bodySmall" weight="bold">
              {String(t("admin.placeVerifHeading"))}
            </Text>
          )}
          <Badge
            tone={badgeToneForVerification(place.verificationStatus)}
            size="sm"
          >
            {String(
              t(
                VERIFICATION_LABEL_KEY[place.verificationStatus] ??
                  VERIFICATION_LABEL_KEY.UNVERIFIED,
              ),
            )}
          </Badge>
        </XStack>

        {canRequestVerification && !showUploadForm && (
          <Button
            // Embedded, the page around this section already has its ONE
            // primary — the page Save (DS v2 §4). Verification is a separate,
            // deliberately secondary action: it judges SAVED data.
            variant={embedded ? "secondary" : "primary"}
            size="$2"
            onPress={() => setShowUploadForm(true)}
            disabled={!verificationEligibility.eligible || isDirty}
          >
            <Send size={14} />
            {String(t("admin.placeVerifRequestButton"))}
          </Button>
        )}
      </XStack>

      {/* Live state hints — surfaces queue position / IN_REVIEW lock /
				rejection notes prominently so organizers don't have to dig into
				the timeline to know what's happening. */}
      {place.verificationStatus === "PENDING" &&
      activeRequest?.status === "PENDING" ? (
        <YStack
          gap="$1"
          padding="$3"
          borderWidth={1}
          borderColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("admin.placeVerifQueueHeading"))}
          </Text>
          <Text variant="caption" tone="muted">
            {queuePosition
              ? String(
                  t("admin.placeVerifQueuePosition", {
                    position: queuePosition.position,
                    total: queuePosition.total,
                  }),
                )
              : String(t("admin.placeVerifQueueWaiting"))}
          </Text>
          <XStack gap="$2" justifyContent="flex-end" marginTop="$2">
            <Button
              variant="secondary"
              size="$1"
              onPress={() =>
                withdrawMutation.mutate({ requestId: activeRequest.id })
              }
              disabled={withdrawMutation.isPending}
            >
              {String(t("admin.placeVerifWithdraw"))}
            </Button>
          </XStack>
        </YStack>
      ) : null}

      {activeRequest?.status === "IN_REVIEW" ? (
        <YStack
          gap="$1"
          padding="$3"
          borderWidth={1}
          borderColor="$info"
          backgroundColor="$surfaceMuted"
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("admin.placeVerifInReviewHeading"))}
          </Text>
          <Text variant="caption" tone="muted">
            {activeRequest.acknowledgedByName
              ? String(
                  t("admin.placeVerifInReviewNamed", {
                    name: activeRequest.acknowledgedByName,
                  }),
                )
              : String(t("admin.placeVerifInReviewAnon"))}
          </Text>
        </YStack>
      ) : null}

      {place.verificationStatus === "REJECTED" &&
      lastRejected?.reviewerNotes ? (
        <YStack
          gap="$1"
          padding="$3"
          borderWidth={2}
          borderColor="$danger"
          backgroundColor="$surfaceMuted"
        >
          <Text variant="bodySmall" weight="bold" tone="error">
            {String(t("admin.placeVerifReviewerFeedback"))}
          </Text>
          <Text variant="caption">{lastRejected.reviewerNotes}</Text>
          {lastRejected.reviewerName ? (
            <Text variant="caption" tone="muted">
              — {lastRejected.reviewerName}
            </Text>
          ) : null}
        </YStack>
      ) : null}

      {/* Benefits explainer — shown for unverified/rejected places when the upload form is closed */}
      {canRequestVerification && !showUploadForm && (
        <YStack
          gap="$2"
          padding="$3"
          borderRadius="$0"
          backgroundColor="$surfaceMuted"
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("admin.placeVerifBenefitsHeading"))}
          </Text>
          <YStack gap="$1">
            {(
              [
                "placeVerifBenefitDiscovery",
                "placeVerifBenefitSeatMaps",
                "placeVerifBenefitTrust",
                "placeVerifBenefitDefaults",
              ] as const
            ).map((key) => (
              <Text key={key} variant="caption" tone="muted">
                {String(t(`admin.${key}`))}
              </Text>
            ))}
          </YStack>
        </YStack>
      )}

      {/* Eligibility checklist (when can request) */}
      {canRequestVerification && !showUploadForm && (
        <YStack gap="$2">
          {isDirty && (
            <XStack gap="$2" alignItems="center">
              <AlertTriangle size={13} color={theme.warning?.val} />
              <Text variant="caption" tone="muted">
                {String(t("admin.placeVerifSaveFirst"))}
              </Text>
            </XStack>
          )}
          {verificationEligibility.reasons.length > 0 ? (
            verificationEligibility.reasons.map((reason) => (
              <XStack key={reason} gap="$2" alignItems="center">
                <XCircle size={13} color={theme.danger?.val} />
                <Text variant="caption" tone="error">
                  {reason}
                </Text>
              </XStack>
            ))
          ) : (
            <XStack gap="$2" alignItems="center">
              <CheckCircle2 size={13} color={theme.success?.val} />
              <Text variant="caption" tone="success">
                {String(t("admin.placeVerifAllRequirementsMet"))}
              </Text>
            </XStack>
          )}
        </YStack>
      )}

      {/* Upload form — the ONE shared implementation (FR-012). The modal
          entry point on the places table renders this same
          component; only the body/action wrappers differ. */}
      {showUploadForm && canRequestVerification && (
        <VerificationRequestForm
          placeId={placeId}
          access={place.access}
          formState={formState}
          isDirty={isDirty}
          onCancel={() => setShowUploadForm(false)}
          onSubmitted={() => setShowUploadForm(false)}
        />
      )}

      {/* Pending status message */}
      {place.verificationStatus === "PENDING" && (
        <Text variant="caption" tone="muted">
          {String(t("admin.placeVerifPendingMessage"))}
        </Text>
      )}

      {/* Verified message */}
      {place.verificationStatus === "VERIFIED" && (
        <Text variant="caption" tone="success">
          {String(t("admin.placeVerifVerifiedMessage"))}
        </Text>
      )}
    </>
  );

  // The vertical rhythm belongs to the CONTENT, so `gap` survives embedding;
  // only the frame (border, padding, surface fill) is the host's to draw.
  if (embedded) {
    return <YStack gap="$3">{body}</YStack>;
  }

  return (
    <YStack
      gap="$3"
      padding="$4"
      borderWidth={2}
      borderColor={
        place.verificationStatus === "VERIFIED"
          ? "$success"
          : place.verificationStatus === "REJECTED"
            ? "$danger"
            : "$borderColor"
      }
      borderRadius={0}
      backgroundColor="$surface"
    >
      {body}
    </YStack>
  );
}
