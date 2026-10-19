import { describe, expect, it } from "vitest";

import { renderNotification } from "../renderers";

// Pins the in-app copy of the volunteer signup notices, per locale. English is
// pinned EXACTLY (it is what `notify` stores, and what the email text reuses);
// Spanish is pinned so a copy edit is a visible diff. Email output must not
// change with the locale.

const NOW = new Date("2026-11-13T12:00:00Z");
const ASK = "11111111-0000-4000-8000-000000000001";
const EVT = "22222222-0000-4000-8000-000000000002";
const ROLE = "33333333-0000-4000-8000-000000000003";
const SIGNUP = "44444444-0000-4000-8000-000000000004";
const GROUP = "55555555-0000-4000-8000-000000000005";
const OCC = "66666666-0000-4000-8000-000000000006";

const render = (variant: string, payload: unknown, locale?: "en" | "es") => {
  const out = renderNotification(variant, payload, { now: NOW, locale });
  if (locale === "es") {
    // Only the in-app title, body and action label localize: every other
    // channel, the fingerprint, kind, tags and the route stay as in English.
    const en = renderNotification(variant, payload, { now: NOW, locale: "en" });
    expect(out.email).toEqual(en.email);
    expect(out.push).toEqual(en.push);
    expect(out.sms).toEqual(en.sms);
    expect(out.fingerprint).toEqual(en.fingerprint);
    expect(out.inApp?.kind).toEqual(en.inApp?.kind);
    expect(out.inApp?.tags).toEqual(en.inApp?.tags);
    expect(out.inApp?.action?.href).toEqual(en.inApp?.action?.href);
  }
  return out;
};

const plain = (s: string | null | undefined) =>
  (s ?? "").replace(/[  ]/gu, " ");

describe("volunteer.signup-received", () => {
  const base = {
    eventId: EVT,
    eventTitle: "Summer Fest",
    roleId: ROLE,
    roleName: "Security",
    signupId: SIGNUP,
  };

  it("en: pending", () => {
    const out = render("volunteer.signup-received", { ...base, status: "PENDING" });
    expect(out.inApp?.title).toBe("Thanks for signing up to volunteer at Summer Fest");
    expect(out.inApp?.body).toBe("Your signup for Security at Summer Fest is pending review.");
    expect(out.inApp?.action).toBeNull();
  });

  it("en: approved", () => {
    const out = render("volunteer.signup-received", { ...base, status: "APPROVED" });
    expect(out.inApp?.title).toBe("You're confirmed to volunteer at Summer Fest");
    expect(out.inApp?.body).toBe("You're confirmed to volunteer at Summer Fest as Security.");
  });

  it("es: pending and approved", () => {
    const p = render("volunteer.signup-received", { ...base, status: "PENDING" }, "es");
    expect(p.inApp?.title).toBe("Recibimos tu inscripción de voluntariado en Summer Fest");
    expect(p.inApp?.body).toBe("Tu inscripción como Security en Summer Fest está pendiente de revisión.");
    const a = render("volunteer.signup-received", { ...base, status: "APPROVED" }, "es");
    expect(a.inApp?.title).toBe("Tu inscripción de voluntariado en Summer Fest está confirmada");
    expect(a.inApp?.body).toBe("Tu inscripción como Security en Summer Fest está confirmada.");
  });

  it("email stays English in es", () => {
    const en = render("volunteer.signup-received", { ...base, status: "APPROVED" });
    const es = render("volunteer.signup-received", { ...base, status: "APPROVED" }, "es");
    expect(es.email).toEqual(en.email);
    expect(es.email?.subject).toBe("Thanks for signing up to volunteer at Summer Fest");
    expect(es.email?.text).toBe("You're confirmed to volunteer at Summer Fest as Security.");
  });
});

