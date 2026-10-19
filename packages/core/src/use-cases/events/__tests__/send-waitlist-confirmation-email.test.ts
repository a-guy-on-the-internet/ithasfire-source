import { describe, expect, it, vi } from "vitest";

import { sendWaitlistConfirmationEmail } from "../send-waitlist-confirmation-email";
import type { SendWaitlistConfirmationEmailDeps } from "../send-waitlist-confirmation-email";

const EVENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const RECIPIENT_EMAIL = "fan@example.com";
const PUBLIC_APP_URL = "https://ithasfire.com";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Night Market Sessions",
    startsAt: new Date("2025-11-02T17:30:00.000Z"),
    slug: "night-market",
    heroImageUrl: null,
    waitlistEmailEnabled: true,
    waitlistEmailSubject: null,
    waitlistEmailBody: null,
    orgId: null,
    ...overrides,
  };
}

function makeDeps(event = makeEvent()): SendWaitlistConfirmationEmailDeps & {
  mailerSendCalls: unknown[];
} {
  const mailerSendCalls: unknown[] = [];
  return {
    repos: {
      events: {
        getById: vi.fn(async (id: string) =>
          id === event.id ? event : null,
        ) as any,
      },
    },
    mailer: {
      send: vi.fn(async (input: unknown) => {
        mailerSendCalls.push(input);
        return { result: { success: true, id: "msg-001" } };
      }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    } as any,
    logger: {
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
      }),
    } as any,
    mailerSendCalls,
  };
}

