# Contributing to Ithas Fire

Thanks for your interest in contributing. This guide covers what you need to get started.

## Prerequisites

- **Node.js** 20+
- **pnpm** 9+ (corepack-enabled: `corepack enable`)
- **Docker** (Postgres + Redis via `infra/docker/docker-compose.yml`)

## Getting started

```bash
# Install dependencies
pnpm install

# Start local infrastructure (Postgres + Redis)
cd infra/docker && docker compose up -d && cd ../..

# Generate the Prisma client
pnpm prisma:gen

# Apply migrations
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dev?schema=public"
pnpm -C packages/db prisma migrate dev

# Build everything
pnpm build

# Start the full stack (API + Web)
pnpm stack:dev
```

For detailed environment setup, see [`docs/env.md`](docs/env.md) and [`docs/db-setup.md`](docs/db-setup.md).

## Project structure

This is a **pnpm workspaces + Turborepo** monorepo using hexagonal architecture:

| Layer     | Location                  | Purpose                                                 |
| --------- | ------------------------- | ------------------------------------------------------- |
| Core      | `packages/core`           | Pure business logic (use cases). Depends only on ports. |
| Ports     | `packages/ports`          | Interfaces (contracts) for external dependencies.       |
| Adapters  | `packages/adapters`       | Implementations (Prisma, Stripe, Redis, etc.).          |
| Transport | `packages/transport/trpc` | tRPC routers that expose use cases to clients.          |
| Apps      | `apps/*`                  | Product surfaces (API, Web, Mobile, Scanner, Jobs).     |

See [`docs/README.md`](docs/README.md) for the full documentation index.

## Making changes

1. **Read adjacent code first.** Before editing a file, read the files around it and the relevant docs.
2. **Follow the architecture.** Use cases go in `packages/core`, depend only on ports, and never import adapters or transport directly.
3. **Match naming conventions.** Files: `kebab-case`. Types: `PascalCase`. Functions: `camelCase`. Port interfaces: `*.port.ts`. Adapter implementations: `*-adapter.ts`.
4. **Add tests.** Colocate unit tests as `<use-case>.test.ts` in the same folder. Cover at least one happy path and one failure scenario.
5. **Run checks before pushing:**

```bash
pnpm build                           # Full build
pnpm lint                            # Lint (treat warnings as errors)
pnpm -C packages/core vitest --run   # Core unit tests
```

For Prisma schema changes, also run:

```bash
pnpm db:validate
pnpm prisma:gen
```

## Commit conventions

- Each commit should represent a coherent vertical slice or a single refactor.
- Avoid "everything everywhere" commits; split across layers if needed.
- No emojis in commit messages or PR descriptions.
- Document intent and edge cases in PR descriptions, especially around money, auth, or schema changes.

## Documentation

- Docs live in `docs/`. See [`docs/README.md`](docs/README.md) for the index.
- When adding a new doc, add it to the appropriate table in `docs/README.md` in the same PR.
- Specs use a two-folder pattern: drafts at the subdirectory root, completed specs in `completed/`.
- Read [`docs/engineering-standards.md`](docs/engineering-standards.md) and [`docs/hot-paths.md`](docs/hot-paths.md) before making architectural changes.
