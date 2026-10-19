// THE target list for whole-monorepo typechecking. Extracted from
// scripts/typecheck-all.mjs so that `pnpm typecheck:all` (which CI runs) and
// scripts/tsc-daemon.mjs cannot drift apart: a daemon that watches a different
// set of projects than CI checks is a daemon that lies.
//
// scripts/typecheck-all.mjs remains the authority on HOW targets are run
// (one `pnpm` child per target, all failures collected). This module is only
// the list.

// EVERY app under apps/ is here. Two joined on 2026-09-29: mobile, once its
// duplicate @types/react identity was pinned out (see its tsconfig), and mcp,
// which was already clean and had simply never been listed. A new app goes on
// this list the day it gets a tsconfig. An app that goes red gets FIXED — not
// removed from this list and not wrapped in a `|| true`; dropping a target is
// how the gate quietly stops meaning anything.
const APPS = ["api", "web", "jobs", "audio-transcoder", "scanner", "mobile", "mcp"];

/** Where incremental build info and daemon state live. Already gitignored, so
 *  nothing here shows up as untracked for the other sessions sharing this
 *  checkout. */
export const CACHE_DIR = "node_modules/.cache/tsc-daemon";

export const TYPECHECK_TARGETS = [
  {
    key: "packages",
    name: "packages (tsconfig.base.json)",
    // `pnpm typecheck` carries `--incremental --tsBuildInfoFile
    // node_modules/.cache/tsc-daemon/packages.tsbuildinfo` (package.json).
    // That lives on the command line rather than inside tsconfig.base.json
    // because `tsBuildInfoFile` is INHERITED through `extends`, and three
    // configs extend this one — apps/web, packages/web-rn-shims and
    // tsconfig.all.json. They would each resolve to the same buildinfo and
    // stomp the packages cache with a different program's file list.
    // KEEP THIS PATH IN SYNC with the `typecheck` script in package.json.
    pnpmArgs: ["typecheck"],
    project: "tsconfig.base.json",
    sourceRoots: ["packages", "tsconfig.base.json"],
  },
  ...APPS.map((app) => ({
    key: `apps-${app}`,
    name: `apps/${app}`,
    pnpmArgs: ["-F", app, "exec", "tsc", "-p", "tsconfig.json", "--noEmit"],
    project: `apps/${app}/tsconfig.json`,
    // Every app compiles packages/** through its path mappings, so a package
    // edit legitimately invalidates the app's last result.
    sourceRoots: [`apps/${app}`, "packages"],
  })),
];

export function targetByKey(key) {
  return TYPECHECK_TARGETS.find((t) => t.key === key);
}
