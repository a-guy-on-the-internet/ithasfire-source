/**
 * FR-004 GREP INVARIANT — the durable guard for R-001.
 *
 * Spec: docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-004,
 * acceptance: "A grep for `.priceCents` outside the resolver, the adapters' row
 * mapping, and the snapshot writers returns only exempt sites, and that
 * invariant is pinned by a test so a new direct read fails CI."
 *
 * WHY THIS TEST EXISTS. `now` being a required parameter (FR-003) makes a MISSED
 * site a compile error only where a site was actually converted. It does nothing
 * about a site written TOMORROW that reads `ticketType.priceCents` and never
 * touches the resolver at all — that compiles cleanly and quietly charges the
 * pre-flip price forever. R-001 is the highest-severity risk in the spec and
 * this is the only thing that catches that shape.
 *
 * WHAT IT SCANS. `packages/core/src/**` only (use cases + lib), excluding tests.
 * Deliberately NOT the adapters (row mapping legitimately reads every column) and
 * NOT the apps (seeds and fixtures construct rows). Core is where money is
 * decided, so core is where the invariant is enforced.
 *
 * TWO AXES. The same scanner runs over two independent invariants, each with
 * its OWN exemption list so the reasons stay honest and readable:
 *
 *   1. PRICE   — `.priceCents` must not be read outside `resolveUnitPriceCents`.
 *   2. SELLABILITY — `.salesOpenAt` / `.salesCloseAt` must not be read outside
 *      `assertTicketTypeOnSale` / `resolveTicketTypeSaleState`.
 *
 * Axis 2 exists because the compile-time protection on that axis is WEAKER than
 * it looks. Making the window fields REQUIRED on `TicketTypeSummary` only forces
 * the four use cases that build that map to supply them; it does nothing about a
 * NEW surface written tomorrow that reads `tt.salesCloseAt` straight off a repo
 * record and hand-rolls `now >= tt.salesCloseAt`. That compiles, passes review by
 * looking obviously correct, and silently picks the WRONG boundary — the close
 * bound is EXCLUSIVE and the open bound INCLUSIVE, and nothing but the shared
 * predicate knows that. A hand-rolled comparison is how two surfaces come to
 * disagree about whether a tier is on sale, which is the same failure class the
 * single price resolver exists to prevent.
 *
 * HOW TO ADD AN EXEMPTION. Add an entry to EXEMPTIONS below with a REASON. The
 * point of an explicit list is that a reviewer can read it: an exemption without
 * a defensible reason is the bug this test is trying to prevent, so "it was
 * failing CI" is not one. If your site answers "what does this ticket cost?",
 * it is NOT exempt — route it through `resolveUnitPriceCents(tt, { now })`
 * with `now` from the injected ClockPort.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE_SRC = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The shapes a `priceCents` READ can take. Every one of these is a way to get
 * the raw number out of a ticket type without going near the resolver.
 *
 * Deliberately narrow on the DOT form: a property DEFINITION (`priceCents:
 * 1200`) or a schema field (`priceCents: z.number()`) must NOT match. Those are
 * writes and contracts, not reads, and flagging them would make this test noise
 * — which is how invariant tests get disabled. The leading `\.` plus the
 * `priceCents` word boundary also excludes the sibling columns
 * (`scheduledPriceCents`, `resaleCapCents`, `lowestPriceCents`, ...), which
 * are inputs TO the resolver, not bypasses.
 *
 * ── THE HOLE THIS DOES NOT CLOSE ──────────────────────────────────────────
 * An object SPREAD (`{ ...ticketType }`) leaks `priceCents` into an output
 * payload with no textual mention at all, so no regex can catch it. That is not
 * hypothetical here — spreading a record into a DTO is idiomatic in this
 * codebase.
 *
 * The durable answer is not a cleverer regex, it is SCHEMA SHAPE: keep
 * `priceCents` off any output schema that isn't supposed to carry it, and
 * declare the schema `.strict()`, so a spread that leaks it fails Zod parsing at
 * runtime instead of shipping. `list-event-ticket-types.ts` already works this
 * way — its output object is `.strict()`, so a stray spread throws rather than
 * quietly serving an unresolved price. Prefer that over trusting this scanner.
 */
