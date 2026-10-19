import { describe, expect, it } from "vitest";

import {
  buildOpenCallGuestDuplicateEmail,
  buildOpenCallNotThisTimeEmail,
  buildOpenCallPickedEmail,
  buildOpenCallReceivedEmail,
  clipOpenCallMessagePreview,
  OPEN_CALL_EMAIL_TEMPLATE_KEY,
  openCallEmailText,
  type OpenCallEmailContent,
} from "../open-call-renderers";
import { renderNotification } from "../renderers";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const SUB = "a1000000-0000-4000-8000-000000000001";
const FORM = "a2000000-0000-4000-8000-000000000002";
const MSG = "a3000000-0000-4000-8000-000000000003";
const HUB = "https://ithasfire.com/my-applications";

/** Neither screens nor emails ever say these (Q37/Q38). */
const BANNED = /\b(pass(ed)?|declin\w*|reject\w*|bill|slot)\b/i;
const GENDERED = /\b(he|she|him|her|his|hers)\b/i;

const pickedPerson = {
  submissionId: SUB,
  formId: FORM,
  callTitle: "Friday Night Sessions",
  actName: null,
  firstPick: true,
  dates: [
    { startsAtIso: "2026-11-14T02:00:00.000Z", timezone: "America/Chicago" },
    { startsAtIso: "2026-11-21T02:00:00.000Z", timezone: "America/Chicago" },
  ],
  payKind: "DOOR_SPLIT",
  payDetails: "70/30 after costs",
  actionUrl: HUB,
  dropOutUrl: "https://ithasfire.com/my-lineups",
  makePageUrl: null,
};

const allText = (c: OpenCallEmailContent) =>
  [c.subject, c.heading, ...c.rows.map((r) => `${r.label} ${r.value}`), ...c.paragraphs, c.footer]
    .concat(c.quote ? [c.quote.label] : [])
    .concat(c.action ? [c.action.label] : [])
    .concat(c.links.map((l) => l.label))
    .join(" ");

