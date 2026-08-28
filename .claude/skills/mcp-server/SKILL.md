---
name: mcp-server
description: "Build or extend the Ithas Fire MCP server (apps/mcp/). Use when asked to 'add an MCP tool', 'expose a new procedure over MCP', 'create MCP server', 'add a tool so Copilot can interact with the app', or 'wire tRPC to MCP'. Covers scaffolding, tool registration, tRPC HTTP client, auth, and registering the server in .vscode/mcp.json."
argument-hint: "Describe the tool(s) to add — e.g. 'add a tool to list events' or 'add bulk-delete-places tool to the MCP server'"
---

# MCP Server Skill

The Ithas Fire MCP server (`apps/mcp/`) wraps the tRPC API over stdio so GitHub Copilot (or any MCP client) can perform real operations in the app.

## Architecture

```
VS Code (MCP client)
  └── apps/mcp (stdio process)
        └── fetch → POST/GET /trpc/* (apps/api)
                        └── tRPC procedures (packages/transport/trpc)
```

**Key facts:**
- Package: `apps/mcp/`, entry: `src/index.ts`
- SDK: `@modelcontextprotocol/sdk@^1.x` (v1 stable — NOT v2 alpha)
- Transport: stdio (launched by VS Code via `.vscode/mcp.json`)
- Auth: `Authorization: Bearer $ITHASFIRE_SESSION_TOKEN` header on every tRPC call
- API URL: `$ITHASFIRE_API_URL` (default: `http://localhost:3001`)
- tRPC transformer: **superjson** — inputs wrapped as `{"json": <value>}`, outputs parsed from `result.data.json`

## Project layout

```
apps/mcp/
  package.json          # name: "mcp", deps: @modelcontextprotocol/sdk, zod, dotenv
  tsconfig.json         # extends ../../packages/config/tsconfig/base.json
  src/
    index.ts            # registers all tools, connects StdioServerTransport
    client.ts           # trpcQuery() / trpcMutation() helpers
    tools/
      places.ts         # list_places, import_places, delete_places
      platform.ts       # list_orders, list_humans, list_tickets, set_human_status
      events.ts         # list_events (add as needed)
```

## Step-by-step: adding a new tool

### 1. Find the tRPC procedure

All procedures live in `packages/transport/trpc/src/routers/`. The `actorHumanId` field is stripped by the tRPC context (`.omit({ actorHumanId: true })`), so don't include it in the HTTP input.

Router → HTTP path mapping (examples):
- `platform.listPlaces` → `/trpc/platform.listPlaces` (query → GET)
- `places.bulkImportPlaces` → `/trpc/places.bulkImportPlaces` (mutation → POST)
- `platform.adminBulkDeletePlaces` → `/trpc/platform.adminBulkDeletePlaces` (mutation → POST)

### 2. Write the tool in the appropriate file under `src/tools/`

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { trpcQuery } from "../client.js";

export function registerPlacesTools(server: McpServer) {
  server.registerTool(
    "list_places",
    {
      title: "List Places",
      description: "Paginated list of all venues/places on the platform (staff only).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Skip N results"),
        query: z.string().optional().describe("Search term"),
        status: z.array(z.enum(["ACTIVE", "ARCHIVED"])).optional(),
      }),
    },
    async (input) => {
      const data = await trpcQuery("platform.listPlaces", input);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}
```

### 3. Register in `src/index.ts`

```typescript
import { registerPlacesTools } from "./tools/places.js";
// ...
registerPlacesTools(server);
```

### 4. Update `.vscode/mcp.json` if the server is not yet registered

```json
{
  "servers": {
    "ithasfire": {
      "type": "stdio",
      "command": "node",
      "args": ["apps/mcp/dist/src/index.js"],
      "env": {
        "ITHASFIRE_API_URL": "http://localhost:3001",
        "ITHASFIRE_SESSION_TOKEN": "${input:ithasfire_session_token}"
      }
    }
  }
}
```

Or for `tsx` during development:
```json
{
  "command": "npx",
  "args": ["tsx", "apps/mcp/src/index.ts"],
  "env": { "ITHASFIRE_SESSION_TOKEN": "${input:ithasfire_session_token}" }
}
```

## tRPC HTTP call patterns

### Queries (GET)

```typescript
// from client.ts
export async function trpcQuery<T>(path: string, input: unknown): Promise<T> {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  const res = await fetch(`${API_URL}/trpc/${path}?input=${encoded}`, {
    headers: buildHeaders(),
  });
  const body = await res.json() as any;
  if (body.error) throw new Error(body.error.json?.message ?? "tRPC query error");
  return body.result.data.json as T;
}
```

### Mutations (POST)

```typescript
export async function trpcMutation<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/trpc/${path}`, {
    method: "POST",
    headers: { ...buildHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ json: input }),
  });
  const body = await res.json() as any;
  if (body.error) throw new Error(body.error.json?.message ?? "tRPC mutation error");
  return body.result.data.json as T;
}
```

## Auth: getting a session token

The MCP server authenticates to the API using a Better-Auth session token.

**Local dev:**
1. Log into `http://localhost:3000` as an ADMIN user
2. Open DevTools → Application → Cookies → look for `better-auth.session_token`
3. Copy the cookie value and set `ITHASFIRE_SESSION_TOKEN=<value>` in `.vscode/mcp.json` env or your shell

**Production:** use a long-lived API key if available (passed as `x-api-key` header instead of `Authorization: Bearer`).

## Building

```bash
# Dev (tsx, no build needed)
npx tsx apps/mcp/src/index.ts

# Compiled
pnpm -F mcp build   # outputs to apps/mcp/dist/
```

## Common pitfalls

- **`console.log` corrupts MCP stdio** — use `console.error` for debug output; stdout is reserved for JSON-RPC messages.
- **Superjson dates** — the API JSON may contain stringified dates from superjson serialization. Parse with `new Date()` if you need to format them.
- **`actorHumanId` is NOT sent in the HTTP request** — the tRPC context injects it from the session token. Sending it will cause a Zod `unrecognized_keys` error.
- **Batch size for import** — `places.bulkImportPlaces` has a `max(500)` Zod guard. Loop in ≤500 chunks (already handled in the `import_places` tool).
- **Don't add tools for destructive operations without confirmation prompts** — the MCP tool description should state "⚠ destructive" so the LLM confirms with the user before calling.
