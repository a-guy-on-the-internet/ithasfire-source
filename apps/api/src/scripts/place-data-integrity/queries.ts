/**
 * place-data-integrity/queries.ts — READ-ONLY detection for two Place defects.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THIS FILE CONTAINS NO WRITES. It is imported by BOTH the read-only      ║
 * ║  `detect.ts` CLI and the `repair.ts` CLI. `detect.ts` imports ONLY this  ║
 * ║  module, so running detection never loads a single line of write code.   ║
 * ║  Keep it that way: any `create` / `update` / `delete` / `$executeRaw`    ║
 * ║  belongs in `repair.ts`.                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── Defect 1: places permanently locked out at PENDING ──────────────────────
 * `withdrawPlaceVerification` used to update the PlaceVerificationRequest row
 * and write an audit entry but NEVER reset `Place.verification`. That is fixed
 * forward (the use case now resets to UNVERIFIED inside `repos.tx()`), but the
 * fix does not repair rows already stranded.
 *
 * It is a lockout, not cosmetic: EVERY "request verification" affordance gates
 * on `verificationStatus === "UNVERIFIED" || "REJECTED"` —
 *   apps/web/src/app/admin/[slug]/places/[placeId]/edit/page.tsx
 *   apps/web/src/app/admin/[slug]/places/[placeId]/verify/_components/VerificationSection.tsx
 *   apps/web/src/app/admin/[slug]/places/_components/PlacesTable.tsx
 * — so a place sitting at PENDING with no open request shows the organiser a
 * permanently "Pending" venue with no request button anywhere, and puts nothing
 * in the platform review queue, while the server would happily accept a
 * resubmit. The organiser cannot self-recover.
 *
 * DETECTION: Place.verification = PENDING AND the place has NO
 * PlaceVerificationRequest whose status is PENDING or IN_REVIEW.
 * (APPROVED / REJECTED / WITHDRAWN are all closed — a closed request leaves
 * nothing for a reviewer to act on and nothing to un-stick the place.)
 *
 * ── Defect 2: the "TBD" sentinel in street addresses ────────────────────────
 * The place editor used to persist the literal string "TBD" as a venue's street
 * address (`line1: addressLine1 || "TBD"`) because `upsertPlace`'s
 * `addressSchema` required a non-empty `line1`. That is fixed forward (`line1`
 * is optional now — see the comment on `addressSchema` in
 * packages/core/src/use-cases/places/upsert-place.ts), but historical rows may
 * still carry it. It leaked to users: PlaceMobileCard.tsx already filters
 * `addressLine1 !== "TBD"` defensively.
 *
 * DETECTION: Place.addrLine1 contains "TBD" OR Place.address contains "TBD"
 * (case-SENSITIVE — Prisma's `contains` on Postgres is case-sensitive without
 * `mode: "insensitive"`, which is what we want for an exact sentinel). The
 * query is deliberately a SUPERSET of the reported defect; `planAddressRepair`
 * below then classifies each row precisely, and anything that is not provably
 * safe to rewrite is reported rather than repaired.
 */

import type { PrismaClient } from "@prisma/client";

/** The literal sentinel the old place editor forged. Case-sensitive. */
export const SENTINEL = "TBD";

/**
 * Request statuses that count as "open" — i.e. a real reviewer obligation
 * exists and the place is legitimately PENDING. Everything else
 * (APPROVED / REJECTED / WITHDRAWN) is closed.
 */
export const OPEN_REQUEST_STATUSES = ["PENDING", "IN_REVIEW"] as const;

