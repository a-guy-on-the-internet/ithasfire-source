import { describe, expect, it } from "vitest";

import {
  listTemplates,
  render,
  sampleInputFor,
  type TemplateId,
  type TemplateProps,
} from "..";

const templateIds: TemplateId[] = [
  "ticket.issued",
  "order.receipt",
  "event.announcement",
  "event.details",
  "event.location_revealed",
  // `auth.verify_email_link` was removed when verification migrated to OTP;
  // `auth.verification_code` (the OTP template) is the only auth template
  // in this smoke set.
  "auth.verification_code",
  "booking.request_received",
  "booking.invite_to_claim",
  "booking.hold_placed",
  "booking.hold_challenged",
  "booking.hold_released",
  "booking.hold_confirmed",
  "booking.hold_staff_attention",
  "booking.lineup_invited",
  "membership.renewal_notice",
  "event.application_received",
  "event.application_approved",
  "event.application_rejected",
  "event.application_submission_received",
  "event.application_waitlisted",
  "event.application_back_in_review",
  // The per-date call-off notice. In the smoke set because its whole job is
  // naming ONE date of a series that is still running — a template that
  // rendered an empty or event-level headline would be the exact sentence the
  // feature exists to avoid sending.
  "rsvp.date_cancelled",
  "settlement.payout_sent",
  "order.bank_payment_failed",
];

