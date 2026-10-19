import { GoogleAuth } from "google-auth-library";

import type { TranslatorPort } from "@th/ports/translator";

/**
 * `TranslatorPort` on Cloud Translation (v3 REST, Basic edition).
 *
 * AUTH: Application Default Credentials, the same mechanism as
 * `CloudTasksScheduler` (one `GoogleAuth` per instance, which caches and
 * refreshes the token; the metadata server on Cloud Run). The API's service
 * account needs `roles/cloudtranslate.user` and the
 * `translate.googleapis.com` API (infra/terraform/translation.tf).
 *
 * PROJECT: `projectId` comes from the constructor; the composition root
 * passes `GCP_PROJECT_ID`.
 *
 * `mimeType: "text/plain"` is REQUIRED. The default is `text/html`, which
 * HTML-escapes the answer ("Comida &amp; bebida").
 *
 * One request per target locale (the v3 call takes a single target). A
 * failed request rejects the whole call; the caller treats translation as
 * optional and reports the failure.
 */
export type GoogleCloudTranslationAdapterOptions = {
  projectId: string;
  /** Test seam. Defaults to ADC. */
  getAccessToken?: () => Promise<string | null | undefined>;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 5s. */
  timeoutMs?: number;
};

export const GOOGLE_TRANSLATION_DEFAULT_TIMEOUT_MS = 5_000;

const TRANSLATION_API = "https://translation.googleapis.com/v3";

export class GoogleCloudTranslationAdapter implements TranslatorPort {
  private readonly projectId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken: () => Promise<string | null | undefined>;
  private readonly timeoutMs: number;

  constructor(options: GoogleCloudTranslationAdapterOptions) {
    this.projectId = options.projectId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? GOOGLE_TRANSLATION_DEFAULT_TIMEOUT_MS;
    if (options.getAccessToken) {
      this.getAccessToken = options.getAccessToken;
    } else {
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      this.getAccessToken = async () => {
        const client = await auth.getClient();
        return (await client.getAccessToken())?.token;
      };
    }
  }

  async translate(input: {
    text: string;
    source: string;
    targets: string[];
  }): Promise<Record<string, string>> {
    const targets = [...new Set(input.targets)].filter(
      (target) => target !== input.source,
    );
    if (targets.length === 0) return {};

    const token = await this.tokenWithinTimeout();
    if (!token) {
      throw new Error("google translation: no access token");
    }

    const entries = await Promise.all(
      targets.map(async (target) => {
        const translated = await this.translateOne(
          token,
          input.text,
          input.source,
          target,
        );
        return [target, translated] as const;
      }),
    );

    const out: Record<string, string> = {};
    for (const [target, translated] of entries) {
      if (translated !== undefined && translated.trim().length > 0) {
        out[target] = translated;
      }
    }
    return out;
  }

  /** The token fetch gets the same bound as a request (ADC can stall). */
  private async tokenWithinTimeout(): Promise<string | null | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.getAccessToken(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("google translation: access token timed out")),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async translateOne(
    token: string,
    text: string,
    source: string,
    target: string,
  ): Promise<string | undefined> {
    const res = await this.fetchImpl(
      `${TRANSLATION_API}/projects/${encodeURIComponent(this.projectId)}/locations/global:translateText`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          contents: [text],
          sourceLanguageCode: source,
          targetLanguageCode: target,
          mimeType: "text/plain",
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok) {
      // Status only: the body can echo the request text.
      throw new Error(
        `google translation: translateText to "${target}" failed with HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as {
      translations?: Array<{ translatedText?: string }>;
    };
    return json.translations?.[0]?.translatedText;
  }
}