export type VerificationRequestSummary = {
  id: string;
  status: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PendingLockoutRow = {
  id: string;
  slug: string | null;
  name: string;
  verification: string;
  city: string | null;
  region: string | null;
  updatedAt: Date;
  /** Full request history, for the operator to eyeball before applying. */
  requests: VerificationRequestSummary[];
};

export type AddressSentinelRow = {
  id: string;
  slug: string | null;
  name: string;
  address: string;
  addrLine1: string | null;
  addrLine2: string | null;
  addressHash: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  updatedAt: Date;
};

export type Line1Action = "none" | "clear" | "report-only";
export type AddressAction =
  | "none"
  | "strip-segments"
  | "rebuild-from-components"
  | "report-only";

export type AddressRepairPlan = {
  line1Action: Line1Action;
  /** Only set when line1Action === "clear". Always `null` (the column is `String?`). */
  proposedAddrLine1?: null;
  line1Reason?: string;

  addressAction: AddressAction;
  /** Only set when addressAction is an auto-repair. NEVER empty — `Place.address` is NOT NULL. */
  proposedAddress?: string;
  /** Mirrors the adapter: `addressHash = formatted.toLowerCase()`. */
  proposedAddressHash?: string;
  addressReason?: string;
};

/** True when the plan would write anything at all. */
export function planWritesAnything(plan: AddressRepairPlan): boolean {
  return (
    plan.line1Action === "clear" ||
    plan.addressAction === "strip-segments" ||
    plan.addressAction === "rebuild-from-components"
  );
}

/** True when the plan needs a human rather than the script. */
export function planNeedsHuman(plan: AddressRepairPlan): boolean {
  return (
    plan.line1Action === "report-only" || plan.addressAction === "report-only"
  );
}

/**
 * Decide, for ONE row, what (if anything) is provably safe to rewrite.
 *
 * Pure: no I/O, no clock, no randomness. Same row in → same plan out, which is
 * what lets `repair.ts` re-plan inside the transaction and refuse to write
 * anything that differs from what the operator reviewed in the dry run.
 *
 * ── `addrLine1` — auto-repaired ─────────────────────────────────────────────
 * Cleared to NULL when it trims to exactly "TBD". Unambiguous: "TBD" is never a
 * real street line, the column is nullable, and 10 of the 11 seeded dev places
 * already sit at NULL. Nothing downstream derives from `addrLine1` — the
 * dedup hash comes from `address`, the tax cache from postcode/country, the
 * timezone from lat/lng.
 * If it merely CONTAINS the sentinel ("TBD Main St"), it is report-only: that
 * could be a real street we must not silently truncate.
 *
 * ── `address` — mostly auto-repaired, conservatively ────────────────────────
 * `Place.address` is a legacy freeform NOT NULL column and `addressHash` is
 * derived from it (`formatted.toLowerCase()` in the Prisma places adapter), so
 * a wrong bulk rewrite is worse than leaving a "TBD". Two — and only two —
 * rewrites are provably information-preserving:
 *
 *   1. "strip-segments": split on ",", drop ONLY whole segments that trim to
 *      exactly "TBD", rejoin. Every surviving segment is preserved verbatim;
 *      the only thing that can be lost is the sentinel itself. Requires a
 *      non-empty remainder.
 *   2. "rebuild-from-components": fires ONLY when step 1 leaves nothing, i.e.
 *      the stored string was exclusively sentinel/empty segments and therefore
 *      carries ZERO information — nothing can be lost. The replacement is
 *      composed from the row's own structured columns in the EXACT part order
 *      the place editor uses (line1, city, region, postcode, country joined
 *      with ", " — see the `rebuiltAddress` block in
 *      apps/web/src/app/admin/[slug]/places/[placeId]/edit/page.tsx), so the
 *      value matches what the next real save would have produced anyway.
 *
 * Everything else is REPORT-ONLY:
 *   - a segment that contains but does not equal the sentinel ("TBD Lane",
 *     "Suite TBD") — stripping it would delete real text;
 *   - a row where stripping leaves nothing AND every structured column is
 *     empty — there is nothing to rebuild from, and we refuse to write "" (or
 *     invent a value): `Place.address` is NOT NULL and the domain invariant is
 *     `formatted: z.string().trim().min(1)` in upsert-place's addressSchema, so
 *     an empty string would be a state the product itself cannot produce.
 *
 * SIDE EFFECT of any `address` rewrite: `addressHash` changes, and `upsertPlace`
 * gates its ZipTax + timezone re-lookup on `existingPlace.addressHash !==
 * finalRecord.addressHash`. So the NEXT ordinary save of a repaired place
 * re-fires those lookups once. Harmless — postcode/country/lat/lng are NOT
 * touched here, so both recompute to the same values — but it costs one extra
 * provider call per repaired place. `--report-only-addresses` opts out of every
 * address write entirely.
 */
export function planAddressRepair(row: AddressSentinelRow): AddressRepairPlan {
  const plan: AddressRepairPlan = {
    line1Action: "none",
    addressAction: "none",
  };

  // ── addrLine1 ─────────────────────────────────────────────────────────────
  const line1 = row.addrLine1;
  if (line1 !== null && line1.includes(SENTINEL)) {
    if (line1.trim() === SENTINEL) {
      plan.line1Action = "clear";
      plan.proposedAddrLine1 = null;
    } else {
      plan.line1Action = "report-only";
      plan.line1Reason =
        `addrLine1 contains "${SENTINEL}" but does not equal it (${JSON.stringify(line1)}) — ` +
        `it may be a real street. Fix by hand in the venue editor.`;
    }
  }

  // ── address ───────────────────────────────────────────────────────────────
  if (!row.address.includes(SENTINEL)) return plan;

  const kept = row.address
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== SENTINEL);

  const residual = kept.find((segment) => segment.includes(SENTINEL));
  if (residual !== undefined) {
    plan.addressAction = "report-only";
    plan.addressReason =
      `address segment ${JSON.stringify(residual)} contains "${SENTINEL}" but does not equal it — ` +
      `dropping it could delete a real address part. Fix by hand in the venue editor.`;
    return plan;
  }

  if (kept.length > 0) {
    plan.addressAction = "strip-segments";
    plan.proposedAddress = kept.join(", ");
  } else {
    // The stored formatted address was nothing but the sentinel, so there is
    // no information to preserve. Rebuild from the structured columns in the
    // place editor's exact part order.
    const line1ForRebuild = plan.line1Action === "clear" ? null : row.addrLine1;
    const rebuilt = [
      line1ForRebuild,
      row.city,
      row.region,
      row.postcode,
      row.country,
    ]
      .map((part) => (part ?? "").trim())
      .filter((part) => part.length > 0 && !part.includes(SENTINEL))
      .join(", ");

    if (rebuilt.length > 0) {
      plan.addressAction = "rebuild-from-components";
      plan.proposedAddress = rebuilt;
    } else {
      plan.addressAction = "report-only";
      plan.addressReason =
        `address is only "${SENTINEL}" and every structured column (line1/city/region/postcode/country) ` +
        `is empty — there is nothing to rebuild from. Place.address is NOT NULL and upsert-place requires ` +
        `formatted.min(1), so writing "" would be a state the product cannot produce. Set a real address ` +
        `in the venue editor.`;
      return plan;
    }
  }

  plan.proposedAddressHash = plan.proposedAddress?.toLowerCase();
  return plan;
}

