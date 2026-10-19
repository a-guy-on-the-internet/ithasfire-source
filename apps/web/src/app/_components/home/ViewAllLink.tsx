"use client";

import { memo } from "react";

import { NextLinkAnchor, useTranslations } from "@th/ui";

interface ViewAllLinkProps {
  href: string;
}

/**
 * Consistent "VIEW ALL →" link used in home page section headers.
 * Swiss style: uppercase, bold, orange hover with mechanical arrow.
 *
 * Renders as a real <a> via next/link so middle-click / open-in-new-tab
 * work and React's synthetic event system can't swallow the navigation.
 */
export const ViewAllLink = memo(function ViewAllLink({
  href,
}: ViewAllLinkProps) {
  const t = useTranslations();

  return (
    <NextLinkAnchor
      href={href}
      role="link"
      style={{
        fontFamily: "inherit",
        fontWeight: 700,
        fontSize: 13,
        color: "var(--color)",
        cursor: "pointer",
        textDecoration: "none",
        textTransform: "uppercase",
        letterSpacing: "1.2px",
        transition: "color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--brandSecondary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--color)";
      }}
      // Keyboard parity with the hover affordance — focus gets the same
      // orange highlight the pointer gets.
      onFocus={(e) => {
        e.currentTarget.style.color = "var(--brandSecondary)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.color = "var(--color)";
      }}
    >
      {String(t("common.viewAll"))} →
    </NextLinkAnchor>
  );
});

ViewAllLink.displayName = "ViewAllLink";
