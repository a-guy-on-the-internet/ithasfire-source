import {
  isKnownError,
  toDependencyFailed,
  toTransient,
} from "@th/core/lib/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";

export type DependencyGuardOptions = {
  actionPrefix?: string;
  classifyTransient?: (error: unknown) => boolean;
};

const proxyCache = new WeakMap<object, object>();

const repoKeys = [
  "humans",
  "events",
  "orders",
  "tickets",
  "payoutTerms",
  "feePolicies",
  "splits",
  "payees",
  "settlements",
  "resaleListings",
  "idempotency",
  "audit",
  "authz",
  "apiKeys",
  "organizations",
  "places",
  "savedLocations",
] as const satisfies readonly (keyof TxRepos)[];

type RepoKey = (typeof repoKeys)[number];

const stringifyProperty = (prop: PropertyKey): string =>
  typeof prop === "symbol"
    ? (prop.description ?? prop.toString())
    : String(prop);

function guardRepoByKey<K extends RepoKey>(
  key: K,
  repo: TxRepos[K],
  logger?: LoggerPort,
  options?: DependencyGuardOptions,
): TxRepos[K] {
  if (!repo) {
    return repo;
  }
  return withDependencyGuard(String(key), repo, logger, options);
}

function guardTxRepos(
  txRepos: TxRepos,
  logger?: LoggerPort,
  config?: Partial<Record<RepoKey, DependencyGuardOptions>>,
): TxRepos {
  const guarded = { ...txRepos } as TxRepos;
  const guardedRecord = guarded as unknown as Record<string, unknown>;
  const sourceRecord = txRepos as unknown as Record<string, unknown>;
  for (const key of repoKeys) {
    if (key in txRepos) {
      const repo = sourceRecord[key as string] as
        | TxRepos[typeof key]
        | undefined;
      if (repo) {
        guardedRecord[key as string] = guardRepoByKey(
          key,
          repo,
          logger,
          config?.[key],
        );
      }
    }
  }
  return guarded;
}

export function withDependencyGuard<T extends object>(
  repoName: string,
  repo: T,
  logger?: LoggerPort,
  options?: DependencyGuardOptions,
): T {
  if (proxyCache.has(repo)) {
    return proxyCache.get(repo) as T;
  }

  const methodCache = new Map<PropertyKey, unknown>();
  const actionPrefix = options?.actionPrefix ?? repoName;

  const proxy = new Proxy(repo, {
    get(target, prop, receiver) {
      if (methodCache.has(prop)) {
        return methodCache.get(prop);
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      const wrapped = async (...args: unknown[]) => {
        try {
          const outcome = Reflect.apply(
            value as (...args: unknown[]) => unknown,
            target,
            args,
          );
          return await outcome;
        } catch (error) {
          if (isKnownError(error)) {
            throw error;
          }

          const methodName = stringifyProperty(prop);
          const action = `${actionPrefix}.${methodName}`;
          const transient = options?.classifyTransient?.(error) === true;

          logger?.error("dependency_error", {
            repo: repoName,
            action,
            method: methodName,
            transient,
            errName: error instanceof Error ? error.name : typeof error,
            errMsg: error instanceof Error ? error.message : String(error),
          });

          if (transient) {
            throw toTransient(action, error);
          }

          throw toDependencyFailed(action, error);
        }
      };

      methodCache.set(prop, wrapped);
      return wrapped;
    },
  });

  proxyCache.set(repo, proxy);
  return proxy as T;
}

export function withGuardedRepos(
  repos: Repos,
  logger?: LoggerPort,
  config?: Partial<Record<RepoKey, DependencyGuardOptions>>,
): Repos {
  const guarded = { ...repos } as Repos;
  const guardedRecord = guarded as unknown as Record<string, unknown>;
  const sourceRecord = repos as unknown as Record<string, unknown>;
  for (const key of repoKeys) {
    const repo = sourceRecord[key as string] as TxRepos[typeof key] | undefined;
    if (repo) {
      guardedRecord[key as string] = guardRepoByKey(
        key,
        repo,
        logger,
        config?.[key],
      );
    }
  }

  guarded.tx = async <T>(fn: (tx: TxRepos) => Promise<T>, options?: TxOptions) =>
    repos.tx(async (tx) => fn(guardTxRepos(tx, logger, config)), options);

  return guarded;
}
