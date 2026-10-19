"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Button, Text, useTranslations, useFormatters } from "@th/ui";
import { Clock, ShoppingCart } from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import { cartResumeHref } from "@/components/cart/cart-resume-href";
import { useCartRecovery, type ActiveCart } from "@/hooks/useCartRecovery";
import { useIsMobile } from "@/hooks/useIsMobile";
import { fmtCurrency } from "@/lib/format";
import {
  SHELL_GUTTER,
  SHELL_GUTTER_MOBILE,
  SHELL_MAX_WIDTH,
} from "@/components/layout/shell-metrics";

// ── Styled containers ────────────────────────────────────────────────────────

/**
 * Full-width fixed strip. On desktop it sits at the bottom of the viewport,
 * on mobile it sits at the top (below the navbar).
 */
const BannerStrip = styled(YStack, {
  name: "CartRecoveryStrip",
  position: "fixed" as never,
  left: 0,
  right: 0,
  zIndex: 999_100, // above cookie banner (999_000) and mobile nav (1000)
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  backgroundColor: "$background",
  variants: {
    placement: {
      bottom: {
        bottom: 0,
        borderTopWidth: 2,
        borderTopColor: "$borderColor",
        borderBottomWidth: 0,
      },
      top: {
        top: 0,
        borderTopWidth: 0,
        borderBottomWidth: 2,
        borderBottomColor: "$borderColor",
      },
    },
  } as const,
});

// Shell chrome: a fixed overlay rather than a document band, but it still
// spans the viewport, so it lands on the same grid as the navbar/body/footer.
const BannerInner = styled(XStack, {
  name: "CartRecoveryInner",
  maxWidth: SHELL_MAX_WIDTH,
  width: "100%",
  alignSelf: "center",
  alignItems: "center",
  paddingHorizontal: SHELL_GUTTER,
  paddingVertical: "$3",
  gap: "$3",
  flexWrap: "wrap",

  $sm: {
    paddingHorizontal: SHELL_GUTTER_MOBILE,
  },
});

// ── Countdown hook ───────────────────────────────────────────────────────────

function useCountdown(expiresAt: Date | null): {
  label: string | null;
  isExpired: boolean;
} {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return useMemo(() => {
    if (!expiresAt) return { label: null, isExpired: false };
    const diffMs = new Date(expiresAt).getTime() - now;
    if (diffMs <= 0) return { label: null, isExpired: true };
    const m = Math.floor(diffMs / 60_000);
    const s = Math.floor((diffMs % 60_000) / 1_000);
    return { label: `${m}:${s.toString().padStart(2, "0")}`, isExpired: false };
  }, [expiresAt, now]);
}

// ── Single cart row ──────────────────────────────────────────────────────────

interface CartRowProps {
  cart: ActiveCart;
  onDismiss: () => void;
}

const CartRow = memo(function CartRow({ cart, onDismiss }: CartRowProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { label: timeLeft, isExpired } = useCountdown(cart.holdExpiresAt);

  // Auto-dismiss expired carts after a brief grace period so the user
  // sees "Hold expired" and then the row disappears on its own.
  const dismissedRef = useRef(false);
  useEffect(() => {
    if (!isExpired || dismissedRef.current) return;
    const id = setTimeout(() => {
      dismissedRef.current = true;
      onDismiss();
    }, 3_000);
    return () => clearTimeout(id);
  }, [isExpired, onDismiss]);

  const ticketCount = useMemo(
    () => cart.ticketSummary.reduce((sum, item) => sum + item.qty, 0),
    [cart.ticketSummary],
  );

  const checkoutHref = cartResumeHref(cart);

  return (
    <BannerInner>
      {/* Left: icon + event details */}
      <XStack alignItems="center" gap="$2" flex={1} minWidth={0}>
        <ShoppingCart size={16} style={{ flexShrink: 0, opacity: 0.6 }} />
        <Text variant="bodySmall" weight="bold" truncate flex={1} minWidth={0}>
          {cart.eventName}
        </Text>
        <Text variant="caption" tone="muted" style={{ flexShrink: 0 }}>
          {String(t("myTickets.nTickets", { count: ticketCount }))}
          {" \u00B7 "}
          {/* A held cart can't know the charge yet: it persists no tax and
              no processing fee (checkout solves both), so a single "total"
              here would understate a pass-through cart. Show the ticket
              subtotal and say what checkout adds, the way the event page
              does: fees and tax on top, or tax only where the organiser
              absorbs the platform fee. A free cart adds nothing, so no
              suffix. */}
          {fmtCurrency(fmt, cart.amountGrossCents, cart.currency)}
          {cart.amountGrossCents > 0
            ? ` ${String(
                t(
                  cart.feeMode === "ABSORB"
                    ? "eventDetail.plusTax"
                    : "eventDetail.plusFeesAndTax",
                ),
              )}`
            : null}
        </Text>
      </XStack>

      {/* Right: timer + actions */}
      <XStack alignItems="center" gap="$2" style={{ flexShrink: 0 }}>
        {timeLeft && !isExpired ? (
          <XStack alignItems="center" gap="$1">
            <Clock size={12} style={{ opacity: 0.6 }} />
            <Text variant="caption" color="$warning">
              {String(t("cart.expiresIn", { time: timeLeft }))}
            </Text>
          </XStack>
        ) : isExpired ? (
          <Text variant="caption" color="$error">
            {String(t("cart.holdExpired"))}
          </Text>
        ) : null}

        <Button
          size="$2"
          variant="ghost"
          onPress={onDismiss}
          aria-label={String(t("cart.dismiss"))}
        >
          {String(t("cart.dismiss"))}
        </Button>

        {!isExpired && checkoutHref && (
          <Link
            href={checkoutHref}
            role="link"
            style={{ textDecoration: "none" }}
          >
            <Button size="$2">{String(t("cart.resume"))}</Button>
          </Link>
        )}
      </XStack>
    </BannerInner>
  );
});

