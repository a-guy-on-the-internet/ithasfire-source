"use client";

import { useEffect, useMemo, type ReactElement } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import {
  Button,
  NextLinkAnchor,
  Separator,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";
import { ArrowLeft } from "lucide-react";

import { SettingsNav } from "@/components/settings";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { AdminPageHeader } from "../../_components/AdminPageHeader";

import { buildOrgSettingsGroups } from "../_lib/org-settings-sections";
import {
  orgSettingsBasePath,
  type OrgSettingsSectionSlug,
} from "../_lib/org-settings-routes";
import { OrgGeneralSection } from "./OrgGeneralSection";
import { OrgContactSection } from "./OrgContactSection";
import { OrgPublicPageSection } from "./OrgPublicPageSection";
import { OrgPerformerSection } from "./OrgPerformerSection";
import { OrgBookingDefaultsSection } from "./OrgBookingDefaultsSection";
import { OrgBookingTagsSection } from "./OrgBookingTagsSection";
import { DefaultAgreementSection } from "./DefaultAgreementSection";
import { OrgDangerSection } from "./OrgDangerSection";

/** Content column width — one measure, every section (matches account settings). */
const CONTENT_MAX_WIDTH = 560;

// ─────────────────────────────────────────────────────────────────────────────
// Section content
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `: ReactElement` return annotation is load-bearing, not decoration. This
 * switch has no `default` arm on purpose — every section slug must map to a
 * component — but WITHOUT the annotation TypeScript simply infers
 * `ReactElement | undefined` and a missing arm compiles clean, rendering
 * nothing at a URL the nav still links to. Annotated, a slug added to
 * `ORG_SETTINGS_SECTION_SLUGS` with no arm here fails the build with "lacks
 * ending return statement". Do not remove it, and do not add a `default`.
 */
function SectionContent({
  section,
  orgId,
  orgName,
  slug,
  canEdit,
}: {
  section: OrgSettingsSectionSlug;
  orgId: string;
  orgName: string;
  slug: string;
  canEdit: boolean;
}): ReactElement {
  switch (section) {
    case "general":
      return <OrgGeneralSection orgId={orgId} canEdit={canEdit} />;
    case "contact":
      return <OrgContactSection orgId={orgId} canEdit={canEdit} />;
    case "page":
      return (
        <OrgPublicPageSection orgId={orgId} slug={slug} canEdit={canEdit} />
      );
    case "performer":
      return <OrgPerformerSection orgId={orgId} canEdit={canEdit} />;
    case "booking-defaults":
      return <OrgBookingDefaultsSection orgId={orgId} slug={slug} />;
    case "booking-tags":
      return <OrgBookingTagsSection orgId={orgId} />;
    case "default-agreement":
      return <DefaultAgreementSection orgId={orgId} orgName={orgName} />;
    case "danger":
      return <OrgDangerSection orgId={orgId} />;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgSettingsViewProps {
  section?: OrgSettingsSectionSlug;
  /**
   * `true` on the bare `/admin/[slug]/settings` route.
   *
   * Desktop is identical either way (rail + content). Mobile differs: the bare
   * route IS the index (nav list, no section body), while a section route shows
   * the section body plus a link back to the index. The switch is a CSS media
   * query, never `useMedia()` — a JS breakpoint read renders one tree on the
   * server and another after hydration.
   */
  isIndexRoute?: boolean;
}

/**
 * `/admin/[slug]/settings` — the org settings shell.
 *
 * Replaces a 870-line single-scroll page that carried its OWN private copy of
 * `SettingsSideRail` (200px, sticky, `$md: { display: "none" }` — i.e. no
 * settings navigation at all on a phone) and a flat five-entry list where three
 * entries pointed at the same URL. Sections are real routes now and the rail is
 * the shared `@/components/settings` `SettingsNav`, the same component the
 * account settings page renders.
 */
export function OrgSettingsView({
  section = "general",
  isIndexRoute = false,
}: OrgSettingsViewProps) {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const t = useTranslations();
  const { currentOwner, isLoading: isOwnerLoading } = useCurrentAdminOwner(slug);

  const isOrg = currentOwner?.kind === "org";
  const orgId = isOrg ? currentOwner.orgId : null;
  const orgName = isOrg ? currentOwner.orgName : "";
  const actorRole = isOrg ? currentOwner.role : null;
  const canEdit = actorRole === "OWNER" || actorRole === "ADMIN";
  const isOwner = actorRole === "OWNER";

  const nav = useMemo(
    () =>
      buildOrgSettingsGroups(
        { slug, canEdit, isOwner },
        { t },
      ),
    [slug, canEdit, isOwner, t],
  );

  // `null` while the owner lookup is unresolved — redirecting on anything but a
  // definite `false` would bounce legitimate admins mid-load. Covers the
  // pre-existing "a non-owner lands directly on /settings/danger" case, which
  // the old view papered over with a local-state fallback that left the URL
  // lying about which section was open.
  const isEntitled = isOrg ? nav.entitled.has(section) : null;

  useEffect(() => {
    if (isEntitled === false) {
      router.replace(orgSettingsBasePath(slug));
    }
  }, [isEntitled, router, slug]);

  // ── Early returns ───────────────────────────────────────────────────────
  if (isOwnerLoading) {
    return (
      // No root padding — ContentArea owns the admin page gutter.
      <YStack
        gap="$4"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.loadingSettings"))}
        </Text>
      </YStack>
    );
  }

  if (!isOrg || !orgId) {
    // The current owner is a human account: surface a link to their personal
    // Account Settings so they can manage profile, email and security without
    // leaving the admin area.
    return (
      // No root padding — ContentArea owns the admin page gutter.
      <YStack gap="$4">
        <AdminPageHeader
          title={String(t("admin.settings"))}
          subtitle={String(t("admin.settingsHumanIntro"))}
          section="settings"
        />

        <YStack gap="$2" paddingTop="$3">
          <Text variant="body" weight="bold">
            {String(t("admin.accountSettingsLinkTitle"))}
          </Text>
          <Text variant="body" tone="muted">
            {String(t("admin.accountSettingsLinkDescription"))}
          </Text>
          {/* `NextLinkAnchor` + `Button tag="span"`, NOT `<Button href>`.
              `Button` is a `styled(TamaguiButton)` and declares no `href`; the
              prop arrived via `GetProps` and was spread straight onto the
              rendered element, producing `<button href="…">` — `href` is not a
              valid attribute on `button`, so BOTH of these controls were dead.
              Verified in the browser before the fix: `tag: "button"`,
              `anchorCount: 0`, and clicking navigated nowhere. This is the
              house pattern used everywhere else, including the rail below. */}
          <XStack gap="$2" paddingTop="$2" flexWrap="wrap">
            <NextLinkAnchor
              href="/account/settings"
              data-testid="org-settings-open-account"
              style={{ textDecoration: "none" }}
            >
              <Button tag="span" variant="primary">
                {String(t("admin.openAccountSettings"))}
              </Button>
            </NextLinkAnchor>
            {/* Account settings is one route per section; the old `#profile`
                anchor still works via the index shim, but link at the route. */}
            <NextLinkAnchor
              href="/account/settings/profile"
              data-testid="org-settings-edit-profile"
              style={{ textDecoration: "none" }}
            >
              <Button tag="span" variant="ghost">
                {String(t("admin.editProfile"))}
              </Button>
            </NextLinkAnchor>
          </XStack>
        </YStack>
      </YStack>
    );
  }

  return (
    // NO root padding. `NavigationShell`'s `ContentArea`
    // (packages/ui/src/ui/shell/NavigationShell.styles.ts) already applies
    // `paddingHorizontal: "$5"` to every admin page, unconditionally at every
    // breakpoint. Adding another `$5` here stacked a second 24px gutter, so at
    // 390px the nav rows measured 260px against the account surface's 334px —
    // 96px of a phone screen spent on nested padding. Team and Orders, the
    // admin pages with the widest content, add none; `ContentArea` owns the
    // page gutter. Vertical rhythm is unaffected: ContentArea also supplies
    // `paddingVertical: "$5"` and `gap: "$4"`.
    <YStack gap="$4" flex={1} width="100%">
      <AdminPageHeader
        title={String(t("admin.settings"))}
        subtitle={String(t("admin.settingsDescription"))}
        section="settings"
      />

      <Separator />

      {/* Nav + content. Flex, not grid: two content-sized siblings that stack
          — nothing needs to align across rows. */}
      <XStack gap="$6" flex={1} $md={{ flexDirection: "column", gap: "$4" }}>
        {/* No `alignSelf` here on purpose: the wrapper must STRETCH to the
            row's height, otherwise it collapses to the rail's own height and
            `SettingsNav`'s `position: sticky` has nothing to travel inside. */}
        <YStack
          flexShrink={0}
          $md={
            isIndexRoute
              ? { width: "100%" }
              : // A section route on mobile shows the section, not the index —
                // the "All settings" link below is the way back.
                { display: "none" }
          }
        >
          <SettingsNav
            groups={nav.groups}
            footerItems={nav.footerItems}
            // THE RULE: the index marks its DEFAULT section active, at every
            // breakpoint — identical to `/account/settings`, which marks
            // Profile. Both surfaces render that section's content on desktop,
            // so leaving the rail unmarked while its panel is on screen tells
            // the user nothing is selected while showing them something. That
            // was a real defect, caught by driving the page.
            //
            // The mobile index IS a pure list with no content beside it, so the
            // highlight there is a weaker claim ("General is the default")
            // rather than a strictly true one. I deliberately did NOT split
            // desktop/mobile: the two settings surfaces disagreeing is worse
            // than either choice on its own, and `SettingsNav` renders ONE tree
            // whose breakpoints are CSS media queries — `aria-current` is a DOM
            // attribute that cannot be media-queried, so a split would fix the
            // visual half and leave the screen-reader half wrong. If we want
            // the mobile index inert, it belongs in `SettingsNav` once, applied
            // to BOTH surfaces. See the note in the nav-model test.
            activeId={section}
            ariaLabel={String(t("admin.settingsNavAria"))}
            testId="org-settings-nav"
          />
        </YStack>

        <YStack
          flex={1}
          gap="$6"
          maxWidth={CONTENT_MAX_WIDTH}
          width="100%"
          minWidth={0}
          // On mobile the bare route IS the index: showing General underneath
          // the list would dump a section the user did not choose.
          $md={isIndexRoute ? { display: "none" } : undefined}
        >
          {!isIndexRoute && (
            <XStack $gtMd={{ display: "none" }}>
              <NextLinkAnchor
                href={orgSettingsBasePath(slug)}
                data-testid="org-settings-back-to-index"
                style={{ textDecoration: "none" }}
              >
                <XStack
                  gap="$2"
                  alignItems="center"
                  minHeight={44}
                  paddingVertical="$2"
                >
                  <ArrowLeft size={16} aria-hidden />
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    textTransform="uppercase"
                    letterSpacing={1.2}
                  >
                    {String(t("admin.settingsAllSections"))}
                  </Text>
                </XStack>
              </NextLinkAnchor>
            </XStack>
          )}

          {isEntitled === false ? (
            <YStack alignItems="center" justifyContent="center" minHeight={200}>
              <Spinner size="lg" />
            </YStack>
          ) : (
            <SectionContent
              section={section}
              orgId={orgId}
              orgName={orgName}
              slug={slug}
              canEdit={canEdit}
            />
          )}
        </YStack>
      </XStack>
    </YStack>
  );
}
