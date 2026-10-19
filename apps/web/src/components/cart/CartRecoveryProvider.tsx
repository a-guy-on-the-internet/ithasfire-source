"use client";

import { usePathname } from "next/navigation";

import { authClient } from "@/lib/auth/auth-client";
import { CartRecoveryBanner } from "./CartRecoveryBanner";

/**
 * Wrapper that only renders CartRecoveryBanner for authenticated users.
 * This should be placed in a layout that has access to auth context.
 */
export function CartRecoveryProvider() {
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();
  const hiddenPrefixes = [
    "/sign-in",
    "/sign-up",
    "/login",
    "/admin",
    "/platform",
    "/account",
    // Embed widgets render inside PARTNER iframes — first-party cart-recovery
    // chrome must never appear over a third-party page (verified live: a
    // pending cart painted the resume bar over /embed/memberships/<id>).
    "/embed",
  ];
  const isSuppressedRoute = hiddenPrefixes.some((prefix) =>
    pathname?.startsWith(prefix),
  );

  // Only show cart recovery on shopper-facing routes once auth has settled.
  if (isPending || isSuppressedRoute || !session?.user) {
    return null;
  }

  return <CartRecoveryBanner />;
}

export default CartRecoveryProvider;
