import { eventBodySchema } from "@th/schema";
import type { EventBody, EventPageBlock, LayoutSection } from "@th/schema";

import type {
  RenderedEventPage,
  RenderedEventPageBlock,
  RenderedEventPageSection,
} from "./types";

const UNKNOWN_ID_PREFIX = "unknown";

type ParseSectionsLenientOk = {
  ok: true;
  sections: LayoutSection[];
};

type ParseSectionsLenientErr = {
  ok: false;
  reason: string;
};

type ParseSectionsLenientResult =
  | ParseSectionsLenientOk
  | ParseSectionsLenientErr;

// We want to treat blocks as "opaque" at the schema layer for rendering
// purposes: unknown block variants shouldn't make the whole document
// un-renderable.
const parseSectionsLenient = (
  sectionsInput: unknown,
): ParseSectionsLenientResult => {
  if (!Array.isArray(sectionsInput)) {
    return { ok: false, reason: "sections is not an array" };
  }

  const sections: LayoutSection[] = [];

  for (const raw of sectionsInput) {
    const maybeId =
      typeof (raw as any)?.id === "string"
        ? (raw as any).id
        : UNKNOWN_ID_PREFIX;

    const style = (raw as any)?.style;
    const normalizedStyle = {
      background: (style?.background ?? "default") as any,
      density: (style?.density ?? "normal") as any,
      maxWidth: (style?.maxWidth ?? "prose") as any,
      textAlign: (style?.textAlign ?? "left") as any,
    };

    const layout = (raw as any)?.layout;

    if (layout?.type === "twoColumn") {
      const ratio = (layout?.ratio ?? "50/50") as any;
      const rawCols = Array.isArray(layout?.columns) ? layout.columns : [];
      const leftBlocks = Array.isArray(rawCols?.[0]?.blocks)
        ? rawCols[0].blocks
        : [];
      const rightBlocks = Array.isArray(rawCols?.[1]?.blocks)
        ? rawCols[1].blocks
        : [];

      sections.push({
        id: maybeId,
        kind: "section",
        style: normalizedStyle as any,
        layout: {
          type: "twoColumn",
          ratio,
          columns: [{ blocks: leftBlocks }, { blocks: rightBlocks }],
        } as any,
      } as LayoutSection);
      continue;
    }

    // Default to single column
    const rawCols = Array.isArray(layout?.columns) ? layout.columns : [];
    const blocks = Array.isArray(rawCols?.[0]?.blocks) ? rawCols[0].blocks : [];

    sections.push({
      id: maybeId,
      kind: "section",
      style: normalizedStyle as any,
      layout: {
        type: "singleColumn",
        columns: [{ blocks }],
      } as any,
    } as LayoutSection);
  }

  return { ok: true, sections };
};

const normalizeBlock = (
  block: EventPageBlock | any,
  index: number,
): RenderedEventPageBlock => {
  // `EventPageBlock` is a discriminated union on `type`, but we also want to be
  // resilient to older/invalid persisted JSON.
  const type = typeof block?.type === "string" ? block.type : "unknown";
  const id =
    typeof block?.id === "string" && block.id.trim().length
      ? block.id
      : `${UNKNOWN_ID_PREFIX}-${index}`;

  switch (type) {
    case "richText":
      return {
        type,
        id,
        html: typeof block?.html === "string" ? block.html : "",
      };
    case "image":
      return {
        type,
        // Prefer the new layout schema: `{ blockId, id }`.
        blockId:
          typeof block?.blockId === "string" && block.blockId.trim().length
            ? block.blockId
            : id,
        // Back-compat: older JSON used `asset.assetId`.
        id:
          typeof block?.id === "string" && block.id.trim().length
            ? block.id
            : (block.asset?.assetId as any),
        alt: block.alt,
      };
    case "spacer":
      return {
        type,
        id,
        size: block.size ?? "md",
      };
    case "cta":
      return {
        type,
        id,
        label: block.label,
        href: block.href,
        variant: block.variant ?? "primary",
      };
    default:
      return {
        type: "unknown",
        originalType: type,
        id,
        raw: block,
      };
  }
};

