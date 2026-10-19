"use client";

import { memo } from "react";

import type { CategorySlugs } from "@/i18n/public-paths";
import { usePublicLinks } from "@/i18n/use-public-links";

import { useCategoryEvents } from "./useCategoryBrowse";
import { HomeEventSection } from "./HomeEventSection";
import { ViewAllLink } from "./ViewAllLink";

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryEventSectionProps {
  /** Category slug to fetch events for (the English one). */
  categorySlug: string;
  /**
   * The category's slug in each language, so "View all" opens the page in
   * this page's language (FR-006). Defaults to the English slug alone.
   */
  categorySlugs?: CategorySlugs;
  /** Display title for the section header. */
  title: string;
  /** Optional subtitle below the title. */
  subtitle?: string;
  /** Max events to show in this section. */
  limit?: number;
  /** Test ID prefix. */
  testIdBase?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders a home-page event section for a specific category.
 * Fetches events via `useCategoryEvents` and renders them in a `HomeEventSection`.
 * Hides entirely when the category has no events and isn't loading.
 */
export const CategoryEventSection = memo<CategoryEventSectionProps>(
  function CategoryEventSection({
    categorySlug,
    categorySlugs,
    title,
    subtitle,
    limit = 8,
    testIdBase,
  }) {
    const { events, isLoading } = useCategoryEvents(categorySlug, limit);
    const links = usePublicLinks();

    // Don't render the section if there are no events and we're done loading.
    if (!isLoading && events.length === 0) return null;

    return (
      <HomeEventSection
        title={title}
        subtitle={subtitle}
        events={events}
        loading={isLoading}
        variant="grid"
        testIdBase={testIdBase ?? `home-category-${categorySlug}`}
        headerAction={
          events.length > 0 ? (
            <ViewAllLink
              href={links.path({
                kind: "category",
                slugs: categorySlugs ?? { en: categorySlug },
              })}
            />
          ) : undefined
        }
      />
    );
  },
);

CategoryEventSection.displayName = "CategoryEventSection";
