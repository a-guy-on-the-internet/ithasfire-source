# Ithas Fire — TicketHunter

## Architecture

Hexagonal monorepo: `core` (use cases, entities) → `ports` (interfaces) → `adapters` (implementations) → `transport` (tRPC routers) → `ui-*` (apps).

## Error Reporting Convention (Sentry)

Two capture paths exist; use them deliberately:

- **Deliberate swallows use `ReporterPort`.** Any use case that catches a failure and returns a fallback/degraded result (instead of throwing) MUST declare `reportError?: ReporterPort` (`packages/ports/src/reporter.ts`) in its deps and call `deps.reportError?.(err, { tags, extra })` in the swallow branch — guarded so a throwing reporter never changes behaviour. The composition roots wire it to `Sentry.captureException` (`apps/api/src/lib/dep.ts`, jobs). Add regression tests for the report (pattern: `packages/core/src/use-cases/search/__tests__/`).
- **Everything else rides the backstops.** Thrown errors are captured by the fastify/tRPC integrations; `logger.error(msg, { err })` is captured via Sentry's pinoIntegration. Do NOT rely on `logger.warn` for anything that must be visible — warn is not captured.
- **Migration is opportunistic, not big-bang.** When already editing a use case that swallows-and-logs, move it from `logger.error` to `reportError` (keep the log line). Never demote a swallow-site's `logger.error` to `warn` without first adding `reportError` — that silently un-Sentries it (the exact bug behind the Jun 2026 4-day silent search outage).

Reviewers: flag new catch-and-fallback branches lacking `reportError` as `[BLOCKING]`.

## Model Lifecycle Convention

A new persisted model ships with its whole lifecycle decided, not just the create-and-list half a demo needs.

- **The spec records the lifecycle.** For each of create, read (single and list), update and remove, the model's spec says built, or not built and why. Append-only is a valid decision: orders, tickets, audit rows and refunds take no update or delete use case (REFUNDED and INVALID are terminal). The defect is the unrecorded gap, found during an incident.
- **Remove is decided when the model is introduced**: soft or hard, and what happens to dependents. Read the FK graph first; most of ours CASCADE.
- **`/platform` gets full CRUD by default** (owner, 2026-10-11: "often times I will want CRUD for things on platform"). A model a platform admin manages gets create, edit and remove on its platform page along with the list, and a page that can remove a row can also create one. A model with no platform page says so in its spec. The standing example: a category can be deleted on `/platform` but is created only by approving a category request.
- **A use case is the supported way to change a row.** Raw SQL skips the audit row and the `reindexAfterMutation` / `markForSearchReindex` calls; two listings were removed from production that way on 2026-10-06. When hand-written SQL is the only way to make a change, build the use case and its surface.

Reviewers: flag as `[BLOCKING]` a new model that lands create without update and remove unless its spec records that part as not built (append-only included), and a platform page that can remove a row but cannot create one.

## Local Dev

Dev login credentials and seeded users/orgs (including the `dev-login` admin slug) live in `apps/api/src/scripts/seed/ids.ts` (imported by `seed-data.ts`). Check there for the email/password to sign in locally.

**Passkeys** (web sign-in or scanner cross-device, AASA/assetlinks, keystore fingerprint) → read `docs/runbooks/passkey-testing.md` before testing or touching them.

## Sessions: hand off or compact

A session is one task. Every turn re-reads the whole context, and quality drops as it fills, so a fresh session that starts from a written handoff beats a long one carried by summaries. Auto-compact (set to fire at 400K) is the backstop, not the plan.

**Hand off** (end this session, the next one starts fresh) when:
- the task is done and the user moves to a different task: new feature, new bug, new area of the code;
- a long investigation has ended in a decision and building starts;
- the session is drifting: repeated mistakes, the same files re-read, user corrections piling up.

At a hand-off point, say so in one line and invoke the `handoff` skill: it writes the handoff, starts the next session and opens it in a VS Code tab, and you close out this side (HISTORY.md entry, memory). When the user's message *is* the new task, that task goes into the handoff rather than being started here. A question answerable in a turn or two stays in this session.

