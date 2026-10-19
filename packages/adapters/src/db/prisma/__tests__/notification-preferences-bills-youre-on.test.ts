import { describe, expect, it, vi } from "vitest";

import { makeNotificationPreferencesRepo } from "../notification-preferences";
import type { PrismaClientOrTx } from "../types";

// "Bills you're on" (lineup-booking-requests v3, L8 / FR-012): the adapter's
// defaults must match comms/categories.ts — ON for in-app / email / push,
// strictly opt-in for SMS — and a stored per-channel mute must stick.
describe("makeNotificationPreferencesRepo — billsYoureOn", () => {
  const prismaWith = (row: { delta: unknown } | null) =>
    ({
      notificationPreference: {
        findUnique: vi.fn(async () => row),
        findMany: vi.fn(),
        upsert: vi.fn(),
      },
    }) as unknown as PrismaClientOrTx;

  it("defaults on for in_app / email / push and off for sms", async () => {
    const snapshot = await makeNotificationPreferencesRepo(
      prismaWith(null),
    ).readEffective({ humanId: "h1", scope: { kind: "GLOBAL" } });
    expect(snapshot.in_app?.billsYoureOn).toBe(true);
    expect(snapshot.email?.billsYoureOn).toBe(true);
    expect(snapshot.push?.billsYoureOn).toBe(true);
    expect(snapshot.sms?.billsYoureOn).toBe(false);
  });

  it("a per-channel mute sticks without touching the other channels or categories", async () => {
    const snapshot = await makeNotificationPreferencesRepo(
      prismaWith({ delta: { channels: { email: { billsYoureOn: false } } } }),
    ).readEffective({ humanId: "h1", scope: { kind: "GLOBAL" } });
    expect(snapshot.email?.billsYoureOn).toBe(false);
    expect(snapshot.in_app?.billsYoureOn).toBe(true);
    expect(snapshot.push?.billsYoureOn).toBe(true);
    // The invite stays transactional — muting this category leaves it be.
    expect(snapshot.email?.transactional).toBe(true);
  });
});
