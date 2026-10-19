import fs from "node:fs";
import path from "node:path";

/**
 * Normalize all Storybook `meta.title` values in `packages/ui/src/**\/*.stories.*`
 * so they are deterministically derived from on-disk path.
 */

const REPO_ROOT = process.cwd();
const UI_SRC_ROOT = path.join(REPO_ROOT, "packages/ui/src");

// Keep this list conservative: we only normalize extensions that exist in this repo.
// (Add more only if the repo introduces them.)
const STORY_FILE_RE = /\.stories\.(tsx|ts|jsx|js|mdx)$/;

function walk(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (STORY_FILE_RE.test(e.name)) out.push(p);
  }
  return out;
}

function toTitleCaseWord(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

function titleCaseSegment(seg: string): string {
  // 1) split camelCase/PascalCase boundaries
  // 2) treat - and _ as word separators
  const spaced = seg
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();

  return spaced.split(/\s+/).filter(Boolean).map(toTitleCaseWord).join(" ");
}

function expectedTitleForStoryFile(storyFileAbs: string): string {
  const rel = path
    .relative(UI_SRC_ROOT, storyFileAbs)
    .replaceAll(path.sep, "/");
  const noExt = rel.replace(/\.stories\.(tsx|ts|jsx|js|mdx)$/, "");
  const parts = noExt.split("/");

  // If the story file is `.../index.stories.*`, treat it as the folder group.
  if (parts.at(-1)?.toLowerCase() === "index") parts.pop();

  return parts.map(titleCaseSegment).join("/");
}

function normalizeFile(storyFileAbs: string): {
  changed: boolean;
  before?: string;
  after?: string;
} {
  const src = fs.readFileSync(storyFileAbs, "utf8");
  const expectedTitle = expectedTitleForStoryFile(storyFileAbs);

  // Handles both single and double quotes. We intentionally do NOT attempt to rewrite
  // dynamic titles (template strings with ${} etc.).
  const titlePropRe = /(\btitle\s*:\s*)(["'])([^\n\r]*?)\2/;
  const m = src.match(titlePropRe);
  if (!m) {
    return { changed: false };
  }

  const currentTitle = m[3] ?? "";
  if (currentTitle === expectedTitle) {
    return { changed: false };
  }

  const next = src.replace(
    titlePropRe,
    (_full, prefix: string, quote: string) => {
      return `${prefix}${quote}${expectedTitle}${quote}`;
    },
  );

  fs.writeFileSync(storyFileAbs, next, "utf8");
  return { changed: true, before: currentTitle, after: expectedTitle };
}

function main() {
  const files = walk(UI_SRC_ROOT);
  let changedCount = 0;
  let skippedNoTitle = 0;

  for (const file of files) {
    const res = normalizeFile(file);
    if (res.changed) changedCount += 1;
    else {
      // Try to approximate whether we skipped due to missing title.
      const content = fs.readFileSync(file, "utf8");
      if (!/\btitle\s*:\s*["']/.test(content)) skippedNoTitle += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        storyFiles: files.length,
        changed: changedCount,
        skippedNoTitle,
      },
      null,
      2,
    ),
  );
}

main();
