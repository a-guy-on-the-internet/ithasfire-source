import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "@th/trpc";

const TRPC_HTTP_URL = process.env.TRPC_HTTP_URL ?? "http://localhost:3001/trpc";

type Command = "seo" | "sitemap" | "nearby" | "local";

function readArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function requireArg(name: string): string {
  const value = readArg(name);
  if (!value) {
    throw new Error(`Missing required arg: ${name}`);
  }
  return value;
}

function parseNumberArg(name: string): number {
  const raw = requireArg(name);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for ${name}: ${raw}`);
  }
  return value;
}

async function main() {
  const client = createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: TRPC_HTTP_URL,
        transformer: superjson,
        fetch(url, options) {
          return fetch(url, {
            ...options,
            credentials: "include",
          });
        },
      }),
    ],
  });

  const cmd = (process.argv[2] ?? "seo") as Command;

  if (cmd === "seo") {
    const slug = process.argv[3] ?? "mission-supper-club";
    const seo = await client.events.getEventSeo.query({ slug });
    // eslint-disable-next-line no-console
    console.log("events.getEventSeo:", JSON.stringify(seo, null, 2));
    return;
  }

  if (cmd === "sitemap") {
    const sitemap = await client.events.listEventSitemapEntries.query({});
    // eslint-disable-next-line no-console
    console.log(
      "events.listEventSitemapEntries (first 5):",
      sitemap.slice(0, 5),
    );
    return;
  }

  if (cmd === "nearby") {
    const lat = parseNumberArg("--lat");
    const lng = parseNumberArg("--lng");
    const radiusM = Number(readArg("--radiusM") ?? 5000);
    const limit = Number(readArg("--limit") ?? 10);

    const result = await client.events.nearbyEvents.query({
      lat,
      lng,
      radiusM,
      limit,
    });

    // eslint-disable-next-line no-console
    console.log("events.nearbyEvents:", JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "local") {
    const regionCode = requireArg("--regionCode");
    const limit = Number(readArg("--limit") ?? 10);
    const result = await client.events.localEvents.query({ regionCode, limit });
    // eslint-disable-next-line no-console
    console.log("events.localEvents:", JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("trpc smoke failed", err);
  process.exit(1);
});
