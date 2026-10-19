"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Centralizes `document.title` for client-rendered areas that can't export
 * Next metadata. A single writer composes three inputs by priority:
 *
 *   [unread prefix] + (specific ?? fallback)
 *
 * - `fallback` is set by area shells (e.g. "Orders · Demo Org").
 * - `specific` is set by detail pages and wins over the shell (e.g.
 *   "Attendees · Summer Fest"), so deep history stays distinguishable.
 * - `unread` prefixes a "(N) " badge so backgrounded tabs surface activity.
 *
 * When nothing is registered (server pages with their own metadata), the
 * writer is a no-op and Next's metadata title stands.
 */
type DocumentTitleContextValue = {
  setFallback: (title: string | null) => void;
  setSpecific: (title: string | null) => void;
  setUnreadCount: (count: number | undefined) => void;
};

const DocumentTitleContext = createContext<DocumentTitleContextValue | null>(
  null,
);

export function DocumentTitleProvider({ children }: { children: ReactNode }) {
  const [fallback, setFallback] = useState<string | null>(null);
  const [specific, setSpecific] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    const base = specific ?? fallback;
    if (!base) return;
    const prefix = unreadCount && unreadCount > 0 ? `(${unreadCount}) ` : "";
    document.title = `${prefix}${base}`;
  }, [fallback, specific, unreadCount]);

  // State setters are stable, so the context value never changes identity.
  const value = useMemo(
    () => ({ setFallback, setSpecific, setUnreadCount }),
    [],
  );

  return (
    <DocumentTitleContext.Provider value={value}>
      {children}
    </DocumentTitleContext.Provider>
  );
}

export function useDocumentTitleContext() {
  return useContext(DocumentTitleContext);
}
