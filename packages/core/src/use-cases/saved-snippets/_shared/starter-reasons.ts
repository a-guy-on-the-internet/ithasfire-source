import type { SavedSnippetKind } from "@th/types/repos/saved-snippets";

// ─────────────────────────────────────────────────────────────────────────────
// Platform starter reasons (booking-the-night FR-013, decision N18): the
// reasons copied into an owner's DECLINE_REASON list the first time it is
// used, then theirs to edit or delete.
//
// WHY THE COPY LIVES HERE, not in an i18n catalog file. The spec says the
// defaults "live in the i18n catalog", but these strings are DATA: they are
// copied into `SavedSnippet` rows once, server-side, in the actor's locale,
// and never rendered through `t()` afterwards. So the copy must be readable by
// core at the moment of the copy:
//   - `apps/web/src/i18n/messages/*` is an app catalog core cannot import;
//   - `packages/locale/messages/*.json` is the shared catalog, but core does
//     not depend on `@th/locale` (adding it is a workspace-dependency + lockfile
//     change for six strings), and those JSON files carry a standing,
//     uncommitted owner WIP that agents must not edit.
// So this module IS the catalog for this one piece of server-side copy: keyed
// by locale, with en/es parity enforced by the TYPE (every locale is a full
// `Record<StarterReasonKey, …>`) and the bounds pinned by a test.
//
// VOICE. One set serves every list — a place's, an organisation's, a person's
// — because the same reason field is used to decline, close, cancel, decline
// terms and pass. So every starter is written in a neutral "we/us" that reads
// right from either side of a booking, and none says "venue" (CONTEXT.md:
// Place). Each body fits an act's pass (240), so the picker offers all six on
// every reason field.
// ─────────────────────────────────────────────────────────────────────────────

/** Locales the starters exist in. Anything else falls back to English. */
export const STARTER_LOCALES = ["en", "es"] as const;
export type StarterLocale = (typeof STARTER_LOCALES)[number];
export const DEFAULT_STARTER_LOCALE: StarterLocale = "en";

/** The copy order — the order the starters land in the list (sortOrder 0..n-1). */
export const STARTER_REASON_KEYS = [
  "dateDoesNotWork",
  "notTheRightFit",
  "sizeDoesNotMatch",
  "budgetDoesNotWork",
  "nightAlreadyBooked",
  "notEnoughTime",
] as const;
export type StarterReasonKey = (typeof STARTER_REASON_KEYS)[number];

export type StarterReason = { readonly label: string; readonly body: string };

/**
 * Plain text: no markup, no control characters, single spaces — each string
 * survives the plain-text sanitizers unchanged (pinned by the test).
 */
export const STARTER_DECLINE_REASONS: {
  readonly [L in StarterLocale]: { readonly [K in StarterReasonKey]: StarterReason };
} = {
  en: {
    dateDoesNotWork: {
      label: "That date doesn't work",
      body: "That date doesn't work for us. If you have other dates in mind, send them over and we'll take a look.",
    },
    notTheRightFit: {
      label: "Not the right fit",
      body: "Thanks for thinking of us. This isn't the right fit for us right now.",
    },
    sizeDoesNotMatch: {
      label: "The size doesn't match",
      body: "The expected crowd and the size of the room don't match, so this one won't work.",
    },
    budgetDoesNotWork: {
      label: "The budget doesn't work",
      body: "The budget doesn't work for us on this one.",
    },
    nightAlreadyBooked: {
      label: "Already booked that night",
      body: "We already have something booked that night.",
    },
    notEnoughTime: {
      label: "Not enough time",
      body: "There isn't enough time before the date to do this properly.",
    },
  },
  es: {
    dateDoesNotWork: {
      label: "Esa fecha no nos va bien",
      body: "Esa fecha no nos va bien. Si tienes otras fechas en mente, envíanoslas y las miramos.",
    },
    notTheRightFit: {
      label: "No encaja con nosotros",
      body: "Gracias por pensar en nosotros. Ahora mismo esto no encaja con lo que hacemos.",
    },
    sizeDoesNotMatch: {
      label: "El tamaño no encaja",
      body: "El público esperado y el tamaño de la sala no encajan, así que esta vez no funciona.",
    },
    budgetDoesNotWork: {
      label: "El presupuesto no cuadra",
      body: "El presupuesto no nos cuadra esta vez.",
    },
    nightAlreadyBooked: {
      label: "Ya tenemos esa noche",
      body: "Ya tenemos algo reservado esa noche.",
    },
    notEnoughTime: {
      label: "No hay tiempo suficiente",
      body: "No hay tiempo suficiente antes de la fecha para hacerlo bien.",
    },
  },
};

/**
 * A stored or requested locale tag → a starter locale. Matches on the
 * language subtag only (`es-MX` → `es`), case-insensitively; anything
 * unknown, empty or absent is English.
 */
export function toStarterLocale(tag: string | null | undefined): StarterLocale | null {
  if (!tag) return null;
  const language = tag.trim().toLowerCase().split(/[-_]/u)[0] ?? "";
  return (STARTER_LOCALES as readonly string[]).includes(language)
    ? (language as StarterLocale)
    : null;
}

/** The starters for one list kind, in copy order. ASK has none (reserved). */
export function starterSnippetsFor(
  kind: SavedSnippetKind,
  locale: StarterLocale,
): readonly StarterReason[] {
  if (kind !== "DECLINE_REASON") return [];
  const catalog = STARTER_DECLINE_REASONS[locale];
  return STARTER_REASON_KEYS.map((key) => catalog[key]);
}
