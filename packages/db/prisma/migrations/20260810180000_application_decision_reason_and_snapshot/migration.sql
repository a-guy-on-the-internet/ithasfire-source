-- Application-driven events, Phase 1 (docs/specs/2026-08-10/
-- application-driven-events.spec.md, Decisions D3 + item 3).
--
-- `decisionReason`: optional reviewer-provided, attendee-facing reason for a
-- decision (today: rejection only — included in the rejection email when
-- present). Nullable TEXT; no backfill — historical decisions simply have no
-- recorded reason.
--
-- `questionsSnapshot`: snapshot of the form's questions at SUBMIT time, keyed
-- by question id ({ [questionId]: { label, type, options? } }, options only
-- for choice types). Waiver-style integrity per D3: the review queue renders
-- answers from the snapshot, never from live questions. Default '{}' — the
-- correct value for historical rows, which predate snapshotting (the queue
-- falls back to live questions for an empty snapshot).
--
-- Additive only. Instant on this table (ADD COLUMN with a non-volatile
-- default does not rewrite on PG 11+). Reversible by dropping both columns;
-- existing indexes are untouched.
ALTER TABLE "EventApplicationSubmission" ADD COLUMN "decisionReason" TEXT,
ADD COLUMN "questionsSnapshot" JSONB NOT NULL DEFAULT '{}';
