/**
 * Mailpit client for the Appium e2e harness.
 *
 * Mirrors `apps/web/e2e/helpers/mailpit.ts` but uses the global `fetch` so it
 * works under plain Node/Mocha (no Playwright APIRequestContext).
 *
 * Mailpit (https://mailpit.axllent.org/) is an SMTP testing server that runs
 * in `infra/docker/docker-compose.yml`. The API on the same instance maintains
 * a JSON API at http://127.0.0.1:8025/api/v1.
 *
 * Use this to drive realistic magic-link flows end-to-end:
 *   1. UI taps "Send magic link" -> API hits Better Auth -> SMTP into Mailpit.
 *   2. Test polls Mailpit for the email to the test address.
 *   3. Test extracts the verify URL and opens it in the simulator, which then
 *      redirects through Safari into the scanner app via its custom scheme.
 */

const DEFAULT_MAILPIT_API_URL = "http://127.0.0.1:8025";

const stripTrailingSlash = (value) => value.replace(/\/+$/, "");

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `Mailpit request failed (${res.status}) for ${url}: ${bodyText}`,
    );
  }
  return bodyText ? JSON.parse(bodyText) : {};
}

export function createMailpitClient({ baseUrl } = {}) {
  const origin = stripTrailingSlash(
    baseUrl ??
      process.env.E2E_MAILPIT_URL ??
      process.env.MAILPIT_API_URL ??
      DEFAULT_MAILPIT_API_URL,
  );

  return {
    origin,

    async ready() {
      // Mailpit has no dedicated health endpoint; listing messages confirms
      // the API is reachable.
      await fetchJson(`${origin}/api/v1/messages`);
    },

    async clear() {
      const res = await fetch(`${origin}/api/v1/messages`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Mailpit clear failed (${res.status}): ${body}`);
      }
    },

    async list() {
      const data = await fetchJson(`${origin}/api/v1/messages`);
      return data.messages ?? [];
    },

    async get(id) {
      return fetchJson(`${origin}/api/v1/message/${id}`);
    },

    /**
     * Poll Mailpit until a message arrives addressed to `toEmail`.
     *
     * Mailpit returns messages newest-first, so we always pick the most recent
     * matching message. Comparison is case-insensitive — Better Auth normalises
     * recipient emails before send.
     */
    async waitForEmailTo(toEmail, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 20_000;
      const pollIntervalMs = opts.pollIntervalMs ?? 500;
      const subjectIncludes = opts.subjectIncludes; // optional substring filter
      const sinceTimestamp = opts.sinceTimestamp ?? 0;
      const deadline = Date.now() + timeoutMs;
      const target = toEmail.toLowerCase();

      const matches = (msg) => {
        const toAddrs = msg.To ?? [];
        const toMatch = toAddrs.some(
          (addr) => (addr.Address ?? "").toLowerCase() === target,
        );
        if (!toMatch) return false;
        if (subjectIncludes) {
          const haystack = (msg.Subject ?? "").toLowerCase();
          if (!haystack.includes(subjectIncludes.toLowerCase())) return false;
        }
        if (sinceTimestamp) {
          const created = msg.Created ? Date.parse(msg.Created) : 0;
          if (!Number.isFinite(created) || created < sinceTimestamp)
            return false;
        }
        return true;
      };

      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const messages = await this.list();
          const hit = messages.find(matches);
          if (hit) return this.get(hit.ID);
        } catch (error) {
          lastError = error;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      const suffix = lastError ? ` (last error: ${lastError.message})` : "";
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for Mailpit email to ${toEmail}${suffix}. ` +
          `Verify Mailpit is running (docker compose up -d mailpit) and the API SMTP_* env vars point at it.`,
      );
    },
  };
}

/**
 * Extract the Better Auth magic-link verify URL from a Mailpit message.
 *
 * The plain-text part of the email is canonical — the API explicitly emits a
 * text body with the URL on its own line, so we scan it first. We only fall
 * back to the HTML part (with `&amp;` decoded) when the text part is absent
 * or doesn't contain a verify URL. We require the URL to contain
 * `/api/auth/magic-link/verify` so we don't accidentally pick up a logo /
 * footer / help-center link from the HTML template.
 */
export function extractMagicLinkUrlFromMailpitMessage(message) {
  const verifyRegex =
    /https?:\/\/[^\s"'<>]+\/api\/auth\/magic-link\/verify[^\s"'<>]*/i;
  const candidates = [];
  if (typeof message.Text === "string" && message.Text.length > 0) {
    candidates.push(message.Text);
  }
  if (typeof message.HTML === "string" && message.HTML.length > 0) {
    // HTML href attributes encode `&` as `&amp;`. Decode before matching so
    // the resulting URL has the real query separators.
    candidates.push(message.HTML.replace(/&amp;/g, "&"));
  }

  for (const body of candidates) {
    const match = verifyRegex.exec(body);
    if (match) {
      return match[0].replace(/[)\].,;:]+$/, "");
    }
  }

  const preview = (message.Text ?? message.HTML ?? "").slice(0, 500);
  throw new Error(
    `Magic-link email did not contain a /api/auth/magic-link/verify URL. Body preview: ${preview}`,
  );
}
