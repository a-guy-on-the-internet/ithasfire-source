"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { YStack, XStack, AnimatePresence, useTheme } from "tamagui";
import {
  Text,
  Button,
  Spinner,
  CharCountTextarea,
  useTranslations,
} from "@th/ui";
import { Send, ChevronDown, UserRound, MessageCircle } from "lucide-react";

import { trpc } from "@/trpc";
import { useSupportOpener } from "@/components/navigation/page-primary-action";
import { useIsCompactViewport } from "@/hooks/useIsCompactViewport";
import { ACCENT } from "@/lib/design-tokens";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SupportThreadView } from "./SupportThreadView";
import { useSupportPolling } from "./useSupportPolling";
import { useSupportRouteContext } from "./support-context";
import {
  getStoredThreadId,
  setStoredThreadId,
  clearStoredThreadId,
} from "./support-thread-store";
import { SUPPORT_MESSAGE_MAX } from "./constants";
import { isUnderPath } from "@/middleware/path-match";
import { FALLBACK_SUPPORT_EMAIL } from "@/lib/support-email";

// Routes that own a full-bleed / chrome-free experience — the floating widget
// would collide with them, so suppress it there (mirrors AppChrome bypass).
const HIDDEN_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/login",
  "/auth",
  "/embed",
  "/access-denied",
  "/qr-test",
  // The real checkout route (`events/checkout/[...slug]`). Segment-exact: an
  // event slug may contain "checkout" (`/events/checkout-night`). Resale
  // (`/events/resale/*`) was never hidden and stays shown.
  "/events/checkout",
  // Staff areas have their own chrome + the operator inbox lives here; the
  // consumer help bubble would be redundant/confusing for operators.
  "/platform",
  "/admin",
];

/**
 * Whether the support chat's launcher is mounted on this route. Callers that
 * point at the chat ("prefer to chat?") must gate on this so they never point
 * at a bubble that isn't there.
 */
export function useSupportChatAvailable(): boolean {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && !shouldHide(pathname);
}

export function shouldHide(pathname: string | null): boolean {
  if (!pathname) return false;
  return HIDDEN_PREFIXES.some((p) => isUnderPath(pathname, p));
}

// How long the composer's send button stays disabled after a rate-limit hit,
// before we auto-re-enable so the user can retry without reloading.
const RATE_LIMIT_COOLDOWN_MS = 5_000;

// Narrow an unknown thrown value to the tRPC client error shape we care about.
// tRPC surfaces the HTTP-equivalent code at `err.data.code` (repo convention),
// so a burst/sustained limit breach arrives as "TOO_MANY_REQUESTS".
function isRateLimitError(err: unknown): boolean {
  const code = (err as { data?: { code?: string } } | null)?.data?.code;
  return code === "TOO_MANY_REQUESTS";
}

