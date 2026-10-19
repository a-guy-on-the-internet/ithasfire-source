// ── Compatibility exports ──────────────────────────────────────────────────
// Block metadata now lives in block-config.ts. This module preserves the
// historical validation API used by entity-page use cases and tests.

export {
  UNIVERSAL_BLOCK_KINDS,
  HUMAN_BLOCK_KINDS,
  PLACE_BLOCK_KINDS,
  ORG_BLOCK_KINDS,
  getValidBlockKinds,
  isValidBlockKind,
  normalizeBlockData,
} from "./block-config";
export type {
  UniversalBlockKind,
  HumanBlockKind,
  PlaceBlockKind,
  OrgBlockKind,
  BlockKind,
} from "./block-config";