describe("volunteer.signup-approved", () => {
  const base = {
    eventId: EVT,
    eventTitle: "Summer Fest",
    roleId: ROLE,
    roleName: "Security",
    signupId: SIGNUP,
    destinationUrl: "https://ithas.fire/events/summer-fest",
  };

  it("en: event path", () => {
    const out = render("volunteer.signup-approved", base);
    expect(out.inApp?.title).toBe("You're approved to volunteer at Summer Fest");
    expect(out.inApp?.body).toBe("You're approved to volunteer at Summer Fest as Security.");
    expect(out.inApp?.action).toEqual({ label: "View event", href: base.destinationUrl });
  });

  it("en: ask path label", () => {
    const out = render("volunteer.signup-approved", { ...base, eventId: null, askId: ASK });
    expect(out.inApp?.action?.label).toBe("View details");
  });

  it("es: both labels, no link means no action", () => {
    const out = render("volunteer.signup-approved", base, "es");
    expect(out.inApp?.title).toBe("Tu inscripción de voluntariado en Summer Fest fue aprobada");
    expect(out.inApp?.body).toBe("Tu inscripción como Security en Summer Fest fue aprobada.");
    expect(out.inApp?.action).toEqual({ label: "Ver evento", href: base.destinationUrl });
    const ask = render("volunteer.signup-approved", { ...base, eventId: null, askId: ASK }, "es");
    expect(ask.inApp?.action?.label).toBe("Ver detalles");
    const none = render("volunteer.signup-approved", { ...base, destinationUrl: undefined }, "es");
    expect(none.inApp?.action).toBeNull();
  });

  it("email stays English in es", () => {
    const en = render("volunteer.signup-approved", base);
    const es = render("volunteer.signup-approved", base, "es");
    expect(es.email).toEqual(en.email);
    expect(es.email?.text).toContain("View event: https://ithas.fire/events/summer-fest");
  });
});

describe("volunteer.signup-rejected", () => {
  const base = {
    eventId: EVT,
    eventTitle: "Summer Fest",
    roleId: ROLE,
    roleName: "Security",
    signupId: SIGNUP,
    rejectionNote: "We are full.",
  };

  it("en", () => {
    const out = render("volunteer.signup-rejected", base);
    expect(out.inApp?.title).toBe("Update on your volunteer application for Summer Fest");
    expect(out.inApp?.body).toBe(
      "Thanks for your interest in volunteering for Summer Fest as Security. Unfortunately the organizer wasn't able to approve your signup this time.",
    );
    expect(out.inApp?.action).toBeNull();
  });

  it("es", () => {
    const out = render("volunteer.signup-rejected", base, "es");
    expect(out.inApp?.title).toBe("Novedades sobre tu inscripción en Summer Fest");
    expect(out.inApp?.body).toBe(
      "Gracias por tu interés en el voluntariado de Summer Fest como Security. Esta vez tu inscripción no fue aprobada.",
    );
  });

  it("email stays English in es (note included)", () => {
    const en = render("volunteer.signup-rejected", base);
    const es = render("volunteer.signup-rejected", base, "es");
    expect(es.email).toEqual(en.email);
    expect(es.email?.text).toContain("Note from the organizer: We are full.");
  });
});

describe("volunteer.spot-opened", () => {
  const base = {
    eventId: EVT,
    eventTitle: "Summer Fest",
    roleId: ROLE,
    roleName: "Security",
    shiftLabel: "Morning",
    pendingCount: 1,
    withdrawnSignupId: SIGNUP,
    signupsUrl: "https://ithas.fire/org/signups",
  };

  it("en: one pending, then several", () => {
    const one = render("volunteer.spot-opened", base);
    expect(one.inApp?.title).toBe("A volunteer spot opened at Summer Fest");
    expect(one.inApp?.body).toBe(
      "A volunteer spot opened on Summer Fest — Security/Morning. 1 pending application is waiting.",
    );
    expect(one.inApp?.action).toEqual({ label: "Review signups", href: base.signupsUrl });
    const many = render("volunteer.spot-opened", { ...base, shiftLabel: null, pendingCount: 3 });
    expect(many.inApp?.body).toBe(
      "A volunteer spot opened on Summer Fest — Security. 3 pending applications are waiting.",
    );
  });

  it("es: one pending, then several", () => {
    const one = render("volunteer.spot-opened", base, "es");
    expect(one.inApp?.title).toBe("Se liberó un cupo de voluntariado en Summer Fest");
    expect(one.inApp?.body).toBe(
      "Se liberó un cupo en Summer Fest — Security/Morning. Hay 1 inscripción pendiente.",
    );
    expect(one.inApp?.action).toEqual({ label: "Revisar inscripciones", href: base.signupsUrl });
    const many = render("volunteer.spot-opened", { ...base, shiftLabel: null, pendingCount: 3 }, "es");
    expect(many.inApp?.body).toBe(
      "Se liberó un cupo en Summer Fest — Security. Hay 3 inscripciones pendientes.",
    );
  });

  it("email stays English in es", () => {
    expect(render("volunteer.spot-opened", base, "es").email).toEqual(
      render("volunteer.spot-opened", base).email,
    );
  });
});

