import type { NotificationLocale } from "../locale";
import { BOOKING_COMMON_COPY } from "./booking";
import { esName } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the booking-hold notices (booking-holds FR-016), one entry
// per `NotificationLocale`. Same pattern as `./rsvp.ts`.
//
// FR-012 / FR-013: an ACT-facing sentence names the act's OWN date and
// position only — never who else is in line, and never a hint of who. The
// act-side functions below take no other-act argument at all, so they cannot
// leak one; only the STAFF-side ones take `actName` (staff see it on the
// request already). Keep it that way.
//
// Dates arrive already formatted in the render locale: `dateLabel` is the
// hold's day, `respondBy` the deadline instant in the place's zone. Spanish
// templates put "el"/"del" in front (the label starts at the weekday).
//
// Spanish phrasing follows the web activity log's hold entries
// (apps/web/src/i18n/messages/es.ts, `entryHold*`): hold = "reserva",
// challenge = "reclamación", kept = "mantenida", released = "liberada",
// lapse = "vencer", place in line = "fila"/"turno", ordinals "3.ª" (agreeing
// with "reserva"/"posición", so no person is gendered). "artista" for act,
// "lugar" for venue.
// ─────────────────────────────────────────────────────────────────────────────

function enOrdinal(position: number): string {
  const mod100 = position % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`;
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
}

/** Feminine abbreviated ordinal — it always qualifies "reserva"/"posición". */
const esOrdinal = (position: number): string => `${position}.ª`;

type Dated = { dateLabel: string };
type AtPlace = { placeName: string };
type Deadline = { respondBy: string };
type Staff = { actName: string };

export type BookingHoldCommonCopy = {
  readonly viewYourRequest: string;
  readonly openBookingInbox: string;
};

export const BOOKING_HOLD_COMMON_COPY: {
  readonly [L in NotificationLocale]: BookingHoldCommonCopy;
} = {
  en: {
    viewYourRequest: "View your request",
    openBookingInbox: BOOKING_COMMON_COPY.en.openBookingInbox,
  },
  es: {
    viewYourRequest: "Ver tu solicitud",
    openBookingInbox: BOOKING_COMMON_COPY.es.openBookingInbox,
  },
};

// ── booking.hold-placed / -placed-batch / -position-changed (act) ───────────

export type BookingHoldPlacedCopy = {
  readonly title: (v: AtPlace & Dated) => string;
  readonly body: (v: Dated & { position: number }) => string;
};

export const BOOKING_HOLD_PLACED_COPY: {
  readonly [L in NotificationLocale]: BookingHoldPlacedCopy;
} = {
  en: {
    title: ({ placeName, dateLabel }) =>
      `${placeName} is holding ${dateLabel} for you`,
    body: ({ dateLabel, position }) =>
      position === 1
        ? `You're first in line for ${dateLabel}.`
        : `You're ${enOrdinal(position)} in line for ${dateLabel}.`,
  },
  es: {
    title: ({ placeName, dateLabel }) =>
      `${esName(placeName, "start")} creó una reserva para ti el ${dateLabel}`,
    body: ({ dateLabel, position }) =>
      position === 1
        ? `Tu reserva es la primera en la fila para el ${dateLabel}.`
        : `Tu reserva es la ${esOrdinal(position)} en la fila para el ${dateLabel}.`,
  },
};

export type BookingHoldPlacedBatchCopy = {
  /** `count` is at least 2 (the schema's floor). */
  readonly title: (v: AtPlace & { count: number }) => string;
  /** One "date — place in line" item; the renderer joins them with "; ". */
  readonly line: (v: Dated & { position: number }) => string;
};

