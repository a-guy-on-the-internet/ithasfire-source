"use client";
import { Search } from "lucide-react";
import { useTranslations } from "@th/ui";

import {
  StatusScreen,
  ButtonPrimary,
  ButtonOutline,
  ButtonRow,
  STATUS_ICON,
  STATUS_ICON_BG,
} from "@/components/layout/PagePrimitives";
import { usePublicLinks } from "@/i18n/use-public-links";

export default function NotFound() {
  const t = useTranslations();
  // An unknown /es/... path goes home to `/es` (spanish-seo FR-006).
  const homePath = usePublicLinks().path({ kind: "home" });
  return (
    <StatusScreen
      icon={Search}
      iconColor={STATUS_ICON}
      iconBg={STATUS_ICON_BG}
      title={String(t("notFoundPage.title"))}
      description={String(t("notFoundPage.description"))}
    >
      <ButtonRow>
        <ButtonPrimary href={homePath}>{String(t("notFoundPage.goHome"))}</ButtonPrimary>
        <ButtonOutline href="/events">{String(t("notFoundPage.browseEvents"))}</ButtonOutline>
      </ButtonRow>
    </StatusScreen>
  );
}
