import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// The three LEAF modules ship into the public request form's client bundle
// (the live ticks, the resolver, the platform keys). A stray runtime import —
// zod, sanitize-html, a use case — would drag its whole graph onto /p/[slug].
// This pins their RUNTIME import graph to each other: anything else must be a
// whole-statement `import type` / `export type` (erased at compile time).
//
// `import { type A } from "x"` counts as RUNTIME on purpose: under
// verbatimModuleSyntax-style transforms it survives as `import {} from "x"`.
// ─────────────────────────────────────────────────────────────────────────────

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LEAVES = [
  "standard-fields.ts",
  "platform-defaults.ts",
  "resolve-booking-standards.ts",
] as const;

const ALLOWED_RUNTIME = new Set(["./standard-fields", "./platform-defaults"]);

type Found = { specifier: string; typeOnly: boolean };

/** Every module reference in `source`, with whether it is type-only. */
function moduleReferences(source: string): Found[] {
  // Drop comments so prose like `import … from "x"` in a doc can't count.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const found: Found[] = [];
  // Static `import … from "x"` / `export … from "x"` (multi-line lists).
  for (const m of code.matchAll(
    /^\s*(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/gm,
  )) {
    found.push({
      specifier: m[3]!,
      typeOnly: /^\s*type\b/.test(m[2]!),
    });
  }
  // Side-effect `import "x"`.
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
    found.push({ specifier: m[1]!, typeOnly: false });
  }
  // Dynamic import() / require() — always runtime.
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) {
    found.push({ specifier: m[1]!, typeOnly: false });
  }
  return found;
}

const runtimeViolations = (source: string) =>
  moduleReferences(source)
    .filter((ref) => !ref.typeOnly && !ALLOWED_RUNTIME.has(ref.specifier))
    .map((ref) => ref.specifier);

describe("booking-standards leaf modules stay dependency-free", () => {
  it.each(LEAVES)("%s has no runtime import beyond its sibling leaves", (file) => {
    const source = readFileSync(resolve(DIR, file), "utf8");
    // Guard a vacuous pass: every leaf imports at least its types.
    expect(moduleReferences(source).length).toBeGreaterThan(0);
    expect(runtimeViolations(source)).toEqual([]);
  });

  describe("the checker itself (negative controls)", () => {
    it("flags a runtime zod import", () => {
      expect(runtimeViolations(`import { z } from "zod";`)).toEqual(["zod"]);
    });

    it("flags a mixed inline-type import of a non-sibling as runtime", () => {
      expect(
        runtimeViolations(`import {\n  type A,\n  b,\n} from "../../lib/sanitize-plain-text";`),
      ).toEqual(["../../lib/sanitize-plain-text"]);
      expect(runtimeViolations(`import { type A } from "zod";`)).toEqual(["zod"]);
    });

    it("flags side-effect, dynamic and require imports, and runtime re-exports", () => {
      expect(runtimeViolations(`import "sanitize-html";`)).toEqual(["sanitize-html"]);
      expect(runtimeViolations(`const m = await import("zod");`)).toEqual(["zod"]);
      expect(runtimeViolations(`const m = require("zod");`)).toEqual(["zod"]);
      expect(runtimeViolations(`export { z } from "zod";`)).toEqual(["zod"]);
    });

    it("allows type-only statements and sibling leaves, and ignores comments", () => {
      expect(
        runtimeViolations(
          [
            `import type { X } from "@th/types/repos/booking-requests";`,
            `export type { Y } from "zod";`,
            `import { fieldAppliesToIntent, type Z } from "./standard-fields";`,
            `// import { z } from "zod";`,
            `/* import "sanitize-html"; */`,
          ].join("\n"),
        ),
      ).toEqual([]);
    });
  });
});
