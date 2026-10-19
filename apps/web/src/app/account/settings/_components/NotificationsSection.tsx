"use client";

import { useState, useCallback } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, styled } from "tamagui";
import { Bell } from "lucide-react";
import {
  Text,
  Button,
  Spinner,
  Switch,
  useNotify,
  useTranslations,
} from "@th/ui";
import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { SmsLegalLinks } from "@/components/notifications/SmsLegalLinks";
import { SectionCard } from "./settings-primitives";

// ─────────────────────────────────────────────────────────────────────────────
// Notification types & constants
// ─────────────────────────────────────────────────────────────────────────────

type ChannelKey = "in_app" | "email" | "push" | "sms";
type CategoryKey =
  | "transactional"
  | "announcements"
  | "reminders"
  | "marketing"
  | "organizerMessages";

const CHANNEL_KEYS: ChannelKey[] = ["in_app", "email", "push", "sms"];
const CHANNEL_LABEL_KEYS: Record<ChannelKey, string> = {
  in_app: "account.sNotifChInApp",
  email: "account.sNotifChEmail",
  push: "account.sNotifChPush",
  sms: "account.sNotifChSms",
};

/**
 * Fallback when the server snapshot omits a channel/category value. Must
 * mirror the defaults the backend applies (adapter DEFAULT_SNAPSHOT +
 * `smsDefaultEnabled` in packages/core/src/use-cases/comms/categories.ts):
 * in-app/email/push default ON, SMS is strictly opt-in and defaults OFF.
 */
const CHANNEL_DEFAULT_ENABLED: Record<ChannelKey, boolean> = {
  in_app: true,
  email: true,
  push: true,
  sms: false,
};

/** DOM id of the phone-number settings card (see SettingsSurface's Security cluster). */
const PHONE_SECTION_DOM_ID = "phone-number-section";

