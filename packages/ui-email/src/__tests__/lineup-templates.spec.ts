import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

const LINEUPS_URL = "https://ithasfire.com/my-lineups";
const PAYOUTS_URL = "https://ithasfire.com/admin/@the-sundowners/payments";
const COMPLETE_URL =
  "https://ithasfire.com/auth/complete?email=band%40example.org&src=lineup-invite";

const GENDERED = /\b(he|she|him|her|his|hers)\b/i;

describe("event.lineup_added", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "event.lineup_added",
      props: sampleInputFor("event.lineup_added"),
    });
    expect(out.html).toContain("<html");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("carries the owner's copy: subject, heading, Event/When/As rows, button, footer", async () => {
    const out = await render({
      templateId: "event.lineup_added",
      props: {
        addedByName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
        roleLabel: "Performer",
        lineupsUrl: LINEUPS_URL,
        publiclyListed: true,
        eventEnded: false,
        organiserWillBeTold: true,
      },
    });
    expect(out.subject).toBe("You're on the lineup for Friday Night Sessions");
    expect(out.text).toContain("Sam Rivera put you on a lineup");
    expect(out.text).toContain("Friday Night Sessions");
    expect(out.text).toContain(
      "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
    );
    expect(out.text).toContain("Performer");
    expect(out.text).toContain("The organiser will be told.");
    expect(out.text).toContain("You can't turn these off, so you know where your name appears.");
    expect(out.html).toContain(`href="${LINEUPS_URL}"`);
    expect(out.html).toContain("Review your lineups");
    expect(out.text).not.toMatch(GENDERED);
  });

  it("claims only what is true: private/volunteer rows and ownerless listings", async () => {
    const out = await render({
      templateId: "event.lineup_added",
      props: {
        addedByName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "",
        roleLabel: "Volunteer",
        lineupsUrl: LINEUPS_URL,
        publiclyListed: false,
        eventEnded: false,
        organiserWillBeTold: false,
      },
    });
    expect(out.text).toContain("Your name is on the lineup for this event.");
    expect(out.text).not.toContain("event page");
    expect(out.text).not.toContain("The organiser will be told.");
    expect(out.text).toContain("you can take yourself off the lineup.");
  });

  it("an ended event's notice promises no 'upcoming shows'", async () => {
    const out = await render({
      templateId: "event.lineup_added",
      props: {
        addedByName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "",
        roleLabel: "DJ",
        lineupsUrl: LINEUPS_URL,
        publiclyListed: true,
        eventEnded: true,
        organiserWillBeTold: true,
      },
    });
    expect(out.text).toContain("Your name shows on the event page.");
    expect(out.text).not.toContain("upcoming shows");
  });

  it("drops the When row cleanly when there is no date", async () => {
    const out = await render({
      templateId: "event.lineup_added",
      props: {
        addedByName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "",
        roleLabel: "DJ",
        lineupsUrl: LINEUPS_URL,
        publiclyListed: true,
        eventEnded: false,
        organiserWillBeTold: true,
      },
    });
    expect(out.html).not.toContain("When:");
    expect(out.html).not.toContain("undefined");
  });

  it("escapes a hostile adder name instead of rendering markup", async () => {
    const out = await render({
      templateId: "event.lineup_added",
      props: {
        addedByName: "<img src=x onerror=alert(1)>",
        eventTitle: "Show",
        whenLabel: "",
        roleLabel: "Host",
        lineupsUrl: LINEUPS_URL,
        publiclyListed: true,
        eventEnded: false,
        organiserWillBeTold: true,
      },
    });
    expect(out.html).not.toContain("<img src=x");
  });
});

describe("event.lineup_payout_invite", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "event.lineup_payout_invite",
      props: sampleInputFor("event.lineup_payout_invite"),
    });
    expect(out.html).toContain("<html");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("an existing account goes straight to payouts, with a way off the lineup", async () => {
    const out = await render({
      templateId: "event.lineup_payout_invite",
      props: {
        inviterName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
        payoutsUrl: PAYOUTS_URL,
        accountCompletionUrl: null,
        lineupsUrl: LINEUPS_URL,
        paidEvent: true,
        organiserWillBeTold: true,
      },
    });
    expect(out.subject).toBe(
      "Sam Rivera invited you to set up payouts for Friday Night Sessions",
    );
    expect(out.html).toContain("Set up payouts");
    expect(out.text).toContain("To be paid your share of ticket sales");
    expect(out.text).toContain("The organiser will be told.");
    expect(out.html).toContain(`href="${PAYOUTS_URL}"`);
    expect(out.html).not.toContain("Finish your account");
    expect(out.html).toContain(`href="${LINEUPS_URL}"`);
    expect(out.text).not.toMatch(GENDERED);
    // The date is its own row — never nested inside the sentence's parens.
    expect(out.text).toContain(
      "When: Sunday, October 4, 2026 at 5:00 PM (Chicago time)",
    );
    expect(out.text).not.toContain("((");
  });

  it("a free event or an ownerless listing gets neutral wording", async () => {
    const out = await render({
      templateId: "event.lineup_payout_invite",
      props: {
        inviterName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "",
        payoutsUrl: PAYOUTS_URL,
        accountCompletionUrl: null,
        lineupsUrl: LINEUPS_URL,
        paidEvent: false,
        organiserWillBeTold: false,
      },
    });
    expect(out.text).not.toContain("share of ticket sales");
    expect(out.text).toContain("To be paid through Ithas Fire for this event");
    expect(out.text).not.toContain("The organiser will be told.");
  });

  it("a shadow profile is asked to finish an account first", async () => {
    const out = await render({
      templateId: "event.lineup_payout_invite",
      props: {
        inviterName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "",
        payoutsUrl: PAYOUTS_URL,
        accountCompletionUrl: COMPLETE_URL,
        lineupsUrl: LINEUPS_URL,
        paidEvent: true,
        organiserWillBeTold: true,
      },
    });
    expect(out.html).toContain("Finish your account");
    expect(out.html).toContain(`href="${COMPLETE_URL.replace(/&/g, "&amp;")}"`);
    // The payouts link is still there, for after sign-up.
    expect(out.html).toContain(`href="${PAYOUTS_URL}"`);
  });
});
