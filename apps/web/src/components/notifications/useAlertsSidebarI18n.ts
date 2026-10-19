"use client";

import { useCallback, useMemo } from "react";
import {
  useLocale,
  useTranslations,
  type AlertsSidebarLabels,
  type NotificationInboxLabels,
  type NotificationItemLabels,
} from "@th/ui";

/**
 * The bell and panel words every web host passes to `AlertsSidebar`, in the
 * user's language. The sidebar's own fallbacks are English, so a host that
 * skipped this would read "Open notifications, 3 unread" to a Spanish user.
 * Both values are memoised on the translator: the sidebar is `memo`ised, and
 * fresh identities would re-render it on every host render.
 */
export function useAlertsSidebarI18n(): {
  formatButtonLabel: (count: number) => string;
  labels: AlertsSidebarLabels;
} {
  const t = useTranslations();
  const formatButtonLabel = useCallback(
    (count: number) => String(t("common.openNotificationsCount", { count })),
    [t],
  );
  const labels = useMemo(
    () => ({
      heading: String(t("account.notificationsTitle")),
      close: String(t("common.close")),
      closeAriaLabel: String(t("common.closeNotifications")),
      viewTabs: String(t("common.notificationViews")),
      inboxTab: String(t("common.notificationsInboxTab")),
      activityTab: String(t("common.notificationsActivityTab")),
      emptyTitle: String(t("common.notificationsActivityEmptyTitle")),
      emptyBody: String(t("common.notificationsActivityEmptyBody")),
      clearAll: String(t("common.notificationsClearAll")),
      alertDismiss: String(t("common.notificationAlertDismiss")),
      alertDraggable: String(t("common.notificationAlertDraggable")),
      alertDropToBottom: String(t("common.notificationAlertDropToBottom")),
    }),
    [t],
  );
  return { formatButtonLabel, labels };
}

/**
 * The inbox's words, its rows' words, and the locale for their relative
 * timestamps. Called by `NotificationInboxContainer` itself, so the inbox is
 * translated both inside the bell panel and on `/account/notifications`,
 * where there is no sidebar to hand anything down. Memoised for the same
 * reason as above: the inbox and every row are `memo`ised.
 */
export function useNotificationInboxI18n(): {
  labels: NotificationInboxLabels;
  itemLabels: NotificationItemLabels;
  locale: string | undefined;
} {
  const t = useTranslations();
  const appLocale = useLocale();
  // English keeps the package's hand-rolled "just now" / "6d ago" (ruled
  // 2026-10-02): Intl would say "now" / "yesterday" and vary by ICU build.
  // Only non-English locales go through Intl.RelativeTimeFormat.
  const locale = /^en\b/i.test(appLocale) ? undefined : appLocale;
  const labels = useMemo(
    () => ({
      tabs: String(t("common.notificationsFilterTabs")),
      unread: String(t("common.notificationsUnreadTab")),
      all: String(t("common.notificationsAllTab")),
      markAllRead: String(t("common.notificationsMarkAllRead")),
      emptyUnreadTitle: String(t("common.notificationsEmptyUnreadTitle")),
      emptyUnreadBody: String(t("common.notificationsEmptyUnreadBody")),
      emptyAllTitle: String(t("common.notificationsEmptyAllTitle")),
      emptyAllBody: String(t("common.notificationsEmptyAllBody")),
      loadMore: String(t("common.notificationsLoadMore")),
      loadingMore: String(t("common.loading")),
    }),
    [t],
  );
  const itemLabels = useMemo(
    () => ({
      showMore: String(t("common.notificationShowMore")),
      showLess: String(t("common.notificationShowLess")),
      showMoreNamed: (subject: string) =>
        String(t("common.notificationShowMoreNamed", { subject })),
      showLessNamed: (subject: string) =>
        String(t("common.notificationShowLessNamed", { subject })),
      dismissNamed: (subject: string) =>
        String(t("common.notificationDismissNamed", { subject })),
      genericSubject: String(t("common.notificationGenericSubject")),
    }),
    [t],
  );
  return { labels, itemLabels, locale };
}
