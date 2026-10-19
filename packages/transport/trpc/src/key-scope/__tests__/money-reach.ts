/**
 * Static money-reach analysis for the FR-008 structural test
 * (`money-reach.test.ts`). Test-only: reads source text, never runs it.
 *
 * 1. Seeds: core and transport files that call a money-moving payments-port
 *    method (`MONEY_PORT_CALL`) or write who gets paid
 *    (`DEFERRED_MONEY_WRITE`: payout-terms lines and payees).
 * 2. Closure: a file that VALUE-imports a function exported by a money file
 *    (named imports resolved through barrels and `export *`) is a money file.
 * 3. Money names: every function a money file exports, as imported into the
 *    transport (`transportMoneyImports`).
 *
 * The test then reads each procedure's resolver source and flags the money
 * names it calls.
 *
 * LIMITS: this scan is a tripwire, not a proof. It does NOT see:
 * - money reached through a callback injected on ctx (`ctx.deps.*`, ports
 *   wired in apps/api `dep.ts`) or any other runtime indirection;
 * - router-local helpers and factories that wrap a use case (a resolver that
 *   calls `makeThing()(...)` is matched only by the names it spells out; the
 *   "maps every money function" test catches an import used only through a
 *   helper, not a helper defined in the router file itself). Example: the
 *   volunteer reward hooks (`makeRewardHooks`, routers/volunteer.ts) grant
 *   $0 comp tickets on ON_APPROVAL (signup review) and ON_CHECK_IN
 *   (`volunteer.signups.checkIn`) and are invisible here; R33 / R34a
 *   denylist those procedures by name, and money-reach.test.ts has a
 *   separate tripwire for any resolver that calls `makeRewardHooks(`.
 *   The reverse also happens: a harmless helper exported from a router file
 *   that is itself a money file is flagged (`answerActNotices`);
 * - exported objects or maps of functions (`export const handlers = {...}`):
 *   only function exports propagate;
 * - payments-port or repo methods missing from the two regexes below.
 * The denylist's prefix rules and `SENSITIVE_NAME` in procedure-tags.test.ts
 * cover the rest. Nobody should read a green run as "no other procedure moves
 * money".
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TRPC_SRC = path.resolve(HERE, "../..");
export const CORE_SRC = path.resolve(TRPC_SRC, "../../../core/src");

/**
 * Payments-port calls that move money: refunds, transfer reversals,
 * transfers (payouts and settlements), and charges: payment intents created
 * (checkout), run on a Terminal reader, or cancelled (cart release). Charges
 * joined with R32 (owner, 2026-10-13: checkout is a person's yes).
 */