export function SupportWidget() {
  const t = useTranslations();
  const theme = useTheme();
  const pathname = usePathname();
  const routeContext = useSupportRouteContext();

  const isMobile = useIsMobile();
  // Complementary to the consumer bottom bar (same 960 boundary): below it the
  // Support TAB is the entry point, above it the bubble is. Never both.
  const isCompactViewport = useIsCompactViewport();

  const sessionQuery = authClient.useSession();
  const user = sessionQuery.data?.user ?? null;
  const isSignedIn = Boolean(user);
  const accountKey = user?.id ?? null;

  // Client-only mount gate. The server and the first client render must produce
  // identical output, but `authClient.useSession()` reports `isPending` on the
  // server (→ render null) while the client often has a cached/resolved session
  // on its first render (→ render the launcher). That presence/absence diff is a
  // hydration mismatch that makes React regenerate this whole subtree on the
  // client, tearing down sibling effects (e.g. the Contextual Action Bar's
  // registered data/actions in GlobalOverlays). Rendering null until after mount
  // keeps SSR and the first client render in lockstep. (suppressHydrationWarning
  // can't help — it only covers attribute/text diffs, not a missing element.)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [isOpen, setIsOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingBody, setPendingBody] = useState<string | null>(null);
  const [sendError, setSendError] = useState(false);
  // Distinct from sendError: a soft, self-clearing "slow down" state used only
  // for TOO_MANY_REQUESTS so we can show a calm notice + a brief cooldown.
  const [rateLimited, setRateLimited] = useState(false);

  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // The element that had focus when the panel opened (the launcher bubble on
  // desktop, the bottom nav's Support tab on mobile). Captured on open so we can
  // restore focus to the exact opener on close (WCAG 2.4.3) instead of guessing
  // by query — which can drop focus to <body> if neither selector is connected
  // at the rAF tick. The query chain stays as a fallback for the edge case
  // where the captured opener is gone (e.g. a viewport switch unmounted it).
  const openerRef = useRef<HTMLElement | null>(null);

  // Client-side support email (public footer defaults). Falls back to the
  // same address used by the /support hub + transactional emails.
  const footerDefaults = trpc.platform.getFooterDefaults.useQuery(undefined, {
    staleTime: 10 * 60_000,
    meta: { silent: true },
  });
  const supportEmail =
    footerDefaults.data?.contactEmail?.trim() || FALLBACK_SUPPORT_EMAIL;

  // Authoritative thread discovery (BLOCKING #1 root fix): ask the backend for
  // the caller's current active (OPEN/AWAITING_HUMAN) thread instead of trusting
  // localStorage. localStorage is now only a fast-path cache that paints the
  // badge instantly on reload; getMyActiveThread validates/overwrites it (and we
  // clear it on a 403/404). This eliminates the stale/foreign-pointer class.
  const activeThreadQuery = trpc.support.getMyActiveThread.useQuery(
    {},
    {
      enabled: isSignedIn,
      staleTime: 30_000,
      meta: { silent: true },
    },
  );

  // Optimistic fast-path: paint the cached pointer immediately on sign-in so the
  // badge/poll can start before getMyActiveThread resolves.
  useEffect(() => {
    if (!accountKey) {
      setThreadId(null);
      return;
    }
    setThreadId(getStoredThreadId(accountKey));
  }, [accountKey]);

  // Reconcile against the authoritative result once it lands: overwrite the
  // cache with the real thread id, or clear both state + cache when there is no
  // active thread (drops a stale/foreign pointer).
  useEffect(() => {
    if (!accountKey || !activeThreadQuery.isSuccess) {
      return;
    }
    const authoritative = activeThreadQuery.data.thread?.id ?? null;
    if (authoritative) {
      setThreadId(authoritative);
      setStoredThreadId(accountKey, authoritative);
    } else {
      setThreadId(null);
      clearStoredThreadId(accountKey);
    }
  }, [
    accountKey,
    activeThreadQuery.isSuccess,
    activeThreadQuery.data?.thread?.id,
  ]);

  // If the poll errors (stale/foreign pointer → forbidden/not_found), drop the
  // bad pointer and fall back to the empty/composer state. Combined with the
  // hook's error-aware refetchInterval, this stops the forever-poll.
  const handlePollError = useCallback(() => {
    clearStoredThreadId(accountKey);
    setThreadId(null);
  }, [accountKey]);

  const {
    messages,
    thread,
    isLoading,
    isError,
    refetch,
    unreadCount,
    markCounterpartyRead,
  } = useSupportPolling({ threadId, isOpen, onError: handlePollError });

  const sendMessage = trpc.support.sendMessage.useMutation();
  const escalate = trpc.support.setThreadStatus.useMutation();
  const markRead = trpc.support.markThreadRead.useMutation();

  // Mark the visible counterparty messages read whenever the panel is open and
  // the tab is foregrounded with something unread (BLOCKING #2 → FR-001). Fired
  // on open and when unreadCount transitions from 0 → >0 while open; the ref
  // guard keeps us from re-firing every render for the same unread batch.
  //
  // After the server stamps readAt we DON'T invalidate getMessages: the poll is
  // now incremental (`gt since`), so a refetch would never return the just-read
  // OLD messages and the badge would never clear — an infinite mark-read loop.
  // Instead we optimistically stamp readAt locally via markCounterpartyRead,
  // which drops unreadCount to 0 and breaks the loop after a single mark-read.
  const markReadInFlightRef = useRef(false);
  useEffect(() => {
    if (
      !isOpen ||
      !threadId ||
      unreadCount === 0 ||
      markReadInFlightRef.current
    ) {
      return;
    }
    markReadInFlightRef.current = true;
    markRead
      .mutateAsync({ threadId })
      .then(() => {
        markCounterpartyRead(new Date());
      })
      .catch(() => {
        // Best-effort; the badge just stays until the next attempt.
      })
      .finally(() => {
        markReadInFlightRef.current = false;
      });
  }, [isOpen, threadId, unreadCount, markRead, markCounterpartyRead]);

  const persistThread = useCallback(
    (newThreadId: string) => {
      setThreadId(newThreadId);
      setStoredThreadId(accountKey, newThreadId);
    },
    [accountKey],
  );

  const handleSend = useCallback(async () => {
    const body = draft.trim();
    if (!body || sendMessage.isPending) {
      return;
    }
    setSendError(false);
    setRateLimited(false);
    setPendingBody(body);
    setDraft("");
    try {
      const result = await sendMessage.mutateAsync({
        body,
        ...(routeContext.eventId ? { eventId: routeContext.eventId } : {}),
        ...(routeContext.orderId ? { orderId: routeContext.orderId } : {}),
      });
      persistThread(result.thread.id);
      refetch();
    } catch (err) {
      // Restore the draft so the user can retry without retyping.
      setDraft(body);
      // A rate-limit breach gets the soft "slow down" treatment (calm notice +
      // cooldown); anything else falls back to the generic send failure.
      if (isRateLimitError(err)) {
        setRateLimited(true);
      } else {
        setSendError(true);
      }
    } finally {
      setPendingBody(null);
    }
  }, [draft, sendMessage, routeContext, persistThread, refetch]);

  // Clear the rate-limit notice as soon as the user edits the draft, so it does
  // not linger while they retype.
  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    setRateLimited(false);
  }, []);

  // Auto-re-enable after a short cooldown when rate-limited. Keyed on the flag
  // so each breach restarts the timer; cleanup prevents a stale timer from
  // clearing a fresh limit state.
  useEffect(() => {
    if (!rateLimited) {
      return;
    }
    const timer = setTimeout(
      () => setRateLimited(false),
      RATE_LIMIT_COOLDOWN_MS,
    );
    return () => clearTimeout(timer);
  }, [rateLimited]);

  const handleEscalate = useCallback(async () => {
    if (!threadId || escalate.isPending) {
      return;
    }
    try {
      await escalate.mutateAsync({ threadId, status: "AWAITING_HUMAN" });
      refetch();
    } catch {
      // Best-effort; the operator still sees the thread in the inbox.
    }
  }, [threadId, escalate, refetch]);

  const openPanel = useCallback(() => {
    // Capture the opener (launcher bubble on desktop, bottom-nav Support tab
    // on mobile) before the panel mounts so close can restore focus to the exact
    // element the user activated (WCAG 2.4.3).
    openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    setIsOpen(true);
    setSendError(false);
    setRateLimited(false);
  }, []);

  // Published for the consumer mobile bottom bar's Support tab (user decision
  // 2026-08-28): on phones the chat is a bar DESTINATION, not a floating
  // bubble. Registering unconditionally keeps viewport switches reactive; the
  // early return below means this component is not mounted at all on the
  // routes that suppress it, so the tab is inert there.
  useSupportOpener(openPanel);

  const closePanel = useCallback(() => {
    setIsOpen(false);
    // Return focus to whichever control opened the panel so keyboard/SR users
    // don't lose their place (WCAG 2.4.3). Prefer the captured opener when it's
    // still in the document; if it's gone (e.g. a viewport switch unmounted the
    // launcher bubble), fall back to querying the live openers — the desktop
    // launcher first, then the mobile bottom nav's Support tab.
    requestAnimationFrame(() => {
      const opener = openerRef.current;
      const target = opener?.isConnected
        ? opener
        : (document.querySelector<HTMLElement>(
            '[data-testid="support-launcher"]',
          ) ??
          document.querySelector<HTMLElement>(
            '[data-testid="cab-overflow-trigger"]',
          ));
      target?.focus();
    });
  }, []);

  // Close on Escape while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closePanel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, closePanel]);

  // Move focus into the panel when it opens.
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => panelRef.current?.focus());
    }
  }, [isOpen]);

  // ONE entry point at every width: the floating launcher bubble below. It
  // used to be desktop-only because it overlapped the full-width action-bar
  // dock on phones, with the mobile entry living in that bar's "…" menu —
  // both the bar and that arrangement were removed 2026-08-27.

  // iOS Safari does not shrink the layout viewport for the on-screen keyboard
  // (Android's `interactiveWidget` does). Track the visual viewport height so
  // the open mobile panel can cap its height to the un-occluded area and ride
  // above the keyboard instead of being covered by it. SSR-safe.
  const [vvHeight, setVvHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!isOpen || !isMobile) {
      setVvHeight(null);
      return;
    }
    if (typeof window === "undefined" || !window.visualViewport) {
      return;
    }
    const vv = window.visualViewport;
    const sync = () => setVvHeight(vv.height);
    sync();
    vv.addEventListener("resize", sync);
    return () => vv.removeEventListener("resize", sync);
  }, [isOpen, isMobile]);

  if (!mounted || shouldHide(pathname) || sessionQuery.isPending) {
    return null;
  }

  const isResolved = thread?.status === "RESOLVED";
  const canEscalate = Boolean(threadId) && thread?.status === "OPEN";

  // Honour prefers-reduced-motion: skip the expand/compress transform so
  // motion-sensitive users get an instant reveal (mirrors Reveal.tsx). When
  // reduced, we drop the `animation` prop and the enter/exit transforms so
  // Tamagui mounts/unmounts the panel without a transition.
  const motionOk =
    typeof window !== "undefined" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  // Enter/exit transforms: desktop "grows" out of the bottom-right corner
  // (scale + opacity + a small offset toward the corner) near where the
  // dock sits; mobile slides up from the bottom edge like the shared BottomSheet.
  const panelAnimation = motionOk ? "base" : undefined;
  const hiddenStyle = !motionOk
    ? undefined
    : isMobile
      ? { opacity: 0, y: 24 }
      : { opacity: 0, scale: 0.85, x: 12, y: 12 };

  // Fold the unread count into the launcher's accessible name so a screen
  // reader announces it on focus, rather than via a live region on the dot
  // (which would re-announce on every count change while collapsed). The dot
  // itself is purely visual (aria-hidden) below.
  const launcherLabel =
    unreadCount > 0
      ? `${String(t("supportChat.openLabel"))} — ${String(
          t("supportChat.unreadLabel", { count: unreadCount }),
        )}`
      : String(t("supportChat.openLabel"));

  return (
    <>
      {/* Desktop-only floating launcher bubble.
          On mobile the entry point is the bottom nav's Support tab instead —
          a fixed bubble fights a fixed bar for the same corner.
          Hidden while the panel is open so the two don't overlap; the panel
          grows from this same bottom-right corner. */}
      {!isCompactViewport && !isOpen && (
        <button
          type="button"
          onClick={openPanel}
          aria-label={launcherLabel}
          data-testid="support-launcher"
          style={{
            position: "fixed",
            right: 20,
            // Sit above the iOS home indicator / dynamic browser chrome instead
            // of behind it. Additive so the 20px resting gap is preserved above
            // the inset (0 where there's no inset). This launcher renders at
            // ≥600px (desktop/tablet + landscape phones), exactly the widths
            // where a bottom inset appears, so the guard matters here.
            bottom: "calc(20px + env(safe-area-inset-bottom))",
            // Below the panel's 1100 so the panel always wins if they ever
            // co-exist for a frame during the open transition.
            zIndex: 1090,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 56,
            height: 56,
            borderRadius: 999,
            border: "none",
            background: ACCENT,
            color: "#FFFFFF",
            cursor: "pointer",
            // Mirror the panel's soft shadow language (rgba(0,0,0,0.35)).
            boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
            // Snappy chrome transition (soft-chrome rule); CSS-only so it's
            // inert under prefers-reduced-motion needs no JS gating here.
            transition: "transform 150ms ease-out, box-shadow 150ms ease-out",
          }}
          onMouseEnter={(e) => {
            if (!motionOk) return;
            const el = e.currentTarget;
            el.style.transform = "scale(1.05)";
            el.style.boxShadow = "0 8px 26px rgba(0,0,0,0.4)";
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget;
            el.style.transform = "scale(1)";
            el.style.boxShadow = "0 6px 20px rgba(0,0,0,0.35)";
          }}
        >
          <MessageCircle size={24} aria-hidden />
          {unreadCount > 0 && (
            // Small filled accent dot pinned top-right, matching the
            // overflow unread indicator's visual language. Purely visual: the
            // unread state is announced via the button's accessible name (see
            // `launcherLabel`), so the dot is aria-hidden to avoid a noisy live
            // region that re-announces on every count change while collapsed.
            <span
              aria-hidden
              data-testid="support-launcher-unread"
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                width: 12,
                height: 12,
                borderRadius: 999,
                background: ACCENT,
                // Ring against the (also-accent) button so the dot stays
                // legible; mirrors the overflow dot's navy ring approach.
                border: "2px solid #FFFFFF",
                pointerEvents: "none",
              }}
            />
          )}
        </button>
      )}

      {/* Expanded panel.
          Fixed bottom-right on desktop; full-width bottom sheet on mobile so it
          never overflows the narrow viewport (recent mobile-overflow history).
          The keyed, animated YStack is the DIRECT child of <AnimatePresence> so
          its exitStyle is honoured and the EXIT (compress/slide-down) animation
          plays before the tree unmounts — a nested animated node would be
          invisible to AnimatePresence and unmount instantly. Fixed positioning
          + the dialog semantics (role/ref/labels) live on this same element;
          `position: "fixed"` is supplied via the DOM `style` prop, which the web
          Stack types as CSSProperties (so "fixed" is allowed there). */}
      <AnimatePresence>
        {isOpen && (
          <YStack
            key="support-widget-panel-surface"
            ref={panelRef}
            role="dialog"
            aria-modal={false}
            aria-label={String(t("supportChat.title"))}
            id={panelId}
            tabIndex={-1}
            data-testid="support-widget-panel"
            animation={panelAnimation}
            opacity={1}
            scale={1}
            x={0}
            y={0}
            enterStyle={hiddenStyle}
            exitStyle={hiddenStyle}
            // Grow from the bubble corner on desktop; on mobile the slide-up
            // reads naturally from the bottom edge so origin stays default.
            transformOrigin={isMobile ? "center bottom" : "right bottom"}
            minHeight={0}
            backgroundColor="$surface"
            shadowColor="rgba(0,0,0,0.35)"
            shadowRadius={40}
            shadowOffset={{ width: 0, height: 10 }}
            borderColor="$borderColor"
            borderWidth={isMobile ? 0 : 2}
            borderTopWidth={2}
            style={{
              position: "fixed",
              zIndex: 1100,
              display: "flex",
              flexDirection: "column",
              outline: "none",
              ...(isMobile
                ? {
                    left: 0,
                    right: 0,
                    bottom: 0,
                    width: "100%",
                    height: "85dvh",
                    // Cap to the visual viewport when the iOS keyboard is open so
                    // the composer stays above it. `vvHeight` is null until a
                    // resize is observed, falling back to the dvh-based cap.
                    maxHeight: vvHeight != null ? `${vvHeight}px` : "85dvh",
                  }
                : {
                    right: 16,
                    bottom: 16,
                    width: 380,
                    height: 560,
                    maxHeight: "calc(100dvh - 32px)",
                  }),
            }}
          >
            {/* Header */}
            <XStack
              alignItems="center"
              justifyContent="space-between"
              paddingHorizontal="$3"
              paddingVertical="$3"
              borderBottomWidth={2}
              borderBottomColor="$borderColor"
              backgroundColor="$surfaceMuted"
            >
              <YStack flex={1} paddingRight="$2">
                <Text variant="label" weight="bold">
                  {String(t("supportChat.title"))}
                </Text>
                <Text variant="caption" tone="muted" truncate>
                  {String(t("supportChat.subtitle"))}
                </Text>
              </YStack>
              <button
                type="button"
                onClick={closePanel}
                aria-label={String(t("supportChat.minimizeLabel"))}
                data-testid="support-widget-close"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 36,
                  minWidth: 44,
                  minHeight: 44,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: theme.color?.val ?? "#FFFFFF",
                }}
              >
                <ChevronDown size={20} aria-hidden />
              </button>
            </XStack>

            {!isSignedIn ? (
              <SignInGate supportEmail={supportEmail} redirectTo={pathname} />
            ) : (
              <>
                <SupportThreadView
                  messages={messages}
                  isLoading={isLoading}
                  isError={isError}
                  onRetry={refetch}
                  perspective="user"
                  pendingBody={pendingBody}
                />

                {/* Composer */}
                <YStack
                  borderTopWidth={2}
                  borderTopColor="$borderColor"
                  padding="$3"
                  gap="$2"
                  backgroundColor="$surface"
                  // Clear the iOS home-indicator / Android gesture bar on mobile
                  // so Send + "talk to a person" aren't tucked under the bar.
                  style={
                    isMobile
                      ? {
                          paddingBottom:
                            "max(12px, env(safe-area-inset-bottom))",
                        }
                      : undefined
                  }
                >
                  {isResolved && (
                    <Text variant="caption" tone="muted">
                      {String(t("supportChat.resolvedNotice"))}
                    </Text>
                  )}
                  {thread?.status === "AWAITING_HUMAN" && (
                    <Text variant="caption" tone="muted">
                      {String(t("supportChat.escalated"))}
                    </Text>
                  )}
                  {sendError && (
                    <Text variant="caption" tone="error">
                      {String(t("supportChat.sendError"))}
                    </Text>
                  )}
                  {rateLimited && (
                    // Soft, muted notice (not an error) — the send still works,
                    // we're just asking the user to slow down for a moment.
                    <Text variant="caption" tone="muted">
                      {String(t("supportChat.rateLimited"))}
                    </Text>
                  )}
                  <CharCountTextarea
                    value={draft}
                    onChange={handleDraftChange}
                    maxLength={SUPPORT_MESSAGE_MAX}
                    minHeight={44}
                    maxLines={4}
                    placeholder={String(t("supportChat.composerPlaceholder"))}
                    enterKeyHint="send"
                    testIdBase="support-composer"
                  />
                  <XStack gap="$2" alignItems="center">
                    {canEscalate && (
                      <Button
                        // "talk to a person" can shrink (and on very narrow
                        // mobile drops its label → icon-only) so the Send button
                        // always stays fully visible at 320px, including the
                        // longer Spanish label. Icon always carries the
                        // accessible name via aria-label.
                        variant="ghost"
                        size={isMobile ? "$3" : "$2"}
                        onPress={() => void handleEscalate()}
                        disabled={escalate.isPending}
                        aria-label={String(t("supportChat.talkToHuman"))}
                        flexShrink={1}
                        minWidth={isMobile ? 44 : 0}
                        {...(isMobile ? { minHeight: 44 } : {})}
                      >
                        <UserRound size={14} aria-hidden />
                        <Text
                          variant="caption"
                          truncate
                          minWidth={0}
                          // Icon-only below 480px (narrow phones) so the longer
                          // Spanish "Hablar con una persona" never pushes Send
                          // off-screen; the button keeps its aria-label.
                          $xs={{ display: "none" }}
                        >
                          {String(t("supportChat.talkToHuman"))}
                        </Text>
                      </Button>
                    )}
                    <XStack flex={1} minWidth={8} />
                    <Button
                      variant="primary"
                      size={isMobile ? "$3" : "$2"}
                      onPress={() => void handleSend()}
                      disabled={
                        !draft.trim() || sendMessage.isPending || rateLimited
                      }
                      aria-label={String(t("supportChat.sendLabel"))}
                      data-testid="support-send"
                      flexShrink={0}
                      {...(isMobile ? { minHeight: 44 } : {})}
                    >
                      {sendMessage.isPending ? (
                        <Spinner size="small" />
                      ) : (
                        <Send size={14} aria-hidden />
                      )}
                      <Text variant="caption" color="$colorInverted">
                        {String(t("supportChat.send"))}
                      </Text>
                    </Button>
                  </XStack>
                </YStack>
              </>
            )}
          </YStack>
        )}
      </AnimatePresence>
    </>
  );
}

