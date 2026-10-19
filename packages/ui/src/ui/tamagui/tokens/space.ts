const numericSpaceScale = {
  $0: 0,
  $1: 4,
  $2: 8,
  $3: 12,
  $4: 16,
  $5: 24,
  $6: 32,
  $7: 48,
  $8: 72,
} as const;

export const spaceTokens = {
  ...numericSpaceScale,
  none: numericSpaceScale["$0"],
  xs: numericSpaceScale["$1"],
  sm: numericSpaceScale["$2"],
  md: numericSpaceScale["$3"],
  true: numericSpaceScale["$3"],
  lg: numericSpaceScale["$4"],
  xl: numericSpaceScale["$5"],
  "2xl": numericSpaceScale["$6"],
  "3xl": numericSpaceScale["$7"],
  "4xl": numericSpaceScale["$8"],
} as const;

export type SpaceTokenName = keyof typeof spaceTokens;
