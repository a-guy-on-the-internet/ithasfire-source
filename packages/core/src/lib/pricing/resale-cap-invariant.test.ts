/**
 * RESALE CAP INVARIANT: no site weighs an ask against the ticket type's cap on
 * its own.
 *
 * Spec: docs/specs/2026-08-12/seat-price-overrides.spec.yaml Q-001 (owner
 * ruling 2026-10-10) and its as_built entry "Q-001 / resale cap". The resale
 * cap is per ticket: `TicketType.resaleCapCents`, lifted to the ticket's own
 * price when that is higher. The rule lives in `effectiveResaleCapCents`
 * (./effective-resale-cap.ts) and nowhere else.
 *
 * WHY THIS TEST EXISTS. `ask > ticketType.resaleCapCents` compiles, reads as
 * obviously correct, and refuses the holder of a $50 seat on a $30 type capped
 * at $35 from listing at the price they paid. Three sites did exactly that
 * before the ruling. The site tests catch those three going back; nothing but
 * this catches a FOURTH site written tomorrow. Same idea, same shape, as
 * lib/orders/__tests__/price-read-invariant.test.ts.
 *
 * WHAT IT SCANS. `packages/core/src/**` (use cases + lib), tests excluded.
 * Core is where an ask is accepted, refused or clamped. The adapters map the
 * column and the apps render the type's own cap to the organizer; neither
 * decides anything.
 *
 * TWO CHECKS.
 *
 *   1. COMPARE. No line compares (`<`, `>`, `<=`, `>=`) or clamps (`Math.min`,
 *      `Math.max`) against the bare name `resaleCapCents`, as a local or as a
 *      member. No exemptions. A value that came out of the helper is named
 *      something else (`effectiveCapCents`, `ticketResaleCapCents`); the bare
 *      name means the TYPE's cap, and the type's cap is never an operand.
 *
 *   2. READ. Every file that reads the type's cap is on CAP_READS below, with
 *      what it does with it, a reason, and the NUMBER of reads. A new file, or
 *      one more read in a listed file, fails until someone looks. That is what
 *      closes the alias hole in check 1 (`const cap = tt.resaleCapCents; if
 *      (ask > cap)` has no bare-name compare, but it IS a new read).
 *
 * HOW TO FIX A FAILURE. If your site refuses, clamps or displays a limit for a
 * SELLER, it needs the ticket's own price too: call
 * `effectiveResaleCapCents({ ticketTypeResaleCapCents, ticketUnitPriceCents })`
 * and add the file as FEEDS_HELPER. If it only carries the type's own cap from
 * one place to another (a copy, a write boundary, the organizer's editor), add
 * it as PASS_THROUGH with a reason a reviewer can check. "It was failing CI" is
 * not one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE_SRC = fileURLToPath(new URL("../..", import.meta.url));
const SCANNED_DIRS = ["use-cases", "lib"] as const;

// ── Matchers ───────────────────────────────────────────────────────────────

/**
 * A READ of the type's cap: member access, destructure or index access.
 * Deliberately not a property DEFINITION (`resaleCapCents: 3500`), a schema
 * field or a string literal (`column === "resaleCapCents"`): those are writes
 * and contracts. The lower-case `r` keeps `ticketTypeResaleCapCents` (the
 * helper's input key) and `effectiveResaleCapCents` out.
 */
