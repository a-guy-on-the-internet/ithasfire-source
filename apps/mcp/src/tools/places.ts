import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { trpcQuery, trpcMutation } from "../client.js";

const PLACE_STATUS = ["ACTIVE", "ARCHIVED"] as const;
const VERIFICATION_STATUS = [
  "UNVERIFIED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "FLAGGED",
] as const;

/** Trim, then treat the empty string as absent. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Server-side bounds from `placeRowSchema` (packages/core/.../bulk-import-places.ts). */
const MAX_FORMATTED = 280;
const MAX_LINE1 = 160;
const MAX_WEBSITE = 500;
const MAX_CAPACITY = 200_000;

/**
 * A scrape's most common website shape is a bare domain (`"exitin.com"`), which
 * fails the server's `.url()` bound. Add the scheme, then DROP the field if it
 * still is not a plain http(s) URL.
 *
 * Dropping beats failing: `parseInput` throws on the FIRST bad row, so one junk
 * website would otherwise discard the entire ≤500-row batch. A venue with no
 * website is a fine venue. Non-http(s) schemes are dropped rather than passed
 * through — `Place.website` is rendered as a link and feeds the claim
 * email-domain check, so a `javascript:` or `data:` value has no business there.
 */
function normalizeWebsite(raw: string | undefined): string | undefined {
  const v = value(raw);
  if (!v) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  if (candidate.length > MAX_WEBSITE) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // `href`, not `candidate`: it normalises the shapes a scrape produces —
    // `"//venue.com"` (which would otherwise persist as `https:////venue.com`)
    // and mixed-case hosts.
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Drop a capacity the server would reject (`.positive().max(200_000)`) instead
 * of failing the row. An LLM writing `capacity: 0` for "unknown" is expected,
 * and "unknown capacity" is exactly `undefined`.
 */
function normalizeCapacity(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw <= 0 || raw > MAX_CAPACITY) return undefined;
  return raw;
}

interface ImportPlaceToolRow {
  name: string;
  formattedAddress?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  capacity?: number;
  website?: string;
  phone?: string;
}

/**
 * Reshape one flat tool-input row into the row `bulkImportPlacesInputSchema`
 * expects (a NESTED `address` object). The tool used to pass its flat rows
 * straight through, so every call failed Zod validation server-side.
 *
 * `formatted` and `countryCode` are both required server-side, and the
 * fallbacks here mirror `apps/web/src/lib/place-csv-address.ts`
 * (`buildPlaceCsvAddress`) exactly so the MCP importer and the platform CSV
 * importer agree on what a partial address turns into.
 */