describe("open-call.picked", () => {
  it("person, en: lineup title, dates in the event's zone, the pay as posted, a drop-out link", () => {
    const out = renderNotification("open-call.picked", pickedPerson, { now: NOW, locale: "en" });
    expect(out.category).toBe("transactional");
    expect(out.inApp!.title).toBe("You're on the lineup for Friday Night Sessions");
    expect(out.inApp!.body).toBe(
      "Fri, Nov 13, 8:00 PM; Fri, Nov 20, 8:00 PM. Pay as posted: A split of the door: 70/30 after costs.",
    );
    expect(out.inApp!.action).toEqual({ label: "Open your application", route: "/my-applications" });
    expect(out.email!.subject).toBe("You're on the lineup for Friday Night Sessions");
    expect(out.email!.template).toMatchObject({ key: OPEN_CALL_EMAIL_TEMPLATE_KEY });
    const content = out.email!.template!.variables as OpenCallEmailContent;
    expect(content.locale).toBe("en");
    expect(content.rows).toEqual([
      { label: "Event", value: "Friday Night Sessions" },
      {
        label: "When",
        value:
          "Friday, November 13, 2026 at 8:00 PM (Chicago time); Friday, November 20, 2026 at 8:00 PM (Chicago time)",
      },
      { label: "Pay as posted", value: "A split of the door: 70/30 after costs" },
    ]);
    expect(content.links).toEqual([{ label: "Drop out", url: "https://ithasfire.com/my-lineups" }]);
    expect(content.paragraphs.join(" ")).toContain("doesn't sign anything or move any money");
    expect(out.email!.text).toContain("Drop out: https://ithasfire.com/my-lineups");
    expect(allText(content)).not.toMatch(BANNED);
    expect(allText(content)).not.toMatch(GENDERED);
  });

  it("person, es: the same notice in Spanish (in-app re-render)", () => {
    const out = renderNotification("open-call.picked", pickedPerson, { now: NOW, locale: "es" });
    expect(out.inApp!.title).toBe("Estás en el lineup de Friday Night Sessions");
    expect(out.inApp!.body).toContain("Pago según la convocatoria: Un porcentaje de la entrada: 70/30 after costs.");
    expect(out.inApp!.action!.label).toBe("Abrir tu postulación");
    // The stored email is English (notify renders "en"), whatever the reader.
    expect(out.email!.subject).toBe("You're on the lineup for Friday Night Sessions");
  });

  it("org member: names the org; a retry with more dates says so", () => {
    const org = { ...pickedPerson, actName: "The Sundowners", dropOutUrl: HUB };
    expect(renderNotification("open-call.picked", org, { now: NOW, locale: "en" }).inApp!.title).toBe(
      "The Sundowners is on the lineup for Friday Night Sessions",
    );
    expect(
      renderNotification("open-call.picked", { ...org, firstPick: false }, { now: NOW, locale: "es" }).inApp!
        .title,
    ).toBe("The Sundowners tiene más fechas en Friday Night Sessions");
    const email = buildOpenCallPickedEmail(org, "en");
    expect(email.paragraphs[0]).toBe(
      "The organizers picked The Sundowners from its application to their open call.",
    );
  });

  it("signed in: the Drop out link opens a page, so the copy does not promise one tap", () => {
    const en = buildOpenCallPickedEmail(pickedPerson, "en");
    expect(en.paragraphs).toContain(
      "Can't make it after all? Use the Drop out link below, and the organizers will be told.",
    );
    expect(en.paragraphs.join(" ")).not.toContain("one tap");
  });

  it("guest email: one-tap Drop out on the status link, and the make-a-page invite (Q34)", () => {
    const statusUrl = "https://ithasfire.com/call/abc123/application/AAAA";
    const guest = {
      ...pickedPerson,
      actionUrl: statusUrl,
      dropOutUrl: statusUrl,
      makePageUrl: "https://ithasfire.com/sign-up?email=moths%40example.com&src=open-call",
    };
    for (const locale of ["en", "es"] as const) {
      const email = buildOpenCallPickedEmail(guest, locale, "guest");
      expect(email.locale).toBe(locale);
      expect(email.links.map((l) => l.url)).toEqual([statusUrl, guest.makePageUrl]);
    }
    const en = buildOpenCallPickedEmail(guest, "en", "guest");
    expect(en.paragraphs).toContain(
      "Can't make it after all? Drop out with one tap, and the organizers will be told.",
    );
    expect(en.paragraphs.at(-1)).toContain("Make a page with this email address");
    const es = buildOpenCallPickedEmail(guest, "es", "guest");
    expect(es.subject).toBe("Estás en el lineup de Friday Night Sessions");
    expect(es.links[0]).toEqual({ label: "Retirarme", url: statusUrl });
    expect(es.paragraphs).toContain(
      "Que te elijan no implica firmar nada ni mover dinero. El pago de arriba es el que publicó la convocatoria; los detalles los acuerdas con quienes organizan.",
    );
    expect(es.paragraphs.at(-1)).toContain("Crea una página con este correo");
    expect(es.footer).toBe("Recibes este correo porque te postulaste a una convocatoria en Ithas Fire.");
  });

  it("refuses a non-http(s) link in the payload", () => {
    expect(() =>
      renderNotification(
        "open-call.picked",
        { ...pickedPerson, dropOutUrl: "javascript:alert(1)" },
        { now: NOW, locale: "en" },
      ),
    ).toThrow();
  });
});