const PENDING_LOCKOUT_SELECT = {
  id: true,
  slug: true,
  name: true,
  verification: true,
  city: true,
  region: true,
  updatedAt: true,
  verificationRequests: {
    select: {
      id: true,
      status: true,
      source: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  },
} as const;

const ADDRESS_SENTINEL_SELECT = {
  id: true,
  slug: true,
  name: true,
  address: true,
  addrLine1: true,
  addrLine2: true,
  addressHash: true,
  city: true,
  region: true,
  postcode: true,
  country: true,
  updatedAt: true,
} as const;

/**
 * Minimal structural type for the Prisma surface these queries need. Accepting
 * this (rather than `PrismaClient`) is what lets `repair.ts` hand in the
 * INTERACTIVE TRANSACTION client and re-run the exact same detection inside the
 * transaction before writing.
 */
export type PlaceReader = Pick<PrismaClient, "place">;

/** Defect 1 — read-only. */
export async function detectPendingLockouts(
  db: PlaceReader,
): Promise<PendingLockoutRow[]> {
  const rows = await db.place.findMany({
    where: {
      verification: "PENDING",
      verificationRequests: {
        none: { status: { in: [...OPEN_REQUEST_STATUSES] } },
      },
    },
    select: PENDING_LOCKOUT_SELECT,
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    verification: row.verification,
    city: row.city,
    region: row.region,
    updatedAt: row.updatedAt,
    requests: row.verificationRequests.map((request) => ({
      id: request.id,
      status: request.status,
      source: request.source,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    })),
  }));
}