SupportWidget.displayName = "SupportWidget";

// ─────────────────────────────────────────────────────────────────────────────
// Signed-out gate: no composer. Sign-in prompt + email fallback (FR-002).
// ─────────────────────────────────────────────────────────────────────────────

function SignInGate({
  supportEmail,
  redirectTo,
}: {
  supportEmail: string;
  redirectTo: string | null;
}) {
  const t = useTranslations();
  const { showSignInOverlay } = useAppOverlay();

  return (
    <YStack
      flex={1}
      justifyContent="center"
      alignItems="center"
      gap="$3"
      padding="$5"
    >
      <Text variant="label" weight="bold" textAlign="center">
        {String(t("supportChat.signedOutTitle"))}
      </Text>
      <Text variant="bodySmall" tone="muted" textAlign="center" maxWidth={280}>
        {String(t("supportChat.signedOutBody"))}
      </Text>
      <Button
        variant="primary"
        size="$3"
        width="100%"
        maxWidth={240}
        onPress={() => showSignInOverlay({ redirect: redirectTo })}
        data-testid="support-signin-link"
      >
        {String(t("supportChat.signInCta"))}
      </Button>
      <Text variant="caption" tone="muted" textAlign="center">
        {String(t("supportChat.emailFallbackPrefix"))}{" "}
        <a
          href={`mailto:${encodeURIComponent(supportEmail)}`}
          data-testid="support-email-fallback"
          style={{
            color: "var(--brandSecondary, #E2481D)",
            fontWeight: 700,
          }}
        >
          {supportEmail}
        </a>
      </Text>
    </YStack>
  );
}
