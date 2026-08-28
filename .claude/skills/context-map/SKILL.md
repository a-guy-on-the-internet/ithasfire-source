---
name: context-map
description: 'Creates a structured map of all files, dependencies, tests, and risks before making any code changes. Use this skill before implementing features, refactoring, or fixing bugs that touch multiple files. Helps identify blast radius, required test updates, and potential side effects. Use when asked to "map the changes", "what files need to change", "analyze impact", or before any multi-file modification.'
---

# Context Map

Before making any changes, create a structured context map to understand the full impact.

## Instructions

When the user asks to implement a feature, fix a bug, or refactor code, FIRST create this map before writing any code.

### 1. Files to Modify
List every file that needs to change:

| File | Change Type | Description |
|------|-------------|-------------|
| path/to/file.ts | EDIT | What changes |
| path/to/new-file.ts | CREATE | Why needed |
| path/to/old-file.ts | DELETE | Why removing |

### 2. Dependencies
Identify what depends on the files being changed:

| Changed File | Depended On By | Risk |
|-------------|---------------|------|
| path/to/port.ts | adapter.ts, use-case.ts | Interface change breaks implementations |

### 3. Tests to Update/Create
List all test files that need changes:

| Test File | Action | Reason |
|-----------|--------|--------|
| path/to/file.test.ts | UPDATE | New parameter added |
| path/to/new.test.ts | CREATE | New feature coverage |

### 4. Reference Patterns
Find existing code that does something similar:

| Pattern | Location | Relevance |
|---------|----------|-----------|
| Similar use case pattern | path/to/example.ts | Mirror this structure |

### 5. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking API contract | HIGH | Check all callers first |
| Missing test coverage | MEDIUM | Add integration test |

## Rules

- **Do not proceed with implementation until this map is reviewed**
- If the map reveals the change is larger than expected, flag it
- Update the map if scope changes during implementation
