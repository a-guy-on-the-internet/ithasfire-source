"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Some blocks render differently in the page builder than on the live public
 * page (e.g. `request_to_play` shows an owner-facing placeholder in the editor
 * but a live CTA on the public page). Blocks read this context to decide which
 * variant to render. Defaults to `"public"` so the live page needs no provider.
 */
export type BlockRenderMode = "public" | "editor";

const BlockRenderModeContext = createContext<BlockRenderMode>("public");

export function BlockRenderModeProvider({
  mode,
  children,
}: {
  mode: BlockRenderMode;
  children: ReactNode;
}) {
  return (
    <BlockRenderModeContext.Provider value={mode}>
      {children}
    </BlockRenderModeContext.Provider>
  );
}

export function useBlockRenderMode(): BlockRenderMode {
  return useContext(BlockRenderModeContext);
}
