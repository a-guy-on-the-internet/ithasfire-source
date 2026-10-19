// Imagery — the system does the work, because the uploads won't.
//
// Organizer photography is inconsistent by nature: a phone snapshot from a bar
// and a lit promo shot land in the same grid. Three mechanisms make them sit on
// one page without fighting — a fixed ratio, one warm-print filter over every
// upload, and a 2px ink frame. The frame is the part that does the most work:
// it is what makes an awkward crop read as intentional.
//
// Sharp corners apply to imagery too. There is no rounded image anywhere.
// Ported from the design system's `tokens/imagery.css`.

/** The sanctioned ratios. An image outside this set is a bug, not a variant. */
export const imageRatios = {
  /** Event hero, full-bleed bands. */
  hero: 21 / 9,
  /** Event card art panel. */
  card: 3 / 2,
  /** Poster / portrait feature slots. */
  poster: 2 / 3,
  /** Table row thumbs, dashboard lists. */
  thumb: 4 / 3,
  /** Avatars, organizer marks, wallet cards. */
  square: 1,
} as const;

export type ImageRatioName = keyof typeof imageRatios;

/** The same ratios as CSS `aspect-ratio` strings, for web surfaces. */
export const imageRatioCss = {
  hero: "21 / 9",
  card: "3 / 2",
  poster: "2 / 3",
  thumb: "4 / 3",
  square: "1 / 1",
} as const satisfies Record<ImageRatioName, string>;

/**
 * The warm-print duotone every organizer upload passes through.
 *
 * Desaturating to a single warm channel is what lets a cool fluorescent snap
 * and a golden-hour shot coexist in one grid. Web-only — CSS filters do not
 * exist on React Native, where the mobile pass will need a different mechanism
 * (a tint overlay, most likely) to reach the same place.
 */
export const imageFilter =
  "grayscale(1) sepia(.34) saturate(1.45) contrast(1.04) brightness(1.02)";

/** Slightly warmer and brighter on hover — the image leans in, it doesn't move. */
export const imageFilterHover =
  "grayscale(1) sepia(.24) saturate(1.6) contrast(1.08) brightness(1.04)";

/** Frame weight, in px. Matches the structural border. */
export const imageFrameWidth = 2;

/**
 * The designed absence.
 *
 * A missing image is a state to design, not an error to hide: an ink panel with
 * the subject's initials set oversized. It reads as deliberate at every size,
 * which a broken-image glyph or a grey box never does.
 */
export const imageFallback = {
  /** Ink panel. */
  background: "#211C16",
  /** Paper initials on it. */
  foreground: "#FDFAF3",
} as const;