function toBulkImportRow(row: ImportPlaceToolRow) {
  const formattedAddress = value(row.formattedAddress);
  const line1 = value(row.addressLine1);
  const city = value(row.city);
  const region = value(row.region);
  const postalCode = value(row.postalCode);
  const countryCode = value(row.countryCode)?.toUpperCase() ?? "US";

  // Same parts, same order as `buildPlaceCsvAddress`. `countryCode` always
  // survives the filter, so this is never the empty string — which matters
  // because `formatted` carries a `min(1)` bound on the server. The row schema
  // additionally requires one of formattedAddress / addressLine1 / city, so
  // this can never floor at a bare `"US"` (the `"TBD"`-sentinel failure mode).
  const rebuilt = [line1, city, region, postalCode, countryCode]
    .filter(Boolean)
    .join(", ");

  // `line1` inherits `formattedAddress` when there is no separate street line.
  // A real `addressLine1` is truncated to the server's 160 cap, but an INHERITED
  // full address is DROPPED instead: `line1` is optional server-side, and a
  // 200-char address cut mid-token would persist to `Place.addrLine1` and render
  // as the venue's street — the "TBD"-sentinel failure mode in another costume.
  // Nothing is lost; `formatted` still carries the whole string.
  const resolvedLine1 =
    line1?.slice(0, MAX_LINE1) ??
    (formattedAddress && formattedAddress.length <= MAX_LINE1
      ? formattedAddress
      : undefined);

  return {
    name: row.name,
    address: {
      formatted: (formattedAddress ?? line1 ?? rebuilt).slice(0, MAX_FORMATTED),
      line1: resolvedLine1,
      line2: value(row.addressLine2),
      city,
      region,
      postalCode,
      countryCode,
      lat: row.latitude,
      lng: row.longitude,
    },
    capacity: normalizeCapacity(row.capacity),
    website: normalizeWebsite(row.website),
    phone: value(row.phone),
    // Matches the platform CSV importer: imported venues are directory-listed
    // and UNOWNED (no `owner`), so they stay claimable by their real operator.
    //
    // NOTE the two fields deliberately absent: `owner` (an import must not mint
    // a verified owner) and `websiteSource` (omitted ⇒ `UNKNOWN`, so a scrape
    // can never declare itself TRUSTED_IMPORT and arm the FR-010 claim
    // fast-track). Neither belongs in this tool's public input schema.
    listedInDirectory: true,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

export function registerPlacesTools(server: McpServer): void {
  // ── list_places ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_places",
    {
      title: "List Places",
      description:
        "Paginated list of all places on the platform. Requires ADMIN or REVIEWER staff role.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("Results per page (max 100)"),
        offset: z.number().int().min(0).default(0).describe("Skip N results"),
        query: z.string().optional().describe("Search by name or city"),
        status: z
          .array(z.enum(PLACE_STATUS))
          .optional()
          .describe("Filter by status: ACTIVE | ARCHIVED"),
        verificationStatus: z
          .array(z.enum(VERIFICATION_STATUS))
          .optional()
          .describe("Filter by verification status"),
      }),
    },
    async (input) => {
      const data = await trpcQuery("platform.listPlaces", input);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  // ── import_places ────────────────────────────────────────────────────────

  server.registerTool(
    "import_places",
    {
      title: "Import Places (bulk)",
      description:
        "Bulk-import place records. Accepts an array of place objects. Automatically batches into ≤500 per request. Imported places are UNOWNED, so they stay claimable by their real operator. Returns total created count.",
      // Only fields `bulkImportPlaces` actually accepts. Anything else would be
      // advertised here and then silently dropped on the way to the server.
      inputSchema: z.object({
        places: z
          .array(
            z
              .object({
                // Bounds mirror the server's `placeRowSchema`. They are not
                // decoration: `parseInput` throws on the FIRST bad row, so a
                // single over-long field discards the whole ≤500-row batch.
                // Catching it here names the offending field to the caller.
                // `.trim()` before the bound, matching the server: it sanitises
                // first, so `" a"` would pass a bare `min(2)` here and still be
                // rejected there — costing the batch the local check exists to
                // save.
                name: z.string().trim().min(2).max(140).describe("Place name"),
                formattedAddress: z.string().max(280).optional(),
                addressLine1: z.string().max(160).optional(),
                addressLine2: z.string().max(160).optional(),
                city: z.string().max(120).optional(),
                region: z.string().max(120).optional(),
                postalCode: z.string().max(32).optional(),
                countryCode: z
                  .string()
                  .trim()
                  .length(2)
                  .optional()
                  .describe("ISO 3166-1 alpha-2; defaults to US"),
                latitude: z.number().gte(-90).lte(90).optional(),
                longitude: z.number().gte(-180).lte(180).optional(),
                // Out-of-range capacity and unparseable websites are NORMALISED
                // away rather than rejected (see toBulkImportRow) — a bad
                // capacity must not cost you the venue.
                capacity: z.number().int().optional(),
                website: z
                  .string()
                  .optional()
                  .describe("Bare domains are accepted; https:// is added"),
                phone: z.string().max(40).optional(),
              })
              // `Place.address` is NOT NULL and renders publicly. Without this,
              // a name-only row persists with address "US" — a rerun of the
              // "TBD" sentinel that place-csv-address.ts exists to prevent.
              // `value()`, not `??`: an LLM emits `""` for an unknown field far
              // more often than it omits the key, and `""` is not nullish — so
              // `??` returned the empty string and rejected rows that DO carry a
              // city. The SDK safeParses the whole array before the handler
              // runs, so that rejected every row in the call.
              .refine(
                (r) =>
                  Boolean(
                    value(r.formattedAddress) ??
                      value(r.addressLine1) ??
                      value(r.city),
                  ),
                {
                  message:
                    "Each place needs at least one of formattedAddress, addressLine1, or city — a place cannot be imported with no location.",
                },
              ),
          )
          .min(1)
          .describe("Array of place objects to import"),
      }),
    },
    async ({ places }) => {
      const BATCH = 500;
      let totalCreated = 0;

      for (let i = 0; i < places.length; i += BATCH) {
        const batch = places.slice(i, i + BATCH).map(toBulkImportRow);
        try {
          const result = (await trpcMutation("places.bulkImportPlaces", {
            places: batch,
          })) as
            | {
                total: number;
                created: number;
              }
            | undefined;
          // `result?`, not `result.`: the client returns `data?.json`, so an
          // unexpected-but-2xx body would throw a TypeError HERE — after the
          // batch already committed — and land in the catch below, which would
          // then advise re-running rows that are in fact saved.
          totalCreated += result?.created ?? 0;
        } catch (err) {
          // Each batch is its own server-side transaction, so earlier batches
          // are ALREADY COMMITTED when a later one throws. Reporting only
          // "failed" would tell the caller to retry the whole array and
          // duplicate every venue in batches 1..n-1 — say what landed and
          // exactly where it stopped.
          // Only claim prior rows landed when some actually did — on a
          // first-batch failure nothing is saved and a "rows before 1 are
          // saved" line would send the caller chasing a phantom partial write.
          // The failing batch's own fate is UNKNOWN. A rejected request never
          // committed, but a connection that died after the server committed
          // looks identical from here — and `Place` has no unique constraint on
          // name or address (only `slug`, which bulkCreate does not write), so
          // nothing catches a duplicate re-run. Say so rather than assert it.
          const failedRange = `${i + 1}-${Math.min(i + BATCH, places.length)}`;
          const resume =
            totalCreated > 0
              ? ` Rows 1-${i} are ALREADY SAVED. Rows ${failedRange} MAY OR MAY NOT have saved — check with list_places before re-running that range, and do not re-run rows 1-${i}.`
              : ` Rows ${failedRange} MAY OR MAY NOT have saved — check with list_places before re-running.`;
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Imported ${totalCreated} of ${places.length} places, then STOPPED. The batch starting at row ${i + 1} failed: ${describeError(err)}.${resume}`,
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Imported ${totalCreated} out of ${places.length} places.`,
          },
        ],
      };
    },
  );

  // ── delete_places ─────────────────────────────────────────────────────────

  server.registerTool(
    "delete_places",
    {
      title: "Delete Places (bulk) ⚠ destructive",
      description:
        "⚠ DESTRUCTIVE — permanently deletes places by ID. Requires ADMIN or REVIEWER role. Always confirm with the user before calling.",
      inputSchema: z.object({
        placeIds: z
          .array(z.string().uuid())
          .min(1)
          .describe("Array of place UUIDs to permanently delete"),
      }),
    },
    async (input) => {
      const data = await trpcMutation("platform.adminBulkDeletePlaces", input);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );
}
