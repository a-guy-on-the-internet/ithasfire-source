-- Membership benefits become first-class entities.
--
-- A benefit stops being a pointer at a Promo and carries its own discount
-- terms. The ONE discount ledger (CouponHold / CouponRedemption) is WIDENED to
-- carry either source rather than forked into a second one.
--
-- Why this is safe to do as a destructive column drop: the whole memberships
-- feature is committed but NOT deployed. `MembershipBenefit` rows exist only in
-- local dev databases, and the backfill below converts every one of them before
-- the column goes. Nothing in prod references any of this.
--
-- Design notes that are not obvious from the DDL:
--
--  * The MembershipBenefitKind enum is REPLACED rather than extended. Postgres
--    can add an enum value inside a transaction but cannot USE it until that
--    transaction commits, and Prisma runs each migration in one transaction —
--    so `ADD VALUE 'DISCOUNT'` followed by an UPDATE to 'DISCOUNT' would fail.
--    The create-swap-drop-rename below is the standard way round it and also
--    genuinely retires 'PROMO' instead of leaving it as a trap.
--
--  * `promoId` is dropped only AFTER its terms are copied onto the benefit. A
--    benefit whose promo had already been deleted (the old FK was ON DELETE SET
--    NULL, so those rows exist with promoId = NULL and no terms anywhere) has
--    nothing to copy: it is DELETED rather than resurrected with invented
--    terms. Such a row already granted nothing at checkout — the adapter
--    filtered `promoId IS NOT NULL` — so deleting it removes a tombstone, not
--    an entitlement.
--
--  * The CHECK constraints are the load-bearing half of "one ledger, two
--    sources": exactly one of (couponId, membershipBenefitId) is set on every
--    hold and every redemption. Without them a row could carry both and be
--    counted twice, or neither and be unattributable.
--
--  * The two ledger FKs differ ON PURPOSE. A HOLD cascades (ephemeral, ≤20min,
--    per-order) and keeps the strict exactly-one-of CHECK the adapter's
--    non-null casts rely on. A REDEMPTION is the permanent record and uses SET
--    NULL, with its CHECK relaxed to AT MOST one — because deleting an OWNER
--    cascades Organization/Human → MembershipTier → MembershipBenefit, and
--    RESTRICT there would make `delete-org` and human erasure fail outright
--    once any member had used a benefit. Attribution survives the SET NULL
--    because `code` carries the `benefit:{id}` marker.
--
--  * taxCategory is DROPPED ENTIRELY — enum, both columns, both indexes. It
--    modelled something real (US taxability genuinely varies by digital vs
--    admission vs tangible) that our provider cannot express:
--    TaxRateLookupPort takes only {postalCode, countryCode} and returns ONE
--    rate. The column therefore never moved a cent; it only split one ZIP's
--    jurisdiction cache into N rows and N ZipTax calls, while claiming a
--    determination nobody made. Memberships bill the postal code's general
--    rate, recorded honestly as `rateSource = "…:general"`.
--
--  * PRESALE_ACCESS is dropped rather than kept. It had no behaviour anywhere
--    — every reference was a comment or a filter excluding it — and it was
--    named for a mechanism rather than a need. The enum survives for the perks
--    that are actually coming; the value gets named when it has semantics.

-- CreateEnum
CREATE TYPE "MembershipDiscountKind" AS ENUM ('AMOUNT', 'PERCENT');

-- AlterTable: owner-stated "what do members get", replacing the tax-category
-- dropdown as the tier form's delivery statement. The category itself is
-- dropped entirely further down — see the header note.
ALTER TABLE "MembershipTier" ADD COLUMN "benefitsDescription" VARCHAR(500);

-- AlterTable: discount terms owned by the benefit.
ALTER TABLE "MembershipBenefit" ADD COLUMN "discountKind" "MembershipDiscountKind";
ALTER TABLE "MembershipBenefit" ADD COLUMN "discountValue" INTEGER;
ALTER TABLE "MembershipBenefit" ADD COLUMN "maxDiscountCents" INTEGER;
ALTER TABLE "MembershipBenefit" ADD COLUMN "label" VARCHAR(80);

-- Backfill: copy each promo-backed benefit's terms off its Promo BEFORE the
-- column is dropped. PromoKind and MembershipDiscountKind share their value
-- names ('AMOUNT' / 'PERCENT') but are distinct types, so the cast goes via
-- text.
UPDATE "MembershipBenefit" AS b
SET "discountKind"     = c."kind"::text::"MembershipDiscountKind",
    "discountValue"    = c."value",
    "maxDiscountCents" = c."maxDiscountCents"