describe("sendWaitlistConfirmationEmail", () => {
  it("sends email when waitlistEmailEnabled is true", async () => {
    const deps = makeDeps();

    const result = await sendWaitlistConfirmationEmail(deps, {
      eventId: EVENT_ID,
      recipientEmail: RECIPIENT_EMAIL,
      publicAppUrl: PUBLIC_APP_URL,
    });

    expect(result.ok).toBe(true);
    expect(result.eventId).toBe(EVENT_ID);
    expect(result.recipientEmail).toBe(RECIPIENT_EMAIL);
    expect(deps.mailerSendCalls).toHaveLength(1);

    const sendCall = deps.mailerSendCalls[0] as Record<string, unknown>;
    expect(sendCall).toMatchObject({
      to: { to: RECIPIENT_EMAIL },
      template: {
        key: "event.waitlist_joined",
        variables: expect.objectContaining({
          eventTitle: "Night Market Sessions",
          // `/e/:slug` was never a real route (no `app/e` segment, no
          // rewrite) — the public page is `/events/[...slug]`.
          eventUrl: `${PUBLIC_APP_URL}/events/night-market`,
        }),
      },
      idempotencyKey: `waitlist-joined:${EVENT_ID}:${RECIPIENT_EMAIL}`,
    });
  });

  it("skips email when waitlistEmailEnabled is false", async () => {
    const deps = makeDeps(makeEvent({ waitlistEmailEnabled: false }));

    const result = await sendWaitlistConfirmationEmail(deps, {
      eventId: EVENT_ID,
      recipientEmail: RECIPIENT_EMAIL,
      publicAppUrl: PUBLIC_APP_URL,
    });

    expect(result.ok).toBe(true);
    expect(deps.mailerSendCalls).toHaveLength(0);
  });

  it("omits the event link entirely when the event has no slug", async () => {
    const deps = makeDeps(makeEvent({ slug: null }));

    await sendWaitlistConfirmationEmail(deps, {
      eventId: EVENT_ID,
      recipientEmail: RECIPIENT_EMAIL,
      publicAppUrl: PUBLIC_APP_URL,
    });

    const sendCall = deps.mailerSendCalls[0] as Record<string, unknown>;
    const template = sendCall.template as Record<string, unknown>;
    const variables = template.variables as Record<string, unknown>;
    // No slug → no link at all. The old id fallback 404'd.
    expect(variables.eventUrl).toBeNull();
  });

  it("includes custom subject when set", async () => {
    const deps = makeDeps(
      makeEvent({ waitlistEmailSubject: "You're on the list!" }),
    );

    await sendWaitlistConfirmationEmail(deps, {
      eventId: EVENT_ID,
      recipientEmail: RECIPIENT_EMAIL,
      publicAppUrl: PUBLIC_APP_URL,
    });

    const sendCall = deps.mailerSendCalls[0] as Record<string, unknown>;
    expect(sendCall.subject).toBe("You're on the list!");
  });

  it("passes organizer message body to template variables", async () => {
    const customBody = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Welcome to the waitlist!" }],
        },
      ],
    };
    const deps = makeDeps(makeEvent({ waitlistEmailBody: customBody }));

    await sendWaitlistConfirmationEmail(deps, {
      eventId: EVENT_ID,
      recipientEmail: RECIPIENT_EMAIL,
      publicAppUrl: PUBLIC_APP_URL,
    });

    const sendCall = deps.mailerSendCalls[0] as Record<string, unknown>;
    const template = sendCall.template as Record<string, unknown>;
    const variables = template.variables as Record<string, unknown>;
    expect(variables.organizerMessageDoc).toEqual(customBody);
  });

  // F8 (2026-09-29): the recipient never chose this sender, so the
  // organiser's body loses links and any non-whitelisted markup.
  it("strips links and injected heading attrs from the organizer body", async () => {
    const hostileBody = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: '1><a href="https://evil.example">x</a><h1' },
          content: [{ type: "text", text: "Claim your prize" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click here",
              marks: [
                { type: "link", attrs: { href: "https://evil.example" } },
                { type: "bold" },
              ],
            },
          ],
        },
        { type: "image", attrs: { src: "https://evil.example/p.png" } },
      ],
    };
    const deps = makeDeps(makeEvent({ waitlistEmailBody: hostileBody }));

    await sendWaitlistConfirmationEmail(deps, {
      eventId: EVENT_ID,
      recipientEmail: RECIPIENT_EMAIL,
      publicAppUrl: PUBLIC_APP_URL,
    });

    const sendCall = deps.mailerSendCalls[0] as Record<string, unknown>;
    const template = sendCall.template as Record<string, unknown>;
    const variables = template.variables as Record<string, unknown>;
    expect(JSON.stringify(variables.organizerMessageDoc)).not.toContain(
      "evil.example",
    );
    expect(variables.organizerMessageDoc).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Claim your prize" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "click here", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
  });

  it("throws not_found when event does not exist", async () => {
    const deps = makeDeps();

    await expect(
      sendWaitlistConfirmationEmail(deps, {
        eventId: "00000000-0000-0000-0000-000000000000",
        recipientEmail: RECIPIENT_EMAIL,
        publicAppUrl: PUBLIC_APP_URL,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects invalid input", async () => {
    const deps = makeDeps();

    await expect(
      sendWaitlistConfirmationEmail(deps, {
        eventId: "not-a-uuid",
        recipientEmail: "bad-email",
        publicAppUrl: "not-a-url",
      }),
    ).rejects.toThrow();
  });
});

// The template renders the date in this zone; without it a UTC server mailed
// a 7pm Chicago show as the next day (prod, 2026-10-13).
describe("sendWaitlistConfirmationEmail passes the event's timezone", () => {
  it("sends Event.timezone beside the date", async () => {
    const deps = makeDeps(
      makeEvent({
        // 2026-10-12 19:00 CDT.
        startsAt: new Date("2026-10-13T00:00:00.000Z"),
        timezone: "America/Chicago",
      }),
    );

    await sendWaitlistConfirmationEmail(deps, {
      eventId: EVENT_ID,
      recipientEmail: RECIPIENT_EMAIL,
      publicAppUrl: PUBLIC_APP_URL,
    });

    const sendCall = deps.mailerSendCalls[0] as Record<string, unknown>;
    expect(sendCall).toMatchObject({
      template: {
        key: "event.waitlist_joined",
        variables: expect.objectContaining({
          eventDateISO: "2026-10-13T00:00:00.000Z",
          timezone: "America/Chicago",
        }),
      },
    });
  });
});
