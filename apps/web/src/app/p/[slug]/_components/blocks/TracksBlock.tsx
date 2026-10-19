"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading } from "./block-primitives";
import { EpkEmbed } from "./epk-embed";
import styles from "./block-primitives.module.css";

type TrackItem = {
  url?: string;
  /** Optional freeform note, e.g. "festival closer", "sync-friendly". */
  label?: string;
};

type TracksData = {
  heading?: string;
  tracks?: TrackItem[];
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Owner-curated, labeled track list (FR-006): up to 10 specific track embeds,
 * each with an optional freeform label flagging what the track is for. Visually
 * distinct from the profile-level `music` widget via the per-track caption.
 */
export function TracksBlock({ block }: Props) {
  const data = block.data as TracksData | undefined;
  if (!data) return null;

  const heading = data.heading ?? "Tracks";
  const tracks = data.tracks?.filter(
    (item): item is TrackItem & { url: string } =>
      typeof item?.url === "string" && item.url.trim().length > 0,
  );
  if (!tracks || tracks.length === 0) return null;

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "1rem" }}>
        {tracks.map((track, i) => (
          <div key={i}>
            <EpkEmbed url={track.url} />
            {track.label && (
              <p
                className={`${styles.bodySmall} ${styles.muted}`}
                style={{ marginTop: "0.375rem" }}
              >
                {track.label}
              </p>
            )}
          </div>
        ))}
      </div>
    </BlockSection>
  );
}
