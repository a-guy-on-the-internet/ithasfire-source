import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// Regression (prod, 2026-10-13): these templates formatted event and shift
// instants with no `timeZone`, so on the UTC server a 7pm Chicago show
// (00:00Z the next day) was mailed as the next day. Each now takes the
// event's IANA zone. These pass under TZ=UTC and TZ=America/Chicago alike.

// 2026-10-12 19:00 CDT (UTC-5).
const EVENING_CDT = "2026-10-13T00:00:00.000Z";
// 2026-10-12 22:00 CDT.
const LATE_CDT = "2026-10-13T03:00:00.000Z";
const ZONE = "America/Chicago";
// 2026-10-12 22:30 PDT (UTC-7) = 05:30Z the next day: still Oct 13 in UTC
// AND in Chicago (00:30 CDT), so these cases fail on zone-less code under
// either TZ the suite runs in.
const LATE_PDT = "2026-10-13T05:30:00.000Z";
// 2026-10-12 23:45 PDT.
const LATER_PDT = "2026-10-13T06:45:00.000Z";
const LA = "America/Los_Angeles";

// ICU puts narrow/thin no-break spaces around times; compare on plain ones.
const plain = (text: string) => text.replace(/[   ]/g, " ");

const renderBoth = async (
  ...args: Parameters<typeof render>
): Promise<{ html: string; text: string }> => {
  const { html, text } = await render(...args);
  return { html: plain(html), text: plain(text) };
};

describe("event and shift dates render in the event's timezone", () => {
  it("event.waitlist_joined: 7pm CDT reads October 12", async () => {
    const { html, text } = await renderBoth({
      templateId: "event.waitlist_joined",
      props: {
        ...sampleInputFor("event.waitlist_joined"),
        eventDateISO: EVENING_CDT,
        timezone: ZONE,
      },
    });
    expect(text).toContain("October 12, 2026 at 7:00 PM");
    expect(html).not.toContain("October 13");
  });

  it("event.waitlist_joined: 10:30pm PDT reads October 12", async () => {
    const { html, text } = await renderBoth({
      templateId: "event.waitlist_joined",
      props: {
        ...sampleInputFor("event.waitlist_joined"),
        eventDateISO: LATE_PDT,
        timezone: LA,
      },
    });
    expect(text).toContain("October 12, 2026 at 10:30 PM");
    expect(html).not.toContain("October 13");
  });

  it("event.announcement: 7pm CDT reads Monday, October 12", async () => {
    const { html, text } = await renderBoth({
      templateId: "event.announcement",
      props: {
        ...sampleInputFor("event.announcement"),
        dateISO: EVENING_CDT,
        timezone: ZONE,
      },
    });
    expect(text).toContain("Monday, October 12, 2026");
    expect(html).not.toContain("October 13");
  });

  it("event.announcement: 10:30pm PDT reads Monday, October 12", async () => {
    const { html, text } = await renderBoth({
      templateId: "event.announcement",
      props: {
        ...sampleInputFor("event.announcement"),
        dateISO: LATE_PDT,
        timezone: LA,
      },
    });
    expect(text).toContain("Monday, October 12, 2026");
    expect(html).not.toContain("October 13");
  });

  it("event.rescheduled: each date in its own event's zone", async () => {
    const { html, text } = await renderBoth({
      templateId: "event.rescheduled",
      props: {
        ...sampleInputFor("event.rescheduled"),
        sourceEventDateISO: EVENING_CDT,
        sourceEventTimezone: ZONE,
        // 2026-10-19 22:30 PDT (UTC-7) = 2026-10-20T05:30Z.
        targetEventDateISO: "2026-10-20T05:30:00.000Z",
        targetEventTimezone: LA,
      },
    });
    expect(text).toContain("Monday, October 12, 2026 at 7:00 PM");
    expect(text).toContain("Monday, October 19, 2026 at 10:30 PM");
    expect(html).not.toContain("October 13");
    expect(html).not.toContain("October 20");
  });

  it.each([
    "volunteer.signup_received",
    "volunteer.signup_approved",
    "volunteer.shift_reminder",
  ] as const)("%s: a 7–10pm CDT shift reads Oct 12", async (templateId) => {
    const { html, text } = await renderBoth({
      templateId,
      props: {
        ...sampleInputFor(templateId),
        shiftStartsAtISO: EVENING_CDT,
        shiftEndsAtISO: LATE_CDT,
        timezone: ZONE,
      },
    });
    expect(text).toContain("Oct 12, 2026, 7:00 PM – Oct 12, 2026, 10:00 PM");
    expect(html).not.toContain("Oct 13");
  });

  it.each([
    "volunteer.signup_received",
    "volunteer.signup_approved",
    "volunteer.shift_reminder",
  ] as const)("%s: a 10:30–11:45pm PDT shift reads Oct 12", async (templateId) => {
    const { html, text } = await renderBoth({
      templateId,
      props: {
        ...sampleInputFor(templateId),
        shiftStartsAtISO: LATE_PDT,
        shiftEndsAtISO: LATER_PDT,
        timezone: LA,
      },
    });
    expect(text).toContain("Oct 12, 2026, 10:30 PM – Oct 12, 2026, 11:45 PM");
    expect(html).not.toContain("Oct 13");
  });

  it("winter CST: a 7:30pm shift on Jan 15 stays on Jan 15", async () => {
    const { text } = await renderBoth({
      templateId: "volunteer.shift_reminder",
      props: {
        ...sampleInputFor("volunteer.shift_reminder"),
        // 2026-01-15 19:30 CST (UTC-6) to 21:30.
        shiftStartsAtISO: "2026-01-16T01:30:00.000Z",
        shiftEndsAtISO: "2026-01-16T03:30:00.000Z",
        timezone: ZONE,
      },
    });
    expect(text).toContain("Jan 15, 2026, 7:30 PM – Jan 15, 2026, 9:30 PM");
  });

  it("membership.renewal_notice: a 10:30pm PDT charge reads October 12", async () => {
    const { html, text } = await renderBoth({
      templateId: "membership.renewal_notice",
      props: {
        ...sampleInputFor("membership.renewal_notice"),
        renewalDateISO: LATE_PDT,
        timezone: LA,
      },
    });
    expect(text).toContain("renews on October 12, 2026");
    expect(html).not.toContain("October 13");
  });

  // The fallback used to be the runtime zone: UTC on Cloud Run, which mailed
  // a 7pm Chicago show as the next day. It is now the platform default.
  it.each(["Mars/Olympus_Mons", null, undefined])(
    "a missing or unknown zone (%s) renders in the platform default, never throws",
    async (timezone) => {
      const { html, text } = await renderBoth({
        templateId: "event.waitlist_joined",
        props: {
          ...sampleInputFor("event.waitlist_joined"),
          eventDateISO: EVENING_CDT,
          timezone,
        },
      });
      expect(text).toContain("October 12, 2026 at 7:00 PM");
      expect(html).not.toContain("October 13");
    },
  );

  it("membership.renewal_notice with no zone reads in the platform default", async () => {
    const { text } = await renderBoth({
      templateId: "membership.renewal_notice",
      props: {
        ...sampleInputFor("membership.renewal_notice"),
        renewalDateISO: LATE_CDT,
      },
    });
    expect(text).toContain("renews on October 12, 2026");
  });
});
