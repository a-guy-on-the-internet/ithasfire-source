// Swiss International Typographic Style — strictly rectangular. No rounded corners.
const numericRadiusScale = {
  $0: 0,
  $1: 0,
  $2: 0,
  $3: 0,
  $4: 0,
  $5: 0,
  $6: 0,
  $7: 0,
} as const;

export const radiusTokens = {
  ...numericRadiusScale,
  none: numericRadiusScale["$0"],
  xs: numericRadiusScale["$1"],
  sm: numericRadiusScale["$2"],
  md: numericRadiusScale["$3"],
  true: numericRadiusScale["$3"],
  lg: numericRadiusScale["$4"],
  xl: numericRadiusScale["$5"],
  pill: numericRadiusScale["$6"],
  full: numericRadiusScale["$7"],
} as const;

export type RadiusTokenName = keyof typeof radiusTokens;