const CAP_READ_PATTERNS: ReadonlyArray<RegExp> = [
  // `tt.resaleCapCents` / `tt?.resaleCapCents`
  /\.resaleCapCents\b/,
  // `const { resaleCapCents } = tt`
  /\{[^}]*(?<![\w$"'])resaleCapCents\b[^}]*\}\s*=(?!=)/,
  // `tt["resaleCapCents"]` (an index on something, not an array literal)
  /[\w$)\].]\[["']resaleCapCents["']\]/,
];

function countCapReads(code: string): number {
  return code
    .split("\n")
    .filter((line) => CAP_READ_PATTERNS.some((re) => re.test(line))).length;
}

/**
 * The bare name as an OPERAND of a comparison or a clamp. Run over whole
 * comment-stripped source, not line by line, so a comparison the formatter
 * wrapped across two lines is still one match.
 */
const CAP_COMPARE_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  {
    // `ask > tt.resaleCapCents`, `x <= resaleCapCents`. The lookbehind keeps
    // `=>` and shifts out.
    label: "compared (right-hand side)",
    re: /(?<![=<>])(?:<=?|>=?)\s*(?:[\w$]+\s*(?:\?\.|!\.|\.)\s*)*resaleCapCents\b/g,
  },
  {
    // `resaleCapCents < ask`, `tt.resaleCapCents! >= x`
    label: "compared (left-hand side)",
    re: /(?<![\w$"'])resaleCapCents\b!?\s*(?:<|>)/g,
  },
  {
    // `Math.min(estimate, tt.resaleCapCents)`, `Math.max(resaleCapCents ?? 0, x)`
    label: "clamped",
    re: /Math\.(?:min|max)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?(?<![\w$"'])resaleCapCents\b/g,
  },
];

type CompareHit = { label: string; offset: number; text: string };

function findCapCompares(code: string): CompareHit[] {
  const hits: CompareHit[] = [];
  for (const { label, re } of CAP_COMPARE_PATTERNS) {
    for (const match of code.matchAll(re)) {
      hits.push({
        label,
        offset: match.index ?? 0,
        text: match[0].replace(/\s+/g, " "),
      });
    }
  }
  return hits;
}

/**
 * Comments explaining the rule are not violations of it. Block comments keep
 * their newlines so reported line numbers stay true.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/\/\/.*$/gm, "");
}

// ── The reads ──────────────────────────────────────────────────────────────

type CapRead = {
  /** Path relative to packages/core/src, POSIX separators. */
  file: string;
  /**
   * FEEDS_HELPER: the read goes into `effectiveResaleCapCents` (checked).
   * PASS_THROUGH: the type's own cap is carried, never weighed against an ask.
   */
  kind: "FEEDS_HELPER" | "PASS_THROUGH";
  /** Lines that read the cap. One more is a failure, on purpose. */
  reads: number;
  /** Why this read is correct. Read by reviewers; keep it honest. */
  reason: string;
};

const CAP_READS: CapRead[] = [
  // ── The two sites that weigh an ask. All through the helper. ───────────
  {
    file: "use-cases/resale/create-resale-listing.ts",
    kind: "FEEDS_HELPER",
    reads: 1,
    reason:
      "The listing gate. Reads the live type's cap and passes it, with the " +
      "ticket's ORIGINAL price (organiser-resale-share FR-007), to " +
      "effectiveResaleCapCents; priceResaleAsk weighs the ask (plus a " +
      "buyer-paid share) against the result before refusing " +
      "RESALE_PRICE_EXCEEDS_CAP.",
  },
  {
    file: "use-cases/resale/estimate-resale-listing.ts",
    kind: "FEEDS_HELPER",
    reads: 1,
    reason:
      "The seller form's estimate (organiser-resale-share NFR-002). Same " +
      "call as the listing gate, so the cap and the highest fitting ask it " +
      "shows are the ones the listing enforces.",
  },

  // ── Carries the type's own cap. Never weighed against an ask. ────────────
  {
    file: "use-cases/analytics/compute-resale-price-snapshots.ts",
    kind: "PASS_THROUGH",
    reads: 1,
    reason:
      "Stores the type's cap on the nightly per-type row as context. The row " +
      "has no ticket, so it deliberately does NOT clamp suggestedPriceCents.",
  },
  {
    file: "use-cases/events/list-event-ticket-types-for-edit.ts",
    kind: "PASS_THROUGH",
    reads: 1,
    reason:
      "The organizer's ticket type editor shows the cap the organizer set. " +
      "Organizer-scoped, about the type, no ticket and no ask in sight.",
  },
  {
    file: "use-cases/ticket-types/upsert-ticket-type.ts",
    kind: "PASS_THROUGH",
    reads: 2,
    reason:
      "Write boundary: `input.resaleCapCents` on its way into the row " +
      "(create and update branches).",
  },
  {
    file: "use-cases/ticket-types/update-ticket-type.ts",
    kind: "PASS_THROUGH",
    reads: 1,
    reason:
      "Write boundary: `input.resaleCapCents` into the patch (null for an " +
      "ADJUSTABLE type). The sales lock on the column lives here too, by " +
      "name, not by value.",
  },
  {
    file: "use-cases/series/generate-events-from-series.ts",
    kind: "PASS_THROUGH",
    reads: 1,
    reason:
      "A COPY: each generated occurrence's ticket type takes the template " +
      "type's cap.",
  },
  {
    file: "use-cases/ticket-type-templates/apply-ticket-type-template.ts",
    kind: "PASS_THROUGH",
    reads: 1,
    reason:
      "A COPY: a template entry's cap onto the ticket type it creates (null " +
      "when resale is off).",
  },
];

// ── Scanner ────────────────────────────────────────────────────────────────

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (
        entry === "__tests__" ||
        entry === "__fixtures__" ||
        entry === "node_modules"
      ) {
        continue;
      }
      collectTsFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    acc.push(full);
  }
  return acc;
}

type ScannedFile = { relPath: string; source: string; code: string };

function scanCore(): ScannedFile[] {
  return SCANNED_DIRS.flatMap((dirName) =>
    collectTsFiles(join(CORE_SRC, dirName)),
  ).map((file) => {
    const source = readFileSync(file, "utf8");
    return {
      relPath: relative(CORE_SRC, file).split(sep).join("/"),
      source,
      code: stripComments(source),
    };
  });
}

function lineOf(code: string, offset: number): number {
  return code.slice(0, offset).split("\n").length;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Q-001: no compare or clamp against the type's resaleCapCents", () => {
  const files = scanCore();

  it("finds none in packages/core", () => {
    const hits = files.flatMap(({ relPath, code }) =>
      findCapCompares(code).map(
        (hit) =>
          `  ${relPath}:${lineOf(code, hit.offset)}  ${hit.label}\n    ${hit.text}`,
      ),
    );

    expect(
      hits,
      hits.length === 0
        ? ""
        : `An ask or a suggestion is weighed against the ticket type's cap ` +
            `on its own.\n\n${hits.join("\n")}\n\n` +
            `The resale cap is per ticket (seat-price-overrides spec Q-001): ` +
            `the type's cap, lifted to the ticket's own price. Compare ` +
            `against effectiveResaleCapCents({ ticketTypeResaleCapCents, ` +
            `ticketUnitPriceCents }) and name its result something other ` +
            `than \`resaleCapCents\`.`,
    ).toEqual([]);
  });

  it("scans a non-trivial number of files (the scanner itself still works)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it.each([
    ["rhs member", "if (input.askPriceCents > ticketType.resaleCapCents) {}"],
    ["rhs optional chain", "if (ask >= tt?.resaleCapCents) {}"],
    ["rhs local", "if (resaleCapCents != null && ask > resaleCapCents) {}"],
    ["lhs local", "if (resaleCapCents < ask) {}"],
    ["lhs member, asserted", "const over = tt.resaleCapCents! <= ask;"],
    [
      "wrapped across lines",
      "if (\n  listing.askPriceCents >\n    currentTicketType.resaleCapCents\n) {}",
    ],
    ["Math.min", "const s = Math.min(estimate, tt.resaleCapCents);"],
    ["Math.max", "const s = Math.max(resaleCapCents ?? 0, floor(x));"],
    ["Math.min, nested call", "Math.min(round(a * (b + 1)), resaleCapCents)"],
  ])("catches a bare-name operand: %s", (_label, code) => {
    expect(findCapCompares(code).length).toBeGreaterThan(0);
  });

  it.each([
    ["a copy", "resaleCapCents: tt.resaleCapCents,"],
    ["a null check", "const hasCap = tt.resaleCapCents != null;"],
    ["a column name", 'if (off && column === "resaleCapCents") continue;'],
    ["a schema field", "resaleCapCents: z.coerce.number().int().min(0),"],
    ["a type argument", 'type T = Pick<TicketType, "resaleCapCents">;'],
    ["an arrow parameter", "caps.map((resaleCapCents) => resaleCapCents ?? 0)"],
    [
      "the helper call",
      "effectiveResaleCapCents({ ticketTypeResaleCapCents: tt?.resaleCapCents, ticketUnitPriceCents })",
    ],
    [
      "the helper's result, compared",
      "if (ticketResaleCapCents != null && perUnitCents > ticketResaleCapCents) {}",
    ],
    ["the helper's result, compared (2)", "if (ask > effectiveCapCents) {}"],
  ])("does NOT flag %s", (_label, code) => {
    expect(findCapCompares(code)).toEqual([]);
  });

  it("ignores comments, and keeps line numbers true", () => {
    const source =
      "/* was: ask > tt.resaleCapCents\n   second line */\n" +
      "// if (ask > resaleCapCents)\n" +
      "const over = ask > tt.resaleCapCents;\n";
    const code = stripComments(source);
    const hits = findCapCompares(code);

    expect(hits).toHaveLength(1);
    expect(lineOf(code, hits[0]!.offset)).toBe(4);
  });

  it("documents the shape it CANNOT catch, and what catches it instead", () => {
    // An alias has no bare-name operand, so the compare matcher is blind to
    // it. It is still a READ, which the next describe counts per file.
    const alias = "const cap = tt.resaleCapCents;\nif (ask > cap) {}";
    expect(findCapCompares(alias)).toEqual([]);
    expect(countCapReads(alias)).toBe(1);
  });
});

