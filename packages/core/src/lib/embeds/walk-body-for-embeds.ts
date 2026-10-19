/**
 * Pure traversal helper that yields all `mediaEmbed` ProseMirror nodes inside
 * an event body. Mirrors the image-collection pattern in
 * `get-public-event-body.ts`.
 *
 * Body shape (v1): sections[].layout.columns[].blocks[]; richText blocks hold
 * a ProseMirror doc whose nodes can include a `mediaEmbed` leaf node.
 */

export type CollectedMediaEmbed = {
  provider: string;
  sourceUrl: string;
  embedUrl: string;
  externalId: string;
  renderMode: string;
  kind?: string;
  title?: string;
  aspectRatio?: string;
};

export function collectMediaEmbedNodes(body: unknown): CollectedMediaEmbed[] {
  const out: CollectedMediaEmbed[] = [];
  if (!body || typeof body !== "object") return out;

  const bodyObj = body as Record<string, unknown>;

  // v1: sections[].layout.columns[].blocks[]
  if (Array.isArray(bodyObj.sections)) {
    for (const section of bodyObj.sections) {
      const layout = (section as any)?.layout;
      const columns = Array.isArray(layout?.columns) ? layout.columns : [];
      for (const col of columns) {
        const blocks = Array.isArray(col?.blocks) ? col.blocks : [];
        for (const block of blocks) {
          collectFromBlock(block, out);
        }
      }
    }
  }

  // Legacy body: blocks[]
  if (Array.isArray(bodyObj.blocks)) {
    for (const block of bodyObj.blocks) {
      collectFromBlock(block, out);
    }
  }

  return out;
}

function collectFromBlock(block: unknown, out: CollectedMediaEmbed[]): void {
  if (!block || typeof block !== "object") return;
  const b = block as Record<string, unknown>;

  if (b.type === "richText" && b.doc && typeof b.doc === "object") {
    walkProseMirror(b.doc, out);
  }
}

function walkProseMirror(node: unknown, out: CollectedMediaEmbed[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;

  if (n.type === "mediaEmbed") {
    const attrs = (n.attrs as Record<string, unknown>) ?? {};
    const provider = attrs.provider;
    const sourceUrl = attrs.sourceUrl;
    const embedUrl = attrs.embedUrl;
    const externalId = attrs.externalId;
    const renderMode = attrs.renderMode;
    if (
      typeof provider === "string" &&
      typeof sourceUrl === "string" &&
      typeof embedUrl === "string" &&
      typeof externalId === "string" &&
      typeof renderMode === "string"
    ) {
      out.push({
        provider,
        sourceUrl,
        embedUrl,
        externalId,
        renderMode,
        kind: typeof attrs.kind === "string" ? attrs.kind : undefined,
        title: typeof attrs.title === "string" ? attrs.title : undefined,
        aspectRatio:
          typeof attrs.aspectRatio === "string" ? attrs.aspectRatio : undefined,
      });
    }
    return;
  }

  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      walkProseMirror(child, out);
    }
  }
}
