import type { Metadata } from "next";
import {
  Rocket,
  Ticket,
  Calendar,
  User,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";

import { getAllArticles, getCategories } from "./_lib/articles";
import { HelpSearch } from "./_components/HelpSearch";
import { ActionCard } from "./_components/ActionCard";

export const metadata: Metadata = {
  title: "Help Centre",
  description:
    "Answers to common questions about buying tickets and organising events on Ithas Fire.",
};

const ICONS: Record<string, LucideIcon> = {
  Rocket,
  Ticket,
  Calendar,
  User,
  HelpCircle,
};

const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

export default function HelpLandingPage() {
  const categories = getCategories();
  const articles = getAllArticles();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 56 }}>
      {/* Hero */}
      <section
        className="swiss-diagonal"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 24,
          paddingBottom: 40,
          borderBottom: `2px solid ${BORDER}`,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 24,
          }}
        >
          <span className="swiss-overline">Help Centre</span>
          <h1
            className="swiss-display-lg"
            style={{ color: "var(--foreground)", maxWidth: 720 }}
          >
            Find answers, fast.
          </h1>
          <p
            style={{
              fontSize: 18,
              lineHeight: 1.6,
              color: "var(--colorMuted, #5C544A)",
              maxWidth: 640,
              textWrap: "balance",
            }}
          >
            Guides for buying tickets, organising events, managing your account,
            and solving common issues. Start with a search or browse a category
            below.
          </p>
          <HelpSearch articles={articles} />
        </div>
      </section>

      {/* Categories */}
      <section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--colorMuted, #5C544A)",
          }}
        >
          Browse by topic
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 16,
          }}
        >
          {categories.map((cat) => {
            const Icon = ICONS[cat.iconName] ?? HelpCircle;
            return (
              <ActionCard
                key={cat.slug}
                icon={Icon}
                title={cat.title}
                description={cat.description}
                href={`/help/${cat.slug}`}
                articleCount={cat.articles.length}
              />
            );
          })}
        </div>
      </section>

      {/* Popular */}
      <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--colorMuted, #5C544A)",
          }}
        >
          Popular articles
        </h2>
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {articles.slice(0, 6).map((a) => (
            <li
              key={a.path}
              style={{
                borderTop: `1px solid ${BORDER}`,
              }}
            >
              <a
                href={a.path}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "16px 0",
                  textDecoration: "none",
                  color: "var(--color, #211C16)",
                  fontSize: 15,
                  gap: 24,
                }}
              >
                <span style={{ fontWeight: 500 }}>{a.title}</span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--colorMuted, #5C544A)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.category.replace(/-/g, " ")}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
