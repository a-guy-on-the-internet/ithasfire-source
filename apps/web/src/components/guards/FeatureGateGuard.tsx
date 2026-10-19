"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Construction } from "lucide-react";
import { useTranslations } from "@th/ui";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { StatusScreen } from "@/components/layout/PagePrimitives";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";
import { isMaintenanceExemptPath } from "@/lib/feature-gates/route-policy";

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance screen (inline — shown in place of children)
// ─────────────────────────────────────────────────────────────────────────────

function MaintenanceScreen() {
  const t = useTranslations();
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

// ─────────────────────────────────────────────────────────────────────────────
// Guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Client-side route guard that enforces feature gates.
 *
 * - **maintenanceMode**: When true, all non-exempt routes show a maintenance
 *   screen instead of their normal content.
 *
 * Exempt routes (admin, platform, auth, legal pages, home) always render
 * normally regardless of gate state.
 */
export function FeatureGateGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { gates, isLoading } = useFeatureGates();

  // While gates are loading, render children normally (no flash).
  if (isLoading || !gates) {
    return <>{children}</>;
  }

  // Maintenance mode: exempt routes pass through, everything else blocked.
  if (gates.maintenanceMode && pathname && !isMaintenanceExemptPath(pathname)) {
    return <MaintenanceScreen />;
  }

  return <>{children}</>;
}

FeatureGateGuard.displayName = "FeatureGateGuard";
