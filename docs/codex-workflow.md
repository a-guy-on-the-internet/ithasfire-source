# Codex workflow for Ithas Fire

This is the Codex adaptation of the project's Claude workflow. Shared project rules remain in `CLAUDE.md`, the role instructions in `.claude/agents/`, and skills in `.claude/skills/`. Read those sources when relevant; this file translates their runtime-specific instructions.

## Tools and roles

- `Task` / `Agent` / `spawn_session`: use native subagents for bounded specialist work. Select the named custom role when the tool supports it. Otherwise read `.codex/agents/<role>.toml` and pass its instructions and source paths in the delegation prompt. A task name alone does not load a role.
- `TodoWrite`: use the available plan tool; when absent, maintain a concise checklist in the task and report meaningful progress.
- `ToolSearch`: discover available tools through the current tool catalog. Browser work uses the available browser/computer-use tools or project Playwright, following their actual API instructions.
- `$ARGUMENTS` in commands means the user's current task. Claude slash commands are available here as `$dev` and the other matching skills.
- Resolve relative skill resources from the original source directory, not the Codex wrapper.

## Development loop

Use `$dev` for implementation: map and plan, route to a specialist, build, independent review, fix findings, then validate the actual result. Review the plan file before edits; the orchestrator can perform that review under an already-authorized implementation request. Carry forward authorization rather than asking again for routine planning or reversible edits.

Delegate independent work alongside useful local work; sequence dependent changes. Give each specialist the goal, owned files, source instructions, constraints, verification commands, and acceptance criteria. Shared worktrees require explicit file ownership and preservation of existing changes. Keep review independent of the author. The reviewer is read-only and returns APPROVED or CHANGES_REQUESTED with actionable findings. Follow the source loop's maximum of three review rounds and report unresolved blockers.

Use the active host's available models. Inherit the parent model by default, including reviews. Claude names such as Haiku and Opus are not Codex model IDs. A Codex UI specialist fills the corresponding implementation/design role under the same UI skill; report model identity accurately. Calling Codex from Codex does not provide cross-model diversity. When Claude hands work to Codex through the `codex-delegate` skill, `scripts/codex-headless.sh` runs the newest listed model in `~/.codex/models_cache.json` (owner ruling 2026-10-07: never pinned); `--model` overrides it per call. Use an external-model integration only when available and appropriate to the authorized work; report its absence if required.

## Validation and permissions

Follow CLAUDE.md's package/app typecheck distinction, real-app checks, and live-stack database protections. Label evidence as executed or reasoned; reading a config or receiving an agent report does not prove runtime behavior. Verify load-bearing agent claims yourself. Use available command execution for read-only inspection even where a Claude role names only Read/Grep/Glob; reviewers do not run builds, tests, or mutations. A role's `disallowedTools` list (e.g. browser-driver's) is binding here too, even though Codex does not enforce it.

Retain the current sandbox and approval controls. A source instruction about bypass flags, provider permissions, sending a Discord update, or tool availability is not a grant in this environment. Obtain any required authorization for the concrete action through the available approval mechanism. Skills requiring unavailable integrations should identify the missing capability rather than inventing a successful run.

## Maintenance

Codex-discoverable wrappers live in `.agents/skills/`; custom roles live in `.codex/agents/`. They point to Claude sources instead of copying their rules. Update a wrapper only when its routing or source path changes. New roles and skills may require a fresh task or app restart to appear in discovery; the current task can read them directly.
