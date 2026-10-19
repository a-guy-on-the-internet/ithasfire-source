import { describe, expect, it } from "vitest";

import { render, sampleInputFor, type TemplateId } from "..";
import { formatInviteWhen } from "../templates/EventInvite";
import { tokens } from "../theme/tokens";

const TITLE = "Harbor Lights Supper Club";

const APPLICANT_TEMPLATES = [
  "event.application_received",
  "event.application_approved",
  "event.application_rejected",
  "event.application_waitlisted",
  "event.application_back_in_review",
] as const satisfies readonly TemplateId[];

const renderMinimal = (templateId: (typeof APPLICANT_TEMPLATES)[number]) =>
  render({ templateId, props: { eventTitle: TITLE } });

/**
 * Assertions read the HTML, never the derived plain `text`: in production core
 * sends its own text part (adapters use `text ?? rendered.text`), so the
 * template's derived text is not what a reader gets. This undoes React's
 * entity escaping and its `<!-- -->` text-node separators so copy can be
 * matched as written.
 */
const shown = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const EVENT_URL = "https://ithasfire.com/e/harbor-lights";
const STATUS_TEMPLATES = [
  "event.application_received",
  "event.application_waitlisted",
  "event.application_back_in_review",
] as const satisfies readonly TemplateId[];

