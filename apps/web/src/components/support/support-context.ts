"use client";

import { usePathname } from "next/navigation";
import { useMemo } from "react";

/**
 * Best-effort order-aware context for the support widget.
 *
 * The backend `support.sendMessage` accepts optional `eventId` / `orderId`
 * (both UUIDs). We derive them from the current route so the operator sees
 * which order a question is about without asking — FR-003.
 *
 * Caveats:
 * - The public event route (`/events/[...slug]`) is slug-based, NOT a UUID,
 *   so we cannot pass `eventId` from the URL without failing the UUID schema.
 *   Event context is therefore omitted here (left for a future enhancement
 *   that resolves slug → id). Context is explicitly best-effort per the spec.
 * - The order route (`/my-tickets/[orderId]`) carries a UUID, so we capture it.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupportRouteContext {
  eventId?: string;
  orderId?: string;
}

/** Read best-effort order context from the current pathname. */
export function useSupportRouteContext(): SupportRouteContext {
  const pathname = usePathname();

  return useMemo(() => {
    if (!pathname) {
      return {};
    }

    const segments = pathname.split("/").filter(Boolean);

    // /my-tickets/<orderId> → capture a UUID order id.
    if (segments[0] === "my-tickets" && segments[1]) {
      const candidate = segments[1];
      if (UUID_RE.test(candidate)) {
        return { orderId: candidate };
      }
    }

    return {};
  }, [pathname]);
}
