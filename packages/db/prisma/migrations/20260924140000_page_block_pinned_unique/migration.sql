-- A PINNED page block lives at most ONCE per page
-- (docs/specs/2026-09-24/venue-track-record-and-review-switch, R6 / FR-012).
--
-- `track_record` is the first pinned block kind: the venue owner can reorder
-- it but never remove or hide it. That makes a duplicate expensive — two
-- copies would be two blocks nobody can delete. Core refuses a second `add`
-- when the page already has one, but that is check-then-create with no lock,
-- and two concurrent recovery adds would both pass the check. This index is
-- the invariant; the adapter maps its P2002 to the same typed BLOCK_PINNED
-- error the core check raises, so the loser gets a 412, not a 500.
--
-- PARTIAL on purpose: only pinned kinds are one-per-page. Every other kind
-- may legitimately repeat (two `photos` blocks, one per section). Prisma
-- cannot express a partial index, so this is raw SQL and the model carries a
-- comment pointing here (the drift guard lives with the data). To pin a
-- second kind, write a NEW migration that drops and recreates this index
-- with `WHERE "kind" IN ('track_record', '<new_kind>')`; never edit this one.
--
-- Section-blind by ruling: the invariant is "one pinned block per page", not
-- "one per section" — core additionally refuses filing a pinned block under
-- any section but "main", so a non-main copy cannot arise in-app.
CREATE UNIQUE INDEX "PageBlock_pinned_kind_per_page_key"
  ON "PageBlock" ("pageId", "kind")
  WHERE "kind" = 'track_record';
