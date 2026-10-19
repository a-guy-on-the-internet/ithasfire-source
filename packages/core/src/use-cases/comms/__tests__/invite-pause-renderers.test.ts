import { describe, expect, it } from "vitest";

import { LOCALIZED_VARIANTS } from "../copy";
import {
  INVITE_PAUSE_DECIDED_COPY,
  INVITE_PAUSE_OPENED_COPY,
} from "../copy/invite-pauses";
import { NOTIFICATION_LOCALES } from "../locale";
import { getNotificationRenderer, renderNotification } from "../renderers";
import {
  invitePauseDecidedRenderer,
  invitePauseOpenedRenderer,
} from "../invite-pause-renderers";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const opened = (patch: Record<string, unknown> = {}) => ({
  pauseId: "a7000000-0000-4000-8000-000000000001",
  ownerKind: "ORG",
  organiserName: "Acme Presents",
  reason: "COMPLAINT_COUNT",
  complaintCount: 3,
  recipientCount: 120,
  windowDays: 30,
  actionRoute: "/admin/acme/events/e1/edit?section=settings",
  linksToEvent: true,
  ...patch,
});

const decided = (patch: Record<string, unknown> = {}) => ({
  pauseId: "a7000000-0000-4000-8000-000000000001",
  ownerKind: "ORG",
  organiserName: "Acme Presents",
  decision: "LIFTED",
  note: null,
  actionRoute: "/admin/acme/events/e1/edit?section=settings",
  linksToEvent: true,
  ...patch,
});

function render(variant: string, payload: unknown, locale: "en" | "es") {
  return renderNotification(variant, payload, { now: NOW, locale }).inApp!;
}

