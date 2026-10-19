import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { PushPort } from "@th/ports/comms/push";
import type { SMSPort } from "@th/ports/comms/sms";
import type { NotificationPreferenceSnapshot } from "@th/ports/repos/notification-preferences";
import type { SmsConsentStatus } from "@th/ports/repos/sms-consent";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakeNotificationsRepo } from "@th/test-utils/fakes/notifications-repo";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { notify, type NotifyDeps } from "../notify";
import {
  getNotificationRenderer,
  renderNotification,
} from "../renderers";

const NOW = new Date("2026-07-07T12:00:00.000Z");
const HUMAN_ID = "8d96bcf3-75bb-4e6b-9bea-9891e093cf3e";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

const PAYLOAD = {
  eventId: EVENT_ID,
  eventTitle: "Secret Loft Session",
  address: "1114 Fatherland St, Nashville, TN 37206",
  venueName: "East Nashville",
  startsAtIso: "2026-08-14T20:00:00.000Z",
  timezone: "America/Chicago",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=36.1773,-86.7554",
  directionsUrl:
    "https://www.google.com/maps/dir/?api=1&destination=36.1773,-86.7554",
  eventUrl: "https://ithasfire.com/events/secret-loft-session",
};

/**
 * GSM-7 basic charset, conservatively: printable ASCII minus the chars GSM
 * lacks (`) or sends as 2-septet escapes ([ ] { } \ ^ ~ |). A body matching
 * this is one segment up to 160 characters.
 */
