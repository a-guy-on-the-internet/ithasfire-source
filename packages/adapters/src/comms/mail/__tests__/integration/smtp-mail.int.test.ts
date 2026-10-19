import { setTimeout as delay } from "node:timers/promises";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SMTPMailAdapter } from "../../smtp-mail";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { MetricsPort } from "@th/ports/metric";
import { CommsPortError } from "@th/ports/comms/index";
import { createTestLogger } from "@th/test-utils";

const shouldRun = process.env.CI_INTEGRATION === "1";
const describeIntegration = shouldRun ? describe : describe.skip;

const MAILPIT_BASE_URL = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "1025");
const SMTP_USER = process.env.SMTP_USER || undefined;
const SMTP_PASS = process.env.SMTP_PASS || undefined;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const DEFAULT_FROM =
  process.env.MAIL_FROM ?? "Ithas Fire <no-reply@ithasfire.test>";

if (shouldRun) {
  vi.setConfig({ testTimeout: 30_000 });
  process.env.UI_EMAIL_RENDER_MODE =
    process.env.UI_EMAIL_RENDER_MODE ?? "react-email";
}

type MailpitAddress = {
  Address: string;
  Name?: string;
};

type MailpitMessageSummary = {
  ID: string;
  Subject?: string;
  From?: MailpitAddress;
  To?: MailpitAddress[];
  Created?: string;
};

type MailpitMessageDetails = MailpitMessageSummary & {
  Text?: string;
  HTML?: string;
  Headers?: Record<string, string | string[]>;
  Size?: number;
  Attachments?: Array<{
    PartID: string;
    FileName: string;
    ContentType: string;
    Size: number;
  }>;
  MIME?: {
    Parts?: Array<{
      Headers?: Record<string, string | string[]>;
      FileName?: string;
      ContentType?: string;
    }>;
  };
};

const MAILPIT_POLL_INTERVAL_MS = 250;
const MAILPIT_POLL_TIMEOUT_MS = 10_000;

async function fetchJson<T>(
  input: string | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mailpit request failed (${response.status}): ${body}`);
  }
  if (response.status === 204) {
    return null as T;
  }
  return (await response.json()) as T;
}

const createMailpitClient = () => {
  const baseUrl = MAILPIT_BASE_URL.replace(/\/$/, "");
  return {
    async ready() {
      await this.ping();
    },
    async ping() {
      await fetchJson(`${baseUrl}/api/v1/info`);
    },
    async clear() {
      await fetchJson(`${baseUrl}/api/v1/messages`, { method: "DELETE" });
    },
    async list(): Promise<MailpitMessageSummary[]> {
      const data = await fetchJson<{ messages?: MailpitMessageSummary[] }>(
        `${baseUrl}/api/v1/messages`,
      );
      return data.messages ?? [];
    },
    async get(id: string): Promise<MailpitMessageDetails> {
      return fetchJson<MailpitMessageDetails>(
        `${baseUrl}/api/v1/message/${id}`,
      );
    },
    async waitFor(
      count: number,
      timeoutMs = MAILPIT_POLL_TIMEOUT_MS,
    ): Promise<MailpitMessageSummary[]> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const messages = await this.list();
        if (messages.length >= count) {
          return messages;
        }
        await delay(MAILPIT_POLL_INTERVAL_MS);
      }
      throw new Error(
        `Timed out waiting for ${count} messages (saw ${await this.list().then((m) => m.length)})`,
      );
    },
    async fetchAttachment(messageId: string, partId: string): Promise<Buffer> {
      const response = await fetch(
        `${baseUrl}/api/v1/message/${messageId}/attachment/${partId}`,
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Failed to download attachment (${response.status}): ${body}`,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },
  };
};

const createMetrics = (): MetricsPort => ({
  increment: () => undefined,
  record: () => undefined,
});

const createIdempotency = (): IdempotencyPort => {
  const cache = new Map<string, { expiresAt: number; payload: unknown }>();
  const locks = new Map<string, number>();

  const begin: IdempotencyPort["begin"] = async (key, ttlSec = 60) => {
    const lockUntil = locks.get(key) ?? 0;
    const now = Date.now();
    if (lockUntil > now) {
      return false;
    }
    locks.set(key, now + ttlSec * 1000);
    return true;
  };

  const commit: IdempotencyPort["commit"] = async (
    key,
    payload,
    keepSec = 60,
  ) => {
    cache.set(key, { payload, expiresAt: Date.now() + keepSec * 1000 });
    locks.set(key, Date.now() + keepSec * 1000);
  };

  const fail: IdempotencyPort["fail"] = async (key) => {
    locks.delete(key);
  };

  const getImpl = async (key: string) => {
    const stored = cache.get(key);
    if (!stored) {
      return null;
    }
    if (stored.expiresAt < Date.now()) {
      cache.delete(key);
      return null;
    }
    return stored.payload;
  };

  async function getTyped<T = unknown>(key: string): Promise<T | null> {
    const result = await getImpl(key);
    return (result ?? null) as T | null;
  }

  async function runTyped<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>,
    keepSec?: number,
  ) {
    const existing = (await getImpl(key)) as T | null;
    if (existing) {
      return { fresh: false, result: existing } as const;
    }
    const acquired = await begin(key, ttlSec);
    if (!acquired) {
      const replay = (await getImpl(key)) as T | null;
      if (replay) {
        return { fresh: false, result: replay } as const;
      }
      throw new Error("idempotency_conflict");
    }
    try {
      const result = await fn();
      await commit(key, result, keepSec);
      return { fresh: true, result } as const;
    } catch (error) {
      await fail(key);
      throw error;
    }
  }

  return {
    begin,
    commit,
    fail,
    get: getTyped as IdempotencyPort["get"],
    run: runTyped as IdempotencyPort["run"],
    purgeExpired: async () => 0,
  };
};