FROM "Coupon" AS c
WHERE b."promoId" = c."id";

-- Orphans: kind = PROMO with promoId NULL (the old SetNull FK fired) carry no
-- terms and never granted anything. Nothing to migrate; drop them.
DELETE FROM "MembershipBenefit"
WHERE "kind"::text = 'PROMO' AND "promoId" IS NULL;

-- PRESALE_ACCESS carried no behaviour and no terms; any row wearing it is
-- unmigratable to a DISCOUNT (there is nothing to migrate) and would block the
-- enum swap below. Drop them with the value.
DELETE FROM "MembershipBenefit" WHERE "kind"::text = 'PRESALE_ACCESS';

-- Enum swap: PROMO → DISCOUNT, and PRESALE_ACCESS retired. See the header note
-- on why this is a type swap rather than ALTER TYPE ... ADD VALUE.
CREATE TYPE "MembershipBenefitKind_new" AS ENUM ('DISCOUNT');

ALTER TABLE "MembershipBenefit"
    ALTER COLUMN "kind" TYPE "MembershipBenefitKind_new"
    USING ('DISCOUNT')::"MembershipBenefitKind_new";

DROP TYPE "MembershipBenefitKind";
ALTER TYPE "MembershipBenefitKind_new" RENAME TO "MembershipBenefitKind";

-- DropForeignKey / DropIndex / DropColumn — the Promo reference is gone.
ALTER TABLE "MembershipBenefit" DROP CONSTRAINT "MembershipBenefit_promoId_fkey";
DROP INDEX "MembershipBenefit_promoId_idx";
ALTER TABLE "MembershipBenefit" DROP COLUMN "promoId";

-- ── Ledger widening: one ledger, two sources ────────────────────────────────

-- The source columns become nullable, since a row now carries exactly one.
ALTER TABLE "CouponHold" ALTER COLUMN "couponId" DROP NOT NULL;
ALTER TABLE "CouponRedemption" ALTER COLUMN "couponId" DROP NOT NULL;

ALTER TABLE "CouponHold" ADD COLUMN "membershipBenefitId" TEXT;
ALTER TABLE "CouponRedemption" ADD COLUMN "membershipBenefitId" TEXT;

-- Uniques mirroring the promo ones. Postgres treats NULLs as distinct in a
-- unique index, so promo rows (membershipBenefitId NULL) do not collide with
-- each other here, and vice versa.
CREATE UNIQUE INDEX "CouponHold_membershipBenefitId_idempotencyKey_key"
    ON "CouponHold"("membershipBenefitId", "idempotencyKey");
CREATE UNIQUE INDEX "CouponRedemption_membershipBenefitId_orderId_key"
    ON "CouponRedemption"("membershipBenefitId", "orderId");
CREATE INDEX "CouponRedemption_membershipBenefitId_humanId_idx"
    ON "CouponRedemption"("membershipBenefitId", "humanId");

ALTER TABLE "CouponHold" ADD CONSTRAINT "CouponHold_membershipBenefitId_fkey"
    FOREIGN KEY ("membershipBenefitId") REFERENCES "MembershipBenefit"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: see the header note. Deleting an OWNER cascades into
-- benefits, and this is the record that must survive it.
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_membershipBenefitId_fkey"
    FOREIGN KEY ("membershipBenefitId") REFERENCES "MembershipBenefit"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Exactly one source per row. `num_nonnulls` is the concise spelling and reads
-- the same as the invariant it enforces.
ALTER TABLE "CouponHold" ADD CONSTRAINT "CouponHold_source_xor"
    CHECK (num_nonnulls("couponId", "membershipBenefitId") = 1);
-- AT MOST one, not exactly one — the deliberate loosening that lets the SET
-- NULL above happen. A de-linked row is still attributable: `code` holds the
-- `benefit:{id}` marker. Both-set remains impossible, which is the half that
-- would double-count.
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_source_xor"
    CHECK (num_nonnulls("couponId", "membershipBenefitId") <= 1);

-- Terms completeness, as column definitions rather than a CHECK. With
-- PRESALE_ACCESS gone there is no term-less kind, so "every benefit has terms"
-- stops being a conditional invariant and becomes NOT NULL. Safe here: the
-- backfill populated every promo-backed row and the two DELETEs above removed
-- everything that could not be populated.
ALTER TABLE "MembershipBenefit" ALTER COLUMN "discountKind" SET NOT NULL;
ALTER TABLE "MembershipBenefit" ALTER COLUMN "discountValue" SET NOT NULL;

