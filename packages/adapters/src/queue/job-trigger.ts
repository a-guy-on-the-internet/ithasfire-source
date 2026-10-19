import { GoogleAuth } from "google-auth-library";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import {
  DRAIN_TRIGGERS,
  type JobTriggerPort,
  type TriggeredJobName,
} from "@th/ports/job-trigger";

/**
 * Upper bound on one wake-up publish. The caller awaits it inside a user's
 * request (see `JobTriggerPort`), so it must never be able to hang one. A
 * publish that misses this is reported and left to the safety-net cron.
 */
export const JOB_TRIGGER_TIMEOUT_MS = 3_000;

type FetchFn = typeof fetch;

// ─────────────────────────────────────────────────────────────────────────────
// Pub/Sub (deployed)
// ─────────────────────────────────────────────────────────────────────────────

export type PubSubJobTriggerOptions = {
  /**
   * Everything before the topic suffix, e.g.
   * `projects/hearthfire-491918/topics/prod-`. Terraform injects it as
   * `JOB_TRIGGER_TOPIC_PREFIX` (infra/terraform/main.tf).
   */
  topicPrefix: string;
  /** Test seam. Defaults to ADC via google-auth-library (metadata server on Cloud Run). */
  getAccessToken?: () => Promise<string | null | undefined>;
  /** Test seam. */
  fetchImpl?: FetchFn;
  timeoutMs?: number;
};

/**
 * Publishes the drain's wake-up message through the Pub/Sub REST API, the same
 * way `dispatchTranscodeJob` publishes audio transcodes (no gRPC client in the
 * image). The topic's push subscription delivers the message body verbatim
 * (`no_wrapper`) to `POST /jobs/<name>` on the jobs service.
 */
export class PubSubJobTrigger implements JobTriggerPort {
  private readonly topicPrefix: string;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;
  private readonly getAccessToken: () => Promise<string | null | undefined>;