// ── Multi-cart collapsed view ────────────────────────────────────────────────

interface CollapsedRowProps {
  carts: ActiveCart[];
  onExpand: () => void;
  onDismissAll: () => void;
}

const CollapsedRow = memo(function CollapsedRow({
  carts,
  onExpand,
  onDismissAll,
}: CollapsedRowProps) {
  const t = useTranslations();

  // Find the earliest expiry across all carts
  const earliestExpiry = useMemo(() => {
    const expires = carts
      .map((c) => c.holdExpiresAt)
      .filter((d): d is Date => d !== null)
      .map((d) => new Date(d).getTime());
    return expires.length ? new Date(Math.min(...expires)) : null;
  }, [carts]);

  const { label: timeLeft, isExpired } = useCountdown(earliestExpiry);

  return (
    <BannerInner>
      <XStack alignItems="center" gap="$2" flex={1} minWidth={0}>
        <ShoppingCart size={16} style={{ flexShrink: 0, opacity: 0.6 }} />
        <Text variant="bodySmall" weight="bold">
          {String(t("cart.nPendingCarts", { count: carts.length }))}
        </Text>
        {timeLeft && !isExpired ? (
          <XStack alignItems="center" gap="$1">
            <Clock size={12} style={{ opacity: 0.6 }} />
            <Text variant="caption" color="$warning">
              {String(t("cart.expiresIn", { time: timeLeft }))}
            </Text>
          </XStack>
        ) : null}
      </XStack>

      <XStack alignItems="center" gap="$2" style={{ flexShrink: 0 }}>
        <Button
          size="$2"
          variant="ghost"
          onPress={onDismissAll}
          aria-label={String(t("cart.dismissAll"))}
        >
          {String(t("cart.dismissAll"))}
        </Button>
        <Button size="$2" onPress={onExpand}>
          {String(t("cart.viewCarts"))}
        </Button>
      </XStack>
    </BannerInner>
  );
});

// ── Main banner ──────────────────────────────────────────────────────────────

interface CartRecoveryBannerProps {
  /** Current order ID to exclude from recovery prompts */
  currentOrderId?: string;
}

/**
 * Full-width fixed banner for cart recovery. Sits at the bottom of the viewport
 * on desktop (above the footer) and at the top on mobile (below the navbar area).
 */
export function CartRecoveryBanner({
  currentOrderId,
}: CartRecoveryBannerProps) {
  const t = useTranslations();
  const isMobile = useIsMobile();
  const { activeCarts, isLoading, dismissCart } = useCartRecovery({
    currentOrderId,
  });

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [isExpanded, setIsExpanded] = useState(false);

  const visibleCarts = useMemo(
    () => activeCarts.filter((cart) => !dismissedIds.has(cart.id)),
    [activeCarts, dismissedIds],
  );

  const handleDismiss = useCallback(
    async (cart: ActiveCart) => {
      setDismissedIds((prev) => new Set([...prev, cart.id]));
      await dismissCart(cart.id);
    },
    [dismissCart],
  );

  const handleDismissAll = useCallback(async () => {
    const ids = visibleCarts.map((c) => c.id);
    setDismissedIds((prev) => new Set([...prev, ...ids]));
    await Promise.allSettled(ids.map((id) => dismissCart(id)));
  }, [visibleCarts, dismissCart]);

  if (isLoading || visibleCarts.length === 0) return null;

  const showSingleCart = visibleCarts.length === 1 || isExpanded;
  const placement = isMobile ? "top" : "bottom";

  return (
    <BannerStrip
      placement={placement}
      // On mobile, nudge below potential sticky nav; on desktop above bottom nav
      style={isMobile ? { top: 0 } : { bottom: 0 }}
      data-testid="cart-recovery-banner"
    >
      {showSingleCart ? (
        <YStack width="100%">
          {visibleCarts.map((cart) => (
            <CartRow
              key={cart.id}
              cart={cart}
              onDismiss={() => handleDismiss(cart)}
            />
          ))}
          {visibleCarts.length > 1 && (
            <XStack justifyContent="center" paddingBottom="$1">
              <Button
                size="$2"
                variant="ghost"
                onPress={() => setIsExpanded(false)}
              >
                {String(t("cart.minimize"))}
              </Button>
            </XStack>
          )}
        </YStack>
      ) : (
        <CollapsedRow
          carts={visibleCarts}
          onExpand={() => setIsExpanded(true)}
          onDismissAll={handleDismissAll}
        />
      )}
    </BannerStrip>
  );
}

export default CartRecoveryBanner;
