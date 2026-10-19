"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { getBlockComponent } from "./block-registry";
import { BlockFallback } from "./BlockFallback";
import { useBlockChrome } from "./block-chrome-context";

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders a single page block by looking up the component from the registry.
 * Falls back to `BlockFallback` (dev-only warning) for unknown kinds.
 *
 * This is the ONE place every entity-page template renders a block, so it is
 * also where the page editor injects its per-block chrome (drag handle,
 * settings, hide/show). With no `BlockChromeProvider` mounted — i.e. on the
 * public page — the output is unchanged.
 */
export function BlockRenderer({ block }: Props) {
  const Component = getBlockComponent(block.kind);
  const renderChrome = useBlockChrome();

  const content = Component ? (
    <Component block={block} />
  ) : (
    <BlockFallback block={block} />
  );

  if (!renderChrome) return content;
  return <>{renderChrome({ block, content })}</>;
}
