"use client";

import { useEffect } from "react";

import { useDocumentTitleContext } from "@/components/providers/DocumentTitleProvider";

/**
 * Sets a *specific* browser tab/history title that wins over the area shell's
 * fallback. Use on detail pages (event editor, place editor) so deep history
 * is distinguishable. Pass a falsy value to skip (e.g. while data loads).
 */
export function useDocumentTitle(title: string | null | undefined) {
  const ctx = useDocumentTitleContext();
  useEffect(() => {
    if (!ctx) {
      if (title) document.title = title;
      return;
    }
    ctx.setSpecific(title ?? null);
    return () => ctx.setSpecific(null);
  }, [ctx, title]);
}

/**
 * Sets the *fallback* title for a whole area (admin/platform/sell/account
 * shells). A detail page's `useDocumentTitle` overrides it when present.
 */
export function useDocumentTitleFallback(title: string | null | undefined) {
  const ctx = useDocumentTitleContext();
  useEffect(() => {
    if (!ctx) {
      if (title) document.title = title;
      return;
    }
    ctx.setFallback(title ?? null);
    return () => ctx.setFallback(null);
  }, [ctx, title]);
}

/**
 * Prefixes the tab title with an unread badge, e.g. "(3) Orders · Demo Org",
 * so backgrounded tabs surface activity.
 */
export function useDocumentTitleUnread(count: number | undefined) {
  const ctx = useDocumentTitleContext();
  useEffect(() => {
    if (!ctx) return;
    ctx.setUnreadCount(count);
    return () => ctx.setUnreadCount(undefined);
  }, [ctx, count]);
}
