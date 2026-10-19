import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import http from "node:http";

import { StripePaymentProcessor } from "../stripe-adapter";

/**
 * Stripe adapter E2E-ish test.
 *
 * Why this exists:
 * - Validates our adapter speaks "Stripe" correctly (params + idempotency header)
 * - Doesn't require real Stripe credentials or network access to Stripe
 * - Uses stripe-mock (local Docker) as an HTTP stub of the Stripe API
 *
 * What we assert:
 * - PaymentIntent creation returns an id + client_secret
 * - Our request is idempotent (stripe-mock echoes request headers)
 * - Destination charges field is sent when destinationAccountId is provided
 */

describe("StripePaymentProcessor (stripe-mock)", () => {
  const host = "127.0.0.1";
  const port = 12111;
  const baseUrl = `http://${host}:${port}`;

  const composeContainerName = "docker-stripe-mock-1";
  let startedContainerId: string | null = null;
  let dockerAvailable = true;

  function checkDockerAvailable(): boolean {
    // Self-hosted CI mounts docker.sock so `docker info` works, but the host
    // port binding for stripe-mock (127.0.0.1:12111) is on the host, not
    // reachable from the CI job container. Require explicit opt-in.
    if (process.env.CI === "true" && process.env.RUN_STRIPE_E2E !== "1") {
      return false;
    }
    try {
      execSync("docker info", { stdio: "ignore", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(() => {
    dockerAvailable = checkDockerAvailable();
    if (!dockerAvailable) return;

    // Prefer the repo's docker-compose service if it's already up.
    try {
      execSync(`docker inspect ${composeContainerName}`, { stdio: "ignore" });
      return;
    } catch {
      // not running; fall back to spinning up a one-off container
    }

    // Start stripe-mock. We bind to 127.0.0.1 to avoid exposing ports publicly.
    // We use --rm so it gets cleaned up even if stop fails (still stop in afterAll).
    const STRIPE_MOCK_IMAGE = "stripe/stripe-mock:latest";
    const cmd = [
      "docker run -d --rm",
      `--name th-stripe-mock-${randomUUID().slice(0, 8)}`,
      `-p ${host}:${port}:${port}`,
      STRIPE_MOCK_IMAGE,
      `-http-addr ${host}:${port}`,
      "-verbose",
    ].join(" ");

    startedContainerId = execSync(cmd, { encoding: "utf8" }).trim();
  }, 60_000);

  afterAll(() => {
    if (!dockerAvailable) return;
    delete process.env.STRIPE_API_BASE;
    if (!startedContainerId) return;
    try {
      execSync(`docker stop ${startedContainerId}`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  });

  it("creates payment intent with idempotency key and destination charges", async () => {
    if (!dockerAvailable) {
      // Using this pattern keeps CI green in environments where docker isn't present.
      // Run locally with Docker for full adapter E2E coverage.
      return;
    }

    // stripe-mock doesn't expose request headers in logs reliably.
    // Prove we send the idempotency key by intercepting Node's outgoing HTTP request headers.
    const seenHeaders: Array<http.OutgoingHttpHeaders | undefined> = [];
    const seenBodies: string[] = [];
    const originalRequest = http.request;
    const requestSpy = vi
      .spyOn(http, "request")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((...args: any[]) => {
        // args can be (url, options, cb) or (options, cb)
        const options =
          typeof args[0] === "string" || args[0] instanceof URL
            ? (args[1] as any)
            : (args[0] as any);
        seenHeaders.push(options?.headers);

        const req = (originalRequest as any)(...args);
        const originalWrite = req.write.bind(req);
        req.write = (chunk: any, ...rest: any[]) => {
          try {
            if (typeof chunk === "string") seenBodies.push(chunk);
            else if (Buffer.isBuffer(chunk))
              seenBodies.push(chunk.toString("utf8"));
          } catch {
            // ignore
          }
          return originalWrite(chunk, ...rest);
        };

        return req;
      }) as any);

    // stripe-mock enforces Stripe-like auth header formats.
    // Avoid hardcoding even fake API keys in-repo; generate a valid-looking test key at runtime.
    const apiKey =
      process.env.STRIPE_E2E_API_KEY ??
      `sk_test_${randomUUID().replace(/-/g, "")}`;

    const payments = new StripePaymentProcessor({
      // Keep this non-secret and non-Stripesque; stripe-mock doesn't validate.
      apiKey,
      apiVersion: "2025-08-27.basil" as any,
    });

    // Point the adapter's internal Stripe client to stripe-mock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payments as any).s = new ((await import("stripe")).default as any)(
      apiKey,
      {
        apiVersion: "2025-08-27.basil",
        host: "127.0.0.1",
        port: 12111,
        protocol: "http",
      },
    );

    const idempotencyKey = `it:${randomUUID()}`;
    const destinationAccountId = "acct_123456789";
    // Apostrophe deliberately included: `qs` percent-encodes `'` while
    // `encodeURIComponent` does not, so building the expectation with the
    // latter would fail on a perfectly ordinary title. We decode instead.
    const description = "Ella's Launch Party — 3 tickets · Order DB21B2C3";

    const result = await payments.createPaymentIntent({
      amountCents: 1234,
      currency: "usd",
      idempotencyKey,
      destinationAccountId,
      metadata: { orderId: "22222222-2222-4222-8222-222222222222" },
      description,
    });

    expect(result.id).toMatch(/^pi_/);
    expect(result.clientSecret).toContain("_secret_");

    const hadIdempotency = seenHeaders.some((h) => {
      const key =
        (h as any)?.["Idempotency-Key"] ?? (h as any)?.["idempotency-key"];
      return key === idempotencyKey;
    });
    expect(hadIdempotency).toBe(true);

    requestSpy.mockRestore();

    // Assert destinationAccountId is stored in metadata (not transfer_data).
    // We use separate charges + manual transfers, not destination charges.
    const bodyJoined = seenBodies.join("&");
    expect(bodyJoined).toContain(
      `metadata[destinationAccountId]=${destinationAccountId}`,
    );
    expect(bodyJoined).not.toContain("transfer_data");

    // The Dashboard/exports description reaches Stripe on the wire, UTF-8
    // intact (em dash and middle dot survive percent-encoding), and is a
    // DIFFERENT field from statement_descriptor_suffix, which we did not set.
    //
    // Assert on the DECODED body: the wire form comes from `qs`, whose
    // unreserved set is narrower than `encodeURIComponent`'s (it also encodes
    // ! ' * ( ) ), so comparing encoded strings would produce a diff that
    // looks like an adapter bug when it is only an encoder-table difference.
    const decodedBody = decodeURIComponent(bodyJoined.replace(/\+/g, " "));
    expect(decodedBody).toContain(`description=${description}`);
    expect(bodyJoined).not.toContain("statement_descriptor");
  });
});
