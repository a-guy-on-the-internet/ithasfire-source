// Design System v2 border grammar — 2px structural rules (cards, buttons,
// section rules), 1px inner hairlines only. Borders carry structure in this
// system (radius is locked to 0), so widths are tokenized alongside colors.
export const borderTokens = {
  structure: 2,
  hair: 1,
} as const;

export type BorderTokenName = keyof typeof borderTokens;
