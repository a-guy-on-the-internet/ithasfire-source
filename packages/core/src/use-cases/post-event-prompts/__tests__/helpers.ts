import { vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type {
  AttendeeEventCandidate,
  EnqueuePostEventPromptInput,
  PerformerGigCandidate,
  PostEventPromptRecord,
  PostEventPromptsRepo,
} from "@th/ports/repos/post-event-prompts";

export const NOW = new Date("2026-07-14T15:00:00.000Z");

export const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
export const EVENT_ID_2 = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
export const PLACE_ID = "cccccccc-1111-4111-8111-cccccccccccc";
export const HUMAN_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const HUMAN_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
export const HUMAN_C = "cccccccc-2222-4222-8222-cccccccccccc";
export const ORG_ID = "dddddddd-1111-4111-8111-dddddddddddd";

export function makeClock(now: Date = NOW): ClockPort {
  return { now: vi.fn(() => now) };
}

export function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

export function makeGigCandidate(
  overrides: Partial<PerformerGigCandidate> = {},
): PerformerGigCandidate {
  return {
    bookingRequestId: "br-1",
    eventId: EVENT_ID,
    eventStatus: "PUBLISHED",
    eventEndsAt: new Date("2026-07-13T04:00:00.000Z"),
    placeId: PLACE_ID,
    performerOwnerType: "human",
    performerOwnerId: HUMAN_A,
    lineupHumanIds: [],
    ...overrides,
  };
}

export function makeAttendeeCandidate(
  overrides: Partial<AttendeeEventCandidate> = {},
): AttendeeEventCandidate {
  return {
    eventId: EVENT_ID,
    eventStatus: "PUBLISHED",
    placeId: PLACE_ID,
    ...overrides,
  };
}

/**
 * Stateful in-memory PostEventPromptsRepo. `createManySkipExisting` honours
 * the (eventId, humanId, audience) unique triple exactly like the DB index,
 * so idempotency tests exercise real skip semantics; `listPending` filters
 * by audience IN THE QUERY like the adapter. Candidate/scan queries are
 * plain stubs configured per test.
 */
export function makeFakePostEventPromptsRepo(args?: {
  seed?: PostEventPromptRecord[];
  gigCandidates?: PerformerGigCandidate[];
  attendeeCandidates?: AttendeeEventCandidate[];
  scannedByEvent?: Record<string, string[]>;
}) {
  const rows: PostEventPromptRecord[] = [...(args?.seed ?? [])];
  let counter = 0;

  const repo: PostEventPromptsRepo = {
    createManySkipExisting: vi.fn(
      async (inputs: EnqueuePostEventPromptInput[]) => {
        let created = 0;
        for (const input of inputs) {
          const exists = rows.some(
            (r) =>
              r.eventId === input.eventId &&
              r.humanId === input.humanId &&
              r.audience === input.audience,
          );
          if (exists) continue;
          counter += 1;
          rows.push({
            id: `prompt-${counter}`,
            eventId: input.eventId,
            humanId: input.humanId,
            placeId: input.placeId ?? null,
            audience: input.audience,
            status: "PENDING",
            attempts: 0,
            sentAt: null,
            createdAt: NOW,
          });
          created += 1;
        }
        return created;
      },
    ),
    // Copies, like a real DB read — the drain's snapshot must not be
    // live-mutated by bookkeeping writes.
    listPending: vi.fn(async ({ limit, audiences }) =>
      rows
        .filter(
          (r) => r.status === "PENDING" && audiences.includes(r.audience),
        )
        .slice(0, limit)
        .map((r) => ({ ...r })),
    ),
    markSent: vi.fn(async (ids: string[], at: Date) => {
      for (const r of rows) {
        if (ids.includes(r.id)) {
          r.status = "SENT";
          r.sentAt = at;
        }
      }
    }),
    markFailed: vi.fn(async (ids: string[]) => {
      for (const r of rows) {
        if (ids.includes(r.id)) r.status = "FAILED";
      }
    }),
    incrementAttempts: vi.fn(async (ids: string[]) => {
      for (const r of rows) {
        if (ids.includes(r.id)) r.attempts += 1;
      }
    }),
    listPerformerGigCandidates: vi.fn(async () => args?.gigCandidates ?? []),
    listAttendeeEventCandidates: vi.fn(
      async () => args?.attendeeCandidates ?? [],
    ),
    scannedTicketHolderHumanIds: vi.fn(
      async (eventId: string) => args?.scannedByEvent?.[eventId] ?? [],
    ),
    humanIdsWithPrompt: vi.fn(async ({ eventId, audience }) =>
      rows
        .filter((r) => r.eventId === eventId && r.audience === audience)
        .map((r) => r.humanId),
    ),
    existsForAudience: vi.fn(async ({ eventId, humanId, audience }) =>
      rows.some(
        (r) =>
          r.eventId === eventId &&
          r.humanId === humanId &&
          r.audience === audience,
      ),
    ),
  };

  return { repo, rows };
}
