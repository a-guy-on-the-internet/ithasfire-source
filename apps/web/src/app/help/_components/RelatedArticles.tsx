// eslint-disable-next-line no-restricted-imports -- RSC: @th/ui barrel pulls client-only deps.
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { ArticleMeta } from "../_lib/types";

const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

export function RelatedArticles({ articles }: { articles: ArticleMeta[] }) {
  if (articles.length === 0) return null;
  return (
    <section
      aria-label="Related articles"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        paddingTop: 40,
        borderTop: `2px solid ${BORDER}`,
        marginTop: 48,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--colorMuted, #5C544A)",
        }}
      >
        Related articles
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
        }}
      >
        {articles.map((a) => (
          <Link
            key={a.path}
            href={a.path}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "20px 20px",
              borderTop: `2px solid ${BORDER}`,
              borderBottom: `1px solid ${BORDER}`,
              textDecoration: "none",
            }}
          >
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "var(--color, #211C16)",
                textTransform: "uppercase",
                letterSpacing: "-0.01em",
              }}
            >
              {a.title}
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--colorMuted, #5C544A)",
              }}
            >
              {a.description}
            </div>
            <ArrowRight
              size={16}
              style={{ color: "var(--colorMuted, #5C544A)", marginTop: 4 }}
            />
          </Link>
        ))}
      </div>
    </section>
  );
}
