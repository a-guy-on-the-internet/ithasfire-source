import type { LoggerPort } from "@th/ports/logger";
import type {
  JobTriggerPort,
  TriggeredJobName,
} from "@th/ports/job-trigger";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { JOB_TRIGGER_TIMEOUT_MS } from "../queue/job-trigger";

/**
 * Wakes an outbox's drain AFTER the write that queued work for it commits.
 *
 * ## Why a repo decorator and not a call in each use case
 *
 * Twelve use cases write these three outboxes (RSVP, cancel/reschedule/
 * unpublish/archive, community edits, call-offs, image uploads, rescans, the
 * degraded requeue), several of them through shared helpers that run inside a
 * caller's transaction. Threading a trigger through every one would put
 * "remember to wake the drain" on every future writer too. The outbox write
 * itself is the one place that cannot be forgotten, so the wake-up rides it.
 *
 * ## Commit semantics
 *
 * - Inside `repos.tx(fn)`: a triggering write only MARKS its drain. The
 *   publish happens after `repos.tx` resolves, i.e. after COMMIT. A rolled-back
 *   transaction publishes nothing, so a drain is never woken for a row that
 *   does not exist. Several writes in one transaction publish once per drain.
 * - On the root repos (autocommit, e.g. `rsvpToEvent`'s deliberately
 *   non-transactional notice insert): the row is committed when the call
 *   returns, so the publish follows immediately.
 *
 * ## Failure semantics
 *
 * The publish is awaited (the services run with request-based CPU; see
 * `JobTriggerPort`) but bounded by {@link JOB_TRIGGER_TIMEOUT_MS} and NEVER
 * throws into the caller: the write already committed, so failing the user's
 * request would report an RSVP/cancel/upload as failed when it succeeded. The
 * failure goes to `reportError` (CLAUDE.md: a deliberate swallow reports) and
 * the row stays queued for the drain's scheduled safety-net run.
 */

type TriggerRule = (result: unknown) => boolean;

const always: TriggerRule = () => true;
/** Bulk writers return how many rows they queued; zero queued nothing. */
const countPositive: TriggerRule = (result) =>
  typeof result === "number" && result > 0;

const TRIGGERING_WRITES = {
  rsvpNotices: {
    job: "community.dispatch-rsvp-confirmations",
    methods: { create: always, createDateCancelled: countPositive },
  },
  eventChangeNotices: {
    job: "events.dispatch-change-notifications",
    methods: { create: always },
  },
  imageModerationRecords: {
    job: "moderation.drain-image-moderations",
    methods: {
      create: always,
      requeueForRescan: countPositive,
      requeueDegraded: countPositive,
    },
  },
} as const satisfies Partial<
  Record<
    keyof TxRepos,
    { job: TriggeredJobName; methods: Record<string, TriggerRule> }
  >
>;

type RepoKey = keyof typeof TRIGGERING_WRITES;
const REPO_KEYS = Object.keys(TRIGGERING_WRITES) as RepoKey[];

export type OutboxDrainTriggerOptions = {
  trigger: JobTriggerPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /** Test seam. */
  timeoutMs?: number;
};

function wrapRepo<T extends object>(
  repo: T,
  key: RepoKey,
  onWrite: (job: TriggeredJobName) => Promise<void> | void,
): T {
  const { job, methods } = TRIGGERING_WRITES[key];
  const rules = methods as Record<string, TriggerRule>;
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const rule = rules[prop];
      if (!rule) return value;
      if (cache.has(prop)) return cache.get(prop);
      const wrapped = async (...args: unknown[]) => {
        const result = await Reflect.apply(
          value as (...a: unknown[]) => unknown,
          target,
          args,
        );
        if (rule(result)) await onWrite(job);
        return result;
      };
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
}

function wrapRepos<R extends TxRepos>(
  repos: R,
  onWrite: (job: TriggeredJobName) => Promise<void> | void,
): R {
  const out = { ...repos } as R;
  const record = out as unknown as Record<string, unknown>;
  for (const key of REPO_KEYS) {
    const repo = (repos as unknown as Record<string, unknown>)[key];
    if (repo && typeof repo === "object") {
      record[key] = wrapRepo(repo, key, onWrite);
    }
  }
  return out;
}

export function withOutboxDrainTriggers(
  repos: Repos,
  options: OutboxDrainTriggerOptions,
): Repos {
  const timeoutMs = options.timeoutMs ?? JOB_TRIGGER_TIMEOUT_MS;

  const publish = async (job: TriggeredJobName): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.trigger.trigger(job),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("job_trigger_timeout")),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      // The row is committed; the drain's scheduled run will pick it up.
      options.logger?.error("job_trigger_failed", { job, err });
      try {
        options.reportError?.(err, {
          tags: { area: "job-trigger", job },
          extra: {
            fallback: "row stays queued for the drain's scheduled run",
          },
        });
      } catch {
        // Best-effort: a throwing reporter must never fail the write.
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // Root repos write in autocommit: committed on return, publish now.
  const root = wrapRepos(repos, publish);

  root.tx = async <T>(
    fn: (tx: TxRepos) => Promise<T>,
    txOptions?: TxOptions,
  ): Promise<T> => {
    // Collected per transaction; published only after COMMIT.
    const pending = new Set<TriggeredJobName>();
    const result = await repos.tx(
      (tx) => fn(wrapRepos(tx, (job) => void pending.add(job))),
      txOptions,
    );
    if (pending.size > 0) {
      await Promise.all([...pending].map((job) => publish(job)));
    }
    return result;
  };

  return root;
}
