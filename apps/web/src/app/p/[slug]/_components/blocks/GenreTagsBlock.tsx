"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { Chip } from "@th/ui";

import { BlockSection, BlockHeading } from "./block-primitives";
import styles from "./block-primitives.module.css";

type GenreTagsData = {
  heading?: string;
  tags?: string[];
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders genre tags as a row of pills using `@th/ui` Chip.
 */
export function GenreTagsBlock({ block }: Props) {
  const data = block.data as GenreTagsData | undefined;
  if (!data) return null;
  const heading = data?.heading;
  const tags = data?.tags;

  if (!tags || tags.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      {heading && <BlockHeading>{heading}</BlockHeading>}
      <div className={styles.chipRow}>
        {tags.map((tag, i) => (
          <Chip
            key={i}
            tone="neutral"
            variant="subtle"
            size="sm"
            interactive={false}
          >
            {tag}
          </Chip>
        ))}
      </div>
    </BlockSection>
  );
}