describe("applicant application emails (printed frame)", () => {
  describe.each(APPLICANT_TEMPLATES)("%s", (templateId) => {
    it("renders with only eventTitle, in the printed frame", async () => {
      const { html } = await renderMinimal(templateId);
      expect(html).toContain(TITLE);
      expect(html).toContain("<h1");
      expect(html).toContain(tokens.colors.canvas);
      expect(html).toContain("IBM Plex Mono");
      expect(html).toContain('alt="Ithas Fire"');
      expect(html).toMatch(/<body[^>]*lang="en"[^>]*dir="ltr"/);
      // DS D-122: email drops shadows.
      expect(html).not.toMatch(/box-shadow/i);
    });

    it("has no reply line and no dead-end 'visit the event page' line without a contact", async () => {
      const { html } = await renderMinimal(templateId);
      expect(shown(html)).not.toContain("Reply to this email");
      expect(shown(html)).not.toMatch(/Visit the event page/i);
    });

    it("invites a reply when the organizer has a contact email", async () => {
      const { html } = await render({
        templateId,
        props: {
          eventTitle: TITLE,
          organizerContactEmail: "hosts@harborlights.example",
        },
      });
      expect(shown(html)).toContain(
        "Questions? Reply to this email to reach the organizer.",
      );
    });

    it("wraps the frame in an Outlook-only 600px ghost table", async () => {
      const { html } = await renderMinimal(templateId);
      expect(html).toContain(
        '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
      );
      expect(html).toContain("<!--[if mso]></td></tr></table><![endif]-->");
      expect(html.indexOf("<!--[if mso]><table")).toBeLessThan(
        html.indexOf("<h1"),
      );
      expect(html.indexOf("<!--[if mso]></td>")).toBeGreaterThan(
        html.indexOf("<h1"),
      );
      expect(html).not.toContain("th-mso-ghost");
    });

    it("does not expand a ghost-table marker typed into the event title", async () => {
      const marker = "<th-mso-ghost-open></th-mso-ghost-open>";
      const { html } = await render({
        templateId,
        props: { eventTitle: marker },
      });
      // Exactly the frame's own ghost table: React escapes the title, so the
      // post-render marker swap cannot fire on user text.
      expect(html.split("<!--[if mso]><table")).toHaveLength(2);
      expect(html).not.toContain(marker);
    });

    it("puts no vertical margin on tables (Outlook drops it) and pins the status bar line height", async () => {
      const { html } = await render({
        templateId,
        props: { ...sampleInputFor(templateId), eventTitle: TITLE },
      });
      // The card only: the shared EmailFooter (outside the card, used by
      // every template) still carries its own table margin.
      const footerAt = html.lastIndexOf(
        "<table",
        html.indexOf('href="https://ithasfire.live"'),
      );
      expect(footerAt).toBeGreaterThan(0);
      expect(html.slice(0, footerAt)).not.toMatch(
        /<table[^>]*style="[^"]*margin-top/,
      );
      expect(html).toContain("mso-line-height-rule:exactly");
    });

    it("renders no link at all when no URL is supplied", async () => {
      const { html } = await renderMinimal(templateId);
      // Only the platform footer may link out (the lockup is an image, not a link).
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)]
        .map((m) => m[1] ?? "")
        .filter((h) => !h.startsWith("https://fonts.googleapis.com"));
      expect(hrefs).toEqual(["https://ithasfire.live"]);
    });
  });

  it("received: no Applied row, no button, no guest line when those props are absent", async () => {
    const { html } = await renderMinimal("event.application_received");
    // "Applied" appears once: the status-bar label, not a ledger row.
    expect(html.match(/>Applied</g)).toHaveLength(1);
    expect(html).not.toContain("Check status");
    expect(shown(html)).not.toContain("Didn't apply?");
  });

  it("received: the guest line says only what is true", async () => {
    const { html } = await render({
      templateId: "event.application_received",
      props: { eventTitle: TITLE, isGuest: true },
    });
    expect(shown(html)).toContain(
      "Didn't apply? Ignore this email. Someone may have typed your address by mistake. No account was created.",
    );
    // Organizers DO see the applicant's email; never claim otherwise.
    expect(shown(html)).not.toMatch(/isn't shared|not shared/i);
  });

  describe.each(STATUS_TEMPLATES)("%s status button", (templateId) => {
    it("shows a bordered 'Check status' button for an account holder", async () => {
      const { html } = await render({
        templateId,
        props: { eventTitle: TITLE, eventUrl: EVENT_URL },
      });
      expect(html).toContain(`href="${EVENT_URL}"`);
      expect(html).toContain("Check status");
      // The secondary kind: white cell, 2px ink border on the <td>.
      expect(html).toMatch(
        new RegExp(`<td[^>]*border:2px solid ${tokens.colors.brand}`),
      );
      expect(html).not.toContain("Check your application");
    });

    it("drops the button for a guest, who can't see status on the event page", async () => {
      const { html } = await render({
        templateId,
        props: { eventTitle: TITLE, eventUrl: EVENT_URL, isGuest: true },
      });
      expect(html).not.toContain("Check status");
      expect(html).not.toContain(`href="${EVENT_URL}"`);
    });
  });

  it("approved: falls back to eventUrl for the button, with no raw-link line", async () => {
    const { html } = await render({
      templateId: "event.application_approved",
      props: { eventTitle: TITLE, eventUrl: EVENT_URL },
    });
    expect(html).toContain(`href="${EVENT_URL}"`);
    expect(html).toContain("Open the event");
    expect(shown(html)).not.toContain("Paste this link");
    expect(shown(html)).not.toContain("Link works until");
    expect(shown(html)).not.toContain("Open the event by");
    expect(html).not.toMatch(/within \d+ days/);
  });

  it("approved: the preview names the link's expiry date, not a fixed number of days", async () => {
    const { html } = await render({
      templateId: "event.application_approved",
      props: {
        eventTitle: TITLE,
        approvalUrl: `${EVENT_URL}/claim?token=abc`,
        // 7:30 PM Tue Oct 6 in Los Angeles; already Oct 7 in UTC.
        expiresAtISO: "2026-10-07T02:30:00.000Z",
        timezone: "America/Los_Angeles",
      },
    });
    expect(shown(html)).toContain(
      "The organizer approved your application. Open the event by Tue, Oct 6.",
    );
    expect(html).not.toMatch(/within \d+ days/);
  });

  it("approved: no button at all without approvalUrl or eventUrl", async () => {
    const { html } = await renderMinimal("event.application_approved");
    expect(html).not.toContain("Open the event");
  });

  it("approved: When row without the calendar link when calendarUrl is absent", async () => {
    const { html } = await render({
      templateId: "event.application_approved",
      props: {
        eventTitle: TITLE,
        startsAtISO: "2026-11-07T03:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
    });
    expect(shown(html)).toContain("Friday, November 6, 2026");
    expect(shown(html)).not.toContain("Add to calendar");
  });

  it("approved: no link expiry anywhere without approvalUrl, even when expiresAtISO is set", async () => {
    const { html } = await render({
      templateId: "event.application_approved",
      props: {
        eventTitle: TITLE,
        eventUrl: EVENT_URL,
        expiresAtISO: "2026-10-07T02:30:00.000Z",
        timezone: "America/Los_Angeles",
      },
    });
    // The button falls back to the event page, which never expires.
    expect(html).toContain(`href="${EVENT_URL}"`);
    expect(shown(html)).not.toContain("Link works until");
    expect(shown(html)).not.toContain("Open the event by");
    expect(shown(html)).toContain("The organizer approved your application.");
  });

  it("approved: an invalid timezone falls back instead of failing the send", async () => {
    const { html } = await render({
      templateId: "event.application_approved",
      props: {
        eventTitle: TITLE,
        approvalUrl: `${EVENT_URL}/claim?token=abc`,
        expiresAtISO: "2026-10-07T02:30:00.000Z",
        timezone: "Not/AZone",
      },
    });
    expect(shown(html)).toContain("Link works until");
  });

  // Core's text part reads an invalid zone in the platform default
  // ("Oct 6, 2026, 9:30 PM CDT", application-renderers.test.ts); the HTML used
  // to read it in UTC (Oct 7). Both now show the same Chicago clock.
  it("approved: an invalid timezone shows the same clock as the text part", async () => {
    const { html } = await render({
      templateId: "event.application_approved",
      props: {
        eventTitle: TITLE,
        approvalUrl: `${EVENT_URL}/claim?token=abc`,
        // 9:30 PM CDT Tue Oct 6 = 02:30Z Wed Oct 7.
        expiresAtISO: "2026-10-07T02:30:00.000Z",
        timezone: "Not/AZone",
      },
    });
    expect(shown(html)).toContain("Tue, Oct 6, 9:30 PM CDT");
    expect(shown(html)).toContain("Open the event by Tue, Oct 6.");
    expect(shown(html)).not.toContain("Oct 7");
  });

  it("rejected: no note block and the shorter preview without a reason", async () => {
    const { html } = await renderMinimal("event.application_rejected");
    expect(html).not.toContain("From the organizer");
    expect(html).not.toContain("left a note");
    expect(html).not.toContain("See other events");
  });

  it("rejected: a multi-line organizer note keeps its line breaks", async () => {
    const decisionReason =
      "Full this round.\nThe spring market is open to all.";
    const { html } = await render({
      templateId: "event.application_rejected",
      props: { eventTitle: TITLE, decisionReason },
    });
    expect(html).toContain(decisionReason);
    expect(html).toMatch(/<p[^>]*white-space:pre-line[^>]*>Full this round\./);
  });

  it("status bar: amber appears on the waitlist only", async () => {
    const declined = await renderMinimal("event.application_rejected");
    expect(declined.html).toContain("Not approved");
    const waitlisted = await renderMinimal("event.application_waitlisted");
    expect(waitlisted.html).toContain(tokens.colors.support);
    expect(declined.html).not.toContain(tokens.colors.support);
  });
});

