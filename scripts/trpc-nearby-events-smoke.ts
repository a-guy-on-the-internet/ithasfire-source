import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "@th/trpc";

const TRPC_HTTP_URL = process.env.TRPC_HTTP_URL ?? "http://localhost:3001/trpc";

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

  const lat = Number(process.env.LAT ?? "37.785834");
  const lng = Number(process.env.LNG ?? "-122.406417");
  const radiusM = Number(process.env.RADIUS_M ?? "30000");

  const res = await client.events.nearbyEvents.query({
    lat,
    lng,
    radiusM,
    limit: 12,
    offset: 0,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        input: { lat, lng, radiusM },
        eventCount: res.events.length,
        firstEvent: res.events[0] ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("trpc nearbyEvents smoke failed", err);
  process.exit(1);
});
