import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import { renderNotification } from "../../comms/renderers";
import type { VenueConfirmationNotificationIntent } from "../_shared/venue-confirmation-intents";
import {
  buildVenueConfirmationIdempotencyKey,
  dispatchVenueConfirmationIntents,
  VENUE_CONFIRMATION_VARIANTS,
  type DispatchVenueConfirmationIntentsDeps,
} from "../notify-venue-confirmation-intents";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const HUMAN_OWNER_ID = "a0000000-0000-4000-8000-000000000001";
const ORG_ID = "a0000000-0000-4000-8000-000000000002";
const ORG_EDITOR_ID = "a0000000-0000-4000-8000-000000000003";
const ORG_ADMIN_ID = "a0000000-0000-4000-8000-000000000004";
const ORG_VIEWER_ID = "a0000000-0000-4000-8000-000000000005";
const AT = new Date("2026-09-02T12:00:00.000Z");
const PUBLIC_APP_URL = "https://ithasfire.test/";

function member(humanId: string, role: OrgMemberRecord["role"]): OrgMemberRecord {
  return { humanId, name: null, email: null, role, joinedAt: new Date("2026-01-01T00:00:00.000Z") };
}

function intent(overrides: Partial<VenueConfirmationNotificationIntent> = {}): VenueConfirmationNotificationIntent {
  return {
    kind: "event.place_confirmed",
    eventId: EVENT_ID,
    placeId: PLACE_ID,
    bookingRequestId: REQUEST_ID,
    recipient: { type: "human", humanId: HUMAN_OWNER_ID },
    at: AT,
    ...overrides,
  };
}