describe("event.invite (personal invite, printed frame)", () => {
  // Distinctive so every place the bearer token surfaces can be counted.
  const TOKEN = "Tk9-bearer-secret-7f3a";
  const INVITE_URL = `https://ithasfire.com/e/harbor-lights?invite=${TOKEN}`;
  const STARTS = "2026-10-19T02:00:00.000Z";
  const ENDS = "2026-10-19T06:00:00.000Z";
  const ZONE = "America/Los_Angeles";

  // The variables exactly as core's sendInviteEmail builds them, nulls included.
  const coreVariables = (
    overrides: Record<string, string | null> = {},
  ) => ({
    eventTitle: TITLE,
    eventWhen: "Oct 18, 2026, 7:00 PM PDT",
    inviteeName: "Maya" as string | null,
    inviteUrl: INVITE_URL,
    organizerName: "Night Owl Collective" as string | null,
    startsAtIso: STARTS,
    endsAtIso: ENDS as string | null,
    timezone: ZONE as string | null,
    ...overrides,
  });

  const renderInvite = (overrides: Record<string, string | null> = {}) =>
    render({ templateId: "event.invite", props: coreVariables(overrides) });

  it("subject, kicker, accent headline and full body with both names", async () => {
    const { subject, html } = await renderInvite();
    expect(subject).toBe(`You’re invited: ${TITLE}`);
    const text = shown(html);
    expect(text).toContain("Invitation · Night Owl Collective");
    expect(html).toMatch(
      new RegExp(`<h1[^>]*color:${tokens.colors.brandAccent}[^>]*>You’re invited</h1>`),
    );
    expect(text).toContain(
      "Maya, Night Owl Collective invited you to a private event. The link below is yours. It opens the event page on any device, with no password and no application.",
    );
    expect(text).toContain(
      "This invite is for you. Anyone you forward it to can use it too.",
    );
    // Not an application: no status bar.
    expect(text).not.toContain("Applied");
    expect(html).not.toMatch(/box-shadow/i);
  });

  it("ledger: Event, When in the event's zone, and the link lasting until the event ends", async () => {
    const { html } = await renderInvite();
    const text = shown(html);
    expect(text).toContain(">Event<");
    // The board's short form, in the event's zone (02:00Z = 7 PM PDT the day before).
    // Date and time range each stay whole (nowrap span + no-break spaces);
    // the ordinary space after "·" is the only place the line can wrap.
    expect(text).toContain(
      '<span style="white-space:nowrap">Sun,\u00a0Oct\u00a018</span>\u00a0· <span style="white-space:nowrap">7:00\u00a0–\u00a011:00\u00a0PM</span>',
    );
    expect(text).toContain(">Link works until<");
    expect(text).toContain(">The event ends<");
  });

  it("When falls back to core's preformatted line without a usable start", async () => {
    const { html } = await renderInvite({ startsAtIso: null, endsAtIso: null });
    expect(shown(html)).toContain(">Oct 18, 2026, 7:00 PM PDT<");
  });

  it("no timezone: core's zone-labelled eventWhen line wins", async () => {
    const { html } = await renderInvite({ endsAtIso: null, timezone: null });
    expect(shown(html)).toContain(">Oct 18, 2026, 7:00 PM PDT<");
  });

  it("no timezone and no eventWhen: the runtime-zone short form as a last resort", async () => {
    const { html } = await renderInvite({ timezone: null, eventWhen: null });
    const when = formatInviteWhen(STARTS, ENDS, null);
    // Exact match against the runtime-zone output (whatever the host zone),
    // and never core's line.
    expect(shown(html)).not.toContain("PDT<");
    expect(shown(html).replace(/<\/?span[^>]*>/g, "")).toContain(`>${when}<`);
  });

  it("When in a half-hour zone is exact", () => {
    expect(formatInviteWhen(STARTS, ENDS, "Asia/Kolkata")).toBe(
      "Mon,\u00a0Oct\u00a019\u00a0· 7:30\u00a0–\u00a011:30\u00a0AM",
    );
  });

  it("When across midnight shows both short instants", () => {
    expect(
      formatInviteWhen(STARTS, "2026-10-19T08:00:00.000Z", ZONE),
    ).toBe("Sun, Oct 18, 7:00 PM – Mon, Oct 19, 1:00 AM");
  });

  it("When with no end shows the start time alone", () => {
    expect(formatInviteWhen(STARTS, null, ZONE)).toBe(
      "Sun,\u00a0Oct\u00a018\u00a0· 7:00\u00a0PM",
    );
  });

  it("an unknown timezone falls back to eventWhen instead of failing the send", async () => {
    const { html } = await renderInvite({ timezone: "Not/AZone" });
    expect(shown(html)).toContain(">Oct 18, 2026, 7:00 PM PDT<");
    expect(formatInviteWhen(STARTS, ENDS, "Not/AZone")).toBe(
      formatInviteWhen(STARTS, ENDS, null),
    );
  });

  it("CTA 'Open the event' points at the invite URL, with the raw link below", async () => {
    const { html } = await renderInvite();
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="${INVITE_URL.replace(/[?.]/g, "\\$&")}"[^>]*>[\\s\\S]*?Open the event`),
    );
    expect(shown(html)).toContain(
      "Button not working? Paste this link into your browser:",
    );
    expect(html).toMatch(new RegExp(`<p[^>]*>${INVITE_URL.replace(/[?.]/g, "\\$&")}</p>`));
  });

  it("the token appears only in the button href and the raw-link line", async () => {
    const { subject, html, text } = await renderInvite();
    expect(subject).not.toContain(TOKEN);
    expect(html.split(TOKEN)).toHaveLength(3);
    // The href and the raw <p>; nothing in <head>, the preview or alt text.
    const head = html.slice(0, html.indexOf("<body"));
    expect(head).not.toContain(TOKEN);
    expect(html).not.toMatch(new RegExp(`alt="[^"]*${TOKEN}`));
    // Core sends no text part, so this derived text is what readers get.
    expect(text.split(TOKEN)).toHaveLength(3);
  });

  it("no invitee name: the body opens with the organizer", async () => {
    const { html } = await renderInvite({ inviteeName: null });
    const text = shown(html);
    expect(text).toContain(
      ">Night Owl Collective invited you to a private event. The link below is yours.",
    );
    expect(text).not.toContain("Maya");
  });

  it("no organizer name: plain 'Invitation' kicker, the guest's name kept", async () => {
    const { html } = await renderInvite({ organizerName: null });
    const text = shown(html);
    expect(text).toContain(">Invitation<");
    expect(text).not.toContain("Invitation ·");
    expect(text).toContain(
      ">Maya, you’re invited to a private event. The link below is yours. It opens the event page on any device, with no password and no application.",
    );
  });

  it("no organizer and no name: the generic opening", async () => {
    const { html } = await renderInvite({ organizerName: null, inviteeName: null });
    const text = shown(html);
    expect(text).toContain(">Invitation<");
    expect(text).not.toContain("Invitation ·");
    expect(text).toContain(
      ">You’re invited to a private event. The link below is yours. It opens the event page on any device, with no password and no application.",
    );
  });

  it("rejects a payload without a valid invite URL", async () => {
    await expect(
      render({
        templateId: "event.invite",
        props: { ...coreVariables(), inviteUrl: "not a url" },
      }),
    ).rejects.toThrow(/props failed validation/);
  });

  it.each(["inviteUrl", "eventTitle"] as const)(
    "rejects a payload missing %s",
    async (key) => {
      const props: Record<string, unknown> = { ...coreVariables() };
      delete props[key];
      await expect(
        render({
          templateId: "event.invite",
          props: props as ReturnType<typeof coreVariables>,
        }),
      ).rejects.toThrow(/props failed validation/);
    },
  );

  it("rejects a blank eventTitle", async () => {
    await expect(
      render({
        templateId: "event.invite",
        props: { ...coreVariables(), eventTitle: "" },
      }),
    ).rejects.toThrow(/props failed validation/);
  });

  describe("Stop invites footer (owner ruling 10-05)", () => {
    const STOP_URL = "https://ithasfire.com/invites/stop?token=iso_optout-abc";

    it("renders a 'Stop invites from <organiser>' link in the link colour as the last small-print line", async () => {
      const { html, text: plain } = await renderInvite({ stopInvitesUrl: STOP_URL });
      const text = shown(html);
      expect(text).toContain("Stop invites from Night Owl Collective");
      expect(html).toContain(`href="${STOP_URL.replace(/&/g, "&amp;")}"`);
      // Board decision 1 (A): the email's link colour, #B93312, underlined…
      expect(tokens.colors.brandAccent).toBe("#B93312");
      const anchor = new RegExp(
        `<a[^>]*href="${STOP_URL.replace(/[.?]/g, "\\$&")}"[^>]*>`,
      ).exec(html)?.[0];
      expect(anchor).toContain(`color:${tokens.colors.brandAccent}`);
      expect(anchor).toContain("text-decoration:underline");
      // …inside the 14px muted small print.
      expect(html).toMatch(
        new RegExp(
          `<p[^>]*font-size:14px[^>]*color:${tokens.colors.mutedText}[^>]*><a[^>]*href="${STOP_URL.replace(/[.?]/g, "\\$&")}"`,
        ),
      );
      // After the forwarding note, i.e. the very last line.
      expect(text.indexOf("Stop invites from")).toBeGreaterThan(
        text.indexOf("Anyone you forward it to can use it too."),
      );
      // Plain text: "Stop invites from <organiser>: <url>", not "[url]".
      expect(plain).toContain(
        `Stop invites from Night Owl Collective: ${STOP_URL}`,
      );
      expect(plain).not.toContain(`[${STOP_URL}]`);
      // The invite token stays in exactly its two places.
      expect(html.split(TOKEN).length - 1).toBe(
        (await renderInvite()).html.split(TOKEN).length - 1,
      );
    });

    it("falls back to 'this organiser' without a name", async () => {
      const { html, text: plain } = await renderInvite({
        stopInvitesUrl: STOP_URL,
        organizerName: null,
      });
      expect(shown(html)).toContain("Stop invites from this organiser");
      expect(plain).toContain(`Stop invites from this organiser: ${STOP_URL}`);
    });

    it("leaves every other link in the text part as 'Label [url]'", async () => {
      const { text: plain } = await renderInvite({ stopInvitesUrl: STOP_URL });
      expect(plain).toContain(`Open the event [${INVITE_URL}]`);
    });

    it("no URL, no line", async () => {
      const { html } = await renderInvite({ stopInvitesUrl: null });
      expect(shown(html)).not.toContain("Stop invites");
    });

    it("rejects a non-URL stopInvitesUrl", async () => {
      await expect(
        render({
          templateId: "event.invite",
          props: { ...coreVariables(), stopInvitesUrl: "javascript:alert(1)x y" },
        }),
      ).rejects.toThrow(/props failed validation/);
    });
  });
});
