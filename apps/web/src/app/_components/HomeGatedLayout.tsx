"use client";

import { Construction } from "lucide-react";
import { useTranslations } from "@th/ui";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { StatusScreen, LoadingScreen } from "@/components/layout/PagePrimitives";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";
import { HomeLayout } from "./HomeLayout";

/**
 * Route-level gate for the homepage.
 *
 * Priority:
 * 1. **maintenanceMode** → show the maintenance screen.
 * 2. otherwise → show the full event-discovery homepage.
 *
 * (The pre-launch "Coming Soon" gate has been removed now that the product is
 * live; the Place Review form it used to host lives permanently at
 * `/review-a-place`.)
 */
export function HomeGatedLayout() {
  const { gates, isLoading } = useFeatureGates();
  const t = useTranslations();

  // Gates are server-seeded on first paint, so this is effectively a no-flash
  // guard. Show a neutral loading state (never a homepage flash) until we can
  // confirm whether maintenance mode is on.
  if (isLoading || !gates) {
    return <LoadingScreen />;
  }

  if (gates.maintenanceMode) {
    return (
      <StatusScreen
        icon={Construction}
        iconColor={ACCENT}
        iconBg={STRUCTURAL}
        title={t("admin.maintenanceTitle") as string}
        description={t("admin.maintenanceBody") as string}
      />
    );
  }

  return <HomeLayout />;
}

HomeGatedLayout.displayName = "HomeGatedLayout";
