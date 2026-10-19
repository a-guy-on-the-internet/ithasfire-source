import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// `kindLabel` arrives sentence-case ("Tomorrow", "In about an hour") because
// the eyebrow and the lead line start with it. The subject puts it mid-
// sentence, so it is lowercased there, the same way the component's <title>
// does. A plain {{kindLabel}} subject template read "starts In about an hour".
describe("volunteer.shift_reminder subject", () => {
  it.each([
    ["In about an hour", "in about an hour"],
    ["Tomorrow", "tomorrow"],
  ])("kindLabel %s reads '…shift starts %s'", async (kindLabel, expected) => {
    const props = {
      ...sampleInputFor("volunteer.shift_reminder"),
      eventTitle: "Night Market Sessions",
      kindLabel,
    };

    const { subject } = await render({
      templateId: "volunteer.shift_reminder",
      props,
    });

    expect(subject).toBe(
      `Reminder: your Night Market Sessions shift starts ${expected}`,
    );
  });
});

// No reply-to is set on these emails, so a reply reaches the platform, not
// the organizer: the footer promises nothing about replying.
describe("volunteer.shift_reminder footer", () => {
  it("links to the signup and makes no reply promise", async () => {
    const { text } = await render({
      templateId: "volunteer.shift_reminder",
      props: sampleInputFor("volunteer.shift_reminder"),
    });
    expect(text).toContain("Can't make it? Open your signup");
    expect(text).not.toMatch(/reply/i);
  });

  it("without a manage link there is no footer at all", async () => {
    const { text } = await render({
      templateId: "volunteer.shift_reminder",
      props: { ...sampleInputFor("volunteer.shift_reminder"), manageUrl: null },
    });
    expect(text).not.toContain("Can't make it?");
  });
});

// volunteer-ask-reminders R12: one person's shifts at one event starting at
// the same time share one email that lists each shift with its window.
describe("volunteer.shift_reminder grouped", () => {
  const base = sampleInputFor("volunteer.shift_reminder");

  it("lists every shift with its label and its own end; the subject says shifts", async () => {
    const { subject, text, html } = await render({
      templateId: "volunteer.shift_reminder",
      props: {
        ...base,
        eventTitle: "Night Market Sessions",
        roleName: "Door greeter",
        shiftLabel: "Evening",
        // 2026-05-02 17:00 CDT.
        shiftStartsAtISO: "2026-05-02T22:00:00.000Z",
        shiftEndsAtISO: "2026-05-03T02:00:00.000Z",
        timezone: "America/Chicago",
        kindLabel: "Tomorrow",
        roles: [
          {
            roleName: "Door greeter",
            shiftLabel: "Evening",
            shiftEndsAtISO: "2026-05-03T02:00:00.000Z",
          },
          {
            roleName: "Bar back",
            shiftLabel: null,
            shiftEndsAtISO: "2026-05-03T00:00:00.000Z",
          },
        ],
      },
    });

    expect(subject).toBe(
      "Reminder: your Night Market Sessions shifts start tomorrow",
    );
    expect(html).toContain(
      "<title>Reminder: your Night Market Sessions shifts start tomorrow</title>",
    );
    expect(text).toContain("Your shifts are coming up.");
    expect(text).toContain("Door greeter (Evening):");
    expect(text).toContain("May 2, 2026, 5:00 PM – May 2, 2026, 9:00 PM");
    expect(text).toContain("Bar back:");
    expect(text).toContain("May 2, 2026, 5:00 PM – May 2, 2026, 7:00 PM");
    expect(text).not.toContain("Shift: Evening");
    expect(html.match(/<li[ >]/g)).toHaveLength(2);
    expect(text).toContain("Can't make it? Open your signup");
  });

  it("a one-entry list reads as a single shift, exactly as without one", async () => {
    const single = await render({
      templateId: "volunteer.shift_reminder",
      props: base,
    });
    const listed = await render({
      templateId: "volunteer.shift_reminder",
      props: {
        ...base,
        roles: [{ roleName: base.roleName, shiftLabel: base.shiftLabel }],
      },
    });
    expect(listed.text).toBe(single.text);
    expect(listed.subject).toBe(single.subject);
    expect(listed.subject).toContain(" shift starts ");
    expect(listed.text).toContain("Your shift is coming up.");
  });
});
