import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";

import {
  createDiscordWebhookAlertSender,
  detectCloudRunEnvTag,
  logAndAlert,
  logAndReport,
} from "../../src/infra/discord-alerts";

function createLogger(): LoggerPort & { log: ReturnType<typeof vi.fn> } {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return logger as unknown as LoggerPort & { log: ReturnType<typeof vi.fn> };
}

describe("createDiscordWebhookAlertSender", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a Discord embed payload when configured", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    const fireDiscordAlert = createDiscordWebhookAlertSender({
      webhookUrl: "https://discord.example/webhook",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await fireDiscordAlert({
      title: "Operational alert",
      colour: "warning",
      fields: [{ name: "Order", value: "123", inline: true }],
      description: "Something needs review",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://discord.example/webhook");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(String(init?.body));
    expect(body.embeds[0]).toMatchObject({
      title: "Operational alert",
      description: "Something needs review",
      fields: [{ name: "Order", value: "123", inline: true }],
    });
  });

  it("does nothing when no webhook is configured", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    const fireDiscordAlert = createDiscordWebhookAlertSender({
      webhookUrl: undefined,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await fireDiscordAlert({ title: "Should not post" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepends titlePrefix to every alert title when configured", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    const fireDiscordAlert = createDiscordWebhookAlertSender({
      webhookUrl: "https://discord.example/webhook",
      fetch: fetchMock as unknown as typeof fetch,
      titlePrefix: "dev",
    });

    await fireDiscordAlert({ title: "Settlement Batch CRASHED" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.embeds[0].title).toBe("[dev] Settlement Batch CRASHED");
  });

  it("warns when Discord returns a non-ok response", async () => {
    const logger = createLogger();
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        }) as Response,
    );
    const fireDiscordAlert = createDiscordWebhookAlertSender({
      webhookUrl: "https://discord.example/webhook",
      fetch: fetchMock as unknown as typeof fetch,
      logger,
    });

    await fireDiscordAlert({ title: "Rate limited" });

    expect(logger.warn).toHaveBeenCalledWith("discord_alert_delivery_failed", {
      status: 429,
      statusText: "Too Many Requests",
    });
  });
});

describe("detectCloudRunEnvTag", () => {
  const original = process.env.K_SERVICE;
  afterEach(() => {
    if (original === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = original;
  });

  it("extracts env from hf-<env>-<role> service names", () => {
    process.env.K_SERVICE = "hf-dev-jobs";
    expect(detectCloudRunEnvTag()).toBe("dev");
    process.env.K_SERVICE = "hf-prod-api";
    expect(detectCloudRunEnvTag()).toBe("prod");
    process.env.K_SERVICE = "hf-stage-web";
    expect(detectCloudRunEnvTag()).toBe("stage");
  });

  it("returns null when K_SERVICE is unset or doesn't match", () => {
    delete process.env.K_SERVICE;
    expect(detectCloudRunEnvTag()).toBeNull();
    process.env.K_SERVICE = "something-else";
    expect(detectCloudRunEnvTag()).toBeNull();
  });
});

describe("logAndAlert", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs structured data and delivers the alert when provided", async () => {
    const logger = createLogger();
    const send = vi.fn(async () => undefined);

    await logAndAlert({
      logger,
      level: "error",
      message: "discord_alert_test",
      extra: { orderId: "123" },
      alert: {
        send,
        payload: { title: "Alert title", colour: "error" },
      },
    });

    expect(logger.log).toHaveBeenCalledWith("error", "discord_alert_test", {
      orderId: "123",
    });
    expect(send).toHaveBeenCalledWith({
      title: "Alert title",
      colour: "error",
    });
  });

  it("swallows alert delivery failures", async () => {
    const logger = createLogger();
    const send = vi.fn(async () => {
      throw new Error("discord unavailable");
    });

    await expect(
      logAndAlert({
        logger,
        level: "warn",
        message: "discord_alert_failure_test",
        alert: {
          send,
          payload: { title: "Alert title" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "discord_alert_failure_test",
      undefined,
    );
  });
});

describe("logAndReport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs structured data, reports the exception, and delivers the alert", async () => {
    const logger = createLogger();
    const send = vi.fn(async () => undefined);
    const captureException = vi.fn();
    const error = new Error("boom");

    await logAndReport({
      logger,
      level: "error",
      message: "runtime_boundary_failed",
      extra: { trpcPath: "events.list" },
      report: {
        captureException,
        error,
        context: {
          tags: { trpcPath: "events.list" },
          extra: { requestType: "query" },
        },
      },
      alert: {
        send,
        payload: { title: "Alert title", colour: "error" },
      },
    });

    expect(logger.log).toHaveBeenCalledWith(
      "error",
      "runtime_boundary_failed",
      {
        trpcPath: "events.list",
      },
    );
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { trpcPath: "events.list" },
      extra: { requestType: "query" },
    });
    expect(send).toHaveBeenCalledWith({
      title: "Alert title",
      colour: "error",
    });
  });

  it("swallows reporter and alert failures", async () => {
    const logger = createLogger();
    const captureException = vi.fn(() => {
      throw new Error("sentry unavailable");
    });
    const send = vi.fn(async () => {
      throw new Error("discord unavailable");
    });

    await expect(
      logAndReport({
        logger,
        level: "error",
        message: "runtime_boundary_failed",
        report: {
          captureException,
          error: new Error("boom"),
        },
        alert: {
          send,
          payload: { title: "Alert title" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(logger.log).toHaveBeenCalledWith(
      "error",
      "runtime_boundary_failed",
      undefined,
    );
  });
});
