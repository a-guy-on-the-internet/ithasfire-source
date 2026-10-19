/**
 * Reduces an organiser-written ProseMirror doc to the plain formatting an
 * email confirmation needs, before it reaches the email renderer.
 *
 * Used where the RECIPIENT did not choose the sender's content — the waitlist
 * confirmation goes to whatever address was typed into an anonymous form, so
 * the organiser's body must not be able to carry links or markup to a
 * stranger (F8, 2026-09-29 scanner report). The stored doc is unvalidated JSON
 * (`z.record(z.unknown())` at save), so this rebuilds it from a whitelist
 * rather than filtering the input in place:
 *
 * - node types: paragraph, heading (level clamped to 1-3), bullet/ordered
 *   lists, list items, blockquote, hard break, horizontal rule, text;
 * - marks: bold, italic, strike only — `link` (and anything else) is dropped,
 *   keeping the link's text;
 * - every attr other than a heading level is dropped;
 * - Unicode control/format characters are stripped from text (bidi
 *   overrides, zero-width); the renderer HTML-escapes what remains;
 * - bounded: at most {@link MAX_NODES} nodes, {@link MAX_DEPTH} levels and
 *   {@link MAX_TEXT_CHARS} characters of text in total.
 *
 * Bare URLs typed as TEXT survive (as escaped text) and some mail clients
 * auto-link them; that residual is accepted — the caps on who can receive the
 * email are the control for it.
 */

export type OrganizerEmailNode = {
  type: string;
  text?: string;
  content?: OrganizerEmailNode[];
  attrs?: { level: 1 | 2 | 3 };
  marks?: Array<{ type: "bold" | "italic" | "strike" }>;
};

export type OrganizerEmailDoc = {
  type: "doc";
  content: OrganizerEmailNode[];
};

const MAX_NODES = 500;
const MAX_DEPTH = 8;
const MAX_TEXT_CHARS = 10_000;

const CONTAINER_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
]);
const LEAF_TYPES = new Set(["hardBreak", "horizontalRule"]);
const ALLOWED_MARKS = new Set(["bold", "italic", "strike"]);

type Budget = { nodes: number; chars: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(raw: string, budget: Budget): string {
  const text = raw.replace(/[\p{Cc}\p{Cf}]/gu, (ch) =>
    ch === "\n" ? " " : "",
  );
  const room = Math.max(0, MAX_TEXT_CHARS - budget.chars);
  const kept = text.slice(0, room);
  budget.chars += kept.length;
  return kept;
}

function cleanNode(
  raw: unknown,
  depth: number,
  budget: Budget,
): OrganizerEmailNode | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  if (depth > MAX_DEPTH || budget.nodes >= MAX_NODES) return null;
  budget.nodes += 1;

  if (raw.type === "text") {
    if (typeof raw.text !== "string") return null;
    const text = cleanText(raw.text, budget);
    if (!text) return null;
    const marks = Array.isArray(raw.marks)
      ? raw.marks
          .filter(
            (m): m is { type: "bold" | "italic" | "strike" } =>
              isRecord(m) &&
              typeof m.type === "string" &&
              ALLOWED_MARKS.has(m.type),
          )
          .map((m) => ({ type: m.type }))
      : [];
    return marks.length > 0
      ? { type: "text", text, marks }
      : { type: "text", text };
  }

  if (LEAF_TYPES.has(raw.type)) return { type: raw.type };

  if (!CONTAINER_TYPES.has(raw.type)) {
    // Unknown wrapper: keep its (cleaned) children as a paragraph so the
    // organiser's words survive but the node type does not.
    const children = cleanChildren(raw.content, depth, budget);
    return children.length > 0
      ? { type: "paragraph", content: children }
      : null;
  }

  const children = cleanChildren(raw.content, depth, budget);
  const node: OrganizerEmailNode = { type: raw.type, content: children };
  if (raw.type === "heading") {
    const level = Number(isRecord(raw.attrs) ? raw.attrs.level : undefined);
    node.attrs = { level: level === 1 || level === 3 ? level : 2 };
  }
  return node;
}

function cleanChildren(
  raw: unknown,
  depth: number,
  budget: Budget,
): OrganizerEmailNode[] {
  if (!Array.isArray(raw)) return [];
  const out: OrganizerEmailNode[] = [];
  for (const child of raw) {
    const cleaned = cleanNode(child, depth + 1, budget);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

export function sanitizeOrganizerEmailDoc(
  raw: unknown,
): OrganizerEmailDoc | null {
  if (!isRecord(raw) || raw.type !== "doc") return null;
  const budget: Budget = { nodes: 0, chars: 0 };
  const content = cleanChildren(raw.content, 0, budget);
  return content.length > 0 ? { type: "doc", content } : null;
}
