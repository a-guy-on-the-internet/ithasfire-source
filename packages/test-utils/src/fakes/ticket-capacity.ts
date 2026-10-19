import { vi } from "vitest";

import type { TicketTypeCapacityUsage } from "@th/ports/repos/tickets";

/**
 * A minimal fake of the `tickets` repo's LOCK-FREE batch capacity read — the
 * only tickets method the public listing surfaces (`listEventTicketTypes`,
 * `getEmbedEventDetail`) touch.
 *
 * Pass per-ticket-type usage; ids absent from the map resolve to
 * `{ issued: 0, held: 0 }`, mirroring the adapter's zero-fill contract (one
 * entry per DISTINCT requested id, never an omission). The returned function is
 * a `vi.fn` so tests can assert the ONE-BATCHED-CALL invariant — an N+1 here
 * would be a per-tier round trip on the hottest read in the product.
 *
 * Note `held` is COUNTED by these surfaces (unlike the POS listing); see
 * `packages/core/src/use-cases/_helpers/load-ticket-type-availability.ts`.
 */
// The return type is INFERRED, not annotated: an explicit
// `ReturnType<typeof vi.fn>` widens the args tuple to `any[]`, which vitest 1.x's
// invariant `Mock<TArgs, TReturn>` refuses for a callback taking a
// `readonly string[]`. Inference keeps both the precise signature and the mock
// helpers (`.mock.calls`, `toHaveBeenCalledWith`) that call sites assert on.
export function makeTicketCapacityUsageFake(
  usageById: Record<string, { issued?: number; held?: number }> = {},
) {
  const countCapacityUsageForTicketTypes = vi.fn(
    async ({
      ticketTypeIds,
    }: {
      ticketTypeIds: readonly string[];
      now: Date;
    }): Promise<TicketTypeCapacityUsage[]> =>
      [...new Set(ticketTypeIds)].map((ticketTypeId) => ({
        ticketTypeId,
        issued: usageById[ticketTypeId]?.issued ?? 0,
        held: usageById[ticketTypeId]?.held ?? 0,
      })),
  );

  return { tickets: { countCapacityUsageForTicketTypes } };
}
