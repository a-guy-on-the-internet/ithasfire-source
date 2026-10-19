import { expect, type APIRequestContext } from "@playwright/test";

const DEFAULT_MAILPIT_API_URL = "http://127.0.0.1:8025";

type MailpitMessageAddress = {
  Address?: string;
  Name?: string;
};

type MailpitMessageSummary = {
  ID: string;
  From?: MailpitMessageAddress;
  To?: MailpitMessageAddress[];
  Subject?: string;
  Created?: string;
};

type MailpitMessageDetails = MailpitMessageSummary & {
  Text?: string;
  HTML?: string;
  Headers?: Record<string, string[]>;
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

async function fetchJson<T>(
  request: APIRequestContext,
  url: string,
): Promise<T> {
  const res = await request.get(url);
  const bodyText = await res.text();
  if (!res.ok()) {
    throw new Error(`Mailpit request failed (${res.status()}): ${bodyText}`);
  }
  return bodyText ? (JSON.parse(bodyText) as T) : ({} as T);
}

export type CreateMailpitClientInput = {
  request: APIRequestContext;
  baseUrl?: string;
};

export function createMailpitClient({
  request,
  baseUrl,
}: CreateMailpitClientInput) {
  const origin = stripTrailingSlash(
    baseUrl ?? process.env.MAILPIT_API_URL ?? DEFAULT_MAILPIT_API_URL,
  );

  return {
    origin,

    async ready(): Promise<void> {
      // Mailpit doesn't have a dedicated health endpoint; list messages is enough.
      await fetchJson<{ messages?: MailpitMessageSummary[] }>(
        request,
        `${origin}/api/v1/messages`,
      );
    },

    async clear(): Promise<void> {
      await request.delete(`${origin}/api/v1/messages`);
    },

    async list(): Promise<MailpitMessageSummary[]> {
      const data = await fetchJson<{ messages?: MailpitMessageSummary[] }>(
        request,
        `${origin}/api/v1/messages`,
      );
      return data.messages ?? [];
    },

    async get(id: string): Promise<MailpitMessageDetails> {
      return fetchJson<MailpitMessageDetails>(
        request,
        `${origin}/api/v1/message/${id}`,
      );
    },

    async waitForEmailTo(
      toEmail: string,
      opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
      },
    ): Promise<MailpitMessageDetails> {
      const timeoutMs = opts?.timeoutMs ?? 15_000;
      const pollIntervalMs = opts?.pollIntervalMs ?? 250;
      const deadline = Date.now() + timeoutMs;

      const matchesToEmail = (msg: MailpitMessageSummary): boolean =>
        (msg.To ?? []).some(
          (addr) =>
            (addr.Address ?? "").toLowerCase() === toEmail.toLowerCase(),
        );

      while (Date.now() < deadline) {
        const messages = await this.list();
        const match = messages.find(matchesToEmail);
        if (match) {
          return this.get(match.ID);
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      throw new Error(`Timed out waiting for Mailpit email to ${toEmail}`);
    },
  };
}

export function extractFirstUrlFromMailpitMessage(
  message: Pick<MailpitMessageDetails, "Text" | "HTML">,
): string {
  const body = `${message.HTML ?? ""}\n${message.Text ?? ""}`;
  // Grab the first http(s) URL.
  const urlRegex = /https?:\/\/[^\s"'<>]+/i;
  const match = urlRegex.exec(body);
  expect(
    match,
    `Expected verification email to contain a URL, got body: ${body.slice(0, 500)}`,
  ).toBeTruthy();
  return match?.[0] ?? "";
}

/**
 * Extract a 6-digit verification code from a Mailpit message. Email
 * verification migrated from clickable links to OTP codes; sign-up specs
 * now grep the code out of the body and POST it to the OTP verify
 * endpoint instead of visiting a URL.
 */
export function extractOtpFromMailpitMessage(
  message: Pick<MailpitMessageDetails, "Text" | "HTML">,
): string {
  const body = `${message.Text ?? ""}\n${message.HTML ?? ""}`;
  // 6-digit run not adjacent to other digits; avoids accidental matches
  // inside order numbers, timestamps, etc.
  const codeRegex = /(?<![0-9])(\d{6})(?![0-9])/;
  const match = codeRegex.exec(body);
  expect(
    match,
    `Expected verification email to contain a 6-digit code, got body: ${body.slice(0, 500)}`,
  ).toBeTruthy();
  return match?.[1] ?? "";
}
