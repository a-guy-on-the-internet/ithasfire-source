import { describe, expect, it } from "vitest";
import { eventSummaryDtoSchema } from "@th/types";

import {
  countryEventToDto,
  discoverEventToDto,
  discoveredEventToDto,
  localEventToDto,
} from "./event-summary-mapper";

/**
 * The card stamps its date and start time from `startsAt` in the DTO's
 * `timezone`. Without the field on the wire the card fell back to the
 * renderer's zone: "12:00 AM" in the UTC server HTML, "7:00 PM" in a Nashville
 * browser, a hydration mismatch on every home load (prod, 2026-10-15).
 *
 * So each DB-backed mapper must emit the zone `date` was formatted in, and the
 * zone must survive the procedures' `.output(eventSummaryDtoSchema)` parse
 * (zod strips undeclared keys, which would silently drop it again).
 */
describe("event summary DTO carries the event's timezone", () => {
  // Thu 15 Oct 2026, 7:00 PM CDT = 00:00Z Friday.
  const THURSDAY_7PM_CDT = new Date("2026-10-16T00:00:00.000Z");
  const plain = (text: string) => text.replace(/[  ]/g, " ");

  const base = {
    title: "Open Mic",
    status: "PUBLISHED",
    slug: null,
    startsAt: THURSDAY_7PM_CDT,
    addressText: "134 W Broadway, Gallatin, TN 37066",
    regionCode: "tn",
    heroImageUrl: null,
  };

  const producers = {
    countryEventToDto: (timezone?: string | null) =>
      countryEventToDto({ ...base, eventId: "evt_1", timezone }),
    localEventToDto: (timezone?: string | null) =>
      localEventToDto({ ...base, id: "evt_1", timezone }),
    discoverEventToDto: (timezone?: string | null) =>
      discoverEventToDto({ ...base, id: "evt_1", timezone }),
  };

  describe.each(Object.entries(producers))("%s", (_, produce) => {
    it("emits the zone `date` was formatted in, and it survives the wire schema", () => {
      const dto = eventSummaryDtoSchema.parse(produce("America/Los_Angeles"));
      expect(dto.timezone).toBe("America/Los_Angeles");
      expect(plain(dto.date)).toBe("Thu, Oct 15, 5:00 PM");
      expect(dto.startsAt).toBe("2026-10-16T00:00:00.000Z");
    });

    it("emits the platform default when the event's zone is missing or unusable", () => {
      for (const zone of [undefined, null, "Mars/Olympus_Mons"]) {
        const dto = eventSummaryDtoSchema.parse(produce(zone));
        expect(dto.timezone).toBe("America/Chicago");
        expect(plain(dto.date)).toBe("Thu, Oct 15, 7:00 PM");
      }
    });
  });

  describe("discoveredEventToDto (search hits)", () => {
    const hit = (extra: { timezone?: string | null; helper?: string | null }) =>
      discoveredEventToDto({
        id: "evt_1",
        eventId: "evt_1",
        title: "Open Mic",
        subtitle: null,
        helper: "Oct 15",
        slug: null,
        startsAt: THURSDAY_7PM_CDT,
        imageUrl: null,
        ...extra,
      });

    it("emits the indexed zone, and it survives the wire schema", () => {
      const dto = eventSummaryDtoSchema.parse(
        hit({ timezone: "America/Los_Angeles" }),
      );
      expect(dto.timezone).toBe("America/Los_Angeles");
      expect(dto.date).toBe("Oct 15");
      expect(dto.startsAt).toBe("2026-10-16T00:00:00.000Z");
    });

    it("falls back to the platform default on a document indexed before the zone was stored", () => {
      for (const zone of [undefined, null, "Mars/Olympus_Mons"]) {
        const dto = eventSummaryDtoSchema.parse(hit({ timezone: zone }));
        expect(dto.timezone).toBe("America/Chicago");
      }
    });

    it("formats the no-helper fallback date in the hit's zone", () => {
      const pacific = eventSummaryDtoSchema.parse(
        hit({ helper: null, timezone: "America/Los_Angeles" }),
      );
      expect(plain(pacific.date)).toBe("Thu, Oct 15, 5:00 PM");
      const fallback = eventSummaryDtoSchema.parse(hit({ helper: null }));
      expect(plain(fallback.date)).toBe("Thu, Oct 15, 7:00 PM");
    });
  });
});