export const BOOKING_HOLD_PLACED_BATCH_COPY: {
  readonly [L in NotificationLocale]: BookingHoldPlacedBatchCopy;
} = {
  en: {
    title: ({ placeName, count }) =>
      `${placeName} is holding ${count} dates for you`,
    line: ({ dateLabel, position }) =>
      `${dateLabel} — ${position === 1 ? "first in line" : `${enOrdinal(position)} in line`}`,
  },
  es: {
    title: ({ placeName, count }) =>
      count === 1
        ? `${esName(placeName, "start")} creó una reserva para ti en 1 fecha`
        : `${esName(placeName, "start")} creó reservas para ti en ${count} fechas`,
    line: ({ dateLabel, position }) =>
      `${dateLabel}: ${esOrdinal(position)} en la fila`,
  },
};

export type BookingHoldPositionChangedCopy = {
  readonly title: (v: Dated & { first: boolean }) => string;
  readonly body: (v: AtPlace & { position: number }) => string;
};

export const BOOKING_HOLD_POSITION_CHANGED_COPY: {
  readonly [L in NotificationLocale]: BookingHoldPositionChangedCopy;
} = {
  en: {
    title: ({ dateLabel, first }) =>
      first
        ? `You're now first in line for ${dateLabel}`
        : `Your spot in line for ${dateLabel} changed`,
    body: ({ placeName, position }) =>
      position === 1
        ? `${placeName} moved your hold to the front of the line.`
        : `You're now ${enOrdinal(position)} in line at ${placeName}.`,
  },
  es: {
    title: ({ dateLabel, first }) =>
      first
        ? `Tu reserva del ${dateLabel} es ahora la primera en la fila`
        : `Cambió la posición de tu reserva del ${dateLabel}`,
    body: ({ placeName, position }) =>
      position === 1
        ? `${esName(placeName, "start")} movió tu reserva al principio de la fila.`
        : `Tu reserva en ${esName(placeName, "mid")} es ahora la ${esOrdinal(position)} en la fila.`,
  },
};

// ── booking.hold-challenged / -challenge-extended ────────────────────────────

export type HoldKeepWill = "book_now" | "ask_for_terms";

export type BookingHoldChallengeCopy = {
  /** Staff (the assignee): names the challenged act. */
  readonly staffTitle: (v: Staff & Dated & { extended: boolean }) => string;
  readonly staffBody: (v: Staff & Deadline) => string;
  /** The challenged act (position 1). Never names the challenger (N20). */
  readonly challengedTitle: (v: AtPlace & Dated & { extended: boolean }) => string;
  readonly challengedBody: (v: Dated & Deadline & { keepWill: HoldKeepWill | undefined }) => string;
  readonly extendedBody: (v: Deadline) => string;
  /** The act next in line (position 2): informational. */
  readonly nextTitle: (v: AtPlace & Dated & { extended: boolean }) => string;
  readonly nextBody: (v: AtPlace & Deadline) => string;
  readonly keepOrReleaseLabel: string;
};