const PRICE_READ_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  // `tt.priceCents`
  { label: "member access", re: /\.priceCents\b/ },
  // `const { priceCents } = tt` / `const { priceCents: p } = tt`
  {
    label: "destructure",
    re: /\{[^}]*\bpriceCents\b[^}]*\}\s*=/,
  },
  // `tt["priceCents"]`
  { label: "index access", re: /\[["']priceCents["']\]/ },
];

/** True when a line reads `priceCents` in ANY of the tracked shapes. */
function isPriceRead(line: string): boolean {
  return PRICE_READ_PATTERNS.some(({ re }) => re.test(line));
}

/**
 * The same three shapes, for the SELLABILITY axis.
 *
 * The word boundary matters as much as it does above: `.salesCloseAt` must not
 * match the local `const salesCloseAt = event.endsAt ?? event.startsAt` that the
 * EVENT-level gate uses in four places. That is a different fact about a
 * different entity — the event's own close — and flagging it would make this
 * scanner noise, which is how invariant tests get deleted. The leading `\.`
 * requires a MEMBER ACCESS, so a bare local never matches.
 */
const WINDOW_READ_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  // `tt.salesOpenAt` / `tt.salesCloseAt`
  { label: "member access", re: /\.sales(Open|Close)At\b/ },
  // `const { salesCloseAt } = tt`
  {
    label: "destructure",
    re: /\{[^}]*\bsales(Open|Close)At\b[^}]*\}\s*=/,
  },
  // `tt["salesCloseAt"]`
  { label: "index access", re: /\[["']sales(Open|Close)At["']\]/ },
];

/** True when a line reads a sales-window bound in ANY of the tracked shapes. */
function isWindowRead(line: string): boolean {
  return WINDOW_READ_PATTERNS.some(({ re }) => re.test(line));
}

type Exemption = {
  /** Path relative to packages/core/src, POSIX separators. */
  file: string;
  /** Why a direct read here is correct. Read by reviewers; keep it honest. */
  reason: string;
};

const EXEMPTIONS: Exemption[] = [
  // ── The resolver itself ────────────────────────────────────────────────────
  {
    file: "lib/orders/door-pricing.ts",
    reason:
      "THE resolver. It is the one place allowed to read the raw field — that " +
      "is the entire point of the invariant.",
  },

  // ── Write boundaries: input → row. Never a price READ. ─────────────────────
  {
    file: "use-cases/ticket-types/upsert-ticket-type.ts",
    reason:
      "Write boundary. `input.priceCents` is the organizer's typed list price " +
      "on its way into the row; there is no stored price to resolve yet.",
  },
  {
    file: "use-cases/ticket-types/update-ticket-type.ts",
    reason:
      "Write boundary (partial update). Same as upsert: the value flows input " +
      "→ row, and the audit entry records what was WRITTEN, not what it costs.",
  },
  {
    file: "use-cases/ticket-types/_shared/ensure-stripe-connected-for-paid-ticketing.ts",
    reason:
      "Not a price read — it forwards the RAW field into " +
      "`isEverPaidTicketType`, which asks 'can this tier EVER take money' " +
      "rather than 'what does it cost now'. Resolving through the price " +
      "resolver first would defeat the gate: a tier scheduled to flip to paid " +
      "resolves to $0 today, and the whole point is to demand a connected " +
      "payee BEFORE that flip lands. Same argument as the sibling fee-policy " +
      "gate in this directory.",
  },
  // ── The per-seat resolver: the resolver's sibling for seat overrides. ─────
  {
    file: "lib/orders/seat-pricing.ts",
    reason:
      "`seatOverrideCents` is THE one read of a seat override's " +
      "`priceCents` (Seat.priceOverride, not a ticket-type price), and " +
      "`resolveSeatUnitPriceCents` routes every un-overridden seat through " +
      "`resolveUnitPriceCents`. `computeOrderAmounts` prices every ticket " +
      "line through it and `holdSeatsForCheckout` compares the locked row's " +
      "override through it (seat-price-overrides spec FR-001..FR-003). " +
      "`seatOverrideCents` delegates the judgement to `classifySeatOverride` " +
      "(same file), which publishEvent's money gate also calls " +
      "(storedSeatOverrideCharges) to judge a stored value without throwing.",
  },
  {
    file: "use-cases/events/set-seat-price-overrides.ts",
    reason:
      "Write boundary, like upsertTicketType. `input.priceOverride.priceCents` " +
      "is the organizer's typed override on its way into the row, compared " +
      "to zero for the free→paid gates (spec FR-006). It never reads a " +
      "stored price: checkout charges overrides through " +
      "lib/orders/seat-pricing.ts above, and the tiers it inspects go to " +
      "`ticketTypeRequiresStripe` / `ticketTypeNeedsFeePolicy` unread.",
  },

  // ── COPY writers: FR-004 names these explicitly. ───────────────────────────
  {
    file: "use-cases/series/generate-events-from-series.ts",
    reason:
      "FR-004 exempts it by name: it COPIES priceCents along with the " +
      "schedule fields rather than resolving. (Q-005 adds the guard that an " +
      "already-elapsed schedule is nulled on copy.)",
  },
  {
    file: "use-cases/ticket-type-templates/apply-ticket-type-template.ts",
    reason:
      "Reads `entry.priceCents` off a TEMPLATE entry, not a live TicketType. A " +
      "template has no schedule to resolve until FR-011 lands.",
  },

  // ── Projections the money function resolves downstream. ────────────────────
  {
    file: "use-cases/orders/create-checkout.ts",
    reason:
      "Builds `TicketTypeSummary` maps carrying the RAW price plus the raw " +
      "schedule fields; `computeOrderAmounts` resolves them at the order's " +
      "single `now`. Pre-resolving here would put the resolution in two places.",
  },
  {
    file: "use-cases/orders/update-order-items.ts",
    reason: "Same TicketTypeSummary projection as create-checkout.",
  },
  {
    file: "use-cases/orders/claim-free-tickets.ts",
    reason: "Same TicketTypeSummary projection as create-checkout.",
  },
  {
    file: "use-cases/pos/_shared/door-ticket-types.ts",
    reason:
      "Same TicketTypeSummary projection as create-checkout, built once for " +
      "every door path (card sale, cash sale, Sell-screen quote). Each prices " +
      "through `priceCart` (door-sales spec FR-001/FR-003/FR-010), which " +
      "resolves the raw price at the sale's single `now`.",
  },

  // ── A different entity that happens to share the column name. ──────────────
  {
    file: "use-cases/memberships/",
    reason:
      "MembershipTier.priceCents is a DIFFERENT entity with no door price and " +
      "no schedule. Recurring memberships are out of this spec's scope; the " +
      "resolver's shape does not apply.",
  },
  {
    file: "use-cases/platform/summarise-recurring-revenue.ts",
    reason:
      "Same MembershipTier.priceCents as the entry above, read from " +
      "use-cases/platform/ rather than use-cases/memberships/, so the prefix " +
      "above does not reach it. `tier.interval === \"YEAR\"` is the tell: a " +
      "TicketType has no billing interval. This annualises a recurring " +
      "membership price and never asks what a ticket costs.",
  },

  // ── Admin edit-form projection. ────────────────────────────────────────────
  {
    file: "use-cases/events/list-event-ticket-types-for-edit.ts",
    reason:
      "DELIBERATE deviation from FR-004's inventory, argued in full in that " +
      "file: this is the value bound to the admin Price input, which " +
      "updateTicketType writes straight back. Resolving it would make the form " +
      "round-trip the post-flip price into `priceCents` on the next save and " +
      "destroy the schedule. The resolved view is exposed ADDITIVELY as " +
      "`effectivePriceCents`, alongside the schedule pair for the Q-002 " +
      "read-back.",
  },

  // The seat-map quotes (list-event-seat-availability, list-embed-available-
  // seats) used to be exempt here for a synthetic ticket type. They now quote
  // through `resolveSeatUnitPriceCents` (quote-seat-price-overrides.ts) and
  // read no `.priceCents`, so they need no exemption.

  // NOTE: compute-event-daily-stats.ts used to be exempted here as
  // "known wrong, out of scope" — it derived historical revenue from the LIVE
  // price AND split sales evenly across tiers. Both are fixed: it now reads
  // realised sales from `analytics.getTicketSalesRollup`, which sums
  // `OrderItem.unitPriceCents`. It reads no ticket-type price at all, so it
  // needs no exemption. Do not re-add one without re-reading why it is gone.

  // ── TEMPLATE materialization: same COPY reasoning as apply-ticket-type- ────
  // ── -template.ts above, one call deeper. ────────────────────────────────────
  {
    file: "lib/ticket-types/template-relative-schedule.ts",
    reason:
      "`materializeTemplateEntrySchedule` is called ONLY from " +
      "apply-ticket-type-template.ts (confirmed: its sole caller), and reads " +
      "`entry.scheduledPriceChange.priceCents` off a TEMPLATE entry, not a " +
      "live TicketType — there is no schedule to resolve against, only a " +
      "future value to validate and materialize into the row the apply path " +
      "writes. Same reasoning as this file's existing " +
      "apply-ticket-type-template.ts exemption, one call frame deeper.",
  },
];

/**
 * SELLABILITY-axis exemptions. Deliberately its OWN list rather than reusing the
 * price one: the sites that may legitimately touch a window are not the same set
 * as the sites that may legitimately touch a price, and sharing a list would
 * silently grant every price exemption a window exemption it never argued for.
 */
const WINDOW_EXEMPTIONS: Exemption[] = [
  // ── The predicate itself ───────────────────────────────────────────────────
  {
    file: "lib/orders/door-pricing.ts",
    reason:
      "THE sellability predicate. `resolveTicketTypeSaleState` / " +
      "`assertTicketTypeOnSale` are the one place allowed to read the raw " +
      "bounds — that is the entire point of the invariant.",
  },

  // ── Write boundaries: input → row. Never a sellability DECISION. ───────────
  {
    file: "lib/ticket-types/sales-window.ts",
    reason:
      "THE write-boundary validator. It reads both bounds to enforce " +
      "open < close before they are persisted; it never decides whether a " +
      "tier may be sold right now, and it has no clock to decide it with.",
  },
  {
    file: "use-cases/ticket-types/upsert-ticket-type.ts",
    reason:
      "Write boundary. `input.salesOpenAt` / `input.salesCloseAt` are the " +
      "organizer's typed bounds on their way into the row, plus the payload " +
      "hash that makes a retry with a different window an idempotency " +
      "conflict. No stored window is being evaluated.",
  },
  {
    file: "use-cases/ticket-types/update-ticket-type.ts",
    reason:
      "Write boundary (partial update). Reads the STORED bounds solely to " +
      "merge them against a partial input before `normalizeSalesWindow` " +
      "validates the pair — the merge is what stops a one-bound edit " +
      "persisting an inverted window. Again no sale decision.",
  },

  // ── COPY writers: reproduce configuration, never evaluate it. ──────────────
  {
    file: "use-cases/series/generate-events-from-series.ts",
    reason:
      "COPY writer. Reads `salesCloseAt` only to decide whether the copied " +
      "window has ALREADY CLOSED at copy time and must be nulled (FR-014, " +
      "FR-016's convention). That is a data-migration question about a " +
      "future row, not 'may this be sold now' — no buyer is being served.",
  },

  // ── Projections the shared predicate consumes downstream. ──────────────────
  {
    file: "use-cases/orders/create-checkout.ts",
    reason:
      "Builds `TicketTypeSummary` maps carrying the RAW window bounds; " +
      "`computeOrderAmounts` hands them to `assertTicketTypeOnSale` at the " +
      "order's single `now`. Pre-deciding here would put the decision in two " +
      "places, which is the thing being prevented.",
  },
  {
    file: "use-cases/orders/update-order-items.ts",
    reason: "Same TicketTypeSummary projection as create-checkout.",
  },
  {
    file: "use-cases/orders/claim-free-tickets.ts",
    reason: "Same TicketTypeSummary projection as create-checkout.",
  },
  {
    file: "use-cases/pos/_shared/door-ticket-types.ts",
    reason:
      "Same TicketTypeSummary projection as create-checkout, shared by every " +
      "door path. The tills' window gate goes through " +
      "`assertTicketTypeOnSale` on the raw type, never reads the bounds itself.",
  },

  // ── Admin edit-form projection — the WINDOW half of an existing PRICE ──────
  // ── exemption above. ─────────────────────────────────────────────────────
  {
    file: "use-cases/events/list-event-ticket-types-for-edit.ts",
    reason:
      "Same file, same reasoning as this file's PRICE-axis EXEMPTIONS entry " +
      "above: the raw bounds are bound to the admin edit form's inputs, which " +
      "updateTicketType writes straight back — resolving them here would " +
      "round-trip a decided state into the stored bounds. The two axes were " +
      "reviewed together; only the price one was exempted the first time.",
  },

  // ── Template materialization: the WINDOW half of an existing PRICE ─────────
  // ── exemption above. ─────────────────────────────────────────────────────
  {
    file: "use-cases/ticket-type-templates/apply-ticket-type-template.ts",
    reason:
      "Same file, same reasoning as this file's PRICE-axis EXEMPTIONS entry " +
      "above: `schedule.salesOpenAt`/`salesCloseAt` are materialized template " +
      "config already validated by `materializeTemplateEntrySchedule` (open<close, " +
      "not-already-elapsed, unresolvable-drops-the-window) and re-checked by " +
      "`upsertTicketType` at the write boundary — this is the write, not a " +
      "sale decision. The two axes were reviewed together; only the price one " +
      "was exempted the first time.",
  },
  // ── Structured-data history: a reported date, not a sale decision. ────────
  {
    file: "use-cases/events/_shared/offers-valid-from.ts",
    reason:
      "`offersValidFrom` reports WHEN sales opened as schema.org " +
      "`Offer.validFrom` for search engines; it decides nothing about whether " +
      "a tier may be sold now. The shared predicate cannot answer it: " +
      "`resolveTicketTypeSaleState` yields `opensAt` only while a tier is " +
      "still `not_yet_on_sale`, never the past opening of a tier already on " +
      "sale. The module reads only `salesOpenAt`, takes no `now`, and is split " +
      "out of build-event-seo.ts so that file stays under this guard.",
  },
];

function findExemption(
  relPath: string,
  list: Exemption[],
): Exemption | undefined {
  return list.find((e) => relPath === e.file || relPath.startsWith(e.file));
}

function isExempt(relPath: string): Exemption | undefined {
  return findExemption(relPath, EXEMPTIONS);
}

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      collectTsFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    acc.push(full);
  }
  return acc;
}

