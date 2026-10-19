"use client";

import { useState, useCallback } from "react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { useAnchorId } from "@/hooks/useAnchorId";

import { BlockSection, BlockHeading } from "./block-primitives";
import styles from "./block-primitives.module.css";

// ── Data shape ─────────────────────────────────────────────────────────────

type FaqItem = {
  question: string;
  answer: string;
};

type FaqData = {
  heading?: string;
  items?: FaqItem[];
};

// ── Collapsible item ───────────────────────────────────────────────────────

function FaqItemRow({ item }: { item: FaqItem }) {
  const [open, setOpen] = useState(false);
  // Per-INSTANCE, not `faq-panel-${index}`: that already collided whenever a
  // page carried two FAQ blocks, and the entity page editor now mounts the
  // whole page twice (hidden authoring copy + preview), so every row collided.
  const panelId = useAnchorId("faq-panel");

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <div className={styles.faqItem} data-open={open || undefined}>
      <button
        type="button"
        className={styles.faqTrigger}
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className={styles.faqQuestion}>{item.question}</span>
        <span className={styles.faqChevron} aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        className={styles.faqPanel}
        style={{ display: open ? "block" : "none" }}
      >
        <div className={styles.faqAnswer}>{item.answer}</div>
      </div>
    </div>
  );
}

// ── Block component ────────────────────────────────────────────────────────

type Props = {
  block: PageBlockRecord;
};

export function FaqBlock({ block }: Props) {
  const data = block.data as FaqData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "FAQ";
  const items = data?.items;

  if (!items || items.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.faqList}>
        {items.map((item, i) => (
          <FaqItemRow key={i} item={item} />
        ))}
      </div>
    </BlockSection>
  );
}