const CATEGORY_KEYS: {
  key: CategoryKey;
  labelKey: string;
  descKey: string;
}[] = [
  {
    // Transactional (order confirmations, tickets, location reveals). Email/
    // push/SMS are user-suppressible per channel; the in-app copy of a
    // transactional notification is always delivered, so that toggle is
    // locked on (FR-012).
    key: "transactional",
    labelKey: "account.sNotifCatTransactional",
    descKey: "account.sNotifCatTransactionalDesc",
  },
  {
    key: "announcements",
    labelKey: "account.sNotifCatAnnouncements",
    descKey: "account.sNotifCatAnnouncementsDesc",
  },
  {
    // Ahead-of-time nudges for something the viewer already opted into — the
    // 24h-before RSVP reminder. Its own row (not folded into transactional) so
    // it is independently switchable per channel, which is the whole point.
    key: "reminders",
    labelKey: "account.sNotifCatReminders",
    descKey: "account.sNotifCatRemindersDesc",
  },
  {
    key: "marketing",
    labelKey: "account.sNotifCatPromotions",
    descKey: "account.sNotifCatPromotionsDesc",
  },
  {
    key: "organizerMessages",
    labelKey: "account.sNotifCatOrgUpdates",
    descKey: "account.sNotifCatOrgUpdatesDesc",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Local styled components
// ─────────────────────────────────────────────────────────────────────────────

const CategoryCard = styled(YStack, {
  name: "NotifCategoryCard",
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  overflow: "hidden",
});

const CategoryHeader = styled(YStack, {
  name: "NotifCategoryHeader",
  gap: "$1",
  paddingVertical: "$3",
  paddingHorizontal: "$4",
  backgroundColor: "$surfaceMuted",
});

const ChannelRow = styled(XStack, {
  name: "NotifChannelRow",
  alignItems: "center",
  justifyContent: "space-between",
  paddingVertical: "$4",
  paddingHorizontal: "$4",
  borderTopWidth: 1,
  borderTopColor: "$borderColor",
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function NotificationsSection() {
  const t = useTranslations();
  const { toast } = useNotify();
  const router = useRouter();

  const prefsQuery = trpc.notificationPreferences.get.useQuery(
    { scope: { kind: "GLOBAL" } },
    { staleTime: 60_000 },
  );

  // ── SMS eligibility (FR-011) ────────────────────────────────────────────
  // SMS toggles only become interactive once a verified phone number (with
  // its SMS consent, captured during verification) is on file. Same session
  // fields PhoneNumberSection reads; verifying a phone refetches the session,
  // so the toggles unlock live.
  const sessionQuery = authClient.useSession();
  const sessionUser = sessionQuery.data?.user as
    | (NonNullable<typeof sessionQuery.data>["user"] & {
        phoneNumber?: string | null;
        phoneNumberVerified?: boolean | null;
      })
    | undefined;
  const smsEligible = Boolean(
    sessionUser?.phoneNumber && sessionUser?.phoneNumberVerified,
  );
  const smsGateResolved = !sessionQuery.isPending;

  // ── SMS availability (platform) ─────────────────────────────────────────
  // With no SMS provider configured nothing is ever texted, so the SMS
  // channel and its "add a phone" nudge are not offered at all. Fail-closed:
  // only an explicit `sms === true` shows them, so they never flash in while
  // the gates load. They come back on their own when SMS is switched on.
  const { gates } = useFeatureGates();
  const smsAvailable = gates?.sms === true;

  /**
   * Take the user to the phone-number card.
   *
   * Notifications and Security are separate routes now, so the card is normally
   * on another page — navigate there and let the fragment do the scrolling. The
   * same-page scroll is kept as the first branch because this section is also
   * embedded elsewhere (and it degrades to a no-op navigation rather than a
   * silent nothing if the card ever shares a page again).
   */
  const scrollToPhoneSection = useCallback(() => {
    const onPage = document.getElementById(PHONE_SECTION_DOM_ID);
    if (onPage) {
      onPage.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    router.push(`/account/settings/security#${PHONE_SECTION_DOM_ID}`);
  }, [router]);

  // ── Optimistic local overrides ──────────────────────────────────────────
  // Keyed by "channel:category" → boolean, applied on top of server data.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  // Track which specific toggles have in-flight mutations.
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const updateMutation = trpc.notificationPreferences.update.useMutation();

  const serverPrefs = prefsQuery.data?.preferences;
  // Categories that may go out by SMS come from the server (core's
  // `smsEligibleCategories`), so this list never drifts from what is sent.
  // Until it loads, no category gets an SMS row.
  const smsEligibleCategories: readonly string[] =
    prefsQuery.data?.smsEligibleCategories ?? [];
  const isLoading = prefsQuery.isLoading;

  /** Read effective value for a specific channel+category toggle. */
  const getEnabled = useCallback(
    (channel: ChannelKey, category: CategoryKey): boolean => {
      const key = `${channel}:${category}`;
      if (key in optimistic) return optimistic[key];
      return (
        serverPrefs?.[channel]?.[category] ?? CHANNEL_DEFAULT_ENABLED[channel]
      );
    },
    [serverPrefs, optimistic],
  );

  const handleToggle = useCallback(
    (channel: ChannelKey, category: CategoryKey, enabled: boolean) => {
      const key = `${channel}:${category}`;
      // Apply optimistic override immediately.
      setOptimistic((prev) => ({ ...prev, [key]: enabled }));
      setSaving((prev) => ({ ...prev, [key]: true }));

      updateMutation.mutate(
        {
          scope: { kind: "GLOBAL" },
          channels: {
            [channel]: { [category]: enabled },
          },
        },
        {
          onSuccess: () => {
            void prefsQuery.refetch().then(() => {
              // Clear only this toggle's optimistic override.
              setOptimistic((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
            });
          },
          onError: () => {
            // Roll back this toggle's optimistic override.
            setOptimistic((prev) => {
              const next = { ...prev };
              delete next[key];
              return next;
            });
            toast.danger({
              id: "notif-prefs-failed",
              title: String(t("account.sNotifSaveError")),
              message: String(t("account.sNotifSaveErrorDesc")),
            });
          },
          onSettled: () => {
            setSaving((prev) => {
              const next = { ...prev };
              delete next[key];
              return next;
            });
          },
        },
      );
    },
    [updateMutation, prefsQuery, toast, t],
  );

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Bell size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sNotificationsTitle"))}
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        {String(t("account.sNotificationsDesc"))}
      </Text>

      {isLoading ? (
        <YStack alignItems="center" paddingVertical="$6">
          <Spinner size="sm" />
        </YStack>
      ) : !serverPrefs ? (
        <YStack
          gap="$2"
          padding="$3"
          backgroundColor="$surfaceMuted"
          borderRadius={0}
        >
          <Text variant="body" weight="medium">
            {String(t("account.sNotifLoadError"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("account.sNotifLoadErrorDesc"))}
          </Text>
        </YStack>
      ) : (
        <YStack gap="$3">
          {smsAvailable && smsGateResolved && !smsEligible ? (
            <XStack
              gap="$3"
              alignItems="center"
              justifyContent="space-between"
              flexWrap="wrap"
              padding="$3"
              borderWidth={1}
              borderColor="$borderColor"
              borderRadius={0}
              backgroundColor="$surfaceMuted"
            >
              <Text variant="bodySmall" flexShrink={1}>
                {String(t("errors.phoneRequiredForSms"))}
              </Text>
              <Button
                variant="outlined"
                size="$2"
                onPress={scrollToPhoneSection}
              >
                {String(t("account.sNotifAddPhoneBtn"))}
              </Button>
            </XStack>
          ) : null}

          {smsAvailable ? (
            <Text variant="caption" tone="muted">
              {String(t("account.sNotifSmsDisclosure"))} <SmsLegalLinks />
            </Text>
          ) : null}

          {CATEGORY_KEYS.map((cat) => {
            return (
              <CategoryCard key={cat.key}>
                <CategoryHeader>
                  <Text variant="body" weight="bold">
                    {String(t(cat.labelKey))}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {String(t(cat.descKey))}
                  </Text>
                </CategoryHeader>

                {CHANNEL_KEYS.filter(
                  (chKey) =>
                    chKey !== "sms" ||
                    (smsEligibleCategories.includes(cat.key) &&
                      // With SMS unavailable the row stays only while it is
                      // on, so consent given earlier can be withdrawn before
                      // texts resume. Once off it is gone until SMS is back.
                      (smsAvailable || getEnabled("sms", cat.key))),
                )
                  .map((chKey) => {
                    const enabled = getEnabled(chKey, cat.key);
                    // Revoke-only: switch-off is the one move allowed while
                    // SMS is unavailable (same pattern as the volunteer
                    // text-reminder toggle in VolunteerSection).
                    const smsRevokeOnly = chKey === "sms" && !smsAvailable;
                    const chLabel = String(t(CHANNEL_LABEL_KEYS[chKey]));
                    const catLabel = String(t(cat.labelKey));
                    const toggleKey = `${chKey}:${cat.key}`;
                    // SMS toggles stay disabled until a verified phone number
                    // (captured with SMS consent) is on file (FR-011).
                    const smsLocked =
                      chKey === "sms" && !smsEligible && !smsRevokeOnly;
                    // The in-app copy of a transactional notification cannot be
                    // suppressed — the toggle is locked on.
                    const inAppLocked =
                      chKey === "in_app" && cat.key === "transactional";
                    return (
                      <ChannelRow key={chKey}>
                        <YStack gap="$1" flexShrink={1}>
                          <Text
                            variant="bodySmall"
                            tone={smsLocked ? "muted" : undefined}
                          >
                            {chLabel}
                          </Text>
                          {inAppLocked ? (
                            <Text variant="caption" tone="muted">
                              {String(t("account.sNotifCatTransactionalLocked"))}
                            </Text>
                          ) : null}
                        </YStack>
                        <Switch
                          size="small"
                          id={`notif-${cat.key}-${chKey}`}
                          checked={
                            inAppLocked ? true : smsLocked ? false : enabled
                          }
                          onCheckedChange={(next: boolean) => {
                            if (smsRevokeOnly && next) return;
                            handleToggle(chKey, cat.key, next);
                          }}
                          disabled={smsLocked || inAppLocked}
                          saving={!!saving[toggleKey]}
                          aria-label={
                            smsLocked
                              ? String(
                                  t("account.sNotifToggleAriaLocked", {
                                    channel: chLabel,
                                    category: catLabel,
                                    reason: String(
                                      t("account.sNotifSmsRequiresPhone"),
                                    ),
                                  }),
                                )
                              : inAppLocked
                                ? String(
                                    t("account.sNotifToggleAriaLocked", {
                                      channel: chLabel,
                                      category: catLabel,
                                      reason: String(
                                        t(
                                          "account.sNotifCatTransactionalLocked",
                                        ),
                                      ),
                                    }),
                                  )
                                : String(
                                    t("account.sNotifToggleAria", {
                                      channel: chLabel,
                                      category: catLabel,
                                    }),
                                  )
                          }
                        />
                      </ChannelRow>
                    );
                  })}
              </CategoryCard>
            );
          })}
        </YStack>
      )}

      <YStack borderBottomWidth={2} borderBottomColor="$borderColor" />

      <XStack alignItems="center" justifyContent="space-between">
        <Text variant="bodySmall" tone="muted">
          {String(t("account.sNotifHistoryLink"))}
        </Text>
        <Button
          variant="outlined"
          size="$2"
          onPress={() => router.push("/account/notifications")}
        >
          {String(t("account.sNotifHistoryBtn"))}
        </Button>
      </XStack>
    </SectionCard>
  );
}