function scanFor(
  matches: (line: string) => boolean,
  exemptions: Exemption[],
): Array<{
  file: string;
  line: number;
  text: string;
}> {
  const hits: Array<{ file: string; line: number; text: string }> = [];

  for (const dirName of ["use-cases", "lib"]) {
    const files = collectTsFiles(join(CORE_SRC, dirName));
    for (const file of files) {
      const relPath = relative(CORE_SRC, file).split(sep).join("/");
      if (findExemption(relPath, exemptions)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, index) => {
        // Comments explaining the rule are not violations of it.
        const trimmed = text.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        ) {
          return;
        }
        if (matches(text)) {
          hits.push({ file: relPath, line: index + 1, text: trimmed });
        }
      });
    }
  }

  return hits;
}

/**
 * The exemptions that no longer cover any read. A dead entry is a standing
 * pass for whatever lands in that file next, so it has to go when the read it
 * argued for does (cf902af11 moved the door projection out of two exempt POS
 * files and left both entries behind; nothing noticed).
 */
function deadExemptions(
  matches: (line: string) => boolean,
  exemptions: Exemption[],
): string[] {
  const files = ["use-cases", "lib"].flatMap((dirName) =>
    collectTsFiles(join(CORE_SRC, dirName)).map((file) =>
      relative(CORE_SRC, file).split(sep).join("/"),
    ),
  );
  return exemptions
    .filter((e) => {
      const covered = files.filter(
        (relPath) => relPath === e.file || relPath.startsWith(e.file),
      );
      return !covered.some((relPath) =>
        readFileSync(join(CORE_SRC, relPath), "utf8")
          .split("\n")
          .some((text) => {
            const trimmed = text.trim();
            if (
              trimmed.startsWith("//") ||
              trimmed.startsWith("*") ||
              trimmed.startsWith("/*")
            ) {
              return false;
            }
            return matches(text);
          }),
      );
    })
    .map((e) => e.file);
}

