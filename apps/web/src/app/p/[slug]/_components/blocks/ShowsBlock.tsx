"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading, BlockListCard } from "./block-primitives";
import styles from "./block-primitives.module.css";

type ShowEvent = {
  id: string;
  title: string;
  /** ISO date string. */
  date: string;
  venueName: string | null;
  slug?: string;
};

type ShowsData = {
  /** Server-injected trust marker. Owner-stored data can never set this. */
  dataSource?: string;
  heading?: string;
  events?: ShowEvent[];
};

type Props = {
  block: PageBlockRecord;
};

function formatShowDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/**
 * Shared renderer for the auto-computed `shows` and `past_shows` blocks.
 *
 * SECURITY: this block is read-only and fully server-built. We trust the
 * payload ONLY when it carries the server-injected `dataSource: "shows"`
 * marker. If the marker is absent (e.g. a raw owner-stored `events` array),
 * we render nothing — an owner must never be able to fabricate a performance
 * history.
 */
export function ShowsBlockBase({
  block,
  defaultHeading,
}: Props & { defaultHeading: string }) {
  const data = block.data as ShowsData | undefined;
  if (!data || data.dataSource !== "shows") return null;

  const heading = data.heading ?? defaultHeading;
  const events = data.events;
  if (!events || events.length === 0) return null;

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "0.75rem" }}>
        {events.map((event) => (
          <BlockListCard
            key={event.id}
            href={event.slug ? `/events/${event.slug}` : undefined}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: "0.5rem",
              }}
            >
              <strong className={styles.bodyDefault}>{event.title}</strong>
              <time
                dateTime={event.date}
                className={`${styles.bodySmall} ${styles.muted} ${styles.noWrap}`}
              >
                {formatShowDate(event.date)}
              </time>
            </div>
            {event.venueName && (
              <div
                className={`${styles.bodySmall} ${styles.muted}`}
                style={{ marginTop: "0.125rem" }}
              >
                {event.venueName}
              </div>
            )}
          </BlockListCard>
        ))}
      </div>
    </BlockSection>
  );
}

/** Upcoming performances, sourced from EventHuman lineup attachments. */
export function ShowsBlock({ block }: Props) {
  return <ShowsBlockBase block={block} defaultHeading="Upcoming shows" />;
}
