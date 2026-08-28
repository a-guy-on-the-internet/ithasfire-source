---
name: feature-scoping
description: "Scope a feature from a vague idea into a structured spec. Use when the user has a feature request, product idea, or business requirement that needs to be broken down before implementation. Outputs a spec YAML in the project's docs/specs/ format. Use when asked to 'scope this', 'write a spec', 'plan this feature', 'what would it take to build X', or before any multi-layer feature implementation."
---

# Feature Scoping

Turn a vague idea into a structured, actionable spec before any code is written. This skill is what the dev orchestrator uses to understand *what* needs to be built before routing work to specialists.

## When to Use

- User describes a feature, product idea, or business requirement
- Before starting any multi-layer implementation (core + transport + UI)
- When asked to "scope this", "what would it take", "write a spec", "plan this feature"
- When the orchestrator needs to understand blast radius before delegating

## Workflow

### Phase 1: Grill

Before writing anything, invoke the **`grilling`** skill (Skill tool) and run its frontier-rounds interview to a shared understanding. Do not assume context, and do not draft the spec while any branch of the design tree is still open.

Seed the root of the design tree with these axes — each unresolved axis is a frontier question in round one:

1. **Problem**: What pain point or opportunity does this address? Why now?
2. **Users**: Who uses this? Buyer, organiser, admin, embed consumer, scanner operator?
3. **Surfaces**: Where does this appear? Web, mobile, scanner, embed, API, jobs?
4. **Money**: Does this touch money flows, pricing, payouts, or refunds?
5. **Data**: What new data is needed? New models, new fields, migrations?
6. **Auth/RBAC**: Who is allowed to do this? Org-scoped? Public? Admin-only?
7. **Constraints**: Deadlines, dependencies on other features, legal requirements?

Per grilling's rules: facts are your job (dispatch sub-agents into the codebase; that's Phase 2 running concurrently), decisions are the user's. The grill is done when the frontier is empty — a `money: true` or auth-touching feature earns extra rounds, not fewer.

### Phase 2: Research

Before drafting, gather codebase context:

1. **Existing specs**: Search `docs/specs/` for specs that overlap with or relate to this feature
2. **Adjacent code**: Find existing use cases, components, or specs that are similar
3. **Schema**: Check current Prisma models for relevant entities
4. **Ports**: Identify which ports are needed (existing vs. new)
5. **Patterns**: Look at how analogous features were built (follow the existing pattern)

### Phase 3: Draft the Spec

Output a `.spec.yaml` file following the project conventions.

**File location**: `docs/specs/<today's date>/<feature-name>.spec.yaml`

**Spec structure**:

```yaml
# <feature-name>.spec.yaml
#
# <One-line description of what this spec covers>

version: "1.0"
updated: "<YYYY-MM-DD>"

# ── Summary ──────────────────────────────────────────────────────────────────

summary:
  problem: >
    <What pain point or gap this addresses — 2-3 sentences>
  solution: >
    <How we solve it — 2-3 sentences>
  users:
    - <persona 1>
    - <persona 2>
  surfaces:
    - <web | mobile | scanner | embed | api | jobs>

# ── Requirements ─────────────────────────────────────────────────────────────

requirements:
  functional:
    - id: FR-001
      description: >
        <Concrete, testable requirement>
    - id: FR-002
      description: >
        <Another requirement>

  non_functional:
    - id: NFR-001
      description: >
        <Performance, security, accessibility, etc.>

# ── Architecture ─────────────────────────────────────────────────────────────
# Map to hexagonal layers: core → ports → adapters → transport → UI

architecture:
  core:
    use_cases:
      - name: <use-case-name>
        description: >
          <What the use case does>
        input: <key input fields>
        output: <key output fields>
        idempotent: <true | false>
        money: <true | false>

  ports:
    new: []        # New port interfaces needed
    existing: []   # Existing ports this feature depends on

  adapters:
    new: []        # New adapter implementations needed
    existing: []   # Existing adapters touched

  transport:
    trpc_procedures: []   # New tRPC procedures
    webhooks: []          # New webhook handlers

  ui:
    pages: []             # New routes / pages
    components: []        # New or modified components

# ── Data ─────────────────────────────────────────────────────────────────────

data:
  new_models: []
  modified_models: []
  migrations_needed: <true | false>

# ── Risks & Open Questions ───────────────────────────────────────────────────

risks:
  - risk: >
      <What could go wrong>
    severity: <HIGH | MEDIUM | LOW>
    mitigation: >
      <How to handle it>

open_questions:
  - <Anything that needs a decision before implementation>

# ── Out of Scope ─────────────────────────────────────────────────────────────

out_of_scope:
  - <Explicitly excluded from this spec>

# ── Acceptance Criteria ──────────────────────────────────────────────────────

acceptance_criteria:
  - <Testable statement 1>
  - <Testable statement 2>
```

### Phase 4: Review with User

Present the spec and ask:
1. "Does this match what you're thinking?"
2. "Anything I got wrong or missed?"
3. "Ready to build, or should we adjust scope?"

**Do not proceed to implementation until the user confirms.**

## Rules

- Be concrete. "The search must return results within 200ms" not "the search should be fast."
- Flag money flows explicitly. If a feature touches money, mark `money: true` on the use case and note idempotency requirements.
- Flag auth requirements. Every use case must state who is authorized.
- Identify what's out of scope. Prevent scope creep by being explicit about what this spec does NOT cover.
- Use the project's spec format. Output to `docs/specs/<date>/` with the correct suffix (`.spec.yaml` for features, `.component.yaml` for UI specs, `.flow.yaml` for user journeys).
- Reference existing patterns. If a similar feature exists, say "mirrors the pattern in create-checkout.ts" rather than inventing a new approach.- **Check for overlapping specs.** Before creating a new spec, search `docs/specs/` for existing specs that cover similar ground. Don't duplicate.
- **Update the index.** After creating a spec, update `docs/README.md` to include the new file in the appropriate table (per project documentation conventions).- Keep it short. A spec should be scannable in under 2 minutes. If it's longer, split it.