describe("open-call.not-this-time", () => {
  const base = { submissionId: SUB, formId: FORM, callTitle: "Friday Night Sessions", actName: null, note: null, actionUrl: HUB };

  it("says 'Not this time', never reject/decline; the standard reply has no note", () => {
    const out = renderNotification("open-call.not-this-time", base, { now: NOW, locale: "en" });
    expect(out.inApp!.title).toBe("Not this time: Friday Night Sessions");
    expect(out.inApp!.body).toBe("Thanks for applying. The organizers didn't pick you this time.");
    const content = out.email!.template!.variables as OpenCallEmailContent;
    expect(content.quote).toBeNull();
    expect(allText(content)).not.toMatch(BANNED);
  });

  it("with the organizer's note, verbatim, in both languages", () => {
    const withNote = { ...base, note: "Loved it. Next season for sure." };
    const en = renderNotification("open-call.not-this-time", withNote, { now: NOW, locale: "en" });
    expect(en.inApp!.body).toBe(
      "Thanks for applying. The organizers didn't pick you this time. Their note: Loved it. Next season for sure.",
    );
    const es = renderNotification("open-call.not-this-time", withNote, { now: NOW, locale: "es" });
    expect(es.inApp!.title).toBe("Esta vez no: Friday Night Sessions");
    expect(es.inApp!.body).toBe(
      "Gracias por postularte. Esta vez quienes organizan no te eligieron. Su nota: Loved it. Next season for sure.",
    );
    expect(buildOpenCallNotThisTimeEmail(withNote, "es").quote).toEqual({
      label: "Su nota",
      text: "Loved it. Next season for sure.",
    });
  });

  it("org member: names the org", () => {
    const out = renderNotification(
      "open-call.not-this-time",
      { ...base, actName: "The Sundowners" },
      { now: NOW, locale: "en" },
    );
    expect(out.inApp!.body).toBe(
      "Thanks for applying as The Sundowners. The organizers didn't pick the act this time.",
    );
  });
});

describe("open-call.pulled", () => {
  it("says the call was pulled, not 'not this time'", () => {
    const payload = { submissionId: SUB, formId: FORM, callTitle: "Friday Night Sessions", actionUrl: HUB };
    const en = renderNotification("open-call.pulled", payload, { now: NOW, locale: "en" });
    expect(en.inApp!.title).toBe("Call pulled: Friday Night Sessions");
    expect(en.inApp!.body).toContain("It wasn't a decision about you.");
    expect(en.inApp!.body).not.toMatch(/not this time/i);
    const es = renderNotification("open-call.pulled", payload, { now: NOW, locale: "es" });
    expect(es.inApp!.title).toBe("Convocatoria retirada: Friday Night Sessions");
  });
});

describe("open-call.message-received", () => {
  const base = {
    submissionId: SUB,
    formId: FORM,
    messageId: MSG,
    callTitle: "Friday Night Sessions",
    recipientSide: "ORGANIZER" as const,
    authorName: "The Moths",
    preview: "Can we bring our own amp?",
    actionUrl: "https://ithasfire.com/admin/org-a1/events/e1/open-call?application=x",
  };

  it("to the organizers: names the applicant; the body is the message, verbatim in every locale", () => {
    const en = renderNotification("open-call.message-received", base, { now: NOW, locale: "en" });
    expect(en.inApp!.title).toBe("The Moths wrote about their application to Friday Night Sessions");
    expect(en.inApp!.body).toBe("Can we bring our own amp?");
    const es = renderNotification("open-call.message-received", base, { now: NOW, locale: "es" });
    expect(es.inApp!.title).toBe("The Moths escribió sobre su postulación a Friday Night Sessions");
    expect(es.inApp!.body).toBe("Can we bring our own amp?");
    const content = en.email!.template!.variables as OpenCallEmailContent;
    expect(content.quote).toEqual({ label: "Message", text: "Can we bring our own amp?" });
    expect(content.footer).toContain("you can edit this event");
  });

  it("to the applicant: 'the organizers wrote to you'; an unknown author name is not invented", () => {
    const toApplicant = { ...base, recipientSide: "APPLICANT" as const, authorName: null, actionUrl: HUB };
    expect(
      renderNotification("open-call.message-received", toApplicant, { now: NOW, locale: "en" }).inApp!.title,
    ).toBe("The organizers of Friday Night Sessions wrote to you");
    expect(
      renderNotification("open-call.message-received", { ...base, authorName: null }, { now: NOW, locale: "es" })
        .inApp!.title,
    ).toBe("Nuevo mensaje sobre una postulación a Friday Night Sessions");
  });
});

