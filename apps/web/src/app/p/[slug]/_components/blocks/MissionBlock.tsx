"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading, BlockBodyText } from "./block-primitives";

type MissionData = {
  heading?: string;
  content?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders an organization's mission statement.
 */
export function MissionBlock({ block }: Props) {
  const data = block.data as MissionData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "Our Mission";
  const content = data?.content;

  if (!content) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <BlockBodyText>{content}</BlockBodyText>
    </BlockSection>
  );
}
