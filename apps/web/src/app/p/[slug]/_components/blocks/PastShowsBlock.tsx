"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { ShowsBlockBase } from "./ShowsBlock";

type Props = {
  block: PageBlockRecord;
};

/**
 * Past performances — same server-built `dataSource: "shows"` payload as
 * `ShowsBlock`, capped at 20 server-side and ordered most-recent first.
 */
export function PastShowsBlock({ block }: Props) {
  return <ShowsBlockBase block={block} defaultHeading="Past shows" />;
}
