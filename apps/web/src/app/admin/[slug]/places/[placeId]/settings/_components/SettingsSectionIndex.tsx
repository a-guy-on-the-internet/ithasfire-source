"use client";

import { useEffect, useState, type MouseEvent } from "react";

/**
 * The venue settings page's in-page jump list ("On this page").
 *
 * ONE element, two presentations, both from `.th-place-settings-index` in
 * globals.css: a sticky vertical list LEFT of the sections when the settings
 * container is two columns wide, and a horizontal row of jump chips above them
 * when it is not (the phone board). The switch is a container query, not a
 * prop — this component never knows which one it is.
 *
 * Every link is a real `<a href="#…">`, so the list works with no script at
 * all. With script, a click also MOVES FOCUS to the section heading (a hash
 * jump alone leaves keyboard focus on the link, so the next Tab lands back in
 * the index instead of inside the section the reader asked for) and honours
 * reduced motion.
 */
export type SettingsSectionIndexItem = {
  /** The heading id the link jumps to. The heading carries `tabIndex={-1}`. */
  targetId: string;
  label: string;
};

export type SettingsSectionIndexProps = {
  items: readonly SettingsSectionIndexItem[];
  /** Accessible name of the `<nav>` — there is already a rail landmark. */
  label: string;
  /** Visible kicker above the vertical list (hidden in the chip row). */
  kicker: string;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function SettingsSectionIndex({
  items,
  label,
  kicker,
}: SettingsSectionIndexProps) {
  // Starts on the first section: that is what is on screen at first paint, and
  // it keeps server and client markup identical (no hydration mismatch).
  const [activeId, setActiveId] = useState<string | null>(
    items[0]?.targetId ?? null,
  );

  // Scroll-spy. A heading that has crossed into the top band of the viewport
  // becomes current; the LAST one to do so wins, so a short section at the
  // bottom still lights up once it is reached. Pure progressive enhancement —
  // without IntersectionObserver the first item simply stays current.
  const targetKey = items.map((i) => i.targetId).join("|");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = targetKey ? targetKey.split("|") : [];
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Document order, not callback order.
        const current = ids.filter((id) => visible.has(id)).pop();
        if (current) setActiveId(current);
      },
      // The top 35% of the viewport is the "reading" band.
      { rootMargin: "0px 0px -65% 0px", threshold: 0 },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [targetKey]);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return; // let the browser do the plain hash jump
    event.preventDefault();
    target.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    // preventScroll: the scrollIntoView above owns the motion; focusing
    // without it would snap the page and cancel the smooth scroll.
    target.focus({ preventScroll: true });
    // Keep the address bar shareable without a second jump.
    window.history.replaceState(null, "", `#${id}`);
    setActiveId(id);
  };

  return (
    <nav
      aria-label={label}
      className="th-place-settings-index"
      data-testid="place-settings-index"
    >
      <p className="th-place-settings-index-kicker" aria-hidden="true">
        {kicker}
      </p>
      <ul className="th-place-settings-index-list" role="list">
        {items.map((item) => (
          <li key={item.targetId}>
            <a
              href={`#${item.targetId}`}
              className="th-place-settings-index-link"
              aria-current={activeId === item.targetId ? "true" : undefined}
              onClick={(event) => handleClick(event, item.targetId)}
              data-testid={`place-settings-index-${item.targetId}`}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
