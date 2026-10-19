"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading, BlockListCard } from "./block-primitives";
import styles from "./block-primitives.module.css";

type PressItem = {
  title: string;
  source: string;
  url?: string;
  date?: string;
  excerpt?: string;
};

type PressData = {
  heading?: string;
  mentions?: PressItem[];
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders press mentions / media coverage for an artist EPK.
 */
export function PressBlock({ block }: Props) {
  const data = block.data as PressData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "Press";
  const mentions = data?.mentions;

  if (!mentions || mentions.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "0.75rem" }}>
        {mentions.map((mention, i) => (
          <BlockListCard key={i} href={mention.url} external>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: "0.5rem",
              }}
            >
              <strong className={styles.bodyDefault}>{mention.title}</strong>
              {mention.date && (
                <time
                  className={`${styles.bodySmall} ${styles.muted} ${styles.noWrap}`}
                >
                  {mention.date}
                </time>
              )}
            </div>
            <div
              className={`${styles.bodySmall} ${styles.muted}`}
              style={{ marginTop: "0.125rem" }}
            >
              {mention.source}
              {mention.url && <span> &#8599;</span>}
            </div>
            {mention.excerpt && (
              <p
                className={styles.bodySmall}
                style={{
                  marginTop: "0.375rem",
                  opacity: 0.75,
                  lineHeight: 1.4,
                }}
              >
                &ldquo;{mention.excerpt}&rdquo;
              </p>
            )}
          </BlockListCard>
        ))}
      </div>
    </BlockSection>
  );
}
