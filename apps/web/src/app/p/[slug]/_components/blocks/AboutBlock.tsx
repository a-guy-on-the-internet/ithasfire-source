"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading, BlockBodyText } from "./block-primitives";

type AboutData = {
  content?: string;
  heading?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders a rich-text "about" section.
 * `block.data` may contain `{ content: string, heading?: string }`.
 */
export function AboutBlock({ block }: Props) {
  const data = block.data as AboutData | undefined;
  if (!data) return null;
  const content = data?.content;
  const heading = data?.heading ?? "About";

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
