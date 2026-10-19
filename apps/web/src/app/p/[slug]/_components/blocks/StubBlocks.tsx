"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading, BlockEmpty } from "./block-primitives";

type Props = {
  block: PageBlockRecord;
};

type StubBlockData = {
  heading?: string;
};

/**
 * Stub block for kinds that require backend data integration.
 * Renders a section heading with a "coming soon" indicator.
 * These will be replaced with real implementations as the data pipelines land.
 */
function StubBlock({
  block,
  defaultHeading,
}: Props & { defaultHeading: string }) {
  const data = block.data as StubBlockData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? defaultHeading;

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <BlockEmpty>Content coming soon.</BlockEmpty>
    </BlockSection>
  );
}

// ── Place stubs ────────────────────────────────────────────────────────────

/** Auto-populated from EventHuman at this place. */
export function ResidentArtistsBlock({ block }: Props) {
  return <StubBlock block={block} defaultHeading="Resident Artists" />;
}

// ── Org stubs ──────────────────────────────────────────────────────────────

/** Auto-populated places the org manages. */
export function ManagedPlacesBlock({ block }: Props) {
  return <StubBlock block={block} defaultHeading="Our Places" />;
}

/** Auto-populated completed events. */
export function PastEventsBlock({ block }: Props) {
  return <StubBlock block={block} defaultHeading="Past Events" />;
}
