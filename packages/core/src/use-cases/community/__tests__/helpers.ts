import { vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { EventEditSuggestionRecord } from "@th/ports/repos/event-edit-suggestions";
import type { CommunityModeratorApplicationRecord } from "@th/ports/repos/community-moderator-applications";
import type { ImageRecord } from "@th/ports/repos/images";

import { snapshotSuggestionBase } from "../../events/_shared/suggestion-fields";

export const NOW = new Date("2026-07-01T12:00:00.000Z");

export const MODERATOR_ID = "11111111-1111-4111-8111-111111111111";
export const USER_ID = "22222222-2222-4222-8222-222222222222";
export const OWNER_ID = "33333333-3333-4333-8333-333333333333";
export const ORG_ID = "44444444-4444-4444-8444-444444444444";
export const EVENT_ID = "55555555-5555-4555-8555-555555555555";
export const SUGGESTION_ID = "66666666-6666-4666-8666-666666666666";
export const IMAGE_ID = "77777777-7777-4777-8777-777777777777";
export const APPLICATION_ID = "88888888-8888-4888-8888-888888888888";
export const CATEGORY_ID = "99999999-9999-4999-8999-999999999999";
export const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Minimal valid EventBody (v1 sections shape) with one text paragraph. */
export function makeValidBody(text = "Open mic night — all welcome") {
  return {
    version: 1,
    sections: [
      {
        id: "s1",
        kind: "section",
        layout: {
          type: "singleColumn",
          columns: [
            {
              blocks: [
                {
                  id: "b1",
                  type: "richText",
                  doc: {
                    type: "doc",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** EventBody carrying a single cta block with the given href. */
export function makeCtaBody(href: string) {
  return {
    version: 1,
    sections: [
      {
        id: "s1",
        kind: "section",
        layout: {
          type: "singleColumn",
          columns: [
            {
              blocks: [
                {
                  id: "b1",
                  type: "cta",
                  label: "Click me",
                  href,
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** EventBody carrying a cta block with a javascript: href (stored XSS). */
export function makeXssCtaBody() {
  return makeCtaBody("javascript:alert(1)");
}

export function makeCommunityEvent(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: null,
    title: "Weekly Open Mic",
    status: "PUBLISHED",
    attendanceMode: "RSVP",
    stewardship: "COMMUNITY",
    visibility: "PUBLIC",
    gateType: "NONE",
    // Matches the NOT NULL DB default. Geo redaction fails closed, so a
    // missing mode is treated as OBSCURED — tests exercising the default
    // (public) geo behaviour need the explicit EXACT.
    locationMode: "EXACT",
    timezone: "America/Chicago",
    startsAt: new Date("2026-08-01T20:00:00.000Z"),
    endsAt: new Date("2026-08-01T23:00:00.000Z"),
    addressText: "123 Main St, Austin, TX",
    countryCode: "US",
    region: "TX",
    locality: "Austin",
    postalCode: "78701",
    lat: 30.27,
    lng: -97.74,
    categoryId: null,
    slug: "event/us/austin/weekly-open-mic-2026-08-01-2000--abc123",
    shortId: "abc123",
    heroImageUrl: null,
    ageLimit: null,
    publishedAt: NOW,
    ...overrides,
  } as EventRecord;
}

export function makeOrgEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeCommunityEvent({
    orgId: ORG_ID,
    humanId: null,
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    ...overrides,
  });
}

export function makePersonalEvent(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return makeCommunityEvent({
    orgId: null,
    humanId: OWNER_ID,
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    ...overrides,
  });
}

/** Base snapshot matching `event` exactly — i.e. no drift, no conflicts. */
export function makeBaseVersion(
  event: EventRecord,
  content: unknown | null = null,
  heroImageId: string | null = null,
): Record<string, unknown> {
  return snapshotSuggestionBase({ event, content, heroImageId });
}

export function makeSuggestion(
  overrides: Partial<EventEditSuggestionRecord> = {},
): EventEditSuggestionRecord {
  const event = makeCommunityEvent();
  return {
    id: SUGGESTION_ID,
    eventId: event.id,
    submitterHumanId: null,
    submitterIpHash: "a".repeat(64),
    fields: { title: "Weekly Open Mic & Jam" },
    baseVersion: makeBaseVersion(event),
    note: null,
    status: "PENDING",
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    appliedFields: null,
    conflictedFields: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeImage(overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: IMAGE_ID,
    ownerType: "EVENT",
    ownerId: EVENT_ID,
    eventId: EVENT_ID,
    key: `events/${EVENT_ID}/images/${IMAGE_ID}.jpg`,
    publicUrl: `https://cdn.example/events/${EVENT_ID}/images/${IMAGE_ID}.jpg`,
    contentType: "image/jpeg",
    sizeBytes: 1234n,
    width: null,
    height: null,
    uploadedAt: NOW,
    attached: false,
    attachedAt: null,
    detachedAt: null,
    deletedAt: null,
    createdByHumanId: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeApplication(
  overrides: Partial<CommunityModeratorApplicationRecord> = {},
): CommunityModeratorApplicationRecord {
  return {
    id: APPLICATION_ID,
    applicantHumanId: USER_ID,
    statement: "I run three open mics and want to keep listings fresh.",
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

export function makeContentFilter(blockedTexts: string[] = []) {
  return {
    hasBlockedContent: vi.fn(async ({ text }: { text: string }) =>
      blockedTexts.some((blocked) => text.includes(blocked)),
    ),
  };
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
