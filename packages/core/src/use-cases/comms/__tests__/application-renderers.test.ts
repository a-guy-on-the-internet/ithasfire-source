import { describe, expect, it } from "vitest";

import {
  applicationApprovedEmail,
  applicationBackInReviewEmail,
  applicationReceivedEmail,
  applicationRejectedEmail,
  applicationWaitlistedEmail,
} from "../application-renderers";
import {
  listNotificationRendererVariants,
  renderNotification,
} from "../renderers";

const NOW = { now: new Date("2026-09-30T00:00:00.000Z") };
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const SUBMISSION_ID = "50000000-0000-4000-8000-000000000005";
const EVENT_URL = "https://ithasfire.test/events/sunset-collective/secret-show";
const CLAIM_URL = `https://ithasfire.test/api/events/${EVENT_ID}/claim?token=tok_123`;

const base = {
  eventId: EVENT_ID,
  eventTitle: "Secret show",
  submissionId: SUBMISSION_ID,
} as const;

describe("applicant renderers — registry", () => {
  it("registers all five applicant variants", () => {
    const variants = listNotificationRendererVariants();
    for (const variant of [
      "event.application-received",
      "event.application-approved",
      "event.application-rejected",
      "event.application-waitlisted",
      "event.application-back-in-review",
    ]) {
      expect(variants).toContain(variant);
    }
  });
});

describe("event.application-received renderer", () => {
  it("renders the direct copy and the full template props", () => {
    const result = renderNotification(
      "event.application-received",
      {
        ...base,
        eventUrl: EVENT_URL,
        appliedAtIso: "2026-09-29T18:00:00.000Z",
        timezone: "America/Chicago",
        organizerContactEmail: "hello@org.test",
      },
      NOW,
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp).toMatchObject({
      title: "Application sent: Secret show",
      body: "Your spot isn't confirmed yet. We'll email you when the organizer decides.",
      kind: "INFO",
      action: {
        label: "View event",
        route: "/events/sunset-collective/secret-show",
      },
    });
    expect(result.email).toMatchObject({
      subject: "Application sent: Secret show",
      template: {
        key: "event.application_received",
        variables: {
          eventTitle: "Secret show",
          eventUrl: EVENT_URL,
          appliedAtISO: "2026-09-29T18:00:00.000Z",
          timezone: "America/Chicago",
          organizerContactEmail: "hello@org.test",
        },
      },
      replyTo: { to: "hello@org.test" },
    });
    expect(result.email?.text).toBe(
      `Your spot isn't confirmed yet. We'll email you when the organizer decides.\n\nEvent page: ${EVENT_URL}\n\nQuestions? Reply to this email to reach the organizer.`,
    );
    // Signed-in leg never carries the guest flag.
    expect(result.email?.template?.variables).not.toHaveProperty("isGuest");
  });

  it("omits absent props instead of sending null", () => {
    const result = renderNotification("event.application-received", base, NOW);

    // The zone is never absent: a missing one resolves to the platform
    // default, the zone the text part reads in.
    expect(result.email?.template?.variables).toEqual({
      eventTitle: "Secret show",
      timezone: "America/Chicago",
    });
    expect(result.inApp?.action).toBeNull();
    expect(result.email?.replyTo).toBeNull();
  });
});

