import { vi } from "vitest";

import type { EntityReportRecord } from "@th/ports/repos/entity-reports";

export const NOW = new Date("2026-08-17T12:00:00.000Z");

export const REPORTER_ID = "11111111-1111-4111-8111-111111111111";
/** Default staff actor in these fixtures (SUPPORT unless a test overrides). */
export const STAFF_ID = "22222222-2222-4222-8222-222222222222";
export const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
export const PLACE_ID = "44444444-4444-4444-8444-444444444444";
export const HUMAN_SUBJECT_ID = "55555555-5555-4555-8555-555555555555";
export const ORG_ID = "66666666-6666-4666-8666-666666666666";
export const REPORT_ID = "77777777-7777-4777-8777-777777777777";

export function makeReport(
  overrides: Partial<EntityReportRecord> = {},
): EntityReportRecord {
  return {
    id: REPORT_ID,
    subjectType: "PLACE",
    subjectId: PLACE_ID,
    reporterHumanId: REPORTER_ID,
    reason: "CLOSED_OR_GONE",
    details: null,
    subjectSnapshot: null,
    status: "PENDING",
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeClock() {
  return { now: vi.fn(() => NOW) };
}

/** hasStaffRole fake honouring a per-human role map (role intersection). */
export function makeStaffAuthz(rolesByHuman: Record<string, string[]> = {}) {
  return {
    hasStaffRole: vi.fn(
      async ({
        actorHumanId,
        requiredRoles,
      }: {
        actorHumanId: string;
        requiredRoles: string[];
      }) => ({
        allowed: (rolesByHuman[actorHumanId] ?? []).some((role) =>
          requiredRoles.includes(role),
        ),
      }),
    ),
  };
}

/** Minimal logger fake capturing warn calls (notification swallow asserts). */
export function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return logger;
}
