"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { formatDateShort } from "@/lib/format";

import { BlockSection, BlockHeading, BlockListCard } from "./block-primitives";
import styles from "./block-primitives.module.css";

type Announcement = {
  id?: string;
  title: string;
  body?: string;
  bodyHtml?: string;
  date?: string;
};

type AnnouncementsData = {
  heading?: string;
  announcements?: Announcement[];
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders a list of announcements.
 * `block.data` should contain `{ announcements: [{ title, body?, date? }], heading? }`.
 */
export function AnnouncementsBlock({ block }: Props) {
  const data = block.data as AnnouncementsData | undefined;
  if (!data) return null;
  const announcements = data?.announcements;
  const heading = data?.heading ?? "Announcements";

  if (!announcements || announcements.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "0.75rem" }}>
        {announcements.map((a, i) => (
          <BlockListCard key={a.id ?? `${a.title}-${i}`}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: "0.5rem",
              }}
            >
              <h3
                className={styles.bodyDefault}
                style={{ fontWeight: 700, margin: 0 }}
              >
                {a.title}
              </h3>
              {a.date && (
                <time
                  dateTime={a.date}
                  className={`${styles.bodySmall} ${styles.muted} ${styles.noWrap}`}
                >
                  {formatDateShort(a.date)}
                </time>
              )}
            </div>
            {a.bodyHtml ? (
              <div
                className={styles.announcementBody}
                dangerouslySetInnerHTML={{ __html: a.bodyHtml }}
              />
            ) : a.body ? (
              <p
                style={{
                  marginTop: "0.375rem",
                  fontSize: "0.875rem",
                  lineHeight: 1.5,
                  opacity: 0.8,
                  whiteSpace: "pre-wrap",
                }}
              >
                {a.body}
              </p>
            ) : null}
          </BlockListCard>
        ))}
      </div>
    </BlockSection>
  );
}
