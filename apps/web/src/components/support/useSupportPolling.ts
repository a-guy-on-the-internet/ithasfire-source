"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { trpc } from "@/trpc";
import { useTabVisible } from "./useTabVisible";
import type { SupportMessageDto, SupportThreadDto } from "./types";

/** Fast poll while the panel is open and the tab is visible (FR-004). */
export const OPEN_INTERVAL_MS = 4_000;
/** Slow poll while collapsed — just enough to refresh the unread badge. */
export const COLLAPSED_INTERVAL_MS = 45_000;

/**
 * Pure decision for React Query's dynamic `refetchInterval` (exported for unit
 * tests). Returns `false` to STOP polling when:
 *  - the query has errored (a stale/foreign stored pointer would otherwise be
 *    polled forever — NFR-001), or
 *  - the tab is hidden (no warm instance for nothing).
 * Otherwise: fast while open, slow while collapsed.
 */
export function resolveRefetchInterval(args: {
  status: "pending" | "error" | "success";
  tabVisible: boolean;
  isOpen: boolean;
}): number | false {
  if (args.status === "error") {
    return false;
  }
  if (!args.tabVisible) {
    return false;
  }
  return args.isOpen ? OPEN_INTERVAL_MS : COLLAPSED_INTERVAL_MS;
}

/** Count of counterparty (non-USER) messages the user hasn't read yet. */
export function countUnread(messages: SupportMessageDto[]): number {
  return messages.reduce((count, message) => {
    const fromOperator = message.authorType !== "USER";
    return fromOperator && message.readAt === null ? count + 1 : count;
  }, 0);
}

/**
 * Merge an incremental delta into the accumulated message list, keyed by id and
 * sorted by createdAt ascending (exported for unit tests).
 *
 * - New ids are appended.
 * - An id that already exists is REPLACED, so updated fields (e.g. a freshly
 *   stamped `readAt`) propagate even though the incremental (`gt since`) poll
 *   would normally only return brand-new messages.
 *
 * Pure + immutable so it slots cleanly into React state updates.
 */
export function mergeMessages(
  current: SupportMessageDto[],
  delta: SupportMessageDto[],
): SupportMessageDto[] {
  if (delta.length === 0) {
    return current;
  }
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of delta) {
    byId.set(m.id, m);
  }
  return Array.from(byId.values()).sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/** The createdAt of the newest accumulated message, or undefined when empty. */
function newestCreatedAt(messages: SupportMessageDto[]): Date | undefined {
  let max: number | undefined;
  for (const m of messages) {
    const t = new Date(m.createdAt).getTime();
    if (max === undefined || t > max) {
      max = t;
    }
  }
  return max === undefined ? undefined : new Date(max);
}

export interface SupportPollingResult {
  messages: SupportMessageDto[];
  thread: SupportThreadDto | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  /** Count of agent/AI/system messages the user hasn't read yet. */
  unreadCount: number;
  /**
   * Optimistically stamp `readAt` on all accumulated counterparty (non-USER)
   * messages whose `readAt` is still null. Call this from the markThreadRead
   * success handler: the server stamps readAt on OLD messages (createdAt <
   * since) that an incremental (`gt since`) poll will NOT return, so without
   * this local update the accumulator would keep readAt null and unreadCount
   * would never reach 0 — the mark-read effect would loop forever.
   */
  markCounterpartyRead: (readAt: Date) => void;
}

export interface UseSupportPollingArgs {
  /** Active thread id to poll, or null when the user has no thread yet. */
  threadId: string | null;
  /** Whether the chat panel is currently expanded. */
  isOpen: boolean;
  /**
   * Invoked when the poll errors (e.g. the stored pointer is stale/foreign and
   * the backend throws forbidden/not_found). Lets the owner drop the bad
   * pointer so we stop polling a thread that will never load.
   */
  onError?: () => void;
}

