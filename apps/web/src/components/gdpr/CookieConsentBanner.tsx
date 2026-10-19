"use client";

import { memo, useMemo } from "react";
import NextLink from "next/link";
import { XStack, YStack, styled } from "tamagui";

import { Button, Text, useTranslations } from "@th/ui";

import { useConsentContext } from "@/components/gdpr/ConsentProvider";
import { optionalStorageKeys } from "@/lib/consent-scope";

// Inline anchor for use within a flowing paragraph. The shared `@th/ui` Link
// renders an `<a>` with `display: flex`, which breaks line wrapping when the
// link sits mid-sentence — see CookieConsentBanner description. Use this
// minimal wrapper instead.
const INLINE_LINK_STYLE: React.CSSProperties = {
  display: "inline",
  color: "inherit",
  textDecoration: "underline",
};

// Same trick as INLINE_LINK_STYLE — bold the disclosure label without nesting a
// second Tamagui <Text>, which would re-assert its own colour instead of
// inheriting the muted parent.
const INLINE_LABEL_STYLE: React.CSSProperties = {
  display: "inline",
  color: "inherit",
  fontWeight: 600,
};

// ── Layout ───────────────────────────────────────────────────────────────────

const BannerOverlay = styled(YStack, {
  name: "CookieBannerOverlay",
  position: "fixed" as never,
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 999_000,
  padding: "$4",
  pointerEvents: "box-none",
  $xs: { padding: "$2" },
});

const BannerCard = styled(YStack, {
  name: "CookieBannerCard",
  maxWidth: 560,
  marginHorizontal: "auto",
  backgroundColor: "$background",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  padding: "$4",
  gap: "$3",
  shadowColor: "transparent",
  shadowOffset: { width: 0, height: 0 },
  shadowRadius: 0,
  shadowOpacity: 0,
  elevation: 0,
  // Tighter on phones — the default padding + 4-line description
  // covered ~half the viewport on iOS Safari.
  $xs: { padding: "$3", gap: "$2" },
});

const ButtonRow = styled(XStack, {
  name: "CookieBannerButtons",
  gap: "$2",
  flexWrap: "wrap",
  justifyContent: "flex-end",
});

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Fixed-bottom cookie-consent banner. Shows only while the user has not yet
 * made a consent choice (`th-consent` cookie is absent) AND there is something
 * optional actually wired up to consent to.
 */
export const CookieConsentBanner = memo(function CookieConsentBanner() {
  const t = useTranslations();
  const { consent, acceptAll, acceptEssential, ready } = useConsentContext();

  // Derived from what is actually configured at build time, so the banner can
  // never claim you are consenting to something that never loads. Today that
  // means replay (NEXT_PUBLIC_SENTRY_DSN is set in every deployed env) but not
  // analytics (no NEXT_PUBLIC_GA_MEASUREMENT_ID anywhere).
  const optionalItems = useMemo(
    () => optionalStorageKeys().map((key) => String(t(key))),
    [t],
  );

  // Don't render during SSR or once the user has chosen
  if (!ready || consent !== null) return null;

  // Nothing optional is wired, so everything left is strictly necessary
  // (session, theme, event unlock, Stripe fraud checks) and exempt from consent
  // under ePrivacy Art. 5(3). Asking anyway would be pure theatre.
  if (optionalItems.length === 0) return null;

  return (
    <BannerOverlay>
      <BannerCard>
        <Text variant="body" weight="bold">
          {String(t("common.cookieTitle"))}
        </Text>
        <Text variant="caption" color="$colorMuted">
          {String(t("common.cookieDescription"))}{" "}
          <NextLink href="/privacy" style={INLINE_LINK_STYLE}>
            {String(t("common.privacyPolicy"))}
          </NextLink>{" "}
          {String(t("common.and"))}{" "}
          <NextLink href="/cookie-policy" style={INLINE_LINK_STYLE}>
            {String(t("common.cookiePolicy"))}
          </NextLink>{" "}
          {String(t("common.forDetails"))}
        </Text>

        {/* The explicit inventory. Whatever we ask consent for is named here in
            plain language — no "improve your experience" euphemism. */}
        <YStack gap="$2">
          <Text variant="caption" color="$colorMuted">
            <span style={INLINE_LABEL_STYLE}>
              {String(t("common.cookieAlwaysOnLabel"))}
            </span>
            {` — ${String(t("common.cookieAlwaysOnItems"))}`}
          </Text>
          <Text variant="caption" color="$colorMuted">
            <span style={INLINE_LABEL_STYLE}>
              {String(t("common.cookieOptionalLabel"))}
            </span>
            {` — ${optionalItems.join(" ")}`}
          </Text>
        </YStack>

        {/* Both buttons get equal visual weight so the rejection path is as
            easy to take as accepting — required by EDPB cookie-consent guidance
            (March 2023) which forbids dark-pattern primary "Accept" CTAs. */}
        <ButtonRow>
          <Button size="$3" onPress={() => acceptEssential("BANNER")} flex={1}>
            {String(t("common.essentialOnly"))}
          </Button>
          <Button size="$3" onPress={() => acceptAll("BANNER")} flex={1}>
            {String(t("common.acceptAll"))}
          </Button>
        </ButtonRow>
      </BannerCard>
    </BannerOverlay>
  );
});
