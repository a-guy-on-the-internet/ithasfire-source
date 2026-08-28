import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPlacesTools } from "./tools/places.js";
import { registerPlatformTools } from "./tools/platform.js";

const server = new McpServer(
  { name: "ithasfire", version: "0.1.0" },
  {
    capabilities: { logging: {} },
    instructions: [
      "You are connected to the Ithas Fire platform API.",
      "All mutating tools (delete_places, set_human_status, import_places) are destructive — always confirm with the user before calling them.",
      "Use check_staff_access first if you're unsure whether the session token is valid.",
      "Results are paginated — use offset + limit to page through large datasets.",
    ].join(" "),
  },
);

registerPlacesTools(server);
registerPlatformTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// NOTE: use console.error for any debug output — stdout is reserved for
// JSON-RPC messages and console.log will corrupt the MCP protocol.
console.error("Ithas Fire MCP server running on stdio");
