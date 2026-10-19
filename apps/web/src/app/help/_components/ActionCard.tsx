// eslint-disable-next-line no-restricted-imports -- help center pages are RSC; the @th/ui barrel pulls client-only Tamagui components into server bundles.
import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";

import { ACCENT } from "@/lib/design-tokens";

const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

export function ActionCard({
  icon: Icon,
  title,
  description,
  href,
  articleCount,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
  articleCount?: number;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "28px 24px",
        borderTop: `2px solid ${BORDER}`,
        borderBottom: `1px solid ${BORDER}`,
        textDecoration: "none",
        position: "relative",
        minHeight: 180,
      }}
    >
      <div
        style={{
          display: "flex",
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(226, 72, 29, 0.12)",
        }}
      >
        <Icon size={22} style={{ color: ACCENT }} />
      </div>
      <div
        style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}
      >
        <h3
          style={{
            fontSize: 16,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "-0.01em",
            color: "var(--color, #211C16)",
          }}
        >
          {title}
        </h3>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            color: "var(--colorMuted, #5C544A)",
          }}
        >
          {description}
        </p>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 12,
          color: "var(--colorMuted, #5C544A)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 700,
        }}
      >
        <span>
          {articleCount !== undefined
            ? `${articleCount} article${articleCount === 1 ? "" : "s"}`
            : "Explore"}
        </span>
        <ArrowRight size={16} />
      </div>
    </Link>
  );
}
