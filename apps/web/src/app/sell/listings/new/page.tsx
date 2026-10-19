"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { YStack, XStack, Card, Spinner } from "tamagui";
import { ShoppingBag } from "lucide-react";
import { NextLinkAnchor, Text, useTranslations, useFormatters } from "@th/ui";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { ResellForm } from "../../../my-tickets/[orderId]/resell/_components/ResellForm";
import { fmtDateShort } from "@/lib/format";
import { formatOrderCode } from "@th/types/order-identifier";

// ─────────────────────────────────────────────────────────────────────────────
// Back link — hover/focus parity (ViewAllLink pattern; NextLinkAnchor
// forwards DOM-safe handlers to the rendered <a>)
// ─────────────────────────────────────────────────────────────────────────────

function BackToListingsLink() {
  const t = useTranslations();

  return (
    <NextLinkAnchor
      href="/sell/listings"
      style={{
        alignSelf: "flex-start",
        fontFamily: "inherit",
        fontWeight: 700,
        fontSize: 14,
        textTransform: "uppercase",
        letterSpacing: 1,
        color: "var(--accent)",
        textDecoration: "none",
        cursor: "pointer",
        transition: "color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--foreground)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--accent)";
      }}
      // Keyboard parity with the hover affordance.
      onFocus={(e) => {
        e.currentTarget.style.color = "var(--foreground)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.color = "var(--accent)";
      }}
    >
      ← {String(t("admin.sellNewListingBackToListings"))}
    </NextLinkAnchor>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner component that reads search params (must be wrapped in Suspense)
// ─────────────────────────────────────────────────────────────────────────────

function NewListingInner() {
  const searchParams = useSearchParams();
  const orderId = searchParams.get("orderId");

  // If an orderId is provided (via redirect or deep link), go straight to the form
  if (orderId) {
    return (
      <YStack
        flex={1}
        gap="$4"
        padding="$4"
        maxWidth={720}
        width="100%"
        marginHorizontal="auto"
      >
        {/* Back link */}
        <BackToListingsLink />

        <ResellForm orderId={orderId} />
      </YStack>
    );
  }

  // No orderId — show the user's orders so they can pick one
  return <OrderPicker />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Order picker: lets the seller choose which order's tickets to list
// ─────────────────────────────────────────────────────────────────────────────

function OrderPicker() {
  const t = useTranslations();
  const fmt = useFormatters();

  const ordersQuery = trpc.orders.listMyOrders.useQuery(
    { limit: 50, offset: 0 },
    { placeholderData: keepPreviousData, staleTime: 30_000 },
  );

  const orders = ordersQuery.data?.items ?? [];
  // B2: withheld, not empty. "No orders yet" would be a false statement.
  const ordersNeedVerification = isEmailVerificationRequired(ordersQuery.error);

  return (
    <YStack
      flex={1}
      gap="$4"
      padding="$4"
      maxWidth={720}
      width="100%"
      marginHorizontal="auto"
    >
      {/* Back link */}
      <BackToListingsLink />

      {/* Header */}
      <YStack gap="$1">
        <Text variant="h1">{String(t("admin.sellNewListingTitle"))}</Text>
        <Text variant="body" tone="muted">
          {String(t("admin.sellNewListingSubtitle"))}
        </Text>
      </YStack>

      {/* Loading */}
      {ordersQuery.isLoading && (
        <YStack alignItems="center" paddingVertical="$8">
          <Spinner size="large" />
        </YStack>
      )}

      {ordersNeedVerification ? (
        <EmailVerificationRequired context="generic" />
      ) : null}

      {/* Empty */}
      {!ordersQuery.isLoading && !ordersNeedVerification && orders.length === 0 && (
        <YStack alignItems="center" gap="$3" paddingVertical="$10">
          <ShoppingBag size={48} color="var(--colorMuted)" />
          <Text variant="subtitle" tone="muted">
            {String(t("admin.sellNewListingNoOrders"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={380}>
            {String(t("admin.sellNewListingNoOrdersDescription"))}
          </Text>
        </YStack>
      )}

      {/* Order cards */}
      {orders.length > 0 && (
        <YStack gap="$2">
          <Text variant="subtitle" weight="bold">
            {String(t("admin.sellNewListingPickOrder"))}
          </Text>
          <Text variant="body" tone="muted" marginBottom="$2">
            {String(t("admin.sellNewListingPickOrderDescription"))}
          </Text>
          {orders.map((order) => (
            <Link
              key={order.id}
              href={`/sell/listings/new?orderId=${order.id}`}
              style={{ textDecoration: "none" }}
            >
              <Card
                padding="$4"
                borderRadius={0}
                borderWidth={2}
                borderColor="$borderColor"
                hoverStyle={{ borderColor: "$accent" }}
                cursor="pointer"
              >
                <XStack justifyContent="space-between" alignItems="center">
                  <YStack gap="$1">
                    {/* Fallback title when the order has no event name. The
                        ONE order code (`formatOrderCode` — the 8-hex TAIL), so
                        a seller reading it off this card can quote it to
                        support. Bare, because "Order " already labels it. */}
                    <Text variant="body" weight="bold">
                      {order.eventName ?? `Order ${formatOrderCode(order.id)}`}
                    </Text>
                    <Text variant="bodySmall" tone="muted">
                      {order.ticketCount
                        ? `${order.ticketCount} ticket${order.ticketCount === 1 ? "" : "s"}`
                        : ""}
                    </Text>
                  </YStack>
                  <Text variant="bodySmall" tone="muted">
                    {order.occurredAt
                      ? fmtDateShort(fmt, order.occurredAt)
                      : ""}
                  </Text>
                </XStack>
              </Card>
            </Link>
          ))}
        </YStack>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page (wrapped in Suspense for useSearchParams)
// ─────────────────────────────────────────────────────────────────────────────

export default function SellNewListingPage() {
  return (
    <Suspense
      fallback={
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          padding="$4"
        >
          <Spinner size="large" />
        </YStack>
      }
    >
      <NewListingInner />
    </Suspense>
  );
}
