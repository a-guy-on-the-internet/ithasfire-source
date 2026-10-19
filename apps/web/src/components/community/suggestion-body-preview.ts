/**
 * Plain-text preview extraction for a suggested event `content` value (the
 * full EventBody JSON carried inside an EventEditSuggestion diff).
 *
 * The diff card must NEVER mount ProseMirror — it only needs a short, safe
 * text preview. This walks both EventBody shapes (v1
 * `sections[].layout.columns[].blocks[]` and legacy top-level `blocks[]`),
 * collecting richText text nodes, image alt text, and CTA labels — mirroring
 * the server-side `extractPlainText` (event-body-sanitizer) without pulling
 * core/sanitize-html into the client bundle.
 *
 * Values are untrusted stored Json, so everything is defensively typed.
 */

const DEFAULT_MAX_CHARS = 300;

export function extractSuggestionBodyPreview(
  value: unknown,
  maxChars: number = DEFAULT_MAX_CHARS,
): string | null {
  if (value === null || typeof value !== "object") return null;

  const parts: string[] = [];
  for (const block of collectBlocks(value)) {
    collectTextFromBlock(block, parts);
  }

  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

function collectBlocks(body: object): Record<string, unknown>[] {
  const bodyObj = body as Record<string, unknown>;
  const blocks: Record<string, unknown>[] = [];

  const push = (candidate: unknown) => {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      blocks.push(candidate as Record<string, unknown>);
    }
  };

  // v1: sections[].layout.columns[].blocks[]
  if (Array.isArray(bodyObj.sections)) {
    for (const section of bodyObj.sections) {
      const layout = (section as Record<string, unknown> | null)?.layout as
        | Record<string, unknown>
        | undefined;
      const columns = Array.isArray(layout?.columns) ? layout.columns : [];
      for (const column of columns) {
        const columnBlocks = (column as Record<string, unknown> | null)
          ?.blocks;
        if (Array.isArray(columnBlocks)) {
          for (const block of columnBlocks) push(block);
        }
      }
    }
  }

  // legacy: top-level blocks[]
  if (Array.isArray(bodyObj.blocks)) {
    for (const block of bodyObj.blocks) push(block);
  }

  return blocks;
}

function collectTextFromBlock(
  block: Record<string, unknown>,
  parts: string[],
): void {
  switch (block.type) {
    case "richText":
      collectProseMirrorText(block.doc, parts);
      break;
    case "cta":
      if (typeof block.label === "string") parts.push(block.label);
      break;
    case "image":
      if (typeof block.alt === "string") parts.push(block.alt);
      break;
    default:
      break;
  }
}

/** Depth-first walk of a ProseMirror doc collecting `text` leaf nodes and image captions. */
function collectProseMirrorText(node: unknown, parts: string[]): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;

  if (typeof record.text === "string") {
    parts.push(record.text);
  }
  // An image's caption shows under it on the page, so a caption-only edit
  // must show here too (the server's content filter reads it the same way).
  if (record.type === "imageBlock") {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (attrs && typeof attrs.caption === "string") {
      parts.push(attrs.caption);
    }
  }
  if (Array.isArray(record.content)) {
    for (const child of record.content) {
      collectProseMirrorText(child, parts);
    }
  }
}
