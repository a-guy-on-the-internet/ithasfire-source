"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading } from "./block-primitives";
import styles from "./block-primitives.module.css";

type CapacityInfoData = {
  heading?: string;
  totalCapacity?: number;
  standing?: number;
  seated?: number;
  notes?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders venue capacity information.
 */
export function CapacityInfoBlock({ block }: Props) {
  const data = block.data as CapacityInfoData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "Capacity";

  if (!data?.totalCapacity && !data?.standing && !data?.seated) {
    return null;
  }

  const items: Array<{ label: string; value: string }> = [];
  if (data.totalCapacity)
    items.push({ label: "Total", value: data.totalCapacity.toLocaleString() });
  if (data.standing)
    items.push({ label: "Standing", value: data.standing.toLocaleString() });
  if (data.seated)
    items.push({ label: "Seated", value: data.seated.toLocaleString() });

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.statGroup}>
        {items.map((item) => (
          <div key={item.label} className={styles.statItem}>
            <div className={styles.statValue}>{item.value}</div>
            <div className={styles.statLabel}>{item.label}</div>
          </div>
        ))}
      </div>
      {data.notes && (
        <p style={{ marginTop: "0.75rem", fontSize: "0.875rem", opacity: 0.7 }}>
          {data.notes}
        </p>
      )}
    </BlockSection>
  );
}
