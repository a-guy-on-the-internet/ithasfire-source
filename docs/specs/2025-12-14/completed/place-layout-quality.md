# Place Layout Quality & Benchmark Plan

Last updated: 2025-11-14

## Goals

- Guarantee place layout rendering remains responsive across web, mobile, and scanner
  surfaces at arena scale (20k seats).
- Ensure inventory accuracy between place layout visuals and checkout/holds data.
- Provide deterministic QA playbooks for releases touching layout ingestion,
  rendering, or transport layers.
- Automate baseline benchmarks so regressions are caught pre-merge.

## Performance Benchmarks

| Scenario | Target | Tooling | Notes |
| --- | --- | --- | --- |
| Web Place Layout (Canvas 2D) – 10k seats | ≥ 55 FPS p95 interaction | `scripts/perf/place-layout-benchmark.ts` (Chrome headless) | Run on CI perf runner (M2, 16GB). Fails build if < 50 FPS p95. |
| Web Place Layout (WebGL instancing) – 18k seats | ≥ 60 FPS p95 pan/zoom | Same harness w/ `--renderer=webgl` flag | Optional until WebGL phase ships. |
| Mobile Place Layout (Expo Skia) – 12k seats | ≥ 45 FPS average pinch/zoom | Detox harness + Skia profiler | Run nightly on device farm (Pixel 6, iPad Air). |
| Initial Place Layout payload size | ≤ 1.5 MB gzipped for 10k seats | `pnpm -F apps/api smoke place-layouts` | Alerts if > 1.6 MB. |
| Layout status SSE latency | ≤ 1.5s p95 event delivery | `scripts/perf/place-layout-stream-latency.ts` | Measures publish→client receipt via instrumentation. |
| Import pipeline duration | ≤ 5 min end-to-end for 20k seats | Observed via metrics `placeLayout.import.duration_ms` | Ops alerted if > 7 min. |

## Automated Test Matrix

### Unit

- `packages/ui/src/ui/place-layout/__tests__/selection.test.ts`
  - Validate reducer invariants, max selection boundaries, hold countdown behavior.
- `packages/core/src/use-cases/place-layouts/get-place-layout.test.ts`
  - DTO structure, caching, role-based redactions, error paths.
- `packages/adapters/test/place-layouts/layout-repo.test.ts`
  - Publishing immutability, diff summaries, tx handling.

### Integration

- tRPC transport tests covering:
  - `placeLayouts.get` (buyer vs organizer)
  - `placeLayouts.admin.*` mutation matrix
  - SSE endpoint handshake + replay (using supertest + EventSource polyfill)
- Import pipeline worker tests (parse → validate → draft create) with fixture files
  for arena and theatre layouts.

### Visual / UX

- Chromatic stories for PlaceLayoutView variants (small, arena, accessibility, diff overlay).
- Storybook interaction tests for admin editor (zoom controls, diff toggles, issue panel).

### End-to-End

- Playwright flow: organizer imports layout, resolves warning, publishes, buyer loads
  layout and selects seats, checkout completes.
- Mobile (Detox) flow: buyer loads layout, pan/zoom, selection, SSE updates toggle.
- Scanner smoke: read-only layout loads with < 3s cold start.

## QA Checklists

### Before merging place layout–related PRs

- [ ] Updated spec or prompt references if contracts change.
- [ ] Added/updated unit + integration tests.
- [ ] Ran targeted performance harness (`pnpm perf place-layout --scenario=<id>`).
- [ ] Verified Storybook stories pass Chromatic diff.
- [ ] Confirmed ESLint/TypeScript clean on touched packages (`pnpm -F @th/ui lint`, etc.).

### Pre-release (weekly place layout builds)

- [ ] Run full performance matrix above (CLI scheduled via GitHub Actions).
- [ ] Validate SSE latency dashboard stays within target.
- [ ] Ops reviews ImportJob metrics for anomalies.
- [ ] Execute manual accessibility spot check (keyboard nav, SR) on web place layout.
- [ ] Confirm admin editor supports latest venue ingest (scripted dataset).

### Incident Response

- Documented in `runbooks/place-layout.md` (to author) covering:
  - Payload size spikes
  - SSE outage / redis backlog
  - Import validation failures > threshold

## Tooling Roadmap

- [ ] Build `scripts/perf/place-layout-benchmark.ts` harness (web) with CLI flags for
  seat count, renderer, device DPR.
- [ ] Add mobile Skia benchmark harness integrated with Expo test suite.
- [ ] Automate SSE latency probes using k6 or artillery with SSE plugin.
- [ ] Create synthetic dataset generator for massive venues (JSON fixtures).
- [ ] Integrate results with Datadog dashboards + Slack alerts.

## Dependencies

- Access to feature flag `feature.placeLayout` to hit staging routes.
- Seed database with sample venues/events (see `docs/db-setup.md`).
- Object storage bucket configured for layout snapshots.
- Perf CI runners with GPU passthrough for WebGL tests (optional).

## Open Questions

- How to baseline scanner performance metrics when offline cache is introduced?
- Do we need differential thresholds per device class (desktop vs low-end mobile)?
- Should we integrate RUM sampling data into automated gating?
- Where to store historical benchmark artifacts for trend analysis?