  constructor(options: PubSubJobTriggerOptions) {
    this.topicPrefix = options.topicPrefix;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? JOB_TRIGGER_TIMEOUT_MS;
    if (options.getAccessToken) {
      this.getAccessToken = options.getAccessToken;
    } else {
      // One GoogleAuth per trigger instance: it caches the client and refreshes
      // the token itself, so only the first publish per ~hour pays for a
      // metadata-server round trip.
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/pubsub"],
      });
      this.getAccessToken = async () => {
        const client = await auth.getClient();
        return (await client.getAccessToken())?.token;
      };
    }
  }

  topicFor(job: TriggeredJobName): string {
    return `${this.topicPrefix}${DRAIN_TRIGGERS[job].topic}`;
  }

  /**
   * The WHOLE hand-off — access token included — is bounded by `timeoutMs`.
   * The token fetch can hang on its own (a stalled metadata server), and some
   * callers (the jobs service re-waking a drain) call this directly rather
   * than through the outbox decorator's race.
   */
  async trigger(job: TriggeredJobName): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("job_trigger_timeout"));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([this.publish(job, controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async publish(
    job: TriggeredJobName,
    signal: AbortSignal,
  ): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) throw new Error("job_trigger_no_access_token");

    const topic = this.topicFor(job);
    const data = Buffer.from(
      JSON.stringify(DRAIN_TRIGGERS[job].payload),
    ).toString("base64");
    const res = await this.fetchImpl(
      `https://pubsub.googleapis.com/v1/${topic}:publish`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal,
        body: JSON.stringify({ messages: [{ data, attributes: { job } }] }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `job_trigger_publish_failed: ${res.status} ${body.slice(0, 300)}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct HTTP (local dev)
// ─────────────────────────────────────────────────────────────────────────────

export type HttpJobTriggerOptions = {
  jobsBaseUrl: string;
  apiKey?: string | null;
  logger: LoggerPort;
  /** A failed local wake-up is a deliberate swallow: report it (CLAUDE.md). */
  reportError?: ReporterPort;
  fetchImpl?: FetchFn;
};

/**
 * Local-dev stand-in for Pub/Sub: POSTs the same body straight at the local
 * jobs service. Deliberately NOT awaited past the hand-off — the drain runs
 * inside that request, and the local processes have no CPU throttling, so the
 * caller does not need to wait for it. Never use this on Cloud Run: under
 * `cpu_idle = true` the un-awaited request can be starved after the response.
 */
export class HttpJobTrigger implements JobTriggerPort {
  private readonly options: HttpJobTriggerOptions;
  private readonly fetchImpl: FetchFn;

  constructor(options: HttpJobTriggerOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async trigger(job: TriggeredJobName): Promise<void> {
    const base = this.options.jobsBaseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.options.apiKey) headers["X-Jobs-API-Key"] = this.options.apiKey;
    void this.fetchImpl(`${base}/jobs/${encodeURIComponent(job)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(DRAIN_TRIGGERS[job].payload),
    })
      .then(async (res) => {
        if (!res.ok) {
          this.fail(job, new Error(`job_trigger_http_non_ok: ${res.status}`));
        }
      })
      .catch((err: unknown) => this.fail(job, err));
  }

  private fail(job: TriggeredJobName, err: unknown): void {
    // The row stays queued for the scheduled safety net; the failure is
    // swallowed (nothing awaits this), so it is logged at error AND reported.
    this.options.logger.error("job_trigger_http_failed", {
      job,
      err: err instanceof Error ? err.message : String(err),
    });
    try {
      this.options.reportError?.(err, {
        tags: { area: "job-trigger", job, backend: "http" },
      });
    } catch {
      // best-effort only
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export type JobTriggerEnv = {
  /** Set on Cloud Run by Terraform. Selects Pub/Sub. */
  JOB_TRIGGER_TOPIC_PREFIX?: string;
  /** Local opt-in: `http` POSTs `JOBS_SERVICE_URL` directly. */
  JOB_TRIGGER_BACKEND?: string;
  JOBS_SERVICE_URL?: string;
  JOBS_API_KEY?: string;
  /** Deployment guards for the http backend (see `createJobTrigger`). */
  NODE_ENV?: string;
  /** Cloud Run sets this on every service. */
  K_SERVICE?: string;
};

/**
 * Pub/Sub when Terraform provided a topic prefix; direct HTTP when a developer
 * opted in locally; otherwise `null` (the scheduled safety net is the only
 * drain trigger, which is the pre-2026-09-30 behaviour).
 *
 * The http backend is REFUSED on Cloud Run (`K_SERVICE`) and in production:
 * it is fire-and-forget, which request-based CPU starves after the response,
 * and it sends no OIDC token, which the jobs service's IAM rejects. A
 * misconfigured deploy gets `null` plus an error log and report, not a
 * trigger that silently never fires.
 */
export function createJobTrigger(
  env: JobTriggerEnv,
  logger: LoggerPort,
  reportError?: ReporterPort,
): JobTriggerPort | null {
  if (env.JOB_TRIGGER_TOPIC_PREFIX) {
    return new PubSubJobTrigger({ topicPrefix: env.JOB_TRIGGER_TOPIC_PREFIX });
  }
  if (env.JOB_TRIGGER_BACKEND === "http" && env.JOBS_SERVICE_URL) {
    if (env.K_SERVICE || env.NODE_ENV === "production") {
      const err = new Error(
        "JOB_TRIGGER_BACKEND=http is local-dev only; refused on Cloud Run / in production (set JOB_TRIGGER_TOPIC_PREFIX)",
      );
      logger.error("job_trigger_http_refused", {
        kService: env.K_SERVICE ?? null,
        nodeEnv: env.NODE_ENV ?? null,
      });
      try {
        reportError?.(err, { tags: { area: "job-trigger", backend: "http" } });
      } catch {
        // best-effort only
      }
      return null;
    }
    return new HttpJobTrigger({
      jobsBaseUrl: env.JOBS_SERVICE_URL,
      apiKey: env.JOBS_API_KEY ?? null,
      logger,
      reportError,
    });
  }
  return null;
}
