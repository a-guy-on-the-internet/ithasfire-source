import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import { schedulePayout } from "../schedule-payout";

function makeDeps(
  overrides?: Partial<{
    staffAllowed: boolean;
    payeeExists: boolean;
    emailVerified: boolean;
  }>,
) {
  const flags = {
    staffAllowed: overrides?.staffAllowed ?? true,
    payeeExists: overrides?.payeeExists ?? true,
    emailVerified: overrides?.emailVerified ?? true,
  };

  const clock: ClockPort = {
    now: () => new Date("2026-01-19T00:00:00.000Z"),
  };

  const repos: Repos = {
    tx: async <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
      fn({
        // Only humans + audit are required by this use-case.
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
              emailVerified: flags.emailVerified,
              phone: null,
              phoneVerified: false,
              username: null,
              displayUsername: null,
              image: null,
            },
          })),
        } as any,
        audit: { log: vi.fn(async () => undefined) } as any,
      } as any),

    payees: {
      getBySubject: vi.fn(async () =>
        flags.payeeExists
          ? { id: "00000000-0000-4000-8000-0000000000b1" }
          : null,
      ),
    } as any,

    payouts: {
      create: vi.fn(async () => ({
        id: "00000000-0000-4000-8000-0000000000c1",
        scheduledFor: new Date("2026-01-19T01:00:00.000Z"),
        status: "scheduled",
        canceledAt: null,
        startedAt: null,
        completedAt: null,
        processorBatchId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      listDue: vi.fn(async () => []),
      markRunning: vi.fn(async () => undefined),
      markCompleted: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as any,
  } as any;

  const authz: AuthZPort = {
    hasStaffRole: vi.fn(async () => ({ allowed: flags.staffAllowed })),
  } as any;

  return { clock, repos, authz };
}

describe("schedulePayout", () => {
  it("creates a payout and writes an audit log", async () => {
    const deps = makeDeps();

    const out = await schedulePayout(deps as any, {
      actorHumanId: "00000000-0000-4000-8000-000000000001",
      subjectType: "ORGANIZATION",
      subjectId: "00000000-0000-4000-8000-000000000002",
      scheduledFor: "2026-01-19T00:10:00.000Z",
    });

    expect(out.payoutId).toBe("00000000-0000-4000-8000-0000000000c1");
  });

  it("throws forbidden when actor is not staff", async () => {
    const deps = makeDeps({ staffAllowed: false });

    await expect(
      schedulePayout(deps as any, {
        actorHumanId: "00000000-0000-4000-8000-000000000001",
        subjectType: "HUMAN",
        subjectId: "00000000-0000-4000-8000-000000000002",
        scheduledFor: "2026-01-19T00:10:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws forbidden when actor email is not verified", async () => {
    const deps = makeDeps({ emailVerified: false });

    await expect(
      schedulePayout(deps as any, {
        actorHumanId: "00000000-0000-4000-8000-000000000001",
        subjectType: "HUMAN",
        subjectId: "00000000-0000-4000-8000-000000000002",
        scheduledFor: "2026-01-19T00:10:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("throws not_found when there is no payee for the subject", async () => {
    const deps = makeDeps({ payeeExists: false });

    await expect(
      schedulePayout(deps as any, {
        actorHumanId: "00000000-0000-4000-8000-000000000001",
        subjectType: "ORGANIZATION",
        subjectId: "00000000-0000-4000-8000-000000000002",
        scheduledFor: "2026-01-19T00:10:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_FOUND" });
  });
});