function buildDeps(options: {
  members?: OrgMemberRecord[];
  username?: string | null;
  pageSlug?: string | null;
  placeName?: string | null;
  eventTitle?: string | null;
  notifyError?: Error;
} = {}) {
  const members = options.members ?? [member(ORG_EDITOR_ID, "EDITOR"), member(ORG_ADMIN_ID, "ADMIN"), member(ORG_VIEWER_ID, "VIEWER")];
  const notify = vi.fn(async () => {
    if (options.notifyError) throw options.notifyError;
    return { ok: true as const, variant: "x", category: "transactional" as const, scope: "user" as const, inApp: { delivered: false } };
  });
  const reportError = vi.fn();
  const deps = {
    repos: {
      events: {
        getById: vi.fn(async () =>
          options.eventTitle === null ? null : { id: EVENT_ID, title: options.eventTitle ?? "Loud Band Night" },
        ),
      },
      places: {
        getById: vi.fn(async () =>
          options.placeName === null ? null : { id: PLACE_ID, name: options.placeName ?? "The Corner Stage" },
        ),
      },
      organizations: {
        getById: vi.fn(async (id: string) => ({ id, slug: "loud-band-org" })),
        listMembers: vi.fn(async ({ offset }: { offset: number }) => ({
          items: offset === 0 ? members : [],
          total: members.length,
        })),
      },
      humans: {
        getByIdWithIdentity: vi.fn(async () =>
          options.username === undefined
            ? { identity: { username: "sam" } }
            : options.username === null
              ? { identity: { username: null } }
              : { identity: { username: options.username } },
        ),
      },
      entityPages: {
        getByOwner: vi.fn(async () => (options.pageSlug ? { slug: options.pageSlug } : null)),
      },
    } as unknown as DispatchVenueConfirmationIntentsDeps["repos"],
    notify: notify as unknown as DispatchVenueConfirmationIntentsDeps["notify"],
    logger: createTestLogger(),
    reportError,
    publicAppUrl: PUBLIC_APP_URL,
  } satisfies DispatchVenueConfirmationIntentsDeps;
  return { deps, notify, reportError };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchVenueConfirmationIntents — routing", () => {
  it("a HUMAN-owned event: one send to the owner, deep-linked to their admin event page (@username)", async () => {
    const { deps, notify } = buildDeps();
    await dispatchVenueConfirmationIntents(deps, { intents: [intent()] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      humanId: HUMAN_OWNER_ID,
      variant: VENUE_CONFIRMATION_VARIANTS.confirmed,
      idempotencyKey: `venue-confirmation:${EVENT_ID}:event.venue_confirmed:${AT.getTime()}:${HUMAN_OWNER_ID}`, // place-term-keep: Idempotency.key format kept byte-identical
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Loud Band Night",
        placeId: PLACE_ID,
        placeName: "The Corner Stage",
        bookingRequestId: REQUEST_ID,
        targetUrl: `https://ithasfire.test/admin/@sam/events/${EVENT_ID}`,
      },
      channels: { sms: { enabled: false } },
    });
  });

  it("falls back to the entity-page slug, then the raw id, for the human admin slug", async () => {
    const withPage = buildDeps({ username: null, pageSlug: "sam-page" });
    await dispatchVenueConfirmationIntents(withPage.deps, { intents: [intent()] });
    expect(withPage.notify.mock.calls[0]![0]).toMatchObject({
      payload: expect.objectContaining({ targetUrl: `https://ithasfire.test/admin/@sam-page/events/${EVENT_ID}` }),
    });

    const bare = buildDeps({ username: null, pageSlug: null });
    await dispatchVenueConfirmationIntents(bare.deps, { intents: [intent()] });
    expect(bare.notify.mock.calls[0]![0]).toMatchObject({
      payload: expect.objectContaining({ targetUrl: `https://ithasfire.test/admin/@${HUMAN_OWNER_ID}/events/${EVENT_ID}` }),
    });
  });

  it("an ORG-owned event: every edit-role member (never a VIEWER), deep-linked to the org's admin event page", async () => {
    const { deps, notify } = buildDeps();
    await dispatchVenueConfirmationIntents(deps, {
      intents: [intent({ recipient: { type: "org", orgId: ORG_ID } })],
    });
    const humanIds = notify.mock.calls.map((c) => (c[0] as { humanId: string }).humanId).sort();
    expect(humanIds).toEqual([ORG_EDITOR_ID, ORG_ADMIN_ID].sort());
    for (const call of notify.mock.calls) {
      expect((call[0] as { payload: { targetUrl: string } }).payload.targetUrl).toBe(
        `https://ithasfire.test/admin/loud-band-org/events/${EVENT_ID}`,
      );
    }
  });

  it("an org with NO edit-role member: no send, one report (the owner cannot be reached)", async () => {
    const { deps, notify, reportError } = buildDeps({ members: [member(ORG_VIEWER_ID, "VIEWER")] });
    await dispatchVenueConfirmationIntents(deps, {
      intents: [intent({ recipient: { type: "org", orgId: ORG_ID } })],
    });
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toMatchObject({ message: "venue_confirmation_notify_no_recipients" });
  });

  it("empty intents: no reads, no sends", async () => {
    const { deps, notify } = buildDeps();
    await dispatchVenueConfirmationIntents(deps, { intents: [] });
    expect(notify).not.toHaveBeenCalled();
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
  });

  it("throws without a publicAppUrl (the caller's swallow reports it)", async () => {
    const { deps } = buildDeps();
    await expect(
      dispatchVenueConfirmationIntents({ ...deps, publicAppUrl: "  " }, { intents: [intent()] }),
    ).rejects.toThrow(/publicAppUrl/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Kinds, payloads, keys
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchVenueConfirmationIntents — kinds and keys", () => {
  it("withdrawn: carries the reason and its own variant", async () => {
    const { deps, notify } = buildDeps();
    await dispatchVenueConfirmationIntents(deps, {
      intents: [intent({ kind: "event.place_confirmation_withdrawn", reason: "Double booked." })],
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: VENUE_CONFIRMATION_VARIANTS.withdrawn,
        idempotencyKey: `venue-confirmation:${EVENT_ID}:event.venue_confirmation_withdrawn:${AT.getTime()}:${HUMAN_OWNER_ID}`, // place-term-keep: Idempotency.key format kept byte-identical
        payload: expect.objectContaining({ reason: "Double booked." }),
      }),
    );
  });

  it("withdrawn WITHOUT a reason is a contract violation: dropped + reported, never sent", async () => {
    const { deps, notify, reportError } = buildDeps();
    await dispatchVenueConfirmationIntents(deps, {
      intents: [intent({ kind: "event.place_confirmation_withdrawn" })],
    });
    expect(notify).not.toHaveBeenCalled();
    expect(reportError.mock.calls[0]![0]).toMatchObject({ message: "venue_confirmation_notify_reason_missing" });
  });

  it("the key changes with the stamp instant (re-confirm / new reason sends again) but not with a retry", () => {
    const base = buildVenueConfirmationIdempotencyKey(intent(), HUMAN_OWNER_ID);
    expect(buildVenueConfirmationIdempotencyKey(intent(), HUMAN_OWNER_ID)).toBe(base);
    expect(buildVenueConfirmationIdempotencyKey(intent({ at: new Date(AT.getTime() + 1) }), HUMAN_OWNER_ID)).not.toBe(base);
    expect(buildVenueConfirmationIdempotencyKey(intent({ kind: "event.place_confirmation_withdrawn" }), HUMAN_OWNER_ID)).not.toBe(base);
    expect(buildVenueConfirmationIdempotencyKey(intent(), ORG_EDITOR_ID)).not.toBe(base);
  });

  it("the key is byte-identical to the one claimed before the intent kinds took the place spelling, so a dispatch either side of the deploy sends once", () => {
    const at = AT.getTime();
    expect(buildVenueConfirmationIdempotencyKey(intent({ kind: "event.place_confirmed" }), HUMAN_OWNER_ID)).toBe(
      `venue-confirmation:${EVENT_ID}:event.venue_confirmed:${at}:${HUMAN_OWNER_ID}`, // place-term-keep: Idempotency.key format kept byte-identical
    );
    expect(buildVenueConfirmationIdempotencyKey(intent({ kind: "event.place_confirmation_withdrawn" }), HUMAN_OWNER_ID)).toBe(
      `venue-confirmation:${EVENT_ID}:event.venue_confirmation_withdrawn:${at}:${HUMAN_OWNER_ID}`, // place-term-keep: Idempotency.key format kept byte-identical
    );
  });

  it("falls back to constants when the place/event rows vanished, and the renderer still accepts the payload", async () => {
    const { deps, notify } = buildDeps({ placeName: null, eventTitle: null });
    await dispatchVenueConfirmationIntents(deps, { intents: [intent()] });
    const sent = notify.mock.calls[0]![0] as { variant: string; payload: unknown };
    expect(sent.payload).toMatchObject({ placeName: "The place", eventTitle: "Your event" });
    expect(() => renderNotification(sent.variant, sent.payload, { now: AT })).not.toThrow();
  });

  it("every planned payload renders through the real renderer registry", async () => {
    const { deps, notify } = buildDeps();
    await dispatchVenueConfirmationIntents(deps, {
      intents: [
        intent(),
        intent({ kind: "event.place_confirmation_withdrawn", reason: "Room is out of service.", recipient: { type: "org", orgId: ORG_ID } }),
      ],
    });
    expect(notify).toHaveBeenCalledTimes(3);
    for (const call of notify.mock.calls) {
      const sent = call[0] as { variant: string; payload: unknown };
      const rendered = renderNotification(sent.variant, sent.payload, { now: AT });
      expect(rendered.inApp?.title.length).toBeGreaterThan(0);
      expect(rendered.email?.subject).toBe(rendered.inApp?.title);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-recipient isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchVenueConfirmationIntents — failure isolation", () => {
  it("a throwing notify() for one recipient is swallowed + reported and the others are still attempted", async () => {
    const { deps, notify, reportError } = buildDeps({ notifyError: new Error("mailer down") });
    await expect(
      dispatchVenueConfirmationIntents(deps, {
        intents: [intent({ recipient: { type: "org", orgId: ORG_ID } })],
      }),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "dispatchVenueConfirmationIntents", variant: VENUE_CONFIRMATION_VARIANTS.confirmed },
    });
  });

  it("a throwing reporter never changes behaviour", async () => {
    const { deps, notify } = buildDeps({ notifyError: new Error("mailer down") });
    const throwing = { ...deps, reportError: vi.fn(() => { throw new Error("sentry down"); }) };
    await expect(dispatchVenueConfirmationIntents(throwing, { intents: [intent()] })).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
