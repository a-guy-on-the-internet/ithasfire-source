---
name: implementation-plan
description: "Turn a spec into an ordered build plan in memory/session_<feature>.plan.md: steps in hexagonal layer order, each with its agent and model. Use when a spec exists and the build needs sequencing."
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

**Plan format** (the shape of the existing `memory/session_*.plan.md` files; read one before writing yours):

```markdown
---
name: session-<feature>-plan
description: "Build plan (<YYYY-MM-DD>) for <feature>; <N> steps, <money path? auth?>, <coder model> + <reviewer model>"
metadata:
  type: project
---

Spec: `docs/specs/<date>/<name>.spec.yaml`. Rulings live in the spec header and in [[<memory file>]].

## Status
- <YYYY-MM-DD> session <id>: <what landed: step, commit hash, pushed or NOT pushed; what is next>

## Ground rules for every step
- Model routing (CLAUDE.md "Model Selection"): which steps go to `coder` on opus and why.
- Files or hunks that belong to peer sessions and must not be staged.
- Typecheck = `pnpm typecheck` + `pnpm typecheck:<app>` for each app touched.

## Steps
1. **<Title>** (<agent>/<model>). <Concrete change, exact files with CREATE | EDIT, tests, verify command.>
2. ...
N-1. **Design board** (orchestrator, artifact): the screens and states, built from the real components; owner picks before the UI step.
N. **Live run**: drive the real app through the feature; 320px; zero console errors.

## Risk checkpoints
- After <step>: <what the orchestrator re-runs itself before continuing>
```

### Step 4: Validate the Plan

Before presenting to the user, verify:

- [ ] Every use case from the spec has a corresponding step
- [ ] Dependencies flow downward (ports before core, core before transport)
- [ ] Each step names the specialist agent and model that should handle it
- [ ] Each step has a verification command
- [ ] Money flows have idempotency noted
- [ ] Auth/RBAC checks are assigned to a step
- [ ] No step requires knowledge of a later step to complete
- [ ] A UI feature has a design-board step before its UI step, and every feature ends in a live run

### Step 5: Present and Confirm

Show the plan. Ask:
1. "Does this sequence make sense?"
2. "Anything you want to reorder or combine?"
3. "Ready to start building?"

The orchestrator can then delegate each step to the appropriate specialist, running review after each.

## Plan Artifact

Save the plan to `~/.claude/projects/-Users-somehuman-Projects-TicketHunter/memory/session_<feature>.plan.md` and add its line to `MEMORY.md` under "In flight". Append to `## Status` as each step lands (commit hash, pushed or not); a later session or a handoff picks up from that log.

## Rules

- **Follow the dependency order.** Schema before ports, ports before core, core before transport, transport before UI. Violating this creates forward references that break builds.
- **One step = one specialist.** Don't mix backend and UI work in the same step. The orchestrator delegates steps to different agents.
- **Name exact files.** "Edit the orders router" is not enough. Say `packages/transport/trpc/src/routers/orders.ts — EDIT`.
- **Include verification.** Every step must have a command that proves it worked: `pnpm db:validate`, `pnpm -C packages/core vitest --run`, `pnpm typecheck` + `pnpm typecheck:<app>`, etc.
- **Flag risk checkpoints.** If a later step depends on a tricky assumption from an earlier step, mark it as a checkpoint where the orchestrator should pause and verify before continuing.
- **Keep it scannable.** A plan for a medium feature should fit on one screen. If it's longer, the feature might need to be split into multiple specs.
- **Reference the spec.** Every plan links back to its spec. Every step should be traceable to a requirement in that spec.