describe("Q-001: every read of the type's resaleCapCents is accounted for", () => {
  const files = scanCore();
  const readsByFile = new Map(
    files
      .map(({ relPath, code }) => [relPath, countCapReads(code)] as const)
      .filter(([, reads]) => reads > 0),
  );

  it("matches CAP_READS file for file and read for read", () => {
    const expected = Object.fromEntries(
      CAP_READS.map((entry) => [entry.file, entry.reads]),
    );
    const actual = Object.fromEntries(readsByFile);

    expect(
      actual,
      `The files that read the ticket type's resaleCapCents, or how often ` +
        `they read it, changed.\n\n` +
        `A read that decides what a SELLER may ask (refuse, clamp, show a ` +
        `limit) must go through effectiveResaleCapCents with the ticket's ` +
        `own price: add the file as FEEDS_HELPER. A read that only carries ` +
        `the type's own cap (copy, write boundary, organizer's editor) is ` +
        `PASS_THROUGH: add it WITH A REASON a reviewer can check. A listed ` +
        `file that no longer reads the cap comes off the list. ` +
        `(seat-price-overrides spec Q-001)`,
    ).toEqual(expected);
  });

  it("every FEEDS_HELPER file really calls effectiveResaleCapCents", () => {
    const missing = CAP_READS.filter((entry) => entry.kind === "FEEDS_HELPER")
      .filter((entry) => {
        const file = files.find((f) => f.relPath === entry.file);
        return !file || !/\beffectiveResaleCapCents\(/.test(file.code);
      })
      .map((entry) => entry.file);

    expect(missing).toEqual([]);
  });

  it("lists each file once, with a reason", () => {
    expect(new Set(CAP_READS.map((e) => e.file)).size).toBe(CAP_READS.length);
    for (const entry of CAP_READS) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
      expect(entry.reads, entry.file).toBeGreaterThan(0);
    }
  });

  it.each([
    ["member access", "const cap = ticketType.resaleCapCents;"],
    ["optional chain", "const cap = tt?.resaleCapCents ?? null;"],
    ["destructure", "const { name, resaleCapCents } = ticketType;"],
    ["index access", 'const cap = tt["resaleCapCents"];'],
  ])("counts a %s read (the matcher is not vacuous)", (_label, code) => {
    expect(countCapReads(code)).toBe(1);
  });

  it.each([
    ["a property definition", "resaleCapCents: 3500,"],
    ["a local passed on", "ticketTypeResaleCapCents: resaleCapCents,"],
    ["a schema field", "resaleCapCents: z.number().int().nullable(),"],
    ["a column name", '{ column: "resaleCapCents", sources: ["resaleCapCents"] },'],
    ["the helper's input key", "input.ticketTypeResaleCapCents ?? null"],
    ["an object literal compared", "if ({ resaleCapCents: 1 } === other) {}"],
  ])("does NOT count %s", (_label, code) => {
    expect(countCapReads(code)).toBe(0);
  });
});
