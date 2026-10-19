// Section headings step down below sm: "ANNOUNCEMENTS" at 24px is 293px wide
// and overran its 264px section at 320. Desktop keeps the h4 size.
export const SECTION_HEADING_PROPS = {
  fontSize: "$5",
  lineHeight: "$5",
  $gtSm: { fontSize: "$6", lineHeight: "$6" },
} as const;
