"use client";

import type { ReactNode } from "react";
// NOT NextLinkAnchor: its inline base style (`color:inherit`) outranks the
// CSS-module rules, which silently kills the tab strip's muted/active colours
// and hover states. A bare next/link <a> is what CSS-module strict-Swiss
// styling needs (same call AccountShell makes).
// eslint-disable-next-line no-restricted-imports
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "@th/ui";

import styles from "./memberships.module.css";

type Props = {
  /** The regular entity page body (default tab). */
  overview: ReactNode;
  /** The Membership tab content (tier pitch / member content). */
  memberships: ReactNode;
};

/**
 * URL-driven tab switch for entity pages with a membership program:
 * `/p/[slug]` renders the overview, `/p/[slug]?tab=memberships` the
 * Membership tab — the exact URL shape the admin surfaces and renewal
 * emails link to.
 *
 * Tabs are LINKS (aria-current), not ARIA tabs: the state lives in the URL,
 * deep links work without JS, and soft navigation keeps the switch cheap.
 * Both panels stay mounted (`hidden`) so tab flips never re-fetch the
 * overview's maps/embeds. Rendered under a Suspense boundary in
 * EntityPageShell because `useSearchParams` opts out of the static shell.
 */
export function EntityPageTabs({ overview, memberships }: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active =
    searchParams.get("tab") === "memberships" ? "memberships" : "overview";

  return (
    <div>
      <nav
        aria-label={String(t("entityMemberships.tabsLabel"))}
        className={styles.tabStrip}
      >
        <div className={styles.tabRow}>
          <Link
            href={pathname}
            scroll={false}
            className={styles.tabLink}
            aria-current={active === "overview" ? "page" : undefined}
          >
            {String(t("entityMemberships.tabOverview"))}
          </Link>
          <Link
            href={`${pathname}?tab=memberships`}
            scroll={false}
            className={styles.tabLink}
            aria-current={active === "memberships" ? "page" : undefined}
          >
            {String(t("entityMemberships.tabMembership"))}
          </Link>
        </div>
      </nav>
      <div hidden={active !== "overview"}>{overview}</div>
      <div hidden={active !== "memberships"}>{memberships}</div>
    </div>
  );
}
