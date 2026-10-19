"use client";

import { useMemo, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- match the pattern used by other help components (RSC-safe).
import Link from "next/link";
import { Search } from "lucide-react";

import type { ArticleMeta } from "../_lib/types";
import { ACCENT } from "@/lib/design-tokens";

const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

interface HelpSearchProps {
  articles: ArticleMeta[];
}

export function HelpSearch({ articles }: HelpSearchProps) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return articles
      .filter((a) => {
        const haystack = [a.title, a.description, ...(a.tags ?? [])]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 8);
  }, [query, articles]);

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 520 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 18px",
          border: `2px solid ${BORDER}`,
          background: "rgba(33,28,22,0.05)",
        }}
      >
        <Search size={18} style={{ color: "var(--colorMuted, #5C544A)" }} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help articles…"
          aria-label="Search help articles"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            fontSize: 16,
            color: "var(--color, #211C16)",
            fontFamily: "inherit",
          }}
        />
      </div>

      {results.length > 0 && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "var(--surface, #FDFAF3)",
            border: `2px solid ${BORDER}`,
            zIndex: 10,
            maxHeight: 400,
            overflowY: "auto",
          }}
        >
          {results.map((a) => (
            <Link
              key={a.path}
              href={a.path}
              style={{
                display: "block",
                padding: "12px 18px",
                borderBottom: `1px solid ${BORDER}`,
                textDecoration: "none",
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--color, #211C16)",
                  marginBottom: 2,
                }}
              >
                {a.title}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--colorMuted, #5C544A)",
                }}
              >
                {a.description}
              </div>
            </Link>
          ))}
        </div>
      )}

      {query.trim().length >= 2 && results.length === 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            padding: "16px 18px",
            background: "var(--surface, #FDFAF3)",
            border: `2px solid ${BORDER}`,
            fontSize: 14,
            color: "var(--colorMuted, #5C544A)",
            zIndex: 10,
          }}
        >
          No results for{" "}
          <span style={{ color: ACCENT }}>&ldquo;{query}&rdquo;</span>.
        </div>
      )}
    </div>
  );
}
