# Migrating CI from Forgejo (git.unme.me) to GitHub

Status: **DONE — CI is live on GitHub as of 2026-08-31.** Actions enabled,
88 secrets + 23 variables loaded, `Deploy dev` green (37m), `Deploy prod` run.
Forgejo is no longer the CI host.

## HANDOFF — state as of 2026-08-28

Target repo: `a-guy-on-the-internet/Ithasfire` (PRIVATE; `Hearthfire` redirects
to it). `gh` is authed with `repo` + `workflow` scope.

DONE:
- Full history mirrored. `github/main` == local `main`. LFS objects pushed
  first (61 objects / 14MB) — GitHub's pre-receive hook rejects the ref push
  until they are there.
- `c6cafc20` — 184 `uses:` lines rewritten to GitHub short form across all 15
  workflows; the 4 Forgejo-only `/pnpm-store` steps deleted (that path does not
  exist on a hosted runner and writing it needs root).
- `a132c0ea` — repaired two workflows that the `pull_request` removal left
  dead: terraform-dev-plan's only job was gated on a PR-only expression and
  skipped on every dispatch, and ci.yml's gitleaks range degenerated to a bare
  `..`, scanning nothing while exiting 0.
- GitHub environments `dev` and `prod` already exist (24 jobs reference them).
- `github-secrets.env` (gitignored) holds **79 of 112** values, resolved from
  Secret Manager (34), local `.env` files (~28), derived identifiers (14: all
  10 Cloud Run service names + project/region/artifact repo) and Terraform
  state (3):
    GCP_WIF_PROVIDER = projects/635137958648/locations/global/workloadIdentityPools/github/providers/github
    GCP_WIF_SERVICE_ACCOUNT = github-actions@hearthfire-491918.iam.gserviceaccount.com

TODO, in order:
1. Fill the remaining 33 in `github-secrets.env` (a separate agent is doing
   this from provider dashboards). `GCP_SA_KEY` is deliberately left EMPTY —
   WIF is recovered, so the long-lived key should be retired, not migrated.
2. `./scripts/github-migration/set-secrets.sh --repo a-guy-on-the-internet/Ithasfire --dry-run`
   until `missing: 0`, then run it for real. It REFUSES a partial import, so
   any value you intend to leave blank (the Plausible/analytics ones are
   optional) needs a placeholder or the check relaxed.
3. Enable Actions on the repo. It is off right now, which is why mirroring 372
   commits triggered nothing — that is the safety catch, do not lift it early.
4. Dispatch a CHEAP workflow first (`infra-validation`) to prove auth and
   `uses:` resolution before `deploy-dev` finds out three jobs deep.

DECIDED 2026-09-11 — the split is applied, for the gate only:
The bill arrived as predicted. September ran 76 `Deploy dev` runs in 11 days and
spent 2,180 of the 2,000 free minutes; April had already cost $18.62 at 5,499
minutes. Measured per run: quality gate 21-25 min, the four image builds 35-45
min combined, typecheck 5 min, everything else ~10.

`quality_gate`, `typecheck` and `ci_coverage_guard` now run self-hosted. The
`build_*` jobs deliberately did NOT move: the ~86-minute amd64 figure above was
QEMU, and whether Rosetta changes it is a measurement, not a guess — run
`runner-smoke.yml` with `probe_amd64=true` and read the `::notice::` line before
touching them.

MEASURED on the VM, run 34655098520, everything green in 359s total:

| Step | Self-hosted | Hosted, for comparison |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 34s | — |
| `@th/ui` (83 files) | 28s | — |
| `apps/web` `test:ci` (464 files) | 74s | — |
| `typecheck:all` (6 tsc targets) | 174s | ~5 min as its own job |
| whole gate + typecheck | ~6 min | 26-30 min |

Peak VM memory was ~4 GiB of 11 GiB, so the per-core fork count on apps/web is
not the ceiling it looked like on paper. Nothing in the lockfile lacks a
linux-arm64 build, and `onlyBuiltDependencies: ["esbuild"]` means nothing
compiles from source at install.

The amd64 probe answered the phase-2 question: **7s**, with the container
genuinely running x86-64 (`arch x64` from `process.arch`, a 3e8-iteration loop
in 3.456s). Rosetta is nothing like the QEMU number above. That makes moving
`build_*` plausible, but a micro-benchmark is NOT a Next.js image build — time a
real one before believing it.

The runner is a Lima VM on the Mac (`~/Projects/GitHubRunner/ci-linux.yaml`),
not a container and not the host:
- Actions **service containers** are why. `quality_gate` reaches postgres and
  redis on `localhost`; sibling containers started through a mounted host socket
  publish into the docker host's namespace, so a runner-in-a-container cannot
  see them. A VM behaves like `ubuntu-latest` does.
- It runs its **own** Docker daemon. The host's Docker Desktop carries the dev
  stack, and CI container cleanup has reached peer containers before.
- Guest is pinned to **UTC**. It inherited `America/Chicago` from the host, and
  this repo resolves ambiguous DST by wall clock.
