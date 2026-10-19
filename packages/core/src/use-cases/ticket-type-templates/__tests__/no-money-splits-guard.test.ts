import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * NFR-003 guard (ticket-type-packs spec): template/pack money is FACE PRICE
 * ONLY and never enters split math. `computeOrderSplits` operates on order
 * money under the zero-sum invariant — feeding template amounts into it (or
 * touching PayoutTermsLine from a template path) would be a category error,
 * so this pins, at grep level, that no template/pack source file references
 * either. The apply path's writes stay TicketType rows only.
 *
 * If this fails, the fix is almost certainly to remove the reference — not
 * to loosen the test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const GUARDED_DIRS = [
  // Organizer-facing template use cases (create/list/apply/archive/fork).
  resolve(HERE, ".."),
  // Staff pack catalogue CRUD.
  resolve(HERE, "../../platform/ticket-packs"),
];

const FORBIDDEN = ["computeOrderSplits", "PayoutTermsLine", "payoutTermsLines"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
      continue;
    }
    if (path.endsWith(".ts") && !path.includes("no-money-splits-guard")) {
      out.push(path);
    }
  }
  return out;
}

describe("NFR-003: template code never touches split math", () => {
  it("collects a non-empty guarded file set (the guard itself is alive)", () => {
    const files = GUARDED_DIRS.flatMap(walk);
    expect(files.length).toBeGreaterThan(8);
  });

  for (const dir of GUARDED_DIRS) {
    it(`no file under ${dir.split("/use-cases/")[1]} references split machinery`, () => {
      for (const file of walk(dir)) {
        const source = readFileSync(file, "utf8");
        for (const needle of FORBIDDEN) {
          expect(
            source.includes(needle),
            `${file} references ${needle} — template/pack code must never enter split math (NFR-003)`,
          ).toBe(false);
        }
      }
    });
  }
});