describe("volunteer.group-coordinator-assigned", () => {
  const base = {
    askId: ASK,
    askTitle: "Festival Crew",
    groupId: GROUP,
    groupName: "Setup",
    coordinateUrl: "https://ithas.fire/volunteers/coordinate/x",
  };

  it("en: with and without assigner", () => {
    const named = render("volunteer.group-coordinator-assigned", { ...base, assignerName: "Sam" });
    expect(named.inApp?.title).toBe("Sam made you coordinator of Setup for Festival Crew");
    expect(named.inApp?.body).toBe(
      "As coordinator of Setup, you can review, approve and check in the volunteers in your group.",
    );
    expect(named.inApp?.action).toEqual({ label: "Open your group", href: base.coordinateUrl });
    const anon = render("volunteer.group-coordinator-assigned", base);
    expect(anon.inApp?.title).toBe("You're now coordinating Setup for Festival Crew");
  });

  it("es: with and without assigner", () => {
    const named = render("volunteer.group-coordinator-assigned", { ...base, assignerName: "Sam" }, "es");
    expect(named.inApp?.title).toBe("Sam te asignó para coordinar Setup en Festival Crew");
    expect(named.inApp?.body).toBe(
      "Al coordinar Setup, puedes revisar, aprobar y registrar la llegada de las personas voluntarias de tu grupo.",
    );
    expect(named.inApp?.action).toEqual({ label: "Abrir tu grupo", href: base.coordinateUrl });
    const anon = render("volunteer.group-coordinator-assigned", base, "es");
    expect(anon.inApp?.title).toBe("Ahora coordinas Setup en Festival Crew");
  });

  it("email stays English in es", () => {
    const p = { ...base, assignerName: "Sam" };
    expect(render("volunteer.group-coordinator-assigned", p, "es").email).toEqual(
      render("volunteer.group-coordinator-assigned", p).email,
    );
  });
});

describe("volunteer.pool-signup-received", () => {
  const base = {
    askId: ASK,
    askTitle: "Festival Crew",
    signupId: SIGNUP,
    roleId: ROLE,
    roleName: "Security",
    coordinateUrl: "https://ithas.fire/volunteers/coordinate/x",
  };

  it("en: pending and approved", () => {
    const p = render("volunteer.pool-signup-received", { ...base, status: "PENDING" });
    expect(p.inApp?.title).toBe("New volunteer signup for Festival Crew");
    expect(p.inApp?.body).toBe(
      "A new Security signup for Festival Crew is waiting for review in the general pool.",
    );
    expect(p.inApp?.action).toEqual({ label: "Open roster", href: base.coordinateUrl });
    const a = render("volunteer.pool-signup-received", { ...base, status: "APPROVED" });
    expect(a.inApp?.body).toBe(
      "A new Security volunteer joined the general pool for Festival Crew and is ready to be assigned to a group.",
    );
  });

  it("es: pending and approved", () => {
    const p = render("volunteer.pool-signup-received", { ...base, status: "PENDING" }, "es");
    expect(p.inApp?.title).toBe("Nueva inscripción de voluntariado en Festival Crew");
    expect(p.inApp?.body).toBe(
      "Una nueva inscripción para Security en Festival Crew espera revisión en la bolsa general.",
    );
    expect(p.inApp?.action).toEqual({ label: "Abrir la lista", href: base.coordinateUrl });
    const a = render("volunteer.pool-signup-received", { ...base, status: "APPROVED" }, "es");
    expect(a.inApp?.body).toBe(
      "Hay una nueva inscripción para Security en la bolsa general de Festival Crew, lista para asignarse a un grupo.",
    );
  });

  it("email stays English in es", () => {
    const p = { ...base, status: "PENDING" };
    expect(render("volunteer.pool-signup-received", p, "es").email).toEqual(
      render("volunteer.pool-signup-received", p).email,
    );
  });
});