const scanForDirectReads = () => scanFor(isPriceRead, EXEMPTIONS);
const scanForDirectWindowReads = () =>
  scanFor(isWindowRead, WINDOW_EXEMPTIONS);

describe("FR-004 — no direct TicketType.priceCents reads outside the resolver", () => {
  it("finds no unexempted `.priceCents` read in packages/core", () => {
    const hits = scanForDirectReads();

    // Rendered so a failure names the file, line and code rather than just a
    // count — the difference between a fixable failure and a mysterious one.
    const rendered = hits
      .map((h) => `  ${h.file}:${h.line}\n    ${h.text}`)
      .join("\n");

    expect(
      hits,
      hits.length === 0
        ? ""
        : `Direct TicketType.priceCents read(s) found outside the resolver.\n\n` +
            `${rendered}\n\n` +
            `Route the read through resolveUnitPriceCents(tt, { now }) with ` +
            `\`now\` from the injected ClockPort (FR-003/FR-004). If the read is ` +
            `genuinely correct — a write boundary, a COPY, a historical snapshot, ` +
            `or a different entity — add it to EXEMPTIONS in this file WITH A ` +
            `REASON a reviewer can check.`,
    ).toEqual([]);
  });

  it("scans a non-trivial number of files (the scanner itself still works)", () => {
    // Guards against the failure mode where a path change makes the scan walk
    // nothing and the invariant reports green forever — the "gates that look
    // real and are not" pattern.
    const files = [
      ...collectTsFiles(join(CORE_SRC, "use-cases")),
      ...collectTsFiles(join(CORE_SRC, "lib")),
    ];
    expect(files.length).toBeGreaterThan(200);
  });

  it("catches a MEMBER-ACCESS read (the matcher is not vacuous)", () => {
    expect(isPriceRead("const x = ticketType.priceCents;")).toBe(true);
    expect(isPriceRead("      unitPriceCents: tt.priceCents,")).toBe(true);
  });

  it("catches a DESTRUCTURED read", () => {
    // No destructure of priceCents exists in core today, so this shape is
    // airtight in FACT but was not airtight by CONSTRUCTION until this pattern
    // was added. Each shape gets its own assertion so removing one can't rot
    // silently behind the others.
    expect(isPriceRead("  const { priceCents } = ticketType;")).toBe(true);
    expect(isPriceRead("  const { priceCents: p } = tt;")).toBe(true);
    expect(isPriceRead("  const { id, priceCents, capacity } = tt;")).toBe(
      true,
    );
  });

  it("catches an INDEX-ACCESS read", () => {
    expect(isPriceRead('const x = tt["priceCents"];')).toBe(true);
    expect(isPriceRead("const x = tt['priceCents'];")).toBe(true);
  });

  it("does NOT flag property definitions, schema fields or sibling columns", () => {
    // Writes and contracts, not reads. Flagging them is how invariant tests
    // become noise and then get deleted.
    expect(isPriceRead("  priceCents: z.number().int(),")).toBe(false);
    expect(isPriceRead("      priceCents: effectivePriceCents,")).toBe(false);
    expect(isPriceRead("  priceCents: number;")).toBe(false);

    // Sibling columns are resolver INPUTS, not bypasses.
    expect(isPriceRead("summary.lowestPriceCents ?? null")).toBe(false);
    expect(isPriceRead("tt.scheduledPriceCents ?? null")).toBe(false);
    expect(isPriceRead("tt.resaleCapCents")).toBe(false);
    expect(isPriceRead("entry.unitPriceCents")).toBe(false);
    expect(isPriceRead("  const { scheduledPriceCents } = tt;")).toBe(false);
  });

  it("documents the shape it CANNOT catch, so nobody trusts it too far", () => {
    // A spread carries `priceCents` into an output payload without ever naming
    // it. No regex reaches this; the defence is `.strict()` output schemas that
    // reject the extra key at runtime. Asserted so the limitation is executable
    // documentation rather than a comment nobody reads.
    expect(isPriceRead("  return { ...ticketType, name: tt.name };")).toBe(
      false,
    );
  });

  it("every exemption carries a reason", () => {
    for (const exemption of EXEMPTIONS) {
      expect(
        exemption.reason.length,
        `missing reason: ${exemption.file}`,
      ).toBeGreaterThan(40);
    }
  });
});

