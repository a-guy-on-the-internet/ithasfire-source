"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading } from "./block-primitives";
import styles from "./block-primitives.module.css";

type HouseRulesData = {
  heading?: string;
  rules?: string[];
  notes?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders venue house rules / policies.
 */
export function HouseRulesBlock({ block }: Props) {
  const data = block.data as HouseRulesData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "House Rules";
  const rules = data?.rules;

  if (!rules || rules.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <ul
        style={{
          listStyle: "disc",
          paddingLeft: "1.25rem",
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.375rem",
        }}
      >
        {rules.map((rule, i) => (
          <li
            key={i}
            className={styles.bodyDefault}
            style={{ lineHeight: 1.5, opacity: 0.85 }}
          >
            {rule}
          </li>
        ))}
      </ul>
      {data.notes && (
        <p
          className={`${styles.bodySmall} ${styles.muted} ${styles.italic}`}
          style={{ marginTop: "0.75rem" }}
        >
          {data.notes}
        </p>
      )}
    </BlockSection>
  );
}
