import assert from "node:assert/strict";

import { createApp } from "../src/app";

// Keep smoke behavior consistent with `apps/api/src/index.ts`:
// load dotenv in dev so local `.env` files work.
if (process.env.NODE_ENV !== "production") {
  try {
    const dotenv = await import("dotenv");
    dotenv.config();
  } catch {
    // Optional dependency in dev; ignore.
  }
}

type HealthResponse = {
  ok: boolean;
};

async function run() {
  const app = await createApp();
  const host = "127.0.0.1";
  const address = await app.listen({ port: 0, host });
  const baseUrl =
    typeof address === "string"
      ? address
      : `http://${(address as { address: string; port: number }).address}:${(address as { address: string; port: number }).port}`;

  try {
    const response = await fetch(new URL("/health", baseUrl));
    assert.equal(response.status, 200, "health should return 200");
    const payload = (await response.json()) as HealthResponse;
    assert.equal(payload?.ok, true, "health payload should report ok");
    // eslint-disable-next-line no-console
    console.log("smoke: /health ok at", baseUrl);
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("smoke: failed", err);
  process.exit(1);
});
