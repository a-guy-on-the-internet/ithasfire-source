"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

/**
 * Wraps a rendered block with editor chrome.
 *
 * The page-editor canvas renders the REAL page components (EntityPageContent →
 * the owner-type template → BlockRenderer). To make that canvas editable
 * without forking the layouts, the editor supplies a wrapper here and
 * `BlockRenderer` — the single choke point every template funnels through —
 * applies it. Returning `content` unchanged is always valid.
 *
 * Defaults to `null` so the public page renders byte-identically with no
 * provider mounted.
 */
export type BlockChromeRenderer = (args: {
  block: PageBlockRecord;
  content: ReactNode;
}) => ReactNode;

const BlockChromeContext = createContext<BlockChromeRenderer | null>(null);

export function BlockChromeProvider({
  renderChrome,
  children,
}: {
  renderChrome: BlockChromeRenderer;
  children: ReactNode;
}) {
  return (
    <BlockChromeContext.Provider value={renderChrome}>
      {children}
    </BlockChromeContext.Provider>
  );
}

export function useBlockChrome(): BlockChromeRenderer | null {
  return useContext(BlockChromeContext);
}
