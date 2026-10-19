// Parsing `tsc --watch --pretty false` output into structured records.
//
// This lives apart from scripts/tsc-daemon.mjs for one reason: it is the
// component whose failure produces a CONFIDENT WRONG ANSWER. If a regex stops
// matching, diagnostics silently stop being recorded while tsc's own
// "Found N errors" trailer still says the tree is red. Pure functions here,
// exercised by `node scripts/tsc-status.mjs --selftest`.

/** Watch mode emits cursor escapes even under `--pretty false`. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

export const CYCLE_START =
  /Starting (?:incremental )?compilation|Starting compilation in watch mode/;
export const CYCLE_END = /Found (\d+) errors?\. Watching for file changes\./;

// `path(line,col): error TS1234: message`
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
// Config-level diagnostics have no file: `error TS5083: ...`
const GLOBAL_DIAGNOSTIC = /^(error|warning) (TS\d+): (.*)$/;

/**
 * Classify one raw line of watch output.
 * `raw` must be the untrimmed line — leading whitespace is how tsc marks a
 * continuation of the previous diagnostic's message.
 */
export function classifyLine(raw) {
  const line = stripAnsi(raw).trimEnd();
  if (!line.trim()) return { kind: "blank" };

  if (CYCLE_START.test(line)) return { kind: "cycle-start" };

  const end = line.match(CYCLE_END);
  if (end) return { kind: "cycle-end", errorCount: Number(end[1]) };

  const match = line.match(DIAGNOSTIC);
  if (match) {
    return {
      kind: "diagnostic",
      record: {
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4],
        code: match[5],
        message: match[6],
      },
    };
  }

  const global = line.match(GLOBAL_DIAGNOSTIC);
  if (global) {
    return {
      kind: "diagnostic",
      record: {
        file: null,
        line: null,
        column: null,
        severity: global[1],
        code: global[2],
        message: global[3],
      },
    };
  }

  // Indented text after a diagnostic elaborates it.
  if (/^\s/.test(stripAnsi(raw))) return { kind: "continuation", text: line.trim() };

  return { kind: "other", text: line };
}
