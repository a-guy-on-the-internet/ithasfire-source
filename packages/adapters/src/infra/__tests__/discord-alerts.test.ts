import { describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";

import {
  createDiscordWebhookAlertSender,
  logAndReport,
  type DiscordAlertOptions,
} from "../discord-alerts";

const WEBHOOK_URL = "https://discord.test/webhook/abc";

function makeLogger(): LoggerPort {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as LoggerPort;
}

function makeFetchMock() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
  })) as unknown as typeof fetch;
}

describe("createDiscordWebhookAlertSender", () => {
  it("posts a body with allowed_mentions disabled (no pings ever)", async () => {
    const fetchMock = makeFetchMock();
    const send = createDiscordWebhookAlertSender({
      webhookUrl: WEBHOOK_URL,
      fetch: fetchMock,
    });

    await send({ title: "hello", description: "@everyone" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const parsed = JSON.parse(opts.body as string);
    expect(parsed.allowed_mentions).toEqual({ parse: [] });
  });

  it("attaches an abort signal to the fetch options", async () => {
    const fetchMock = makeFetchMock();
    const send = createDiscordWebhookAlertSender({
      webhookUrl: WEBHOOK_URL,
      fetch: fetchMock,
    });

    await send({ title: "hello" });

    const [, opts] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(opts.signal).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("no-ops when the webhook URL is empty", async () => {
    const fetchMock = makeFetchMock();
    const send = createDiscordWebhookAlertSender({
      webhookUrl: "",
      fetch: fetchMock,
    });

    await send({ title: "hello" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when the webhook URL is unset", async () => {
    const fetchMock = makeFetchMock();
    const send = createDiscordWebhookAlertSender({ fetch: fetchMock });

    await send({ title: "hello" });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("logAndReport — Sentry deep-link", () => {
  const basePayload: DiscordAlertOptions = {
    title: "tRPC unhandled error",
    colour: "error",
    fields: [
      { name: "Path", value: "orders.create", inline: true },
      { name: "Type", value: "mutation", inline: true },
      { name: "Code", value: "INTERNAL_SERVER_ERROR", inline: true },
    ],
  };

  it("appends a clickable Sentry field built from the captured event id", async () => {
    const send = vi.fn((_payload: DiscordAlertOptions) => Promise.resolve());
    const eventId = "0123456789abcdef0123456789abcdef";
    const buildSentryUrl = vi.fn(
      (id: string) =>
        `https://hearth-fire.sentry.io/organizations/hearth-fire/issues/?query=${id}`,
    );

    await logAndReport({
      logger: makeLogger(),
      level: "error",
      message: "trpc.unhandled_error",
      report: {
        captureException: () => eventId,
        buildSentryUrl,
        error: new Error("boom"),
      },
      alert: { send, payload: basePayload },
    });

    expect(buildSentryUrl).toHaveBeenCalledWith(eventId);
    expect(send).toHaveBeenCalledTimes(1);
    const sentPayload = send.mock.calls[0]![0];
    const sentryField = sentPayload.fields?.find((f) => f.name === "Sentry");
    expect(sentryField).toBeDefined();
    expect(sentryField!.value).toContain(
      `https://hearth-fire.sentry.io/organizations/hearth-fire/issues/?query=${eventId}`,
    );
    expect(sentryField!.value).toBe(
      `[View issue](https://hearth-fire.sentry.io/organizations/hearth-fire/issues/?query=${eventId})`,
    );
    // The original payload is not mutated.
    expect(basePayload.fields).toHaveLength(3);
  });

  it("sends the payload without a Sentry field when captureException returns no event id", async () => {
    const send = vi.fn((_payload: DiscordAlertOptions) => Promise.resolve());
    const buildSentryUrl = vi.fn(() => "https://should.not/be/called");

    await logAndReport({
      logger: makeLogger(),
      level: "error",
      message: "trpc.unhandled_error",
      report: {
        captureException: () => undefined,
        buildSentryUrl,
        error: new Error("boom"),
      },
      alert: { send, payload: basePayload },
    });

    expect(buildSentryUrl).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const sentPayload = send.mock.calls[0]![0];
    expect(sentPayload.fields?.some((f) => f.name === "Sentry")).toBe(false);
    expect(sentPayload).toBe(basePayload);
  });

  it("omits the Sentry field when the URL builder yields nothing", async () => {
    const send = vi.fn((_payload: DiscordAlertOptions) => Promise.resolve());

    await logAndReport({
      logger: makeLogger(),
      level: "error",
      message: "trpc.unhandled_error",
      report: {
        captureException: () => "abc123",
        buildSentryUrl: () => undefined,
        error: new Error("boom"),
      },
      alert: { send, payload: basePayload },
    });

    const sentPayload = send.mock.calls[0]![0];
    expect(sentPayload.fields?.some((f) => f.name === "Sentry")).toBe(false);
  });
});
