"use client";

import { useState } from "react";
import Link from "next/link";
import { styled, XStack, YStack } from "tamagui";
import { Text, Button, Badge, NextLinkAnchor, useTranslations } from "@th/ui";
import { ShieldCheck, ShieldAlert, Clock, ShieldX } from "lucide-react";

import {
  CommunityHandoverNotice,
  PageEditorView,
} from "@/components/entity-pages";
import type { PlaceVerificationStatus } from "@/app/admin/[slug]/_components/PlaceRailContextHeader";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceProfileEditorProps {
  placeId: string;
  slug: string;
  verificationStatus: PlaceVerificationStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

const FormSection = styled(YStack, {
  padding: 32,
  gap: 32,
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

// ─────────────────────────────────────────────────────────────────────────────
// Verification config
// ─────────────────────────────────────────────────────────────────────────────

// Labels reuse the admin.placeVerif* catalog keys the verification surface
// and rail chip already resolve — one vocabulary for one status.
const VERIFICATION_CONFIG: Record<
  PlaceVerificationStatus,
  {
    labelKey: string;
    tone: "success" | "warning" | "danger" | "neutral";
    Icon: typeof ShieldCheck;
  }
> = {
  VERIFIED: {
    labelKey: "admin.placeVerifVerified",
    tone: "success",
    Icon: ShieldCheck,
  },
  PENDING: {
    labelKey: "admin.placeVerifPending",
    tone: "warning",
    Icon: Clock,
  },
  UNVERIFIED: {
    labelKey: "admin.placeVerifUnverified",
    tone: "neutral",
    Icon: ShieldAlert,
  },
  REJECTED: {
    labelKey: "admin.placeVerifRejected",
    tone: "danger",
    Icon: ShieldX,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PlaceProfileEditor({
  placeId,
  slug,
  verificationStatus,
}: PlaceProfileEditorProps) {
  const t = useTranslations();
  const isVerified = verificationStatus === "VERIFIED";
  const verificationInfo = VERIFICATION_CONFIG[verificationStatus];

  const settingsHref = `/admin/${slug}/places/${placeId}/settings`;
  // Bumped after Keep / Clear on the handover notice: Clear rewrites the main
  // section, so the canvas (and its local undo history) starts over.
  const [canvasVersion, setCanvasVersion] = useState(0);

  // The settings that used to sit in a collapsed "Page settings" drawer above
  // this canvas — slug, bio, images, visibility, theme — and the attendee
  // review controls that rode inside it now live on the venue settings page
  // (FR-401). This route is the block canvas and nothing else: composing a
  // page is not setting a field.
  //
  // (Booking left this drawer earlier, for the Bookings page — an owner had
  // looked for the switch here, failed, and reported it did not exist. The
  // drawer it was signposted from is gone now too.)
  //
  // A SIGNPOST, not a second home: an owner who comes here looking for those
  // settings is told once where they went.
  const settingsSignpost = (
    <XStack
      gap="$3"
      alignItems="center"
      flexWrap="wrap"
      data-testid="place-page-settings-moved"
    >
      <Text variant="bodySmall" tone="muted" flexShrink={1} minWidth={0}>
        {String(t("admin.placePageSettingsMovedNote"))}
      </Text>
      <NextLinkAnchor
        href={settingsHref}
        aria-label={String(t("admin.placePageSettingsMovedCta"))}
      >
        {/* `tag="span"` does NOT stop Tamagui's Button emitting
            `role="button" tabindex="0"`, which inside an anchor is a nested
            interactive control and a duplicate tab stop — the anchor is the
            control, so the Button is neutralised to decoration. */}
        <Button
          tag="span"
          variant="secondary"
          size="$2"
          aria-hidden
          tabIndex={-1}
        >
          {String(t("admin.placePageSettingsMovedCta"))}
        </Button>
      </NextLinkAnchor>
    </XStack>
  );

  // ── Verification gate ───────────────────────────────────────
  if (!isVerified) {
    return (
      <>
        <FormSection>
          {settingsSignpost}
          <YStack
            padding="$6"
            gap="$4"
            alignItems="center"
            borderWidth={2}
            borderColor="$borderColor"
            borderRadius={0}
          >
            <verificationInfo.Icon size={48} color="var(--colorMuted)" />
            <Text variant="h3" weight="bold" textAlign="center">
              {String(t("admin.placePageGateHeading"))}
            </Text>
            <Badge tone={verificationInfo.tone} size="md">
              {String(t(verificationInfo.labelKey))}
            </Badge>
            <Text variant="body" tone="muted" textAlign="center" maxWidth={480}>
              {String(t("admin.placePageGateBody"))}
            </Text>
            {(verificationStatus === "UNVERIFIED" ||
              verificationStatus === "REJECTED") && (
              // Verification is a section of the venue settings page now —
              // link straight to it, not to the top of the page.
              <Link href={`${settingsHref}#verification`}>
                <Button tag="span" variant="primary" size="$3">
                  {String(t("admin.placePageGateRequestCta"))}
                </Button>
              </Link>
            )}
            {verificationStatus === "PENDING" && (
              <Text variant="caption" tone="muted">
                {String(t("admin.placePageGatePendingNote"))}
              </Text>
            )}
          </YStack>
        </FormSection>
      </>
    );
  }

  // ── Live editor (verified places) ───────────────────────────
  return (
    <>
      <YStack paddingHorizontal={16} paddingTop={16} gap="$4">
        {settingsSignpost}
        {/* What moderators wrote before the claim, and keep-or-clear. Above
            the canvas so the owner decides before editing (D6). */}
        <CommunityHandoverNotice
          placeId={placeId}
          onResolved={() => setCanvasVersion((v) => v + 1)}
        />
      </YStack>
      {/* `showSettings={false}` drops the settings drawer AND the toolbar's
          aggregate Save with it — left behind, that Save would commit
          nothing (see PageEditorView). */}
      <PageEditorView
        key={canvasVersion}
        ownerType="PLACE"
        ownerId={placeId}
        title={String(t("admin.placePageEditorTitle"))}
        showLiveHeader={false}
        showSettings={false}
      />
    </>
  );
}
