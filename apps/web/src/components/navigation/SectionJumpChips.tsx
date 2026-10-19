"use client";

import type { MouseEvent } from "react";

/**
 * A phone-width row of jump chips for a page's own sections — the narrow
 * presentation of the venue settings index (`SettingsSectionIndex`), shared
 * through the same CSS rules (`.th-section-chips*` sit in the selector lists
 * of `.th-place-settings-index*` in globals.css, so the two can never drift).
 *
 * `.th-section-chips` hides itself from 960px up: that is where the shell's
 * rail appears, and the rail's own children are the index there.
 *
 * Every chip is a real `<a href="#…">`, so the row works with no script and a
 * modifier-click opens the section in a new tab. A plain click is handed to
 * `onSelect`, which owns the scroll, the focus move and the fragment.
 *
 * Presentational and controlled: the caller owns `activeId` (scroll-spy).
 */
export type SectionJumpChip = { id: string; label: string };

export type SectionJumpChipsProps = {
  items: readonly SectionJumpChip[];
  activeId: string | null;
  /** Return false to let the browser do the plain hash jump. */
  onSelect: (id: string) => boolean;
  /** Accessible name of the `<nav>` — the shell already has a rail landmark. */
  label: string;
  testId?: string;
};

export function SectionJumpChips({
  items,
  activeId,
  onSelect,
  label,
  testId = "section-jump-chips",
}: SectionJumpChipsProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (onSelect(id)) event.preventDefault();
  };

  return (
    <nav aria-label={label} className="th-section-chips" data-testid={testId}>
      <ul className="th-section-chips-list" role="list">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="th-section-chips-link"
              aria-current={activeId === item.id ? "true" : undefined}
              onClick={(event) => handleClick(event, item.id)}
              data-testid={`${testId}-${item.id}`}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
