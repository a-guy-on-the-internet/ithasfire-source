"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { useSearchParams } from "next/navigation";
import { YStack, XStack } from "tamagui";
import { ArrowLeft, User } from "lucide-react";
import { Text, Button, NextLinkAnchor, Spinner, useTranslations } from "@th/ui";

import { SettingsNav } from "@/components/settings";
import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useSessionVerdict } from "@/hooks/useSessionVerdict";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { readRedirectParam } from "@/lib/redirect";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

import { PageContainer } from "./settings-primitives";
import { buildSettingsGroups } from "../_lib/settings-sections";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_BASE_PATH,
  sectionFromPathname,
  type SettingsSectionSlug,
} from "../_lib/settings-routes";
import { ProfileSection } from "./ProfileSection";
import { RolesCraftSection } from "./RolesCraftSection";
import { EmailSection } from "./EmailSection";
import { FollowingSection } from "./FollowingSection";
import { NotificationsSection } from "./NotificationsSection";
import { PasswordSection } from "./PasswordSection";
import { TwoFactorSection } from "./TwoFactorSection";
import { PhoneNumberSection } from "./PhoneNumberSection";
import { PhoneNumberReadOnly } from "./PhoneNumberReadOnly";
import { PasskeysSection } from "./PasskeysSection";
import { BillingSection } from "./BillingSection";
import { PerformerSection } from "./PerformerSection";
import { BookingDefaultsSection } from "./BookingDefaultsSection";
import { BookingRequestsSection } from "./BookingRequestsSection";
import { EditSuggestionsSection } from "./EditSuggestionsSection";
import { VenueClaimsSection } from "./VenueClaimsSection";
import { DangerZone } from "./DangerZone";

/**
 * Sticky offset for the 2FA return banner. AppShell's ScrollAwareNavbar is
 * sticky at top 0 (NAV_HEIGHT = 68, module-private in ScrollAwareNavbar.tsx)
 * and stays pinned on desktop, so the banner must stick below it or it would
 * slide under the glass navbar. 68px navbar + 12px breathing room.
 */
const RETURN_BANNER_STICKY_TOP = 80;

/** Content column width — one measure, every section. */
const CONTENT_MAX_WIDTH = 560;

/**
 * True once the client has hydrated.
 *
 * `authClient.useSession()` is PENDING during SSR (auth is client-side), but is
 * frequently already RESOLVED on the client's very first render — so branching
 * the tree on it made the server emit a spinner where the client emitted real
 * chrome, and React threw the whole server tree away with "Hydration failed
 * because the server rendered HTML didn't match the client" on every single
 * account-settings URL.
 *
 * The contract is that the server render and the FIRST client render must be
 * identical. `useState(false)` + a mount effect guarantees that: the hydration
 * pass sees `false` exactly as the server did, and the swap happens in the
 * commit afterwards. Only the inner content region is gated on it — the shell
 * and the nav render unconditionally, so the page never flashes empty.
 */
function useHasHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth-only detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the current user has a credential (email/password) account.
 * OAuth-only users should not see password or 2FA settings. `null` = unknown
 * (still loading, or the lookup failed) — both credential-gated cards stay
 * hidden until it is a definite `true`.
 */