const headerValue = (
  headers: MailpitMessageDetails["Headers"],
  key: string,
): string | undefined => {
  if (!headers) return undefined;
  const direct = headers[key];
  if (!direct) return undefined;
  if (Array.isArray(direct)) {
    return direct[0];
  }
  return direct;
};

const findAttachmentPart = (
  message: MailpitMessageDetails,
  fileName: string,
) => {
  const attachments = message.Attachments ?? [];
  const viaAttachments = attachments.find((att) => att.FileName === fileName);
  if (viaAttachments) {
    return viaAttachments;
  }
  const mimeParts = message.MIME?.Parts ?? [];
  return mimeParts.find(
    (part) =>
      part.FileName === fileName ||
      headerValue(part.Headers ?? {}, "Content-Disposition")?.includes(
        fileName,
      ),
  );
};

describeIntegration("SMTPMailAdapter integration", () => {
  const mailpit = createMailpitClient();

  beforeAll(async () => {
    await mailpit.ready();
  });

  beforeEach(async () => {
    await mailpit.clear();
  });

  const createAdapter = (
    overrides: Partial<ConstructorParameters<typeof SMTPMailAdapter>[0]> = {},
  ) =>
    new SMTPMailAdapter({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      username: SMTP_USER,
      password: SMTP_PASS,
      defaultFromEmail: DEFAULT_FROM,
      logger: createTestLogger(),
      metrics: createMetrics(),
      idempotency: overrides.idempotency,
      appHeaderValue: "IthasFireIntegration",
      ...overrides,
    });

  it("sends templated emails end-to-end", async () => {
    const adapter = createAdapter();

    const sendResult = await adapter.send({
      to: { to: "integration+template@ithasfire.test", name: "Template User" },
      template: {
        key: "auth.verification_code",
        variables: {
          code: "742910",
          expiresMinutes: 15,
          productName: "Ithas Fire",
        },
      },
    });

    expect(sendResult.result.success).toBe(true);

    const messages = await mailpit.waitFor(1);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const message = messages[0]!;
    const details = await mailpit.get(message.ID);
    expect(details.Subject).toContain("verification code");
    const html = details.HTML ?? "";
    const text = details.Text ?? "";
    expect(`${html}\n${text}`).toContain("742910");
    expect(headerValue(details.Headers, "X-Template")).toBe(
      "auth.verification_code",
    );
    expect(headerValue(details.Headers, "X-App")).toBe("IthasFireIntegration");
  });

  it("delivers attachments and metadata headers", async () => {
    const adapter = createAdapter();
    const attachmentContent = "Integration attachment payload";
    const sendResult = await adapter.send({
      to: {
        to: "integration+attachments@ithasfire.test",
        name: "Attachment User",
      },
      subject: "Attachment check",
      text: "See attached",
      metadata: {
        orderId: "ord_123",
      },
      tags: ["integration", "mail"],
      idempotencyKey: "smtp-int-attach",
      attachments: [
        {
          filename: "integration.txt",
          mime: "text/plain",
          bytesBase64: Buffer.from(attachmentContent).toString("base64"),
        },
      ],
    });

    expect(sendResult.result.success).toBe(true);

    const messages = await mailpit.waitFor(1);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const message = messages[0]!;
    const details = await mailpit.get(message.ID);
    const viaAttachment = findAttachmentPart(details, "integration.txt");
    expect(viaAttachment).toBeTruthy();

    const headerMeta = headerValue(details.Headers, "X-Meta-orderId");
    expect(headerMeta).toBe("ord_123");
    expect(headerValue(details.Headers, "X-Tags")).toBe("integration,mail");

    if (viaAttachment && "PartID" in viaAttachment) {
      const buffer = await mailpit.fetchAttachment(
        details.ID,
        (viaAttachment as { PartID: string }).PartID,
      );
      expect(buffer.toString("utf-8")).toBe(attachmentContent);
    }
  });

  it("replays idempotent sends without duplicating messages", async () => {
    const idempotency = createIdempotency();
    const adapter = createAdapter({ idempotency });
    const input = {
      to: { to: "integration+idem@ithasfire.test" },
      subject: "Idempotent send",
      text: "First send",
      idempotencyKey: "smtp-int-idem-001",
    } as const;

    const first = await adapter.send(input);
    expect(first.result.success).toBe(true);
    expect(first.result.id?.length ?? 0).toBeGreaterThan(0);

    await mailpit.waitFor(1);

    const second = await adapter.send(input);
    expect(second.result.success).toBe(true);
    expect(second.result.idempotentReplay).toBe(true);

    await delay(500);
    const messages = await mailpit.list();
    expect(messages).toHaveLength(1);
  });

  it("rejects invalid inputs before reaching SMTP", async () => {
    const adapter = createAdapter();

    await expect(
      adapter.send({
        to: [],
        subject: "Missing recipient",
        text: "Should fail",
      } as unknown as never),
    ).rejects.toBeInstanceOf(CommsPortError);
  });

  it("reports healthy transport", async () => {
    const adapter = createAdapter();
    const health = await adapter.health();
    expect(health.ok).toBe(true);
    expect(health.vendor).toBe("smtp");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps unreachable server to dependency error", async () => {
    const adapter = createAdapter({
      host: "127.0.0.1",
      port: 65000,
    });
    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.vendor).toBe("smtp");
    expect(health.message).toBeDefined();
  });
});
