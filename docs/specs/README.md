# Specs

Design specifications for Ithas Fire. A spec records what was decided and what to build. The code wins where the two disagree.

## Where a spec lives

- A new spec goes in a **date folder** (`YYYY-MM-DD/`) named for the day it was authored.
- A draft sits at the root of its date folder.
- Once the work is implemented and merged, the spec moves into `completed/` inside the same folder. Delete any redirect stub.
- A spec exists in exactly one place. Cross-reference with relative links, never copies.
- Older namespaced catalogs (`events/`, `platform/`, `transport/` and similar) stay where they are until a deliberate migration moves them. New specs go in date folders. Some date folders also hold an `obsolete/` subfolder of retired specs from before the header lines existed; leave them in place.
- Specs get no rows in `docs/README.md`. Find one with `ls docs/specs/<date>/` or `git grep`.

## Naming

File-name suffix gives the type. YAML and Markdown are both valid where noted.

| Suffix | Meaning |
| --- | --- |
| `.spec.yaml` / `.spec.md` | Feature or system spec |
| `.component.yaml` | UI component spec |
| `.flow.yaml` | UI flow or user journey |
| `.transport.yaml` | Transport layer spec |
| `.pipeline.yaml` | Data pipeline spec |
| `.task.yaml` | One-off or scheduled task spec |
| `.schema.yaml` | Database schema spec |
| `.pattern.yaml` / `.pattern.md` | Reusable pattern doc |

## Header lines

Once confirmed, a spec's body stays as written; later state goes in a header line. In YAML a header line is a `#` comment on line 1; in Markdown it is a `> ` line right under the title:

- **Status**: `# Draft, scoping.` or similar, for a spec not yet confirmed.
- **Superseded by**: `# Superseded by <path> (<date>)`, pointing at the spec that replaces it. The old file stays in place.
- **Not built yet**: `# Not built yet (<date>): <what is missing>`, on a spec whose backend or UI has not fully landed.
- **Owner note**: `# Owner note <date>: "<quote>"`, for an owner ruling recorded against the spec.
