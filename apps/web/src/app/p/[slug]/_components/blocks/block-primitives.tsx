"use client";

import type { ReactNode } from "react";

import { getSafeExternalHref } from "./safe-block-url";
import styles from "./block-primitives.module.css";

/* ── BlockSection ─────────────────────────────────────────────────────────── */

interface BlockSectionProps {
  children: ReactNode;
  className?: string;
  /**
   * Accessible name for the `<section>`. A `<section>` is only a landmark
   * (`region`) when it is named, so the provenance blocks pass their stamp +
   * heading here (venue-track-record-and-review-switch FR-015) and a screen
   * reader can jump between "The door", "Performers" and "Attendees".
   */
  "aria-label"?: string;
}

/**
 * Standard card-like wrapper for every page block.
 * Provides consistent padding, border-radius, and border.
 */
export function BlockSection({
  children,
  className,
  "aria-label": ariaLabel,
}: BlockSectionProps) {
  return (
    <section
      className={`${styles.blockSection} ${className ?? ""}`.trim()}
      aria-label={ariaLabel}
    >
      {children}
    </section>
  );
}

/* ── BlockHeading ─────────────────────────────────────────────────────────── */

interface BlockHeadingProps {
  children: ReactNode;
}

/**
 * Standard heading for block sections.
 * Uses the page theme text color via CSS custom property.
 */
export function BlockHeading({ children }: BlockHeadingProps) {
  return <h2 className={styles.blockHeading}>{children}</h2>;
}

/* ── Supporting layout classes ────────────────────────────────────────────── */

interface BlockBodyTextProps {
  children: ReactNode;
  className?: string;
}

/** Pre-wrapped body text with standard line-height. */
export function BlockBodyText({ children, className }: BlockBodyTextProps) {
  return (
    <div className={`${styles.blockBodyText} ${className ?? ""}`.trim()}>
      {children}
    </div>
  );
}

interface BlockEmptyProps {
  children: ReactNode;
}

/** Muted "empty" placeholder text inside a block. */
export function BlockEmpty({ children }: BlockEmptyProps) {
  return <p className={styles.blockEmpty}>{children}</p>;
}

interface BlockPillLinkProps {
  href: string;
  external?: boolean;
  children: ReactNode;
}

/** Pill-shaped action link used in location-map, rider, booking, etc. */
export function BlockPillLink({
  href,
  external = false,
  children,
}: BlockPillLinkProps) {
  const safeHref = external ? getSafeExternalHref(href) : href;
  if (!safeHref) {
    return <span className={styles.blockPillLink}>{children}</span>;
  }

  return (
    <a
      href={safeHref}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className={styles.blockPillLink}
    >
      {children}
    </a>
  );
}

interface BlockListCardProps {
  href?: string;
  external?: boolean;
  children: ReactNode;
}

/** Tinted list-row card used for events, announcements, press, etc. */
export function BlockListCard({
  href,
  external,
  children,
}: BlockListCardProps) {
  const safeHref = href && external ? getSafeExternalHref(href) : href;

  if (safeHref) {
    return (
      <a
        href={safeHref}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className={styles.blockListCard}
      >
        {children}
      </a>
    );
  }

  return <div className={styles.blockListCard}>{children}</div>;
}
