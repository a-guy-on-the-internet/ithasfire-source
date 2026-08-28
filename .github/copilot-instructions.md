````instructions
# Ithas Fire Copilot Instructions

## Mission-critical context
- Monorepo managed with **pnpm workspaces** and **Turborepo**. All packages are TypeScript (`"type": "module"`) with strict settings and project references in `tsconfig.base.json`.
- Hexagonal architecture:
  - `packages/core` holds pure use cases (business logic) that depend only on ports and shared types.
  - `packages/ports` defines interfaces; `packages/adapters` implements them (Prisma repos, Stripe, Redis, etc.).
  - `packages/transport/trpc` exposes use cases over tRPC; `apps/api` bootstraps Fastify + transports; `apps/web` is a Next.js client; `apps/mobile` and `apps/scanner` are Expo/React Native surfaces.
- Critical docs: `docs/engineering-standards.md`, `docs/backend-usecase-creation-process.md`, `docs/hot-paths.md`, and `docs/db-setup.md`. Reference them before making architectural changes.
- For any external tech, package, or tool guidance, fetch the latest documentation through Context7 before relying on memory.

### Local dev helper scripts
- `pnpm api:bg` / `api:bg:status` / `api:bg:stop`: manage the Fastify server in a detached background process. PID lives in `.tmp/api-dev.pid` and each run appends logs to `logs/dev/api/api-<timestamp>.log` (tail with `tail -f logs/dev/api/<file>.log`).
- `pnpm web:dev:local`: wraps `pnpm -F web dev`, ensuring `WEB_API_BASE_URL` is set (defaults to `http://localhost:3001`; override via `--base` or env).
- `pnpm stack:dev`: sequentially runs the detached API helper and then boots the web helper so the UI always points at the freshly started API.
- `pnpm mobile`: runs `pnpm -F mobile start`. Export `EXPO_PUBLIC_API_BASE_URL` (defaults to `http://localhost:3001`) before launching, optionally set `EXPO_PUBLIC_STORYBOOK=1` for Storybook, and pass extra Expo CLI flags after `--` (e.g., `pnpm mobile -- --tunnel`).
- `pnpm vitest:bg --dir <path>` / `pnpm vitest:bg:stop --label <label>`: run Vitest in watch or run-once mode for any workspace with logs + PID management under `logs/dev/tests`. Default labels mirror the relative directory (override with `--label`).

- **You always have terminal access.** Never ask if terminal is available — just run the command. If a tool call fails, retry or find another way. Do not stall asking the user for permission to use the terminal.
- Avoid emitting extremely large heredocs directly to the console (for example, using `cat <<'EOF'` to write very large content into a file). Massive heredocs can break or render the console poorly when piping them into files with `cat`; instead write the content to a temporary file, use chunked writes, or log a concise summary.
- **`psql` uses a pager by default.** Always pass `--no-pager` or prepend `PAGER=cat` (e.g., `PAGER=cat psql ...`) when running `psql` commands from scripts or automated tooling. Otherwise the output hangs waiting for user interaction.

### Tone & formatting
- **Be judicious with emojis.** Use them sparingly in user-facing copy (toasts, labels, empty states) only when they add genuine clarity — e.g., a single warning icon in an error banner. Avoid emoji clusters, decorative emojis in headings, or emojis that duplicate an already-present icon. Code comments, PR descriptions, and commit messages should be emoji-free.

## Picking up a task
1. Locate the relevant package (`packages/*` for shared logic, `apps/*` for product surfaces). Follow exports maps—never import from `dist/`.
2. Read adjacent files and schemas before editing. For new use cases, fill out the template in `docs/backend-usecase-creation-process.md` and colocate tests in the same folder (`<use-case>.test.ts`).
3. Prefer small, composable changes. If a task impacts multiple layers (core → adapter → transport), touch each layer in isolation and add integration tests where feasible.

## Architecture guardrails
- **Use cases** must:
  - Accept raw input, parse via Zod, and throw typed errors `{ code: "invalid_input" | ... }` as enumerated in standards.
  - Depend only on ports (`@th/ports`). No direct Prisma, Stripe, or transport imports.
  - Run exactly one `repos.tx()` per mutation and commit audit logs within that transaction.
  - Wrap monetary logic with deterministic helpers (see `packages/core/src/lib/pricing`). Money values are bigint cents or integers—no floats.
  - Use idempotency (`IdempotencyPort`) for any externally-triggered or money-moving flow. Reuse existing key patterns (see `create-checkout.ts`).
- **Adapters** implement ports and may touch external services, but must return repo DTOs (never Prisma models) and stay side-effect focused.
- **Transports** (tRPC, Fastify) are thin: parse inputs, invoke use cases, map errors. Never embed business logic or database calls.
- Follow naming conventions: files kebab-case, types/classes PascalCase, functions camelCase. Append `.port.ts` for interfaces and `-adapter.ts` for implementations.