describe("invite-pause renderers", () => {
  it("are registered and localized", () => {
    expect(getNotificationRenderer("invite-pause.opened")).toBe(invitePauseOpenedRenderer);
    expect(getNotificationRenderer("invite-pause.decided")).toBe(invitePauseDecidedRenderer);
    expect(LOCALIZED_VARIANTS.has("invite-pause.opened")).toBe(true);
    expect(LOCALIZED_VARIANTS.has("invite-pause.decided")).toBe(true);
  });

  it("have copy for every notification locale", () => {
    for (const locale of NOTIFICATION_LOCALES) {
      expect(INVITE_PAUSE_OPENED_COPY[locale]).toBeDefined();
      expect(INVITE_PAUSE_DECIDED_COPY[locale]).toBeDefined();
    }
  });

  describe("invite-pause.opened", () => {
    it("count, en and es", () => {
      const en = render("invite-pause.opened", opened(), "en");
      expect(en.title).toBe("Invites from Acme Presents are paused");
      expect(en.body).toBe(
        "3 people marked your invite emails as spam in the last 30 days. Invite emails are on hold until a review lifts the pause. Your shared invite link still works.",
      );
      expect(en.kind).toBe("WARNING");
      expect(en.action).toEqual({
        label: "Ask for a review",
        route: "/admin/acme/events/e1/edit?section=settings",
      });

      const es = render("invite-pause.opened", opened(), "es");
      expect(es.title).toBe("Las invitaciones de Acme Presents están en pausa");
      expect(es.body).toBe(
        "3 personas marcaron tus correos de invitación como spam en los últimos 30 días. Los correos de invitación quedan en espera hasta que una revisión levante la pausa. Tu enlace de invitación compartido sigue funcionando.",
      );
      expect(es.action?.label).toBe("Pedir una revisión");
    });

    it("rate, en and es, singular and plural", () => {
      const one = opened({ reason: "COMPLAINT_RATE", complaintCount: 1, recipientCount: 40 });
      expect(render("invite-pause.opened", one, "en").body).toMatch(
        /^1 of the 40 people you invited in the last 30 days marked the email as spam\. /,
      );
      expect(render("invite-pause.opened", one, "es").body).toMatch(
        /^1 de las 40 personas que invitaste en los últimos 30 días marcó el correo como spam\. /,
      );
      const two = opened({ reason: "COMPLAINT_RATE", complaintCount: 2, recipientCount: 150 });
      expect(render("invite-pause.opened", two, "en").body).toMatch(
        /^2 of the 150 people you invited/,
      );
      expect(render("invite-pause.opened", two, "es").body).toMatch(
        /^2 de las 150 personas que invitaste en los últimos 30 días marcaron/,
      );
    });

    it.each([
      [1, 0],
      [1, 1],
    ])("rate with %i complaint(s) among %i invites falls back to the count sentence", (complaintCount, recipientCount) => {
      const p = opened({ reason: "COMPLAINT_RATE", complaintCount, recipientCount });
      expect(render("invite-pause.opened", p, "en").body).toMatch(
        /^1 person marked your invite email as spam in the last 30 days\. /,
      );
      expect(render("invite-pause.opened", p, "es").body).toMatch(
        /^1 persona marcó tu correo de invitación como spam/,
      );
    });

    it("2 of 2 also falls back to the count sentence", () => {
      const p = opened({ reason: "COMPLAINT_RATE", complaintCount: 2, recipientCount: 2 });
      expect(render("invite-pause.opened", p, "en").body).toMatch(
        /^2 people marked your invite emails as spam/,
      );
    });

    it("an events-list link gets the honest label (and so does a payload without the flag)", () => {
      for (const p of [
        opened({ actionRoute: "/admin/acme/events", linksToEvent: false }),
        (({ linksToEvent: _drop, ...rest }) => rest)(opened({ actionRoute: "/admin/acme/events" })),
      ]) {
        expect(render("invite-pause.opened", p, "en").action).toEqual({
          label: "Open your events",
          route: "/admin/acme/events",
        });
        expect(render("invite-pause.opened", p, "es").action?.label).toBe("Abrir tus eventos");
      }
    });

    it("a person (no organiser name) reads 'your invites'", () => {
      const p = opened({ ownerKind: "HUMAN", organiserName: null });
      expect(render("invite-pause.opened", p, "en").title).toBe("Your invites are paused");
      expect(render("invite-pause.opened", p, "es").title).toBe(
        "Tus invitaciones están en pausa",
      );
    });
  });

  describe("invite-pause.decided", () => {
    it("LIFTED, en and es", () => {
      const en = render("invite-pause.decided", decided(), "en");
      expect(en.title).toBe("Invites from Acme Presents are back on");
      expect(en.body).toBe(
        "Our team reviewed the pause and lifted it. You can send invite emails again.",
      );
      expect(en.kind).toBe("SUCCESS");
      expect(en.action).toEqual({
        label: "Send invites",
        route: "/admin/acme/events/e1/edit?section=settings",
      });

      const es = render("invite-pause.decided", decided(), "es");
      expect(es.title).toBe("Las invitaciones de Acme Presents vuelven a estar activas");
      expect(es.body).toBe(
        "Nuestro equipo revisó la pausa y la levantó. Ya puedes volver a enviar correos de invitación.",
      );
      expect(es.action?.label).toBe("Enviar invitaciones");
    });

    it("KEPT with a note, en and es: the note is verbatim", () => {
      const p = decided({ decision: "KEPT", note: "Two more reports came in." });
      const en = render("invite-pause.decided", p, "en");
      expect(en.title).toBe("Invites from Acme Presents stay paused");
      expect(en.body).toBe(
        "Our team reviewed the pause and kept it for now. Note from our team: Two more reports came in. You can ask for another review.",
      );
      expect(en.kind).toBe("WARNING");
      expect(en.action?.label).toBe("See what to do");

      const es = render("invite-pause.decided", p, "es");
      expect(es.title).toBe("Las invitaciones de Acme Presents siguen en pausa");
      expect(es.body).toBe(
        "Nuestro equipo revisó la pausa y la mantiene por ahora. Nota de nuestro equipo: Two more reports came in. Puedes pedir otra revisión.",
      );
      expect(es.action?.label).toBe("Ver qué hacer");
    });

    it("a note without a closing stop gets one; one with a stop (or a quoted stop) is left alone", () => {
      const body = (note: string, locale: "en" | "es") =>
        render("invite-pause.decided", decided({ decision: "KEPT", note }), locale).body;
      expect(body("Too many reports", "en")).toBe(
        "Our team reviewed the pause and kept it for now. Note from our team: Too many reports. You can ask for another review.",
      );
      expect(body("Demasiadas quejas", "es")).toBe(
        "Nuestro equipo revisó la pausa y la mantiene por ahora. Nota de nuestro equipo: Demasiadas quejas. Puedes pedir otra revisión.",
      );
      for (const note of ["Why?", "Stop!", "Clipped…", 'They said "no."']) {
        expect(body(note, "en")).toContain(`Note from our team: ${note} You can`);
      }
    });

    it("events-list fallback uses the honest label for both decisions", () => {
      for (const decision of ["LIFTED", "KEPT"]) {
        const p = decided({ decision, note: "n.", actionRoute: "/admin/acme/events", linksToEvent: false });
        expect(render("invite-pause.decided", p, "en").action?.label).toBe("Open your events");
        expect(render("invite-pause.decided", p, "es").action?.label).toBe("Abrir tus eventos");
      }
    });

    it("a person reads 'your invites'", () => {
      const p = decided({ ownerKind: "HUMAN", organiserName: null, decision: "KEPT", note: "x" });
      expect(render("invite-pause.decided", p, "en").title).toBe("Your invites stay paused");
      expect(render("invite-pause.decided", p, "es").title).toBe(
        "Tus invitaciones siguen en pausa",
      );
    });
  });

  it("reject an unknown field (stored payloads are strict)", () => {
    expect(() => render("invite-pause.decided", decided({ extra: 1 }), "en")).toThrow();
  });
});