const GSM7_BASIC = /^[ !"#$%&'()*+,\-./0-9:;<=>?@A-Z_a-z]*$/;

describe("event.location-revealed renderer", () => {
  it("is registered in the transactional category", () => {
    const definition = getNotificationRenderer("event.location-revealed");
    expect(definition).not.toBeNull();
    expect(definition?.category).toBe("transactional");
  });

  it("renders in-app, push, and email channels without throwing", () => {
    const rendered = renderNotification("event.location-revealed", PAYLOAD, {
      now: NOW,
    });

    expect(rendered.category).toBe("transactional");
    expect(rendered.fingerprint).toEqual({
      variant: "event.location-revealed",
      eventId: EVENT_ID,
      address: PAYLOAD.address,
    });

    expect(rendered.inApp).toMatchObject({
      title: "Location revealed: Secret Loft Session",
      body: "The location for Secret Loft Session is now live: East Nashville — 1114 Fatherland St, Nashville, TN 37206.",
      kind: "INFO",
      // Derived from PAYLOAD.eventUrl — a SLUG path, never the id (an id route
      // 404s on the public `/events/[...slug]` page).
      action: { label: "View event", route: "/events/secret-loft-session" },
    });

    expect(rendered.push).toMatchObject({
      title: "Location revealed: Secret Loft Session",
      body: "East Nashville — 1114 Fatherland St, Nashville, TN 37206. Tap for directions.",
      collapseKey: `event-location-${EVENT_ID}`,
      data: { eventId: EVENT_ID, directionsUrl: PAYLOAD.directionsUrl },
    });

    expect(rendered.email).toMatchObject({
      subject: "The location for Secret Loft Session is now live",
      template: {
        key: "event.location_revealed",
        variables: {
          eventTitle: "Secret Loft Session",
          startsAtISO: PAYLOAD.startsAtIso,
          timezone: "America/Chicago",
          venueName: "East Nashville",
          address: PAYLOAD.address,
          mapUrl: PAYLOAD.mapUrl,
          directionsUrl: PAYLOAD.directionsUrl,
          eventUrl: PAYLOAD.eventUrl,
        },
      },
    });
    expect(rendered.email?.text).toContain(PAYLOAD.directionsUrl);
    expect(rendered.email?.text).toContain(PAYLOAD.eventUrl);
  });

  it("renders a minimal transactional sms leg (title + address + event URL, ≤320 chars)", () => {
    const rendered = renderNotification("event.location-revealed", PAYLOAD, {
      now: NOW,
    });

    expect(rendered.sms).toBeDefined();
    const body = rendered.sms!.body!;
    // The text names its sender (carriers expect the brand).
    expect(body.startsWith("Ithas Fire: Location revealed for ")).toBe(true);
    expect(body).toContain("Secret Loft Session");
    expect(body).toContain(PAYLOAD.address);
    expect(body).toContain(PAYLOAD.eventUrl);
    expect(body.length).toBeLessThanOrEqual(320);
  });

  it("truncates an oversized sms lead while always preserving the event URL", () => {
    const rendered = renderNotification(
      "event.location-revealed",
      {
        ...PAYLOAD,
        eventTitle: "T".repeat(200),
        address: "A".repeat(500),
        venueName: "V".repeat(200),
      },
      { now: NOW },
    );

    const body = rendered.sms!.body!;
    expect(body.length).toBeLessThanOrEqual(320);
    expect(body.endsWith(` ${PAYLOAD.eventUrl}`)).toBe(true);
    // Truncation cuts the end of the lead, never the brand.
    expect(body.startsWith("Ithas Fire: ")).toBe(true);
    // ASCII "..." (GSM-7), never "…" (U+2026, forces UCS-2).
    expect(body).toContain("...");
    expect(body).not.toContain("…");
    expect(body).toMatch(GSM7_BASIC);
  });

  it("truncation never splits a surrogate pair (emoji-heavy title)", () => {
    const rendered = renderNotification(
      "event.location-revealed",
      {
        ...PAYLOAD,
        // 100 astral code points = 200 UTF-16 units (the schema max) — the
        // truncation cut is guaranteed to land inside the emoji run.
        eventTitle: "🔥".repeat(100),
        address: "A".repeat(500),
      },
      { now: NOW },
    );

    const body = rendered.sms!.body!;
    expect(body.length).toBeLessThanOrEqual(320);
    expect(body.endsWith(` ${PAYLOAD.eventUrl}`)).toBe(true);
    // No lone surrogate anywhere (high without low, or low without high).
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(body)).toBe(false);
  });

  it("renders without the optional venue/map fields", () => {
    const rendered = renderNotification(
      "event.location-revealed",
      {
        eventId: EVENT_ID,
        eventTitle: "Secret Loft Session",
        address: PAYLOAD.address,
        startsAtIso: PAYLOAD.startsAtIso,
        eventUrl: PAYLOAD.eventUrl,
      },
      { now: NOW },
    );

    expect(rendered.inApp?.body).toBe(
      "The location for Secret Loft Session is now live: 1114 Fatherland St, Nashville, TN 37206.",
    );
    expect(rendered.push?.data).toEqual({ eventId: EVENT_ID });
  });

  it("rejects a payload with no address", () => {
    expect(() =>
      renderNotification(
        "event.location-revealed",
        { ...PAYLOAD, address: "" },
        { now: NOW },
      ),
    ).toThrowError();
  });
});

