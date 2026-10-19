"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import { Badge, NextLinkAnchor, Spinner, Text, useTranslations } from "@th/ui";
import { ClipboardList, ImageIcon, UserCheck } from "lucide-react";

import { trpc } from "@/trpc";

const CONTENT_MAX_WIDTH = 960;

/** `/moderate/places/<placeId>/page`: the moderator's place page editor. */
const PLACE_PAGE_EDITOR_RE = /^\/moderate\/places\/[^/]+\/page\/?$/;

/**
 * The band's max width for a route. The place page editor takes the full
 * width, as the owner's editor under /admin does: its canvas previews the
 * public page, and the 960px band made it narrower than the page it edits.
 * Every other /moderate page keeps the 960px band.
 */
export function moderateContentMaxWidth(
  pathname: string | null,
): number | undefined {
  return pathname && PLACE_PAGE_EDITOR_RE.test(pathname)
    ? undefined
    : CONTENT_MAX_WIDTH;
}

/**
 * Access gate + band layout for /moderate/** (community-managed-event-
 * listings spec). Gates on `community.checkModeratorAccess`
 * ({ allowed: boolean } — COMMUNITY_MODERATOR or platform ADMIN; never
 * throws for signed-in non-moderators). Mirrors the PlatformShell gating
 * pattern: loading → spinner, denied/error → redirect, no shell chrome.
 *
 * The Applications tab is ADMIN-only (moderatorApplications.list /
 * .review are platform-ADMIN procedures), so its nav link only renders
 * for platform admins; the applications page re-checks and redirects.
 */
export function ModerateShell({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const contentMaxWidth = moderateContentMaxWidth(pathname);

  const accessQuery = trpc.community.checkModeratorAccess.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  });
  const allowed = accessQuery.data?.allowed === true;
  const secondFactorEnrolled = accessQuery.data?.secondFactorEnrolled === true;
  const needsSecondFactor = allowed && !secondFactorEnrolled;

  // ADMIN check only drives the Applications nav link visibility; the page
  // itself re-gates. Only fired once moderator access is confirmed.
  const staffQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
    enabled: allowed,
  });
  const isPlatformAdmin =
    staffQuery.data?.allowed === true &&
    staffQuery.data.roles.includes("ADMIN");

  // Flagged-image backlog badge on the Images nav item. There is no dedicated
  // count procedure, so derive a cheap "one page" count from the first page of
  // the queue (append "+" when a next cursor exists rather than paging further).
  // Only fired once moderator access is confirmed.
  const flaggedImagesQuery = trpc.moderation.listFlaggedImages.useQuery(
    { limit: 30 },
    { retry: false, staleTime: 30_000, enabled: allowed },
  );
  const flaggedImagesCount = flaggedImagesQuery.data?.items.length ?? 0;
  const flaggedImagesHasMore = Boolean(flaggedImagesQuery.data?.nextCursor);
  const flaggedImagesLabel = flaggedImagesCount
    ? `${flaggedImagesCount}${flaggedImagesHasMore ? "+" : ""}`
    : null;

  // Access denied — redirect before rendering anything (PlatformShell pattern:
  // /access-denied is the standalone "no permission" page; a moderator
  // missing an enrolled 2nd factor (step-up 2FA gate) goes to /enroll-2fa
  // instead — they DO have the role, they just need to add a passkey/TOTP.
  useEffect(() => {
    if (accessQuery.isLoading) return;
    if (accessQuery.isError || !allowed) {
      router.replace("/access-denied");
      return;
    }
    if (needsSecondFactor) {
      router.replace(
        `/enroll-2fa?redirect_url=${encodeURIComponent(pathname ?? "/moderate")}`,
      );
    }
  }, [
    accessQuery.isLoading,
    accessQuery.isError,
    allowed,
    needsSecondFactor,
    pathname,
    router,
  ]);

  if (accessQuery.isLoading) {
    return (
      <YStack
        minHeight="60vh"
        alignItems="center"
        justifyContent="center"
        padding="$6"
        aria-busy
      >
        <Spinner size="large" />
      </YStack>
    );
  }

  if (accessQuery.isError || !allowed || needsSecondFactor) {
    // Redirect effect is in flight — render nothing.
    return null;
  }

  const navItems: Array<{
    href: string;
    label: string;
    Icon: typeof ClipboardList;
    count?: string | null;
    countAria?: string;
  }> = [
    {
      href: "/moderate/suggestions",
      label: String(t("moderation.navSuggestions")),
      Icon: ClipboardList,
    },
    {
      href: "/moderate/images",
      label: String(t("moderation.navImages")),
      Icon: ImageIcon,
      count: flaggedImagesLabel,
      countAria: flaggedImagesCount
        ? String(t("moderation.imagesCountAria", { count: flaggedImagesCount }))
        : undefined,
    },
    ...(isPlatformAdmin
      ? [
          {
            href: "/moderate/applications",
            label: String(t("moderation.navApplications")),
            Icon: UserCheck,
          },
        ]
      : []),
  ];

  return (
    <YStack flex={1} minHeight="100vh" backgroundColor="$background">
      {/* Header band — full-width with constrained inner content */}
      <YStack
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        backgroundColor="$surface"
      >
        <YStack
          width="100%"
          maxWidth={contentMaxWidth}
          alignSelf="center"
          paddingHorizontal="$4"
          paddingTop="$5"
          gap="$3"
        >
          <Text
            variant="h3"
            tag="h1"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("moderation.shellTitle"))}
          </Text>

          <nav aria-label={String(t("moderation.shellTitle"))}>
            <XStack gap="$2" flexWrap="wrap">
              {navItems.map(({ href, label, Icon, count, countAria }) => {
                const active = pathname?.startsWith(href) ?? false;
                return (
                  <NextLinkAnchor
                    key={href}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    textDecorationLine="none"
                  >
                    <XStack
                      gap="$2"
                      alignItems="center"
                      minHeight={44}
                      paddingHorizontal="$3"
                      borderBottomWidth={3}
                      borderBottomColor={active ? "$accent" : "transparent"}
                      hoverStyle={{ borderBottomColor: "$accent" }}
                      cursor="pointer"
                    >
                      <Icon size={14} aria-hidden />
                      <Text
                        variant="bodySmall"
                        weight="bold"
                        textTransform="uppercase"
                        tone={active ? "default" : "muted"}
                      >
                        {label}
                      </Text>
                      {count ? (
                        <Badge tone="warning" size="xs" aria-label={countAria}>
                          {count}
                        </Badge>
                      ) : null}
                    </XStack>
                  </NextLinkAnchor>
                );
              })}
            </XStack>
          </nav>
        </YStack>
      </YStack>

      {/* Constrained content band */}
      <YStack
        width="100%"
        maxWidth={contentMaxWidth}
        alignSelf="center"
        paddingHorizontal="$4"
        paddingVertical="$5"
        flex={1}
      >
        {children}
      </YStack>
    </YStack>
  );
}