const normalizeV1Section = (
  section: LayoutSection,
): RenderedEventPageSection => {
  const normalizedStyle = section.style;

  if (section.layout.type === "twoColumn") {
    const [left, right] = section.layout.columns;
    return {
      id: section.id,
      kind: "section",
      style: normalizedStyle,
      layout: {
        type: "twoColumn",
        ratio: section.layout.ratio,
        columns: [
          {
            blocks: (left.blocks ?? []).map(normalizeBlock),
          },
          {
            blocks: (right.blocks ?? []).map(normalizeBlock),
          },
        ],
      },
    };
  }

  const [only] = section.layout.columns;
  return {
    id: section.id,
    kind: "section",
    style: normalizedStyle,
    layout: {
      type: "singleColumn",
      columns: [
        {
          blocks: (only.blocks ?? []).map(normalizeBlock),
        },
      ],
    },
  };
};

export type NormalizeEventBodyResult =
  | { ok: true; body: RenderedEventPage }
  | {
      ok: false;
      // The raw input we couldn't parse.
      input: unknown;
      // Zod issues are useful for debugging but not required by callers.
      issues?: unknown;
    };

/**
 * Normalize `EventBody` (legacy or V1) into a renderer-friendly V1 shape.
 *
 * - Legacy `{ layoutId, blocks }` becomes a single section.
 * - V1 is passed through with block safety normalization.
 */
export function normalizeEventBodyToRendered(
  input: unknown,
): NormalizeEventBodyResult {
  const parsed = eventBodySchema.safeParse(input);
  if (!parsed.success) {
    // Salvage best-effort legacy input (v0) that fails strict parsing.
    // This keeps the renderer resilient to older persisted JSON and
    // slightly-out-of-date editor schemas.
    const maybeLegacy = input as any;
    if (
      maybeLegacy &&
      typeof maybeLegacy === "object" &&
      Array.isArray(maybeLegacy.blocks)
    ) {
      return {
        ok: true,
        body: {
          version: 1,
          sections: [
            {
              id: "legacy",
              kind: "section",
              style: {
                background: "default",
                density: "normal",
                maxWidth: "prose",
                textAlign: "left",
              },
              layout: {
                type: "singleColumn",
                columns: [
                  {
                    blocks: (maybeLegacy.blocks ?? []).map(normalizeBlock),
                  },
                ],
              },
            },
          ],
        },
      };
    }

    // Salvage best-effort v1-ish input that only fails because of unknown
    // block variants.
    const maybeV1 = input as any;
    if (maybeV1?.version === 1) {
      const lenientSections = parseSectionsLenient(maybeV1.sections);
      if (lenientSections.ok) {
        return {
          ok: true,
          body: {
            version: 1,
            sections: lenientSections.sections.map(normalizeV1Section),
          },
        };
      }
    }

    return { ok: false, input, issues: parsed.error.issues };
  }

  const body: EventBody = parsed.data;

  if ("version" in body && body.version === 1 && "sections" in body) {
    const v1Body = body as Extract<
      EventBody,
      { version: 1; sections: unknown }
    >;
    return {
      ok: true,
      body: {
        version: 1,
        sections: (v1Body.sections ?? []).map(normalizeV1Section),
      },
    };
  }

  // v0 body format — wrap blocks in a single section
  const legacyBody = body as unknown as { blocks?: unknown[] };
  return {
    ok: true,
    body: {
      version: 1,
      sections: [
        {
          id: "legacy",
          kind: "section",
          style: {
            background: "default",
            density: "normal",
            maxWidth: "prose",
            textAlign: "left",
          },
          layout: {
            type: "singleColumn",
            columns: [
              {
                blocks: (legacyBody.blocks ?? []).map(normalizeBlock),
              },
            ],
          },
        },
      ],
    },
  };
}