describe("event.application-approved renderer", () => {
  const approved = { ...base, approvalToken: "tok_123" } as const;

  // The HTML template gets the same zone the text part reads in; ui-email's
  // application-templates.spec.ts pins the HTML side ("Tue, Oct 6, 9:30 PM CDT").
  it("an invalid zone: text and template both read the platform default", () => {
    const result = renderNotification(
      "event.application-approved",
      {
        ...approved,
        approvalUrl: CLAIM_URL,
        expiresAtIso: "2026-10-07T02:30:00.000Z",
        eventUrl: EVENT_URL,
        timezone: "Not/AZone",
      },
      NOW,
    );
    expect(result.email?.text?.replace(/[\u202f\u00a0]/gu, " ")).toContain(
      "Oct 6, 2026, 9:30 PM CDT",
    );
    expect(result.email?.template?.variables).toMatchObject({
      timezone: "America/Chicago",
    });
  });

  it("renders the template with the claim link, dates and zone", () => {
    const result = renderNotification(
      "event.application-approved",
      {
        ...approved,
        approvalUrl: CLAIM_URL,
        expiresAtIso: "2026-10-07T00:00:00.000Z",
        eventUrl: EVENT_URL,
        startsAtIso: "2026-10-10T01:00:00.000Z",
        endsAtIso: "2026-10-10T05:00:00.000Z",
        timezone: "America/Chicago",
      },
      NOW,
    );

    expect(result.inApp).toMatchObject({
      title: "You're in: Secret show",
      body: "The organizer approved your application. The event page is open to you now.",
      kind: "SUCCESS",
      // Signed-in applicants already hold the unlock: the page, not the
      // expiring claim link.
      action: {
        label: "View event",
        route: "/events/sunset-collective/secret-show",
      },
      expiresAt: new Date("2026-10-07T00:00:00.000Z"),
    });
    expect(result.email).toMatchObject({
      subject: "You're in: Secret show",
      template: {
        key: "event.application_approved",
        variables: {
          eventTitle: "Secret show",
          approvalUrl: CLAIM_URL,
          eventUrl: EVENT_URL,
          expiresAtISO: "2026-10-07T00:00:00.000Z",
          startsAtISO: "2026-10-10T01:00:00.000Z",
          endsAtISO: "2026-10-10T05:00:00.000Z",
          timezone: "America/Chicago",
        },
      },
    });
    expect(result.email?.template?.variables).not.toHaveProperty("calendarUrl");
    // The token / claim URL is a bearer secret: never in metadata (the mail
    // adapter forwards email metadata to the ESP as tags/headers).
    for (const metadata of [result.email?.metadata, result.inApp?.metadata]) {
      expect(metadata).toEqual({
        eventId: EVENT_ID,
        submissionId: SUBMISSION_ID,
        expiresAtIso: "2026-10-07T00:00:00.000Z",
      });
      expect(JSON.stringify(metadata)).not.toContain("tok_123");
    }
    expect(result.email?.text).toContain(`Open the event: ${CLAIM_URL}`);
    // Expiry is formatted in the event's zone, not printed as raw ISO.
    expect(result.email?.text).toContain("This link works until Oct 6, 2026");
    expect(result.email?.text).toContain("CDT");
  });

  it("caps eventTitle at 200 like the other applicant renderers", () => {
    expect(() =>
      renderNotification(
        "event.application-approved",
        { ...approved, eventTitle: "x".repeat(201) },
        NOW,
      ),
    ).toThrow();
  });

  it("ALWAYS emits the template, even with no claim link", () => {
    const result = renderNotification("event.application-approved", approved, NOW);

    expect(result.email?.template).toEqual({
      key: "event.application_approved",
      variables: { eventTitle: "Secret show", timezone: "America/Chicago" },
    });
    expect(result.email?.subject).toBe("You're in: Secret show");
    expect(result.email?.text).toBe(
      "The organizer approved your application. The event page is open to you now.",
    );
    expect(result.inApp?.action).toBeNull();
  });

  it("never persists the claim link as the in-app action when no page URL exists", () => {
    const result = renderNotification(
      "event.application-approved",
      { ...approved, approvalUrl: CLAIM_URL },
      NOW,
    );
    // The in-app row is persisted and the claim URL is a bearer secret.
    expect(result.inApp?.action).toBeNull();
    expect(JSON.stringify(result.inApp)).not.toContain(CLAIM_URL);
  });
});

describe("event.application-rejected renderer", () => {
  it("renders the direct copy without a note", () => {
    const result = renderNotification("event.application-rejected", base, NOW);

    expect(result.inApp).toMatchObject({
      title: "Not approved: Secret show",
      body: "The organizer didn't approve your application.",
      kind: "INFO",
      action: null,
    });
    expect(result.email).toMatchObject({
      subject: "Not approved: Secret show",
      text: "The organizer didn't approve your application.",
      template: {
        key: "event.application_rejected",
        variables: { eventTitle: "Secret show" },
      },
    });
  });

  it("adds the organizer note and the org page link when present", () => {
    const orgUrl = "https://ithasfire.test/orgs/sunset-collective";
    const result = renderNotification(
      "event.application-rejected",
      {
        ...base,
        decisionReason: "Full lineup already",
        organizerEventsUrl: orgUrl,
      },
      NOW,
    );

    expect(result.inApp?.body).toBe(
      "The organizer didn't approve your application. Note from the organizer: Full lineup already",
    );
    expect(result.email?.text).toContain("Note from the organizer: Full lineup already");
    expect(result.email?.text).toContain(orgUrl);
    expect(result.email?.template?.variables).toEqual({
      eventTitle: "Secret show",
      decisionReason: "Full lineup already",
      organizerEventsUrl: orgUrl,
    });
  });
});

describe("event.application-waitlisted renderer", () => {
  it("renders the direct copy", () => {
    const result = renderNotification(
      "event.application-waitlisted",
      { ...base, eventUrl: EVENT_URL, organizerContactEmail: "hello@org.test" },
      NOW,
    );

    expect(result.inApp).toMatchObject({
      title: "Waitlisted: Secret show",
      body: "If a spot opens, we'll email you a link.",
    });
    expect(result.email).toMatchObject({
      subject: "Waitlisted: Secret show",
      template: {
        key: "event.application_waitlisted",
        variables: {
          eventTitle: "Secret show",
          eventUrl: EVENT_URL,
          organizerContactEmail: "hello@org.test",
        },
      },
      replyTo: { to: "hello@org.test" },
    });
    expect(result.email?.text).not.toMatch(/rejected/i);
  });
});

