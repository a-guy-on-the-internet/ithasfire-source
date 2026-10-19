"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading, BlockPillLink } from "./block-primitives";
import { getSafeExternalHref } from "./safe-block-url";
import styles from "./block-primitives.module.css";

type VideoItem = {
  url: string;
  title?: string;
};

type VideoData = {
  heading?: string;
  videos?: VideoItem[];
};

type Props = {
  block: PageBlockRecord;
};

/**
 * YouTube/Vimeo oEmbed regex for extracting video IDs.
 */
const YOUTUBE_RE =
  /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

function getYouTubeEmbedUrl(url: string): string | null {
  const safeUrl = getSafeExternalHref(url);
  if (!safeUrl) return null;
  const match = safeUrl.match(YOUTUBE_RE);
  return match ? `https://www.youtube-nocookie.com/embed/${match[1]}` : null;
}

/**
 * Renders video embeds (YouTube for now, extensible later).
 */
export function VideoBlock({ block }: Props) {
  const data = block.data as VideoData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "Videos";
  const videos = data?.videos;

  if (!videos || videos.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "1rem" }}>
        {videos.map((video, i) => {
          const safeUrl = getSafeExternalHref(video.url);
          if (!safeUrl) return null;

          const embedUrl = getYouTubeEmbedUrl(safeUrl);

          if (embedUrl) {
            return (
              <div key={i}>
                <div className={styles.videoWrapper}>
                  <iframe
                    src={embedUrl}
                    title={video.title ?? `Video ${i + 1}`}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className={styles.videoIframe}
                  />
                </div>
                {video.title && (
                  <p
                    className={`${styles.bodySmall} ${styles.muted}`}
                    style={{ marginTop: "0.375rem" }}
                  >
                    {video.title}
                  </p>
                )}
              </div>
            );
          }

          // Fallback: plain link
          return (
            <BlockPillLink key={i} href={safeUrl} external>
              {video.title || safeUrl} &#8599;
            </BlockPillLink>
          );
        })}
      </div>
    </BlockSection>
  );
}
