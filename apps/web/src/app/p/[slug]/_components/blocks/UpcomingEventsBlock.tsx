"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { BlockSection, BlockHeading, BlockEmpty } from "./block-primitives";
import styles from "./block-primitives.module.css";

type UpcomingEventsData = {
  heading?: string;
  /** Pre-populated event summaries, if any, or empty for auto-populated. */
  events?: Array<{
    id: string;
    title: string;
    date: string;
    venueName?: string;
    slug?: string;
  }>;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders an upcoming events list.
 *
 * In its current form this renders static event data stored in block.data.
 * A future iteration will auto-populate from the entity's actual upcoming
 * events via a server component or client fetch.
 */
export function UpcomingEventsBlock({ block }: Props) {
  const t = useTranslations();
  const data = block.data as UpcomingEventsData | undefined;
  if (!data) return null;
  const events = data?.events;
  const heading = data?.heading ?? "Upcoming Events";

  if (!events || events.length === 0) {
    return (
      <BlockSection>
        <BlockHeading>{heading}</BlockHeading>
        <BlockEmpty>{t("places.noUpcomingEvents")}</BlockEmpty>
        <a href="/events" className={styles.blockPillLink} style={{ marginTop: "0.75rem" }}>
          {t("places.browseEvents")}
          <span aria-hidden>&#8599;</span>
        </a>
      </BlockSection>
    );
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <ul className={styles.linkList}>
        {events.map((event) => (
          <li key={event.id}>
            <a
              href={
                event.slug ? `/events/${event.slug}` : `/events/${event.id}`
              }
              className={styles.linkRow}
              style={{ justifyContent: "space-between" }}
            >
              <div>
                <div style={{ fontWeight: 500, fontSize: "0.9375rem" }}>
                  {event.title}
                </div>
                {event.venueName && (
                  <div
                    className={`${styles.bodySmall} ${styles.muted}`}
                    style={{ marginTop: "0.125rem" }}
                  >
                    {event.venueName}
                  </div>
                )}
              </div>
              <time
                dateTime={event.date}
                className={`${styles.bodySmall} ${styles.muted} ${styles.noWrap}`}
                style={{ marginLeft: "1rem" }}
              >
                {formatEventDate(event.date)}
              </time>
            </a>
          </li>
        ))}
      </ul>
    </BlockSection>
  );
}

function formatEventDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}