describe("event.location-revealed renderer — SMS short link", () => {
  const SHORT_URL = "https://ithasfire.com/e/wqsdk6pxzi";

  it("the SMS ends with the short URL; email and in-app keep the canonical URL", () => {
    const rendered = renderNotification(
      "event.location-revealed",
      { ...PAYLOAD, eventShortUrl: SHORT_URL },
      { now: NOW },
    );

    const sms = rendered.sms!.body!;
    expect(sms.endsWith(` ${SHORT_URL}`)).toBe(true);
    expect(sms).not.toContain(PAYLOAD.eventUrl);

    expect(rendered.inApp?.action).toEqual({
      label: "View event",
      route: "/events/secret-loft-session",
    });
    expect(rendered.email?.text).toContain(
      `View the event: ${PAYLOAD.eventUrl}`,
    );
    expect(rendered.email?.text).not.toContain(SHORT_URL);
    expect(rendered.email?.template?.variables).toMatchObject({
      eventUrl: PAYLOAD.eventUrl,
    });
    // The link is not part of the dedupe identity.
    expect(rendered.fingerprint).toEqual({
      variant: "event.location-revealed",
      eventId: EVENT_ID,
      address: PAYLOAD.address,
    });
  });

  it("without a short URL (absent or null) the SMS carries the canonical URL, as before", () => {
    for (const payload of [PAYLOAD, { ...PAYLOAD, eventShortUrl: null }]) {
      const rendered = renderNotification("event.location-revealed", payload, {
        now: NOW,
      });
      expect(rendered.sms!.body!.endsWith(` ${PAYLOAD.eventUrl}`)).toBe(true);
    }
  });

  it("a realistic reveal fits ONE 160-char segment with the short link and needs two with the canonical one", () => {
    // Plausible production shape: the canonical slug URL from the demo org
    // (122 chars) and its matching short link (34 chars). No venueName here;
    // the next test covers the venue case.
    const realistic = {
      ...PAYLOAD,
      eventTitle: "Lower East Side Charity Fundraiser",
      venueName: null,
      address: "102 Norfolk St, New York, NY 10002",
      eventUrl:
        "https://ithasfire.com/events/ithas-fire-demo-org/us/general/lower-east-side-charity-fundraiser-2026-10-30-0200--wqsdk6pxzi",
    };

    const long = renderNotification("event.location-revealed", realistic, {
      now: NOW,
    }).sms!.body!;
    const short = renderNotification(
      "event.location-revealed",
      { ...realistic, eventShortUrl: SHORT_URL },
      { now: NOW },
    ).sms!.body!;

    // Plain GSM-7 basic charset, so one segment really is 160 characters.
    expect(short).toMatch(GSM7_BASIC);
    expect(long.length).toBe(228);
    expect(short.length).toBe(140);
    expect(long.length).toBeGreaterThan(160);
    expect(short.length).toBeLessThanOrEqual(160);
    // Nothing of the message itself was traded away for the link.
    expect(short).toContain(realistic.address);
    expect(short).not.toContain("…");
  });

  it("with a venue name the short-link SMS is still ONE GSM-7 segment; email keeps the em dash", () => {
    const withVenue = {
      ...PAYLOAD,
      eventTitle: "Lower East Side Charity Fundraiser",
      venueName: "The Back Room",
      address: "102 Norfolk St, New York, NY 10002",
      eventUrl:
        "https://ithasfire.com/events/ithas-fire-demo-org/us/general/lower-east-side-charity-fundraiser-2026-10-30-0200--wqsdk6pxzi",
      eventShortUrl: SHORT_URL,
    };

    const rendered = renderNotification("event.location-revealed", withVenue, {
      now: NOW,
    });
    const sms = rendered.sms!.body!;

    expect(sms).toBe(
      `Ithas Fire: Location revealed for Lower East Side Charity Fundraiser: The Back Room, 102 Norfolk St, New York, NY 10002. ${SHORT_URL}`,
    );
    expect(sms).toMatch(GSM7_BASIC);
    expect(sms.length).toBe(155);
    expect(sms.length).toBeLessThanOrEqual(160);

    // Email and in-app text are untouched: still the em-dash fragment.
    expect(rendered.email?.text).toContain(
      "The Back Room — 102 Norfolk St, New York, NY 10002.",
    );
    expect(rendered.inApp?.body).toBe(
      "The location for Lower East Side Charity Fundraiser is now live: The Back Room — 102 Norfolk St, New York, NY 10002.",
    );
  });

  it("the short link leaves the truncated lead more room than the canonical one", () => {
    const oversized = {
      ...PAYLOAD,
      eventTitle: "T".repeat(200),
      address: "A".repeat(500),
    };
    const long = renderNotification("event.location-revealed", oversized, {
      now: NOW,
    }).sms!.body!;
    const short = renderNotification(
      "event.location-revealed",
      { ...oversized, eventShortUrl: SHORT_URL },
      { now: NOW },
    ).sms!.body!;

    expect(long.length).toBeLessThanOrEqual(320);
    expect(short.length).toBeLessThanOrEqual(320);
    expect(short.endsWith(` ${SHORT_URL}`)).toBe(true);
    const leadOf = (body: string, url: string) =>
      body.slice(0, body.length - url.length - 1);
    expect(leadOf(short, SHORT_URL).length).toBeGreaterThan(
      leadOf(long, PAYLOAD.eventUrl).length,
    );
  });

  it("rejects a short URL that is not a URL", () => {
    expect(() =>
      renderNotification(
        "event.location-revealed",
        { ...PAYLOAD, eventShortUrl: "/e/wqsdk6pxzi" },
        { now: NOW },
      ),
    ).toThrowError();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-app non-suppressibility through notify()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every transactional channel toggled OFF — the hostile case for a reveal.
 * The dispatcher's `channels: { inApp: { enabled: true } }` override must
 * still land the in-app notification while email/push stay suppressed.
 */
const ALL_TRANSACTIONAL_OFF: NotificationPreferenceSnapshot = {
  in_app: {
    transactional: false,
    announcements: true,
    marketing: true,
    organizerMessages: true,
  },
  push: {
    transactional: false,
    announcements: true,
    marketing: false,
    organizerMessages: true,
  },
  email: {
    transactional: false,
    announcements: true,
    marketing: true,
    organizerMessages: true,
  },
};

function buildNotifyDeps(options?: {
  preferences?: NotificationPreferenceSnapshot;
  /** Verified phone on the identity (null → no phone at all). */
  phone?: string | null;
  /** Current sms consent ledger row status (null → no ledger row). */
  smsConsentStatus?: SmsConsentStatus | null;
}) {
  const preferences = options?.preferences ?? ALL_TRANSACTIONAL_OFF;
  const phone = options?.phone ?? null;
  const smsConsentStatus = options?.smsConsentStatus ?? null;

  const notificationsRepo = createFakeNotificationsRepo();
  const auditRepo = { log: vi.fn(async () => {}) };
  const smsConsentGetByPhone = vi.fn(async () =>
    smsConsentStatus ? { status: smsConsentStatus } : null,
  );

  const repos = {
    tx: async <T>(
      fn: (tx: {
        notifications: typeof notificationsRepo;
        audit: typeof auditRepo;
      }) => Promise<T>,
    ) => fn({ notifications: notificationsRepo, audit: auditRepo }),
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: {
          id: HUMAN_ID,
          name: "Test Human",
          status: "ACTIVE" as const,
          roles: [] as string[],
          locale: null,
          phone,
        },
        identity: {
          authUserId: HUMAN_ID,
          email: "human@example.com",
          emailVerified: true,
          phone,
          phoneVerified: phone !== null,
          username: null,
          displayUsername: null,
          image: null,
        },
      })),
    },
    notificationPrefs: {
      readEffective: vi.fn(async () => preferences),
    },
    pushDevices: {
      findActiveByHuman: vi.fn(async () => []),
    },
    smsConsent: {
      getByPhone: smsConsentGetByPhone,
    },
    notifications: notificationsRepo,
    audit: auditRepo,
  } as unknown as NotifyDeps["repos"];

  const mailerSend = vi.fn(async () => ({
    result: { success: true, id: "email-1" },
  }));
  const mailer = {
    send: mailerSend,
    sendBatch: vi.fn(async () => ({ results: [], okCount: 0, errorCount: 0 })),
    health: vi.fn(async () => ({ ok: true })),
  } as unknown as MailerPort;

  const pushSend = vi.fn(async () => ({ id: "push-1" }));
  const push = {
    send: pushSend,
    registerDevice: vi.fn(),
    unregisterDevice: vi.fn(),
    health: vi.fn(),
  } as unknown as PushPort;

  const smsSend = vi.fn(async () => ({
    result: { success: true, id: "sms-1" },
  }));
  const sms = {
    send: smsSend,
    health: vi.fn(async () => ({ ok: true })),
  } as unknown as SMSPort;

  const deps: NotifyDeps = {
    repos,
    clock: { now: () => NOW },
    idempotency: createFakeIdempotencyPort(),
    push,
    mailer,
    sms,
    logger: createTestLogger(),
  };

  return {
    deps,
    mailerSend,
    pushSend,
    smsSend,
    smsConsentGetByPhone,
    notificationsRepo,
  };
}

