/**
 * Terraform `jobs_scheduler_overrides` reader
 *
 * `validate-manifest.ts`'s drift gate asks one question of each env's tfvars:
 * WHICH job keys does this environment's `jobs_scheduler_overrides` block
 * override the cron / timezone / enabled of? This module answers it without
 * an HCL parser, but with the pieces of one that the question needs — comment
 * stripping, string-aware brace walking — because the regex it replaced had
 * four verified holes against the committed prod.tfvars: a nested block before
 * `cron` hid the override, `"key" : { … }` colon syntax hid it, a `#` comment
 * mentioning the variable name anchored the walk on the wrong block, and a
 * commented-out entry counted as live.
 *
 * Error posture: an override block that is MENTIONED but cannot be located, or
 * that is not brace-balanced, THROWS. The caller reports that as a gate
 * failure. A gate that cannot read its input must fail, never pass. Errors
 * name the LINE of the original file: the comment stripper keeps every
 * newline, and every walk runs on that same full-length buffer, so a line
 * count up to the offending index is exact.
 */

/** Fields whose presence makes an entry a schedule override. */
const SCHEDULE_FIELD = /\b(cron|timezone|enabled)\s*[=:]/;

const VARIABLE = "jobs_scheduler_overrides";

/** Anchored at line start so a mention inside another expression cannot match. */
const ASSIGNMENT = /^[ \t]*jobs_scheduler_overrides[ \t]*=[ \t]*\{/m;

/**
 * Job keys whose cron / timezone / enabled this tfvars file overrides.
 *
 * @throws when `jobs_scheduler_overrides` is referenced outside a comment or
 *   string but no line-anchored `jobs_scheduler_overrides = {` assignment
 *   exists, or when any brace walk reaches end-of-input unbalanced.
 */
export function readSchedulerOverrides(tfvars: string): Set<string> {
  const source = stripComments(tfvars);
  const found = new Set<string>();

  const anchor = ASSIGNMENT.exec(source);
  if (!anchor) {
    if (mentionsVariableOutsideStrings(source)) {
      throw new Error(
        `"${VARIABLE}" is referenced but no line-anchored \`${VARIABLE} = {\` assignment was found`,
      );
    }
    return found;
  }

  const open = anchor.index + anchor[0].length - 1;
  const close = findBlockEnd(source, open);

  // Walk the block's own top level, in place on `source` (not a slice, so
  // every index — and every line number an error reports — is the file's).
  // Every entry is `"<key>" = { … }` or `"<key>" : { … }`; anything else at
  // this level (a string value, a bracketed list, an anonymous map) is skipped
  // as a unit so its contents can never be mistaken for an entry.
  let i = open + 1;
  while (i < close) {
    const ch = source[i];
    if (ch === '"') {
      const { value, end } = readString(source, i);
      const after = /^\s*[=:]\s*\{/.exec(source.slice(end, close + 1));
      if (!after) {
        i = end;
        continue;
      }
      const entryOpen = end + after[0].length - 1;
      const entryClose = findBlockEnd(source, entryOpen);
      const body = source.slice(entryOpen + 1, entryClose);
      // Any nesting depth: the body is tested whole, with its string literals
      // blanked so a `note = "cron = …"` inside `payload` does not count.
      if (SCHEDULE_FIELD.test(blankStrings(body))) found.add(value);
      i = entryClose + 1;
      continue;
    }
    if (ch === "{") {
      i = findBlockEnd(source, i) + 1;
      continue;
    }
    if (ch === "[") {
      i = findBracketEnd(source, i) + 1;
      continue;
    }
    i++;
  }

  return found;
}

// ── Lexical helpers ────────────────────────────────────────────────────────

/** 1-based line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Remove `# …`, `// …` and `/* … *\/` comments. Every newline is preserved,
 * so the output is line-for-line the input: the line-anchored assignment
 * regex still works and line numbers computed on it are the file's.
 * Comment markers inside string literals are left alone. Heredocs
 * (`<<EOT` / `<<-EOT` … `EOT`) are string literals too, so their bodies are
 * BLANKED (newlines kept): a line inside one that happens to read
 * `jobs_scheduler_overrides = {` must not anchor the block scan.
 */
export function stripComments(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === '"') {
      const { end } = readString(input, i);
      out += input.slice(i, end);
      i = end;
      continue;
    }

    const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(input.slice(i));
    if (heredoc) {
      const terminator = heredoc[1]!;
      const bodyStart = i + heredoc[0].length;
      const lines = input.slice(bodyStart).split("\n");
      let consumed = 0;
      let closed = false;
      for (const line of lines) {
        consumed += line.length + 1;
        if (line.trim() === terminator) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new Error(
          `heredoc <<${terminator} opened on line ${lineAt(input, i)} is never terminated`,
        );
      }
      const end = Math.min(input.length, bodyStart + consumed);
      out += input.slice(i, end).replace(/[^\n]/g, "");
      i = end;
      continue;
    }

    if (ch === "#" || (ch === "/" && input[i + 1] === "/")) {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && input[i + 1] === "*") {
      const close = input.indexOf("*/", i + 2);
      const end = close === -1 ? input.length : close + 2;
      // Keep the newlines the comment spanned.
      out += input.slice(i, end).replace(/[^\n]/g, "");
      i = end;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Read a double-quoted string literal starting at `start` (which must be the
 * opening quote). Backslash escapes are honoured so an escaped quote does not
 * end the literal. Returns the unescaped value and the index just past the
 * closing quote.
 */
function readString(
  input: string,
  start: number,
): { value: string; end: number } {
  let value = "";
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\\" && i + 1 < input.length) {
      value += input[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i++;
  }
  throw new Error(
    `unterminated string literal opened on line ${lineAt(input, start)}`,
  );
}

/**
 * Replace every string literal's contents with nothing, keeping the quotes.
 * Only ever called on text whose strings a prior walk has already closed, so
 * `readString` cannot throw here.
 */
function blankStrings(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      const { end } = readString(input, i);
      out += '""';
      i = end;
      continue;
    }
    out += input[i];
    i++;
  }
  return out;
}

/** Does the (comment-stripped) source name the variable outside a string? */
function mentionsVariableOutsideStrings(source: string): boolean {
  return new RegExp(`\\b${VARIABLE}\\b`).test(blankStrings(source));
}

/**
 * Index of the `}` matching the `{` at `open`, skipping string literals and
 * nested braces. Throws if the input ends first.
 */
function findBlockEnd(input: string, open: number): number {
  return findMatching(input, open, "{", "}");
}

/** Index of the `]` matching the `[` at `open`. */
function findBracketEnd(input: string, open: number): number {
  return findMatching(input, open, "[", "]");
}

function findMatching(
  input: string,
  open: number,
  opener: string,
  closer: string,
): number {
  let depth = 0;
  let i = open;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      i = readString(input, i).end;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(
    `unbalanced \`${opener}\` opened on line ${lineAt(input, open)}: reached end of input at depth ${depth}`,
  );
}