export const BOOKING_HOLD_CHALLENGE_COPY: {
  readonly [L in NotificationLocale]: BookingHoldChallengeCopy;
} = {
  en: {
    staffTitle: ({ actName, dateLabel, extended }) =>
      extended
        ? `Deadline moved for ${actName} on ${dateLabel}`
        : `Challenge open: ${actName} on ${dateLabel}`,
    staffBody: ({ actName, respondBy }) =>
      `${actName} has until ${respondBy} to keep or release the hold.`,
    challengedTitle: ({ placeName, dateLabel, extended }) =>
      extended
        ? `More time to answer ${placeName} about ${dateLabel}`
        : `${placeName} needs an answer on ${dateLabel}`,
    challengedBody: ({ dateLabel, respondBy, keepWill }) => {
      const ready = `Another act is ready to book ${dateLabel}.`;
      switch (keepWill) {
        case "book_now":
          return `${ready} Agree your terms by ${respondBy} to keep it. Keep agrees them and books the night.`;
        case "ask_for_terms":
          // Before the tap the new deadline is not known yet (the keep sets
          // it, at least 48 hours out) — so "within 48 hours of keeping",
          // never a date (review W2).
          return `${ready} Keep it by ${respondBy} and the place sends you terms. Agree them within 48 hours of keeping, or the hold lapses.`;
        default:
          return `${ready} Keep or release your hold by ${respondBy}, or it lapses.`;
      }
    },
    extendedBody: ({ respondBy }) =>
      `Your deadline moved. Keep or release your hold by ${respondBy}.`,
    nextTitle: ({ placeName, dateLabel, extended }) =>
      extended
        ? `Update on ${dateLabel} at ${placeName}`
        : `The first hold on ${dateLabel} was challenged`,
    nextBody: ({ placeName, respondBy }) =>
      `You're next in line at ${placeName}. You'll hear by ${respondBy}.`,
    keepOrReleaseLabel: "Keep or release",
  },
  es: {
    staffTitle: ({ actName, dateLabel, extended }) =>
      extended
        ? `Plazo ampliado para ${esName(actName, "mid")} el ${dateLabel}`
        : `Reclamación abierta: ${esName(actName, "mid")} el ${dateLabel}`,
    staffBody: ({ actName, respondBy }) =>
      `${esName(actName, "start")} tiene hasta el ${respondBy} para mantener o liberar la reserva.`,
    challengedTitle: ({ placeName, dateLabel, extended }) =>
      extended
        ? `Más tiempo para responder ${esName(placeName, "a")} sobre el ${dateLabel}`
        : `${esName(placeName, "start")} necesita tu respuesta sobre el ${dateLabel}`,
    challengedBody: ({ dateLabel, respondBy, keepWill }) => {
      // "Otra solicitud", not "otro artista": says nothing about who.
      const ready = `Hay otra solicitud lista para quedarse con el ${dateLabel}.`;
      switch (keepWill) {
        case "book_now":
          return `${ready} Acepta tus condiciones antes del ${respondBy} para conservar la fecha. Al mantener tu reserva, se aceptan y la noche queda contratada.`;
        case "ask_for_terms":
          return `${ready} Mantén tu reserva antes del ${respondBy} y el lugar te enviará condiciones. Acéptalas en las 48 horas siguientes a mantenerla, o la reserva vencerá.`;
        default:
          return `${ready} Mantén o libera tu reserva antes del ${respondBy}, o vencerá.`;
      }
    },
    extendedBody: ({ respondBy }) =>
      `Tu plazo cambió. Mantén o libera tu reserva antes del ${respondBy}.`,
    nextTitle: ({ placeName, dateLabel, extended }) =>
      extended
        ? `Novedades sobre el ${dateLabel} en ${esName(placeName, "mid")}`
        : `La primera reserva del ${dateLabel} fue reclamada`,
    nextBody: ({ placeName, respondBy }) =>
      `Tu reserva es la siguiente en la fila ${esName(placeName, "de")}. Tendrás noticias antes del ${respondBy}.`,
    keepOrReleaseLabel: "Mantener o liberar",
  },
};

// ── booking.hold-challenge-answered ──────────────────────────────────────────

export type BookingHoldChallengeAnsweredCopy = {
  /** The keeper's own notice: kept with no terms yet, absolute deadline. */
  readonly keeperTitle: (v: Dated) => string;
  readonly keeperBody: (v: AtPlace & Deadline) => string;
  /** The act next in line: the first hold stands. Never names that act. */
  readonly standsTitle: (v: Dated) => string;
  readonly standsBody: (v: AtPlace) => string;
  /** Staff (the assignee). */
  readonly staffTitle: (v: Staff & Dated & { kept: boolean }) => string;
  readonly staffReleasedBody: (v: Dated) => string;
  readonly staffKeptAwaitingTermsBody: (v: Deadline) => string;
  readonly staffKeptBody: string;
};

