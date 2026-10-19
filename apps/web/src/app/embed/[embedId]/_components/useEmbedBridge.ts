import { useCallback, useEffect, useRef } from "react";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";
import type { Screen } from "./embed-types";

// ─────────────────────────────────────────────────────────────────────────────
// Message types
// ─────────────────────────────────────────────────────────────────────────────

export type HfMessageType =
  | "hf:ready"
  | "hf:resize"
  | "hf:navigate"
  | "hf:orderComplete"
  | "hf:cartUpdate";

export type HfMessage =
  | { type: "hf:ready"; embedId: string }
  | { type: "hf:resize"; height: number }
  | { type: "hf:navigate"; screen: Screen }
  | {
      type: "hf:orderComplete";
      orderId: string;
      totalCents: number;
      currency: string;
    }
  | {
      type: "hf:cartUpdate";
      items: Array<{ ticketTypeId: string; qty: number }>;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 100;
const HEIGHT_TOLERANCE = 2;
// Ceiling against a resize feedback loop (an element sized in viewport units
// grows with the iframe, the widget reports it, the host grows the iframe).
// Set above the widget's tallest real list: 50 poster cards in one column are
// ~36,200px, so 50000 never clips a real list.
const MAX_HEIGHT = 50000;

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useEmbedBridge(embedId: string, screen: Screen) {
  const lastHeightRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenRef = useRef<Screen>(screen);

  const isInIframe = typeof window !== "undefined" && window.parent !== window;

  const post = useCallback(
    (msg: HfMessage) => {
      if (!isInIframe) return;
      // Target ONLY the verified embedding origin (ancestorOrigins / referrer)
      // — never "*". Messages like hf:orderComplete carry order data
      // (orderId, totalCents) that must not be broadcast to an arbitrary
      // parent. When the host origin is unknown, don't post at all.
      const targetOrigin = getEmbedHostOrigin();
      if (!targetOrigin) return;
      window.parent.postMessage(msg, targetOrigin);
    },
    [isInIframe],
  );

  // ── Ready on mount ──────────────────────────────────────────────
  useEffect(() => {
    post({ type: "hf:ready", embedId });
  }, [post, embedId]);

  // ── Navigate on screen change ───────────────────────────────────
  useEffect(() => {
    if (screenRef.current !== screen) {
      screenRef.current = screen;
      post({ type: "hf:navigate", screen });
    }
  }, [screen, post]);

  // ── Resize observer ─────────────────────────────────────────────
  useEffect(() => {
    if (!isInIframe) return;

    const observer = new ResizeObserver(() => {
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        const height = Math.min(
          Math.ceil(document.body.scrollHeight),
          MAX_HEIGHT,
        );
        if (Math.abs(height - lastHeightRef.current) > HEIGHT_TOLERANCE) {
          lastHeightRef.current = height;
          post({ type: "hf:resize", height });
        }
      }, DEBOUNCE_MS);
    });

    observer.observe(document.body);

    return () => {
      observer.disconnect();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isInIframe, post]);

  // ── Imperative emitters ─────────────────────────────────────────
  const emitOrderComplete = useCallback(
    (orderId: string, totalCents: number, currency: string) => {
      post({ type: "hf:orderComplete", orderId, totalCents, currency });
    },
    [post],
  );

  const emitCartUpdate = useCallback(
    (items: Array<{ ticketTypeId: string; qty: number }>) => {
      post({
        type: "hf:cartUpdate",
        items: items.map((i) => ({ ticketTypeId: i.ticketTypeId, qty: i.qty })),
      });
    },
    [post],
  );

  return { emitOrderComplete, emitCartUpdate };
}
