import { describe, expect, it } from "vitest";

import {
  getNotificationCategoryConfig,
  isSmsAllowedForCategory,
  notificationCategoryKeys,
  smsEligibleCategories,
  smsIneligibleEnables,
} from "../categories";

// Our toll-free sending numbers are registered for passcodes and for
// notifications about things the person signed up for; only transactional
// may be texted (no reminder builds an SMS body yet).
describe("SMS-eligible notification categories", () => {
  it("allows SMS only for transactional", () => {
    expect(smsEligibleCategories).toEqual(["transactional"]);
    for (const key of notificationCategoryKeys) {
      expect(isSmsAllowedForCategory(key)).toBe(
        key === "transactional",
      );
      expect(getNotificationCategoryConfig(key).smsAllowed).toBe(
        isSmsAllowedForCategory(key),
      );
    }
  });

  it("names the ineligible categories a delta tries to turn on", () => {
    expect(smsIneligibleEnables(undefined)).toEqual([]);
    expect(
      smsIneligibleEnables({
        transactional: true,
        reminders: true,
        marketing: true,
        billsYoureOn: true,
        announcements: false,
      }),
    ).toEqual(["reminders", "marketing", "billsYoureOn"]);
  });

  it("accepts turning an ineligible category off", () => {
    expect(
      smsIneligibleEnables({ marketing: false, organizerMessages: false }),
    ).toEqual([]);
  });
});