describe("render", () => {
  templateIds.forEach((templateId) => {
    it(`returns subject/html/text for ${templateId}`, async () => {
      const props = sampleInputFor(templateId);
      const { subject, html, text } = await render({ templateId, props });

      expect(subject).toBeTypeOf("string");
      expect(subject.length).toBeGreaterThan(0);
      expect(html).toContain("<html");
      expect(html).toContain("</html>");
      expect(text.trim().length).toBeGreaterThan(0);

      if (templateId === "ticket.issued") {
        expect(html).toContain("Your tickets are ready");
        expect(html).toContain("Manage Order");
        // Support is reachable, but as the fine-print sentence's link only.
        // The separate "Get Support" action link was removed deliberately: it
        // pointed at the same href as that sentence, and a bold underline
        // directly beneath the filled primary read as a competing button.
        // Assert the LINK rather than a label so re-wording the copy doesn't
        // break this, while dropping the affordance entirely still does.
        expect(html).toContain('href="https://ithasfire.com/help"');
        // QR is now the affordance itself; the previous "View QR Code"
        // button was dropped (it pointed to the same URL as the image)
        // so the QR `<Img>` carries the link and the alt text both.
        expect(html).toMatch(/QR code for\s+/);
        expect(text).toContain("Manage Order");
      }

      if (templateId === "auth.verification_code") {
        expect(text).toMatch(/expires in/);
      }

      if (templateId === "event.location_revealed") {
        expect(html).toContain("is now live");
        expect(html).toContain("1114 Fatherland St");
        expect(html).toContain("Get directions");
        expect(html).toContain("View event");
      }

      // The application emails assert on the HTML only: core sends its own
      // plain-text part for them, so the derived `text` never reaches a reader.
      const shown = html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

      if (templateId === "event.application_received") {
        expect(subject).toBe("Application sent: Night Market Sessions");
        expect(html).toContain("Your application is in");
        expect(shown).toContain("Your spot isn't confirmed yet");
        // Applied date renders in the EVENT timezone (18:12Z = 11:12 PDT).
        expect(shown).toContain("Tue, Sep 29");
        // Sample is a guest applicant: the guest line, and no status button
        // (guests can't see their status on the event page).
        expect(shown).toContain("No account was created.");
        expect(html).not.toContain("Check status");
      }

      if (templateId === "event.application_approved") {
        expect(subject).toBe("You're in: Night Market Sessions");
        expect(html).toContain("Open the event");
        // Expiry in the event zone, with the zone abbreviation.
        expect(shown).toContain("Tue, Oct 6, 7:30 PM PDT");
        expect(shown).toContain(
          "The organizer approved your application. Open the event by Tue, Oct 6.",
        );
        expect(shown).toContain("Paste this link into your browser");
        // No calendar chooser page exists yet, so the sample sends none.
        expect(html).not.toContain("Add to calendar");
      }

      if (templateId === "event.application_rejected") {
        // Direct, not soft: the decision, the note, no apology.
        expect(subject).toBe("Not approved: Night Market Sessions");
        expect(html).toContain("more applications than spots");
        expect(html).toContain("From the organizer");
        expect(html).toContain("See other events from this organizer");
        expect(html).not.toMatch(/rejected/i);
        expect(shown).not.toMatch(/sorry|thanks for applying/i);
      }

      if (templateId === "event.application_waitlisted") {
        expect(subject).toBe("Waitlisted: Night Market Sessions");
        expect(html).toContain("on the waitlist");
        expect(html).not.toMatch(/rejected/i);
      }

      if (templateId === "event.application_back_in_review") {
        expect(subject).toBe("Back in review: Night Market Sessions");
        expect(html).toContain("Your approval was withdrawn");
        expect(shown).toContain("back in review");
        expect(html).toContain("Check status");
        // A guest's unlock cookie can't be revoked: never claim lost access.
        expect(shown).not.toMatch(
          /no longer|lost access|access (was|has been) removed/i,
        );
      }

      if (templateId === "event.application_submission_received") {
        expect(subject).toContain("New application for");
        expect(html).toContain("Jordan Alvarez");
        expect(html).toContain("Review applications");
        expect(html).toContain(
          "https://ithasfire.com/admin/night-market/events/evt_123/applications",
        );
      }

      if (templateId === "membership.renewal_notice") {
        // Dispute-prevention essentials: tier, amount, the OWNER's name (what
        // the card statement shows) and a working cancel affordance.
        expect(subject).toContain("Sustaining Member");
        expect(subject).toContain("$10.98");
        expect(html).toContain("DRKMTTR Collective");
        expect(html).toContain("Manage or cancel membership");
        expect(html).toContain("https://ithasfire.com/account/memberships");
        expect(text).toContain("Manage or cancel membership");
      }
    });
  });

  describe("booking hold templates (FR-016)", () => {
    const ACT_URL = "https://ithasfire.com/account/settings/booking-requests";

    it("hold_placed: placed vs moved subjects, position wording, no other act named", async () => {
      const placed = await render({
        templateId: "booking.hold_placed",
        props: { kind: "placed", placeName: "The Corner Stage", dateLabel: "Fri, Aug 14, 2026", position: 3, targetUrl: ACT_URL },
      });
      expect(placed.subject).toBe("The Corner Stage is holding Fri, Aug 14, 2026 for you");
      expect(placed.html).toContain("3rd in line");
      expect(placed.html).toContain("not a booking yet");
      expect(placed.html).toContain(ACT_URL);

      const moved = await render({
        templateId: "booking.hold_placed",
        props: { kind: "moved", placeName: "The Corner Stage", dateLabel: "Fri, Aug 14, 2026", position: 1, targetUrl: ACT_URL },
      });
      expect(moved.subject).toBe("You're now first in line for Fri, Aug 14, 2026");
      expect(moved.html).toContain("First in line");
      expect(moved.text).toContain("front of the line");
    });

    it("hold_placed (placed_batch): ONE email lists every date and its position, and no other act", async () => {
      const batch = await render({
        templateId: "booking.hold_placed",
        props: {
          kind: "placed_batch",
          placeName: "The Corner Stage",
          dates: [
            { dateLabel: "Fri, Aug 14, 2026", position: 1 },
            { dateLabel: "Sat, Aug 15, 2026", position: 2 },
            { dateLabel: "Fri, Aug 21, 2026", position: 3 },
          ],
          targetUrl: ACT_URL,
        },
      });
      // Subject mirrors the core renderer title for booking.hold-placed-batch.
      expect(batch.subject).toBe("The Corner Stage is holding 3 dates for you");
      expect(batch.html).toContain("Fri, Aug 14, 2026");
      expect(batch.html).toContain("Sat, Aug 15, 2026");
      expect(batch.html).toContain("Fri, Aug 21, 2026");
      expect(batch.html).toContain("First in line");
      expect(batch.html).toContain("2nd in line");
      expect(batch.html).toContain("3rd in line");
      expect(batch.html).toContain("not a booking yet");
      expect(batch.html).toContain(ACT_URL);
      // FR-013: nothing about the rest of the line.
      expect(batch.text).not.toMatch(/another act/i);
    });

    it("hold_challenged: position 1 gets the keep/release CTA, position 2 gets the you'll-hear-by copy, extended flips the subject", async () => {
      const base = {
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        respondByLabel: "Thu, Aug 6 at 7:00 PM CDT",
        targetUrl: ACT_URL,
      };
      const challenged = await render({
        templateId: "booking.hold_challenged",
        props: { ...base, position: 1, extended: false },
      });
      expect(challenged.subject).toBe("The Corner Stage needs an answer on Fri, Aug 14, 2026");
      expect(challenged.html).toContain("Keep or release the hold");
      expect(challenged.html).toContain("ANSWER BY");
      expect(challenged.html).toContain("Thu, Aug 6 at 7:00 PM CDT");

      const extended = await render({
        templateId: "booking.hold_challenged",
        props: { ...base, position: 1, extended: true },
      });
      expect(extended.subject).toBe("More time to answer The Corner Stage about Fri, Aug 14, 2026");
      expect(extended.html).toContain("deadline moved later");

      const second = await render({
        templateId: "booking.hold_challenged",
        props: { ...base, position: 2, extended: false },
      });
      expect(second.subject).toBe("The first hold on Fri, Aug 14, 2026 was challenged");
      expect(second.html).toContain("next in line");
      expect(second.html).not.toContain("Keep or release the hold");
      expect(second.html).toContain("View your request");
    });

    // ── booking-the-night P2d-2 ── N20 copy + what Keep will do (FR-014).
    it("hold_challenged: 'another act is ready' (never who), and the lede says what Keep will do", async () => {
      const base = {
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        respondByLabel: "Thu, Aug 6 at 7:00 PM CDT",
        targetUrl: ACT_URL,
        position: 1 as const,
        extended: false,
      };
      const bookNow = await render({ templateId: "booking.hold_challenged", props: { ...base, keepWill: "book_now" } });
      expect(bookNow.text).toContain("Another act is ready to book Fri, Aug 14, 2026.");
      expect(bookNow.text).toContain("Agree your terms by Thu, Aug 6 at 7:00 PM CDT to keep it.");
      const ask = await render({ templateId: "booking.hold_challenged", props: { ...base, keepWill: "ask_for_terms" } });
      // Review W2: before the tap there is no deadline yet — "within 48 hours of keeping".
      expect(ask.text).toContain("Keep it by Thu, Aug 6 at 7:00 PM CDT and the place sends you terms. Agree them within 48 hours of keeping, or the hold lapses.");
      expect(ask.text).not.toMatch(/You then have 48 hours/);
      const plain = await render({ templateId: "booking.hold_challenged", props: base });
      expect(plain.text).toContain("Another act is ready to book Fri, Aug 14, 2026.");
      expect(plain.text).not.toMatch(/Another act wants/);
    });

    it("hold_staff_attention: kept with no terms sent asks the venue to send them, with the act's deadline", async () => {
      const r = await render({
        templateId: "booking.hold_staff_attention",
        props: {
          kind: "answered_kept",
          actName: "The Fake Band",
          placeName: "The Corner Stage",
          dateLabel: "Fri, Aug 14, 2026",
          targetUrl: ACT_URL,
          respondByLabel: "Sat, Aug 8 at 7:00 PM CDT",
        },
      });
      expect(r.text).toContain("Send them terms to keep this night. They have until Sat, Aug 8 at 7:00 PM CDT to agree");
    });

    it("hold_released: every reason renders its own line and subject", async () => {
      const base = { placeName: "The Corner Stage", dateLabel: "Fri, Aug 14, 2026", targetUrl: ACT_URL };
      const cases: Array<[TemplateProps<"booking.hold_released">["reason"], string, string]> = [
        ["released", "was released", "released the hold"],
        ["request_closed", "was released", "request was closed"],
        ["sibling_confirmed", "was released", "different date"],
        ["lost_date", "went to another act", "propose another date"],
        ["expired", "lapsed", "without an answer"],
        ["event_scheduled", "was released", "scheduled an event on that date"],
      ];
      for (const [reason, subjectPart, bodyPart] of cases) {
        const out = await render({ templateId: "booking.hold_released", props: { ...base, reason } });
        expect(out.subject, reason).toContain(subjectPart);
        expect(out.html, reason).toContain(bodyPart);
        expect(out.text, reason).toContain(ACT_URL);
      }
    });

    it("hold_confirmed: subject matches the renderer title", async () => {
      const out = await render({
        templateId: "booking.hold_confirmed",
        props: { placeName: "The Corner Stage", dateLabel: "Fri, Aug 14, 2026", targetUrl: ACT_URL },
      });
      expect(out.subject).toBe("The Corner Stage confirmed Fri, Aug 14, 2026");
      expect(out.html).toContain("View your booking");
      expect(out.html).toContain("draft event");
    });

    it("hold_staff_attention: answered_kept / answered_released / expired", async () => {
      const base = {
        actName: "The Midnight Ramblers",
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        targetUrl: "https://ithasfire.com/admin/corner-stage/places/plc_123/bookings",
      };
      const kept = await render({ templateId: "booking.hold_staff_attention", props: { ...base, kind: "answered_kept" } });
      expect(kept.subject).toBe("The Midnight Ramblers kept their hold on Fri, Aug 14, 2026");
      expect(kept.html).toContain("Confirm the hold");
      expect(kept.html).toContain("Open booking inbox");

      const released = await render({ templateId: "booking.hold_staff_attention", props: { ...base, kind: "answered_released" } });
      expect(released.subject).toBe("The Midnight Ramblers released their hold on Fri, Aug 14, 2026");
      expect(released.html).toContain("moved up");

      const expired = await render({ templateId: "booking.hold_staff_attention", props: { ...base, kind: "expired" } });
      expect(expired.subject).toBe("Hold for The Midnight Ramblers on Fri, Aug 14, 2026 lapsed");
      expect(expired.html).toContain("in time");
      expect(expired.text).toContain(base.targetUrl);
    });
  });

  describe("booking lineup invite (lineup-booking-requests v2 FR-003)", () => {
    const TARGET = "https://ithasfire.com/bookings/acts/44444444-4444-4444-8444-444444444444";

    it("subject mirrors the renderer title; names sender, venue and dates; one Review link; calm copy", async () => {
      const out = await render({
        templateId: "booking.lineup_invited",
        props: {
          senderName: "Corner Booking Collective",
          venueName: "The Corner Stage",
          dateLabels: ["Fri, Aug 14, 2026 at 8:00 PM"],
          targetUrl: TARGET,
        },
      });
      expect(out.subject).toBe("Corner Booking Collective added you to a bill at The Corner Stage");
      expect(out.html).toContain("Corner Booking Collective");
      expect(out.html).toContain("The Corner Stage");
      expect(out.html).toContain("Fri, Aug 14, 2026 at 8:00 PM");
      expect(out.html).toContain(`href="${TARGET}"`);
      expect(out.html).toContain("Review");
      expect(out.text).toContain(TARGET);
      // NFR-002: no urgency, no deadline language.
      expect(out.html).not.toMatch(/urgent|expires|deadline|act now|hurry/i);
    });

    it("renders without dates (the dates block is omitted, not empty)", async () => {
      const out = await render({
        templateId: "booking.lineup_invited",
        props: { senderName: "Sam", venueName: "The Corner Stage", dateLabels: [], targetUrl: TARGET },
      });
      expect(out.html).not.toContain("DATES THEY ASKED ABOUT");
      expect(out.subject).toBe("Sam added you to a bill at The Corner Stage");
    });

    it("escapes a hostile sender name instead of rendering markup", async () => {
      const out = await render({
        templateId: "booking.lineup_invited",
        props: {
          senderName: "<script>alert(1)</script>",
          venueName: "The Corner Stage",
          dateLabels: [],
          targetUrl: TARGET,
        },
      });
      expect(out.html).not.toContain("<script>alert(1)</script>");
    });
  });

  it("localizes the ticket issued template subject and body", async () => {
    const props = sampleInputFor("ticket.issued");
    const es = await render({
      templateId: "ticket.issued",
      props,
      locale: "es",
    });
    const en = await render({
      templateId: "ticket.issued",
      props,
      locale: "en",
    });

    expect(en.subject).toBe("Your tickets are ready: Indie Fest 2025");
    expect(es.subject).toBe("Tus entradas están listas: Indie Fest 2025");
    expect(es.html).toContain("Gestionar pedido");
    expect(es.text).toContain("Gestionar pedido");
    expect(es.html).toContain('lang="es"');
  });

  it("renders the account-claim CTA only when accountCompletionUrl is set", async () => {
    // Default sample has no completion URL — no claim block.
    const base = sampleInputFor("ticket.issued");
    const withoutClaim = await render({ templateId: "ticket.issued", props: base });
    expect(withoutClaim.html).not.toContain("Save to an account");

    // Shadow (guest) comp recipients carry the /auth/complete link.
    const claimUrl =
      "https://ithasfire.com/auth/complete?email=guest%40example.com&src=volunteer-comp";
    const withClaim = await render({
      templateId: "ticket.issued",
      props: { ...base, accountCompletionUrl: claimUrl },
    });
    expect(withClaim.html).toContain("Save to an account");
    // `&` is entity-encoded in HTML output, so assert on the unambiguous
    // path + query parts rather than the raw URL string.
    expect(withClaim.html).toContain("/auth/complete?email=guest%40example.com");
    expect(withClaim.html).toContain("src=volunteer-comp");

    const es = await render({
      templateId: "ticket.issued",
      props: { ...base, accountCompletionUrl: claimUrl },
      locale: "es",
    });
    expect(es.html).toContain("Guardar en una cuenta");
    expect(es.html).toContain("/auth/complete?email=guest%40example.com");
  });

  it("renders a seat line for seated tickets and none for GA tickets", async () => {
    const props = sampleInputFor("ticket.issued");
    props.tickets = [
      {
        code: "TH-SEATED",
        qrUrl: "https://ithasfire.com/tickets/qr/TH-SEATED",
        seatLabel: "Front Row · A12",
      },
      {
        code: "TH-GA",
        qrUrl: "https://ithasfire.com/tickets/qr/TH-GA",
      },
    ];

    const { html, text } = await render({ templateId: "ticket.issued", props });

    expect(html).toContain("Front Row · A12");
    expect(text).toContain("Front Row · A12");
    // The "Seat" heading renders once — only for the seated ticket; the GA
    // ticket card must not gain an empty seat line.
    expect(html.match(/>Seat</g)).toHaveLength(1);

    const es = await render({
      templateId: "ticket.issued",
      props,
      locale: "es",
    });
    expect(es.html).toContain("Asiento");
    expect(es.html).toContain("Front Row · A12");
  });

  it("renders no seat heading when no ticket has a seat label", async () => {
    const props = sampleInputFor("ticket.issued");
    props.tickets = [
      {
        code: "TH-GA-1",
        qrUrl: "https://ithasfire.com/tickets/qr/TH-GA-1",
      },
      {
        code: "TH-GA-2",
        qrUrl: "https://ithasfire.com/tickets/qr/TH-GA-2",
      },
    ];

    const { html } = await render({ templateId: "ticket.issued", props });

    expect(html).not.toMatch(/>Seat</);
  });

  it("throws for unknown template", async () => {
    const templateId = "unknown" as TemplateId;
    const props = {} as TemplateProps<typeof templateId>;
    await expect(render({ templateId, props })).rejects.toMatchObject({
      code: "template_not_found",
    });
  });

  it("validates props", async () => {
    const props = sampleInputFor("ticket.issued");
    const invalidProps = {
      ...props,
      eventTitle: undefined as unknown as string,
    };

    await expect(
      render({ templateId: "ticket.issued", props: invalidProps }),
    ).rejects.toMatchObject({
      code: "render_failed",
    });
  });

  it("returns fresh copies from sampleInputFor", () => {
    const first = sampleInputFor("ticket.issued");
    (first as { eventTitle: string }).eventTitle = "Mutated";
    const second = sampleInputFor("ticket.issued");
    expect(second.eventTitle).toBe("Indie Fest 2025");
  });
});

