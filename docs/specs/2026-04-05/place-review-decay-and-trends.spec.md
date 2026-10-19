# Place Review Decay & Trend Detection

**Date:** 2026-04-05
**Status:** Phase 2 (implement when sufficient review history exists, likely 6+ months post-launch)
**Depends on:** place-reviews-and-stats.spec.md (Phase 1)

---

## Summary

Add time-weighted decay to PlaceStats aggregation so recent reviews carry more weight than old ones. Surface trend direction (IMPROVING / STABLE / DECLINING) so artists and venues can see trajectory, not just snapshots. Additionally, weight verified platform reviews (source: PLATFORM, linked to eventId) higher than unverified seed reviews (source: SURVEY) since platform reviews are cross-referenced against real settlement and ticket data.

This is Phase 2 because decay and trends only become meaningful once you have reviews spanning multiple months. At launch, all reviews are roughly the same age — decay factors would be noise. Implement this when you have 6+ months of review data and venues are starting to accumulate 10+ reviews.

---

## Design

### Time-Weighted Decay

Each review's contribution to aggregate scores decreases over time using exponential decay:

```
weight = e^(-λ * age_in_days)
```

Where λ (lambda) is the decay constant. Tuning λ:
- λ = 0.00189 → half-life of ~12 months (review at 50% weight after 1 year)
- λ = 0.00378 → half-life of ~6 months (more aggressive, better for fast-changing scenes)

**Recommended starting value:** 12-month half-life. A review from last month has ~94% weight. A review from 6 months ago has ~71%. A review from 2 years ago has ~25%. Old data fades but never fully disappears — a venue with 50 reviews from 3 years ago and 2 from last month still shows the recent ones prominently while acknowledging the history.

### Source Weighting

Reviews from different sources have different reliability:

| Source | Weight multiplier | Rationale |
|--------|------------------|-----------|
| PLATFORM | 1.0 | Linked to real event, cross-referenced with settlements |
| SURVEY | 0.8 | Self-reported, unverified, but still valuable |
| IMPORTED | 0.6 | Bulk imported, lowest confidence |

The final weight for any review is: `time_decay_weight * source_weight`

### Combined Weight Formula

```
final_weight = e^(-λ * age_in_days) * source_multiplier
```

All aggregation calculations in `recalculatePlaceStats` switch from simple averages to weighted averages using `final_weight`.

---

## PlaceStats Additions

Add these fields to the existing PlaceStats model:

```prisma
  // ── Recent window stats (last 12 months only) ────────────────────
  recentReviewCount       Int      @default(0)
  recentPayoutMeanCents   Int?
  recentPayoutMedianCents Int?
  recentPayoutStdDevCents Int?
  recentPromotionScore    Float?
  recentSoundScore        Float?
  recentAudienceFitScore  Float?
  recentWouldPlayAgainPct Float?
  recentBookerAvgRating   Float?
  recentParkingScore      Float?

  // ── Trend detection ───────────────────────────────────────────────
  trendDirection          PlaceReviewTrend?  // IMPROVING, STABLE, DECLINING
  trendConfidence         Float?   // 0.0-1.0, based on sample size and delta magnitude
  trendCalculatedAt       DateTime?
```

### New enum

```prisma
enum PlaceReviewTrend {
  IMPROVING
  STABLE
  DECLINING
}
```

---

## Trend Detection Logic

Compare recent window (last 12 months) to all-time stats. The trend is derived from a composite score:

```
composite = average(promotionScore, soundScore, audienceFitScore, wouldPlayAgainPct, normalizedBookerRating)
```

Where `normalizedBookerRating = bookerAvgRating / 5.0` to bring it into the 0-1 range.

```
delta = recentComposite - allTimeComposite
```

| Delta | Trend |
|-------|-------|
| delta > +0.10 | IMPROVING |
| delta < -0.10 | DECLINING |
| abs(delta) <= 0.10 | STABLE |

### Confidence

Trend confidence is based on sample size:

```
confidence = min(1.0, recentReviewCount / 10)
```

At fewer than 3 recent reviews, trend is set to null (not enough data). At 3-9 reviews, confidence is partial. At 10+, confidence is 1.0.

### Payout trends

Payout trends are computed separately because a dollar value trend is more meaningful as a percentage change:

```
payoutDelta = (recentPayoutMeanCents - allTimePayoutMeanCents) / allTimePayoutMeanCents
```

This isn't stored as a separate field — it's computed at query time and surfaced in the API response alongside the other trend data. A venue where recent mean payout is 30% higher than all-time mean tells a clear story.

---

## Recalculation Changes

The existing `recalculatePlaceStats` use case is extended:

1. Fetch all non-hidden, non-flagged reviews for the place
2. Compute `final_weight` for each review (time decay * source weight)
3. Compute all-time stats using weighted averages
4. Filter to reviews within the last 12 months
5. Compute recent stats (unweighted — they're all recent enough)
6. Compute trend direction and confidence from recent vs all-time delta
7. Upsert PlaceStats with all fields

### Weighted average calculation

```typescript
function weightedMean(values: { value: number; weight: number }[]): number {
  const totalWeight = values.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight === 0) return 0;
  return values.reduce((sum, v) => sum + v.value * v.weight, 0) / totalWeight;
}
```

### Weighted standard deviation

```typescript
function weightedStdDev(values: { value: number; weight: number }[]): number {
  const mean = weightedMean(values);
  const totalWeight = values.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight === 0) return 0;
  const variance = values.reduce((sum, v) => sum + v.weight * (v.value - mean) ** 2, 0) / totalWeight;
  return Math.sqrt(variance);
}
```

---

## API Surface Changes

### `getPlacePublicStats` response additions

```typescript
{
  // ... existing fields ...
  recent: {
    reviewCount: number;
    payoutMeanCents: number | null;
    payoutMedianCents: number | null;
    promotionScore: number | null;
    soundScore: number | null;
    // etc.
  } | null;  // null if fewer than 3 recent reviews
  trend: {
    direction: "IMPROVING" | "STABLE" | "DECLINING";
    confidence: number;  // 0.0-1.0
  } | null;  // null if not enough data
}
```

---

## UI Implications

When trend data is available, venue pages can show:
- A trend indicator (↑ IMPROVING / → STABLE / ↓ DECLINING) next to the venue name or overall score
- "Based on X reviews in the last 12 months" context
- Recent vs all-time comparison where they diverge significantly

The trend badge is a trust signal. A declining venue gets a gentle visual indicator that something has changed. An improving venue gets positive reinforcement. This incentivizes venues to actually improve their artist experience because the data is public.

---

## Implementation Triggers

Implement this spec when:
- [ ] At least 20 venues have 5+ reviews each
- [ ] Reviews span at least 6 months of history
- [ ] The recalculatePlaceStats job is already running reliably
- [ ] Venue claiming is live (so venues can see and respond to their trends)

---

## Migration Checklist

- [ ] Add recent* fields and trend fields to PlaceStats model
- [ ] Add PlaceReviewTrend enum
- [ ] Migrate: `prisma migrate dev --name add-place-review-trends`
- [ ] Update `recalculatePlaceStats` with weighted aggregation + trend detection
- [ ] Update `getPlacePublicStats` response schema with recent + trend data
- [ ] Add trend badge component to venue public page
- [ ] Backfill: run recalculation across all existing PlaceStats records
- [ ] Add decay lambda to platform config (adjustable without code change)
