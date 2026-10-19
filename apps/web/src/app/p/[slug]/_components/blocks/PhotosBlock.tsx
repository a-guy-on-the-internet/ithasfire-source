"use client";

import { useState } from "react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { Download } from "lucide-react";
import { useTranslations } from "@th/ui";

import { BlockSection, BlockHeading } from "./block-primitives";
import { getSafeExternalHref } from "./safe-block-url";
import { ImageLightbox } from "@/components/media/ImageLightbox";
import styles from "./block-primitives.module.css";

type PhotoItem = {
  url: string;
  alt?: string;
  caption?: string;
  /** Press-asset flag (FR-008): offer a direct download in addition to display. */
  downloadable?: boolean;
};

type PhotosData = {
  photos?: PhotoItem[];
  heading?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders a photo gallery grid.
 * `block.data` should contain `{ photos: [{ url, alt?, caption? }], heading? }`.
 */
export function PhotosBlock({ block }: Props) {
  const t = useTranslations();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const data = block.data as PhotosData | undefined;
  const photos = data?.photos
    ?.map((photo) => ({ ...photo, url: getSafeExternalHref(photo.url) }))
    .filter((photo): photo is PhotoItem => Boolean(photo.url));
  const heading = data?.heading ?? "Photos";

  if (!data || !photos || photos.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.gridAutoFill}>
        {photos.map((photo, i) => (
          <figure key={`${photo.url}-${i}`} className={styles.photoFigure}>
            {/* Thumbnails stay square-cropped for a tidy grid; clicking opens
                the uncropped image in an accessible lightbox. */}
            <button
              type="button"
              className={styles.photoButton}
              onClick={() => setLightboxIndex(i)}
              aria-label={
                photo.alt
                  ? String(t("common.viewPhotoNamed", { name: photo.alt }))
                  : String(t("common.viewPhoto"))
              }
            >
              <img
                src={photo.url}
                alt={photo.alt ?? ""}
                loading="lazy"
                className={styles.photoImg}
              />
            </button>
            {photo.caption && (
              <figcaption className={styles.photoCaption}>
                {photo.caption}
              </figcaption>
            )}
            {photo.downloadable && (
              <a
                href={photo.url}
                download
                target="_blank"
                rel="noopener noreferrer"
                className={styles.photoDownload}
              >
                <Download size={12} aria-hidden />
                Download
              </a>
            )}
          </figure>
        ))}
      </div>

      {lightboxIndex !== null && (
        <ImageLightbox
          images={photos.map((p) => ({
            url: p.url,
            alt: p.alt,
            caption: p.caption,
          }))}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </BlockSection>
  );
}
