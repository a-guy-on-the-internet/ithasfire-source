import type { Metadata } from "next";
import { notFound } from "next/navigation";
// eslint-disable-next-line no-restricted-imports -- RSC: @th/ui barrel pulls client-only deps.
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { getCategories, getCategory } from "../_lib/articles";
import { Breadcrumbs } from "../_components/Breadcrumbs";

const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

interface PageProps {
  params: Promise<{ category: string }>;
}

export function generateStaticParams() {
  return getCategories().map((c) => ({ category: c.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { category } = await params;
  const cat = getCategory(category);
  if (!cat) return { title: "Help" };
  return {
    title: `${cat.title} — Help Centre`,
    description: cat.description,
  };
}

export default async function HelpCategoryPage({ params }: PageProps) {
  const { category } = await params;
  const cat = getCategory(category);
  if (!cat) notFound();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
      <Breadcrumbs
        items={[{ label: "Help", href: "/help" }, { label: cat.title }]}
      />

      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          paddingBottom: 32,
          borderBottom: `2px solid ${BORDER}`,
        }}
      >
        <span className="swiss-overline">{cat.articles.length} articles</span>
        <h1 className="swiss-display-md" style={{ color: "var(--foreground)" }}>
          {cat.title}
        </h1>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.6,
            color: "var(--colorMuted, #5C544A)",
            maxWidth: 640,
          }}
        >
          {cat.description}
        </p>
      </header>

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {cat.articles.map((a) => (
          <li key={a.path} style={{ borderTop: `1px solid ${BORDER}` }}>
            <Link
              href={a.path}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 24,
                padding: "24px 0",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* h2: these rows sit directly under the page h1 — h3 skipped
                    a heading level. */}
                <h2
                  style={{
                    fontSize: 17,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                    color: "var(--color, #211C16)",
                    margin: 0,
                  }}
                >
                  {a.title}
                </h2>
                <p
                  style={{
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: "var(--colorMuted, #5C544A)",
                  }}
                >
                  {a.description}
                </p>
              </div>
              <ArrowRight
                size={18}
                style={{ color: "var(--colorMuted, #5C544A)", flexShrink: 0 }}
              />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
