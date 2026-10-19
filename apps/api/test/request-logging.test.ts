import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// 2026-09-29: the API had no per-request log in production, and Cloud Run's
// request log only shows Cloudflare edge IPs, so the attacker could not be
// identified. The access log now carries the real client IP in prod.

const setTagMock = vi.fn();
vi.mock("../src/instrument", () => ({
  Sentry: { getIsolationScope: () => ({ setTag: setTagMock }) },
}));

const CF_HEADERS = {
  "cf-connecting-ip": "203.0.113.7",
  "x-forwarded-for": "203.0.113.7, 172.70.1.1",
};

async function buildApp(nodeEnv: "production" | "development") {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.resetModules();
  const { default: requestLogging } = await import(
    "../src/plugins/dev-request-logging"
  );
  const info = vi.fn();
  const app = Fastify({ logger: false, trustProxy: true });
  app.decorate("deps", { logger: { info } } as never);
  await app.register(requestLogging as never);
  app.get("/api/volunteering/:feedToken/calendar.ics", async () => "ok");
  app.get("/health", async () => "ok");
  await app.ready();
  return { app, info };
}

afterEach(() => {
  vi.unstubAllEnvs();
  setTagMock.mockReset();
});

describe("per-request log line — client IP", () => {
  it("production: logs the real client IP, the full XFF chain, and the route TEMPLATE (never the token-bearing URL)", async () => {
    const { app, info } = await buildApp("production");

    await app.inject({
      method: "GET",
      url: "/api/volunteering/SECRET-FEED-TOKEN/calendar.ics?x=1",
      headers: CF_HEADERS,
    });

    expect(info).toHaveBeenCalledTimes(1);
    const [msg, fields] = info.mock.calls[0]!;
    expect(msg).toBe("http_request");
    expect(fields).toMatchObject({
      method: "GET",
      route: "/api/volunteering/:feedToken/calendar.ics",
      statusCode: 200,
      clientIp: "203.0.113.7",
      cfConnectingIp: "203.0.113.7",
      forwardedFor: "203.0.113.7, 172.70.1.1",
    });
    expect(JSON.stringify(fields)).not.toContain("SECRET-FEED-TOKEN");
    expect(setTagMock).toHaveBeenCalledWith("client_ip", "203.0.113.7");
    await app.close();
  });

  it("production: an unmatched probe path is logged without its query string", async () => {
    const { app, info } = await buildApp("production");

    await app.inject({
      method: "GET",
      url: "/wp-admin/setup.php?token=abc",
      headers: CF_HEADERS,
    });

    expect(info.mock.calls[0]![1]).toMatchObject({
      path: "/wp-admin/setup.php",
      statusCode: 404,
      clientIp: "203.0.113.7",
    });
    expect(JSON.stringify(info.mock.calls[0]![1])).not.toContain("token=abc");
    await app.close();
  });

  it("production: /health probes are not logged", async () => {
    const { app, info } = await buildApp("production");

    await app.inject({ method: "GET", url: "/health" });

    expect(info).not.toHaveBeenCalled();
    await app.close();
  });

  it("development: keeps the raw URL and adds the IP fields", async () => {
    const { app, info } = await buildApp("development");

    await app.inject({ method: "GET", url: "/health", headers: CF_HEADERS });

    expect(info.mock.calls[0]![1]).toMatchObject({
      url: "/health",
      clientIp: "203.0.113.7",
    });
    await app.close();
  });
});
