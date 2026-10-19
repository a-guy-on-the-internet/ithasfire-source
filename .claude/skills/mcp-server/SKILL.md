---
name: mcp-server
description: "Add a tool to the Ithas Fire MCP server (apps/mcp), which exposes tRPC procedures to an MCP client over stdio."
disable-model-invocation: true
---

# MCP Server

`apps/mcp/` is a stdio MCP server that calls the API's tRPC endpoints over HTTP. It is registered as `ithasfire` in `.vscode/mcp.json` (run through `tsx`, so no build is needed to use it).

```
MCP client → apps/mcp (stdio) → fetch /trpc/* on apps/api → packages/transport/trpc
```

- Entry `src/index.ts` registers every tool; `src/client.ts` has `trpcQuery()` / `trpcMutation()`; tools live in `src/tools/<area>.ts`. Copy an existing tool in `src/tools/places.ts`.
- SDK `@modelcontextprotocol/sdk` v1 (`server.registerTool(name, { title, description, inputSchema }, handler)`).
- tRPC uses **superjson**: inputs go as `{"json": <value>}`, outputs come back in `result.data.json`. The client helpers already do this.
- API URL: `ITHASFIRE_API_URL` (default `http://localhost:3001`).

## Auth

`client.ts` sends, in this order:

1. `ITHASFIRE_API_KEY` as `x-api-key`: the long-lived key, and the one to use. Create it by calling `apiKeys.create` as a signed-in user.
2. `ITHASFIRE_SESSION_TOKEN` as `Authorization: Bearer`, only when no API key is set: a Better Auth session cookie value (`better-auth.session_token` from a signed-in browser), short-lived.

Dev sign-in credentials are in `apps/api/src/scripts/seed/ids.ts`.

## Adding a tool

1. Find the procedure in `packages/transport/trpc/src/routers/`. Its HTTP path is `/trpc/<router>.<procedure>`; queries are GET, mutations POST.
2. Write the tool in the matching `src/tools/<area>.ts` (a new area gets its own file and a `register<Area>Tools(server)` call in `src/index.ts`). Mirror the procedure's Zod input, minus `actorHumanId`: the tRPC context injects it from the credentials, and sending it fails `.strict()` with `unrecognized_keys`.
3. Mark a destructive tool's `title` `⚠ destructive` and add its name to the destructive list in the server `instructions` (`src/index.ts`), so the calling model confirms with the user first.
4. Gate: `pnpm -F mcp build` (it is the package's typecheck). Then call the tool once against the local API and show the result.

## Pitfalls

- stdout carries the JSON-RPC stream, so debug output goes to `console.error`; one `console.log` corrupts the session.
- Dates arrive as strings after superjson; wrap in `new Date()` before formatting.
- `places.bulkImportPlaces` caps a call at 500 rows; batch above that (`import_places` already does).
