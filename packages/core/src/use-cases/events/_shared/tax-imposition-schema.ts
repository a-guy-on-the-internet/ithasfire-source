import { z } from "zod";

/**
 * One tax line as quoted to a client: the wire shape of `TaxImposition`
 * (`lib/pricing/tax-impositions.ts`). Shared by `getCheckoutFeeRates` and
 * `estimateCheckoutTax` so the two quotes cannot drift apart.
 */
export const taxImpositionSchema = z.object({
  code: z.string(),
  label: z.string(),
  jurisdiction: z.string(),
  rateBps: z.number().int().positive(),
  base: z.enum(["TICKET_FACE", "BUYER_TOTAL"]),
  collector: z.enum(["PLATFORM", "ORGANISER"]),
});

export type TaxImpositionOutput = z.infer<typeof taxImpositionSchema>;

/**
 * The base shared by every PLATFORM imposition, or null when they differ or
 * there are none. ORGANISER lines are disclosure only and never charged, so
 * they do not count.
 */
export function uniformPlatformTaxBase(
  impositions: ReadonlyArray<Pick<TaxImpositionOutput, "base" | "collector">>,
): "TICKET_FACE" | "BUYER_TOTAL" | null {
  const bases = new Set(
    impositions.filter((i) => i.collector === "PLATFORM").map((i) => i.base),
  );
  if (bases.size !== 1) return null;
  return [...bases][0] ?? null;
}
