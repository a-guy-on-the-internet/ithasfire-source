"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { Chip } from "@th/ui";

import { BlockSection, BlockHeading } from "./block-primitives";
import styles from "./block-primitives.module.css";

type AmenitiesData = {
  heading?: string;
  amenities?: string[];
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders venue amenities (parking, accessibility, etc.) using `@th/ui` Chip.
 */
export function AmenitiesBlock({ block }: Props) {
  const data = block.data as AmenitiesData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "Amenities";
  const amenities = data?.amenities;

  if (!amenities || amenities.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={`${styles.chipRow} ${styles.chipRowOnPageSurface}`}>
        {amenities.map((amenity, i) => (
          <Chip
            key={i}
            tone="neutral"
            variant="outline"
            size="sm"
            interactive={false}
          >
            {amenity}
          </Chip>
        ))}
      </div>
    </BlockSection>
  );
}
