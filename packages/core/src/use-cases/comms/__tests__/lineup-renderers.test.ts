import { describe, expect, it } from "vitest";

import {
  formatLineupFullWhen,
  formatLineupShortDate,
  formatLineupShortDateTime,
  timezoneCity,
} from "../lineup-renderers";
import {
  listNotificationRendererVariants,
  renderNotification,
} from "../renderers";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ROW_ID = "50000000-0000-4000-8000-000000000005";
// Sun, Oct 4 2026, 5:00 PM in Chicago (CDT, UTC-5).
const STARTS = "2026-10-04T22:00:00.000Z";
const ctx = { now: new Date("2026-09-30T12:00:00.000Z") };

describe("lineup date helpers", () => {
  it("formats in the event's zone", () => {
    expect(formatLineupShortDateTime(STARTS, "America/Chicago")).toBe(
      "Sun, Oct 4, 5:00 PM",
    );
    expect(formatLineupShortDate(STARTS, "America/Chicago")).toBe("Sun, Oct 4");
    expect(formatLineupFullWhen(STARTS, "America/Chicago")).toBe(
      "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
    );
  });

  // UTC was the server's zone, not the event's. A missing or unknown zone now
  // reads in the platform default (Chicago), and the label says so.
  it("falls back to the platform default for a missing or unknown zone, never throwing", () => {
    expect(formatLineupShortDateTime(STARTS, null)).toBe("Sun, Oct 4, 5:00 PM");
    expect(formatLineupShortDate("2026-10-05T04:30:00.000Z", undefined)).toBe(
      "Sun, Oct 4",
    );
    expect(formatLineupFullWhen(STARTS, "Not/AZone")).toBe(
      "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
    );
    expect(formatLineupFullWhen(STARTS, null)).toBe(
      "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
    );
    expect(formatLineupShortDateTime("not-a-date", "America/Chicago")).toBeNull();
  });

  it("a Los Angeles 10:30 PM start stays on Sunday", () => {
    // 22:30 PDT Sun Oct 4 = 05:30Z Mon Oct 5 (00:30 CDT, also Monday).
    const late = "2026-10-05T05:30:00.000Z";
    expect(formatLineupShortDateTime(late, "America/Los_Angeles")).toBe(
      "Sun, Oct 4, 10:30 PM",
    );
    expect(formatLineupFullWhen(late, "America/Los_Angeles")).toBe(
      "Sunday, October 4, 2026 at 10:30 PM (Los Angeles time)",
    );
  });

  // The UTC-id branch serves explicit UTC zones only: formatLineupFullWhen
  // now passes a resolved zone, so null never reaches it from there.
  it("names the zone's city (UTC ids, and a direct null, read UTC)", () => {
    expect(timezoneCity("America/New_York")).toBe("New York");
    expect(timezoneCity("America/Indiana/Indianapolis")).toBe("Indianapolis");
    expect(timezoneCity("Etc/UTC")).toBe("UTC");
    expect(timezoneCity(null)).toBe("UTC");
  });
});

