import type { NotificationLocale } from "../locale";
import { COMMON_COPY } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the image-moderation notices (held, approved, rejected).
// One entry per `NotificationLocale`; see `./rsvp.ts` for the pattern.
//
// `subjectTitle` (the event the image is on) is the organizer's own text and
// stays verbatim. When it is null the sentence drops the "for ..." phrase.
// ─────────────────────────────────────────────────────────────────────────────

type ModerationCopy = {
  readonly title: string;
  readonly body: (v: { subjectTitle: string | null }) => string;
  readonly viewEventLabel: string;
};

export type ImageModerationHeldCopy = ModerationCopy;
export type ImageModerationApprovedCopy = ModerationCopy;
export type ImageModerationRejectedCopy = ModerationCopy;

const enFor = (t: string | null) => (t ? ` for "${t}"` : "");
const esFor = (t: string | null) => (t ? ` para «${t}»` : "");

export const IMAGE_MODERATION_HELD_COPY: {
  readonly [L in NotificationLocale]: ImageModerationHeldCopy;
} = {
  en: {
    title: "Your image is being reviewed",
    body: ({ subjectTitle }) =>
      `The image you uploaded${enFor(subjectTitle)} is being reviewed and will appear once it's approved. No action is needed.`,
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: "Tu imagen está en revisión",
    body: ({ subjectTitle }) =>
      `La imagen que subiste${esFor(subjectTitle)} está en revisión y aparecerá cuando se apruebe. No tienes que hacer nada.`,
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

export const IMAGE_MODERATION_APPROVED_COPY: {
  readonly [L in NotificationLocale]: ImageModerationApprovedCopy;
} = {
  en: {
    title: "Your image is now live",
    body: ({ subjectTitle }) =>
      `The image you uploaded${enFor(subjectTitle)} has been approved and is now visible.`,
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: "Tu imagen ya es visible",
    body: ({ subjectTitle }) =>
      `La imagen que subiste${esFor(subjectTitle)} fue aprobada y ya es visible.`,
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

export const IMAGE_MODERATION_REJECTED_COPY: {
  readonly [L in NotificationLocale]: ImageModerationRejectedCopy;
} = {
  en: {
    title: "Your image wasn't approved",
    body: ({ subjectTitle }) =>
      `The image you uploaded${enFor(subjectTitle)} wasn't approved and won't be shown. You can upload a different one anytime.`,
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: "Tu imagen no fue aprobada",
    body: ({ subjectTitle }) =>
      `La imagen que subiste${esFor(subjectTitle)} no fue aprobada y no se mostrará. Puedes subir otra cuando quieras.`,
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};
