
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AgreementType" AS ENUM ('PERFORMANCE', 'VENUE_RENTAL', 'SERVICES', 'REVENUE_SHARE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'PROPOSED', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'FULFILLED', 'EXPIRED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('PENDING', 'VIEWED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "HumanStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'FINANCE', 'SCANNER', 'VIEWER');

-- CreateEnum
CREATE TYPE "PlaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PayeeSubjectType" AS ENUM ('HUMAN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "PayeeStatus" AS ENUM ('PENDING', 'ACTIVE', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "PaymentFeeType" AS ENUM ('ABSORB', 'PASS_THROUGH');

-- CreateEnum
CREATE TYPE "FeePolicyScopeType" AS ENUM ('GLOBAL', 'ORG', 'EVENT');

-- CreateEnum
CREATE TYPE "FeePolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PayoutTermsKind" AS ENUM ('PRIMARY', 'RESALE');

-- CreateEnum
CREATE TYPE "PayoutTermsStatus" AS ENUM ('PENDING', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PayoutTermsBasis" AS ENUM ('GROSS', 'NET_AFTER_PLATFORM_FEES');

-- CreateEnum
CREATE TYPE "PayoutSchedule" AS ENUM ('ASAP', 'WEEK_OF_EVENT', 'ONE_WEEK_AFTER', 'TWO_WEEKS_AFTER', 'FOUR_WEEKS_AFTER');

-- CreateEnum
CREATE TYPE "PayoutTermsLineRounding" AS ENUM ('FLOOR', 'NEAREST');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EventHumanRole" AS ENUM ('PERFORMER', 'HOST', 'DJ', 'INSTRUCTOR', 'SPEAKER', 'VENDOR', 'VOLUNTEER', 'OTHER');

-- CreateEnum
CREATE TYPE "EventVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "EventGateType" AS ENUM ('NONE', 'APPLICATION', 'PASSWORD');

-- CreateEnum
CREATE TYPE "EventLocationMode" AS ENUM ('EXACT', 'APPROXIMATE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "EventUnlockSource" AS ENUM ('PASSWORD', 'APPLICATION', 'ADMIN', 'INVITE_LIST', 'MAGIC_LINK');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('DISABLED', 'SCHEDULED', 'OPEN');

-- CreateEnum
CREATE TYPE "WaitlistEntrySource" AS ENUM ('PUBLIC', 'INVITE', 'APPLICATION');

-- CreateEnum
CREATE TYPE "WaitlistEntryStatus" AS ENUM ('PENDING', 'NOTIFIED', 'PURCHASED', 'DROPPED');

-- CreateEnum
CREATE TYPE "ApplicationQuestionType" AS ENUM ('SHORT_TEXT', 'LONG_TEXT', 'MULTI_CHOICE', 'SINGLE_CHOICE');

-- CreateEnum
CREATE TYPE "ApplicationSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InviteListOwnerType" AS ENUM ('HUMAN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "ContactImportFileFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "TicketTypeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('AVAILABLE', 'HELD', 'SOLD', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SeatSectionType" AS ENUM ('GA', 'RESERVED');

-- CreateEnum
CREATE TYPE "PlaceOwnerType" AS ENUM ('HUMAN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "TemplateOwnerScope" AS ENUM ('HUMAN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "EventSeriesOwnerScope" AS ENUM ('HUMAN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "EventSeriesOccurrenceStatus" AS ENUM ('PLANNED', 'SKIPPED', 'GENERATED', 'PUBLISHED', 'CANCELLED', 'DETACHED');

-- CreateEnum
CREATE TYPE "PlaceVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'PENDING', 'REJECTED');

-- CreateEnum
CREATE TYPE "PlaceVerificationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HumanRole" AS ENUM ('USER', 'REVIEWER', 'ADMIN', 'DEVELOPER', 'SUPPORT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED', 'REFUNDED', 'DISPUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('PRIMARY', 'RESALE', 'COMP');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('VALID', 'SCANNED', 'INVALID', 'REFUNDED', 'LISTED');

-- CreateEnum
CREATE TYPE "TicketScanOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'REPLAY');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'HELD', 'SOLD', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "EmbedStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CouponKind" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "CouponScope" AS ENUM ('GLOBAL', 'ORG', 'EVENT', 'TICKET_TYPE');

-- CreateEnum
CREATE TYPE "CouponHoldStatus" AS ENUM ('PENDING', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "PushProvider" AS ENUM ('expo', 'fcm', 'apns', 'web');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ios', 'android', 'web', 'unknown');

-- CreateEnum
CREATE TYPE "NotificationDigestType" AS ENUM ('ORGANIZER_WEEKLY', 'ATTENDEE_FEEDBACK');

-- CreateEnum
CREATE TYPE "NotificationDigestChannel" AS ENUM ('EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "FeedbackRequestStatus" AS ENUM ('PENDING', 'SCHEDULED', 'SENT', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "OrgInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OrgTrustTier" AS ENUM ('NEW', 'ESTABLISHED', 'TRUSTED', 'TOP', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ImageOwnerType" AS ENUM ('EVENT', 'ORG');

-- CreateEnum
CREATE TYPE "AudioUploadStatus" AS ENUM ('PENDING', 'UPLOADED', 'TRANSCODING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "PendingTicketTransferStatus" AS ENUM ('PENDING', 'CLAIMED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AnnouncementAudienceType" AS ENUM ('ALL_TICKET_HOLDERS', 'EVENT_TICKET_HOLDERS', 'MULTIPLE_EVENTS', 'EVENT_TICKET_TIER', 'CONTACT_LIST', 'WAITLIST_SUBSCRIBERS');

-- CreateEnum
CREATE TYPE "ResourceLimitKind" AS ENUM ('ORGS_OWNED', 'ORGS_JOINED', 'STORAGE_BYTES_ORG', 'STORAGE_BYTES_HUMAN', 'EVENTS_PER_ORG', 'MEMBERS_PER_ORG', 'ANNOUNCEMENTS_PER_DAY');

-- CreateEnum
CREATE TYPE "QuotaSubjectType" AS ENUM ('HUMAN', 'ORG');

-- CreateEnum
CREATE TYPE "ExpansionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PageOwnerType" AS ENUM ('HUMAN', 'ORGANIZATION', 'PLACE');

-- CreateEnum
CREATE TYPE "PageVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'UNLISTED');

-- CreateEnum
CREATE TYPE "NotificationPreferenceScopeKind" AS ENUM ('GLOBAL', 'ORG', 'EVENT');

-- CreateEnum
CREATE TYPE "VolunteerSignupStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CHECKED_IN', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "PlaceReviewPaymentMethod" AS ENUM ('GUARANTEE', 'DOOR_SPLIT', 'TICKET_SALES', 'BAR_PERCENTAGE', 'TIPS_ONLY', 'PAY_TO_PLAY', 'UNPAID', 'OTHER');

-- CreateEnum
CREATE TYPE "PlaceReviewPromotionLevel" AS ENUM ('ACTIVELY_PROMOTED', 'POSTED_ONCE', 'NO_PROMOTION');

-- CreateEnum
CREATE TYPE "PlaceReviewSoundQuality" AS ENUM ('GREAT', 'ADEQUATE', 'BAD', 'NONEXISTENT', 'LIED_ABOUT_IT');

-- CreateEnum
CREATE TYPE "PlaceReviewStageEquipment" AS ENUM ('FULL', 'PARTIAL', 'NONE', 'LIED_ABOUT_IT');

-- CreateEnum
CREATE TYPE "PlaceReviewAudienceFit" AS ENUM ('PERFECT_FIT', 'OKAY', 'WRONG_CROWD');

-- CreateEnum
CREATE TYPE "PlaceReviewPlayAgain" AS ENUM ('YES', 'MAYBE', 'NO');

-- CreateEnum
CREATE TYPE "PlaceReviewParking" AS ENUM ('DEDICATED_LOT', 'STREET_NEARBY', 'DIFFICULT', 'NIGHTMARE');

-- CreateEnum
CREATE TYPE "PlaceReviewBookerRating" AS ENUM ('EXCELLENT', 'GOOD', 'OKAY', 'POOR', 'TERRIBLE');

-- CreateEnum
CREATE TYPE "PlaceReviewSource" AS ENUM ('SURVEY', 'PLATFORM', 'IMPORTED');

-- CreateTable
CREATE TABLE "Agreement" (
    "id" TEXT NOT NULL,
    "type" "AgreementType" NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "proposerType" TEXT NOT NULL,
    "proposerId" TEXT NOT NULL,
    "counterpartyType" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "placeId" TEXT,
    "eventId" TEXT,
    "payoutTermsId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "proposedDate" TIMESTAMP(3),
    "proposedEndDate" TIMESTAMP(3),
    "guaranteeCents" INTEGER,
    "proposedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declinedReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "waiverAccepted" BOOLEAN NOT NULL DEFAULT false,
    "waiverAcceptedAt" TIMESTAMP(3),
    "waiverVersion" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "artistHumanId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "preferredDates" JSONB NOT NULL DEFAULT '[]',
    "expectedDraw" INTEGER,
    "genre" TEXT,
    "links" JSONB NOT NULL DEFAULT '[]',
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'PENDING',
    "viewedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "agreementId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceWaiver" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceAvailability" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "date" TIMESTAMP(3),
    "startTime" TEXT,
    "endTime" TEXT,
    "note" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "eventId" TEXT,
    "subject" TEXT NOT NULL,
    "bodyDoc" JSONB NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "audienceType" "AnnouncementAudienceType" NOT NULL,
    "audienceRef" TEXT,
    "audienceFilter" JSONB,
    "excludedContactListId" TEXT,
    "recipientCount" INTEGER,
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventApplicationForm" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "introText" TEXT,
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "updatedByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventApplicationForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventApplicationQuestion" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "type" "ApplicationQuestionType" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "options" JSONB,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventApplicationQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventApplicationSubmission" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" "ApplicationSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "reviewerHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvalToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventApplicationSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventWaitlistEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "source" "WaitlistEntrySource" NOT NULL DEFAULT 'PUBLIC',
    "status" "WaitlistEntryStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "notifiedAt" TIMESTAMP(3),
    "convertedOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteList" (
    "id" TEXT NOT NULL,
    "ownerType" "InviteListOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "passwordHint" TEXT,
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "lastImportAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InviteList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteListEntry" (
    "id" TEXT NOT NULL,
    "inviteListId" TEXT NOT NULL,
    "humanId" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "displayName" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastInvitedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "importId" TEXT,
    "consentSource" TEXT,
    "consentRecordedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InviteListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactImport" (
    "id" TEXT NOT NULL,
    "ownerType" "InviteListOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "inviteListId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileFormat" "ContactImportFileFormat" NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "chunksReceived" INTEGER NOT NULL DEFAULT 1,
    "totalChunks" INTEGER,
    "completedAt" TIMESTAMP(3),
    "createdByHumanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventInviteList" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "inviteListId" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventInviteList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Human" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "status" "HumanStatus" NOT NULL DEFAULT 'ACTIVE',
    "roles" "HumanRole"[],
    "locale" TEXT,
    "phone" TEXT,
    "billingAddressLine1" TEXT,
    "billingAddressLine2" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "billingPostalCode" TEXT,
    "billingCountry" TEXT,
    "trust_tier" "OrgTrustTier" NOT NULL DEFAULT 'NEW',
    "trust_badge_label" TEXT,
    "trust_badge_icon" TEXT,
    "default_primary_payout_terms_id" TEXT,
    "default_resale_payout_terms_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Human_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_user" (
    "id" TEXT NOT NULL,
    "human_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "phone_number" TEXT,
    "phone_number_verified" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "display_username" TEXT,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "scope" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_two_factor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "auth_two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "human_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "provider" "PushProvider" NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "appId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityPage" (
    "id" TEXT NOT NULL,
    "ownerType" "PageOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "bannerUrl" TEXT,
    "visibility" "PageVisibility" NOT NULL DEFAULT 'PUBLIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageTheme" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "colorPrimary" TEXT,
    "colorBg" TEXT,
    "colorText" TEXT,
    "fontKey" TEXT,
    "layoutKey" TEXT,

    CONSTRAINT "PageTheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageBlock" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL DEFAULT '{}',
    "visible" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PageBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageSlugHistory" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageSlugHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventType" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventTag" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventHuman" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT,
    "externalName" TEXT,
    "externalUrl" TEXT,
    "role" "EventHumanRole" NOT NULL DEFAULT 'PERFORMER',
    "customRoleLabel" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventHuman_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventTemplate" (
    "id" TEXT NOT NULL,
    "ownerScope" "TemplateOwnerScope" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaults" JSONB,
    "createdByHumanId" TEXT NOT NULL,
    "updatedByHumanId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSeries" (
    "id" TEXT NOT NULL,
    "ownerScope" "EventSeriesOwnerScope" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL,
    "schedule" JSONB NOT NULL,
    "templateId" TEXT,
    "defaults" JSONB,
    "createdByHumanId" TEXT NOT NULL,
    "updatedByHumanId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSeriesOccurrence" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" "EventSeriesOccurrenceStatus" NOT NULL DEFAULT 'PLANNED',
    "eventId" TEXT,
    "overrides" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSeriesOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "humanId" TEXT,
    "orgId" TEXT,
    "placeId" TEXT,
    "savedLocationId" TEXT,
    "categoryId" TEXT,
    "typeId" TEXT,
    "addressText" TEXT,
    "countryCode" TEXT,
    "region" TEXT,
    "locality" TEXT,
    "postalCode" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "geohash6" TEXT,
    "geohash8" TEXT,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "EventVisibility" NOT NULL DEFAULT 'PUBLIC',
    "gateType" "EventGateType" NOT NULL DEFAULT 'NONE',
    "locationMode" "EventLocationMode" NOT NULL DEFAULT 'EXACT',
    "locationRadiusMeters" INTEGER DEFAULT 500,
    "locationLabel" TEXT,
    "slug" TEXT,
    "shortId" TEXT,
    "regionCode" TEXT,
    "publishedAt" TIMESTAMP(3),
    "default_locale" TEXT,
    "listing_priority" INTEGER,
    "passwordHash" TEXT,
    "passwordUpdatedAt" TIMESTAMP(3),
    "waitlistStatus" "WaitlistStatus" NOT NULL DEFAULT 'DISABLED',
    "waitlistPublishAt" TIMESTAMP(3),
    "waitlistDescription" TEXT,
    "waitlistCap" INTEGER,
    "waitlist_email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "waitlist_email_subject" TEXT,
    "waitlist_email_body" JSONB,
    "volunteeringEnabled" BOOLEAN NOT NULL DEFAULT false,
    "volunteerAutoApprove" BOOLEAN NOT NULL DEFAULT false,
    "volunteerIntroText" TEXT,
    "currency" VARCHAR(3),
    "refundCutoffAt" TIMESTAMP(3),
    "admission_tax_rate_bps" INTEGER,
    "tax_rate_source" TEXT,
    "body" JSONB,
    "hero_image_id" TEXT,
    "payout_terms_id" TEXT,
    "resale_payout_terms_id" TEXT,
    "place_layout_id" TEXT,
    "waiver_template_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventUnlock" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "source" "EventUnlockSource" NOT NULL,
    "applicationSubmissionId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMagicLink" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "targetHumanId" TEXT,
    "createdByHumanId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventMagicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_images" (
    "id" TEXT NOT NULL,
    "ownerType" "ImageOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "eventId" TEXT,
    "key" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT,
    "uploadedAt" TIMESTAMP(3),
    "attached" BOOLEAN NOT NULL DEFAULT false,
    "attachedAt" TIMESTAMP(3),
    "detachedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdByHumanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_uploads" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceContentType" TEXT,
    "sourceSizeBytes" BIGINT,
    "hlsPlaylistKey" TEXT,
    "hlsPlaylistUrl" TEXT,
    "segmentCount" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "status" "AudioUploadStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedAt" TIMESTAMP(3),
    "transcodedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "attached" BOOLEAN NOT NULL DEFAULT false,
    "attachedAt" TIMESTAMP(3),
    "detachedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdByHumanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audio_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "featured_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "curated_by_human_id" TEXT,
    "curated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "curated_until" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "featured_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSlugHistory" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventSlugHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payee" (
    "id" TEXT NOT NULL,
    "subjectType" "PayeeSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "stripeAccountId" TEXT,
    "status" "PayeeStatus" NOT NULL DEFAULT 'PENDING',
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'usd',
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeePolicy" (
    "id" TEXT NOT NULL,
    "scopeType" "FeePolicyScopeType" NOT NULL,
    "scopeId" TEXT,
    "status" "FeePolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "buyerFeePct" DECIMAL(5,4) NOT NULL,
    "maxFeeCents" INTEGER,
    "minFeeCents" INTEGER NOT NULL DEFAULT 0,
    "maxPlatformFeeCents" INTEGER,
    "platformFixedCents" INTEGER NOT NULL DEFAULT 0,
    "feeMode" "PaymentFeeType" NOT NULL DEFAULT 'PASS_THROUGH',
    "processsorFeePct" DECIMAL(5,4) NOT NULL,
    "processorFixedCents" INTEGER NOT NULL,
    "payoutPct" DECIMAL(5,4) NOT NULL,
    "payoutFixedCents" INTEGER NOT NULL,
    "monthlyPayoutCents" INTEGER NOT NULL,
    "payoutMinimumCents" INTEGER NOT NULL DEFAULT 1000,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutTerms" (
    "id" TEXT NOT NULL,
    "kind" "PayoutTermsKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "settlementCurrency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "basis" "PayoutTermsBasis" NOT NULL DEFAULT 'NET_AFTER_PLATFORM_FEES',
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "status" "PayoutTermsStatus" NOT NULL DEFAULT 'PENDING',
    "feeMode" "PaymentFeeType",
    "feePolicyId" TEXT,
    "payoutSchedule" "PayoutSchedule" NOT NULL DEFAULT 'WEEK_OF_EVENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutTermsLine" (
    "id" TEXT NOT NULL,
    "payoutTermsId" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "ticketTypeId" TEXT,
    "percent" INTEGER NOT NULL,
    "floorCents" INTEGER NOT NULL DEFAULT 0,
    "capPercent" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "rounding" "PayoutTermsLineRounding" NOT NULL DEFAULT 'FLOOR',

    CONSTRAINT "PayoutTermsLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSplit" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "OrderSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "scheduledPayoutDate" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "fxRate" DECIMAL(18,8),
    "stripeTransferId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payoutId" TEXT,
    "payoutTermsId" TEXT,
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementLine" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderSplitId" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemSettlementLine" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "settlementLineId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItemSettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "canceledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "processorBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutItem" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "amountCents" INTEGER NOT NULL,
    "stripeTransferId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutItemSettlement" (
    "payoutItemId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,

    CONSTRAINT "PayoutItemSettlement_pkey" PRIMARY KEY ("payoutItemId","settlementId")
);

-- CreateTable
CREATE TABLE "FeedbackRequest" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "status" "FeedbackRequestStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "NotificationDigestChannel" NOT NULL DEFAULT 'EMAIL',
    "sendAfter" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "payloadHash" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDigestSubscription" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "digestType" "NotificationDigestType" NOT NULL,
    "subscribed" BOOLEAN NOT NULL DEFAULT true,
    "unsubscribedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDigestSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDigestLog" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "orgId" TEXT,
    "eventId" TEXT,
    "digestType" "NotificationDigestType" NOT NULL,
    "channel" "NotificationDigestChannel" NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "metadata" JSONB,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDigestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "metadata" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "actionLabel" TEXT,
    "actionHref" TEXT,
    "actionRoute" TEXT,
    "templateKey" TEXT,
    "templateVersion" TEXT,
    "templateVariables" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "scopeKind" "NotificationPreferenceScopeKind" NOT NULL DEFAULT 'GLOBAL',
    "orgId" TEXT NOT NULL DEFAULT '',
    "eventId" TEXT NOT NULL DEFAULT '',
    "delta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shortId" TEXT,
    "eventId" TEXT NOT NULL,
    "buyerHumanId" TEXT NOT NULL,
    "amountGrossCents" INTEGER NOT NULL,
    "feesPlatformCents" INTEGER NOT NULL DEFAULT 0,
    "taxAmountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "feePolicySnapshot" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stripePaymentIntentId" TEXT,
    "parentOrderId" TEXT,
    "source" "OrderSource" NOT NULL DEFAULT 'PRIMARY',
    "paymentMethodType" VARCHAR(32),
    "billingAddressLine1" TEXT,
    "billingAddressLine2" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "billingPostalCode" TEXT,
    "billingCountry" VARCHAR(2),
    "stripeTaxCalculationId" TEXT,
    "paidOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ticketTypeId" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "paidOutAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "transferredAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_locale" TEXT,
    "contact_email" TEXT,
    "physical_address" TEXT,
    "default_primary_payout_terms_id" TEXT,
    "default_resale_payout_terms_id" TEXT,
    "clerkOrgId" TEXT,
    "trust_tier" "OrgTrustTier" NOT NULL DEFAULT 'NEW',
    "trust_badge_label" TEXT,
    "trust_badge_icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSlugHistory" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgSlugHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgMember" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "clerkMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgInvitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "invitedByHumanId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "OrgInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanDelegate" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "delegateId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanDelegate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceReview" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "humanId" TEXT,
    "anonymousName" TEXT,
    "anonymousEmail" TEXT,
    "payoutCents" INTEGER,
    "paymentMethod" "PlaceReviewPaymentMethod" NOT NULL,
    "paymentDetail" VARCHAR(500),
    "venuePromoted" "PlaceReviewPromotionLevel" NOT NULL,
    "promotionDetail" VARCHAR(500),
    "soundQuality" "PlaceReviewSoundQuality" NOT NULL,
    "soundDetail" VARCHAR(500),
    "stageEquipment" "PlaceReviewStageEquipment" NOT NULL,
    "stageEquipmentDetail" VARCHAR(500),
    "audienceFit" "PlaceReviewAudienceFit" NOT NULL,
    "audienceDetail" VARCHAR(500),
    "parkingLoadIn" "PlaceReviewParking" NOT NULL,
    "parkingDetail" VARCHAR(500),
    "bookerRating" "PlaceReviewBookerRating" NOT NULL,
    "bookerDetail" VARCHAR(500),
    "wouldPlayAgain" "PlaceReviewPlayAgain" NOT NULL,
    "comment" VARCHAR(1000),
    "genre" VARCHAR(200),
    "estimatedDraw" INTEGER,
    "source" "PlaceReviewSource" NOT NULL DEFAULT 'SURVEY',
    "eventId" TEXT,
    "responseText" VARCHAR(500),
    "responseById" TEXT,
    "respondedAt" TIMESTAMP(3),
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceStats" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCountPublic" INTEGER NOT NULL DEFAULT 0,
    "payoutMeanCents" INTEGER,
    "payoutMedianCents" INTEGER,
    "payoutMinCents" INTEGER,
    "payoutMaxCents" INTEGER,
    "payoutStdDevCents" INTEGER,
    "payoutSampleSize" INTEGER NOT NULL DEFAULT 0,
    "payoutGuaranteePct" DOUBLE PRECISION,
    "payoutDoorSplitPct" DOUBLE PRECISION,
    "payoutTicketSalesPct" DOUBLE PRECISION,
    "payoutTipsPct" DOUBLE PRECISION,
    "payoutPayToPlayPct" DOUBLE PRECISION,
    "payoutUnpaidPct" DOUBLE PRECISION,
    "promotionScore" DOUBLE PRECISION,
    "soundScore" DOUBLE PRECISION,
    "audienceFitScore" DOUBLE PRECISION,
    "wouldPlayAgainPct" DOUBLE PRECISION,
    "bookerScore" DOUBLE PRECISION,
    "parkingScore" DOUBLE PRECISION,
    "stageEquipmentScore" DOUBLE PRECISION,
    "drawMean" INTEGER,
    "drawMedian" INTEGER,
    "drawMin" INTEGER,
    "drawMax" INTEGER,
    "drawSampleSize" INTEGER NOT NULL DEFAULT 0,
    "payToPlayFlagged" BOOLEAN NOT NULL DEFAULT false,
    "equipmentLiedFlagged" BOOLEAN NOT NULL DEFAULT false,
    "noPromotionFlagged" BOOLEAN NOT NULL DEFAULT false,
    "genreCloud" JSONB NOT NULL DEFAULT '[]',
    "totalEventCount" INTEGER NOT NULL DEFAULT 0,
    "totalTicketsSold" INTEGER NOT NULL DEFAULT 0,
    "avgTicketPriceCents" INTEGER,
    "avgAttendance" INTEGER,
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "address" TEXT NOT NULL,
    "addrLine1" TEXT,
    "addrLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postcode" TEXT,
    "country" TEXT,
    "addressHash" TEXT,
    "capacity" INTEGER,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" "PlaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "verificaion" "PlaceVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "listed_in_directory" BOOLEAN NOT NULL DEFAULT false,
    "default_primary_payout_terms_id" TEXT,
    "default_resale_payout_terms_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceSlugHistory" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceSlugHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place_layouts" (
    "id" TEXT NOT NULL,
    "place_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "checksum" TEXT NOT NULL,
    "glyph_snapshot_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "seat_index" JSONB NOT NULL DEFAULT '{}',
    "stage" JSONB NOT NULL DEFAULT '{}',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "created_by_human_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "place_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedLocation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "countryCode" TEXT,
    "region" TEXT,
    "locality" TEXT,
    "postalCode" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "ownerType" "PlaceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "geohash6" TEXT,
    "geohash8" TEXT,
    "placeId" TEXT,
    "admission_tax_rate_bps" INTEGER,
    "tax_rate_fetched_at" TIMESTAMP(3),
    "tax_rate_source" TEXT,
    "address_hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceOwnership" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "ownerType" "PlaceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "reviewerHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "proof" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceVerificationRequest" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "status" "PlaceVerificationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerNotes" TEXT,
    "reviewerHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceVerificationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceVerificationDocument" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceVerificationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatSection" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SeatSectionType" NOT NULL DEFAULT 'GA',
    "capacity" INTEGER,
    "geometry" JSONB,
    "stage_anchor" JSONB,
    "layout_section_id" TEXT,
    "place_layout_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "seatSectionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "row" TEXT,
    "number" INTEGER,
    "status" "SeatStatus" NOT NULL,
    "geometry" JSONB,
    "price_override" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "action" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Idempotency" (
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "resultJson" JSONB,
    "errorText" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Idempotency_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "EventDailyStats" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "grossRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "netRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "ticketsSold" INTEGER NOT NULL DEFAULT 0,
    "ticketsRefunded" INTEGER NOT NULL DEFAULT 0,
    "ticketsTransferred" INTEGER NOT NULL DEFAULT 0,
    "totalCapacity" INTEGER NOT NULL DEFAULT 0,
    "sellThroughRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "refundCount" INTEGER NOT NULL DEFAULT 0,
    "ticketTypeStats" JSONB NOT NULL DEFAULT '[]',
    "waitlistCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventDailyStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResalePriceSnapshot" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "suggestedPriceCents" INTEGER NOT NULL,
    "facePriceCents" INTEGER NOT NULL,
    "resaleCapCents" INTEGER,
    "demandTier" TEXT NOT NULL,
    "sellThroughRate" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'heuristic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResalePriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefaultResourceLimit" (
    "kind" "ResourceLimitKind" NOT NULL,
    "limitValue" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefaultResourceLimit_pkey" PRIMARY KEY ("kind")
);

-- CreateTable
CREATE TABLE "ResourceQuotaOverride" (
    "id" TEXT NOT NULL,
    "subjectType" "QuotaSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" "ResourceLimitKind" NOT NULL,
    "limitValue" BIGINT NOT NULL,
    "note" TEXT,
    "grantedByHumanId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceQuotaOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceUsage" (
    "id" TEXT NOT NULL,
    "subjectType" "QuotaSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" "ResourceLimitKind" NOT NULL,
    "currentUsage" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpansionRequest" (
    "id" TEXT NOT NULL,
    "subjectType" "QuotaSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" "ResourceLimitKind" NOT NULL,
    "currentLimitValue" BIGINT NOT NULL,
    "requestedLimitValue" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ExpansionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByHumanId" TEXT NOT NULL,
    "reviewedByHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpansionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Embed" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "EmbedStatus" NOT NULL DEFAULT 'ACTIVE',
    "requireAuth" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Embed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "claimantId" TEXT NOT NULL,
    "respondentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "deadline" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "resolution" TEXT,
    "sellerEvidence" JSONB NOT NULL DEFAULT '{}',
    "sellerRespondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sellerHumanId" TEXT NOT NULL,
    "askPriceCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'internal',
    "externalRef" JSONB,
    "resalePayoutTermsId" TEXT,
    "buyerOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingHold" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerHumanId" TEXT NOT NULL,
    "heldUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "ticketTypeId" TEXT,
    "ownerHumanId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'VALID',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scannedAt" TIMESTAMP(3),
    "seatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketType" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "status" "TicketTypeStatus" NOT NULL DEFAULT 'ACTIVE',
    "seatSectionId" TEXT,
    "resaleAllowed" BOOLEAN NOT NULL DEFAULT false,
    "resaleCapCents" INTEGER,
    "transferAllowed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeNormalized" TEXT NOT NULL,
    "kind" "CouponKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "scope" "CouponScope" NOT NULL,
    "scopeId" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "maxRedemptionsPerHuman" INTEGER,
    "minOrderCents" INTEGER NOT NULL DEFAULT 0,
    "maxDiscountCents" INTEGER,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amountDiscountCents" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponHold" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amountDiscountCents" INTEGER NOT NULL,
    "status" "CouponHoldStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketScan" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "actorHumanId" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "outcome" "TicketScanOutcome" NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketTransfer" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromHumanId" TEXT NOT NULL,
    "toHumanId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "orderId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingTicketTransfer" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromHumanId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "PendingTicketTransferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedByHumanId" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PendingTicketTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerRoleTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultCapacity" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerRoleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventVolunteerRole" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "templateId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "capacity" INTEGER,
    "autoApprove" BOOLEAN,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventVolunteerRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventVolunteerShift" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "label" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventVolunteerShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerSignup" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "shiftId" TEXT,
    "humanId" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "status" "VolunteerSignupStatus" NOT NULL DEFAULT 'PENDING',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "reviewerHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "checkedInAt" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerSignup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaiverTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "humanId" TEXT,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaiverTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaiverAcceptance" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "waiverTemplateId" TEXT NOT NULL,
    "waiverVersion" INTEGER NOT NULL,
    "waiverBodyHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "WaiverAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_eventId_key" ON "Agreement"("eventId");

-- CreateIndex
CREATE INDEX "Agreement_proposerType_proposerId_status_idx" ON "Agreement"("proposerType", "proposerId", "status");

-- CreateIndex
CREATE INDEX "Agreement_counterpartyType_counterpartyId_status_idx" ON "Agreement"("counterpartyType", "counterpartyId", "status");

-- CreateIndex
CREATE INDEX "Agreement_placeId_status_idx" ON "Agreement"("placeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_agreementId_key" ON "BookingRequest"("agreementId");

-- CreateIndex
CREATE INDEX "BookingRequest_placeId_status_idx" ON "BookingRequest"("placeId", "status");

-- CreateIndex
CREATE INDEX "BookingRequest_artistHumanId_status_idx" ON "BookingRequest"("artistHumanId", "status");

-- CreateIndex
CREATE INDEX "PlaceWaiver_placeId_isActive_idx" ON "PlaceWaiver"("placeId", "isActive");

-- CreateIndex
CREATE INDEX "PlaceAvailability_placeId_isOpen_idx" ON "PlaceAvailability"("placeId", "isOpen");

-- CreateIndex
CREATE INDEX "PlaceAvailability_placeId_dayOfWeek_idx" ON "PlaceAvailability"("placeId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "PlaceAvailability_placeId_date_idx" ON "PlaceAvailability"("placeId", "date");

-- CreateIndex
CREATE INDEX "Announcement_orgId_createdAt_idx" ON "Announcement"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Announcement_eventId_idx" ON "Announcement"("eventId");

-- CreateIndex
CREATE INDEX "Announcement_sentBy_idx" ON "Announcement"("sentBy");

-- CreateIndex
CREATE UNIQUE INDEX "EventApplicationForm_eventId_key" ON "EventApplicationForm"("eventId");

-- CreateIndex
CREATE INDEX "EventApplicationForm_updatedByHumanId_idx" ON "EventApplicationForm"("updatedByHumanId");

-- CreateIndex
CREATE INDEX "EventApplicationQuestion_formId_order_idx" ON "EventApplicationQuestion"("formId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "EventApplicationSubmission_approvalToken_key" ON "EventApplicationSubmission"("approvalToken");

-- CreateIndex
CREATE INDEX "EventApplicationSubmission_eventId_status_idx" ON "EventApplicationSubmission"("eventId", "status");

-- CreateIndex
CREATE INDEX "EventApplicationSubmission_humanId_idx" ON "EventApplicationSubmission"("humanId");

-- CreateIndex
CREATE INDEX "EventApplicationSubmission_reviewerHumanId_idx" ON "EventApplicationSubmission"("reviewerHumanId");

-- CreateIndex
CREATE INDEX "EventWaitlistEntry_eventId_status_idx" ON "EventWaitlistEntry"("eventId", "status");

-- CreateIndex
CREATE INDEX "EventWaitlistEntry_humanId_idx" ON "EventWaitlistEntry"("humanId");

-- CreateIndex
CREATE INDEX "InviteList_ownerType_ownerId_idx" ON "InviteList"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "InviteListEntry_inviteListId_idx" ON "InviteListEntry"("inviteListId");

-- CreateIndex
CREATE INDEX "InviteListEntry_humanId_idx" ON "InviteListEntry"("humanId");

-- CreateIndex
CREATE INDEX "InviteListEntry_importId_idx" ON "InviteListEntry"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "InviteListEntry_inviteListId_contactEmail_key" ON "InviteListEntry"("inviteListId", "contactEmail");

-- CreateIndex
CREATE UNIQUE INDEX "InviteListEntry_inviteListId_contactPhone_key" ON "InviteListEntry"("inviteListId", "contactPhone");

-- CreateIndex
CREATE INDEX "ContactImport_ownerType_ownerId_idx" ON "ContactImport"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "ContactImport_inviteListId_idx" ON "ContactImport"("inviteListId");

-- CreateIndex
CREATE INDEX "ContactImport_createdByHumanId_idx" ON "ContactImport"("createdByHumanId");

-- CreateIndex
CREATE INDEX "EventInviteList_inviteListId_idx" ON "EventInviteList"("inviteListId");

-- CreateIndex
CREATE UNIQUE INDEX "EventInviteList_eventId_inviteListId_key" ON "EventInviteList"("eventId", "inviteListId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_human_id_key" ON "auth_user"("human_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_email_key" ON "auth_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_phone_number_key" ON "auth_user"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_username_key" ON "auth_user"("username");

-- CreateIndex
CREATE INDEX "auth_account_user_id_idx" ON "auth_account"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_account_provider_id_account_id_key" ON "auth_account"("provider_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session"("token");

-- CreateIndex
CREATE INDEX "auth_session_user_id_idx" ON "auth_session"("user_id");

-- CreateIndex
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "auth_two_factor_user_id_key" ON "auth_two_factor"("user_id");

-- CreateIndex
CREATE INDEX "auth_two_factor_secret_idx" ON "auth_two_factor"("secret");

-- CreateIndex
CREATE INDEX "api_keys_human_id_idx" ON "api_keys"("human_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "PushDevice_humanId_idx" ON "PushDevice"("humanId");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_provider_token_key" ON "PushDevice"("provider", "token");

-- CreateIndex
CREATE UNIQUE INDEX "EntityPage_slug_key" ON "EntityPage"("slug");

-- CreateIndex
CREATE INDEX "EntityPage_slug_idx" ON "EntityPage"("slug");

-- CreateIndex
CREATE INDEX "EntityPage_ownerType_ownerId_idx" ON "EntityPage"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityPage_ownerType_ownerId_key" ON "EntityPage"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "PageTheme_pageId_key" ON "PageTheme"("pageId");

-- CreateIndex
CREATE INDEX "PageBlock_pageId_orderIndex_idx" ON "PageBlock"("pageId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "PageSlugHistory_slug_key" ON "PageSlugHistory"("slug");

-- CreateIndex
CREATE INDEX "PageSlugHistory_pageId_recordedAt_idx" ON "PageSlugHistory"("pageId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE INDEX "Category_active_idx" ON "Category"("active");

-- CreateIndex
CREATE INDEX "Category_sortOrder_idx" ON "Category"("sortOrder");

-- CreateIndex
CREATE INDEX "EventType_categoryId_isActive_sortIndex_idx" ON "EventType"("categoryId", "isActive", "sortIndex");

-- CreateIndex
CREATE UNIQUE INDEX "EventType_categoryId_slug_key" ON "EventType"("categoryId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "EventType_categoryId_name_key" ON "EventType"("categoryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_slug_key" ON "Tag"("slug");

-- CreateIndex
CREATE INDEX "EventTag_tagId_idx" ON "EventTag"("tagId");

-- CreateIndex
CREATE INDEX "EventTag_eventId_sortOrder_idx" ON "EventTag"("eventId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EventTag_eventId_tagId_key" ON "EventTag"("eventId", "tagId");

-- CreateIndex
CREATE INDEX "EventHuman_humanId_idx" ON "EventHuman"("humanId");

-- CreateIndex
CREATE INDEX "EventHuman_eventId_sortOrder_idx" ON "EventHuman"("eventId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EventHuman_eventId_humanId_key" ON "EventHuman"("eventId", "humanId");

-- CreateIndex
CREATE INDEX "EventTemplate_ownerScope_ownerId_active_idx" ON "EventTemplate"("ownerScope", "ownerId", "active");

-- CreateIndex
CREATE INDEX "EventTemplate_ownerScope_ownerId_name_idx" ON "EventTemplate"("ownerScope", "ownerId", "name");

-- CreateIndex
CREATE INDEX "EventTemplate_createdByHumanId_idx" ON "EventTemplate"("createdByHumanId");

-- CreateIndex
CREATE INDEX "EventTemplate_updatedByHumanId_idx" ON "EventTemplate"("updatedByHumanId");

-- CreateIndex
CREATE INDEX "EventSeries_ownerScope_ownerId_active_idx" ON "EventSeries"("ownerScope", "ownerId", "active");

-- CreateIndex
CREATE INDEX "EventSeries_ownerScope_ownerId_name_idx" ON "EventSeries"("ownerScope", "ownerId", "name");

-- CreateIndex
CREATE INDEX "EventSeries_templateId_idx" ON "EventSeries"("templateId");

-- CreateIndex
CREATE INDEX "EventSeries_createdByHumanId_idx" ON "EventSeries"("createdByHumanId");

-- CreateIndex
CREATE INDEX "EventSeries_updatedByHumanId_idx" ON "EventSeries"("updatedByHumanId");

-- CreateIndex
CREATE UNIQUE INDEX "EventSeries_ownerScope_ownerId_nameNormalized_key" ON "EventSeries"("ownerScope", "ownerId", "nameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "EventSeriesOccurrence_eventId_key" ON "EventSeriesOccurrence"("eventId");

-- CreateIndex
CREATE INDEX "EventSeriesOccurrence_seriesId_startsAt_idx" ON "EventSeriesOccurrence"("seriesId", "startsAt");

-- CreateIndex
CREATE INDEX "EventSeriesOccurrence_status_idx" ON "EventSeriesOccurrence"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EventSeriesOccurrence_seriesId_ordinal_key" ON "EventSeriesOccurrence"("seriesId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Event_shortId_key" ON "Event"("shortId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_hero_image_id_key" ON "Event"("hero_image_id");

-- CreateIndex
CREATE INDEX "Event_placeId_idx" ON "Event"("placeId");

-- CreateIndex
CREATE INDEX "Event_geohash6_idx" ON "Event"("geohash6");

-- CreateIndex
CREATE INDEX "Event_geohash8_idx" ON "Event"("geohash8");

-- CreateIndex
CREATE INDEX "Event_categoryId_idx" ON "Event"("categoryId");

-- CreateIndex
CREATE INDEX "Event_typeId_idx" ON "Event"("typeId");

-- CreateIndex
CREATE INDEX "Event_orgId_listing_priority_idx" ON "Event"("orgId", "listing_priority");

-- CreateIndex
CREATE INDEX "Event_humanId_listing_priority_idx" ON "Event"("humanId", "listing_priority");

-- CreateIndex
CREATE INDEX "EventUnlock_humanId_idx" ON "EventUnlock"("humanId");

-- CreateIndex
CREATE INDEX "EventUnlock_eventId_revokedAt_idx" ON "EventUnlock"("eventId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventUnlock_eventId_humanId_key" ON "EventUnlock"("eventId", "humanId");

-- CreateIndex
CREATE UNIQUE INDEX "EventMagicLink_token_key" ON "EventMagicLink"("token");

-- CreateIndex
CREATE INDEX "EventMagicLink_eventId_idx" ON "EventMagicLink"("eventId");

-- CreateIndex
CREATE INDEX "EventMagicLink_expiresAt_idx" ON "EventMagicLink"("expiresAt");

-- CreateIndex
CREATE INDEX "event_images_ownerType_ownerId_idx" ON "event_images"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "event_images_eventId_idx" ON "event_images"("eventId");

-- CreateIndex
CREATE INDEX "event_images_eventId_attached_idx" ON "event_images"("eventId", "attached");

-- CreateIndex
CREATE INDEX "event_images_createdByHumanId_idx" ON "event_images"("createdByHumanId");

-- CreateIndex
CREATE UNIQUE INDEX "event_images_ownerId_key_key" ON "event_images"("ownerId", "key");

-- CreateIndex
CREATE INDEX "audio_uploads_eventId_idx" ON "audio_uploads"("eventId");

-- CreateIndex
CREATE INDEX "audio_uploads_eventId_status_idx" ON "audio_uploads"("eventId", "status");

-- CreateIndex
CREATE INDEX "audio_uploads_status_idx" ON "audio_uploads"("status");

-- CreateIndex
CREATE INDEX "audio_uploads_createdByHumanId_idx" ON "audio_uploads"("createdByHumanId");

-- CreateIndex
CREATE UNIQUE INDEX "audio_uploads_eventId_sourceKey_key" ON "audio_uploads"("eventId", "sourceKey");

-- CreateIndex
CREATE INDEX "featured_events_curated_by_human_id_idx" ON "featured_events"("curated_by_human_id");

-- CreateIndex
CREATE INDEX "featured_events_curated_until_idx" ON "featured_events"("curated_until");

-- CreateIndex
CREATE UNIQUE INDEX "featured_events_event_id_key" ON "featured_events"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "EventSlugHistory_slug_key" ON "EventSlugHistory"("slug");

-- CreateIndex
CREATE INDEX "EventSlugHistory_eventId_recordedAt_idx" ON "EventSlugHistory"("eventId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payee_stripeAccountId_key" ON "Payee"("stripeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Payee_subjectType_subjectId_key" ON "Payee"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "FeePolicy_scopeType_scopeId_status_effectiveFrom_idx" ON "FeePolicy"("scopeType", "scopeId", "status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "FeePolicy_scopeType_scopeId_status_version_key" ON "FeePolicy"("scopeType", "scopeId", "status", "version");

-- CreateIndex
CREATE INDEX "PayoutTerms_kind_isDefault_status_idx" ON "PayoutTerms"("kind", "isDefault", "status");

-- CreateIndex
CREATE INDEX "PayoutTermsLine_payoutTermsId_idx" ON "PayoutTermsLine"("payoutTermsId");

-- CreateIndex
CREATE INDEX "PayoutTermsLine_payeeId_idx" ON "PayoutTermsLine"("payeeId");

-- CreateIndex
CREATE INDEX "PayoutTermsLine_ticketTypeId_idx" ON "PayoutTermsLine"("ticketTypeId");

-- CreateIndex
CREATE INDEX "OrderSplit_payeeId_idx" ON "OrderSplit"("payeeId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSplit_orderId_payeeId_key" ON "OrderSplit"("orderId", "payeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_stripeTransferId_key" ON "Settlement"("stripeTransferId");

-- CreateIndex
CREATE INDEX "Settlement_scheduledPayoutDate_status_idx" ON "Settlement"("scheduledPayoutDate", "status");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_payeeId_scheduledPayoutDate_key" ON "Settlement"("payeeId", "scheduledPayoutDate");

-- CreateIndex
CREATE INDEX "SettlementLine_orderId_idx" ON "SettlementLine"("orderId");

-- CreateIndex
CREATE INDEX "SettlementLine_payeeId_idx" ON "SettlementLine"("payeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementLine_settlementId_orderSplitId_key" ON "SettlementLine"("settlementId", "orderSplitId");

-- CreateIndex
CREATE INDEX "OrderItemSettlementLine_settlementLineId_idx" ON "OrderItemSettlementLine"("settlementLineId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemSettlementLine_orderItemId_settlementLineId_key" ON "OrderItemSettlementLine"("orderItemId", "settlementLineId");

-- CreateIndex
CREATE INDEX "Payout_status_scheduledFor_idx" ON "Payout"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Payout_scheduledFor_idx" ON "Payout"("scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutItem_stripeTransferId_key" ON "PayoutItem"("stripeTransferId");

-- CreateIndex
CREATE INDEX "PayoutItem_payeeId_idx" ON "PayoutItem"("payeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutItem_payoutId_payeeId_currency_key" ON "PayoutItem"("payoutId", "payeeId", "currency");

-- CreateIndex
CREATE INDEX "PayoutItemSettlement_settlementId_idx" ON "PayoutItemSettlement"("settlementId");

-- CreateIndex
CREATE INDEX "FeedbackRequest_status_sendAfter_idx" ON "FeedbackRequest"("status", "sendAfter");

-- CreateIndex
CREATE INDEX "FeedbackRequest_humanId_status_idx" ON "FeedbackRequest"("humanId", "status");

-- CreateIndex
CREATE INDEX "FeedbackRequest_eventId_idx" ON "FeedbackRequest"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequest_orderId_humanId_key" ON "FeedbackRequest"("orderId", "humanId");

-- CreateIndex
CREATE INDEX "NotificationDigestSubscription_digestType_subscribed_idx" ON "NotificationDigestSubscription"("digestType", "subscribed");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDigestSubscription_humanId_digestType_key" ON "NotificationDigestSubscription"("humanId", "digestType");

-- CreateIndex
CREATE INDEX "NotificationDigestLog_humanId_digestType_sentAt_idx" ON "NotificationDigestLog"("humanId", "digestType", "sentAt");

-- CreateIndex
CREATE INDEX "NotificationDigestLog_orgId_digestType_sentAt_idx" ON "NotificationDigestLog"("orgId", "digestType", "sentAt");

-- CreateIndex
CREATE INDEX "NotificationDigestLog_eventId_digestType_sentAt_idx" ON "NotificationDigestLog"("eventId", "digestType", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDigestLog_digestType_channel_payloadHash_key" ON "NotificationDigestLog"("digestType", "channel", "payloadHash");

-- CreateIndex
CREATE INDEX "Notification_humanId_createdAt_idx" ON "Notification"("humanId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_humanId_readAt_idx" ON "Notification"("humanId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_expiresAt_idx" ON "Notification"("expiresAt");

-- CreateIndex
CREATE INDEX "NotificationPreference_humanId_scopeKind_idx" ON "NotificationPreference"("humanId", "scopeKind");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_humanId_scopeKind_orgId_eventId_key" ON "NotificationPreference"("humanId", "scopeKind", "orgId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shortId_key" ON "Order"("shortId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripePaymentIntentId_key" ON "Order"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Order_eventId_occurredAt_idx" ON "Order"("eventId", "occurredAt");

-- CreateIndex
CREATE INDEX "Order_buyerHumanId_idx" ON "Order"("buyerHumanId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_ticketTypeId_idx" ON "OrderItem"("ticketTypeId");

-- CreateIndex
CREATE INDEX "OrderItem_status_idx" ON "OrderItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_clerkOrgId_key" ON "Organization"("clerkOrgId");

-- CreateIndex
CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrgSlugHistory_slug_key" ON "OrgSlugHistory"("slug");

-- CreateIndex
CREATE INDEX "OrgSlugHistory_orgId_recordedAt_idx" ON "OrgSlugHistory"("orgId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMember_clerkMembershipId_key" ON "OrgMember"("clerkMembershipId");

-- CreateIndex
CREATE INDEX "OrgMember_humanId_idx" ON "OrgMember"("humanId");

-- CreateIndex
CREATE INDEX "OrgMember_orgId_idx" ON "OrgMember"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMember_orgId_humanId_key" ON "OrgMember"("orgId", "humanId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgInvitation_token_key" ON "OrgInvitation"("token");

-- CreateIndex
CREATE INDEX "OrgInvitation_token_idx" ON "OrgInvitation"("token");

-- CreateIndex
CREATE INDEX "OrgInvitation_orgId_status_idx" ON "OrgInvitation"("orgId", "status");

-- CreateIndex
CREATE INDEX "OrgInvitation_email_idx" ON "OrgInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OrgInvitation_orgId_email_key" ON "OrgInvitation"("orgId", "email");

-- CreateIndex
CREATE INDEX "HumanDelegate_delegateId_idx" ON "HumanDelegate"("delegateId");

-- CreateIndex
CREATE INDEX "HumanDelegate_principalId_idx" ON "HumanDelegate"("principalId");

-- CreateIndex
CREATE UNIQUE INDEX "HumanDelegate_principalId_delegateId_key" ON "HumanDelegate"("principalId", "delegateId");

-- CreateIndex
CREATE INDEX "PlaceReview_placeId_createdAt_idx" ON "PlaceReview"("placeId", "createdAt");

-- CreateIndex
CREATE INDEX "PlaceReview_humanId_idx" ON "PlaceReview"("humanId");

-- CreateIndex
CREATE INDEX "PlaceReview_eventId_idx" ON "PlaceReview"("eventId");

-- CreateIndex
CREATE INDEX "PlaceReview_source_idx" ON "PlaceReview"("source");

-- CreateIndex
CREATE UNIQUE INDEX "PlaceStats_placeId_key" ON "PlaceStats"("placeId");

-- CreateIndex
CREATE INDEX "PlaceStats_placeId_idx" ON "PlaceStats"("placeId");

-- CreateIndex
CREATE INDEX "PlaceStats_reviewCountPublic_idx" ON "PlaceStats"("reviewCountPublic");

-- CreateIndex
CREATE UNIQUE INDEX "Place_slug_key" ON "Place"("slug");

-- CreateIndex
CREATE INDEX "Place_slug_idx" ON "Place"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PlaceSlugHistory_slug_key" ON "PlaceSlugHistory"("slug");

-- CreateIndex
CREATE INDEX "PlaceSlugHistory_placeId_recordedAt_idx" ON "PlaceSlugHistory"("placeId", "recordedAt");

-- CreateIndex
CREATE INDEX "place_layouts_place_id_idx" ON "place_layouts"("place_id");

-- CreateIndex
CREATE INDEX "place_layouts_created_by_human_id_idx" ON "place_layouts"("created_by_human_id");

-- CreateIndex
CREATE UNIQUE INDEX "place_layouts_place_id_name_key" ON "place_layouts"("place_id", "name");

-- CreateIndex
CREATE INDEX "SavedLocation_geohash6_idx" ON "SavedLocation"("geohash6");

-- CreateIndex
CREATE INDEX "SavedLocation_geohash8_idx" ON "SavedLocation"("geohash8");

-- CreateIndex
CREATE INDEX "SavedLocation_ownerType_ownerId_idx" ON "SavedLocation"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedLocation_ownerType_ownerId_address_hash_key" ON "SavedLocation"("ownerType", "ownerId", "address_hash");

-- CreateIndex
CREATE INDEX "PlaceOwnership_placeId_idx" ON "PlaceOwnership"("placeId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaceOwnership_placeId_ownerType_ownerId_key" ON "PlaceOwnership"("placeId", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "PlaceVerificationRequest_placeId_idx" ON "PlaceVerificationRequest"("placeId");

-- CreateIndex
CREATE INDEX "PlaceVerificationRequest_status_idx" ON "PlaceVerificationRequest"("status");

-- CreateIndex
CREATE INDEX "PlaceVerificationDocument_requestId_idx" ON "PlaceVerificationDocument"("requestId");

-- CreateIndex
CREATE INDEX "SeatSection_eventId_idx" ON "SeatSection"("eventId");

-- CreateIndex
CREATE INDEX "SeatSection_place_layout_id_idx" ON "SeatSection"("place_layout_id");

-- CreateIndex
CREATE UNIQUE INDEX "SeatSection_eventId_name_key" ON "SeatSection"("eventId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SeatSection_eventId_place_layout_id_layout_section_id_key" ON "SeatSection"("eventId", "place_layout_id", "layout_section_id");

-- CreateIndex
CREATE INDEX "Seat_seatSectionId_idx" ON "Seat"("seatSectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_seatSectionId_label_key" ON "Seat"("seatSectionId", "label");

-- CreateIndex
CREATE INDEX "AuditLog_entity_at_idx" ON "AuditLog"("entity", "at");

-- CreateIndex
CREATE INDEX "Idempotency_status_expiresAt_idx" ON "Idempotency"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "EventDailyStats_date_idx" ON "EventDailyStats"("date");

-- CreateIndex
CREATE INDEX "EventDailyStats_eventId_date_idx" ON "EventDailyStats"("eventId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "EventDailyStats_eventId_date_key" ON "EventDailyStats"("eventId", "date");

-- CreateIndex
CREATE INDEX "ResalePriceSnapshot_eventId_date_idx" ON "ResalePriceSnapshot"("eventId", "date");

-- CreateIndex
CREATE INDEX "ResalePriceSnapshot_ticketTypeId_date_idx" ON "ResalePriceSnapshot"("ticketTypeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ResalePriceSnapshot_eventId_ticketTypeId_date_key" ON "ResalePriceSnapshot"("eventId", "ticketTypeId", "date");

-- CreateIndex
CREATE INDEX "ResourceQuotaOverride_subjectId_idx" ON "ResourceQuotaOverride"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceQuotaOverride_subjectType_subjectId_kind_key" ON "ResourceQuotaOverride"("subjectType", "subjectId", "kind");

-- CreateIndex
CREATE INDEX "ResourceUsage_subjectId_idx" ON "ResourceUsage"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceUsage_subjectType_subjectId_kind_key" ON "ResourceUsage"("subjectType", "subjectId", "kind");

-- CreateIndex
CREATE INDEX "ExpansionRequest_status_createdAt_idx" ON "ExpansionRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExpansionRequest_subjectType_subjectId_idx" ON "ExpansionRequest"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ExpansionRequest_requestedByHumanId_idx" ON "ExpansionRequest"("requestedByHumanId");

-- CreateIndex
CREATE INDEX "Embed_domain_idx" ON "Embed"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Embed_subjectType_subjectId_domain_key" ON "Embed"("subjectType", "subjectId", "domain");

-- CreateIndex
CREATE INDEX "Claim_orderId_idx" ON "Claim"("orderId");

-- CreateIndex
CREATE INDEX "Claim_eventId_status_idx" ON "Claim"("eventId", "status");

-- CreateIndex
CREATE INDEX "Claim_claimantId_idx" ON "Claim"("claimantId");

-- CreateIndex
CREATE INDEX "Claim_respondentId_idx" ON "Claim"("respondentId");

-- CreateIndex
CREATE INDEX "Claim_status_deadline_idx" ON "Claim"("status", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_orderItemId_key" ON "Claim"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_ticketId_key" ON "Listing"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_buyerOrderId_key" ON "Listing"("buyerOrderId");

-- CreateIndex
CREATE INDEX "Listing_sellerHumanId_idx" ON "Listing"("sellerHumanId");

-- CreateIndex
CREATE INDEX "Listing_eventId_status_idx" ON "Listing"("eventId", "status");

-- CreateIndex
CREATE INDEX "Listing_status_expiresAt_idx" ON "Listing"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ListingHold_listingId_key" ON "ListingHold"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_orderItemId_key" ON "Ticket"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_code_key" ON "Ticket"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_seatId_key" ON "Ticket"("seatId");

-- CreateIndex
CREATE INDEX "Ticket_eventId_idx" ON "Ticket"("eventId");

-- CreateIndex
CREATE INDEX "Ticket_ownerHumanId_idx" ON "Ticket"("ownerHumanId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_orderId_ticketTypeId_code_key" ON "Ticket"("orderId", "ticketTypeId", "code");

-- CreateIndex
CREATE INDEX "TicketType_eventId_idx" ON "TicketType"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketType_eventId_name_key" ON "TicketType"("eventId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_code_normalized_unique" ON "Coupon"("codeNormalized");

-- CreateIndex
CREATE INDEX "Coupon_status_startsAt_endsAt_idx" ON "Coupon"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Coupon_scope_scopeId_idx" ON "Coupon"("scope", "scopeId");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_humanId_idx" ON "CouponRedemption"("couponId", "humanId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_orderId_key" ON "CouponRedemption"("couponId", "orderId");

-- CreateIndex
CREATE INDEX "CouponHold_orderId_idx" ON "CouponHold"("orderId");

-- CreateIndex
CREATE INDEX "CouponHold_expiresAt_idx" ON "CouponHold"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CouponHold_couponId_idempotencyKey_key" ON "CouponHold"("couponId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TicketScan_ticketId_idx" ON "TicketScan"("ticketId");

-- CreateIndex
CREATE INDEX "TicketScan_eventId_scannedAt_idx" ON "TicketScan"("eventId", "scannedAt");

-- CreateIndex
CREATE INDEX "TicketTransfer_ticketId_idx" ON "TicketTransfer"("ticketId");

-- CreateIndex
CREATE INDEX "TicketTransfer_fromHumanId_idx" ON "TicketTransfer"("fromHumanId");

-- CreateIndex
CREATE INDEX "TicketTransfer_toHumanId_idx" ON "TicketTransfer"("toHumanId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingTicketTransfer_token_key" ON "PendingTicketTransfer"("token");

-- CreateIndex
CREATE INDEX "PendingTicketTransfer_recipientEmail_status_idx" ON "PendingTicketTransfer"("recipientEmail", "status");

-- CreateIndex
CREATE INDEX "PendingTicketTransfer_ticketId_status_idx" ON "PendingTicketTransfer"("ticketId", "status");

-- CreateIndex
CREATE INDEX "PendingTicketTransfer_token_idx" ON "PendingTicketTransfer"("token");

-- CreateIndex
CREATE INDEX "PendingTicketTransfer_fromHumanId_idx" ON "PendingTicketTransfer"("fromHumanId");

-- CreateIndex
CREATE INDEX "VolunteerRoleTemplate_orgId_archived_idx" ON "VolunteerRoleTemplate"("orgId", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerRoleTemplate_orgId_name_key" ON "VolunteerRoleTemplate"("orgId", "name");

-- CreateIndex
CREATE INDEX "EventVolunteerRole_eventId_sortOrder_idx" ON "EventVolunteerRole"("eventId", "sortOrder");

-- CreateIndex
CREATE INDEX "EventVolunteerRole_templateId_idx" ON "EventVolunteerRole"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "EventVolunteerRole_eventId_name_key" ON "EventVolunteerRole"("eventId", "name");

-- CreateIndex
CREATE INDEX "EventVolunteerShift_roleId_sortOrder_idx" ON "EventVolunteerShift"("roleId", "sortOrder");

-- CreateIndex
CREATE INDEX "VolunteerSignup_eventId_status_idx" ON "VolunteerSignup"("eventId", "status");

-- CreateIndex
CREATE INDEX "VolunteerSignup_roleId_idx" ON "VolunteerSignup"("roleId");

-- CreateIndex
CREATE INDEX "VolunteerSignup_shiftId_idx" ON "VolunteerSignup"("shiftId");

-- CreateIndex
CREATE INDEX "VolunteerSignup_humanId_idx" ON "VolunteerSignup"("humanId");

-- CreateIndex
CREATE INDEX "VolunteerSignup_reviewerHumanId_idx" ON "VolunteerSignup"("reviewerHumanId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerSignup_eventId_roleId_contactEmail_key" ON "VolunteerSignup"("eventId", "roleId", "contactEmail");

-- CreateIndex
CREATE INDEX "WaiverTemplate_orgId_idx" ON "WaiverTemplate"("orgId");

-- CreateIndex
CREATE INDEX "WaiverTemplate_humanId_idx" ON "WaiverTemplate"("humanId");

-- CreateIndex
CREATE INDEX "WaiverAcceptance_humanId_idx" ON "WaiverAcceptance"("humanId");

-- CreateIndex
CREATE INDEX "WaiverAcceptance_waiverTemplateId_idx" ON "WaiverAcceptance"("waiverTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "WaiverAcceptance_orderId_waiverTemplateId_key" ON "WaiverAcceptance"("orderId", "waiverTemplateId");

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_payoutTermsId_fkey" FOREIGN KEY ("payoutTermsId") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_artistHumanId_fkey" FOREIGN KEY ("artistHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "Agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceWaiver" ADD CONSTRAINT "PlaceWaiver_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceAvailability" ADD CONSTRAINT "PlaceAvailability_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_sentBy_fkey" FOREIGN KEY ("sentBy") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_updatedByHumanId_fkey" FOREIGN KEY ("updatedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventApplicationQuestion" ADD CONSTRAINT "EventApplicationQuestion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "EventApplicationForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_reviewerHumanId_fkey" FOREIGN KEY ("reviewerHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventWaitlistEntry" ADD CONSTRAINT "EventWaitlistEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventWaitlistEntry" ADD CONSTRAINT "EventWaitlistEntry_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteListEntry" ADD CONSTRAINT "InviteListEntry_inviteListId_fkey" FOREIGN KEY ("inviteListId") REFERENCES "InviteList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteListEntry" ADD CONSTRAINT "InviteListEntry_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteListEntry" ADD CONSTRAINT "InviteListEntry_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ContactImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactImport" ADD CONSTRAINT "ContactImport_inviteListId_fkey" FOREIGN KEY ("inviteListId") REFERENCES "InviteList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactImport" ADD CONSTRAINT "ContactImport_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventInviteList" ADD CONSTRAINT "EventInviteList_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventInviteList" ADD CONSTRAINT "EventInviteList_inviteListId_fkey" FOREIGN KEY ("inviteListId") REFERENCES "InviteList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Human" ADD CONSTRAINT "Human_default_primary_payout_terms_id_fkey" FOREIGN KEY ("default_primary_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Human" ADD CONSTRAINT "Human_default_resale_payout_terms_id_fkey" FOREIGN KEY ("default_resale_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_two_factor" ADD CONSTRAINT "auth_two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageTheme" ADD CONSTRAINT "PageTheme_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "EntityPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageBlock" ADD CONSTRAINT "PageBlock_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "EntityPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageSlugHistory" ADD CONSTRAINT "PageSlugHistory_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "EntityPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventType" ADD CONSTRAINT "EventType_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTag" ADD CONSTRAINT "EventTag_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTag" ADD CONSTRAINT "EventTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventHuman" ADD CONSTRAINT "EventHuman_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventHuman" ADD CONSTRAINT "EventHuman_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplate" ADD CONSTRAINT "EventTemplate_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTemplate" ADD CONSTRAINT "EventTemplate_updatedByHumanId_fkey" FOREIGN KEY ("updatedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeries" ADD CONSTRAINT "EventSeries_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EventTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeries" ADD CONSTRAINT "EventSeries_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeries" ADD CONSTRAINT "EventSeries_updatedByHumanId_fkey" FOREIGN KEY ("updatedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeriesOccurrence" ADD CONSTRAINT "EventSeriesOccurrence_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "EventSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeriesOccurrence" ADD CONSTRAINT "EventSeriesOccurrence_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_savedLocationId_fkey" FOREIGN KEY ("savedLocationId") REFERENCES "SavedLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "EventType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_payout_terms_id_fkey" FOREIGN KEY ("payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_resale_payout_terms_id_fkey" FOREIGN KEY ("resale_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_hero_image_id_fkey" FOREIGN KEY ("hero_image_id") REFERENCES "event_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_place_layout_id_fkey" FOREIGN KEY ("place_layout_id") REFERENCES "place_layouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_waiver_template_id_fkey" FOREIGN KEY ("waiver_template_id") REFERENCES "WaiverTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventUnlock" ADD CONSTRAINT "EventUnlock_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventUnlock" ADD CONSTRAINT "EventUnlock_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMagicLink" ADD CONSTRAINT "EventMagicLink_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMagicLink" ADD CONSTRAINT "EventMagicLink_targetHumanId_fkey" FOREIGN KEY ("targetHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMagicLink" ADD CONSTRAINT "EventMagicLink_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMagicLink" ADD CONSTRAINT "EventMagicLink_redeemedByHumanId_fkey" FOREIGN KEY ("redeemedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_images" ADD CONSTRAINT "event_images_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_images" ADD CONSTRAINT "event_images_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_uploads" ADD CONSTRAINT "audio_uploads_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_uploads" ADD CONSTRAINT "audio_uploads_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featured_events" ADD CONSTRAINT "featured_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featured_events" ADD CONSTRAINT "featured_events_curated_by_human_id_fkey" FOREIGN KEY ("curated_by_human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSlugHistory" ADD CONSTRAINT "EventSlugHistory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTerms" ADD CONSTRAINT "PayoutTerms_feePolicyId_fkey" FOREIGN KEY ("feePolicyId") REFERENCES "FeePolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTermsLine" ADD CONSTRAINT "PayoutTermsLine_payoutTermsId_fkey" FOREIGN KEY ("payoutTermsId") REFERENCES "PayoutTerms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTermsLine" ADD CONSTRAINT "PayoutTermsLine_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTermsLine" ADD CONSTRAINT "PayoutTermsLine_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSplit" ADD CONSTRAINT "OrderSplit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSplit" ADD CONSTRAINT "OrderSplit_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payoutTermsId_fkey" FOREIGN KEY ("payoutTermsId") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_orderSplitId_fkey" FOREIGN KEY ("orderSplitId") REFERENCES "OrderSplit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemSettlementLine" ADD CONSTRAINT "OrderItemSettlementLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemSettlementLine" ADD CONSTRAINT "OrderItemSettlementLine_settlementLineId_fkey" FOREIGN KEY ("settlementLineId") REFERENCES "SettlementLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItemSettlement" ADD CONSTRAINT "PayoutItemSettlement_payoutItemId_fkey" FOREIGN KEY ("payoutItemId") REFERENCES "PayoutItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItemSettlement" ADD CONSTRAINT "PayoutItemSettlement_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDigestSubscription" ADD CONSTRAINT "NotificationDigestSubscription_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDigestLog" ADD CONSTRAINT "NotificationDigestLog_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDigestLog" ADD CONSTRAINT "NotificationDigestLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDigestLog" ADD CONSTRAINT "NotificationDigestLog_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerHumanId_fkey" FOREIGN KEY ("buyerHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_default_primary_payout_terms_id_fkey" FOREIGN KEY ("default_primary_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_default_resale_payout_terms_id_fkey" FOREIGN KEY ("default_resale_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSlugHistory" ADD CONSTRAINT "OrgSlugHistory_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgInvitation" ADD CONSTRAINT "OrgInvitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgInvitation" ADD CONSTRAINT "OrgInvitation_invitedByHumanId_fkey" FOREIGN KEY ("invitedByHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgInvitation" ADD CONSTRAINT "OrgInvitation_acceptedByHumanId_fkey" FOREIGN KEY ("acceptedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanDelegate" ADD CONSTRAINT "HumanDelegate_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanDelegate" ADD CONSTRAINT "HumanDelegate_delegateId_fkey" FOREIGN KEY ("delegateId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_responseById_fkey" FOREIGN KEY ("responseById") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceStats" ADD CONSTRAINT "PlaceStats_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Place" ADD CONSTRAINT "Place_default_primary_payout_terms_id_fkey" FOREIGN KEY ("default_primary_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Place" ADD CONSTRAINT "Place_default_resale_payout_terms_id_fkey" FOREIGN KEY ("default_resale_payout_terms_id") REFERENCES "PayoutTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceSlugHistory" ADD CONSTRAINT "PlaceSlugHistory_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_layouts" ADD CONSTRAINT "place_layouts_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_layouts" ADD CONSTRAINT "place_layouts_created_by_human_id_fkey" FOREIGN KEY ("created_by_human_id") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedLocation" ADD CONSTRAINT "SavedLocation_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceOwnership" ADD CONSTRAINT "PlaceOwnership_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceOwnership" ADD CONSTRAINT "PlaceOwnership_reviewerHumanId_fkey" FOREIGN KEY ("reviewerHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_reviewerHumanId_fkey" FOREIGN KEY ("reviewerHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceVerificationDocument" ADD CONSTRAINT "PlaceVerificationDocument_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PlaceVerificationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatSection" ADD CONSTRAINT "SeatSection_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatSection" ADD CONSTRAINT "SeatSection_place_layout_id_fkey" FOREIGN KEY ("place_layout_id") REFERENCES "place_layouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_seatSectionId_fkey" FOREIGN KEY ("seatSectionId") REFERENCES "SeatSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDailyStats" ADD CONSTRAINT "EventDailyStats_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResalePriceSnapshot" ADD CONSTRAINT "ResalePriceSnapshot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResalePriceSnapshot" ADD CONSTRAINT "ResalePriceSnapshot_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Embed" ADD CONSTRAINT "Embed_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_claimantId_fkey" FOREIGN KEY ("claimantId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_respondentId_fkey" FOREIGN KEY ("respondentId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerHumanId_fkey" FOREIGN KEY ("sellerHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_buyerOrderId_fkey" FOREIGN KEY ("buyerOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingHold" ADD CONSTRAINT "ListingHold_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingHold" ADD CONSTRAINT "ListingHold_buyerHumanId_fkey" FOREIGN KEY ("buyerHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ownerHumanId_fkey" FOREIGN KEY ("ownerHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_seatSectionId_fkey" FOREIGN KEY ("seatSectionId") REFERENCES "SeatSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponHold" ADD CONSTRAINT "CouponHold_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponHold" ADD CONSTRAINT "CouponHold_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketScan" ADD CONSTRAINT "TicketScan_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketScan" ADD CONSTRAINT "TicketScan_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketScan" ADD CONSTRAINT "TicketScan_actorHumanId_fkey" FOREIGN KEY ("actorHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_fromHumanId_fkey" FOREIGN KEY ("fromHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_toHumanId_fkey" FOREIGN KEY ("toHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTicketTransfer" ADD CONSTRAINT "PendingTicketTransfer_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTicketTransfer" ADD CONSTRAINT "PendingTicketTransfer_fromHumanId_fkey" FOREIGN KEY ("fromHumanId") REFERENCES "Human"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTicketTransfer" ADD CONSTRAINT "PendingTicketTransfer_claimedByHumanId_fkey" FOREIGN KEY ("claimedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerRoleTemplate" ADD CONSTRAINT "VolunteerRoleTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventVolunteerRole" ADD CONSTRAINT "EventVolunteerRole_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventVolunteerRole" ADD CONSTRAINT "EventVolunteerRole_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "VolunteerRoleTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventVolunteerShift" ADD CONSTRAINT "EventVolunteerShift_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "EventVolunteerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "EventVolunteerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "EventVolunteerShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSignup" ADD CONSTRAINT "VolunteerSignup_reviewerHumanId_fkey" FOREIGN KEY ("reviewerHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverTemplate" ADD CONSTRAINT "WaiverTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverTemplate" ADD CONSTRAINT "WaiverTemplate_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverAcceptance" ADD CONSTRAINT "WaiverAcceptance_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverAcceptance" ADD CONSTRAINT "WaiverAcceptance_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverAcceptance" ADD CONSTRAINT "WaiverAcceptance_waiverTemplateId_fkey" FOREIGN KEY ("waiverTemplateId") REFERENCES "WaiverTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

