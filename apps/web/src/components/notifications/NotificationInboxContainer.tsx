"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import {
  NotificationInbox,
  truncateNotificationSubject,
  useAlertsSidebarClose,
  useLocale,
  useTranslations,
  type InboxTab,
  type NotificationItemData,
} from "@th/ui";
import { guardedNavigate } from "@/hooks/navigation-guard";
import { trpc } from "@/trpc";
import { toNotificationItemAction } from "./notification-action";
import { useNotificationInboxI18n } from "./useAlertsSidebarI18n";

/**
 * Screen-reader-only box for the dismiss-announcement live region. Same
 * recipe as `BulkActionBar`'s (`apps/web/src/components/AdminTableParts.tsx`)
 * — no shared `.sr-only` class exists on every route, so this is inlined.
 */
const visuallyHiddenStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Both lookups below search THIS inbox only. Two can be mounted at once —
 * `/account/notifications` renders one in the page and the navbar bell's panel
 * portals another to the end of <body> — and a document-wide search found the
 * page's rows first, moving focus behind the panel's `aria-modal` dialog.
 */

/** The row that replaces the dismissed one, if any is still rendered. */
function findRowFirstControl(
  root: HTMLElement,
  id: string,
): HTMLElement | null {
  const row = root.querySelector<HTMLElement>(
    `[data-notification-id="${CSS.escape(id)}"]`,
  );
  return row?.querySelector<HTMLElement>("a[href], button") ?? null;
}

/** Fallback when the dismissed row had no neighbour left to focus — the Close
 * button of the panel this inbox sits in (none on the full inbox page, where
 * there is nothing to fall back to and focus is left to drop). */
function findSidebarCloseButton(root: HTMLElement): HTMLElement | null {
  return (
    root
      .closest('[role="dialog"]')
      ?.querySelector<HTMLElement>("[data-th-sidebar-close]") ?? null
  );
}

/** True when nothing holds focus — what the browser leaves behind when the
 * focused row unmounts. Anything else means the user has moved on. */