describe("message preview clip", () => {
  it("a long emoji body clips to the schema's UTF-16 bound and still renders", () => {
    const preview = clipOpenCallMessagePreview(`x${"🎸".repeat(300)}`);
    expect(preview.length).toBeLessThanOrEqual(240);
    const out = renderNotification(
      "open-call.message-received",
      {
        submissionId: SUB,
        formId: FORM,
        messageId: MSG,
        callTitle: "Friday Night Sessions",
        recipientSide: "APPLICANT",
        authorName: null,
        preview,
        actionUrl: HUB,
      },
      { now: NOW, locale: "en" },
    );
    expect(out.inApp!.body).toBe(preview);
  });
});

describe("open-call.dropped-out", () => {
  it("names the act and the nights it came off", () => {
    const payload = {
      submissionId: SUB,
      formId: FORM,
      callTitle: "Friday Night Sessions",
      actName: "The Moths",
      dates: [{ startsAtIso: "2026-11-14T02:00:00.000Z", timezone: "America/Chicago" }],
      actionUrl: "https://ithasfire.com/admin/org-a1/events/e1/open-call?application=x",
    };
    const en = renderNotification("open-call.dropped-out", payload, { now: NOW, locale: "en" });
    expect(en.inApp!.title).toBe("The Moths dropped out of Friday Night Sessions");
    expect(en.inApp!.body).toBe(
      "They took themselves off the lineup (Fri, Nov 13, 8:00 PM). Their application now shows as dropped out.",
    );
    const es = renderNotification("open-call.dropped-out", { ...payload, actName: null, dates: [] }, {
      now: NOW,
      locale: "es",
    });
    expect(es.inApp!.title).toBe("Alguien salió del lineup de Friday Night Sessions");
    expect(es.inApp!.body).toBe("Se retiró. Su postulación ahora figura como retirada.");
  });
});

describe("open-call.application-received and the guest duplicate", () => {
  it("received, signed in (stored): links the hub, never a status page", () => {
    const payload = {
      submissionId: SUB,
      formId: FORM,
      callTitle: "Friday Night Sessions",
      actionUrl: HUB,
    };
    const en = renderNotification("open-call.application-received", payload, { now: NOW, locale: "en" });
    expect(en.inApp!.title).toBe("Application sent: Friday Night Sessions");
    expect(en.inApp!.action!.route).toBe(new URL(HUB).pathname);
    const content = en.email!.template!.variables as OpenCallEmailContent;
    expect(content.action).toEqual({ label: "Open your application", url: HUB });
    expect(content.paragraphs.join(" ")).toContain("in your applications");
    expect(content.paragraphs.join(" ")).not.toContain("Keep this email.");
  });

  it("received, guest email: links the status page and asks them to keep the email", () => {
    const statusUrl = "https://ithasfire.com/call/abc123/application/tok";
    const payload = { submissionId: SUB, formId: FORM, callTitle: "Friday Night Sessions", actionUrl: statusUrl };
    const content = buildOpenCallReceivedEmail(payload, "en", "guest");
    expect(content.action).toEqual({ label: "Open your application", url: statusUrl });
    expect(content.paragraphs.join(" ")).toContain("Keep this email.");
    expect(openCallEmailText(content)).toContain(`Open your application: ${statusUrl}`);
  });

  it("guest duplicate: points at the call and the first email, in the given locale", () => {
    const es = buildOpenCallGuestDuplicateEmail(
      { callTitle: "Friday Night Sessions", callUrl: "https://ithasfire.com/call/abc123" },
      "es",
    );
    expect(es.subject).toBe("Ya te postulaste: Friday Night Sessions");
    expect(es.action).toEqual({ label: "Abrir la convocatoria", url: "https://ithasfire.com/call/abc123" });
  });
});
