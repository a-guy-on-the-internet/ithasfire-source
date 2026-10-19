import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// volunteer-ask-reminders FR-004: the start-anchored reminder says what
// starts (an event, or a one-time ask), never "your shift"; it names the
// zone beside the time, shows an end only when there is one, and never
// shows an address for an ask.
describe("volunteer.start_reminder", () => {
  const base = sampleInputFor("volunteer.start_reminder");

  it("ask: subject and body name the ask and its start, in its zone, with the end", async () => {
    const { subject, text, html } = await render({
      templateId: "volunteer.start_reminder",
      props: {
        ...base,
        anchor: "ask",
        title: "River cleanup day",
        // 2026-05-02 09:00–13:00 CDT.
        startsAtISO: "2026-05-02T14:00:00.000Z",
        endsAtISO: "2026-05-02T18:00:00.000Z",
        timezone: "America/Chicago",
        kindLabel: "In about an hour",
        addressText: "404 Elm St",
        manageUrl: "https://ithasfire.com/v/ask-1",
      },
    });

    expect(subject).toBe("Reminder: River cleanup day starts in about an hour");
    expect(text).toContain("May 2, 2026, 9:00 AM – May 2, 2026, 1:00 PM CDT");
    expect(`${subject} ${text}`).not.toMatch(/shift/i);
    // An ask reminder never names an address, even if one is passed.
    expect(text).not.toContain("404 Elm St");
    expect(html).toContain("https://ithasfire.com/v/ask-1");
    expect(text).toContain("Can't make it? View details");
    // No reply-to is set, so no promise that a reply reaches the organizer.
    expect(text).not.toMatch(/reply/i);
  });

  it("ask with no end and no zone: the start alone, in the platform default zone, named", async () => {
    const { text } = await render({
      templateId: "volunteer.start_reminder",
      props: {
        ...base,
        anchor: "ask",
        startsAtISO: "2026-05-02T14:00:00.000Z",
        endsAtISO: null,
        timezone: null,
      },
    });
    expect(text).toContain("When: May 2, 2026, 9:00 AM CDT");
    expect(text).not.toContain("UTC");
    expect(text).not.toContain("–");
  });

  it("no role name of its own: the sentence names none", async () => {
    const { text } = await render({
      templateId: "volunteer.start_reminder",
      props: { ...base, title: "River cleanup day", roleName: null },
    });
    expect(text).toContain("you signed up to volunteer at River cleanup day.");
    expect(text).not.toContain(" as ");
  });

  it("event: says the event starts, with the gated address line", async () => {
    const { subject, text } = await render({
      templateId: "volunteer.start_reminder",
      props: {
        ...base,
        anchor: "event",
        title: "Night Market Sessions",
        startsAtISO: "2026-05-02T23:00:00.000Z",
        endsAtISO: "2026-05-03T03:00:00.000Z",
        timezone: "America/Chicago",
        kindLabel: "Tomorrow",
        addressText: "404 Elm St, Austin, TX",
      },
    });
    expect(subject).toBe("Reminder: Night Market Sessions starts tomorrow");
    expect(text).toContain("When:");
    expect(text).toContain("Can't make it? Open your signup");
    expect(text).not.toMatch(/reply/i);
    expect(text).toContain("May 2, 2026, 6:00 PM");
    expect(text).toContain("404 Elm St, Austin, TX");
    expect(`${subject} ${text}`).not.toMatch(/shift/i);
  });
});

// volunteer-ask-reminders R12: one person's roles on one ask (or event) at
// one start share one email listing every role.
describe("volunteer.start_reminder grouped", () => {
  const base = sampleInputFor("volunteer.start_reminder");

  it("lists every role; subject unchanged", async () => {
    const { subject, text, html } = await render({
      templateId: "volunteer.start_reminder",
      props: {
        ...base,
        title: "River cleanup day",
        kindLabel: "Tomorrow",
        roleName: "Litter picker",
        roleNames: ["Litter picker", "Check-in table", "Water station"],
      },
    });
    expect(subject).toBe("Reminder: River cleanup day starts tomorrow");
    expect(text).toContain("you signed up to volunteer at River cleanup day as:");
    for (const role of ["Litter picker", "Check-in table", "Water station"]) {
      expect(text).toContain(role);
    }
    expect(html.match(/<li[ >]/g)).toHaveLength(3);
  });

  it("a one-entry list reads as the single role", async () => {
    const single = await render({
      templateId: "volunteer.start_reminder",
      props: base,
    });
    const listed = await render({
      templateId: "volunteer.start_reminder",
      props: { ...base, roleNames: [base.roleName ?? "Litter picker"] },
    });
    expect(listed.text).toBe(single.text);
  });
});
