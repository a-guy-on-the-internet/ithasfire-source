import { describe, expect, it } from "vitest";

import {
  getNotificationCategoryConfig,
  isNotificationCategory,
  notificationCategoryKeys,
} from "../categories";
import { updateNotificationPreferencesInputSchema } from "../update-notification-preferences";

// "Bills you're on" (lineup-booking-requests v3, L8 / FR-012d): a new
// preference category for act-facing notices AFTER the invite. Not
// transactional; user-suppressible per channel; house defaults.
describe("notification category billsYoureOn", () => {
  it("is a known category", () => {
    expect(notificationCategoryKeys).toContain("billsYoureOn");
    expect(isNotificationCategory("billsYoureOn")).toBe(true);
  });

  it("defaults on for in-app / email / push, SMS strictly opt-in", () => {
    expect(getNotificationCategoryConfig("billsYoureOn")).toMatchObject({
      metricsTag: "bills_youre_on",
      inAppDefaultEnabled: true,
      emailDefaultEnabled: true,
      pushDefaultEnabled: true,
      smsDefaultEnabled: false,
    });
  });

  it("can be switched per channel and as a whole", () => {
    const base = {
      actorHumanId: "11111111-1111-4111-8111-111111111111",
      humanId: "11111111-1111-4111-8111-111111111111",
      scope: { kind: "GLOBAL" as const },
    };
    expect(
      updateNotificationPreferencesInputSchema.safeParse({
        ...base,
        updates: { channels: { email: { billsYoureOn: false } } },
      }).success,
    ).toBe(true);
    expect(
      updateNotificationPreferencesInputSchema.safeParse({
        ...base,
        updates: { categories: { billsYoureOn: false } },
      }).success,
    ).toBe(true);
  });
});
