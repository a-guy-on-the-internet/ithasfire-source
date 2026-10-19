// Density — dashboard and admin get denser, not different.
//
// Same paper, same ink, same labels. What changes is geometry: row height,
// padding, leading, label size. Nothing here touches colour, border weight,
// radius or font family, and that constraint is the point — a compact table
// must still be recognisably the same table, so a reader moving between an
// organizer dashboard and an admin console isn't relearning the interface.
//
// Ported from the design system's `tokens/density.css`.

/** Comfortable is the default. Compact is opt-in, per container. */
export type DensityName = "comfortable" | "compact";

export interface DensitySpec {
  /** Table/list row height. */
  rowHeight: number;
  rowPadY: number;
  rowPadX: number;
  /** Line-height multiplier inside a cell. */
  cellLeading: number;
  /** Default gap between stacked siblings at this density. */
  stackGap: number;
  /** Panel interior padding. */
  panelPad: number;
  /** Control height — matches the sm/md rungs of the control ladder. */
  controlHeight: number;
  /** Mono label size at this density. */
  labelSize: number;
  /** Body size at this density. */
  bodySize: number;
}

export const densityTokens = {
  comfortable: {
    rowHeight: 56,
    rowPadY: 16,
    rowPadX: 16,
    cellLeading: 1.5,
    stackGap: 16,
    panelPad: 24,
    controlHeight: 44,
    labelSize: 11,
    bodySize: 15,
  },
  compact: {
    rowHeight: 40,
    rowPadY: 8,
    rowPadX: 12,
    cellLeading: 1.35,
    stackGap: 12,
    panelPad: 16,
    controlHeight: 36,
    labelSize: 10,
    bodySize: 13.5,
  },
} as const satisfies Record<DensityName, DensitySpec>;

/**
 * The floor a touch surface may never go below, whatever the density says.
 *
 * Attendee and scanner surfaces are used one-handed, often outdoors, sometimes
 * by someone wearing gloves at a gate in February. A container that sets
 * `compact` must not be able to shrink a control they have to hit.
 */
export const HIT_MIN = 44;

/**
 * Resolve a density spec, honouring the touch floor.
 *
 * `touch` is not a stylistic preference — it marks a surface where a finger is
 * the input device. When set, `compact` keeps its tighter padding and leading
 * (the information-density win) but gives back the control and row heights,
 * which is the half of compact that would cost someone a mis-tap.
 */
export const resolveDensity = (
  name: DensityName = "comfortable",
  { touch = false }: { touch?: boolean } = {},
): DensitySpec => {
  const spec = densityTokens[name];
  if (!touch) {
    return spec;
  }
  return {
    ...spec,
    controlHeight: Math.max(spec.controlHeight, HIT_MIN),
    rowHeight: Math.max(spec.rowHeight, HIT_MIN),
  };
};

export type DensityTokenName = keyof typeof densityTokens;