function useHasCredentialAccount() {
  const [hasCredential, setHasCredential] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    authClient
      .listAccounts()
      .then((result) => {
        if (cancelled) return;
        const accounts = (result.data ?? []) as { providerId: string }[];
        setHasCredential(accounts.some((a) => a.providerId === "credential"));
      })
      .catch((err) => {
        traceIgnoredError("account.settings.listAccounts")(err);
        if (!cancelled) setHasCredential(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return hasCredential;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section content
// ─────────────────────────────────────────────────────────────────────────────

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  emailDeliveryStatus?: string | null;
  emailVerified?: boolean | null;
};

/**
 * The Security cluster is four cards, not one — password, phone, TOTP and
 * passkeys all answer "how do I get into this account", so they share a route.
 * Password + 2FA are credential-only; passkeys are an independent primary
 * factor every signed-in user (OAuth-only included) can enrol.
 */
function SecurityCluster({ hasCredential }: { hasCredential: boolean | null }) {
  const showCredentialSecurity = hasCredential === true;
  // A phone number here is used only for texted codes and SMS notifications.
  // With no SMS provider configured nothing is ever texted, so the editable
  // card is swapped (fail-closed while gates load) for a read-only one that
  // still shows a number already on file. It returns when SMS is switched on.
  const { gates } = useFeatureGates();
  const smsAvailable = gates?.sms === true;
  return (
    <YStack gap="$5">
      {showCredentialSecurity && <PasswordSection />}
      {/* Anchor target for the "add a phone to enable SMS" affordance in
          NotificationsSection (PHONE_SECTION_DOM_ID), which now links across
          routes to `/account/settings/security#phone-number-section`. */}
      {smsAvailable ? (
        <YStack id="phone-number-section">
          <PhoneNumberSection />
        </YStack>
      ) : (
        <PhoneNumberReadOnly />
      )}
      {showCredentialSecurity && <TwoFactorSection />}
      <PasskeysSection />
    </YStack>
  );
}

function SectionContent({
  section,
  user,
  hasCredential,
}: {
  section: SettingsSectionSlug;
  user: SessionUser;
  hasCredential: boolean | null;
}) {
  switch (section) {
    case "profile":
      return <ProfileSection user={user} />;
    case "email":
      return <EmailSection user={user} hasCredential={hasCredential} />;
    case "security":
      return <SecurityCluster hasCredential={hasCredential} />;
    case "notifications":
      return (
        <YStack gap="$4">
          <FollowingSection />
          <NotificationsSection />
        </YStack>
      );
    case "billing":
      return <BillingSection />;
    case "roles":
      return <RolesCraftSection />;
    case "performer":
      return <PerformerSection />;
    case "booking-defaults":
      return <BookingDefaultsSection />;
    case "booking-requests":
      return <BookingRequestsSection />;
    case "venues":
      return <VenueClaimsSection />;
    case "contributions":
      return <EditSuggestionsSection />;
    case "danger":
      return <DangerZone />;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsSurfaceProps {
  section: SettingsSectionSlug;
  /**
   * `true` on the bare `/account/settings` route.
   *
   * Desktop is identical either way (rail + content). Mobile differs: the bare
   * route IS the index (nav list, no section body), while a section route shows
   * the section body plus a link back to the index. The switch is a CSS media
   * query, never `useMedia()` — a JS breakpoint read would render one tree on
   * the server and another after hydration, which is exactly the mismatch this
   * route family already had once.
   */
  isIndexRoute?: boolean;
}

export function SettingsSurface({
  section,
  isIndexRoute = false,
}: SettingsSurfaceProps) {
  const router = useRouter();
  const t = useTranslations();
  const searchParams = useSearchParams();

  /**
   * The active section and the mobile index/detail split are CLIENT STATE,
   * seeded once from the props (which come from the SSR entry route). Switching
   * sections then mutates this state and rewrites the URL with
   * `window.history.pushState` — the Next-sanctioned shallow-routing tool (see
   * `node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md`,
   * "Shallow routing on the client"). Because there is no Next navigation, this
   * component stays MOUNTED across a tab switch: the session / credential /
   * work-summary hooks never re-run and the hydration spinner never re-appears.
   *
   * The `[section]` routes remain the SSR/deep-link entry points; a hard load of
   * `/account/settings/email` still renders Email because the prop seeds the
   * initial state below.
   */
  const [activeSection, setActiveSection] =
    useState<SettingsSectionSlug>(section);
  // Mobile-only: `true` shows the nav list (index), `false` shows the section
  // body + "All settings" back link. Desktop ignores this — the CSS media props
  // render rail + content at every width.
  const [isIndex, setIsIndex] = useState(isIndexRoute);

  /**
   * Client-side section switch: swap the panel, rewrite the URL without a
   * navigation, and reset scroll so a section opened from a scrolled mobile
   * index list starts at the top.
   */
  const selectSection = useCallback(
    (slug: SettingsSectionSlug, href: string) => {
      setActiveSection(slug);
      setIsIndex(false);
      window.history.pushState(null, "", href);
      window.scrollTo({ top: 0 });
    },
    [],
  );

  // Mobile "All settings" — return to the index list without a navigation.
  const backToIndex = useCallback(() => {
    setActiveSection(DEFAULT_SETTINGS_SECTION);
    setIsIndex(true);
    window.history.pushState(null, "", SETTINGS_BASE_PATH);
    window.scrollTo({ top: 0 });
  }, []);

  // Browser back/forward over the `pushState` entries never remounts this
  // surface, so re-derive the state from the URL. A `popstate` that lands
  // OUTSIDE the settings tree is left to Next's router, which owns that
  // cross-route navigation (and the remount).
  useEffect(() => {
    function onPopState() {
      const parsed = sectionFromPathname(window.location.pathname);
      if (!parsed) return;
      setActiveSection(parsed.section);
      setIsIndex(parsed.isIndex);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Sanitized return path (e.g. arriving from /enroll-2fa to add a second
  // factor). Never read the raw param — readRedirectParam rejects off-site
  // and javascript: targets.
  const redirectTarget = readRedirectParam(searchParams);
  const { verdict: sessionVerdict, user: sessionUser } = useSessionVerdict();
  const hydrated = useHasHydrated();
  const user = sessionUser as SessionUser | undefined;
  const hasCredential = useHasCredentialAccount();

  /**
   * What the CONTENT COLUMN shows. The shell around it is invariant.
   *
   * `"pending"` is the only thing the server can honestly render (auth is
   * client-side), so it is also what the first client render must produce —
   * hence the `hydrated` gate ahead of the session read. See `useHasHydrated`.
   *
   * The signed-in/out call belongs to `useSessionVerdict`, NOT to raw
   * `isPending` + `data`. Better Auth reports a `/get-session` that answered
   * "nobody" identically to one whose request beat the freshly-set cookie
   * (`isPending: currentValue.data === null`), so reading it inline handed a
   * user who had just typed their password a full "NOT SIGNED IN" dead end
   * whose only way out was to sign in again. The hook re-checks once before
   * concluding, and latches signed-in once a user has been seen.
   */
  const contentState: "pending" | "signedOut" | "ready" =
    !hydrated || sessionVerdict === "unknown"
      ? "pending"
      : sessionVerdict === "signedIn"
        ? "ready"
        : "signedOut";

  const summaryQuery = trpc.humans.getMyWorkSummary.useQuery(undefined, {
    staleTime: 60_000,
    enabled: Boolean(user),
  });
  // A transport-level failure leaves `data` undefined, which we treat as "still
  // unknown": the nav shows the always-available Account group and nothing gets
  // redirected away.
  const summary = summaryQuery.data ?? null;

  const nav = useMemo(
    () => buildSettingsGroups(summary, { t }),
    [summary, t],
  );

  // `null` = "we don't know" — the summary is unresolved, or it came back
  // degraded. See `entitlementDecidable`; the redirect below is the only
  // consumer and it must never fire on a guess.
  const isEntitled = nav.entitlementDecidable
    ? nav.entitled.has(activeSection)
    : null;

  useEffect(() => {
    if (isEntitled === false) {
      router.replace(SETTINGS_BASE_PATH);
    }
  }, [isEntitled, router]);

  return (
    <PageContainer>
      {/* NO page title here. `AccountShell` (the /account layout) already
          renders "Navigate → SETTINGS" plus the Overview/My Page/Settings/
          Notifications tab row directly above this component, so a second
          <h2>SETTINGS</h2> stacked ~180px under the first was pure repetition —
          and its back button duplicated the tab row on desktop and the
          "All settings" link on mobile. This now matches the org settings
          surface: the shell states where you are, the nav says which section,
          and each section card carries its own heading. */}

      {/* Nav + content. Flex, not grid: two content-sized siblings that stack
          — nothing needs to align across rows. */}
      <XStack gap="$6" flex={1} $md={{ flexDirection: "column", gap: "$4" }}>
        {/* No `alignSelf` here on purpose: the wrapper must STRETCH to the
            row's height, otherwise it collapses to the rail's own height and
            `SettingsNav`'s `position: sticky` has nothing to travel inside. */}
        <YStack
          flexShrink={0}
          $md={
            isIndex
              ? { width: "100%" }
              : // A section detail on mobile shows the section, not the index —
                // the "All settings" link below is the way back.
                { display: "none" }
          }
        >
          <SettingsNav
            groups={nav.groups}
            footerItems={nav.footerItems}
            activeId={activeSection}
            onSelect={(id, href) =>
              selectSection(id as SettingsSectionSlug, href)
            }
            ariaLabel={String(t("account.settingsNavAria"))}
          />

          {/* A failed summary silently produced a nav with no work or
              submissions groups and no way to notice, let alone recover. Say
              so, and offer the retry — `refetch` is the only affordance,
              since a reload would just re-run the same failing query. */}
          {summaryQuery.isError && (
            <YStack
              gap="$2"
              paddingHorizontal="$3"
              paddingTop="$3"
              role="status"
              data-testid="settings-nav-summary-error"
            >
              <Text variant="caption" color="$dangerSoft">
                {String(t("account.settingsNavLoadError"))}
              </Text>
              <XStack>
                <Button
                  variant="ghost"
                  size="$2"
                  minHeight={44}
                  onPress={() => void summaryQuery.refetch()}
                  disabled={summaryQuery.isFetching}
                >
                  {String(t("account.settingsNavRetry"))}
                </Button>
              </XStack>
            </YStack>
          )}
        </YStack>

        <YStack
          flex={1}
          gap="$7"
          maxWidth={CONTENT_MAX_WIDTH}
          width="100%"
          // On mobile the index IS the list: showing Profile underneath it
          // would dump a section the user did not choose.
          $md={isIndex ? { display: "none" } : undefined}
        >
          {!isIndex && (
            <XStack $gtMd={{ display: "none" }}>
              <NextLinkAnchor
                href={SETTINGS_BASE_PATH}
                data-testid="settings-back-to-index"
                // Plain left-click returns to the index client-side; modified
                // clicks fall through to a real navigation to the base route.
                onClick={(e) => {
                  if (
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey ||
                    e.button !== 0
                  ) {
                    return;
                  }
                  e.preventDefault();
                  backToIndex();
                }}
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
                    {String(t("account.settingsAllSections"))}
                  </Text>
                </XStack>
              </NextLinkAnchor>
            </XStack>
          )}

          {activeSection === "security" && redirectTarget && (
            <YStack
              borderWidth={2}
              borderColor="$borderColor"
              borderLeftWidth={3}
              borderLeftColor="$accent"
              borderRadius={0}
              backgroundColor="$surface"
              padding="$4"
              gap="$3"
              role="status"
              zIndex={10}
              // Sticky so the return affordance survives scrolling through the
              // Security cluster — otherwise it leaves the viewport and the
              // user has no way back after enrolling. Inline style, not a
              // Tamagui prop: the react-native-web layer silently strips
              // `position: "sticky"` (see the HeaderLeft note in
              // EventBuilder.tsx). $surface is opaque in both themes, so
              // sections don't bleed through while stuck; no ancestor up to
              // <body> sets overflow hidden (body uses overflow-x: clip,
              // chosen precisely because it doesn't defeat sticky).
              style={{
                position: "sticky",
                top: RETURN_BANNER_STICKY_TOP,
              }}
            >
              <Text
                variant="bodySmall"
                weight="bold"
                textTransform="uppercase"
                letterSpacing={1.2}
              >
                {String(t("account.settings2faReturnTitle"))}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {String(t("account.settings2faReturnDesc"))}
              </Text>
              <XStack>
                <NextLinkAnchor href={redirectTarget}>
                  <Button tag="span" variant="primary" size="$3">
                    {String(t("account.settings2faReturnCta"))}
                  </Button>
                </NextLinkAnchor>
              </XStack>
            </YStack>
          )}

          {/* The ONLY part of this page that varies with session state. The
              shell above renders identically on the server and on the first
              client pass, which is what keeps hydration intact. */}
          {contentState === "pending" || isEntitled === false ? (
            <YStack alignItems="center" justifyContent="center" minHeight={200}>
              <Spinner size="lg" />
            </YStack>
          ) : contentState === "signedOut" ? (
            <YStack alignItems="center" gap="$4" minHeight={200}>
              <User size={48} color="$colorMuted" />
              <Text variant="h3">{String(t("account.notSignedIn"))}</Text>
              <Text variant="body" tone="muted" textAlign="center">
                {String(t("account.notSignedInDesc"))}
              </Text>
              <NextLinkAnchor href="/sign-in">
                <Button tag="span" variant="primary" size="$3">
                  {String(t("auth.signIn"))}
                </Button>
              </NextLinkAnchor>
            </YStack>
          ) : (
            <SectionContent
              section={activeSection}
              user={user!}
              hasCredential={hasCredential}
            />
          )}
        </YStack>
      </XStack>
    </PageContainer>
  );
}
