-- Recurring memberships: tiers, subscriptions, benefits, standing, tax cache.
--
-- Purely additive — five new tables, four new enums, one nullable column on
-- OrderItem. Nothing existing changes shape, so this is safe to apply ahead of
-- any application code that reads it.
--
-- Design notes that are not obvious from the DDL:
--
--  * Membership.status is TEXT, not an enum, because it mirrors STRIPE's
--    subscription status vocabulary rather than ours. Stripe has added values
--    before; failing to persist a real subscription state would be worse than
--    storing a string we do not yet branch on. Every enum below is ours.
--
--  * MembershipTaxJurisdiction is keyed on (country, postal, category) rather
--    than on the member, because membership tax is DESTINATION-sourced and the
--    rate is therefore a property of the place, not the person. Members in the
--    same postal code share one row and one Stripe TaxRate.
--
--  * There is deliberately NO unique constraint across
--    (countryCode, postalCode, taxCategory) — superseded rows are retained with
--    archivedAt set, because subscriptions may still reference an archived rate
--    until they are migrated. Uniqueness among LIVE rows is enforced by the
--    partial index below.

-- CreateEnum
CREATE TYPE "MembershipInterval" AS ENUM ('MONTH', 'YEAR');

CREATE TYPE "MembershipTierStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TYPE "MembershipTaxCategory" AS ENUM ('DIGITAL', 'ADMISSION', 'TANGIBLE', 'MIXED');

CREATE TYPE "MembershipBenefitKind" AS ENUM ('PROMO', 'PRESALE_ACCESS');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "membershipId" TEXT;

-- CreateTable
CREATE TABLE "MembershipTier" (
    "id" TEXT NOT NULL,
    "ownerOrgId" TEXT,
    "ownerHumanId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "interval" "MembershipInterval" NOT NULL DEFAULT 'MONTH',
    "taxCategory" "MembershipTaxCategory" NOT NULL DEFAULT 'DIGITAL',
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "status" "MembershipTierStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipTier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MembershipTaxJurisdiction" (
    "id" TEXT NOT NULL,
    "countryCode" VARCHAR(2) NOT NULL,
    "postalCode" TEXT NOT NULL,
    "taxCategory" "MembershipTaxCategory" NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "rateSource" TEXT NOT NULL,
    "stripeTaxRateId" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipTaxJurisdiction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "memberHumanId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "taxJurisdictionId" TEXT,
    "billingPostalCode" TEXT,
    "billingCountryCode" VARCHAR(2),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MembershipBenefit" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "kind" "MembershipBenefitKind" NOT NULL,
    "promoId" TEXT,
    "categoryId" TEXT,
    "placeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipBenefit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MembershipStanding" (
    "id" TEXT NOT NULL,
    "ownerOrgId" TEXT,
    "ownerHumanId" TEXT,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "reserveBps" INTEGER NOT NULL DEFAULT 0,
    "reserveReleaseDays" INTEGER NOT NULL DEFAULT 90,
    "overriddenBy" TEXT,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipStanding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MembershipTier_stripePriceId_key" ON "MembershipTier"("stripePriceId");
CREATE INDEX "MembershipTier_ownerOrgId_status_idx" ON "MembershipTier"("ownerOrgId", "status");
CREATE INDEX "MembershipTier_ownerHumanId_status_idx" ON "MembershipTier"("ownerHumanId", "status");

CREATE UNIQUE INDEX "MembershipTaxJurisdiction_stripeTaxRateId_key" ON "MembershipTaxJurisdiction"("stripeTaxRateId");
CREATE INDEX "MembershipTaxJurisdiction_countryCode_postalCode_taxCategory_idx" ON "MembershipTaxJurisdiction"("countryCode", "postalCode", "taxCategory", "archivedAt");
CREATE INDEX "MembershipTaxJurisdiction_checkedAt_idx" ON "MembershipTaxJurisdiction"("checkedAt");

-- At most ONE live rate per (country, postal, category). Archived rows are
-- exempt so superseded rates can linger for subscriptions still pointing at
-- them. A plain unique constraint would make archive-and-replace impossible.
CREATE UNIQUE INDEX "MembershipTaxJurisdiction_live_unique"
    ON "MembershipTaxJurisdiction"("countryCode", "postalCode", "taxCategory")
    WHERE "archivedAt" IS NULL;

CREATE UNIQUE INDEX "Membership_stripeSubscriptionId_key" ON "Membership"("stripeSubscriptionId");
CREATE UNIQUE INDEX "Membership_tierId_memberHumanId_key" ON "Membership"("tierId", "memberHumanId");
CREATE INDEX "Membership_memberHumanId_status_idx" ON "Membership"("memberHumanId", "status");
CREATE INDEX "Membership_tierId_status_idx" ON "Membership"("tierId", "status");
CREATE INDEX "Membership_status_currentPeriodEnd_idx" ON "Membership"("status", "currentPeriodEnd");

CREATE INDEX "MembershipBenefit_tierId_idx" ON "MembershipBenefit"("tierId");
CREATE INDEX "MembershipBenefit_promoId_idx" ON "MembershipBenefit"("promoId");

CREATE UNIQUE INDEX "MembershipStanding_ownerOrgId_key" ON "MembershipStanding"("ownerOrgId");
CREATE UNIQUE INDEX "MembershipStanding_ownerHumanId_key" ON "MembershipStanding"("ownerHumanId");

-- AddForeignKey
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_ownerOrgId_fkey" FOREIGN KEY ("ownerOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_ownerHumanId_fkey" FOREIGN KEY ("ownerHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "MembershipTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_memberHumanId_fkey" FOREIGN KEY ("memberHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_taxJurisdictionId_fkey" FOREIGN KEY ("taxJurisdictionId") REFERENCES "MembershipTaxJurisdiction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MembershipBenefit" ADD CONSTRAINT "MembershipBenefit_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "MembershipTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipBenefit" ADD CONSTRAINT "MembershipBenefit_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MembershipStanding" ADD CONSTRAINT "MembershipStanding_ownerOrgId_fkey" FOREIGN KEY ("ownerOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipStanding" ADD CONSTRAINT "MembershipStanding_ownerHumanId_fkey" FOREIGN KEY ("ownerHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