export const BOOKING_HOLD_CHALLENGE_ANSWERED_COPY: {
  readonly [L in NotificationLocale]: BookingHoldChallengeAnsweredCopy;
} = {
  en: {
    keeperTitle: ({ dateLabel }) => `You kept your hold on ${dateLabel}`,
    keeperBody: ({ placeName, respondBy }) =>
      `${placeName} will send you terms. Agree them by ${respondBy}, or the hold lapses.`,
    standsTitle: ({ dateLabel }) => `The first hold on ${dateLabel} stands`,
    standsBody: ({ placeName }) =>
      `The act ahead of you kept their hold at ${placeName}. You're still next in line.`,
    staffTitle: ({ actName, dateLabel, kept }) =>
      kept
        ? `${actName} kept their hold on ${dateLabel}`
        : `${actName} released their hold on ${dateLabel}`,
    staffReleasedBody: ({ dateLabel }) => `The line for ${dateLabel} moved up.`,
    staffKeptAwaitingTermsBody: ({ respondBy }) =>
      `Send them terms to keep this night. They have until ${respondBy} to agree, or the hold lapses.`,
    staffKeptBody: `They're still first in line. Confirm the hold to book them, or release it.`,
  },
  es: {
    keeperTitle: ({ dateLabel }) => `Mantuviste tu reserva del ${dateLabel}`,
    keeperBody: ({ placeName, respondBy }) =>
      `${esName(placeName, "start")} te enviará condiciones. Acéptalas antes del ${respondBy} o la reserva vencerá.`,
    standsTitle: ({ dateLabel }) =>
      `La primera reserva del ${dateLabel} se mantiene`,
    standsBody: ({ placeName }) =>
      `La reserva que va delante de la tuya en ${esName(placeName, "mid")} se mantuvo. Tu reserva sigue siendo la siguiente en la fila.`,
    staffTitle: ({ actName, dateLabel, kept }) =>
      kept
        ? `${esName(actName, "start")} mantuvo su reserva del ${dateLabel}`
        : `${esName(actName, "start")} liberó su reserva del ${dateLabel}`,
    staffReleasedBody: ({ dateLabel }) => `La fila del ${dateLabel} avanzó.`,
    staffKeptAwaitingTermsBody: ({ respondBy }) =>
      `Envíale condiciones para mantener esta noche. Tiene hasta el ${respondBy} para aceptarlas o la reserva vencerá.`,
    staffKeptBody:
      "Su reserva sigue siendo la primera en la fila. Confirma la reserva para cerrar la contratación, o libérala.",
  },
};

// ── booking.hold-released / -lost-date / -expired / -confirmed ──────────────

export type HoldReleaseReason =
  | "MANUAL"
  | "REQUEST_CLOSED"
  | "SIBLING_CONFIRMED"
  | "EVENT_SCHEDULED";

export type BookingHoldReleasedCopy = {
  /** Staff, FR-018 only: a published event took the held date. */
  readonly staffTitle: (v: Staff & Dated) => string;
  readonly staffBody: string;
  readonly title: (v: AtPlace & Dated) => string;
  readonly body: (v: AtPlace & { reason: HoldReleaseReason }) => string;
};

export const BOOKING_HOLD_RELEASED_COPY: {
  readonly [L in NotificationLocale]: BookingHoldReleasedCopy;
} = {
  en: {
    staffTitle: ({ actName, dateLabel }) =>
      `Hold for ${actName} on ${dateLabel} was released`,
    staffBody: `An event was scheduled on that date, so the hold left the line.`,
    title: ({ placeName, dateLabel }) =>
      `Your hold on ${dateLabel} at ${placeName} was released`,
    body: ({ placeName, reason }) =>
      reason === "SIBLING_CONFIRMED"
        ? `Your booking was confirmed for a different date, so this hold is no longer needed.`
        : reason === "REQUEST_CLOSED"
          ? `The request was closed, so the hold went with it.`
          : reason === "EVENT_SCHEDULED"
            ? `${placeName} scheduled an event on that date, so the hold was released. Your request is still open.`
            : `${placeName} released the hold. Your request is still open.`,
  },
  es: {
    staffTitle: ({ actName, dateLabel }) =>
      `Se liberó la reserva ${esName(actName, "de")} del ${dateLabel}`,
    staffBody:
      "Se programó un evento en esa fecha, así que la reserva salió de la fila.",
    title: ({ placeName, dateLabel }) =>
      `Se liberó tu reserva del ${dateLabel} en ${esName(placeName, "mid")}`,
    body: ({ placeName, reason }) =>
      reason === "SIBLING_CONFIRMED"
        ? "Tu contratación se confirmó para otra fecha, así que esta reserva ya no hace falta."
        : reason === "REQUEST_CLOSED"
          ? "La solicitud se cerró y la reserva con ella."
          : reason === "EVENT_SCHEDULED"
            ? `${esName(placeName, "start")} programó un evento en esa fecha, así que la reserva se liberó. Tu solicitud sigue abierta.`
            : `${esName(placeName, "start")} liberó la reserva. Tu solicitud sigue abierta.`,
  },
};