describe("event.location-revealed in-app non-suppressibility", () => {
  it("delivers in-app despite transactional in_app pref OFF, while email stays suppressed", async () => {
    const { deps, mailerSend, pushSend, notificationsRepo } =
      buildNotifyDeps();

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "event.location-revealed",
      payload: PAYLOAD,
      idempotencyKey: `event-location-revealed:${EVENT_ID}:${HUMAN_ID}`,
      // The dispatcher's forced-channel override: in-app only.
      channels: { inApp: { enabled: true } },
    });

    expect(result.ok).toBe(true);
    expect(result.category).toBe("transactional");
    // In-app forced through the disabled preference.
    expect(result.inApp.status).toBe("persisted");
    expect(notificationsRepo.__records.size).toBe(1);
    // Email/push honour the user's (disabled) transactional preferences.
    expect(result.email?.status).toBe("skipped");
    expect(result.push?.status).toBe("skipped");
    expect(mailerSend).not.toHaveBeenCalled();
    expect(pushSend).not.toHaveBeenCalled();
  });

  it("without the override, the disabled in_app pref DOES suppress (proving the override is what forces delivery)", async () => {
    const { deps, notificationsRepo } = buildNotifyDeps();

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "event.location-revealed",
      payload: PAYLOAD,
      idempotencyKey: `event-location-revealed:${EVENT_ID}:control`,
    });

    expect(result.inApp.status).toBe("skipped");
    expect(notificationsRepo.__records.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SMS leg (FR-006): preference-driven + consent-ledger gated through notify()
// ─────────────────────────────────────────────────────────────────────────────

const VERIFIED_PHONE = "+15555550123";

const smsPrefs = (transactional: boolean): NotificationPreferenceSnapshot => ({
  ...ALL_TRANSACTIONAL_OFF,
  sms: {
    transactional,
    announcements: false,
    marketing: false,
    organizerMessages: false,
  },
});

describe("event.location-revealed sms leg through notify()", () => {
  it("sends the sms when the transactional×sms pref is on and no consent revocation exists", async () => {
    const { deps, smsSend } = buildNotifyDeps({
      preferences: smsPrefs(true),
      phone: VERIFIED_PHONE,
      smsConsentStatus: null,
    });

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "event.location-revealed",
      payload: PAYLOAD,
      idempotencyKey: `event-location-revealed:${EVENT_ID}:sms-on`,
    });

    expect(result.sms).toEqual({ status: "sent", vendorMessageId: "sms-1" });
    expect(smsSend).toHaveBeenCalledTimes(1);
    const sent = smsSend.mock.calls[0]![0] as { body?: string };
    expect(sent.body).toContain(PAYLOAD.eventUrl);
    expect(sent.body).toContain(PAYLOAD.address);
  });

  it("suppresses the sms when the transactional×sms pref is off", async () => {
    const { deps, smsSend, smsConsentGetByPhone } = buildNotifyDeps({
      preferences: smsPrefs(false),
      phone: VERIFIED_PHONE,
      smsConsentStatus: null,
    });

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "event.location-revealed",
      payload: PAYLOAD,
      idempotencyKey: `event-location-revealed:${EVENT_ID}:sms-off`,
    });

    expect(result.sms).toEqual({
      status: "skipped",
      reason: "channel_disabled",
    });
    expect(smsSend).not.toHaveBeenCalled();
    // The channel gate short-circuits before the ledger is even consulted.
    expect(smsConsentGetByPhone).not.toHaveBeenCalled();
  });

  it("skips the sms when the consent ledger says OPTED_OUT, even with the pref on", async () => {
    const { deps, smsSend, smsConsentGetByPhone } = buildNotifyDeps({
      preferences: smsPrefs(true),
      phone: VERIFIED_PHONE,
      smsConsentStatus: "OPTED_OUT",
    });

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "event.location-revealed",
      payload: PAYLOAD,
      idempotencyKey: `event-location-revealed:${EVENT_ID}:sms-optout`,
    });

    expect(result.sms).toEqual({ status: "skipped", reason: "opted_out" });
    expect(smsConsentGetByPhone).toHaveBeenCalledWith(VERIFIED_PHONE);
    expect(smsSend).not.toHaveBeenCalled();
  });
});
