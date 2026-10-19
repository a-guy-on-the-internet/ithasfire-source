// eslint-disable-next-line no-restricted-imports -- RSC: @th/ui barrel pulls client-only deps.
import Link from "next/link";
import type { Category } from "../_lib/types";
import { ACCENT } from "@/lib/design-tokens";

const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

interface HelpNavProps {
  categories: Category[];
  activeCategory?: string;
  activeArticle?: string;
}

export function HelpNav({
  categories,
  activeCategory,
  activeArticle,
}: HelpNavProps) {
  return (
    <nav
      aria-label="Help navigation"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        fontSize: 14,
      }}
    >
      {categories.map((cat) => {
        const isActive = cat.slug === activeCategory;
        return (
          <div
            key={cat.slug}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            <Link
              href={`/help/${cat.slug}`}
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: isActive ? ACCENT : "var(--colorMuted, #5C544A)",
                textDecoration: "none",
                borderLeft: isActive
                  ? `3px solid ${ACCENT}`
                  : `3px solid transparent`,
                paddingLeft: 10,
              }}
            >
              {cat.title}
            </Link>

            {isActive && (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  paddingLeft: 13,
                  borderLeft: `1px solid ${BORDER}`,
                  marginLeft: 1,
                }}
              >
                {cat.articles.map((a) => {
                  const isCurrent = a.slug === activeArticle;
                  return (
                    <li key={a.path}>
                      <Link
                        href={a.path}
                        style={{
                          display: "block",
                          padding: "4px 8px",
                          fontSize: 13,
                          color: isCurrent
                            ? "var(--color, #211C16)"
                            : "var(--colorMuted, #5C544A)",
                          fontWeight: isCurrent ? 600 : 400,
                          textDecoration: "none",
                        }}
                      >
                        {a.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
