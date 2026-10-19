import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { PushPort } from "@th/ports/comms/push";
import type { SMSPort } from "@th/ports/comms/sms";
import type { MetricsPort } from "@th/ports/metric";
import type { NotificationPreferenceSnapshot } from "@th/ports/repos/notification-preferences";
import type { PushDeviceRecord } from "@th/ports/repos/push-devices";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakeNotificationsRepo } from "@th/test-utils/fakes/notifications-repo";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { notify, type NotifyDeps } from "../notify";
import * as renderers from "../renderers";

const HUMAN_ID = "8d96bcf3-75bb-4e6b-9bea-9891e093cf3e";
const DEFAULT_PREFERENCES: NotificationPreferenceSnapshot = {
  in_app: {
    transactional: true,
    announcements: true,
    marketing: true,
    organizerMessages: true,
  },
  push: {
    transactional: true,
    announcements: true,
    marketing: false,
    organizerMessages: true,
  },
  email: {
    transactional: true,
    announcements: true,
    marketing: true,
    organizerMessages: true,
  },
};

const DEFAULT_DEVICE: PushDeviceRecord = {
  id: "device-1",
  humanId: HUMAN_ID,
  provider: "expo",
  token: "ExponentPushToken[xyz]",
  platform: "ios",
  appId: null,
  enabled: true,
  lastSeenAt: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

function buildDefaultHuman() {
  return {
    id: HUMAN_ID,
    name: "Test Human",
    status: "ACTIVE" as const,
    roles: [] as string[],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
  };
}

function buildDefaultIdentity() {
  return {
    authUserId: HUMAN_ID,
    email: "human@example.com",
    emailVerified: true,
    phone: "+15005550006",
    phoneVerified: true,
    username: null,
    displayUsername: null,
    image: null,
  };
}

function buildTestDeps(options?: {
  preferences?: NotificationPreferenceSnapshot;
  devices?: PushDeviceRecord[];
  pushPortOverrides?: Partial<PushPort>;
  mailerOverrides?: Partial<MailerPort>;
  smsPortOverrides?: Partial<SMSPort>;
  humanOverrides?: Partial<ReturnType<typeof buildDefaultHuman>>;
  identityOverrides?: Partial<ReturnType<typeof buildDefaultIdentity>>;
  smsConsentStatus?: "OPTED_OUT" | "OPTED_IN" | "UNKNOWN" | null;
  metrics?: MetricsPort;
}) {
  const preferences = options?.preferences ?? DEFAULT_PREFERENCES;
  const devices = options?.devices ?? [DEFAULT_DEVICE];
  const notificationsRepo = createFakeNotificationsRepo();
  const auditLog = vi.fn(async () => {});

  const humanRecord = {
    ...buildDefaultHuman(),
    ...(options?.humanOverrides ?? {}),
  };
  const identityRecord = {
    ...buildDefaultIdentity(),
    ...(options?.identityOverrides ?? {}),
  };

  const humansRepo = {
    getByIdWithIdentity: vi.fn(async (id: string) =>
      id === HUMAN_ID ? { human: humanRecord, identity: identityRecord } : null,
    ),
  } as unknown;

  const notificationPrefsRepo = {
    readEffective: vi.fn(async () => preferences),
  } as unknown;

  const pushDevicesRepo = {
    findActiveByHuman: vi.fn(async () => devices),
  } as unknown;

  const auditRepo = {
    log: auditLog,
  } as unknown;

  const smsConsentStatus = options?.smsConsentStatus ?? null;
  const smsConsentGetByPhone = vi.fn(async (phoneE164: string) =>
    smsConsentStatus
      ? {
          id: "consent-1",
          phoneE164,
          status: smsConsentStatus,
          source: "test",
          reasonKeyword: null,
          providerMessageId: null,
          actorHumanId: null,
          metadata: {},
          createdAt: new Date("2024-01-01T00:00:00Z"),
          updatedAt: new Date("2024-01-01T00:00:00Z"),
          optedOutAt: smsConsentStatus === "OPTED_OUT" ? new Date() : null,
          optedInAt: smsConsentStatus === "OPTED_IN" ? new Date() : null,
        }
      : null,
  );
  const smsConsentRepo = {
    getByPhone: smsConsentGetByPhone,
  } as unknown;

  const repos = {
    tx: async <T>(
      fn: (tx: {
        notifications: typeof notificationsRepo;
        audit: typeof auditRepo;
      }) => Promise<T>,
    ) => fn({ notifications: notificationsRepo, audit: auditRepo }),
    humans: humansRepo,
    notificationPrefs: notificationPrefsRepo,
    pushDevices: pushDevicesRepo,
    notifications: notificationsRepo,
    audit: auditRepo,
    smsConsent: smsConsentRepo,
  } as unknown as NotifyDeps["repos"];

  const pushSend = vi.fn(async () => ({ id: "push-1" }));
  const pushPort: PushPort = {
    send: pushSend,
    registerDevice: vi.fn(),
    unregisterDevice: vi.fn(),
    health: vi.fn(),
    ...(options?.pushPortOverrides ?? {}),
  };

  const metrics: MetricsPort = options?.metrics ?? {
    increment: vi.fn(),
    record: vi.fn(),
  };

  const mailerSend = vi.fn(async () => ({
    result: { success: true, id: "email-1" },
  }));
  const mailer: MailerPort = {
    send: mailerSend,
    sendBatch: vi.fn(async () => ({ results: [], okCount: 0, errorCount: 0 })),
    health: vi.fn(async () => ({ ok: true })),
    ...(options?.mailerOverrides ?? {}),
  };

  const smsSend = vi.fn(async () => ({
    result: { success: true, id: "sms-1" },
  }));
  const smsPort: SMSPort = {
    send: smsSend,
    sendBatch: vi.fn(async () => ({ results: [], okCount: 0, errorCount: 0 })),
    health: vi.fn(async () => ({ ok: true })),
    ...(options?.smsPortOverrides ?? {}),
  };

  const idempotency = createFakeIdempotencyPort();

  return {
    deps: {
      repos,
      clock: { now: () => new Date("2024-02-01T00:00:00Z") },
      idempotency,
      push: pushPort,
      mailer,
      sms: smsPort,
      metrics,
      logger: createTestLogger(),
    } satisfies NotifyDeps,
    humanRecord,
    auditLog,
    pushSend,
    mailerSend,
    smsSend,
    smsConsentGetByPhone,
    notificationsRepo,
    idempotency,
    metrics,
  };
}

describe("notify", () => {
  it("persists in-app notification and delivers push when eligible", async () => {
    const { deps, pushSend, mailerSend, smsSend, notificationsRepo, metrics } =
      buildTestDeps();

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "notification.generic",
      payload: {
        title: "Tickets ready",
        body: "Your tickets are ready for download",
        kind: "SUCCESS",
        push: {
          body: "Tickets ready",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.category).toBe("transactional");
    expect(result.inApp.status).toBe("persisted");
    if (result.inApp.status !== "persisted") {
      throw new Error("Expected in-app notification to persist");
    }
    expect(result.inApp.notificationId).toBeDefined();
    expect(result.push?.status).toBe("sent");
    expect(result.email?.status).toBe("skipped");
    expect(result.email).toMatchObject({ reason: "renderer_omitted" });
    expect(result.sms?.status).toBe("skipped");
    expect(pushSend).toHaveBeenCalledTimes(1);
    expect(mailerSend).not.toHaveBeenCalled();
    expect(smsSend).not.toHaveBeenCalled();
    expect(notificationsRepo.__records.size).toBe(1);

    const pushCall = pushSend.mock.calls[0];
    expect(pushCall).toBeDefined();
    if (!pushCall) throw new Error("Expected push call to be recorded");
    const [pushInput] = pushCall as unknown as [
      Parameters<PushPort["send"]>[0],
      ...unknown[],
    ];
    expect(pushInput.metadata?.notificationId).toBe(
      result.inApp.notificationId,
    );

    expect(metrics.increment).toHaveBeenCalledWith("comms.notify.request", {
      variant: "notification.generic",
      category: "transactional",
    });
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.notify.inapp.persisted",
      {
        variant: "notification.generic",
        category: "transactional",
      },
    );
    expect(metrics.increment).toHaveBeenCalledWith("comms.notify.push.sent", {
      variant: "notification.generic",
      category: "transactional",
      devices: "1",
    });
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.notify.email.skipped",
      {
        variant: "notification.generic",
        category: "transactional",
        reason: "renderer_omitted",
      },
    );
    expect(metrics.increment).toHaveBeenCalledWith("comms.notify.sms.skipped", {
      variant: "notification.generic",
      category: "transactional",
      reason: "channel_disabled",
    });
  });

  it("sends email when renderer provides content", async () => {
    const { deps, mailerSend, smsSend } = buildTestDeps();
    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "notification.generic" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
        push: undefined,
        email: {
          subject: "Welcome",
          text: "Hi there",
          html: null,
          template: null,
          tags: [],
          metadata: {},
        },
        sms: undefined,
      });

    try {
      const result = await notify(deps, {
        humanId: HUMAN_ID,
        variant: "notification.generic",
        payload: {},
      });

      expect(result.email?.status).toBe("sent");
      if (result.email?.status !== "sent") {
        throw new Error("Expected email to be sent");
      }
      expect(result.email.vendorMessageId).toBe("email-1");
      expect(mailerSend).toHaveBeenCalledTimes(1);
      expect(result.sms?.status).toBe("skipped");
      expect(smsSend).not.toHaveBeenCalled();

      const sendCall = mailerSend.mock.calls[0];
      if (!sendCall) throw new Error("Expected mailer send to be called");
      const [sendInput] = sendCall as unknown as [
        Parameters<MailerPort["send"]>[0],
        ...unknown[],
      ];
      expect(sendInput.to).toEqual({
        to: "human@example.com",
        name: "Test Human",
      });
      expect(sendInput.subject).toBe("Welcome");
    } finally {
      renderSpy.mockRestore();
    }
  });

  it("sends sms when renderer provides content", async () => {
    const metrics = {
      increment: vi.fn(),
      record: vi.fn(),
    } satisfies MetricsPort;

    const { deps, smsSend } = buildTestDeps({ metrics });
    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "notification.generic" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
        push: undefined,
        email: undefined,
        sms: {
          body: "SMS copy",
          tags: ["test"],
          metadata: { foo: "bar" },
        },
      });

    try {
      const result = await notify(deps, {
        humanId: HUMAN_ID,
        variant: "notification.generic",
        payload: {},
        channels: {
          sms: { enabled: true },
        },
      });

      expect(result.sms?.status).toBe("sent");
      if (result.sms?.status !== "sent") {
        throw new Error("Expected sms to be sent");
      }
      expect(result.sms.vendorMessageId).toBe("sms-1");
      expect(smsSend).toHaveBeenCalledTimes(1);
      const call = smsSend.mock.calls[0];
      if (!call) throw new Error("Expected sms send call");
      const [smsInput] = call as unknown as [
        Parameters<SMSPort["send"]>[0],
        ...unknown[],
      ];
      const recipients = Array.isArray(smsInput.to)
        ? smsInput.to
        : [smsInput.to];
      expect(recipients).toEqual([{ toE164: "+15005550006" }]);
      expect(smsInput.body).toBe("SMS copy");
      expect(smsInput.tags).toEqual([
        "test",
        "transactional",
        "notification.generic",
      ]);

      expect(metrics.increment).toHaveBeenCalledWith("comms.notify.sms.sent", {
        variant: "notification.generic",
        category: "transactional",
      });
    } finally {
      renderSpy.mockRestore();
    }
  });

  it.each(["marketing", "announcements", "organizerMessages", "billsYoureOn"] as const)(
    "never texts a %s notification, even with an sms override forced on",
    async (category) => {
      const { deps, smsSend } = buildTestDeps();
      const renderSpy = vi
        .spyOn(renderers, "renderNotification")
        .mockReturnValue({
          category,
          fingerprint: { variant: "notification.generic" },
          inApp: {
            title: "Hello",
            body: "Body",
            kind: "INFO",
            action: null,
            expiresAt: null,
            tags: [],
            metadata: {},
            template: null,
          },
          push: undefined,
          email: undefined,
          sms: { body: "SMS copy", tags: [], metadata: {} },
        });

      try {
        const result = await notify(deps, {
          humanId: HUMAN_ID,
          variant: "notification.generic",
          payload: {},
          channels: { sms: { enabled: true } },
        });

        expect(result.sms).toEqual({
          status: "skipped",
          reason: "category_not_sms_eligible",
        });
        expect(smsSend).not.toHaveBeenCalled();
      } finally {
        renderSpy.mockRestore();
      }
    },
  );

  it("passes reportError through to the sms channel", async () => {
    const reportError = vi.fn();
    const { deps, smsSend } = buildTestDeps();
    smsSend.mockImplementationOnce(async () => {
      throw new Error("sns down");
    });
    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "notification.generic" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
        push: undefined,
        email: undefined,
        sms: { body: "SMS copy", tags: [], metadata: {} },
      });

    try {
      const result = await notify(
        { ...deps, reportError },
        {
          humanId: HUMAN_ID,
          variant: "notification.generic",
          payload: {},
          channels: { sms: { enabled: true } },
        },
      );

      expect(result.sms).toEqual({ status: "failed", reason: "port_error" });
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            useCase: "comms.sendSms",
            stage: "send_threw",
          }),
        }),
      );
    } finally {
      renderSpy.mockRestore();
    }
  });

  it("skips sms when consent was revoked, even with the preference enabled", async () => {
    const metrics = {
      increment: vi.fn(),
      record: vi.fn(),
    } satisfies MetricsPort;

    const { deps, smsSend, smsConsentGetByPhone } = buildTestDeps({
      metrics,
      smsConsentStatus: "OPTED_OUT",
    });

    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "notification.generic" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
        push: undefined,
        email: undefined,
        sms: {
          body: "SMS copy",
          tags: [],
          metadata: {},
        },
      });

    try {
      const result = await notify(deps, {
        humanId: HUMAN_ID,
        variant: "notification.generic",
        payload: {},
        channels: {
          sms: { enabled: true },
        },
      });

      expect(result.sms?.status).toBe("skipped");
      expect(result.sms).toMatchObject({ reason: "opted_out" });
      expect(smsConsentGetByPhone).toHaveBeenCalledWith("+15005550006");
      expect(smsSend).not.toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        "comms.notify.sms.skipped",
        {
          variant: "notification.generic",
          category: "transactional",
          reason: "opted_out",
        },
      );
    } finally {
      renderSpy.mockRestore();
    }
  });

  it("skips sms when phone is unverified", async () => {
    const metrics = {
      increment: vi.fn(),
      record: vi.fn(),
    } satisfies MetricsPort;

    const { deps, smsSend } = buildTestDeps({
      metrics,
      identityOverrides: {
        phoneVerified: false,
      },
    });

    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "notification.generic" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
        push: undefined,
        email: undefined,
        sms: {
          body: "Verify",
          tags: [],
          metadata: {},
        },
      });

    try {
      const result = await notify(deps, {
        humanId: HUMAN_ID,
        variant: "notification.generic",
        payload: {},
        channels: {
          sms: { enabled: true },
        },
      });

      expect(result.sms?.status).toBe("skipped");
      expect(result.sms).toMatchObject({ reason: "unverified" });
      expect(smsSend).not.toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        "comms.notify.sms.skipped",
        {
          variant: "notification.generic",
          category: "transactional",
          reason: "unverified",
        },
      );
    } finally {
      renderSpy.mockRestore();
    }
  });

  it("skips push delivery when channel preference disabled", async () => {
    const prefs: NotificationPreferenceSnapshot = {
      ...DEFAULT_PREFERENCES,
      push: {
        transactional: false,
        announcements: true,
        marketing: false,
        organizerMessages: true,
      },
    };

    const { deps, pushSend, smsSend } = buildTestDeps({ preferences: prefs });

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "notification.generic",
      payload: {
        title: "Reminder",
        body: "Something happened",
        push: {
          body: "Push body",
        },
      },
    });

    expect(result.push?.status).toBe("skipped");
    expect(result.push).toMatchObject({ reason: "channel_disabled" });
    expect(pushSend).not.toHaveBeenCalled();
    expect(result.email?.status).toBe("skipped");
    expect(result.sms?.status).toBe("skipped");
    expect(result.sms).toMatchObject({ reason: "channel_disabled" });
    expect(smsSend).not.toHaveBeenCalled();
  });

  it("derives a per-channel idempotency key for the mailer (never the notify-level claim)", async () => {
    // Regression: notify() claims `idempotencyKey` via deps.idempotency.begin()
    // BEFORE dispatching channels. The mail adapter takes its own claim through
    // the same idempotency port (bound in the api/jobs containers), so passing
    // the identical key down made every send fail with idempotency_conflict —
    // emails silently lost while outbox rows were still marked dispatched.
    const { deps, mailerSend } = buildTestDeps();
    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "notification.generic" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
        push: undefined,
        email: {
          subject: "Welcome",
          text: "Hi there",
          html: null,
          template: null,
          tags: [],
          metadata: {},
        },
        sms: undefined,
      });

    try {
      const result = await notify(deps, {
        humanId: HUMAN_ID,
        variant: "notification.generic",
        payload: {},
        idempotencyKey: "rsvp-confirmed:notice-42",
      });

      expect(result.email?.status).toBe("sent");
      const sendCall = mailerSend.mock.calls[0];
      if (!sendCall) throw new Error("Expected mailer send to be called");
      const [sendInput] = sendCall as unknown as [
        Parameters<MailerPort["send"]>[0],
        ...unknown[],
      ];
      // Suffixed, and therefore distinct from the notify-level claimed key.
      expect(sendInput.idempotencyKey).toMatch(/:email$/);
      expect(sendInput.idempotencyKey).toContain("rsvp-confirmed:notice-42");
    } finally {
      renderSpy.mockRestore();
    }
  });

  it("replays idempotent result without duplicate side effects", async () => {
    const { deps, pushSend, smsSend, notificationsRepo, idempotency } =
      buildTestDeps();

    const payload = {
      humanId: HUMAN_ID,
      variant: "notification.generic",
      payload: {
        title: "Receipt",
        body: "Your receipt is attached",
      },
      idempotencyKey: "idem-key-12345",
    } as const;

    const first = await notify(deps, payload);
    expect(first.idempotentReplay).toBeUndefined();
    expect(first.email?.status).toBe("skipped");
    expect(first.sms?.status).toBe("skipped");
    const recordCountAfterFirst = notificationsRepo.__records.size;
    const pushCallCountAfterFirst = pushSend.mock.calls.length;

    const second = await notify(deps, payload);
    expect(second.idempotentReplay).toBe(true);
    expect(second.email?.status).toBe("skipped");
    expect(second.sms?.status).toBe("skipped");
    expect(notificationsRepo.__records.size).toBe(recordCountAfterFirst);
    expect(pushSend.mock.calls.length).toBe(pushCallCountAfterFirst);
    expect(smsSend).not.toHaveBeenCalled();
    expect(idempotency.__store.size).toBe(1);
  });

  it("throws invalid_input when variant is unknown", async () => {
    const { deps } = buildTestDeps();

    await expect(
      notify(deps, {
        humanId: HUMAN_ID,
        variant: "unknown.variant",
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_NOTIFICATION_VARIANT" });
  });

  it("skips push when no devices are registered", async () => {
    const { deps, pushSend } = buildTestDeps({ devices: [] });

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "notification.generic",
      payload: {
        title: "Heads up",
        body: "Check the app",
        push: {
          body: "Push copy",
        },
      },
    });

    expect(result.push?.status).toBe("skipped");
    expect(result.push).toMatchObject({ reason: "no_devices" });
    expect(pushSend).not.toHaveBeenCalled();
    expect(result.email?.status).toBe("skipped");
  });
});
// Deduplicated: kept the first copy of the notify tests above.

