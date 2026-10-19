// eslint-disable-next-line no-restricted-imports -- RSC: @th/ui barrel pulls client-only deps.
import Link from "next/link";
import { ChevronRight } from "lucide-react";

interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        color: "var(--colorMuted, #5C544A)",
        flexWrap: "wrap",
      }}
    >
      {items.map((item, i) => (
        <span
          key={`${item.label}-${i}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {item.href ? (
            <Link
              href={item.href}
              style={{
                color: "var(--colorMuted, #5C544A)",
                textDecoration: "none",
              }}
            >
              {item.label}
            </Link>
          ) : (
            <span style={{ color: "var(--color, #211C16)" }}>
              {item.label}
            </span>
          )}
          {i < items.length - 1 && (
            <ChevronRight
              size={14}
              style={{ color: "var(--borderColorSoft, rgba(33,28,22,0.3))" }}
            />
          )}
        </span>
      ))}
    </nav>
  );
}