describe("volunteer.group-signup-assigned", () => {
  const p = {
    askId: ASK,
    askTitle: "Festival Crew",
    groupId: GROUP,
    groupName: "Setup",
    signupId: SIGNUP,
    roleName: "Security",
    volunteerName: "Alex Kim",
    coordinateUrl: "https://ithas.fire/volunteers/coordinate/x",
  };

  it("en", () => {
    const out = render("volunteer.group-signup-assigned", p);
    expect(out.inApp?.title).toBe("Alex Kim joined Setup");
    expect(out.inApp?.body).toBe(
      "Alex Kim (Security) was assigned to your group Setup for Festival Crew.",
    );
    expect(out.inApp?.action).toEqual({ label: "Open your group", href: p.coordinateUrl });
  });

  it("es", () => {
    const out = render("volunteer.group-signup-assigned", p, "es");
    expect(out.inApp?.title).toBe("Alex Kim se unió a Setup");
    expect(out.inApp?.body).toBe(
      "Se asignó a Alex Kim (Security) a tu grupo Setup en Festival Crew.",
    );
    expect(out.inApp?.action).toEqual({ label: "Abrir tu grupo", href: p.coordinateUrl });
  });

  it("email stays English in es", () => {
    expect(render("volunteer.group-signup-assigned", p, "es").email).toEqual(
      render("volunteer.group-signup-assigned", p).email,
    );
  });
});

describe("volunteer.occurrence-cancelled", () => {
  const p = {
    askId: ASK,
    askTitle: "Festival Crew",
    occurrenceId: OCC,
    roleName: "Security",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    endsAtIso: "2026-11-14T05:30:00.000Z",
    askUrl: "https://ithas.fire/v/x",
  };

  it("en", () => {
    const out = render("volunteer.occurrence-cancelled", p);
    expect(out.inApp?.title).toBe("Your Security shift for Festival Crew was cancelled");
    expect(plain(out.inApp?.body)).toBe(
      "The Security shift you claimed for Festival Crew (Fri, Nov 13, 2026, 7:30 PM CST) has been cancelled. No action needed — you're no longer expected that day.",
    );
    expect(out.inApp?.action).toEqual({ label: "View the schedule", href: p.askUrl });
    expect(out.inApp?.expiresAt).toEqual(new Date(p.endsAtIso));
  });

  it("es", () => {
    const out = render("volunteer.occurrence-cancelled", p, "es");
    expect(out.inApp?.title).toBe("Tu turno de Security en Festival Crew fue cancelado");
    expect(plain(out.inApp?.body)).toBe(
      "Se canceló tu turno de Security en Festival Crew del viernes 13 de noviembre de 2026 a las 19:30 (GMT-6). No tienes que hacer nada: ya no te esperan ese día.",
    );
    expect(out.inApp?.action).toEqual({ label: "Ver los horarios", href: p.askUrl });
    expect(out.inApp?.expiresAt).toEqual(new Date(p.endsAtIso));
  });

  it("email stays English in es", () => {
    expect(render("volunteer.occurrence-cancelled", p, "es").email).toEqual(
      render("volunteer.occurrence-cancelled", p).email,
    );
  });
});