/**
 * Open/visibility/collapsed-aware poll over `support.getMessages` (NFR-001).
 *
 * - open + tab visible  → fast poll (~4s)
 * - collapsed + visible → slow poll (~45s), badge only
 * - tab hidden          → no polling at all (interval false)
 * - no thread id        → query disabled (nothing to poll yet)
 *
 * We lean on React Query's dynamic `refetchInterval` rather than a hand-rolled
 * `setInterval`, matching how the rest of the app polls (e.g. notifications).
 */
export function useSupportPolling({
  threadId,
  isOpen,
  onError,
}: UseSupportPollingArgs): SupportPollingResult {
  const tabVisible = useTabVisible();

  // Incremental accumulator. The query fetches only the delta since our newest
  // seen message (`since` cursor); we merge each delta into this list so it
  // persists across the React Query key changes that `since` advancing causes.
  // Reset whenever the thread id changes so a new thread never inherits a stale
  // conversation.
  const [messages, setMessages] = useState<SupportMessageDto[]>([]);
  const threadIdRef = useRef<string | null>(threadId);
  if (threadIdRef.current !== threadId) {
    threadIdRef.current = threadId;
    // Synchronous reset during render keeps `since` correct on the very next
    // query input (no stale cursor from the previous thread).
    if (messages.length > 0) {
      setMessages([]);
    }
  }

  // `since` = createdAt of the newest accumulated message, or undefined on the
  // first load (full history). Advancing `since` changes the query key, but the
  // accumulator above survives because it lives in component state.
  const since = newestCreatedAt(messages);

  const query = trpc.support.getMessages.useQuery(
    { threadId: threadId ?? "", ...(since ? { since } : {}) },
    {
      enabled: Boolean(threadId),
      // A FUNCTION (not a static number) so a failing poll stops itself: once
      // the query is in the error state we return false and never tick again,
      // which is what keeps a stale/foreign stored pointer from being polled
      // forever (NFR-001 / scale-to-zero).
      refetchInterval: (q) =>
        resolveRefetchInterval({
          status: q.state.status,
          tabVisible,
          isOpen,
        }),
      // Don't poll in the background tab; resume cleanly on focus.
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 2_000,
      retry: false,
      // The widget surfaces its own inline error; suppress the global toast.
      meta: { silent: true },
    },
  );

  // Merge each successful fetch's delta into the accumulator. Keyed on the data
  // reference so we re-merge only when a new payload lands.
  const delta = query.data?.messages;
  useEffect(() => {
    if (!delta) {
      return;
    }
    setMessages((current) => mergeMessages(current, delta));
  }, [delta]);

  const thread = query.data?.thread ?? null;

  // Notify the owner exactly once per error transition so it can clear a bad
  // pointer (and fall back to the empty/composer state) without us spamming the
  // callback on every render.
  const erroredRef = useRef(false);
  useEffect(() => {
    if (query.isError && !erroredRef.current) {
      erroredRef.current = true;
      onError?.();
    } else if (!query.isError) {
      erroredRef.current = false;
    }
  }, [query.isError, onError]);

  const unreadCount = useMemo(() => countUnread(messages), [messages]);

  // Optimistically clear the unread badge after markThreadRead succeeds. The
  // server stamps readAt on OLD messages the incremental poll won't re-fetch,
  // so we mirror that locally — otherwise unreadCount would stay > 0 and the
  // mark-read effect would loop. Idempotent: a second call is a no-op once
  // every counterparty message already has a readAt.
  const markCounterpartyRead = useCallback((readAt: Date) => {
    setMessages((current) => {
      let changed = false;
      const next = current.map((m) => {
        if (m.authorType !== "USER" && m.readAt === null) {
          changed = true;
          return { ...m, readAt };
        }
        return m;
      });
      return changed ? next : current;
    });
  }, []);

  return {
    messages,
    thread,
    // Loading only on the very first paint (no accumulated history yet) so a
    // background incremental poll never flips the view back to a spinner.
    isLoading: query.isLoading && Boolean(threadId) && messages.length === 0,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
    unreadCount,
    markCounterpartyRead,
  };
}
