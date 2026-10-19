/**
 * GitHub-style heading slugs for help articles, so `[..](#some-heading)` and
 * `/help/<cat>/<slug>#some-heading` land where the author expects.
 *
 * Mirrors `github-slugger` (not a dependency): lowercase, drop everything that
 * is not a letter, mark, number, connector (`_`), space or hyphen, then turn
 * EACH space into a hyphen (no collapsing — "a  b" → "a--b", as on GitHub).
 * Repeats within one document get `-1`, `-2`, ….
 */
const STRIP = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

export function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(STRIP, "").replace(/ /g, "-");
}

/** One per document: remembers slugs already handed out to dedupe repeats. */
export function createHeadingSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugifyHeading(text);
    let slug = base;
    let n = seen.get(base) ?? 0;
    while (seen.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    seen.set(base, n);
    seen.set(slug, 0);
    return slug;
  };
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const HEADING = /^h[1-6]$/;

/**
 * Rehype plugin: gives every heading without an explicit `id` a GitHub-style
 * one derived from its text content (so `**bold**` / `` `code` `` children
 * slug the same as plain text). Run AFTER `rehype-raw`.
 */
export function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = createHeadingSlugger();
    const walk = (node: HastNode) => {
      if (
        node.type === "element" &&
        node.tagName &&
        HEADING.test(node.tagName)
      ) {
        const props = (node.properties ??= {});
        if (props.id == null || props.id === "") props.id = slug(textOf(node));
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
