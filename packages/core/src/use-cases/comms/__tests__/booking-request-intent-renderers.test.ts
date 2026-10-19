import { describe, expect, it } from "vitest";

import { listNotificationRendererVariants, renderNotification } from "../renderers";

// The parking variants are GONE (venue-confirmation spec, amendment
// 2026-09-25: an unclaimed venue takes no requests). Nothing sends them and
// no queued payload can name them (the invite was mailed in-process; notify()
// stores rendered rows), so they are unregistered rather than kept as
// retired renderers. Re-adding either must be a deliberate act.

const NOW = new Date("2026-09-07T12:00:00.000Z");

describe("parking notification variants (removed)", () => {
  it.each(["booking.venue-claim-invite", "booking.requests-unparked"])(
    "%s is not registered and cannot render",
    (variant) => {
      expect(listNotificationRendererVariants()).not.toContain(variant);
      expect(() =>
        renderNotification(
          variant,
          {
            placeId: "33333333-3333-4333-8333-333333333333",
            placeName: "The Corner Stage",
          },
          { now: NOW },
        ),
      ).toThrowError(/UNKNOWN_NOTIFICATION_VARIANT/);
    },
  );
});