**Compact** (stay in this session) when the next step continues the same task and needs what is already in context: after a plan is agreed and before building it, or between implementation steps of one feature. Suggest `/compact focus on <next step>` at that boundary instead of waiting for auto-compact.

**Before either:** a ruling, correction or preference the user gives in chat goes to memory or the active plan/spec file when it is given. Rules that live only in the conversation are what compaction loses.

## Compact Instructions

When summarizing this conversation for compaction, keep verbatim:
- every ruling, correction and preference the user stated, with who decided it;
- the files this session changed versus files belonging to peer sessions, and each commit made with whether it is pushed;
- open questions waiting on the user, and the agreed next step;
- whether each load-bearing claim is `[VERIFIED]` or `[REASONED]`.

Name the active plan, spec, handoff and memory files by path. Drop tool output and file contents (they are re-read from disk), and dead ends unless the reason they failed matters.

## Product principle

**Pro-social is the tiebreaker.** Read `docs/pro-social.md` before recommending any product, UX or design option (grilling, scoping, specs, UI review), and name the principle that decided the recommendation.

**No enshittification is a veto** (owner, 2026-10-12). Its definition and examples are in `docs/pro-social.md`. An option that moves toward it is off the table, not a lost tiebreak; when a change might qualify, ask the owner before building. Reviewers: flag it as `[BLOCKING]`.

## Prose & Vocabulary

- **All prose follows the `unslop` skill's avoid-list** — chat replies to the user included, not just artifacts. Load it before writing any substantial human-facing text.
- **`CONTEXT.md` (repo root) is the canonical glossary**: use its terms — and honour its `_Avoid_` lists — in code, delegation prompts, and copy. When terminology is being debated or a term is fuzzy, load the `domain-modeling` skill and resolve it into `CONTEXT.md` right there.
- **Editing any agent-consumed doc** (a skill, this file, `.claude/agents/*`) → load the `writing-for-agents` skill first.

## Dev Orchestrator

### Model Selection (be deliberate, not default-everything)

An agent's frontmatter sets its default model; `model` on the `Agent` call overrides it for that call.

| Agent | Default | Override |
| --- | --- | --- |
| `reviewer`, `security-reviewer` | `opus`, pinned | never lower. This codebase's best catches (a TOCTOU race, a Turbopack prod bug, an incomplete auth allowlist) came from review reasoning a weaker model waves through. |
| `coder`, `refactor` | `sonnet` | pass `model: "opus"` for the **hard** cases below |
| `ui`, `mobile`, `infra` | inherit | — |
| `browser-driver` | `sonnet`, pinned | never `haiku`: a haiku driver ran `pnpm seed:dev` on its own (2026-09-29) |
| `Explore`, boilerplate, fleets of near-identical tasks | — | pass `model: "haiku"` |

**Hard** — send `coder`/`refactor` on `opus` when the step:
- touches money, auth/authz, migrations, concurrency or locking;
- spans layers (core + adapter + transport) or more than ~3 files with new behaviour;
- starts from an ambiguous spec, or is a bug whose cause is not yet known;
- is a fix round after a `sonnet` build drew a `[BLOCKING]` finding. Escalate on the first one; don't send `sonnet` back twice.

Everything else (a fully specified diff, tests and fixtures, applying `[WARNING]`/`[NIT]` fixes, a single-area change with a clear pattern to copy) stays on `sonnet`. Name the model you chose in the plan step (or in your message to the user), so the routing is visible.

### Tool output budget (every agent, every Bash call)

Everything a tool returns is re-read on every later turn, so a 50KB log at turn
10 is paid for again at turns 11 through 200. Return the **signal**, not the dump:

- Tests, typecheck, lint, build: pipe through `2>&1 | tail -40`, or `grep` for
  `FAIL|error|✗` plus a summary line. Use vitest `--reporter=dot` for full suites.
