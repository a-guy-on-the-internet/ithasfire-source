# packages/db

This package contains the Prisma schema and database access layer.

The schema is split into domain-specific `.prisma` files under `prisma/`:
`schema.prisma` (generator + datasource), `enums.prisma`, `auth.prisma`,
`org.prisma`, `place.prisma`, `finance.prisma`, `event.prisma`,
`application.prisma`, `ticket.prisma`, `order.prisma`, `resale.prisma`,
`notification.prisma`, `profile.prisma`, `platform.prisma`.
See `docs/decisions/prisma-multi-file-schema.md` for rationale.

## Quick Commands

- Generate Prisma client (from repo root):

  ```bash
  # using npx (from packages/db)
  cd packages/db
  npx prisma generate --schema=prisma/

  # or from repo root with pnpm workspace
  pnpm -C packages/db exec prisma generate --schema=prisma/
  ```

- Create a migration (Postgres example):

  ```bash
  cd packages/db
  # set DATABASE_URL to a Postgres database
  npx prisma migrate dev --name init
  ```

- Smoke test the client (node):

  ```bash
  # set DATABASE_URL to your database (Postgres)
  node test-smoke.js
  ```

## Notes

- The generated Prisma client lands in the workspace `node_modules` (pnpm workspace). If you use pnpm, run the repository-level install.
- If you use nvm, ensure your VS Code and CI environments have Node available in PATH.

## Event template tables

The event template feature from the templates spec introduces a new `EventTemplate` model (see `prisma/event.prisma`). To apply it locally:

1. Ensure `DATABASE_URL` is set to a Postgres database you can reset. For quick smoke work you can point to a disposable local Postgres instance, e.g. `postgres://localhost:5432/postgres`.
2. Run the migration generation command from the repo root (replace the migration name if you prefer):

   ```bash
   cd packages/db
   pnpm exec prisma migrate dev --name add-event-templates
   ```

3. Run `pnpm exec prisma generate` again so downstream packages pick up the new client typings.

## Backfill Notes

- No legacy data exists yet, so there is nothing to migrate. If you have pre-existing seed scripts for events, you can optionally insert starter templates that mirror your go-to configurations.
- The `defaults` column intentionally stores the normalized JSON representation that matches `TemplateDefaults` from `@th/core`. Keep the shape in sync if you evolve the spec.
