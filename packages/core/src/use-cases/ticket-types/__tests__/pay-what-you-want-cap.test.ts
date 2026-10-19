import { describe, expect, it } from "vitest";

import { MAX_DONATION_AMOUNT_CENTS } from "../../../lib/pricing/pay-what-you-want";
import { updateTicketTypeInputSchema } from "../update-ticket-type";
import { upsertTicketTypeInputSchema } from "../upsert-ticket-type";

/**
 * A pay-what-you-want tier's minimum and suggestion are capped at the same
 * $10,000.00 per ticket that checkout enforces. Uncapped, an organiser could
 * save a minimum no buyer could ever pay (checkout refuses anything above the
 * cap) or a suggestion checkout would refuse to hold as the default.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TT_ID = "22222222-2222-4222-8222-222222222222";

const issueFor = (
  result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } },
  field: string,
) => result.error?.issues.find((issue) => issue.path.includes(field));

describe("ticket-type PWYW amounts are capped at $10,000.00", () => {
  const upsert = (field: string, cents: number) =>
    upsertTicketTypeInputSchema.safeParse({
      eventId: EVENT_ID,
      name: "Pay What You Want",
      priceCents: 0,
      pricingMode: "ADJUSTABLE",
      capacity: 100,
      [field]: cents,
    });
  const update = (field: string, cents: number) =>
    updateTicketTypeInputSchema.safeParse({
      eventId: EVENT_ID,
      ticketTypeId: TT_ID,
      [field]: cents,
    });

  it.each([
    ["upsertTicketType", upsert],
    ["updateTicketType", update],
  ] as const)("%s refuses one cent over on minimum AND suggestion", (_name, parse) => {
    for (const field of ["minimumCents", "suggestedCents"]) {
      expect(
        issueFor(parse(field, MAX_DONATION_AMOUNT_CENTS + 1), field)?.message,
      ).toMatch(/capped at \$10,000\.00 per ticket/);
      expect(
        issueFor(parse(field, MAX_DONATION_AMOUNT_CENTS), field),
      ).toBeUndefined();
    }
  });
});
