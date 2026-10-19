import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Repeat, Banknote, ShieldAlert } from "lucide-react";

import { assertFeatureEnabled } from "@/server/feature-gates";
import { SellerShell } from "./_components/SellerShell";

import type { NavigationSection } from "@th/ui";

export const metadata: Metadata = {
  title: "Seller Hub",
  robots: { index: false, follow: false },
};

const SELL_SECTIONS: NavigationSection[] = [
  {
    id: "seller",
    label: "admin.sellHubTitle",
    items: [
      {
        id: "listings",
        label: "admin.sellNavListings",
        route: "listings",
        icon: <Repeat size={18} />,
      },
      {
        id: "payouts",
        label: "admin.sellNavPayouts",
        route: "payouts",
        icon: <Banknote size={18} />,
      },
      {
        id: "claims",
        label: "admin.sellNavClaims",
        route: "claims",
        icon: <ShieldAlert size={18} />,
      },
    ],
  },
];

/**
 * Route-level gate for the Seller Hub (peer-to-peer resale listings, payouts,
 * claims). `resale` is off by default; when off this `notFound()`s so the
 * whole `/sell` tree is unreachable by direct URL.
 */
export default async function SellLayout({
  children,
}: {
  children: ReactNode;
}) {
  await assertFeatureEnabled("resale");
  return <SellerShell sections={SELL_SECTIONS}>{children}</SellerShell>;
}