/** FR-008 loser: the date went to another act — never which one. */
export type BookingHoldLostDateCopy = {
  readonly title: (v: AtPlace & Dated) => string;
  readonly body: (v: Dated) => string;
};

export const BOOKING_HOLD_LOST_DATE_COPY: {
  readonly [L in NotificationLocale]: BookingHoldLostDateCopy;
} = {
  en: {
    title: ({ placeName, dateLabel }) =>
      `${dateLabel} at ${placeName} went to another act`,
    body: ({ dateLabel }) =>
      `Your hold on ${dateLabel} was released. Your request stays open — you can propose another date in the thread.`,
  },
  es: {
    // Matches the activity log's "La fecha se asignó a otro artista".
    title: ({ placeName, dateLabel }) =>
      `La fecha del ${dateLabel} en ${esName(placeName, "mid")} se asignó a otro artista`,
    body: ({ dateLabel }) =>
      `Se liberó tu reserva del ${dateLabel}. Tu solicitud sigue abierta: puedes proponer otra fecha en la conversación.`,
  },
};

export type BookingHoldExpiredCopy = {
  readonly title: (v: AtPlace & Dated) => string;
  readonly body: string;
  readonly staffTitle: (v: Staff & Dated) => string;
  readonly staffBody: string;
};

export const BOOKING_HOLD_EXPIRED_COPY: {
  readonly [L in NotificationLocale]: BookingHoldExpiredCopy;
} = {
  en: {
    title: ({ placeName, dateLabel }) =>
      `Your hold on ${dateLabel} at ${placeName} lapsed`,
    body: `The deadline to keep or release passed without an answer, so the hold was released. Your request is still open.`,
    staffTitle: ({ actName, dateLabel }) =>
      `Hold for ${actName} on ${dateLabel} lapsed`,
    staffBody: `They didn't answer the challenge in time. The hold was released and the line moved up.`,
  },
  es: {
    title: ({ placeName, dateLabel }) =>
      `Venció tu reserva del ${dateLabel} en ${esName(placeName, "mid")}`,
    body: "El plazo para mantener o liberar pasó sin respuesta, así que la reserva se liberó. Tu solicitud sigue abierta.",
    staffTitle: ({ actName, dateLabel }) =>
      `Venció la reserva ${esName(actName, "de")} del ${dateLabel}`,
    staffBody:
      "No respondió a la reclamación a tiempo. La reserva se liberó y la fila avanzó.",
  },
};

export type BookingHoldConfirmedCopy = {
  readonly title: (v: AtPlace & Dated) => string;
  readonly body: string;
  readonly viewBookingLabel: string;
};

export const BOOKING_HOLD_CONFIRMED_COPY: {
  readonly [L in NotificationLocale]: BookingHoldConfirmedCopy;
} = {
  en: {
    title: ({ placeName, dateLabel }) => `${placeName} confirmed ${dateLabel}`,
    body: `Your date is booked. A draft event was created — the place will finish the details with you.`,
    viewBookingLabel: "View your booking",
  },
  es: {
    title: ({ placeName, dateLabel }) => `${esName(placeName, "start")} confirmó el ${dateLabel}`,
    body: "Tu fecha está contratada. Se creó un evento en borrador; el lugar terminará de definir los detalles contigo.",
    viewBookingLabel: "Ver tu contratación",
  },
};
