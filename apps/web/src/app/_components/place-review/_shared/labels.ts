// ─────────────────────────────────────────────────────────────────────────────
// Enum label maps — these drive ChipGroup / MultiChipGroup options
// ─────────────────────────────────────────────────────────────────────────────

export const PAYMENT_LABELS: Record<string, string> = {
  GUARANTEE: "Guarantee",
  DOOR_SPLIT: "Door split",
  TICKET_SALES: "Ticket sales",
  BAR_PERCENTAGE: "Bar %",
  TIPS_ONLY: "Tips only",
  PAY_TO_PLAY: "Pay to play",
  UNPAID: "Unpaid",
  OTHER: "Other",
};

export const PROMOTION_LABELS: Record<string, string> = {
  ACTIVELY_PROMOTED: "They went all out",
  POSTED_ONCE: "Bare minimum",
  NO_PROMOTION: "Nothing at all",
};

export const SOUND_LABELS: Record<string, string> = {
  GREAT: "Dialed in",
  ADEQUATE: "Got the job done",
  BAD: "Rough",
  NONEXISTENT: "Nonexistent",
};

export const EQUIPMENT_LABELS: Record<string, string> = {
  FULL: "Full backline",
  PARTIAL: "Some gear",
  NONE: "I Brought everything",
};

export const AUDIENCE_LABELS: Record<string, string> = {
  PERFECT_FIT: "My people",
  OKAY: "Mixed bag",
  WRONG_CROWD: "Wrong crowd entirely",
};

export const PLAY_AGAIN_LABELS: Record<string, string> = {
  YES: "Absolutely",
  MAYBE: "Maybe",
  NO: "Never again",
};

export const PARKING_LABELS: Record<string, string> = {
  DEDICATED_LOT: "Dedicated lot",
  STREET_NEARBY: "Street nearby",
  DIFFICULT: "Difficult",
  NIGHTMARE: "Nightmare",
};

export const BOOKER_LABELS: Record<string, string> = {
  EXCELLENT: "A pro",
  GOOD: "Solid",
  OKAY: "Fine",
  POOR: "Frustrating",
  TERRIBLE: "Awful",
};

export const MERCH_LABELS: Record<string, string> = {
  ALLOWED_FREELY: "Yes, no cut",
  ALLOWED_WITH_CUT: "Yes, with a cut",
  NOT_ALLOWED: "Nope",
};

export const STAFF_LABELS: Record<string, string> = {
  YES: "Had our backs",
  SOMEWHAT: "Hit or miss",
  NO: "On our own",
};

export const INDEPENDENT_LABELS: Record<string, string> = {
  YES: "Indie",
  NO: "Chain / corporate",
  NOT_SURE: "Not sure",
};

/** FOH / sound engineer rating (stored in soundDetail freeform) */
export const FOH_RATING_LABELS: Record<string, string> = {
  AMAZING: "Amazing",
  GOOD: "Good",
  OKAY: "Okay",
  BAD: "Bad",
  NO_ENGINEER: "No engineer",
};

/** Security presence (stored in parkingDetail freeform) */
export const SECURITY_LABELS: Record<string, string> = {
  YES: "Yes",
  NO: "No",
};

export const DEFAULT_GENRE_TAGS = [
  "Rock",
  "Indie",
  "Pop",
  "Hip-Hop",
  "R&B",
  "Jazz",
  "Blues",
  "Country",
  "Folk",
  "Punk",
  "Metal",
  "Electronic",
  "Singer-Songwriter",
  "Latin",
  "Reggae",
  "Funk",
  "Soul",
  "Classical",
  "Americana",
  "World",
];

export const PAYOUT_RANGES: Record<string, string> = {
  UNPAID: "Unpaid / $0",
  RANGE_1_100: "$1 – $100",
  RANGE_100_250: "$100 – $250",
  RANGE_250_500: "$250 – $500",
  RANGE_500_1000: "$500 – $1 000",
  RANGE_1000_PLUS: "$1 000+",
  SPECIFIC: "Specific amount",
};

export const TIME_OF_DAY_LABELS: Record<string, string> = {
  MORNING: "Morning (9am–12pm)",
  AFTERNOON: "Afternoon (12pm–5pm)",
  EVENING: "Evening (5pm–9pm)",
  NIGHT: "Night (9pm+)",
};
