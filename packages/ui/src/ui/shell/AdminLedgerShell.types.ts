import type { ReactNode } from "react";

import type { LedgerSectionTabItem } from "./ledger/LedgerSectionTabs";
import type { NavigationShellProps } from "./NavigationShell.types";

/**
 * Props for `AdminLedgerShell` — the ledger-topbar sibling of
 * `NavigationShell` (docs/specs/2026-08-26/completed/admin-ledger-shell-map.md).
 *
 * It accepts every prop `AdminShell` passes `NavigationShell` (same names,
 * same types — `AdminShell` swaps the tag, nothing else) plus the three
 * ledger registers. The navbar-only props this shell has no home for are
 * omitted so the type tells the truth: `secondaryNav`, `onInviteTeammate`,
 * `environmentBadge`, `onBrandPress`.
 *
 * Partial parity, documented: `quickActions` reach ONLY the mobile drawer
 * (the topbar has no quick-action bar); `onOpenCommandPalette` binds the
 * ⌘/Ctrl+K shortcut but has no visible affordance in this shell.
 * `contentVariant` / `contentMaxWidth` are accepted and ignored — the ledger
 * shell always renders the plain content area.
 */
export interface AdminLedgerShellProps extends Omit<
  NavigationShellProps,
  "secondaryNav" | "onInviteTeammate" | "environmentBadge" | "onBrandPress"
> {
  /**
   * Surface name beside the wordmark in register 1 — the DS Topbar's `role`
   * ("Admin"). Named `surfaceRole` here so it never reads as the ARIA
   * attribute. This is what stops an organizer wondering whether they are
   * looking at the public site; the consumer owns the string so it stays
   * i18n-correct. Hidden on the mobile top bar.
   */
  surfaceRole?: ReactNode;
  /**
   * Register 2 — the surface's top-level areas. Omit or pass an empty array
   * to render no section tabs at all (the rail remains the item-level nav).
   */
  sectionTabs?: LedgerSectionTabItem[];
  /**
   * Accessible name for the section-tabs `<nav>` landmark. Must NOT be
   * "Main navigation" — that is the rail's landmark name. Defaults to
   * "Sections".
   */
  sectionTabsLabel?: string;
  /** href of the active section tab. */
  sectionTabsCurrent?: string;
  /** Activate handler for a section tab (client-side navigation). */
  onSectionTabSelect?: (href: string) => void;
  /** Overflow menu rendered after the section tabs. */
  sectionTabsOverflow?: ReactNode;
  /** Register 3 facts, joined by mono middots. Facts only — no controls. */
  contextItems?: ReactNode[];
  /** Register 3 right-aligned live figure. */
  contextRight?: ReactNode;
}
