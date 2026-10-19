"use client";

import { YStack } from "tamagui";
import { NextLinkAnchor, Spinner, Text, useTranslations } from "@th/ui";
import { ArrowRight } from "lucide-react";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import {
  CommunityHandoverNotice,
  PageFieldsEditor,
  PageThemeEditor,
} from "@/components/entity-pages";
import { trpc } from "@/trpc";
import type { PlaceVerificationStatus } from "@/lib/verification-config";

import { PlaceEditSection } from "./PlaceEditSection";

/**
 * The venue's PUBLIC PAGE settings — slug, bio, images, visibility, theme —
 * as a section of the venue settings page.
 *
 * These two forms used to live in a collapsed "Page settings" drawer above the
 * block canvas on `/page`. They are the SAME components (`PageFieldsEditor`,
 * `PageThemeEditor`) rendered `embedded`, so the ORG and HUMAN page editors,
 * which keep the drawer, and this section can never drift into two
 * implementations. The block canvas stays on `/page`: composing a page is not
 * setting a field.
 *
 * SAVING. Neither form carries a Save button — each registers with the nearest
 * `PageSettingsSaveProvider` (see `page-settings-save.tsx`). The venue settings
 * page mounts that provider and folds the aggregate into its ONE Save, which
 * is why nothing here has to know about saving at all. Images still auto-save
 * on pick, exactly as they did in the drawer.
 *
 * VERIFICATION GATE. `/page` only ever offered these forms to a VERIFIED
 * venue — an unverified one got a gate screen instead. That is a product rule,
 * not a server one (`updatePage` has no verification check), and moving the
 * forms must not quietly lift it, so the same gate applies here with the same
 * copy.
 *
 * The same `AdminEmailVerificationGate` block `/page` wraps its editor in
 * wraps these forms, for the same reason.
 */
export type PublicPageSectionProps = {
  placeId: string;
  /** Org/workspace slug for the link to the block canvas. */
  slug: string;
  verificationStatus: PlaceVerificationStatus;
  headingId: string;
};

export function PublicPageSection({
  placeId,
  slug,
  verificationStatus,
  headingId,
}: PublicPageSectionProps) {
  const t = useTranslations();
  const isVerified = verificationStatus === "VERIFIED";

  // Same query + key `PageEditorView` uses on `/page`, so React Query shares
  // it and the header's page-visibility chip reads the same answer.
  const pageQuery = trpc.entityPages.getMyPage.useQuery(
    { ownerType: "PLACE", ownerId: placeId },
    { staleTime: 10_000, retry: 2, enabled: isVerified },
  );
  const page = pageQuery.data?.page;
  const theme = pageQuery.data?.theme ?? null;

  const canvasLink = isVerified ? (
    <NextLinkAnchor
      href={`/admin/${slug}/places/${placeId}/page`}
      className="th-place-edit-link"
      data-testid="place-settings-open-canvas"
    >
      <span className="th-place-edit-link-rule">
        <Text variant="bodySmall" weight="bold" tone="inherit">
          {String(t("admin.placeSettingsOpenCanvasLabel"))}
        </Text>
        <ArrowRight size={16} strokeWidth={2.5} aria-hidden="true" />
      </span>
    </NextLinkAnchor>
  ) : null;

  let body;
  if (!isVerified) {
    body = (
      <Text variant="body" tone="muted" data-testid="place-settings-page-gate">
        {String(t("admin.placePageGateBody"))}
      </Text>
    );
  } else if (pageQuery.isLoading) {
    body = (
      <YStack alignItems="center" paddingVertical="$4">
        <Spinner size="lg" />
      </YStack>
    );
  } else if (pageQuery.isError || !page) {
    body = (
      <Text variant="body" tone="muted">
        {String(t("admin.peNoPageDescription"))}
      </Text>
    );
  } else {
    body = (
      <AdminEmailVerificationGate mode="block">
        <YStack gap="$5">
          {/* Same notice as the canvas route: Clear empties the bio and
              images this form edits, so the owner sees it here first too. */}
          <CommunityHandoverNotice placeId={placeId} />
          <PageFieldsEditor
            page={{ ...page, slug: page.slug ?? "" }}
            ownerType="PLACE"
            ownerId={placeId}
            embedded
          />
          {/* A rule, not a second box: two forms, one section. */}
          <YStack
            borderTopWidth={1}
            borderTopColor="$borderColor"
            paddingTop="$5"
          >
            <PageThemeEditor
              theme={theme}
              ownerType="PLACE"
              ownerId={placeId}
              embedded
            />
          </YStack>
        </YStack>
      </AdminEmailVerificationGate>
    );
  }

  return (
    <PlaceEditSection
      title={String(t("admin.placeSettingsSectionPublicPage"))}
      headingId={headingId}
      anchor
      headerAside={canvasLink}
    >
      {body}
    </PlaceEditSection>
  );
}
