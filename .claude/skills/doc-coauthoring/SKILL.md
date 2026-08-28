---
name: doc-coauthoring
description: "Structured workflow for co-authoring documentation, specs, standards, or technical writing with the user. Use when asked to 'help me write', 'draft a doc', 'co-author this', 'let us work on the docs together', or when creating any substantial written document that benefits from iterative refinement rather than one-shot generation."
---

# Doc Co-authoring

A structured workflow for writing documents collaboratively with the user. Instead of dumping a finished doc, this skill transfers context, iterates in focused passes, and verifies the output reads well.

## When to Use

- Writing or rewriting docs in `docs/` (standards, specs, guides, READMEs)
- Drafting legal copy, marketing copy, or user-facing content
- Creating ADRs (architectural decision records) — these live in `docs/decisions/`
- Any substantial document where "write the whole thing" would produce generic output
- When the user says "help me write", "draft this", "co-author", "work on the docs"

## Workflow

### Phase 1: Context Transfer

**Goal**: Understand what the user wants to say before trying to say it.

Ask these questions (skip any the user already answered):

1. **What is this document?** (spec, guide, standard, ADR, marketing page, legal page)
2. **Who reads it?** (developers, users, legal reviewers, investors, the user's future self)
3. **What's the one thing the reader should walk away knowing?**
4. **What already exists?** (Is this a rewrite, a new doc, or filling in a stub?)
5. **What's the voice?** (Technical and precise? Conversational? Authoritative?)

If a document already exists, **read it first** before asking questions. Then ask: "What's wrong with the current version?" or "What do you want to change?"

### Phase 2: Outline

Produce a structural outline — section headers with 1-line descriptions of what each section covers. This is cheap to iterate on.

```markdown
## Outline: <Document Name>

1. **<Section>** — <What this covers>
2. **<Section>** — <What this covers>
3. **<Section>** — <What this covers>
...
```

Present the outline so the user can:
- Reorder sections
- Add or remove sections
- Flag sections they want to write themselves vs. delegate to you

**Do not write full prose until the outline is approved.**

### Phase 3: Drafting

Write the document section by section. After each section (or group of related sections), pause and ask for feedback.

**Drafting principles:**
- Write in the voice agreed in Phase 1, filtered through the `unslop` skill's avoid-list
- If the doc is consumed by agents (a skill, AGENTS.md/CLAUDE.md, pointed-to reference), apply the `writing-for-agents` skill instead of prose conventions
- Be concrete. Use examples from the actual codebase when possible.
- Front-load the important stuff. The first sentence of each section should be the key point.
- Keep paragraphs short (3-5 sentences max).
- Use code blocks, tables, and lists to break up walls of text.

**Chunking strategy:**
- For short docs (< 100 lines): Draft the whole thing, present for review
- For medium docs (100-300 lines): Draft in 2-3 chunks
- For long docs (300+ lines): Draft section by section with feedback after each

### Phase 4: Revision

After the full draft exists, do a focused revision pass:

1. **Accuracy pass**: Verify all code references, file paths, and technical claims are correct. Check the codebase.
2. **Audience pass**: Re-read as the target audience. Remove jargon they won't know. Add context they need.
3. **Cut pass**: Remove every sentence that doesn't earn its place. Tighten prose. Kill weasel words ("basically", "simply", "just", "quite", "really").

Present the revised version with a diff summary: "I tightened the intro, fixed the path to the config file, and removed the section on X because it duplicated what's in Y."

### Phase 5: Verification

Before finalizing:

- [ ] All file paths referenced in the doc actually exist
- [ ] Code examples compile / are syntactically valid
- [ ] The doc follows the project's documentation conventions (see `docs/README.md`)
- [ ] New docs are added to the appropriate table in `docs/README.md`
- [ ] Spec docs use the correct suffix (`.spec.yaml`, `.flow.yaml`, etc.)
- [ ] The document is saved to the correct location

## Rules

- **Don't one-shot large documents.** The whole point of co-authoring is iteration. Outline first, then chunk.
- **Read before rewriting.** If a doc already exists, understand what it says before proposing changes. The user may have carefully chosen specific wording.
- **Respect the user's voice.** If they've written part of it, match their style for the rest. Don't impose a different tone.
- **Ask, don't assume.** If you're not sure whether something should be included, ask. "Should we cover X here or is that out of scope?"
- **Show your cuts.** When removing content in revision, explain why. The user may want it back.
- **Reference the codebase.** Good docs are grounded in reality. Link to actual files, use real examples, reference actual behavior.
- **Keep the user in control.** They decide the structure, voice, and scope. You execute and suggest. Never overwrite their decisions.
