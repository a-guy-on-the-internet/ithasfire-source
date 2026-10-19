"use client";

import { Fragment } from "react";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { BlockSection, BlockHeading } from "./block-primitives";
import styles from "./block-primitives.module.css";

type TechSpecItem = {
  label?: string;
  value?: string;
};

type TechSpecsData = {
  heading?: string;
  specs?: TechSpecItem[];
  notes?: string;
};

type Props = {
  block: PageBlockRecord;
};

type SpecRow = { label: string; value: string };

/**
 * Renders the venue tech-spec sheet — the venue-side counterpart of the artist
 * `rider` block: PA / console / monitors / backline / stage / power / load-in
 * facts an artist needs to advance a show. A two-column label/value sheet
 * (semantic `<dl>`), with an optional free-text notes paragraph below.
 *
 * Rows missing a label or a value are skipped; when nothing survives and there
 * are no notes, the block renders nothing (matching the other venue-fact
 * blocks' empty behaviour).
 */
export function TechSpecsBlock({ block }: Props) {
  const t = useTranslations();
  const data = block.data as TechSpecsData | undefined;
  if (!data) return null;
  const heading = data.heading ?? String(t("techSpecs.heading"));

  const rows: SpecRow[] = (Array.isArray(data.specs) ? data.specs : [])
    .map((item) => ({
      label: typeof item?.label === "string" ? item.label.trim() : "",
      value: typeof item?.value === "string" ? item.value.trim() : "",
    }))
    .filter((item): item is SpecRow => item.label !== "" && item.value !== "");

  const notes = typeof data.notes === "string" ? data.notes.trim() : "";

  if (rows.length === 0 && !notes) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      {rows.length > 0 && (
        <dl className={styles.specList}>
          {rows.map((row, i) => (
            <Fragment key={i}>
              <dt className={styles.specLabel}>{row.label}</dt>
              <dd className={styles.specValue}>{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {notes && (
        <p
          className={`${styles.bodySmall} ${styles.muted} ${styles.italic}`}
          style={{ marginTop: rows.length > 0 ? "0.75rem" : 0 }}
        >
          {notes}
        </p>
      )}
    </BlockSection>
  );
}
