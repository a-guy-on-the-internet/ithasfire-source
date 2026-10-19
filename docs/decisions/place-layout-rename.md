# Decision Record: Seatmap → Place Layout Terminology

## Context

Ithas Fire previously used the term "seatmap" across the data model, hexagonal ports, use cases, and documentation. We are renaming the concept to "place layout" to better align with the Place domain language.

## Terminology Mapping

| Old term | New term | Notes |
| --- | --- | --- |
| `Seatmap` (general) | `PlaceLayout` | PascalCase for types/interfaces. |
| `seatmap` (identifier) | `placeLayout` | camelCase for variables and union members. |
| `seatmaps` (collection / folder) | `place-layouts` | kebab-case for directories and import paths. |
| `SeatmapRepo` | `PlaceLayoutRepo` | Applies to all port interfaces. |
| `SeatmapBlobRepo` | `PlaceLayoutBlobRepo` | Applies to blob storage port. |
| `SeatmapStreamingPort` | `PlaceLayoutStreamingPort` | Applies to streaming/broadcast port. |
| `SeatmapDiff` | `PlaceLayoutDiff` | Applies to diff types. |
| `ReplaceSeatmapInput` | `ReplacePlaceLayoutInput` | Applies to use case schemas/types. |
| `DeleteSeatmap` | `DeletePlaceLayout` | Applies to use case names and outputs. |
| `VenueSeatmap` model | `PlaceLayout` | Prisma model + generated types. |
| `venue_seatmaps` table | `place_layouts` | Database table name + migrations. |
| Feature flag `feature.seatmap` | `feature.place_layout` | Update config + references. |
| Metrics/events prefixed `seatmap.` | `place_layout.` | Keep structured suffixes. |
| Cache keys `seatmap:*` | `place_layout:*` | Preserve downstream expectations. |

## Update Order

1. **Schema**: rename the Prisma model, relation fields, and enums as needed; generate a migration for the renamed table and columns.
2. **Ports**: move `packages/ports/src/seatmaps` to `place-layouts`; rename exported symbols.
3. **Core use cases**: rename files in `packages/core/src/use-cases/seatmaps` and update imports, tests, and error codes.
4. **Transport**: rename TRPC router, context dependencies, and exposed procedures.
5. **Adapters/Test utils**: update fake repos, dependency injection registrations, and any stubbed data keyed by `seatmap`.
6. **Docs & Specs**: run through specs, prompts, and runbooks updating terminology, feature flags, and metric namespaces.
7. **Validation**: regenerate Prisma client, run TypeScript builds, and execute focused Vitest suites.

## Follow-up

- Communicate the rename to data/analytics teams so dashboards and alerts swap to the new metric names.
- Coordinate feature flag rename in configuration before deploying.
- Monitor for lingering `seatmap` references post-merge using `rg "seatmap"`.