describe("event.lineup-added renderer", () => {
  const payload = {
    eventId: EVENT_ID,
    eventHumanId: ROW_ID,
    eventTitle: "Friday Night Sessions",
    startsAtIso: STARTS,
    timezone: "America/Chicago",
    roleLabel: "Performer",
    addedByName: "Sam Rivera",
    lineupsUrl: "https://ithasfire.com/my-lineups",
    publiclyListed: true,
    eventEnded: false,
    organiserWillBeTold: true,
  };

  it("is registered", () => {
    expect(listNotificationRendererVariants()).toContain("event.lineup-added");
  });

  it("renders the owner's copy, transactional, deduped on the row", () => {
    const out = renderNotification("event.lineup-added", payload, ctx);
    expect(out.category).toBe("transactional");
    expect(out.fingerprint).toEqual({
      variant: "event.lineup-added",
      eventHumanId: ROW_ID,
    });
    expect(out.inApp).toMatchObject({
      title: "You're on the lineup for Friday Night Sessions",
      body: "Sam Rivera added you as Performer. Sun, Oct 4, 5:00 PM.",
      action: { label: "Review your lineups", route: "/my-lineups" },
    });
    expect(out.push).toMatchObject({
      title: "You're on the lineup for Friday Night Sessions",
      body: "Sam Rivera added you as Performer. Sun, Oct 4, 5:00 PM.",
    });
    expect(out.email?.subject).toBe(
      "You're on the lineup for Friday Night Sessions",
    );
    expect(out.email?.template).toEqual({
      key: "event.lineup_added",
      variables: {
        addedByName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
        roleLabel: "Performer",
        lineupsUrl: "https://ithasfire.com/my-lineups",
        publiclyListed: true,
        eventEnded: false,
        organiserWillBeTold: true,
      },
    });
    expect(out.email?.text).toContain("Sam Rivera put you on a lineup");
    expect(out.email?.text).toContain("The organiser will be told.");
    expect(out.sms).toBeUndefined();
  });

  it("only claims what is true: private/volunteer rows are not 'on the event page', and no organiser line without one", () => {
    const out = renderNotification(
      "event.lineup-added",
      { ...payload, publiclyListed: false, organiserWillBeTold: false },
      ctx,
    );
    expect(out.email?.text).toContain("Your name is on the lineup for this event.");
    expect(out.email?.text).not.toContain("event page");
    expect(out.email?.text).not.toContain("The organiser will be told.");
    expect(out.email?.text).toContain("you can take yourself off the lineup.");
    expect(out.email?.template?.variables).toMatchObject({
      publiclyListed: false,
      organiserWillBeTold: false,
    });
  });

  it("an event that already ended promises no 'upcoming shows'", () => {
    const out = renderNotification(
      "event.lineup-added",
      { ...payload, eventEnded: true },
      ctx,
    );
    expect(out.email?.text).toContain("Your name shows on the event page.");
    expect(out.email?.text).not.toContain("upcoming shows");
  });

  it("rejects an empty adder name before any send", () => {
    expect(() =>
      renderNotification(
        "event.lineup-added",
        { ...payload, addedByName: "" },
        ctx,
      ),
    ).toThrow();
  });

  it("keeps the copy gender-neutral", () => {
    const out = renderNotification("event.lineup-added", payload, ctx);
    const all = JSON.stringify(out);
    expect(all).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

describe("event.lineup-left renderer", () => {
  const payload = {
    eventId: EVENT_ID,
    eventHumanId: ROW_ID,
    eventTitle: "Friday Night Sessions",
    startsAtIso: STARTS,
    timezone: "America/Chicago",
    personName: "The Sundowners",
    lineupUrl:
      "https://ithasfire.com/admin/acme/events/40000000-0000-4000-8000-000000000004/edit?section=lineup",
    wasPubliclyListed: true,
  };

  it("renders the owner's copy with the builder's lineup link", () => {
    const out = renderNotification("event.lineup-left", payload, ctx);
    expect(out.category).toBe("transactional");
    expect(out.inApp).toMatchObject({
      title: "The Sundowners took themselves off the lineup",
      body: "Friday Night Sessions, Sun, Oct 4. Their name is off the event page.",
      action: { label: "Open the lineup", href: payload.lineupUrl },
    });
    expect(out.email?.subject).toBe(
      "The Sundowners took themselves off the lineup",
    );
    expect(out.email?.text).toContain(payload.lineupUrl);
    const all = JSON.stringify(out);
    expect(all).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });

  it("says 'off the event page' only when the name was ever on it", () => {
    const out = renderNotification(
      "event.lineup-left",
      { ...payload, wasPubliclyListed: false },
      ctx,
    );
    expect(out.inApp?.body).toBe("Friday Night Sessions, Sun, Oct 4. They're off the lineup.");
    expect(out.email?.text).not.toContain("event page");
  });
});
