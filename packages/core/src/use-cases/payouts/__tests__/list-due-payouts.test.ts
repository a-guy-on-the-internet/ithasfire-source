import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import { listDuePayouts } from "../list-due-payouts";

describe("listDuePayouts", () => {
  it("returns due payouts", async () => {
    const clock: ClockPort = {
      now: () => new Date("2026-01-19T00:00:00.000Z"),
    };

    const repos: Repos = {
      tx: async <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
        fn({
          humans: {
            getByIdWithIdentity: vi.fn(async () => ({
              human: {
                id: "h",
                name: "Test",
                status: "ACTIVE",
                roles: [],
                locale: null,
              },
              identity: {
                authUserId: "h",
                email: "test@example.com",
                emailVerified: true,
                phone: null,
                phoneVerified: false,
                username: null,
                displayUsername: null,
                image: null,
              },
            })),
          } as any,
        } as any),
      payouts: {
        listDue: vi.fn(async () => [
          {
            id: "00000000-0000-4000-8000-0000000000a1",
            scheduledFor: new Date("2026-01-18T23:00:00.000Z"),
          },
        ]),
      } as any,
    } as any;

    const authz: AuthZPort = {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    } as any;

    const out = await listDuePayouts({ repos, authz, clock } as any, {
      actorHumanId: "00000000-0000-4000-8000-000000000001",
      limit: 10,
    });

    expect(out.payouts).toHaveLength(1);
    expect(out.payouts[0]?.id).toBe("00000000-0000-4000-8000-0000000000a1");
  });
});
