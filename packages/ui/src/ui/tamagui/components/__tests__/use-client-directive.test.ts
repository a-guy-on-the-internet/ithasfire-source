import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `@th/ui` component that calls a React hook must open with `"use client"`.
 *
 * Why this exists: the package's barrels (`components/index.ts`, `shell/index.ts`) are
 * imported from Next.js Server Components. One hook-using file without the directive
 * poisons the whole RSC module graph, and the failure is a 500 on EVERY route — while
 * `tsc` and every unit test stay green. This happened on 2026-08-26 with
 * `forms/ValidationSummary.tsx`; only loading a page caught it.
 */
const ROOT = join(__dirname, "..", "..", "..");
const HOOK_CALL = /\buse(State|Effect|Ref|Id|Callback|Memo|ImperativeHandle|LayoutEffect|Context|Reducer|SyncExternalStore|Transition|DeferredValue)\(/;
const SKIP = /(\.test\.|\.stories\.|__tests__|\.native\.)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !SKIP.test(p)) out.push(p);
  }
  return out;
}

describe("@th/ui client directive", () => {
  it("every hook-using .tsx file under src/ui opens with \"use client\"", () => {
    const offenders = walk(ROOT)
      .filter((p) => HOOK_CALL.test(readFileSync(p, "utf8")))
      .filter((p) => {
        const head = readFileSync(p, "utf8").split("\n").slice(0, 3).join("\n");
        return !/["']use client["']/.test(head);
      })
      .map((p) => relative(ROOT, p));
    expect(offenders).toEqual([]);
  });
});
