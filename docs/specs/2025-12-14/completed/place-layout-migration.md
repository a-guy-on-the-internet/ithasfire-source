# Place Layout Terminology Migration

This note captures the canonical replacements for the former “seatmap” terminology as we rename the domain to “place layout”. Use this mapping across code, schema, telemetry, and documentation.

## Identifier mapping

| Scope | Old | New |
| --- | --- | --- |
| Directory / package name | `seatmaps` | `place-layouts` |
| PascalCase type | `Seatmap` | `PlaceLayout` |
| CamelCase identifier | `seatmap` | `placeLayout` |
| PascalCase use case | `ReplaceSeatmap` | `ReplacePlaceLayout` |
| PascalCase use case | `DeleteSeatmap` | `DeletePlaceLayout` |
| Port interface | `SeatmapRepo` | `PlaceLayoutRepo` |
| Port interface | `SeatmapBlobRepo` | `PlaceLayoutBlobRepo` |
| Port interface | `SeatmapStreamingPort` | `PlaceLayoutStreamingPort` |
| Port types | `SeatmapDiff`, `SeatmapSnapshot`, `SeatmapParserIssue` | `PlaceLayoutDiff`, `PlaceLayoutSnapshot`, `PlaceLayoutParserIssue` |
| Prisma model | `VenueSeatmap` | `PlaceLayout` |
| Prisma relation field | `Place.seatmap` | `Place.placeLayout` |
| Prisma relation field | `Human.venueSeatmaps` | `Human.placeLayoutsCreated` |
| Table name | `venue_seatmaps` | `place_layouts` |
| Feature flag | `feature.seatmap` | `feature.placeLayout` |
| Metrics prefix | `seatmap.*` | `placeLayout.*` |
| Cache/Idempotency key prefix | `seatmap:` | `placeLayout:` |
| Audit entity/action | `seatmap.*` | `placeLayout.*` |
| TRPC router namespace | `seatmaps.*` | `placeLayouts.*` |

## Compatibility notes

- Update downstream infrastructure (feature-flag service, metrics dashboards, alerting) in step with the rename. If dual-writing is required temporarily, prefer writing to both `seatmap.*` and `placeLayout.*` metrics while consumers migrate.
- External documentation and runbooks should be refreshed to avoid mixed terminology.
- Any persisted references (e.g., event logs) that rely on the old strings should either be backfilled or explicitly documented as legacy naming.
