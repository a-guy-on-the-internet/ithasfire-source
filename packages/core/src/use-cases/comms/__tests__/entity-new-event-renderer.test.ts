import { describe, expect, it } from "vitest";
import { renderNotification } from "../renderers";

const payload = {
  entityPageId: "page-1",
  entityName: "The Hideout",
  eventId: "event-1",
  eventTitle: "Friday Night",
  startsAtIso: "2026-10-10T01:00:00.000Z",
  timezone: "America/Chicago",
  eventUrl: "https://ithasfire.com/events/org/us/chicago/friday--123",
  manageFollowingUrl: "https://ithasfire.com/account/settings/notifications",
};
const render = (value = payload) => renderNotification("entity.new-event", value, {
  now: new Date("2026-09-22T00:00:00Z"),
});

describe("entity.new-event", () => {
  it("uses controllable organiser messages and sends all three channels to the public event", () => {
    const result = render();
    expect(result.category).toBe("organizerMessages");
    expect(result.inApp?.action).toEqual({ label: "View event", route: "/events/org/us/chicago/friday--123" });
    expect(result.inApp?.body).toContain("Friday Night");
    expect(result.inApp?.body).toContain("Oct 9");
    expect(result.push?.data).toMatchObject({ eventId: "event-1", url: payload.eventUrl });
    expect(result.email?.text).toContain(payload.eventUrl);
    expect(result.email?.text).toContain(payload.manageFollowingUrl);
    expect(result.sms).toBeUndefined();
  });

  it("sanitizes titles and names before using them as text or email headers", () => {
    const result = render({ ...payload, entityName: "<b>The Hideout</b>\nBcc: no", eventTitle: "&lt;script&gt;bad()&lt;/script&gt;Friday" });
    expect(result.email?.subject).toBe("New event from The Hideout Bcc: no");
    expect(result.email?.text).not.toContain("<script>");
    expect(result.inApp?.body).toContain("Friday");
    expect(result.email?.html).toBeUndefined();
  });

  it("rejects non-web links and unexpected location data", () => {
    expect(() => render({ ...payload, eventUrl: "javascript:alert(1)" })).toThrow();
    expect(() => renderNotification("entity.new-event", { ...payload, address: "Hidden venue address" }, { now: new Date() })).toThrow();
  });

  it("keeps fingerprint stable across edits and falls back for invalid timezone", () => {
    const changed = render({ ...payload, eventTitle: "Renamed", timezone: "Invalid/Zone" });
    expect(changed.fingerprint).toEqual(render().fingerprint);
    // An unknown zone reads in the platform default (Chicago), not UTC: 01:00Z
    // on Oct 10 is 8 PM CDT on Oct 9.
    expect(changed.inApp?.body).toContain("Oct 9");
    expect(changed.inApp?.body).toContain("CDT");
    expect(changed.inApp?.body).not.toContain("UTC");
  });
});

describe("entity.new-event — one alert per event", () => {
  it("fingerprints and collapses per EVENT, so two followed pages announcing one event dedupe", () => {
    const viaOrg = render();
    const viaVenue = render({ ...payload, entityPageId: "page-2", entityName: "The Venue" });
    expect(viaVenue.fingerprint).toEqual(viaOrg.fingerprint);
    expect(viaOrg.fingerprint).toEqual({ variant: "entity.new-event", eventId: "event-1" });
    expect(viaVenue.push?.collapseKey).toBe(viaOrg.push?.collapseKey);
  });
});