-- Retirement tombstone: `removeTierBenefit` sets this instead of DELETEing, so
-- the redemption history a benefit produced outlives the entitlement.
ALTER TABLE "MembershipBenefit" ADD COLUMN "archivedAt" TIMESTAMP(3);
-- Supersedes the plain (tierId) index rather than sitting beside it: Postgres
-- serves a tierId-only lookup from this composite's leading column, so keeping
-- both would only add write amplification on every benefit mutation.
DROP INDEX "MembershipBenefit_tierId_idx";
CREATE INDEX "MembershipBenefit_tierId_archivedAt_idx"
    ON "MembershipBenefit"("tierId", "archivedAt");

-- ── Drop taxCategory entirely ───────────────────────────────────────────────
--
-- DEDUPE, do not empty.
--
-- An earlier draft emptied this table on the reasoning that it is "a cache —
-- rows re-resolve on next use". That reasoning is WRONG and the mistake is
-- worth recording, because it is invisible until a rate changes:
-- `Membership.taxJurisdictionId` is ON DELETE SET NULL, so emptying the table
-- nulls every live subscription's pointer — and NOTHING re-resolves a null.
-- The three writers are `startMembership` (signup/resume only),
-- `updateMemberBillingAddress` (only on a customer.updated that actually
-- CHANGES the address), and `refreshTaxJurisdictions` — which iterates
-- `listStale` over the JURISDICTION table, so an empty table means it examines
-- zero rows forever. The subscription keeps billing its old Stripe TaxRate
-- until someone notices, and as merchant of record the shortfall is ours.
--
-- So: keep exactly one LIVE row per (countryCode, postalCode) — which is all
-- the narrowed unique index below requires — repoint any membership that
-- pointed at a loser, and archive the losers. Archived rows are retained by
-- design (subscriptions may still reference them), and every membership ends
-- up on a live row that `listStale` can still see.

-- 1. Repoint memberships onto the survivor for their ZIP, BEFORE archiving
--    anything, so no row is orphaned mid-flight.
UPDATE "Membership" m
SET "taxJurisdictionId" = s."id"
FROM "MembershipTaxJurisdiction" j,
     LATERAL (
       SELECT k."id"
       FROM "MembershipTaxJurisdiction" k
       WHERE k."countryCode" = j."countryCode"
         AND k."postalCode"  = j."postalCode"
         AND k."archivedAt" IS NULL
       ORDER BY k."checkedAt" DESC, k."id"
       LIMIT 1
     ) s
WHERE m."taxJurisdictionId" = j."id"
  AND j."id" <> s."id";

-- 2. Archive every live row that is not its ZIP's survivor. Same
--    archive-and-replace lifecycle refreshTaxJurisdictions already uses, so
--    the narrowed partial unique below has exactly one live row per ZIP.
UPDATE "MembershipTaxJurisdiction" j
SET "archivedAt" = CURRENT_TIMESTAMP
WHERE j."archivedAt" IS NULL
  AND j."id" <> (
    SELECT k."id"
    FROM "MembershipTaxJurisdiction" k
    WHERE k."countryCode" = j."countryCode"
      AND k."postalCode"  = j."postalCode"
      AND k."archivedAt" IS NULL
    ORDER BY k."checkedAt" DESC, k."id"
    LIMIT 1
  );

DROP INDEX "MembershipTaxJurisdiction_live_unique";
DROP INDEX "MembershipTaxJurisdiction_countryCode_postalCode_taxCategory_idx";

ALTER TABLE "MembershipTaxJurisdiction" DROP COLUMN "taxCategory";
ALTER TABLE "MembershipTier" DROP COLUMN "taxCategory";
DROP TYPE "MembershipTaxCategory";

CREATE INDEX "MembershipTaxJurisdiction_countryCode_postalCode_archivedAt_idx"
    ON "MembershipTaxJurisdiction"("countryCode", "postalCode", "archivedAt");

-- At most ONE live rate per (country, postal). Archived rows stay exempt so
-- archive-and-replace keeps working.
CREATE UNIQUE INDEX "MembershipTaxJurisdiction_live_unique"
    ON "MembershipTaxJurisdiction"("countryCode", "postalCode")
    WHERE "archivedAt" IS NULL;
