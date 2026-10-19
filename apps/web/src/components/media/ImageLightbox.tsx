"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "@th/ui";

import styles from "./image-lightbox.module.css";

export type LightboxImage = {
  url: string;
  alt?: string;
  caption?: string;
};

type Props = {
  images: LightboxImage[];
  /** Index of the image to open first. */
  startIndex?: number;
  onClose: () => void;
};

/**
 * Accessible, uncropped full-image viewer. Renders into a body portal (escapes
 * the admin shell's clipping/scroll contexts), traps focus, closes on Esc /
 * backdrop click, and navigates with arrow keys when there is more than one
 * image. Images are shown with `object-fit: contain` so nothing is cropped.
 */
export function ImageLightbox({ images, startIndex = 0, onClose }: Props) {
  const t = useTranslations();
  const count = images.length;
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(startIndex, Math.max(0, count - 1))),
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);

  const goPrev = useCallback(
    () => setIndex((i) => (i - 1 + count) % count),
    [count],
  );
  const goNext = useCallback(() => setIndex((i) => (i + 1) % count), [count]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Defer focus so the portal node is in the DOM.
    const focusId = window.setTimeout(() => closeRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && count > 1) {
        event.preventDefault();
        goPrev();
        return;
      }
      if (event.key === "ArrowRight" && count > 1) {
        event.preventDefault();
        goNext();
        return;
      }
      if (event.key === "Tab") {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const list = Array.from(focusables);
        const first = list[0];
        const last = list[list.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.clearTimeout(focusId);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose, goPrev, goNext, count]);

  if (!mounted || count === 0) return null;

  const current = images[Math.max(0, Math.min(index, count - 1))];

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={String(t("common.photoViewer"))}
      >
        <button
          ref={closeRef}
          type="button"
          className={`${styles.control} ${styles.close}`}
          onClick={onClose}
          aria-label={String(t("common.close"))}
        >
          <X size={18} aria-hidden />
        </button>

        {count > 1 && (
          <button
            type="button"
            className={`${styles.control} ${styles.nav} ${styles.prev}`}
            onClick={goPrev}
            aria-label={String(t("common.previousPhoto"))}
          >
            <ChevronLeft size={22} aria-hidden />
          </button>
        )}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.image}
          src={current.url}
          alt={current.alt ?? ""}
        />

        {count > 1 && (
          <button
            type="button"
            className={`${styles.control} ${styles.nav} ${styles.next}`}
            onClick={goNext}
            aria-label={String(t("common.nextPhoto"))}
          >
            <ChevronRight size={22} aria-hidden />
          </button>
        )}

        {(current.caption || count > 1) && (
          <div className={styles.meta}>
            {current.caption && (
              <p className={styles.caption}>{current.caption}</p>
            )}
            {count > 1 && (
              <span className={styles.counter}>
                {index + 1} / {count}
              </span>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