export const MONEY_PORT_CALL =
  /\.(refundPaymentIntent|reverseTransfer|createTransfer|createPaymentIntent|createCardPresentPaymentIntent|processPaymentIntentOnReader|cancelPaymentIntent|createConnectAccount|updateDisputeEvidence)\s*\(/;

/**
 * Deferred money writes: they move no money now, but decide where later
 * transfers go. Payout-terms lines name the payees a sale is split between;
 * a payee row binds a subject to a Stripe account. A key that can write either
 * can redirect an event's payouts (R32). Confirming a line
 * (`updateLineConfirmation`) and archiving terms (`archive`) decide whether
 * a payout goes out under them, so they seed too.
 *
 * Left out, each read 2026-10-13: `provisionDefaultPrimary` (a 100% line to
 * the subject's OWN payee), `markNotDefault` and `pinFeePolicy` (no payee or
 * line), and `payees.syncCapabilities` / `markDeauthorized` /
 * `updateResaleFinanceState` (Stripe webhook state for an existing payee).
 */
export const DEFERRED_MONEY_WRITE =
  /\.payoutTerms\.(replaceLines|updateDraft|activate|clone|seedLinesIfEmpty|createDraft|updateLineConfirmation|archive)\s*\(|\.payees\.upsertForSubject\s*\(/;

/** A file is a money seed when it calls either. */
export const isMoneySeed = (text: string): boolean =>
  MONEY_PORT_CALL.test(text) || DEFERRED_MONEY_WRITE.test(text);

type Mod = {
  file: string;
  text: string;
  /** value imports: local name -> { spec, imported } ("*" for namespace) */
  imports: Array<{ local: string; imported: string; spec: string }>;
  reexports: Array<{ exported: string; imported: string; spec: string }>;
  starExports: string[];
  localExports: Set<string>;
  functionExports: Set<string>;
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
};

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const parseNames = (list: string) =>
  list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("type "))
    .map((s) => {
      const [imported, local] = s.split(/\s+as\s+/);
      return { imported: imported!.trim(), local: (local ?? imported)!.trim() };
    });

function parse(file: string): Mod {
  const text = stripComments(readFileSync(file, "utf8"));
  const mod: Mod = {
    file,
    text,
    imports: [],
    reexports: [],
    starExports: [],
    localExports: new Set(),
    functionExports: new Set(),
  };
  for (const m of text.matchAll(
    /import\s+(type\s+)?(\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    if (m[1]) continue;
    for (const n of parseNames(m[3]!)) mod.imports.push({ ...n, spec: m[4]! });
  }
  for (const m of text.matchAll(
    /import\s+\*\s+as\s+(\w+)\s+from\s*["']([^"']+)["']/g,
  )) {
    mod.imports.push({ local: m[1]!, imported: "*", spec: m[2]! });
  }
  for (const m of text.matchAll(
    /export\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    if (m[1]) continue;
    for (const n of parseNames(m[2]!)) {
      mod.reexports.push({ exported: n.local, imported: n.imported, spec: m[3]! });
    }
  }
  for (const m of text.matchAll(
    /export\s+\*\s+(?:as\s+\w+\s+)?from\s*["']([^"']+)["']/g,
  )) {
    mod.starExports.push(m[1]!);
  }
  for (const m of text.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(function\*?|const|let|class)\s+(\w+)(\s*(?::[^=]*)?=\s*(async\s*)?(\(|function|[\w]+\s*=>))?/g,
  )) {
    mod.localExports.add(m[2]!);
    if (m[1]!.startsWith("function") || m[3]) mod.functionExports.add(m[2]!);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}\s*;?(?!\s*from)/g)) {
    for (const n of parseNames(m[1]!)) mod.localExports.add(n.local);
  }
  return mod;
}

export class MoneyGraph {
  readonly mods = new Map<string, Mod>();

  constructor() {
    for (const f of [...walk(CORE_SRC), ...walk(TRPC_SRC)]) {
      this.mods.set(f, parse(f));
    }
  }

  resolveSpec(from: string, spec: string): string | null {
    let base: string;
    if (spec === "@th/core") base = CORE_SRC;
    else if (spec.startsWith("@th/core/")) base = path.join(CORE_SRC, spec.slice(9));
    else if (spec === "@th/trpc") base = TRPC_SRC;
    else if (spec.startsWith("@th/trpc/")) base = path.join(TRPC_SRC, spec.slice(9));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
    else return null;
    base = base.replace(/\.js$/, "");
    for (const c of [base, `${base}.ts`, path.join(base, "index.ts")]) {
      if (this.mods.has(c)) return c;
      if (c.endsWith(".ts") && existsSync(c) && !statSync(c).isDirectory()) {
        return this.mods.has(c) ? c : null;
      }
    }
    return null;
  }

  /** The file that defines `name` as exported from `file`, through barrels. */
  resolveName(file: string, name: string, seen = new Set<string>()): string | null {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const mod = this.mods.get(file);
    if (!mod) return null;
    if (mod.localExports.has(name)) return file;
    for (const r of mod.reexports) {
      if (r.exported !== name) continue;
      const target = this.resolveSpec(file, r.spec);
      return target ? this.resolveName(target, r.imported, seen) : null;
    }
    for (const spec of mod.starExports) {
      const target = this.resolveSpec(file, spec);
      const hit = target ? this.resolveName(target, name, seen) : null;
      if (hit) return hit;
    }
    return null;
  }

  /** Every file that (transitively) reaches a money-moving port call. */
  moneyFiles(): Set<string> {
    const money = new Set<string>();
    for (const [f, m] of this.mods) if (isMoneySeed(m.text)) money.add(f);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [f, m] of this.mods) {
        if (money.has(f)) continue;
        const hits = m.imports.some((imp) => {
          const target = this.resolveSpec(f, imp.spec);
          if (!target) return false;
          if (imp.imported === "*") return money.has(target);
          const def = this.resolveName(target, imp.imported);
          return (
            !!def &&
            money.has(def) &&
            !!this.mods.get(def)?.functionExports.has(imp.imported)
          );
        });
        if (hits) {
          money.add(f);
          grew = true;
        }
      }
    }
    return money;
  }

  /**
   * Money functions imported into transport files: local name -> where.
   * These are the names a procedure resolver calls.
   */
  transportMoneyImports(money: Set<string>): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [f, m] of this.mods) {
      if (!f.startsWith(TRPC_SRC)) continue;
      for (const imp of m.imports) {
        if (imp.imported === "*") continue;
        const target = this.resolveSpec(f, imp.spec);
        if (!target) continue;
        const def = this.resolveName(target, imp.imported);
        if (
          def &&
          money.has(def) &&
          this.mods.get(def)?.functionExports.has(imp.imported)
        ) {
          const where = out.get(imp.local) ?? [];
          where.push(path.relative(TRPC_SRC, f));
          out.set(imp.local, where);
        }
      }
    }
    return out;
  }
}