describe("footer defaults injection", () => {
  it("renders the injected mailing address and contact into the footer", async () => {
    const props = sampleInputFor("ticket.issued");
    const { html } = await render({
      templateId: "ticket.issued",
      props,
      footer: {
        physicalAddress: "500 Congress Ave, Austin, TX 78701",
        contactEmail: "support@acme.test",
        brandName: "Acme Tickets",
      },
    });

    expect(html).toContain("500 Congress Ave, Austin, TX 78701");
    expect(html).toContain("mailto:support@acme.test");
    expect(html).toContain("Acme Tickets");
  });

  it("omits the address line when no footer default is provided", async () => {
    const props = sampleInputFor("ticket.issued");
    const { html } = await render({ templateId: "ticket.issued", props });

    // The old hardcoded placeholder address must never appear.
    expect(html).not.toContain("Austin TX");
  });
});

describe("image moderation templates", () => {
  const EVENT_URL = "https://ithasfire.com/events/night-market-sessions";

  it("renders the held notice from its sample", async () => {
    const props = sampleInputFor("image.moderation.held");
    const { subject, html, text } = await render({
      templateId: "image.moderation.held",
      props,
    });

    expect(subject).toBe("Your image is being reviewed");
    expect(html).toContain("<html");
    expect(html).toContain("being reviewed");
    // Sample carries a helpUrl → the footer link renders.
    expect(html).toContain("Help Center");
    expect(html).toContain("https://ithasfire.com/help");
    // Sample names + links the event, so the uploader knows WHICH image.
    expect(html).toContain("Night Market Sessions");
    expect(html).toContain(EVENT_URL);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("renders the approved notice from its sample", async () => {
    const props = sampleInputFor("image.moderation.approved");
    const { subject, html } = await render({
      templateId: "image.moderation.approved",
      props,
    });

    expect(subject).toBe("Your image is now live");
    expect(html).toContain("approved and is now visible");
    expect(html).toContain("Night Market Sessions");
    expect(html).toContain(EVENT_URL);
    // No helpUrl in the sample → generic footer, no Help Center link.
    expect(html).not.toContain("Help Center");
  });

  it("renders the rejected notice with the reviewer note", async () => {
    const props = sampleInputFor("image.moderation.rejected");
    const { subject, html } = await render({
      templateId: "image.moderation.rejected",
      props,
    });

    expect(subject).toBe("Your image wasn't approved");
    // Apostrophes are HTML-escaped in rendered output, so assert on
    // apostrophe-free fragments.
    expect(html).toContain("and won");
    expect(html).toContain("be shown");
    expect(html).toContain("Note from our moderators");
    expect(html).toContain("meet our content guidelines");
    expect(html).toContain("Night Market Sessions");
    expect(html).toContain(EVENT_URL);
  });

  it("names the event in the body copy of all three notices", async () => {
    for (const templateId of [
      "image.moderation.held",
      "image.moderation.approved",
      "image.moderation.rejected",
    ] as const) {
      const { html } = await render({
        templateId,
        props: {
          eventTitle: "Night Market Sessions",
          eventUrl: EVENT_URL,
        },
      });
      // The event name IS the link, inline in the sentence — no duplicate
      // "Event: …" line to repeat it.
      expect(html).toContain(
        `The image you uploaded for <a href="${EVENT_URL}"`,
      );
      expect(html).toContain(">Night Market Sessions</a>");
    }
  });

  it("falls back to the generic copy when the event is unknown", async () => {
    for (const templateId of [
      "image.moderation.held",
      "image.moderation.approved",
      "image.moderation.rejected",
    ] as const) {
      const { html } = await render({ templateId, props: {} });
      expect(html).toContain("The image you uploaded");
      expect(html).not.toContain("The image you uploaded for");
      expect(html).not.toContain("Night Market Sessions");
      expect(html).not.toContain("/events/");
    }
  });

  it("names the event without a link when only the title is known", async () => {
    const { html } = await render({
      templateId: "image.moderation.rejected",
      props: { eventTitle: "Night Market Sessions" },
    });

    // Named in the sentence, but as plain text — nothing to link to.
    expect(html).toContain("The image you uploaded for ");
    expect(html).toContain("Night Market Sessions");
    expect(html).not.toContain("/events/");
  });
});

describe("booking templates", () => {
  it("renders the venue new-request notification from its sample", async () => {
    const props = sampleInputFor("booking.request_received");
    const { subject, html, text } = await render({
      templateId: "booking.request_received",
      props,
    });

    expect(subject).toBe("New booking request for The Corner Stage");
    expect(html).toContain("The Midnight Ramblers");
    expect(html).toContain("Open booking inbox");
    // Sample is an EMBED submission → website source line + mailto contact.
    expect(html).toContain("booking button on your website");
    expect(html).toContain("mailto:sam@midnightramblers.band");
    // Preferred dates render human-readable (ISO date-only, formatted UTC).
    expect(html).toContain("August 14, 2026");
    expect(html).toContain("August 28, 2026");
    // Pitch text makes it into both bodies.
    expect(html).toContain("four-piece Americana band");
    expect(text).toContain("four-piece Americana band");
  });

  it("renders the PLATFORM source line and omits absent contact fields", async () => {
    const props = sampleInputFor("booking.request_received");
    delete props.contactName;
    delete props.contactEmail;
    delete props.preferredDates;
    props.source = "PLATFORM";

    const { html } = await render({
      templateId: "booking.request_received",
      props,
    });

    expect(html).toContain("your page on Ithas Fire");
    expect(html).not.toContain("booking button on your website");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("PREFERRED DATES");
  });

  it("escapes untrusted pitch text — no HTML injection", async () => {
    const props = sampleInputFor("booking.request_received");
    props.message = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    props.actName = "<b>Bold Act</b>";

    const { html } = await render({
      templateId: "booking.request_received",
      props,
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Bold Act</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Bold Act&lt;/b&gt;");
  });

  it("renders the invite-to-claim email with claim link and factual expiry", async () => {
    const props = sampleInputFor("booking.invite_to_claim");
    const { subject, html, text } = await render({
      templateId: "booking.invite_to_claim",
      props,
    });

    expect(subject).toBe(
      "The Corner Stage wants to book you — finish setting up",
    );
    expect(html).toContain("wants to book you");
    expect(html).toContain("Claim your booking request");
    expect(html).toContain(
      "/booking-requests/claim/tok_abc123def456",
    );
    // Expiry is stated factually as the exact instant, pinned to UTC —
    // never the render server's local timezone (which would overstate the
    // deadline). Assert the EXACT formatted string so a timezone regression
    // fails in any CI timezone. Normalize two rendering artifacts first:
    // react-email's `<!-- -->` separators between dynamic text nodes, and
    // the U+202F (narrow no-break space) some ICU builds emit before AM/PM.
    const expected =
      "This link expires on August 12, 2026 at 12:00 AM UTC and can only be used once.";
    expect(
      html.replace(/<!-- -->/g, "").replace(/\u202f/g, " "),
    ).toContain(expected);
    expect(text.replace(/\u202f/g, " ")).toContain(expected);
  });

  it("invite-to-claim renders without an act name", async () => {
    const props = sampleInputFor("booking.invite_to_claim");
    props.actName = null;

    const { html } = await render({
      templateId: "booking.invite_to_claim",
      props,
    });

    expect(html).toContain("wants to book you");
    expect(html).not.toContain("The Midnight Ramblers");
  });
});

describe("volunteer signup approved template", () => {
  it("renders the renderer-provided CTA label when destinationUrl is set", async () => {
    // Sample carries a destinationUrl (event page for event-path signups;
    // ask-path signups pass their public /v/<askId> page instead) plus the
    // renderer-computed destinationLabel ("View event" on the event path).
    const props = sampleInputFor("volunteer.signup_approved");
    const { subject, html } = await render({
      templateId: "volunteer.signup_approved",
      props,
    });

    expect(subject).toBe(
      "You're approved to volunteer at Night Market Sessions",
    );
    expect(html).toContain("View event");
    expect(html).toContain(
      "/events/00000000-0000-4000-8000-000000000003",
    );
  });

  it("defaults the CTA label to View details when destinationLabel is absent", async () => {
    const props = sampleInputFor("volunteer.signup_approved");
    delete props.destinationLabel;

    const { html } = await render({
      templateId: "volunteer.signup_approved",
      props,
    });

    expect(html).toContain("View details");
    expect(html).not.toContain("View event");
  });

  it("renders without a CTA when destinationUrl is absent", async () => {
    const props = sampleInputFor("volunteer.signup_approved");
    delete props.destinationUrl;

    const { html } = await render({
      templateId: "volunteer.signup_approved",
      props,
    });

    expect(html).not.toContain("View details");
    expect(html).not.toContain("View event");
    expect(html).toContain("approved to volunteer");
  });
});

describe("rsvp.date_cancelled", () => {
  it("leads with the DATE and never claims the whole series is cancelled", async () => {
    const props = sampleInputFor("rsvp.date_cancelled");
    const { subject, html, text } = await render({
      templateId: "rsvp.date_cancelled",
      props,
    });

    expect(subject).toContain("Weekly Open Mic");
    expect(html).toContain("THIS DATE IS OFF");
    // The reassurance is the point: one night is off, the series is not.
    expect(html).toContain("the other dates are still on");
    expect(html).toContain("See Other Dates");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("renders without an event link when the event has no resolvable page", async () => {
    // A slugless event still has to get the cancellation — losing the link
    // beats losing the notice.
    const props = {
      ...sampleInputFor("rsvp.date_cancelled"),
      eventUrl: null,
      heroImageUrl: null,
    };
    const { html } = await render({ templateId: "rsvp.date_cancelled", props });

    expect(html).not.toContain("See Other Dates");
    expect(html).toContain("THIS DATE IS OFF");
  });

  it("whole listing cancelled: says so, and offers no other dates", async () => {
    // Cancel/archive of a community listing: one message per person stands
    // for every remaining night they held. There is no rest of the schedule.
    const props = {
      ...sampleInputFor("rsvp.date_cancelled"),
      eventUrl: null,
      listingCancelled: true,
    };
    const { subject, html } = await render({
      templateId: "rsvp.date_cancelled",
      props,
    });
    const shown = html.replace(/<!-- -->/g, "");

    expect(subject).toBe("Cancelled: Weekly Open Mic");
    expect(shown).toContain(
      "None of its remaining nights will happen. Your RSVP is cancelled.",
    );
    // Said once, under the title; the poster goes too.
    expect(shown).not.toContain("Weekly Open Mic has been cancelled");
    expect(html).not.toContain(String(props.heroImageUrl));
    expect(html).not.toContain("THIS DATE IS OFF");
    expect(html).not.toContain("the other dates are still on");
    expect(html).not.toContain("See Other Dates");
    expect(html).not.toContain("WHERE IT WOULD HAVE BEEN");
  });

  it("whole listing cancelled with an eventUrl: a View Event button, still no other dates", async () => {
    // The core drain sends a link only for a CANCELLED listing, whose page
    // says "Event cancelled".
    const props = {
      ...sampleInputFor("rsvp.date_cancelled"),
      eventUrl: "https://ithas.fire/e/weekly-open-mic",
      listingCancelled: true,
    };
    const { html } = await render({
      templateId: "rsvp.date_cancelled",
      props,
    });

    expect(html).toContain("View Event");
    expect(html).toContain('href="https://ithas.fire/e/weekly-open-mic"');
    expect(html).not.toContain("See Other Dates");
  });

  it("whole listing cancelled without an eventUrl: no button at all", async () => {
    const props = {
      ...sampleInputFor("rsvp.date_cancelled"),
      eventUrl: null,
      listingCancelled: true,
    };
    const { html } = await render({
      templateId: "rsvp.date_cancelled",
      props,
    });

    expect(html).not.toContain("View Event");
  });
});

describe("order.bank_payment_failed", () => {
  it("names the event and order code, says nothing was charged, and links back to buy again", async () => {
    const props = sampleInputFor("order.bank_payment_failed");
    const { subject, html, text } = await render({
      templateId: "order.bank_payment_failed",
      props,
    });
    const shown = html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

    expect(subject).toBe("Your bank payment didn't go through");
    expect(shown).toContain(
      "The bank payment for Summer Sounds 2025 didn't go through, so we cancelled order DB21B2C3. You weren't charged.",
    );
    expect(html).toContain(
      'href="https://ithasfire.com/events/summer-sounds-2025"',
    );
    expect(html).toContain("Buy Again");
    expect(text).toContain("DB21B2C3");
    // Owner rule: "place", never "venue", in copy.
    expect(html).not.toMatch(/venue/i);
  });

  it("still renders, without the button, when the event has no public page", async () => {
    const props = {
      ...sampleInputFor("order.bank_payment_failed"),
      eventUrl: null,
    };
    const { html } = await render({
      templateId: "order.bank_payment_failed",
      props,
    });

    expect(html).not.toContain("Buy Again");
    expect(html).toContain("DB21B2C3");
  });
});

describe("settlement.payout_sent", () => {
  it("shows the amount, the hop row, both sale lines and the payouts button when money moved", async () => {
    const props = sampleInputFor("settlement.payout_sent");
    const { subject, html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    expect(subject).toBe("You've been paid $10.64");
    expect(html).toContain("<title>You&#x27;ve been paid $10.64</title>");
    // The preheader counts SALES (consumed credits): the real 09-20 payout
    // was two sales of one event, so "2 events" would be a lie.
    expect(html).toContain(
      "Sent to your Stripe account Sun 20 Sep · 2 sales · nothing withheld",
    );
    expect(html).not.toContain("2 events");
    expect(html).toContain("$10.64");
    expect(html).toContain("Sent to your Stripe account");
    // The hop row: a green "we sent it" cell, then the bank cell quoting the delay.
    expect(html).toContain("We sent it");
    expect(html).toContain("about 2 days for this account");
    // Both sale lines, each with its own date in the event's own zone.
    expect(html).toContain("$9.67");
    expect(html).toContain("$0.97");
    // 2026-09-05T00:54Z is the evening of Friday 4 Sep in America/Chicago —
    // the line's OWN zone, not UTC's calendar day.
    expect(html).toContain("Fri 4 Sep · 1 ticket");
    expect(html).toContain("View payouts");
    expect(html).toContain("https://ithasfire.com/admin/ithas-fire/payments");
    expect(html).toContain("Open your Stripe dashboard");
    expect(html).toContain("Nothing was withheld from this payout.");
    expect(html).toContain("Nothing else is waiting to be paid.");
    expect(html).toContain("Still owed to Ithas Fire");
  });

  it("says nothing about duration when Stripe has not told us the bank delay", async () => {
    const props = {
      ...sampleInputFor("settlement.payout_sent"),
      bankDelayDays: null,
    };
    const { html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    expect(html).toContain("On Stripe&#x27;s schedule");
    expect(html).not.toMatch(/On Stripe&#x27;s schedule[^<]*\d/);
    expect(html).not.toContain("for this account");
  });

  it("never claims a reserved amount was paid, drops the hop row, and lists the reserve once", async () => {
    const props = {
      ...sampleInputFor("settlement.payout_sent"),
      kind: "reserved" as const,
      // The reserve IS the amount — the outcome row carries it, so the accent
      // deduction row must not repeat the same money.
      reserveHeldCents: 1064,
      balanceAfterCents: 0,
    };
    const { subject, html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    expect(subject).toBe("Your $10.64 payout is being held in reserve");
    expect(html).not.toContain("paid");
    expect(html).not.toContain("Sent to your Stripe account");
    expect(html).not.toContain("We sent it");
    expect(html).not.toContain("Your bank");
    expect(html).toContain("Held for now.");
    expect(html).toContain("this returns automatically");
    expect(html).toContain("Nothing else is outstanding.");
    // Once in the preheader, once as the outcome row — never a third time as
    // a deduction.
    expect(html.match(/Held in reserve/g)).toHaveLength(2);
    // The destination row is signed like payout/applied so the column sums.
    expect(html).toContain("−$10.64");
  });

  it("never says paid or sent when the payout only covered a balance", async () => {
    const props = {
      ...sampleInputFor("settlement.payout_sent"),
      kind: "applied_to_balance" as const,
      recoveredDebtCents: 1064,
      balanceAfterCents: 0,
    };
    const { subject, html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    expect(subject).toBe(
      "Your $10.64 payout covered your outstanding balance",
    );
    expect(html).not.toContain("paid");
    expect(html).not.toContain("Sent to your Stripe account");
    expect(html).not.toContain("Your bank");
    expect(html).toContain("Covered your outstanding balance");
    expect(html).toContain("Nothing else is outstanding.");
    // The recovered debt is the outcome row, not also a deduction.
    expect(html).not.toContain("Applied to an earlier refund");
    expect(html).toContain("Future payouts go to your Stripe account as usual.");
  });

  it("renders no payouts button for a payee without a payouts page", async () => {
    const props = {
      ...sampleInputFor("settlement.payout_sent"),
      payoutsUrl: null,
      orgName: null,
    };
    const { html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    expect(html).not.toContain("View payouts");
    expect(html).toContain("Open your Stripe dashboard");
    expect(html).toContain("Still owed to you");
    expect(html).toContain("You get a note each time a payout is sent.");
  });

  it("omits the Still owed row when the sender cannot state a balance", async () => {
    const props = {
      ...sampleInputFor("settlement.payout_sent"),
      balanceAfterCents: null,
    };
    const { html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    expect(html).toContain("Sent to your Stripe account");
    expect(html).toContain("Nothing was withheld from this payout.");
    expect(html).not.toContain("Still owed");
    expect(html).not.toContain("is still coming");
  });

  it("copes with no lines, a non-USD currency, a bare line, and a next payable date", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const empty = await render({
      templateId: "settlement.payout_sent",
      props: { ...base, lines: [], currency: "eur", amountCents: 1234 },
    });
    expect(empty.subject).toBe("You've been paid €12.34");
    expect(empty.html).toContain("€12.34");
    expect(empty.html).toContain("Where it came from");
    expect(empty.html).not.toContain("Fri 4 Sep");

    const bare = await render({
      templateId: "settlement.payout_sent",
      props: {
        ...base,
        lines: [
          {
            eventTitle: null,
            eventStartsAtIso: null,
            eventTimezone: null,
            ticketCount: null,
            amountCents: 1064,
            orderId: null,
          },
        ],
        balanceAfterCents: 4500,
        nextPayableAtIso: "2026-10-17T05:00:00.000Z",
      },
    });
    expect(bare.html).toContain("Sale");
    // A bare line has no sub-line at all — not an empty muted paragraph.
    expect(bare.html).not.toMatch(/Sale<\/p><p/);
    expect(bare.html).not.toContain("ticket");
    expect(bare.html).toContain(
      "$45.00 is still coming, and becomes payable on Sat 17 Oct.",
    );
  });

  it("steps the hero amount down for a five-figure sum so it fits a phone", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const small = await render({
      templateId: "settlement.payout_sent",
      props: base,
    });
    expect(small.html).toContain("font-size:52px");

    const big = await render({
      templateId: "settlement.payout_sent",
      props: { ...base, amountCents: 1234567 },
    });
    expect(big.html).toContain("$12,345.67");
    expect(big.html).toContain("font-size:40px");
    expect(big.html).not.toContain("font-size:52px");
  });

  it("shows a reserve release as money arriving and stops claiming nothing was withheld", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const { html } = await render({
      templateId: "settlement.payout_sent",
      // 1064 in sales + 2000 released = 3064 sent.
      props: { ...base, reserveReleasedCents: 2000, amountCents: 3064 },
    });

    expect(html).toContain("Reserve released back to you");
    expect(html).toContain("+$20.00");
    expect(html).not.toContain("Nothing was withheld");
    expect(html).toContain("Nothing else is waiting to be paid.");
  });

  it("folds credits past the 25-line cap into one other-sales row", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const lines = Array.from({ length: 25 }, (_, i) => ({
      eventTitle: `Show ${i + 1}`,
      eventStartsAtIso: null,
      eventTimezone: null,
      ticketCount: 1,
      amountCents: 100,
      orderId: null,
    }));
    const { html } = await render({
      templateId: "settlement.payout_sent",
      props: {
        ...base,
        lines,
        otherSalesCount: 5,
        otherSalesCents: 500,
        amountCents: 3000,
        settlementCount: 30,
      },
    });

    expect(html).toContain("Show 25");
    expect(html).not.toContain("Show 26");
    expect(html).toContain("5 other sales");
    expect(html).toContain("not listed individually");
    expect(html).toContain("+$5.00");
    expect(html).toContain("$30.00");
  });

  it("shows a refund residual as a signed deduction and stops claiming nothing was withheld", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const { html } = await render({
      templateId: "settlement.payout_sent",
      // 5000 in sales − 3000 refunded earlier = 2000 sent.
      props: {
        ...base,
        lines: [{ ...base.lines[0]!, amountCents: 5000 }],
        adjustmentsCents: -3000,
        amountCents: 2000,
      },
    });

    expect(html).toContain("Other adjustments");
    expect(html).toContain(
      "Earlier refunds and other changes since these sales",
    );
    expect(html).toContain("−$30.00");
    expect(html).not.toContain("Nothing was withheld");
  });

  it("adds no reconciliation rows when all four new terms are zero", async () => {
    const props = sampleInputFor("settlement.payout_sent");
    expect(props.reserveReleasedCents).toBe(0);
    expect(props.otherSalesCount).toBe(0);
    expect(props.otherSalesCents).toBe(0);
    expect(props.adjustmentsCents).toBe(0);

    const { html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    expect(html).not.toContain("other sale");
    expect(html).not.toContain("Reserve released");
    expect(html).not.toContain("Other adjustments");
    expect(html).toContain("Nothing was withheld from this payout.");
  });

  it("renders every statement term of a fully reconciling payout", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const props = {
      ...base,
      otherSalesCount: 5,
      otherSalesCents: 500,
      reserveReleasedCents: 2000,
      adjustmentsCents: -350,
      recoveredDebtCents: 150,
      connectAccountFeeCents: 200,
      reserveHeldCents: 300,
      amountCents: 2564,
    };
    const linesTotal = props.lines.reduce((sum, l) => sum + l.amountCents, 0);
    // The statement must add up — every term non-zero, nothing hidden.
    expect(
      linesTotal +
        props.otherSalesCents +
        props.reserveReleasedCents +
        props.adjustmentsCents -
        props.recoveredDebtCents -
        props.connectAccountFeeCents -
        props.reserveHeldCents,
    ).toBe(props.amountCents);

    const { html } = await render({
      templateId: "settlement.payout_sent",
      props,
    });

    // Rows in statement order: sales, other sales, release, the three holds,
    // adjustments, destination.
    const order = [
      "$9.67",
      "$0.97",
      "5 other sales",
      "Reserve released back to you",
      "Applied to an earlier refund",
      "Stripe account fee withheld",
      "Held in reserve",
      "Other adjustments",
      "Sent to your Stripe account",
    ];
    const positions = order.map((needle) => html.lastIndexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain("+$5.00");
    expect(html).toContain("+$20.00");
    expect(html).toContain("−$1.50");
    expect(html).toContain("−$2.00");
    expect(html).toContain("−$3.00");
    expect(html).toContain("−$3.50");
    expect(html).toContain("−$25.64");
    expect(html).not.toContain("Nothing was withheld");
  });

  it("lists unitemised sales as a plain row, not as other than nothing", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const { html } = await render({
      templateId: "settlement.payout_sent",
      props: { ...base, lines: [], otherSalesCount: 2, otherSalesCents: 1064 },
    });

    expect(html).not.toContain("other");
    expect(html).not.toContain("not listed individually");
    // Unsigned, like a sale line — not "+$10.64".
    expect(html).not.toContain("+$10.64");
    // Anchor label and value on the SAME row: the preheader already says
    // "2 sales" and the hero already emits ">$10.64</p>", so either alone
    // would pass with the row deleted.
    expect(html).toMatch(/2 sales<\/p>[\s\S]{0,400}?>\$10\.64<\/p>/);
    // Exactly hero + row; the outcome row is "−$10.64" and Still-owed is
    // "$0.00", so this drops to 1 if the row disappears.
    expect(html.match(/>\$10\.64<\/p>/g)).toHaveLength(2);
  });

  it("never says money is coming when the balance is owed by the payee", async () => {
    const base = sampleInputFor("settlement.payout_sent");
    const { html } = await render({
      templateId: "settlement.payout_sent",
      props: { ...base, balanceAfterCents: -5000 },
    });

    expect(html).not.toContain("is still coming");
    expect(html).not.toContain("Nothing else is waiting");
    expect(html).toContain("Still owed to Ithas Fire");
    expect(html).toContain("-$50.00");
  });
});

describe("listTemplates", () => {
  it("includes every smoke-tested template id", () => {
    // `templateIds` is a focused subset (the templates this spec smoke-
    // tests render output for), not the whole registry. Earlier this
    // test asserted equal length, which kept breaking every time a new
    // template landed without being added to this list. We only care
    // that the smoke-tested ids exist in the registry.
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(templateIds.length);
    templateIds.forEach((id) => {
      expect(templates.find((template) => template.id === id)).toBeTruthy();
    });
  });
});

// The Eta text templates use `{{= }}` tags. With Eta's default `<% %>` tags
// they were never interpolated, so the plain-text part of these emails shipped
// the raw template (`{{= it.resetUrl }}`) from April to September 2026.
describe("text templates interpolate", () => {
  (
    ["auth.verification_code", "auth.2fa_otp", "auth.reset_password_link"] as const
  ).forEach((templateId) => {
    it(`${templateId} text part has no raw template tags`, async () => {
      const { text } = await render({ templateId, props: sampleInputFor(templateId) });
      expect(text).not.toContain("{{");
      expect(text).not.toContain("it.");
    });
  });

  it.each([
    [undefined, "to sign in", "to sign in."],
    ["sign-in", "to sign in", "to sign in."],
    ["email-verification", "to verify your email", "to verify your email."],
    ["forget-password", "to reset your password", "to reset your password."],
    ["change-email", "to confirm your new email address", "to confirm your new email address."],
  ] as const)(
    "the verification code says what it is for (purpose %s)",
    async (purpose, textPhrase, htmlPhrase) => {
      const props = { ...sampleInputFor("auth.verification_code"), purpose };
      const { text, html } = await render({ templateId: "auth.verification_code", props });
      expect(text).toContain(`Use code 482931 ${textPhrase}.`);
      expect(html).toContain(`Enter this code in Ithas Fire ${htmlPhrase}`);
      if (purpose !== undefined && purpose !== "sign-in") {
        expect(text).not.toContain("to sign in");
        expect(html).not.toContain("to sign in");
      }
    },
  );

  // B2: the sign-up "verify your email" code reaches whoever owns the inbox,
  // even when someone else registered the address.
  it("the email-verification code tells a stranger not to share it", async () => {
    const props = {
      ...sampleInputFor("auth.verification_code"),
      purpose: "email-verification" as const,
    };
    const { text, html } = await render({ templateId: "auth.verification_code", props });
    expect(text).toContain(
      "If you didn’t sign up for Ithas Fire, ignore this email and don’t share this code.",
    );
    expect(html).toContain(
      "If you didn't sign up for Ithas Fire, ignore this email and don't share this code.",
    );
    expect(text).not.toContain("If you didn’t request this");
    expect(html).not.toContain("safely ignore");
  });

  it.each(["forget-password", "change-email"] as const)(
    "the %s code keeps the plain ignore line",
    async (purpose) => {
      const props = { ...sampleInputFor("auth.verification_code"), purpose };
      const { text, html } = await render({ templateId: "auth.verification_code", props });
      expect(text).toContain("If you didn’t request this, ignore this message.");
      expect(html).toContain("If you didn't request this code, you can safely ignore this email.");
      expect(text).not.toContain("share this code");
    },
  );

  it("the reset link reaches the text part", async () => {
    const props = sampleInputFor("auth.reset_password_link");
    const { text } = await render({ templateId: "auth.reset_password_link", props });
    expect(text).toContain((props as { resetUrl: string }).resetUrl);
  });
});
