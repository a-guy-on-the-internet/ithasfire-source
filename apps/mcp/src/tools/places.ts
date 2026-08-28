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

export function registerPlacesTools(server: McpServer): void {
  // ── list_places ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_places",
    {
      title: "List Places",
      description:
        "Paginated list of all venues / places on the platform. Requires ADMIN or REVIEWER staff role.",
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
        "Bulk-import venue records. Accepts an array of place objects. Automatically batches into ≤500 per request. Returns total imported count.",
      inputSchema: z.object({
        places: z
          .array(
            z.object({
              name: z.string().min(1).describe("Venue name"),
              slug: z.string().optional().describe("URL slug"),
              formattedAddress: z.string().optional(),
              addressLine1: z.string().optional(),
              addressLine2: z.string().optional(),
              city: z.string().optional(),
              region: z.string().optional(),
              postalCode: z.string().optional(),
              countryCode: z
                .string()
                .length(2)
                .optional()
                .describe("ISO 3166-1 alpha-2"),
              latitude: z.number().optional(),
              longitude: z.number().optional(),
              capacity: z.number().int().optional(),
              website: z.string().optional(),
              phone: z.string().optional(),
              email: z.string().optional(),
              ticketmasterVenueId: z.string().optional(),
              googlePlaceId: z.string().optional(),
            }),
          )
          .min(1)
          .describe("Array of venue objects to import"),
      }),
    },
    async ({ places }) => {
      const BATCH = 500;
      let totalImported = 0;
      for (let i = 0; i < places.length; i += BATCH) {
        const batch = places.slice(i, i + BATCH);
        const result = (await trpcMutation("places.bulkImportPlaces", {
          places: batch,
        })) as {
          imported: number;
        };
        totalImported += result.imported ?? 0;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Imported ${totalImported} out of ${places.length} places.`,
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