- Rebuild it with `limactl start --name=ci-linux ./ci-linux.yaml`, then register
  a runner with `--labels hf-linux` and `svc.sh install`.

**The escape hatch is the `CI_GATE_RUNNER` repo variable.** Set to `hf-linux` it
routes; cleared, the jobs fall back to `ubuntu-latest` with no commit. Use it
whenever the Mac is off — every downstream job `needs:` these two, so a sleeping
Mac stalls the whole pipeline. It stalls CLOSED (a timed-out job resolves to
`failure`, and every gate demands `success || skipped`), but `notify` is muted
by `false &&`, so it stalls QUIETLY — the run sits yellow and reads as "still
building". That is the same shape as the 11-day Forgejo outage below, so treat a
quiet pipeline as suspect and check the runner is online first.

Set ONE label: the expression yields a string, not a label set, so
`"self-hosted,hf-linux"` is read as a single literal label and matches nothing.
A typo is indistinguishable from a sleeping Mac in the UI — both show Queued.

CLEANUP — done 2026-08-31:
- [x] `github-secrets.env` overwritten and deleted.
- [x] `main-rescue-0825` deleted from Forgejo (verified every commit on it was
      already contained in GitHub's `main` first).
- [x] The 4.6G `hf-gate` scratch worktree removed.
- [ ] **STILL OWED — revoke `roles/secretmanager.secretAccessor` from
      `sad-mans-computer@hearthfire-491918.iam.gserviceaccount.com`.** It was
      granted so the migration pull could read Secret Manager, and that laptop
      identity can currently read every production secret. It cannot revoke
      itself (no `setIamPolicy`), so do it in the console:
      https://console.cloud.google.com/iam-admin/iam?project=hearthfire-491918
      CI is unaffected — it runs as `github-actions@`, which holds
      `roles/secretmanager.admin` independently.
- [x] **OIDC done.** All 36 auth steps now use `workload_identity_provider` +
      `service_account`; ZERO `GCP_SA_KEY` references remain and every
      authenticating workflow carries `id-token: write`. The WIF provider's
      trust condition is scoped to
      `attribute.repository == "a-guy-on-the-internet/Ithasfire"` for
      pull_request / workflow_dispatch / schedule / push-on-main, which matches
      the triggers in use. The long-lived JSON key is retired, not merely
      unused.
- [x] `origin` now points at GitHub; Forgejo demoted to the `forgejo` remote and
      `main` tracks `origin/main`.
- [x] Forgejo runner decommissioned with `docker compose down` (NOT `stop` —
      `restart: always` would have brought it back on the next Docker restart).
      The `forgejo-runner-data` volume is kept, so `docker compose up -d`
      restores it still registered.
- [x] `secretmanager.secretAccessor` revoked from `sad-mans-computer@`, verified
      by attempting a real secret read and getting PERMISSION_DENIED.

FORGEJO, for context on why this happened: `refs/heads/main` is still frozen at
`d0bd5126` and unwritable by push OR server-side merge — a stale
`refs/heads/main.lock` on the host, fixable only with shell access there.
Everything since routed through `main-rescue-0825` via workflow_dispatch,
because `actions/checkout` takes the TRIGGERING ref.

## Why

Three deploy-blocking failures came out of the Forgejo instance in one week:

1. `mac-runner` reported `idle` to the server while failing **every** task fetch
   for 11 days (`fetch_timeout: 5s` against a server whose declare handshake
   measured 24s). Dev deploys stopped with no error anywhere but that log.
2. Multi-commit pushes returned HTTP 500 while the refs actually landed — the
   post-receive hook timed out *after* updating refs, so pushes "failed" and
   succeeded at once.
3. `refs/heads/main` became permanently unwritable (`reference already
   exists`). Not a DB desync — the branch table and git agree, and repo
   settings writes succeed. It is a **stale `refs/heads/main.lock`** in the bare
   repo, and clearing it needs shell access to the host. Six days of retries
   changed nothing, and it blocked a production deploy.

The decisive operational cost, though, is that **Forgejo has no Actions logs
API** (confirmed against its own `swagger.v1.json`). Diagnosing a failed run
means reconstructing it from workflow definitions. On GitHub it is
`gh run view --log`.

## Cost

- **CORRECTED 2026-08-28 — this is not $0.** The earlier estimate assumed a
  PUBLIC repo (the Forgejo one is public); the GitHub target is **PRIVATE**.
  Self-hosted minutes are free on any plan, but GitHub-HOSTED minutes on a
  private repo are metered: 2,000/month free, then ~$0.008/min for Linux. All
  49 jobs are currently `runs-on: ubuntu-latest`, i.e. GitHub-hosted. LFS is
  fine either way — 131MB against a 1GB allowance, and `actions/checkout`
  defaults to `lfs: false`, so CI never pulls it.
- **One thing to verify against current pricing:** the workflows use
  `environment:` in 24 places. Environment *secrets* on **private** repos have
  historically required a paid plan (Team, $4/user/mo). Check before relying on
  them.
- **Effort: 1.5–3 days**, dominated by re-sourcing 91 secrets, not by YAML.

## The parts

| Path | What it does |
| --- | --- |
| `rewrite-workflow-uses.mjs` | Rewrites the 184 `uses:` lines. **Cutover-only** — see below. `--dry-run`, `--reverse`. |
| `secrets.inventory.tsv` | 91 secrets → scope (dev/prod/shared) → which workflows use each. Generated from the workflows. |
| `vars.inventory.tsv` | 24 variables → which workflows use each. |
| `secrets.env.example` | Every name, no values. Copy to `github-secrets.env` (gitignored) and fill in. |
| `set-secrets.sh` | Pushes them via `gh`. Values go over stdin, never argv, never echoed. Refuses partial imports. |

### The `uses:` rewrite is cutover-only

Forgejo resolves a bare `actions/checkout@v4` against its own
`DEFAULT_ACTIONS_URL` (code.forgejo.org), **not** github.com. That is why all
184 carry the full URL. Running the rewrite while Forgejo is still the CI host
breaks every workflow at once. Run it in the same commit that cuts over, and
keep `--reverse` in your pocket.

### Secrets cannot be exported

Forgejo secrets are write-only. All 91 must be re-sourced from the providers
(GCP, Stripe, Apple, Cloudflare, AWS, Neon, Upstash, Resend, Sentry, Azure,
ZipTax). This is the expensive step and the one that can cause an incident — a
wrong `STRIPE_SECRET_KEY_PROD` is a production payments failure. Do it
deliberately, and use `--dry-run` until `missing: 0`.

You will be at **91 repo secrets against GitHub's 100-per-repo cap.** The 24
`_DEV` / 24 `_PROD` pairs could become environment secrets, which relieves the
cap and is better hygiene — but it means editing every `secrets.FOO_DEV`
reference to `secrets.FOO`, so treat it as a follow-up, not part of the
cutover.

## Order of operations

1. Decide repo ownership. The existing GitHub remote is a personal account
   (`a-guy-on-the-internet/Hearthfire`) whose `main` is stale. Ownership
   determines secret scoping and access.
2. **Keep the repo private, or keep PR triggers off.** The self-hosted runner
   is the dev workstation: it bind-mounts `/var/run/docker.sock` into every job
   container and holds the dev Postgres and GCP credentials. Public repo + fork
   PRs + self-hosted runner = arbitrary code execution on that machine. The
   `pull_request` triggers were removed on 2026-08-25 for exactly this reason;
   re-adding them on a public repo re-opens it.
3. Mirror the history: `git push github main` (187MB, unremarkable).
4. Fill `github-secrets.env`; `set-secrets.sh --dry-run` until `missing: 0`;
   then run it for real.
5. Install and register `actions/runner`. It is **not** act_runner — the
   `ForgejoRunner/config.yaml` tuning has to be re-created: `capacity: 2` (5
   starved the build fan-out), the `/pnpm-store` bind mount that replaces
   `actions/cache@v4` (which hangs without a cache backend), and the shared
   `forgejo-runner-jobs` docker network. Also raise the equivalent of
   `fetch_timeout` if the host is ever slow — that is what caused the 11-day
   outage.
6. Run `rewrite-workflow-uses.mjs`, commit, push.
7. Prefer OIDC over the SA key: `GCP_WIF_PROVIDER` / `GCP_WIF_SERVICE_ACCOUNT`
   already exist and are used in 2 places, against 36 uses of
   `credentials_json`. GitHub's OIDC → GCP WIF is well-trodden and lets
   `GCP_SA_KEY` be retired.
8. Verify on **dev** end to end before pointing anything at prod.

## Carry these bugs with you — migration does not fix them

- **`deploy-prod` takes its schema from one place and its code from another.**
  `migrate_db` checks out the triggering ref (no `ref:` pin), while
  `deploy_prod` re-tags whatever built `api:dev`. When those diverge, the
  promoted image needs migrations the DB lacks, `/health` returns 503, the
  Cloud Run startup probe fails, and the roll dies three jobs deep. This
  happened on 2026-08-24 (run #706) because `main` was frozen 24 commits behind
  the tree that built `:dev`. Pin the ref, or assert the promoted image's
  commit matches the migrated tree, and fail loudly at the top of the run.
- **One Mac is still one Mac.** Same `capacity: 2`, same ~40-minute gate. Under
  load the adapters integration tests fail with `P1017 Server has closed the
  connection` out of `prisma migrate deploy` — environmental, not a defect, and
  it follows you.
- `pnpm run <script> -- <flags>` still silently drops everything after `--`.
- Root `pnpm exec tsc --noEmit` is still a no-op, and `pnpm typecheck` still
  excludes `apps/**`. See CLAUDE.md's "Gates That Look Real And Are Not".

## Rollback

Until DNS-level changes are made, nothing is one-way. Forgejo keeps working
throughout; `rewrite-workflow-uses.mjs --reverse` restores the Forgejo `uses:`
form, and the `origin` remote is untouched. The point of no return is retiring
the Forgejo runner — do that only after a full green deploy-dev **and** a green
deploy-prod on GitHub.
