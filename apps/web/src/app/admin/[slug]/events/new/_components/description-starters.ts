import type { ProseMirrorDoc } from "@th/schema";

/**
 * Starter text for an empty event description. A starter is ordinary,
 * editable prose (one paragraph and a bullet list) — not a template, and
 * nothing is saved until the organiser saves the event.
 *
 * Copy lives in the web catalog (`admin.ebStarter<Kind>Name|Intro|Items`);
 * `Items` is one bullet per line.
 */
export const DESCRIPTION_STARTER_KINDS = [
  "OpenMic",
  "Comedy",
  "Music",
  "Other",
] as const;

export type DescriptionStarterKind = (typeof DESCRIPTION_STARTER_KINDS)[number];

/**
 * Which starter fits the event's category. Slugs are the seeded platform
 * categories (`apps/api/src/scripts/seed/fixtures.ts`): `music` and
 * `open-mics`; there is no seeded comedy category, so a custom one is caught
 * by slug or name. Matching is ASCII words only (an accented or non-Latin
 * name misses and returns null). Conservative on purpose: anything unrecognised returns
 * null (never `Other`) so no starter is pushed that may not fit.
 */
export function starterKindForCategory(
  category: { slug?: string | null; name?: string | null } | null,
): DescriptionStarterKind | null {
  if (!category) return null;
  const words = (v?: string | null) =>
    (v ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
      .join(" ");
  for (const text of [words(category.slug), words(category.name)]) {
    if (!text) continue;
    const has = (re: RegExp) => re.test(` ${text} `);
    if (has(/ open mics? /)) return "OpenMic";
    if (has(/ (comedy|stand up|standup) /)) return "Comedy";
    if (has(/ (music|concerts?) /)) return "Music";
  }
  return null;
}

/**
 * The category the starter suggestion reads. Community listings use the
 * UNSAVED picker id (looked up in the category list); owned events use the
 * category saved on the event, since their picker saves on select.
 */
export function resolveStarterCategory(args: {
  isCommunity: boolean;
  pickerId: string | null;
  categories: ReadonlyArray<{
    id: string;
    slug?: string | null;
    name?: string | null;
  }>;
  savedCategory: { slug?: string | null; name?: string | null } | null;
}): { slug?: string | null; name?: string | null } | null {
  if (args.isCommunity) {
    return args.categories.find((c) => c.id === args.pickerId) ?? null;
  }
  return args.savedCategory;
}

type Translate = (key: string) => unknown;

export function buildDescriptionStarterDoc(
  kind: DescriptionStarterKind,
  t: Translate,
): ProseMirrorDoc {
  const intro = String(t(`admin.ebStarter${kind}Intro`)).trim();
  const items = String(t(`admin.ebStarter${kind}Items`))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // ProseMirror rejects an empty text node and an empty bulletList, so a
  // blank translation drops its part instead of producing an invalid doc.
  const content: ProseMirrorDoc["content"] = [];
  if (intro) {
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: intro }],
    });
  }
  if (items.length > 0) {
    content.push({
      type: "bulletList",
      content: items.map((text) => ({
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      })),
    });
  }
  if (content.length === 0) content.push({ type: "paragraph" });

  return { type: "doc", content } as ProseMirrorDoc;
}
