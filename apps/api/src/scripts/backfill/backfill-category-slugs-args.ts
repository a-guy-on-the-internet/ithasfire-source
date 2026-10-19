/**
 * Argument parsing and the remote-host guard for backfill-category-slugs.ts,
 * kept free of database imports so a test can load them.
 */
import { parseArgs } from "node:util";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
]);

export type BackfillArgs = { apply: boolean; confirmRemoteHost?: string };

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: "boolean", default: false },
      "confirm-remote-host": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    apply: values.apply === true,
    confirmRemoteHost: values["confirm-remote-host"],
  };
}

export function resolveDbHost(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL");
  }
}

/** Throws unless the run may write to `host`. A dry run is always allowed. */
export function assertWriteAllowed(args: BackfillArgs, host: string): void {
  if (!args.apply || LOCAL_HOSTS.has(host)) return;
  if (args.confirmRemoteHost !== host) {
    throw new Error(
      `Refusing to --apply against remote host "${host}".\n` +
        `Re-run with --confirm-remote-host=${host} if that is intended.`,
    );
  }
}