describe("notify — in-app template for read-time localisation", () => {
  const RSVP_PAYLOAD = {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventTitle: "Open Mic Night",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    venueName: "The Hall",
    addressText: "123 Main St",
    eventUrl: "https://ithas.fire/e/open-mic-night",
    manageRsvpsUrl: "https://ithas.fire/my-rsvps",
  };

  // ICU puts a narrow no-break space before "PM"; compare on plain spaces.
  const plain = (s: string | null | undefined) =>
    (s ?? "").replace(/ /gu, " ");

  it("stores the variant and payload as the row's template, with the English text unchanged", async () => {
    const { deps, notificationsRepo } = buildTestDeps();

    const result = await notify(deps, {
      humanId: HUMAN_ID,
      variant: "rsvp.confirmed",
      payload: RSVP_PAYLOAD,
    });

    expect(result.inApp.status).toBe("persisted");
    const [row] = [...notificationsRepo.__records.values()];
    expect(row).toBeDefined();
    expect(row!.templateKey).toBe("rsvp.confirmed");
    expect(row!.templateVersion).toBe("1");
    expect(row!.templateVariables).toEqual(RSVP_PAYLOAD);
    // The stored text is the English render, exactly as before this change.
    expect(row!.title).toBe("You're going to Open Mic Night");
    expect(plain(row!.body)).toBe(
      "Your RSVP for Open Mic Night is confirmed. It starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
    expect(row!.action).toEqual({
      label: "View event",
      route: "/e/open-mic-night",
    });
    // sendInApp records the variant in metadata; the read side relies on it.
    expect(row!.metadata?.variant).toBe("rsvp.confirmed");
  });

  it("stores no template for the generic variant (its text is all caller-supplied)", async () => {
    const { deps, notificationsRepo } = buildTestDeps();

    await notify(deps, {
      humanId: HUMAN_ID,
      variant: "notification.generic",
      payload: { title: "Heads up", body: "Check the app" },
    });

    const [row] = [...notificationsRepo.__records.values()];
    expect(row!.templateKey).toBeNull();
    expect(row!.templateVariables).toBeNull();
  });

  it("reports an in-app payload it could not store, still sends the row (English, no template)", async () => {
    const { deps, notificationsRepo } = buildTestDeps();
    const reportError = vi.fn();
    const oversized = { blob: "x".repeat(20_000) };
    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "rsvp.confirmed" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
      });

    try {
      const result = await notify(
        { ...deps, reportError },
        { humanId: HUMAN_ID, variant: "rsvp.confirmed", payload: oversized },
      );

      expect(result.inApp.status).toBe("persisted");
      const [row] = [...notificationsRepo.__records.values()];
      expect(row!.title).toBe("Hello");
      expect(row!.templateKey).toBeNull();
      expect(row!.templateVariables).toBeNull();
      expect(reportError).toHaveBeenCalledTimes(1);
      const [error, context] = reportError.mock.calls[0]!;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('"rsvp.confirmed"');
      expect(context).toMatchObject({
        tags: { useCase: "comms.notify", variant: "rsvp.confirmed", reason: "oversized" },
      });
      // The payload itself is never sent to the reporter.
      expect(JSON.stringify(context)).not.toContain("xxxx");
    } finally {
      renderSpy.mockRestore();
    }
  });

  it("still sends the row when the reporter itself throws", async () => {
    const { deps, notificationsRepo } = buildTestDeps();
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const renderSpy = vi
      .spyOn(renderers, "renderNotification")
      .mockReturnValue({
        category: "transactional",
        fingerprint: { variant: "rsvp.confirmed" },
        inApp: {
          title: "Hello",
          body: "Body",
          kind: "INFO",
          action: null,
          expiresAt: null,
          tags: [],
          metadata: {},
          template: null,
        },
      });

    try {
      const result = await notify(
        { ...deps, reportError },
        {
          humanId: HUMAN_ID,
          variant: "rsvp.confirmed",
          payload: { blob: "x".repeat(20_000) },
        },
      );
      expect(result.inApp.status).toBe("persisted");
      expect(notificationsRepo.__records.size).toBe(1);
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      renderSpy.mockRestore();
    }
  });

  it("reports nothing when the stored payload fits", async () => {
    const { deps } = buildTestDeps();
    const reportError = vi.fn();
    await notify(
      { ...deps, reportError },
      { humanId: HUMAN_ID, variant: "rsvp.confirmed", payload: RSVP_PAYLOAD },
    );
    expect(reportError).not.toHaveBeenCalled();
  });
});