- Test, e2e, build and typecheck runs queue machine-wide (1 heavy + 3 light slots), so ~20
  sessions never stack them. `vitest run` and playwright queue from their own configs;
  typecheck and builds queue only through the scripts: `pnpm typecheck` (packages),
  `pnpm typecheck:<api|web|jobs|mobile|scanner>`, `pnpm -F web build`; any other heavy
  command goes through `node scripts/dev/gate/run.mjs --weight heavy -- <cmd>` (a hook
  refuses bare `tsc` and `next build`). Under memory pressure the gate runs one job at a
  time. A queued run prints `gate: queued (<weight>) …` with the reason and can wait tens
  of minutes: give it a long timeout or `run_in_background`. `pnpm gate:status` shows
  holders, waiters, memory and ungated runs.
  Container-backed tests share one native `th-test-pg` server that test-utils starts itself.
- Read files by range (`offset`/`limit`, `sed -n`); `grep -n` first to find the range.
- Cap broad searches with `| head -50`.
- When the full output is needed later, write it to the scratchpad and report the path.

**Cross-model work.** `[skill:codex-delegate]` runs Codex/GPT for a second-opinion
review on high-stakes diffs (additive to `reviewer`, never a replacement), for
mechanical offload, and for computer-use. **Prefer GPT for cheap/mechanical/
computer-use work** to save Claude tokens (user's standing preference); the
wrapper always runs the newest GPT model (owner, 10-07).
`[skill:visual-critique]` runs Gemini for an objective visual-defect pass over
screenshots; Claude triages every finding. **TASTE STAYS WITH CLAUDE (hard
rule):** UI/design/visual/product-taste judgment is Claude's verdict, never
another model's. When unsure if something is "taste," treat it as taste.

## Dev Loop (Default Posture)

For **any** implementation task — even without an explicit `/dev` invocation — act as the **development orchestrator**: analyze the task, route it to the right specialist subagent, then run it through code review before declaring it done. Produce reviewed, production-ready code. `/dev <task>` runs this same loop explicitly; this section makes it the default.

### Delegation
Delegate to specialists with the **Agent tool**, setting `subagent_type` to the specialist's name (`coder`, `reviewer`, `ui`, `infra`, `refactor`, `mobile` — defined in `.claude/agents/`). Delegations are **stateless**: each subagent starts fresh, so every prompt must be detailed and self-contained — what to implement, which files/packages, the constraints/patterns to follow, which docs to read, and exactly what to report back. Pass full context every time; when relaying review feedback, restate the original intent plus the findings verbatim.

### Agent Roster & Routing
| Agent | When to use |
|-------|------------|
| `coder` | Backend features, use cases, adapters, transports, tests, bug fixes, applying review feedback |
| `reviewer` | Code review after any implementation step (always runs; read-only) |
| `ui` | Web/shared UI pages, components, layouts, styling, design system, accessibility, responsive design |
| `infra` | Terraform, Docker, CI/CD, Cloud Run, DNS, secrets, deployment, env config |
| `refactor` | Code cleanup, deduplication, module reorganization, dead code removal, barrel exports |
| `mobile` | Expo / React Native in `apps/mobile`, `apps/scanner` |

Classify before delegating:
- **Expo / React Native app** (`apps/mobile`, `apps/scanner`) → load the `ui` skill for visible screens, then route to `mobile` (mobile UI stays with `mobile`; `ui` runs the design-review pass after the mobile engineering review).
- **Non-mobile UI** (web pages, components, styling, tokens) → load the `ui` skill, then route to `ui`.
- **Infra** (Terraform, Docker, CI, Cloud Run, env vars, secrets) → `infra`.
- **Pure cleanup** (no new behavior) → `refactor`.
- **Everything else** (use cases, adapters, transports, tests, bug fixes, the fastify `apps/audio-transcoder` and `apps/mcp`) → `coder`.
- **Cross-cutting** → split into steps and route each (run sequentially: e.g. `coder` → `reviewer` → `ui` → `reviewer`).

### Orchestrator Skills Toolkit
Before building: `feature-scoping` (vague idea → spec; opens by running the `grilling` interview to an empty frontier) → `implementation-plan` (spec → ordered steps in a `memory/session_*.plan.md`). For UI work, load the `ui` skill first. `grilling` also stands alone for stress-testing any plan or decision outside scoping. After building: `help-center-authoring` (if user-facing). Every new living doc in `docs/` or `docs/runbooks/` gets a row in the matching table of `docs/README.md` (`pnpm docs:check` fails without it); one in a folder with its own README (`decisions/`, `design/`) gets a row there; specs and dated records get none. Use `domain-modeling` when a session shifts the domain language (update `CONTEXT.md` / `docs/decisions/`), and `/handoff` to end a session into a fresh one (see "Sessions: hand off or compact").

### The 9-Step Loop
```
1. PLAN    → Break down the task, classify each step, write the steps to the plan file
2. ROUTE   → Pick the right specialist for each step
3. BUILD   → Delegate to the specialist (Agent tool)
4. REVIEW  → Delegate to `reviewer` to audit the output
5. FIX     → If CHANGES_REQUESTED, send findings back to the SAME specialist
6. REPEAT  → Steps 4–5 until APPROVED (max 3 rounds per step)
7. NEXT    → Move to the next step (if cross-cutting), repeat from step 3
8. RUN     → Drive the REAL app and look at it (see "Run it" below)
9. REPORT  → Summarize what was built, reviewed, and validated
```

### Hard Constraints
- **Never skip review.** Every implementation gets reviewed by `reviewer`.
- **Max 3 review rounds per step.** If unresolved after 3, stop and escalate to the user.
- **One feature/fix per loop.** Don't combine unrelated changes in one iteration.
- **Pass full context between agents** — delegations are stateless; restate intent and findings each time.
- **Track progress in the plan file's `## Status`** (commit hash, pushed or not) as each step lands; a one-step task reports its commit in the final report instead.
- **Run final validation yourself** (typecheck, tests) after approval, as a sanity check.
- **Run the app yourself** for anything user-facing. Green tests are not evidence that a page works.

### Run It (step 8)

Any change with a visible surface is NOT done until it has been driven in the real app. Unit tests here mock the design system away and render components in isolation, so an entire class of defect is invisible to them by construction: accessible-name collisions with the rest of the page, SSR/hydration mismatches, reflow and overflow, and anything about how a component sits among its neighbours.

This is not hypothetical. A passkey rename UI went through the full loop — layer-ordered delegation, two review rounds, 405 green tests — and shipped three real defects that fell out within twenty minutes of running it: two "Save" buttons with identical accessible names on one page, a full hydration failure on the route, and a horizontal overflow at 320px whose cause a subagent had guessed at with arithmetic (and got wrong).

**Run e2e WITHOUT wiping your dev database:**
```bash
cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test e2e/<spec>.spec.ts --project=chromium --reporter=list
```
`E2E_USE_LIVE_STACK=1` reuses an already-running dev stack (:3000 + :3001) and skips the readiness step that runs `prisma migrate reset --force`. **Without it, the harness WIPES the local dev database.** It also now blocks the ~54 specs that call `resetE2eState()` in `beforeEach`: that endpoint `deleteMany`s every order, event, org and auth user in whatever DB the API points at, so under the flag those specs fail fast instead of destroying your seed data. Pass `E2E_ALLOW_LIVE_RESET=1` to wipe a live stack on purpose. Never work around Prisma's agent guardrail, and never set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` — if a reset seems necessary, stop and ask.

Trade-off: your DB is not pristine in this mode, so fixture-dependent specs may fail, and any spec you run this way must clean up what it creates. Use the default (wiping) path for money, settlement, and journey suites.

`fullyParallel: true` is set, so specs that mutate the SAME account collide when run together — and the symptom looks like a product bug, not a harness one. Measured: the two passkey specs together → 2 failed; `--workers=1` → 4 passed. When running more than one spec that touches shared account state, pass `--workers=1`.

Minimum bar for a UI change: load the page, exercise the interaction, check **zero new console errors**, and check a 320px viewport. The `test` fixture in `e2e/fixtures.ts` fails a spec on console errors automatically — trust it only as far as `e2e/helpers/console-errors.ts`'s ignore list allows (read it; it has swallowed real failures before).

### Claim Discipline (subagents and orchestrator)

Subagent reports are evidence only where they are backed by a command. In every report, tag each load-bearing claim:

- `[VERIFIED: <exact command>]` — it was executed and the output is pasted.
- `[REASONED]` — it was derived by reading code. Legitimate, but it is a hypothesis.

The orchestrator **re-runs the load-bearing `[VERIFIED]` claims** and treats `[REASONED]` claims about runtime behaviour as unproven until measured. Real examples from one session: "the 320px cluster wraps" was `[REASONED]` and wrong; "`\p{...}` may crash on Hermes" was `[REASONED]` and disproved by actually running Hermes; "DOM output is byte-identical for existing callers" was true but had to be checked by grepping every call site.

Note `reviewer` has **no Bash**: it physically cannot execute anything, so everything it reports is `[REASONED]`. `security-reviewer` has Bash for read-only probing (grep, `git diff`, `git show`); its runtime claims count only where tagged `[VERIFIED]`. Their findings are leads to verify, not verdicts.

### Gates That Look Real And Are Not

Verify a gate actually fails before trusting it. Each of these was confirmed by planting a deliberate error and watching the "gate" pass:

| Command | Reality |
| --- | --- |
| `pnpm exec tsc --noEmit` **at repo root** | **No-op.** Picks up the root solution `tsconfig.json` (`files: []`), so `--noEmit` walks nothing and exits 0 even with a planted type error. Use **`pnpm typecheck`** (`-p tsconfig.base.json`), which does catch it. From inside `apps/web` the bare form is real — so the same command is a gate or a lie depending on cwd. |
| **`pnpm typecheck` alone** | **Covers `packages/**` only and skips every test file.** An app type error exits 0: a 3-arg call against a 2-arg signature in `apps/api` passed it and failed the app's own tsc with TS2554. Typechecking is two commands minimum: `pnpm typecheck` plus `pnpm typecheck:<app>` for every app touched (mcp and audio-transcoder have no script: `bash scripts/dev/with-gate-lock.sh pnpm -F <app> exec tsc -p tsconfig.json --noEmit`). The app command checks the tests in its `include` (web, mobile, scanner, jobs), the only gate that catches a fixture asserting a shape the product cannot emit; **`apps/api/test/**` is typechecked by nothing, so vitest is its only gate.** |
| `pnpm run <script> -- <flags>` | The `--` and everything after it lands in the underlying tool's argv and is silently dropped. A bogus flag runs green. `deploy-dev.yml`'s web step passes `--retry=1` this way, so its documented flake-retry has never applied. |
| `pnpm -F <name> exec …` with a typo'd filter | Prints "No projects matched the filters" and exits **0** — a permanently-green step that looks like coverage. |
| `vitest --run` in a package with no tests | Exits **non-zero** on zero matched files. Never add a CI step for a package that has no tests. |
| e2e console-error assertion | Only as honest as `IGNORED_PATTERNS`. `/hydration-mismatch/i` matched the docs URL React appends to REAL hydration failures, so the gate reported clean on a page failing hydration on every load. |

A package's tests running locally does **not** mean CI runs them. `@th/types` had 161 tests in zero jobs; check the workflow before claiming coverage.

### Verdict Handling
The `reviewer` returns `APPROVED | CHANGES_REQUESTED` with findings tagged `[BLOCKING] / [WARNING] / [NIT]`. Any `[BLOCKING]` → `CHANGES_REQUESTED`. On `CHANGES_REQUESTED`, extract the `[BLOCKING]` and `[WARNING]` findings and send them back to the specialist that wrote the code, then re-review. A Coverage line marked UNASSESSED needs evidence, not a code change: give the reviewer the files or command output it names and re-review. On `APPROVED` with warnings, fix, accept or defer each one, and say which in the final report.

### Final Report
```
## Dev Loop Complete

### Task
<what was requested>

### Implementation
<specialist's final summary — files changed, tests written>

### Review
<reviewer's final verdict — APPROVED with any remaining notes>

### Validation
<commands run and results>

### Review Rounds: <N>
```
