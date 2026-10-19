"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading } from "./block-primitives";
import { EpkEmbed } from "./epk-embed";
import styles from "./block-primitives.module.css";

type MusicEmbedItem = {
  provider?: string;
  url?: string;
};

type MusicData = {
  heading?: string;
  embeds?: MusicEmbedItem[];
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Owner-curated "listen" widget (FR-005): up to 3 primary artist-profile
 * embeds. This is the profile-level player — the curated, per-track list lives
 * in the `tracks` block.
 */
export function MusicBlock({ block }: Props) {
  const data = block.data as MusicData | undefined;
  if (!data) return null;

  const heading = data.heading ?? "Listen";
  const embeds = data.embeds?.filter(
    (item): item is { url: string } =>
      typeof item?.url === "string" && item.url.trim().length > 0,
  );
  if (!embeds || embeds.length === 0) return null;

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "1rem" }}>
        {embeds.map((embed, i) => (
          <EpkEmbed key={i} url={embed.url} />
        ))}
      </div>
    </BlockSection>
  );
}
