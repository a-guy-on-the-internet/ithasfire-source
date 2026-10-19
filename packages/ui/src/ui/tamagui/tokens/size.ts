const numericSizeScale = {
  $0: 0,
  $1: 10,
  $2: 12,
  $3: 14,
  $4: 16,
  $5: 20,
  $6: 24,
  $7: 32,
  $8: 40,
} as const;

export const sizeTokens = {
  ...numericSizeScale,
  xs: numericSizeScale["$1"],
  sm: numericSizeScale["$2"],
  md: numericSizeScale["$3"],
  true: numericSizeScale["$3"],
  lg: numericSizeScale["$4"],
  xl: numericSizeScale["$5"],
  "2xl": numericSizeScale["$6"],
  "3xl": numericSizeScale["$7"],
  "4xl": numericSizeScale["$8"],
} as const;

export type SizeTokenName = keyof typeof sizeTokens;
