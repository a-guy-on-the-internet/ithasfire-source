---
name: implementation-plan
description: "Break a scoped feature into an ordered implementation plan that follows hexagonal architecture layers. Use when a spec exists and you need to plan the build sequence before delegating to specialists. Use when asked to 'plan the implementation', 'break this down into steps', 'what order do we build this', or when the dev orchestrator needs to sequence work across agents."
---

# Implementation Plan

Turn a scoped spec into an ordered, layer-by-layer implementation plan that the dev orchestrator can delegate step-by-step to specialist agents.

## When to Use

- A spec (`.spec.yaml`) exists and the user wants to build it
- The dev orchestrator needs to break a feature into delegatable steps
- When asked "plan the implementation", "break this down", "what order do we build this"
- Before starting any cross-cutting feature that touches multiple packages

## Workflow

### Step 1: Read the Spec

Load the relevant spec from `docs/specs/`. Extract:
- Use cases to build
- Data/schema changes
- Ports and adapters needed
- Transport procedures
- UI pages/components
- Risks and open questions

If no spec exists, invoke the `feature-scoping` skill first.

### Step 2: Research the Codebase

Before planning, verify assumptions:
1. Check Prisma schema for current state of relevant models
2. Find analogous use cases to mirror their pattern
3. Check which ports already exist vs. need creation
4. Identify existing tRPC procedures in the relevant router
5. Check UI components that will be modified or extended

### Step 3: Generate the Plan

Break the feature into **ordered steps** following the hexagonal dependency flow:

```
1. Schema / Migration (if needed)
2. Ports (new interfaces)
3. Core use cases (business logic)
4. Adapters (implementations)
5. Transport (tRPC / webhooks)
6. UI (pages, components)
7. Tests (unit + integration + e2e)
```

Not every feature needs all layers. Skip layers that don't apply.

**Plan format:**

```markdown
# Implementation Plan: <Feature Name>

**Spec**: docs/specs/<date>/<name>.spec.yaml
**Branch**: feat/<kebab-case-name>
**Layers touched**: core, ports, adapters, transport, ui

## Steps

### Step 1: <Title>
**Agent**: @coder | @ui | @infra
**Packages**: packages/db, packages/ports, etc.
**What**:
- <Concrete change 1>
- <Concrete change 2>
**Files**:
- `path/to/file.ts` — CREATE | EDIT
**Tests**:
- <What to test>
**Verify**: <Command to run — e.g., `pnpm db:validate`>

### Step 2: <Title>
...

## Commit Strategy
- <How to split commits — one per step, or group related steps>

## Risk Checkpoints
- After Step N: <verify X before continuing>
```

### Step 4: Validate the Plan

Before presenting to the user, verify:

- [ ] Every use case from the spec has a corresponding step
- [ ] Dependencies flow downward (ports before core, core before transport)
- [ ] Each step names the specialist agent that should handle it
- [ ] Each step has a verification command
- [ ] Money flows have idempotency noted
- [ ] Auth/RBAC checks are assigned to a step
- [ ] No step requires knowledge of a later step to complete

### Step 5: Present and Confirm

Show the plan. Ask:
1. "Does this sequence make sense?"
2. "Anything you want to reorder or combine?"
3. "Ready to start building?"

The orchestrator can then delegate each step to the appropriate specialist, running review after each.

## Plan Artifact

Save the plan to session memory (`/memories/session/<feature-name>.plan.md`) so it survives across chat turns. Plans are ephemeral orchestration artifacts — they go stale as soon as implementation is done, so they don't belong in `docs/specs/` alongside durable specs.

If the orchestrator starts a new chat, it can read the session memory file and pick up where it left off.

## Rules

- **Follow the dependency order.** Schema before ports, ports before core, core before transport, transport before UI. Violating this creates forward references that break builds.
- **One step = one specialist.** Don't mix backend and UI work in the same step. The orchestrator delegates steps to different agents.
- **Name exact files.** "Edit the orders router" is not enough. Say `packages/transport/trpc/src/routers/orders.ts — EDIT`.
- **Include verification.** Every step must have a command that proves it worked: `pnpm db:validate`, `pnpm -C packages/core vitest --run`, `pnpm -w tsc -p tsconfig.base.json --noEmit`, etc.
- **Flag risk checkpoints.** If a later step depends on a tricky assumption from an earlier step, mark it as a checkpoint where the orchestrator should pause and verify before continuing.
- **Keep it scannable.** A plan for a medium feature should fit on one screen. If it's longer, the feature might need to be split into multiple specs.
- **Reference the spec.** Every plan links back to its spec. Every step should be traceable to a requirement in that spec.
- **Use context-map per step.** When the orchestrator delegates a step to a specialist, consider invoking the `context-map` skill first to map exact file dependencies and test impact before coding begins.
