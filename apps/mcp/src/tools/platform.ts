import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { trpcQuery, trpcMutation } from "../client.js";

export function registerPlatformTools(server: McpServer): void {
  // ── list_orders ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_orders",
    {
      title: "List Orders",
      description:
        "Paginated list of all orders across all orgs. Requires ADMIN or REVIEWER staff role.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("Results per page"),
        offset: z.number().int().min(0).default(0).describe("Skip N results"),
        query: z
          .string()
          .optional()
          .describe("Search by order ID or buyer name"),
      }),
    },
    async (input) => {
      const data = await trpcQuery("platform.listOrders", input);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  // ── list_humans ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_humans",
    {
      title: "List Humans",
      description:
        "Paginated list of all registered users (humans) on the platform. Requires ADMIN or SUPPORT staff role.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("Results per page"),
        offset: z.number().int().min(0).default(0).describe("Skip N results"),
        query: z.string().optional().describe("Search by name or email"),
      }),
    },
    async (input) => {
      const data = await trpcQuery("platform.listHumans", input);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  // ── list_tickets ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_tickets",
    {
      title: "List Tickets",
      description:
        "Paginated list of all tickets across events. Requires ADMIN or REVIEWER staff role.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("Results per page"),
        offset: z.number().int().min(0).default(0).describe("Skip N results"),
        query: z.string().optional().describe("Search term"),
      }),
    },
    async (input) => {
      const data = await trpcQuery("platform.listTickets", input);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  // ── set_human_status ─────────────────────────────────────────────────────

  server.registerTool(
    "set_human_status",
    {
      title: "Set Human Status ⚠ destructive",
      description:
        "⚠ ADMIN-only — change a user's status to ACTIVE, SUSPENDED, or BANNED. Suspending/banning invalidates all their sessions. Always confirm with the user before calling.",
      inputSchema: z.object({
        humanId: z.string().uuid().describe("UUID of the human to update"),
        status: z
          .enum(["ACTIVE", "SUSPENDED", "BANNED"])
          .describe("New status for the human"),
        reason: z
          .string()
          .optional()
          .describe("Optional reason for the status change"),
      }),
    },
    async (input) => {
      const data = await trpcMutation("platform.setHumanStatus", input);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  // ── check_staff_access ───────────────────────────────────────────────────

  server.registerTool(
    "check_staff_access",
    {
      title: "Check Staff Access",
      description:
        "Verify the session token is valid and check which staff roles the current user has. Useful for diagnosing auth issues.",
      inputSchema: z.object({}),
    },
    async () => {
      const data = await trpcQuery("platform.checkStaffAccess", {});
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );
}
