import { Image, StyleSheet, Text, View } from "react-native";

import { useThemedSheet, type NativePalette } from "@th/ui-native";

/**
 * Minimal mobile renderer for the opaque `events.getPublicEventBody` JSON.
 *
 * The canonical structure lives in `@th/schema` (`eventBodySchema`):
 *   - v1: `{ version: 1, sections: [{ layout: { columns: [{ blocks }] } }] }`
 *   - v0: `{ blocks: [...] }`
 * Blocks are a discriminated union: `richText` (ProseMirror doc), `image`
 * (`asset.assetId` resolved via `imageMap`), `spacer`, `cta`, …
 *
 * v1 scope (per spec risk note): paragraphs/headings from `richText` docs and
 * standalone `image` blocks ONLY. Everything else — spacers, CTAs, lists,
 * media embeds — is skipped silently. Malformed bodies render nothing.
 */

type RenderBlock =
  | { key: string; kind: "heading" | "paragraph"; text: string }
  | { key: string; kind: "image"; url: string; alt: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Concatenate all descendant `text` node values of a ProseMirror node. */
const collectText = (node: unknown): string => {
  if (!isRecord(node)) return "";
  let out = typeof node.text === "string" ? node.text : "";
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      out += collectText(child);
    }
  }
  return out;
};

const collectRichTextBlocks = (
  doc: unknown,
  keyPrefix: string,
  out: RenderBlock[],
): void => {
  if (!isRecord(doc) || !Array.isArray(doc.content)) return;
  doc.content.forEach((node, index) => {
    if (!isRecord(node)) return;
    if (node.type !== "paragraph" && node.type !== "heading") return;
    const text = collectText(node).trim();
    if (!text) return;
    out.push({
      key: `${keyPrefix}-${index}`,
      kind: node.type === "heading" ? "heading" : "paragraph",
      text,
    });
  });
};

const collectPageBlocks = (
  blocks: unknown,
  keyPrefix: string,
  imageMap: Record<string, string>,
  out: RenderBlock[],
): void => {
  if (!Array.isArray(blocks)) return;
  blocks.forEach((block, index) => {
    if (!isRecord(block)) return;
    const key = `${keyPrefix}-${index}`;
    if (block.type === "richText") {
      collectRichTextBlocks(block.doc, key, out);
    } else if (block.type === "image") {
      const assetId = isRecord(block.asset) ? block.asset.assetId : null;
      const url = typeof assetId === "string" ? imageMap[assetId] : undefined;
      if (url) {
        out.push({
          key,
          kind: "image",
          url,
          alt: typeof block.alt === "string" && block.alt ? block.alt : "Event image",
        });
      }
    }
    // Unknown block types (spacer, cta, …) are skipped silently.
  });
};

/** Pure + defensive: any malformed input yields an empty list, never a throw. */
export const extractEventBodyBlocks = (
  body: unknown,
  imageMap: Record<string, string>,
): RenderBlock[] => {
  const out: RenderBlock[] = [];
  try {
    if (!isRecord(body)) return out;
    if (body.version === 1 && Array.isArray(body.sections)) {
      body.sections.forEach((section, sectionIndex) => {
        if (!isRecord(section) || !isRecord(section.layout)) return;
        const columns = section.layout.columns;
        if (!Array.isArray(columns)) return;
        columns.forEach((column, columnIndex) => {
          if (!isRecord(column)) return;
          collectPageBlocks(
            column.blocks,
            `s${sectionIndex}c${columnIndex}`,
            imageMap,
            out,
          );
        });
      });
    } else if (Array.isArray(body.blocks)) {
      collectPageBlocks(body.blocks, "b", imageMap, out);
    }
  } catch {
    return [];
  }
  return out;
};

export const EventBodyRenderer = ({
  body,
  imageMap,
}: {
  body: unknown;
  imageMap: Record<string, string>;
}) => {
  const styles = useThemedSheet(makeSheet);
  const blocks = extractEventBodyBlocks(body, imageMap);
  if (blocks.length === 0) return null;

  return (
    <View style={styles.container} testID="event-body">
      {blocks.map((block) =>
        block.kind === "image" ? (
          <Image
            key={block.key}
            source={{ uri: block.url }}
            accessibilityLabel={block.alt}
            style={styles.image}
            resizeMode="cover"
          />
        ) : (
          <Text
            key={block.key}
            style={block.kind === "heading" ? styles.heading : styles.paragraph}
            accessibilityRole={block.kind === "heading" ? "header" : undefined}
          >
            {block.text}
          </Text>
        ),
      )}
    </View>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    container: { gap: 14 },
    heading: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 17,
      fontWeight: "700",
      letterSpacing: 0.3,
      lineHeight: 23,
    },
    paragraph: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 16,
      lineHeight: 24,
    },
    image: {
      width: "100%",
      aspectRatio: 16 / 9,
      backgroundColor: c.surfaceMuted,
    },
  });
