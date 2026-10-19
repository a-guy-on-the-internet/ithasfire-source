# Builder rules (every agent that edits or runs code)

`coder`, `refactor`, `mobile`, `ui` and `infra` read this before their first command. It holds the rules that come from this machine, not from the code: several Claude sessions share one working tree, one dev database and one CPU, so a command that is safe on a laptop of your own can break a peer's run.

## Shared tree

- **Git is read-only for you.** Run `git status`, `git diff`, `git log`, `git show` freely. The orchestrator stages and commits by explicit path; a file-level commit or stash from a subagent sweeps in peers' half-finished edits.
- **Kill only PIDs you started.** Record the PID when you background something and stop it by that PID. Pattern kills (`pkill -f tsc`, `docker rm` by image filter) hit peers' runs; before removing a testcontainer, check `ps -eo pid,etime,command | grep vitest` and leave it alone if another session has a live run.
- **Scratch files live in your scratchpad**, never inside a workspace package. eslint lints every file under a package, gitignored or not, and the pre-push hook lints the shared tree, so one stray `.tsx` blocks everyone's push.
- **Mutation checks run on a copy.** Watching a test fail on a planted bug is the right check; plant it in a copied file or a throwaway worktree. Planting it in place puts the bug into every peer's suite for the length of the window.

## Load

- **One suite at a time.** Wait for a run to finish before starting the next; overlapping vitest runs have swapped this machine out and taken the dev stack down.
- **Return the signal, not the dump.** Pipe tests, typecheck, lint and build through `2>&1 | tail -40`, or `grep -E 'FAIL|error|✗'` plus the summary line; use vitest `--reporter=dot` for full suites. Read files by range. Write long output to your scratchpad and report the path.

## Gates

- **Typecheck is two commands.** `pnpm typecheck` covers `packages/**` only and skips every test file. Add `pnpm typecheck:<api|web|jobs|mobile|scanner>` for each app you touched. These scripts, `vitest run` and playwright queue machine-wide (`gate: queued (<weight>) behind PID …`; `pnpm gate:status` shows the holders) and can wait tens of minutes, so give them a long timeout or run them in the background. Bare `tsc` skips the queue. Bare `pnpm exec tsc --noEmit` at the repo root checks nothing.
- `apps/audio-transcoder` and `apps/mcp` have no root script: run `bash scripts/dev/with-gate-lock.sh pnpm -F <app> exec tsc -p tsconfig.json --noEmit`.
- **`apps/api/test/**` has no typecheck at all**; vitest is its only gate.
- **Prisma client: `pnpm -F @th/db run generate`**, the one form that is right from any directory. A bare `prisma generate` picks its schema by cwd: from the repo root `prisma.config.ts` points it at all of `packages/db/prisma/`, but from `packages/db/` it reads one file and writes a model-less client into the shared `node_modules`, which kills every session's API.

## Dev database

- The real dev DB is `[::1]:5432`. `127.0.0.1:5432` can be a CI job's empty Postgres forwarded by lima. psql takes `@[::1]:5432`; node `pg` and Prisma need `&host=::1` on the URL instead.
- Seeds, `migrate reset`, e2e runs without `E2E_USE_LIVE_STACK=1`, and anything that deletes rows run only when your prompt asks for them by name. They wipe the data every other session is driving.

## Report

Tag each load-bearing claim in your report:

- `[VERIFIED: <exact command>]` with the relevant output pasted;
- `[REASONED]` when you derived it by reading code. That is a hypothesis about runtime behaviour, and the orchestrator will treat it as one.