## Database & Prisma workflow
- Default Postgres + Redis for local dev via Docker Compose:
  ```bash
  cd infra/docker
  docker compose up -d
  ```
  Connection string example: `postgresql://postgres:postgres@localhost:5432/dev?schema=public`.
- After changing any `.prisma` file in `packages/db/prisma/`:
  1. Validate: `pnpm db:validate`.
  2. Generate client: `pnpm -F @th/db prisma generate`.
  3. Create migration (if needed): `pnpm -C packages/db prisma migrate dev --name <description>` (ensure `DATABASE_URL` is set).
  4. Smoke test: `cd packages/db && node test-smoke.js` (with `DATABASE_URL`).
- Never bypass Prisma migrate for schema changes. Document breaking alterations in PR descriptions.

## Testing & validation
When you touch code, run the narrowest set of checks that covers your changes and note the commands in your summary.

| Scenario | Commands |
| --- | --- |
| Global sanity | `pnpm build`, `pnpm -w tsc -p tsconfig.base.json`, `pnpm lint` (treat warnings as failures even though CI uses `|| true`). |
| Prisma/schema work | `pnpm db:validate`, `pnpm -F @th/db prisma generate`. |
| Core/business logic | `pnpm -C packages/core vitest --run` (or `pnpm -F @th/core exec vitest --run`). |
| Adapter integrations | Add/update integration specs under `packages/adapters/test` and run `pnpm -C packages/adapters vitest --run`. |
| API smoke | `pnpm -F api run smoke` (requires local infra + env). |

Always add or update tests alongside feature or bugfix work. For new use cases, include retry/idempotency edge cases and money math invariants.

### Testing expectations
- Prefer the helper scripts when possible so logs + PID files stay consistent: `pnpm vitest:bg --dir packages/core` (watch) or add `--once` for single runs, then `pnpm vitest:bg:stop --label packages-core` to tear them down.
- Document the exact command(s) you ran in summaries/PRs (e.g., "`pnpm vitest:bg --dir packages/ports --once`").
- When a package exposes its own convenience script (`pnpm -F api run smoke`, etc.), use that rather than ad-hoc `pnpm` invocations so future readers know how to reproduce the result.
- If you spin up detached services (API, mobile, etc.), mention the helper you used (`pnpm api:bg`, `pnpm mobile`) and where logs live so others can audit failures.

### E2E (Playwright) testing
- E2E specs live in `apps/web/e2e/`. Run a specific spec with:
  ```bash
  pnpm -F web exec playwright test e2e/<spec-name>.spec.ts --project=chromium
  ```
- **Video recording is enabled for all test runs** (`video: "on"` in `playwright.config.ts`). Every test produces a `.webm` video in `apps/web/test-results/<test-folder>/video.webm`.
- When summarizing E2E results, **list the video files that were created** so the reader can review the actual browser interactions. Example:
  ```
  Videos:
    apps/web/test-results/platform-tables-Overview-renders-the-three-nav-cards-chromium/video.webm
    apps/web/test-results/platform-tables-Orders-renders-table-chromium/video.webm
    ...
  ```
- **Cleanup:** `apps/web/test-results/` accumulates artifacts across runs. Periodically delete it to reclaim disk space:
  ```bash
  rm -rf apps/web/test-results
  ```
  Playwright recreates the directory automatically on the next run. Do not commit `test-results/` to git (it is already gitignored).

## Hot-path cautions
- Money flows: Work in integer cents, preserve rounding, ensure `sum(order_splits) === basis` and `platform_take` math stays deterministic.
- Idempotency: Webhooks, payouts, refunds, ticket scans must be safe on retry. Reuse the established key patterns and ensure `begin/commit/fail` discipline.
- Concurrency: Maintain unique constraints on `(orderId, payeeId)` and similar combos; guard against double scans or settlements.
- RBAC: Enforce org-scoped permissions via `repos.authz.ensureOrgRole` inside use cases. Never trust client-provided roles.
- Security: Verify Stripe webhooks with adapters, keep QR tokens short-lived, mask PII in logs, and respect CORS/domain allowlists.

## Admin pages & navigation
- Every admin page lives under `apps/web/src/app/admin/[slug]/<section>/`.
- When adding a new admin page, **you must also add a corresponding navigation entry** to the `ADMIN_SECTIONS` array in `apps/web/src/app/admin/[slug]/layout.tsx`. The entry needs a `title`, `icon` (from `lucide-react`), and `href` matching the new route segment. Without this step the page is unreachable from the sidebar.
- `AdminShell.tsx` (in the `_components` directory) consumes `ADMIN_SECTIONS` via `namespaceNavSections` to build the sidebar. You should not need to edit it when adding a standard page—just update `ADMIN_SECTIONS`.