describe("event.application-back-in-review renderer", () => {
  it("renders the owner's copy and the new template key", () => {
    const result = renderNotification(
      "event.application-back-in-review",
      { ...base, eventUrl: EVENT_URL },
      NOW,
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp).toMatchObject({
      title: "Back in review: Secret show",
      body: "The organizer withdrew their approval. Your application is back in review.",
      kind: "INFO",
      action: {
        label: "View event",
        route: "/events/sunset-collective/secret-show",
      },
    });
    expect(result.email).toMatchObject({
      subject: "Back in review: Secret show",
      template: {
        key: "event.application_back_in_review",
        variables: { eventTitle: "Secret show", eventUrl: EVENT_URL },
      },
    });
    expect(result.sms).toBeUndefined();
    // Never claims access was taken away (guest cookies can't be revoked).
    expect(result.email?.text).not.toMatch(/access|locked|revoked/i);
  });

  it("rejects unknown fields (strict payload)", () => {
    expect(() =>
      renderNotification(
        "event.application-back-in-review",
        { ...base, extra: "nope" },
        NOW,
      ),
    ).toThrow();
  });
});

describe("guest email builders", () => {
  it("received: isGuest flag + the 'didn't apply?' line on the guest leg only", () => {
    const guest = applicationReceivedEmail({ eventTitle: "Secret show", isGuest: true });
    expect(guest.template.variables).toEqual({
      eventTitle: "Secret show",
      isGuest: true,
      timezone: "America/Chicago",
    });
    // Exact copy: must not claim the address stays private (organizers see
    // a guest's contact email).
    expect(guest.text).toContain(
      "Didn't apply? Ignore this email. Someone may have typed your address by mistake. No account was created.",
    );

    const member = applicationReceivedEmail({ eventTitle: "Secret show" });
    expect(member.template.variables).not.toHaveProperty("isGuest");
    expect(member.text).not.toContain("Didn't apply?");
  });

  it("waitlisted + back-in-review: isGuest only on the guest leg", () => {
    for (const build of [applicationWaitlistedEmail, applicationBackInReviewEmail]) {
      expect(build({ eventTitle: "T", isGuest: true }).template.variables).toEqual({
        eventTitle: "T",
        isGuest: true,
      });
      expect(build({ eventTitle: "T" }).template.variables).not.toHaveProperty(
        "isGuest",
      );
    }
  });

  it("every builder adds the reply-to-organizer line only when there is a contact", () => {
    const line = "Questions? Reply to this email to reach the organizer.";
    const contact = { eventTitle: "T", organizerContactEmail: "hello@org.test" };
    for (const content of [
      applicationReceivedEmail(contact),
      applicationReceivedEmail({ ...contact, isGuest: true }),
      applicationApprovedEmail(contact),
      applicationRejectedEmail(contact),
      applicationWaitlistedEmail(contact),
      applicationBackInReviewEmail(contact),
    ]) {
      expect(content.text.endsWith(`\n\n${line}`)).toBe(true);
    }
    for (const content of [
      applicationReceivedEmail({ eventTitle: "T" }),
      applicationApprovedEmail({ eventTitle: "T" }),
      applicationRejectedEmail({ eventTitle: "T" }),
      applicationWaitlistedEmail({ eventTitle: "T" }),
      applicationBackInReviewEmail({ eventTitle: "T" }),
    ]) {
      expect(content.text).not.toContain(line);
    }
  });

  it("every builder subject matches its in-app title", () => {
    for (const content of [
      applicationReceivedEmail({ eventTitle: "T" }),
      applicationApprovedEmail({ eventTitle: "T" }),
      applicationRejectedEmail({ eventTitle: "T" }),
      applicationWaitlistedEmail({ eventTitle: "T" }),
      applicationBackInReviewEmail({ eventTitle: "T" }),
    ]) {
      expect(content.subject).toBe(content.title);
      expect(content.text.startsWith(content.body.split(" Note from")[0]!)).toBe(true);
    }
  });

  // UTC was the server's zone: 00:00Z Oct 7 read as "Oct 7" though the
  // deadline is 7 PM CDT on Oct 6. The fallback is now the platform default.
  it.each(["Not/AZone", null, undefined])(
    "approved: a missing or unknown timezone (%s) falls back to the platform default",
    (timezone) => {
      const content = applicationApprovedEmail({
        eventTitle: "T",
        approvalUrl: CLAIM_URL,
        expiresAtIso: "2026-10-07T00:00:00.000Z",
        timezone,
      });
      expect(content.text).toContain("This link works until Oct 6, 2026, 7:00 PM CDT");
      expect(content.text).not.toContain("UTC");
    },
  );

  it("approved: a Los Angeles deadline at 10:30 PM stays on Oct 6", () => {
    // 22:30 PDT Oct 6 = 05:30Z Oct 7 (00:30 CDT, also Oct 7).
    const content = applicationApprovedEmail({
      eventTitle: "T",
      approvalUrl: CLAIM_URL,
      expiresAtIso: "2026-10-07T05:30:00.000Z",
      timezone: "America/Los_Angeles",
    });
    expect(content.text).toContain("This link works until Oct 6, 2026, 10:30 PM PDT");
  });
});