/** Defect 2 — read-only. Superset query; `planAddressRepair` classifies. */
export async function detectAddressSentinels(
  db: PlaceReader,
): Promise<AddressSentinelRow[]> {
  const rows = await db.place.findMany({
    where: {
      OR: [
        { addrLine1: { contains: SENTINEL } },
        { address: { contains: SENTINEL } },
      ],
    },
    select: ADDRESS_SENTINEL_SELECT,
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({ ...row }));
}

export type IntegrityReport = {
  pendingLockouts: PendingLockoutRow[];
  addressSentinels: { row: AddressSentinelRow; plan: AddressRepairPlan }[];
};

export async function detectAll(db: PlaceReader): Promise<IntegrityReport> {
  const [pendingLockouts, sentinelRows] = await Promise.all([
    detectPendingLockouts(db),
    detectAddressSentinels(db),
  ]);
  return {
    pendingLockouts,
    addressSentinels: sentinelRows.map((row) => ({
      row,
      plan: planAddressRepair(row),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation — shared by both CLIs so the dry run and the real run print
// byte-identical row detail.
// ─────────────────────────────────────────────────────────────────────────────

const show = (value: string | null | undefined): string =>
  value === null || value === undefined ? "(null)" : JSON.stringify(value);

const label = (row: {
  id: string;
  slug: string | null;
  name: string;
}): string =>
  `${row.id}  slug=${row.slug ?? "(null)"}  name=${JSON.stringify(row.name)}`;

export function printTargetBanner(
  scriptName: string,
  mode: string,
): {
  hostname: string;
  database: string;
} {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL must be set explicitly. This script never loads a .env file — " +
        "apps/api/.env points at a CLOUD Neon database and .env.local wins over it, so an " +
        "implicit target is exactly the mistake we refuse to make. Pass it on the command line.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL.");
  }
  const hostname = url.hostname;
  const database = url.pathname.replace(/^\//, "") || "(default)";
  const port = url.port || "5432";
  const user = url.username || "(none)";
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";

  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${scriptName}`);
  console.log(`  MODE:     ${mode}`);
  console.log(
    `  HOST:     ${hostname}:${port}${isLocal ? "  (local)" : "  ** NOT LOCAL **"}`,
  );
  console.log(`  DATABASE: ${database}`);
  console.log(`  USER:     ${user}`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("");

  return { hostname, database };
}

export function printPendingLockouts(rows: PendingLockoutRow[]): void {
  console.log(
    `## Defect 1 — places stranded at PENDING with no open verification request`,
  );
  console.log(
    `   detection: Place.verification = 'PENDING' AND no PlaceVerificationRequest ` +
      `with status in (${OPEN_REQUEST_STATUSES.join(", ")})`,
  );
  console.log(`   found: ${rows.length}`);
  console.log("");
  for (const row of rows) {
    console.log(`  • ${label(row)}`);
    console.log(
      `      location:  ${show(row.city)}, ${show(row.region)}   updatedAt=${row.updatedAt.toISOString()}`,
    );
    console.log(`      current:   verification = PENDING`);
    console.log(`      proposed:  verification = UNVERIFIED`);
    if (row.requests.length === 0) {
      console.log(`      requests:  (none ever)`);
    } else {
      console.log(`      requests:  ${row.requests.length} (all closed)`);
      for (const request of row.requests) {
        console.log(
          `        - ${request.id}  status=${request.status}  source=${request.source}  ` +
            `created=${request.createdAt.toISOString()}  updated=${request.updatedAt.toISOString()}`,
        );
      }
    }
    console.log("");
  }
  if (rows.length === 0) console.log("  (none)\n");
}

export function printAddressSentinels(
  entries: { row: AddressSentinelRow; plan: AddressRepairPlan }[],
): void {
  const repairable = entries.filter((entry) => planWritesAnything(entry.plan));
  const reportOnly = entries.filter((entry) => planNeedsHuman(entry.plan));

  console.log(`## Defect 2 — the "${SENTINEL}" sentinel in street addresses`);
  console.log(
    `   detection: Place.addrLine1 LIKE '%${SENTINEL}%' OR Place.address LIKE '%${SENTINEL}%' (case-sensitive)`,
  );
  console.log(
    `   found: ${entries.length}   auto-repairable: ${repairable.length}   report-only: ${reportOnly.length}`,
  );
  console.log("");

  for (const { row, plan } of entries) {
    console.log(`  • ${label(row)}`);
    console.log(
      `      current:   address=${show(row.address)}  addrLine1=${show(row.addrLine1)}  addressHash=${show(row.addressHash)}`,
    );
    console.log(
      `      structured: line2=${show(row.addrLine2)} city=${show(row.city)} region=${show(row.region)} ` +
        `postcode=${show(row.postcode)} country=${show(row.country)}`,
    );
    console.log(`      updatedAt: ${row.updatedAt.toISOString()}`);

    if (plan.line1Action === "clear") {
      console.log(
        `      proposed:  addrLine1 ${show(row.addrLine1)} -> (null)`,
      );
    } else if (plan.line1Action === "report-only") {
      console.log(`      REPORT-ONLY (addrLine1): ${plan.line1Reason}`);
    }

    if (
      plan.addressAction === "strip-segments" ||
      plan.addressAction === "rebuild-from-components"
    ) {
      console.log(
        `      proposed:  address ${show(row.address)} -> ${show(plan.proposedAddress)}   [${plan.addressAction}]`,
      );
      console.log(
        `      proposed:  addressHash ${show(row.addressHash)} -> ${show(plan.proposedAddressHash)}`,
      );
    } else if (plan.addressAction === "report-only") {
      console.log(`      REPORT-ONLY (address): ${plan.addressReason}`);
    }

    if (!planWritesAnything(plan) && !planNeedsHuman(plan)) {
      console.log(
        `      proposed:  (nothing — matched the query but is clean)`,
      );
    }
    console.log("");
  }
  if (entries.length === 0) console.log("  (none)\n");
}

export function printSummary(report: IntegrityReport): {
  totalFindings: number;
  autoRepairable: number;
  reportOnly: number;
} {
  const autoRepairableAddresses = report.addressSentinels.filter((entry) =>
    planWritesAnything(entry.plan),
  ).length;
  const reportOnlyAddresses = report.addressSentinels.filter((entry) =>
    planNeedsHuman(entry.plan),
  ).length;
  const noopAddresses =
    report.addressSentinels.length -
    autoRepairableAddresses -
    reportOnlyAddresses;

  const totalFindings =
    report.pendingLockouts.length +
    autoRepairableAddresses +
    reportOnlyAddresses;

  console.log("## Summary");
  console.log(
    `  defect 1 — stranded PENDING places:        ${report.pendingLockouts.length}  (all auto-repairable)`,
  );
  console.log(
    `  defect 2 — rows matching the sentinel:     ${report.addressSentinels.length}`,
  );
  console.log(
    `               auto-repairable:              ${autoRepairableAddresses}`,
  );
  console.log(
    `               report-only (needs a human):  ${reportOnlyAddresses}`,
  );
  console.log(`               false positives (clean):      ${noopAddresses}`);
  console.log(`  TOTAL findings:                            ${totalFindings}`);
  console.log("");

  return {
    totalFindings,
    autoRepairable: report.pendingLockouts.length + autoRepairableAddresses,
    reportOnly: reportOnlyAddresses,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing — STRICT. `pnpm run <script> -- <flags>` silently swallows args
// in this repo (see CLAUDE.md "Gates That Look Real And Are Not"), and a typo'd
// flag that runs green is exactly how a "dry run" becomes an unreviewed write.
// Unknown args are a hard error.
// ─────────────────────────────────────────────────────────────────────────────

export function parseArgs(
  argv: string[],
  known: { flags: readonly string[]; options?: readonly string[] },
): { flags: Set<string>; options: Map<string, string> } {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const knownOptions = known.options ?? [];

  for (const arg of argv) {
    if (known.flags.includes(arg)) {
      flags.add(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      const name = arg.slice(0, eq);
      if (knownOptions.includes(name)) {
        options.set(name, arg.slice(eq + 1));
        continue;
      }
    }
    throw new Error(
      `Unrecognised argument ${JSON.stringify(arg)}. Known flags: ` +
        `${[...known.flags, ...knownOptions.map((o) => `${o}=<value>`)].join(" ")}`,
    );
  }

  return { flags, options };
}