## Package map & entry points
- `packages/core/src/use-cases/**`: Pure functions with Zod schemas; add exports via `packages/core/src/index.ts`.
- `packages/adapters/src/**`: Implementations for Stripe, Prisma (`PrismaRepos`), Redis idempotency, etc.; follow dependency-injection patterns.
- `packages/transport/trpc`: Router bindings for UI clients. Update input/output schemas to stay in sync with use cases.
- `apps/api/src`: Fastify bootstrap; register transports and webhook routes. Keep handlers thin and reuse adapters.
- `apps/web/src`: Next.js + React Native Web UI; rely on tRPC hooks for data and `@th/ui` components.
- `packages/ui` / `packages/ui-email`: Shared component libraries. Update stories and Markdown docs when adding UI primitives.

## Documentation conventions
- **`docs/README.md`** is the top-level index. Keep it up to date when adding, moving, or removing docs.
- **Spec lifecycle** follows a two-folder pattern within each `docs/specs/<YYYY-MM-DD>/` date folder:
  - **Active drafts** live at the date-folder root (e.g., `specs/2025-12-14/seatmaps-port.spec.yaml`).
  - **Completed specs** get moved into `completed/` once the work is implemented and merged.
  - When graduating a spec: move the file into `completed/` and delete any redirect stub. Do not leave the old file behind.
  - **Never** create `uncompleted/` directories. Drafts belong at the date-folder root; the absence of `completed/` is what marks them as in-progress.
- **New specs** go into `docs/specs/<today's date>/` (e.g., `docs/specs/2026-04-08/`). Create the folder if it doesn't exist.
- **Spec file naming** uses suffixes to convey type: `.spec.yaml`, `.component.yaml`, `.flow.yaml`, `.transport.yaml`, `.pipeline.yaml`, `.task.yaml`, `.schema.yaml`, `.pattern.yaml`. See `docs/README.md` for the full table.
- **No duplicate files.** A spec must exist in exactly one location. If it needs to be referenced from another directory, use a relative link, not a copy.
- **Root-level docs** (`docs/*.md`) are reserved for core reference material (standards, env, auth, roles, DB). Domain-specific operational docs belong in a subdirectory (`docs/jobs/`, `docs/testing/`, `docs/dev/`, etc.).
- When creating new docs, add them to the appropriate table in `docs/README.md` in the same PR.

## Pull-request readiness checklist
- [ ] Document intent and edge cases in the PR description, especially around money, auth, or schema changes.
- [ ] Include migrations, generated client updates, and regenerated types when Prisma schema changes.
- [ ] Run the appropriate validation commands (see table) and paste results in the summary.
- [ ] Ensure new code has Vitest coverage with both happy path and at least one failure/retry scenario.
- [ ] Confirm no secrets or `.env` values are committed. Update docs/readmes if developer workflow changes.

## Cloud Run & CI/CD debugging
When a deploy-dev workflow fails or a Cloud Run service won't start:

1. **Check image build logs** — `gh run view --job=<id> --log-failed 2>&1 | tail -60`.
2. **Check Cloud Run logs** — `gcloud run services logs read <service> --region us-central1 --project hearthfire-491918 --limit 30`.
3. **Describe the service** — `gcloud run services describe <service> --region us-central1 --project hearthfire-491918 --format yaml` to see env vars, image, and status.
4. **Verify images exist** — `gcloud artifacts docker tags list us-central1-docker.pkg.dev/hearthfire-491918/services/<service>`.
5. **Verify WIF** — `gcloud iam workload-identity-pools providers list --location=global --workload-identity-pool=github-pool --project=hearthfire-491918`.

Service names: `hf-dev-api`, `hf-dev-web`, `hf-dev-jobs`, `hf-dev-tileserver`.
WIF SA: `github-actions@hearthfire-491918.iam.gserviceaccount.com`.
See `infra/README.md` for the full debugging reference.

Following these guardrails keeps Ithas Fire’s money handling, auditability, and developer ergonomics intact. When in doubt, read the nearby use case or adapter and mirror its patterns before innovating.

## Commit hygiene (AI agents)
  - Prefer commits that represent a coherent “vertical slice” (core → ports → adapter → transport/UI) or a single refactor/test stabilization.
  - It’s okay to use multiple commits for one feature; avoid “everything everywhere” commits.
- **Safety rule: never rollback without explicit approval.** Do **not** run any command that discards or rewinds work (including but not limited to `git restore`, `git reset` (any mode), `git checkout -- <path>`, `git clean`, `git revert`, `git stash`, `git stash pop`, or interactive rebases) unless the user explicitly asks for that rollback/cleanup and confirms the scope of what will be lost.
- **`git stash` is absolutely forbidden.** Never use `git stash` or `git stash pop` for any reason — not for "baselining" error counts, not for temporary checks, not for anything. It risks losing work and creates confusing state. Find another way (e.g., `git diff --stat`, reading files, or just running the check directly).
````