describe("FR-014 — no direct sales-window reads outside the shared predicate", () => {
  it("finds no unexempted `.salesOpenAt` / `.salesCloseAt` read in packages/core", () => {
    const hits = scanForDirectWindowReads();

    const rendered = hits
      .map((h) => `  ${h.file}:${h.line}\n    ${h.text}`)
      .join("\n");

    expect(
      hits,
      hits.length === 0
        ? ""
        : `Direct TicketType sales-window read(s) found outside the shared ` +
            `predicate.\n\n${rendered}\n\n` +
            `Route the decision through assertTicketTypeOnSale(tt, now) (to ` +
            `refuse a purchase) or resolveTicketTypeSaleState(tt, now) (to ` +
            `describe one), with \`now\` from the injected ClockPort. A ` +
            `hand-rolled comparison WILL get the boundary wrong: salesOpenAt ` +
            `is INCLUSIVE and salesCloseAt is EXCLUSIVE. If the read is ` +
            `genuinely correct — a write boundary, a COPY, or a projection the ` +
            `predicate consumes downstream — add it to WINDOW_EXEMPTIONS in ` +
            `this file WITH A REASON a reviewer can check.`,
    ).toEqual([]);
  });

  it("catches a MEMBER-ACCESS read (the matcher is not vacuous)", () => {
    expect(isWindowRead("if (now >= tt.salesCloseAt) return;")).toBe(true);
    expect(isWindowRead("  const opens = ticketType.salesOpenAt;")).toBe(true);
  });

  it("catches a DESTRUCTURED read", () => {
    expect(isWindowRead("  const { salesCloseAt } = tt;")).toBe(true);
    expect(isWindowRead("  const { salesOpenAt: o } = ticketType;")).toBe(true);
    expect(isWindowRead("  const { id, salesCloseAt, capacity } = tt;")).toBe(
      true,
    );
  });

  it("catches an INDEX-ACCESS read", () => {
    expect(isWindowRead('const x = tt["salesCloseAt"];')).toBe(true);
    expect(isWindowRead("const x = tt['salesOpenAt'];")).toBe(true);
  });

  it("does NOT flag property definitions or schema fields", () => {
    expect(isWindowRead("  salesOpenAt: z.coerce.date().nullable(),")).toBe(
      false,
    );
    expect(isWindowRead("      salesCloseAt: null,")).toBe(false);
    expect(isWindowRead("  salesOpenAt: Date | null;")).toBe(false);
  });

  it("does NOT flag the EVENT-level close, which is a different fact", () => {
    // `ensureEventOnSale` and its three siblings compute a LOCAL `salesCloseAt`
    // from the event's own end. Flagging that would make this scanner noise —
    // and noisy invariant tests get deleted rather than fixed.
    expect(
      isWindowRead("  const salesCloseAt = event.endsAt ?? event.startsAt;"),
    ).toBe(false);
    expect(
      isWindowRead("  if (salesCloseAt && now.getTime() >= salesCloseAt.getTime()) {"),
    ).toBe(false);
  });

  it("every window exemption carries a reason", () => {
    for (const exemption of WINDOW_EXEMPTIONS) {
      expect(
        exemption.reason.length,
        `missing reason: ${exemption.file}`,
      ).toBeGreaterThan(40);
    }
  });
});

