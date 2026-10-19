import { Platform } from "react-native";

export const MOBILE_BREAKPOINT = 600;
export const TABLET_BREAKPOINT = 992;

export const DEFAULT_MIN_CARD_WIDTH = 272;
export const DEFAULT_MAX_ROWS_DESKTOP = 3;
export const DEFAULT_MAX_ROWS_TABLET = 4;
export const DEFAULT_MAX_ROWS_MOBILE = Infinity;

export const DEFAULT_ROW_GAP = "$5";
export const DEFAULT_COLUMN_GAP = "$4";
export const CAROUSEL_ROW_GAP = "$3";
export const CAROUSEL_COLUMN_GAP = "$2";
export const LIST_ROW_GAP = "$2";

/**
 * Slice of the track left visible past the active carousel card when the card
 * has to be narrowed to fit (phones). Keeps the "there is more to the right"
 * affordance instead of a card that exactly fills the viewport and reads static.
 */
export const CAROUSEL_PEEK_PX = 36;

/** Floor for the narrowed carousel card — below this the horizontal card's
 *  40% art panel + body stops being legible, so we let it clip instead. */
export const MIN_CAROUSEL_CARD_WIDTH = 260;

export const isWeb = Platform.OS === "web" || typeof document !== "undefined";