function focusWasDropped(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * Smart container that connects the `NotificationInbox` presentational
 * component to tRPC queries & mutations.
 *
 * Render this as the `renderInbox` prop of `AlertsSidebar`.
 */
export function NotificationInboxContainer() {
  const router = useRouter();
  const t = useTranslations();
  const inboxI18n = useNotificationInboxI18n();
  // The server re-renders each row's text in this language where it has the
  // copy. Part of the query key, so switching language refetches.
  const appLocale = useLocale();
  const utils = trpc.useUtils();
  // Set when this inbox is inside the bell panel; null on the full page.
  const closeSidebar = useAlertsSidebarClose();
  const [activeTab, setActiveTab] = useState<InboxTab>("unread");

  // Focus-after-dismiss (see handleDismiss below) and its live-region
  // announcement. A dismiss marks the row read, which invalidates
  // `notifications.list`; when the row then leaves the unread result set and
  // unmounts, the browser drops `document.activeElement` to <body> with no
  // announcement, and the next Tab restarts the user at the panel's Close
  // button, losing their position in the list.
  //
  // Armed ONLY by a dismiss on the Unread tab, the one place the row leaves
  // the list. On All a read row stays put, so an armed ref would sit there
  // until some unrelated list change (switching tabs, a poll) fired the effect
  // and pulled focus off whatever the user had moved to. Cleared on a tab
  // change and when the mark-read fails, for the same reason.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingDismissRef = useRef<{
    dismissedId: string;
    nextFocusId: string | null;
  } | null>(null);
  const [dismissAnnouncement, setDismissAnnouncement] = useState("");

  // ── Queries ─────────────────────────────────────────────────────────
  const isUnreadFilter = activeTab === "unread" ? false : undefined;

  // Poll while the inbox is open so new notifications appear without a live
  // push (the SSE subscription is not wired to Redis).
  const listQuery = trpc.notifications.list.useInfiniteQuery(
    { read: isUnreadFilter, limit: 25, locale: appLocale },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      initialCursor: undefined as Date | undefined,
      staleTime: 30_000,
      refetchInterval: 30_000,
    },
  );

  const countQuery = trpc.notifications.countUnread.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  // ── Mutations ───────────────────────────────────────────────────────
  const markReadMutation = trpc.notifications.markRead.useMutation({
    onSuccess: () => {
      void utils.notifications.countUnread.invalidate();
      void utils.notifications.list.invalidate();
    },
    // The dismissed row will not leave, so there is no focus to hand on.
    // Only when THIS failure is for the armed row: a failed mark-read of some
    // other row (a row press, an earlier dismiss) must not disarm it.
    onError: (_err, vars) => {
      const pending = pendingDismissRef.current;
      if (pending && vars.ids.includes(pending.dismissedId)) {
        pendingDismissRef.current = null;
      }
    },
  });

  const markAllReadMutation = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => {
      void utils.notifications.countUnread.invalidate();
      void utils.notifications.list.invalidate();
    },
  });

  // ── Derived data ────────────────────────────────────────────────────
  const notifications: NotificationItemData[] =
    listQuery.data?.pages.flatMap((page) =>
      page.items.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        kind: item.kind as NotificationItemData["kind"],
        readAt: item.readAt ? new Date(item.readAt) : null,
        // Promotes a route-only action to a usable href (and drops known-dead
        // routes) — see `notification-action.ts`.
        action: toNotificationItemAction(item.action),
        createdAt: new Date(item.createdAt),
      })),
    ) ?? [];

  const unreadCount = countQuery.data?.count ?? 0;

  // ── Handlers ────────────────────────────────────────────────────────
  const handleMarkRead = useCallback(
    (id: string) => {
      markReadMutation.mutate({ ids: [id] });
    },
    [markReadMutation],
  );

  const handleMarkAllRead = useCallback(() => {
    markAllReadMutation.mutate();
  }, [markAllReadMutation]);

  const handleDismiss = useCallback(
    (id: string) => {
      // On All, dismiss = mark read and the row stays where it is, focus
      // included. Nothing to hand on, nothing to announce.
      if (activeTab !== "unread") {
        pendingDismissRef.current = null;
        markReadMutation.mutate({ ids: [id] });
        return;
      }
      const index = notifications.findIndex((n) => n.id === id);
      const dismissed = index === -1 ? undefined : notifications[index];
      // Next row takes the focus; dismissing the last row falls back to the
      // previous one. Resolved now, against the list as it looks before the
      // mutation's invalidate reshuffles it — the id is looked up again once
      // the row actually unmounts (see the effect below), so a refetch that
      // also removes the candidate (e.g. it got marked read elsewhere) just
      // falls through to the sidebar Close button instead of focusing stale.
      const next =
        index === -1
          ? null
          : (notifications[index + 1] ?? notifications[index - 1] ?? null);
      pendingDismissRef.current = {
        dismissedId: id,
        nextFocusId: next?.id ?? null,
      };
      // Cut the same way the row's own "Dismiss: …" name is, so a long body
      // is not read out in full. A blank subject would come back as the
      // helper's English placeholder, so it gets the no-subject sentence.
      const rawSubject = dismissed ? (dismissed.title ?? dismissed.body) : "";
      setDismissAnnouncement(
        String(
          rawSubject.trim()
            ? t("common.notificationDismissedNamed", {
                subject: truncateNotificationSubject(rawSubject),
              })
            : t("common.notificationDismissed"),
        ),
      );
      markReadMutation.mutate({ ids: [id] });
    },
    [activeTab, notifications, markReadMutation, t],
  );

  // Runs after every list update, including the one that follows a dismiss's
  // invalidate + refetch — however long that takes. Resolves once the
  // dismissed row is actually gone from `notifications` (not optimistically,
  // since this list is query-driven); by the time this effect runs, React
  // has already committed that removal to the DOM, so the query below sees
  // the post-removal tree.
  useEffect(() => {
    const pending = pendingDismissRef.current;
    if (!pending) return;
    const stillPresent = notifications.some(
      (n) => n.id === pending.dismissedId,
    );
    if (stillPresent) return;
    pendingDismissRef.current = null;
    // Only pick focus up if it actually fell with the row. If the user has
    // since put it somewhere (another row, a tab, the bell after Escape),
    // that is where it stays.
    const root = rootRef.current;
    if (!root || !focusWasDropped()) return;
    const target =
      (pending.nextFocusId && findRowFirstControl(root, pending.nextFocusId)) ||
      findSidebarCloseButton(root);
    target?.focus();
  }, [notifications]);

  // Row click and the row's link (click or Enter) both land here, so the panel
  // closes the same way for mouse and keyboard. Modifier/middle-clicks open a
  // new tab without calling this, and leave the panel where it is.
  const handleAction = useCallback(
    (href: string) => {
      closeSidebar?.();
      // Through the open page's unsaved-changes guard, if any: a row press
      // is not a link click, so the guard would not otherwise see it.
      guardedNavigate(() => router.push(href));
    },
    [closeSidebar, router],
  );

  const handleLoadMore = useCallback(() => {
    void listQuery.fetchNextPage();
  }, [listQuery]);

  const handleTabChange = useCallback(
    (tab: InboxTab) => {
      pendingDismissRef.current = null;
      setActiveTab(tab);
      // Reset pagination when switching tabs
      void utils.notifications.list.invalidate();
    },
    [utils],
  );

  return (
    // `display: contents`: a root to scope the focus lookups to, without a
    // box of its own, so the inbox still sits directly in the panel's (and
    // the page's) flex column.
    <div ref={rootRef} style={{ display: "contents" }}>
      {/* Persistent (never unmounts with a dismiss) so the announcement
          survives the row it describes being removed. */}
      <span aria-live="polite" style={visuallyHiddenStyle}>
        {dismissAnnouncement}
      </span>
      <NotificationInbox
        notifications={notifications}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        unreadCount={unreadCount}
        onMarkRead={handleMarkRead}
        onMarkAllRead={handleMarkAllRead}
        onAction={handleAction}
        onDismiss={handleDismiss}
        hasMore={listQuery.hasNextPage ?? false}
        onLoadMore={handleLoadMore}
        isLoading={listQuery.isLoading}
        isLoadingMore={listQuery.isFetchingNextPage}
        labels={inboxI18n.labels}
        itemLabels={inboxI18n.itemLabels}
        locale={inboxI18n.locale}
      />
    </div>
  );
}