describe("every exemption still covers a real read", () => {
  it("has no dead PRICE exemptions", () => {
    expect(
      deadExemptions(isPriceRead, EXEMPTIONS),
      "These EXEMPTIONS entries match no `.priceCents` read any more. Remove " +
        "them, or move them to the file the read went to (with its reason).",
    ).toEqual([]);
  });

  it("has no dead WINDOW exemptions", () => {
    expect(
      deadExemptions(isWindowRead, WINDOW_EXEMPTIONS),
      "These WINDOW_EXEMPTIONS entries match no `.salesOpenAt` / " +
        "`.salesCloseAt` read any more. Remove them, or move them to the file " +
        "the read went to (with its reason).",
    ).toEqual([]);
  });

  it("flags an exemption whose file has no read (the check is not vacuous)", () => {
    expect(
      deadExemptions(isPriceRead, [
        { file: "lib/orders/__no_such_file__.ts", reason: "probe" },
      ]),
    ).toEqual(["lib/orders/__no_such_file__.ts"]);
    // A file that EXISTS but holds no read is the case that matters: it is
    // what an exemption becomes when its read moves elsewhere.
    expect(
      deadExemptions(isPriceRead, [
        { file: "lib/location/place-event-location.ts", reason: "probe" },
      ]),
    ).toEqual(["lib/location/place-event-location.ts"]);
    // And a live exemption is NOT flagged.
    expect(
      deadExemptions(isPriceRead, [
        { file: "lib/orders/door-pricing.ts", reason: "probe" },
      ]),
    ).toEqual([]);
  });
});
