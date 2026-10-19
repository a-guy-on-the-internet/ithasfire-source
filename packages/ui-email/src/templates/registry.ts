import type { Translator, TranslationValues } from "@th/locale";
import type { ReactElement } from "react";

import { z } from "zod";

import { tokens } from "../theme/tokens";

import type { EventAnnouncementProps } from "./EventAnnouncement";
import { EventAnnouncement } from "./EventAnnouncement";
import type { EventDetailsProps } from "./EventDetails";
import { EventDetails } from "./EventDetails";
import type { OrderReceiptProps } from "./OrderReceipt";
import { OrderReceipt } from "./OrderReceipt";
import type { BankPaymentFailedProps } from "./BankPaymentFailed";
import {
  BankPaymentFailed,
  BANK_PAYMENT_FAILED_SUBJECT,
} from "./BankPaymentFailed";
import type { TicketIssuedProps } from "./TicketIssued";
import { TicketIssued } from "./TicketIssued";
import type { ApplicationApprovedProps } from "./ApplicationApproved";
import { ApplicationApproved } from "./ApplicationApproved";
import type { ApplicationBackInReviewProps } from "./ApplicationBackInReview";
import { ApplicationBackInReview } from "./ApplicationBackInReview";
import type { ApplicationReceivedProps } from "./ApplicationReceived";
import { ApplicationReceived } from "./ApplicationReceived";
import type { ApplicationRejectedProps } from "./ApplicationRejected";
import { ApplicationRejected } from "./ApplicationRejected";
import type { ApplicationSubmissionReceivedProps } from "./ApplicationSubmissionReceived";
import { ApplicationSubmissionReceived } from "./ApplicationSubmissionReceived";
import type { ApplicationWaitlistedProps } from "./ApplicationWaitlisted";
import { ApplicationWaitlisted } from "./ApplicationWaitlisted";
import type { EventInviteProps } from "./EventInvite";
import { EventInvite } from "./EventInvite";
import type { OrgInvitationProps } from "./OrgInvitation";
import { OrgInvitation } from "./OrgInvitation";
import type { ScannerOnboardingProps } from "./ScannerOnboarding";
import { ScannerOnboarding } from "./ScannerOnboarding";
import type { WaitlistJoinedProps } from "./WaitlistJoined";
import { WaitlistJoined } from "./WaitlistJoined";
import type { EventRescheduledProps } from "./EventRescheduled";
import { EventRescheduled } from "./EventRescheduled";
import type { EventLocationRevealedProps } from "./EventLocationRevealed";
import { EventLocationRevealed } from "./EventLocationRevealed";
import type { RsvpConfirmedProps } from "./RsvpConfirmed";
import { RsvpConfirmed } from "./RsvpConfirmed";
import type { RsvpDateCancelledProps } from "./RsvpDateCancelled";
import { RsvpDateCancelled } from "./RsvpDateCancelled";
import type { RsvpReminderProps } from "./RsvpReminder";
import { RsvpReminder } from "./RsvpReminder";
import type { ReviewRecoveryProps } from "./ReviewRecovery";
import { ReviewRecovery } from "./ReviewRecovery";
import type { VolunteerSignupReceivedProps } from "./VolunteerSignupReceived";
import { VolunteerSignupReceived } from "./VolunteerSignupReceived";
import type { VolunteerSignupApprovedProps } from "./VolunteerSignupApproved";
import { VolunteerSignupApproved } from "./VolunteerSignupApproved";
import type { VolunteerSignupRejectedProps } from "./VolunteerSignupRejected";
import { VolunteerSignupRejected } from "./VolunteerSignupRejected";
import type { VolunteerShiftReminderProps } from "./VolunteerShiftReminder";
import {
  VolunteerShiftReminder,
  volunteerShiftReminderSubject,
} from "./VolunteerShiftReminder";
import type { VolunteerStartReminderProps } from "./VolunteerStartReminder";
import {
  VolunteerStartReminder,
  volunteerStartReminderSubject,
} from "./VolunteerStartReminder";
import type { VolunteerGroupCoordinatorAssignedProps } from "./VolunteerGroupCoordinatorAssigned";
import {
  VolunteerGroupCoordinatorAssigned,
  volunteerGroupCoordinatorAssignedSubject,
} from "./VolunteerGroupCoordinatorAssigned";
import type { LineupAddedProps } from "./LineupAdded";
import { LineupAdded, lineupAddedSubject } from "./LineupAdded";
import type { LineupPayoutInviteProps } from "./LineupPayoutInvite";
import {
  LineupPayoutInvite,
  lineupPayoutInviteSubject,
} from "./LineupPayoutInvite";
import type { OpenCallNoticeProps } from "./OpenCallNotice";
import { OpenCallNotice, openCallNoticeSubject } from "./OpenCallNotice";
import type { ImageModerationHeldProps } from "./ImageModerationHeld";
import { ImageModerationHeld } from "./ImageModerationHeld";
import type { ImageModerationApprovedProps } from "./ImageModerationApproved";
import { ImageModerationApproved } from "./ImageModerationApproved";
import type { ImageModerationRejectedProps } from "./ImageModerationRejected";
import { ImageModerationRejected } from "./ImageModerationRejected";
import type { BookingRequestReceivedProps } from "./BookingRequestReceived";
import { BookingRequestReceived } from "./BookingRequestReceived";
import type { BookingInviteToClaimProps } from "./BookingInviteToClaim";
import { BookingInviteToClaim } from "./BookingInviteToClaim";
import type { BookingThreadMessageProps } from "./BookingThreadMessage";
import { BookingThreadMessage } from "./BookingThreadMessage";
import type { OrganizerBookingRequestReceivedProps } from "./OrganizerBookingRequestReceived";
import { OrganizerBookingRequestReceived } from "./OrganizerBookingRequestReceived";
import type { OrganizerBookingRequestRespondedProps } from "./OrganizerBookingRequestResponded";
import type { BookingRequestRespondedProps } from "./BookingRequestResponded";
import type { BookingCancelledProps } from "./BookingCancelled";
import { BookingCancelled, bookingCancelledSubject } from "./BookingCancelled";
// ── P3b (asks) ──
import type { BookingAskReceivedProps } from "./BookingAskReceived";
import {
  BookingAskReceived,
  bookingAskReceivedSubject,
} from "./BookingAskReceived";
import {
  BookingRequestResponded,
  bookingRequestRespondedSubject,
} from "./BookingRequestResponded";
import type { BookingHoldPlacedProps } from "./BookingHoldPlaced";
import { BookingHoldPlaced } from "./BookingHoldPlaced";
import type { BookingLineupInvitedProps } from "./BookingLineupInvited";
import { BookingLineupInvited } from "./BookingLineupInvited";
import type { BookingLineupRequestClosedProps } from "./BookingLineupRequestClosed";
import {
  BookingLineupRequestClosed,
  bookingLineupRequestClosedSubject,
} from "./BookingLineupRequestClosed";
import type { BookingLineupRemovedProps } from "./BookingLineupRemoved";
import {
  BookingLineupRemoved,
  bookingLineupRemovedSubject,
} from "./BookingLineupRemoved";
import type { BookingHoldChallengedProps } from "./BookingHoldChallenged";
import { BookingHoldChallenged } from "./BookingHoldChallenged";
import type { BookingHoldReleasedProps } from "./BookingHoldReleased";
import { BookingHoldReleased } from "./BookingHoldReleased";
import type { BookingHoldConfirmedProps } from "./BookingHoldConfirmed";
import { BookingHoldConfirmed } from "./BookingHoldConfirmed";
import type { BookingHoldStaffAttentionProps } from "./BookingHoldStaffAttention";
import { BookingHoldStaffAttention } from "./BookingHoldStaffAttention";
import { OrganizerBookingRequestResponded } from "./OrganizerBookingRequestResponded";
import type { MembershipRenewalNoticeProps } from "./MembershipRenewalNotice";
import { MembershipRenewalNotice } from "./MembershipRenewalNotice";
import type { PayoutSentProps } from "./PayoutSent";
import { PayoutSent, payoutSentTitle } from "./PayoutSent";
import verificationCodeTemplate from "../text-templates/verification-code.eta";
import twoFactorOtpTemplate from "../text-templates/two-factor-otp.eta";
import resetPasswordLinkTemplate from "../text-templates/reset-password-link.eta";
import { createQrDataUrl } from "../lib/qr";
import type { ProseMirrorDoc } from "../lib/prose-to-html";
import {
  VERIFICATION_CODE_PURPOSES,
  type VerificationCodePurpose,
} from "@th/types/verification-code-purpose";

/**
 * better-auth emailOTP `type`: what the code is for. Absent = sign-in. The
 * list lives in `@th/types` so apps/api can check better-auth's union against
 * it at compile time.
 */
export { VERIFICATION_CODE_PURPOSES, type VerificationCodePurpose };

export type VerificationCodeProps = {
  code: string;
  expiresMinutes: number;
  productName: string;
  purpose?: VerificationCodePurpose;
};

const VERIFICATION_PURPOSE_PHRASE: Record<VerificationCodePurpose, string> = {
  "sign-in": "sign in",
  "email-verification": "verify your email",
  "forget-password": "reset your password",
  "change-email": "confirm your new email address",
};

/**
 * The second-factor one-time code (`twoFactor` plugin's `otpOptions.sendOTP`).
 * Registered 2026-09-07: `sendTwoFactorOtp` had been sending this key since
 * the feature shipped, and it was never here — so even once the use case's
 * `phoneNumber: null` rejection was fixed, the mailer had nothing to render.
 * No `expiresMinutes`: the use case is not told the TTL, and a number this
 * template cannot verify is worse than none.
 */
export type TwoFactorOtpProps = {
  otpCode: string;
  productName: string;
};

export type ResetPasswordLinkProps = {
  productName: string;
  resetUrl: string;
  expiresMinutes: number;
};

export const TEMPLATE_IDS = [
  "ticket.issued",
  "order.receipt",
  "order.bank_payment_failed",
  "event.announcement",
  "event.details",
  "event.application_approved",
  "event.application_back_in_review",
  "event.application_received",
  "event.application_rejected",
  "event.application_submission_received",
  "event.application_waitlisted",
  "event.invite",
  "event.waitlist_joined",
  "event.rescheduled",
  "event.location_revealed",
  "rsvp.confirmed",
  "rsvp.date_cancelled",
  "rsvp.reminder",
  "org.invitation",
  "scanner.onboarding",
  "auth.verification_code",
  "auth.2fa_otp",
  "auth.reset_password_link",
  "review.recovery",
  "volunteer.signup_received",
  "volunteer.signup_approved",
  "volunteer.signup_rejected",
  "volunteer.shift_reminder",
  "volunteer.start_reminder",
  "volunteer.group_coordinator_assigned",
  "event.lineup_added",
  "event.lineup_payout_invite",
  "open_call.notice",
  "image.moderation.held",
  "image.moderation.approved",
  "image.moderation.rejected",
  "booking.request_received",
  "booking.invite_to_claim",
  "booking.thread_message",
  "booking.organizer_request_received",
  "booking.organizer_request_responded",
  "booking.request_responded",
  "booking.booking_cancelled",
  // ── P3b (asks) ──
  "booking.ask_received",
  "booking.hold_placed",
  "booking.hold_challenged",
  "booking.hold_released",
  "booking.hold_confirmed",
  "booking.hold_staff_attention",
  "booking.lineup_invited",
  "booking.lineup_request_closed",
  "booking.lineup_removed",
  "membership.renewal_notice",
  "settlement.payout_sent",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type TemplatePropsMap = {
  "ticket.issued": TicketIssuedProps;
  "order.receipt": OrderReceiptProps;
  "order.bank_payment_failed": BankPaymentFailedProps;
  "event.announcement": EventAnnouncementProps;
  "event.details": EventDetailsProps;
  "event.application_approved": ApplicationApprovedProps;
  "event.application_back_in_review": ApplicationBackInReviewProps;
  "event.application_received": ApplicationReceivedProps;
  "event.application_rejected": ApplicationRejectedProps;
  "event.application_submission_received": ApplicationSubmissionReceivedProps;
  "event.application_waitlisted": ApplicationWaitlistedProps;
  "event.invite": EventInviteProps;
  "event.waitlist_joined": WaitlistJoinedProps;
  "event.rescheduled": EventRescheduledProps;
  "event.location_revealed": EventLocationRevealedProps;
  "rsvp.confirmed": RsvpConfirmedProps;
  "rsvp.date_cancelled": RsvpDateCancelledProps;
  "rsvp.reminder": RsvpReminderProps;
  "org.invitation": OrgInvitationProps;
  "scanner.onboarding": ScannerOnboardingProps;
  "auth.verification_code": VerificationCodeProps;
  "auth.2fa_otp": TwoFactorOtpProps;
  "volunteer.signup_received": VolunteerSignupReceivedProps;
  "volunteer.signup_approved": VolunteerSignupApprovedProps;
  "volunteer.signup_rejected": VolunteerSignupRejectedProps;
  "volunteer.shift_reminder": VolunteerShiftReminderProps;
  "volunteer.start_reminder": VolunteerStartReminderProps;
  "volunteer.group_coordinator_assigned": VolunteerGroupCoordinatorAssignedProps;
  "event.lineup_added": LineupAddedProps;
  "event.lineup_payout_invite": LineupPayoutInviteProps;
  "open_call.notice": OpenCallNoticeProps;
  "auth.reset_password_link": ResetPasswordLinkProps;
  "review.recovery": ReviewRecoveryProps;
  "image.moderation.held": ImageModerationHeldProps;
  "image.moderation.approved": ImageModerationApprovedProps;
  "image.moderation.rejected": ImageModerationRejectedProps;
  "booking.request_received": BookingRequestReceivedProps;
  "booking.invite_to_claim": BookingInviteToClaimProps;
  "booking.thread_message": BookingThreadMessageProps;
  "booking.organizer_request_received": OrganizerBookingRequestReceivedProps;
  "booking.organizer_request_responded": OrganizerBookingRequestRespondedProps;
  "booking.request_responded": BookingRequestRespondedProps;
  "booking.booking_cancelled": BookingCancelledProps;
  // ── P3b (asks) ──
  "booking.ask_received": BookingAskReceivedProps;
  "booking.hold_placed": BookingHoldPlacedProps;
  "booking.hold_challenged": BookingHoldChallengedProps;
  "booking.hold_released": BookingHoldReleasedProps;
  "booking.hold_confirmed": BookingHoldConfirmedProps;
  "booking.hold_staff_attention": BookingHoldStaffAttentionProps;
  "booking.lineup_invited": BookingLineupInvitedProps;
  "booking.lineup_request_closed": BookingLineupRequestClosedProps;
  "booking.lineup_removed": BookingLineupRemovedProps;
  "membership.renewal_notice": MembershipRenewalNoticeProps;
  "settlement.payout_sent": PayoutSentProps;
};

export type TemplateComponentContext = {
  translator: Translator;
  locale: string;
};

export type TemplateDefinition<T extends TemplateId> = {
  id: T;
  subjectTemplate?: string;
  getSubject?: (
    props: TemplatePropsMap[T],
    context: TemplateComponentContext,
  ) => string;
  requiredProps: string[];
  component?: (
    props: TemplatePropsMap[T],
    context: TemplateComponentContext,
  ) => ReactElement;
  textTemplate?: string;
  htmlFallback?: (props: TemplatePropsMap[T]) => string | Promise<string>;
  sample: TemplatePropsMap[T];
};

const translateSubject = (
  context: TemplateComponentContext,
  key: string,
  values: TranslationValues,
) => {
  return context.translator.t(key, values);
};

const createTicketSample = (
  tickets: ReadonlyArray<{ code: string; seatLabel?: string }>,
): TicketIssuedProps["tickets"] => {
  return tickets.map(({ code, seatLabel }) => ({
    code,
    qrUrl: createQrDataUrl(code),
    ...(seatLabel ? { seatLabel } : {}),
  }));
};

/** An href in an email: http(s) only (z.url alone admits `javascript:`). */
const httpUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "http(s) URL required");

export const templateSchemas: {
  [K in TemplateId]: z.ZodType<TemplatePropsMap[K]>;
} = {
  "ticket.issued": z.object({
    eventTitle: z.string(),
    eventDateISO: z.string(),
    venueName: z.string(),
    tickets: z.array(
      z.object({
        code: z.string(),
        qrUrl: z.string().url(),
        seatLabel: z.string().optional(),
      }),
    ),
    orderId: z.string(),
    manageUrl: z.string().url(),
    supportUrl: z.string().url(),
    venueAddress: z.string().optional(),
    mapImageUrl: z.string().url().optional(),
    directionsUrl: z.string().url().optional(),
    addressRevealAtISO: z.string().optional(),
    timezone: z.string().optional(),
    accountCompletionUrl: z.string().url().optional(),
    gettingThereUrl: z.string().url().optional(),
  }),
  "order.receipt": z.object({
    orderId: z.string(),
    buyerName: z.string().optional(),
    lineItems: z.array(
      z.object({
        label: z.string(),
        amountCents: z.number().int(),
      }),
    ),
    totalCents: z.number().int(),
    eventTitle: z.string().optional(),
    viewOrderUrl: z.string().url().optional(),
    paymentMethod: z.string().optional(),
    complimentary: z.boolean().optional(),
    currency: z.string().length(3).optional(),
  }),
  "order.bank_payment_failed": z.object({
    eventTitle: z.string().min(1),
    orderCode: z.string().min(1),
    // Nullable: a slugless event has no public page, and the notice must
    // still send without the button.
    eventUrl: z.string().url().nullable().optional(),
  }),
  "event.announcement": z.object({
    eventTitle: z.string(),
    dateISO: z.string(),
    timezone: z.string().nullable().optional(),
    ctaUrl: z.string().url(),
    teaser: z.string().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.details": z.object({
    eventTitle: z.string(),
    startsAtISO: z.string(),
    endsAtISO: z.string().optional(),
    timezone: z.string().optional(),
    descriptionDoc: z
      .object({
        type: z.literal("doc"),
        content: z.array(z.any()),
      })
      .nullable()
      .optional(),
    venueName: z.string().optional(),
    addressText: z.string().optional(),
    heroImageUrl: z.string().url().optional(),
    eventUrl: z.string().url(),
    organizerName: z.string().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.application_approved": z.object({
    eventTitle: z.string(),
    approvalUrl: z.string().url().nullable().optional(),
    eventUrl: z.string().url().nullable().optional(),
    expiresAtISO: z.string().nullable().optional(),
    startsAtISO: z.string().nullable().optional(),
    endsAtISO: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    calendarUrl: z.string().url().nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.application_back_in_review": z.object({
    eventTitle: z.string(),
    eventUrl: z.string().url().nullable().optional(),
    isGuest: z.boolean().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.application_received": z.object({
    eventTitle: z.string(),
    eventUrl: z.string().url().nullable().optional(),
    appliedAtISO: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    isGuest: z.boolean().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.application_rejected": z.object({
    eventTitle: z.string(),
    decisionReason: z.string().nullable().optional(),
    organizerEventsUrl: z.string().url().nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.application_submission_received": z.object({
    eventTitle: z.string(),
    applicantName: z.string(),
    queueUrl: z.string().url(),
  }),
  "event.application_waitlisted": z.object({
    eventTitle: z.string(),
    eventUrl: z.string().url().nullable().optional(),
    isGuest: z.boolean().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  // Core sends these names verbatim (`Iso` casing) and sends null for absent
  // values, so every optional field must also accept null.
  "event.invite": z.object({
    eventTitle: z.string().min(1),
    inviteUrl: z.string().url(),
    eventWhen: z.string().nullable().optional(),
    inviteeName: z.string().nullable().optional(),
    organizerName: z.string().nullable().optional(),
    startsAtIso: z.string().nullable().optional(),
    endsAtIso: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    // Rendered as an href: http(s) only (z.url alone admits `javascript:`).
    stopInvitesUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "http(s) URL required")
      .nullable()
      .optional(),
  }),
  "event.waitlist_joined": z.object({
    eventTitle: z.string(),
    eventDateISO: z.string(),
    timezone: z.string().nullable().optional(),
    // Nullable: a slugless event has no resolvable page; the confirmation
    // still sends, just without the button.
    eventUrl: z.string().url().nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    organizerMessageDoc: z
      .object({
        type: z.literal("doc"),
        content: z.array(z.any()),
      })
      .nullable()
      .optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.rescheduled": z.object({
    sourceEventTitle: z.string(),
    sourceEventDateISO: z.string(),
    targetEventTitle: z.string(),
    targetEventDateISO: z.string(),
    sourceEventTimezone: z.string().nullable().optional(),
    targetEventTimezone: z.string().nullable().optional(),
    manageUrl: z.string().url(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "event.location_revealed": z.object({
    eventTitle: z.string(),
    startsAtISO: z.string(),
    timezone: z.string().nullable().optional(),
    venueName: z.string().nullable().optional(),
    address: z.string(),
    mapUrl: z.string().url().nullable().optional(),
    mapImageUrl: z.string().url().nullable().optional(),
    directionsUrl: z.string().url().nullable().optional(),
    // Nullable: a slugless event has no resolvable page, and the reveal (the
    // address) must still send.
    eventUrl: z.string().url().nullable().optional(),
  }),
  "rsvp.confirmed": z.object({
    eventTitle: z.string(),
    startsAtISO: z.string(),
    endsAtISO: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    venueName: z.string().nullable().optional(),
    addressText: z.string().nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    eventUrl: z.string().url().nullable().optional(),
    manageRsvpsUrl: z.string().url().nullable().optional(),
  }),
  "rsvp.date_cancelled": z.object({
    eventTitle: z.string(),
    // The occurrence that is off. No endsAtISO: the message is about a night
    // not happening, so its would-have-been end time is noise.
    startsAtISO: z.string(),
    timezone: z.string().nullable().optional(),
    venueName: z.string().nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    // Nullable for the same reason as rsvp.confirmed: a slugless event has no
    // resolvable page, and the cancellation must still send.
    eventUrl: z.string().url().nullable().optional(),
    // The whole listing is off (cancelled, archived or completed), not one night.
    listingCancelled: z.boolean().nullable().optional(),
  }),
  "rsvp.reminder": z.object({
    eventTitle: z.string(),
    // Resolved in the listing's timezone by the renderer; null on a catch-up
    // send where neither "today" nor "tomorrow" is true.
    dayLabel: z.string().nullable().optional(),
    startsAtISO: z.string(),
    endsAtISO: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    venueName: z.string().nullable().optional(),
    addressText: z.string().nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    eventUrl: z.string().url().nullable().optional(),
    manageRsvpsUrl: z.string().url().nullable().optional(),
  }),
  "org.invitation": z.object({
    orgName: z.string(),
    role: z.string(),
    inviterName: z.string().nullable(),
    acceptUrl: z.string().url(),
    expiresInDays: z.number().int().min(1),
    accentColor: z.string().nullable().optional(),
    logoUrl: z.string().url().nullable().optional(),
    scannerIosUrl: z.string().url().nullable().optional(),
    scannerAndroidUrl: z.string().url().nullable().optional(),
  }),
  "scanner.onboarding": z.object({
    orgName: z.string(),
    recipientEmail: z.string().email(),
    iosAppUrl: z.string().url().nullable().optional(),
    androidAppUrl: z.string().url().nullable().optional(),
  }),
  "auth.verification_code": z.object({
    code: z.string(),
    expiresMinutes: z.number().int(),
    productName: z.string(),
    purpose: z.enum(VERIFICATION_CODE_PURPOSES).optional(),
  }),
  "auth.2fa_otp": z.object({
    otpCode: z.string().regex(/^[0-9]{6}$/),
    productName: z.string(),
  }),
  "auth.reset_password_link": z.object({
    productName: z.string(),
    resetUrl: z.string().url(),
    expiresMinutes: z.number().int(),
  }),
  "review.recovery": z.object({
    venueName: z.string(),
    lastStepLabel: z.string(),
    resumeUrl: z.string().url(),
    unsubscribeUrl: z.string().url(),
  }),
  "volunteer.signup_received": z.object({
    eventTitle: z.string(),
    roleName: z.string(),
    shiftLabel: z.string().nullable().optional(),
    shiftStartsAtISO: z.string().nullable().optional(),
    shiftEndsAtISO: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    status: z.enum(["PENDING", "APPROVED"]),
    accountCompletionUrl: z.string().url().nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "volunteer.signup_approved": z.object({
    eventTitle: z.string(),
    roleName: z.string(),
    shiftLabel: z.string().nullable().optional(),
    shiftStartsAtISO: z.string().nullable().optional(),
    shiftEndsAtISO: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    reviewerName: z.string().nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
    destinationUrl: z.string().url().nullable().optional(),
    destinationLabel: z.string().nullable().optional(),
  }),
  "volunteer.signup_rejected": z.object({
    eventTitle: z.string(),
    roleName: z.string(),
    reviewerName: z.string().nullable().optional(),
    rejectionNote: z.string().nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  }),
  "volunteer.shift_reminder": z.object({
    eventTitle: z.string(),
    roleName: z.string(),
    shiftLabel: z.string().nullable().optional(),
    shiftStartsAtISO: z.string(),
    shiftEndsAtISO: z.string(),
    timezone: z.string().nullable().optional(),
    kindLabel: z.string(),
    addressText: z.string().nullable().optional(),
    manageUrl: z.string().url().nullable().optional(),
    roles: z
      .array(
        z.object({
          roleName: z.string(),
          shiftLabel: z.string().nullable().optional(),
          shiftEndsAtISO: z.string().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
  }),
  "volunteer.start_reminder": z.object({
    anchor: z.enum(["event", "ask"]),
    title: z.string(),
    roleName: z.string().nullable(),
    startsAtISO: z.string(),
    endsAtISO: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    kindLabel: z.string(),
    addressText: z.string().nullable().optional(),
    manageUrl: z.string().url().nullable().optional(),
    roleNames: z.array(z.string()).nullable().optional(),
  }),
  "volunteer.group_coordinator_assigned": z.object({
    assignerName: z.string().nullable().optional(),
    groupName: z.string().min(1),
    askTitle: z.string().min(1),
    coordinateUrl: z.string().url(),
    accountCompletionUrl: z.string().url().nullable().optional(),
  }),
  "event.lineup_added": z.object({
    addedByName: z.string().min(1),
    eventTitle: z.string().min(1),
    whenLabel: z.string(),
    roleLabel: z.string().min(1),
    lineupsUrl: z.string().url(),
    publiclyListed: z.boolean(),
    eventEnded: z.boolean(),
    organiserWillBeTold: z.boolean(),
  }),
  // Open-call notices: every string is written by core (comms/
  // open-call-renderers.ts). Rendered as hrefs: http(s) only (z.url alone
  // admits `javascript:`).
  "open_call.notice": z.object({
    locale: z.string().min(2).max(16),
    subject: z.string().min(1),
    heading: z.string().min(1),
    rows: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })),
    paragraphs: z.array(z.string().min(1)),
    quote: z.object({ label: z.string().min(1), text: z.string().min(1) }).nullable(),
    action: z
      .object({ label: z.string().min(1), url: httpUrlSchema })
      .nullable(),
    links: z.array(z.object({ label: z.string().min(1), url: httpUrlSchema })),
    footer: z.string().min(1),
  }),
  "event.lineup_payout_invite": z.object({
    inviterName: z.string().min(1),
    eventTitle: z.string().min(1),
    whenLabel: z.string(),
    payoutsUrl: z.string().url(),
    accountCompletionUrl: z.string().url().nullable().optional(),
    lineupsUrl: z.string().url(),
    paidEvent: z.boolean(),
    organiserWillBeTold: z.boolean(),
  }),
  "image.moderation.held": z.object({
    eventTitle: z.string().nullable().optional(),
    eventUrl: z.string().url().nullable().optional(),
    helpUrl: z.string().url().nullable().optional(),
  }),
  "image.moderation.approved": z.object({
    eventTitle: z.string().nullable().optional(),
    eventUrl: z.string().url().nullable().optional(),
    helpUrl: z.string().url().nullable().optional(),
  }),
  "image.moderation.rejected": z.object({
    note: z.string().nullable().optional(),
    eventTitle: z.string().nullable().optional(),
    eventUrl: z.string().url().nullable().optional(),
    helpUrl: z.string().url().nullable().optional(),
  }),
  "booking.request_received": z.object({
    placeName: z.string(),
    actName: z.string(),
    contactName: z.string().nullable().optional(),
    contactEmail: z.string().email().nullable().optional(),
    message: z.string(),
    preferredDates: z.array(z.string()).optional(),
    source: z.enum(["PLATFORM", "EMBED"]),
    inboxUrl: z.string().url(),
  }),
  "booking.invite_to_claim": z.object({
    placeName: z.string(),
    actName: z.string().nullable().optional(),
    claimUrl: z.string().url(),
    expiresAtISO: z.string(),
  }),
  "booking.thread_message": z.object({
    placeName: z.string(),
    messageBody: z.string(),
    replyToEmail: z.string().nullable().optional(),
  }),
  "booking.organizer_request_received": z.object({
    orgName: z.string(),
    message: z.string(),
    preferredDates: z.array(z.string()).optional(),
    attachedEventTitle: z.string().optional(),
    requestsUrl: z.string().url(),
  }),
  "booking.organizer_request_responded": z.object({
    actName: z.string(),
    action: z.enum(["accepted", "declined"]),
    targetUrl: z.string().url(),
  }),
  "booking.request_responded": z.object({
    responderName: z.string(),
    action: z.enum(["accepted", "declined", "closed"]),
    reason: z.string().optional(),
    acceptedNext: z.enum(["terms_coming", "agreement_ready"]).optional(),
    targetUrl: z.string().url(),
  }),
  "booking.booking_cancelled": z.object({
    cancelledByName: z.string(),
    dateLabel: z.string(),
    reason: z.string(),
    eventCancelled: z.boolean(),
    targetUrl: z.string().url(),
  }),
  // ── P3b (asks) ──
  "booking.ask_received": z.object({
    venueName: z.string(),
    label: z.string(),
    note: z.string().optional(),
    answerPhrase: z.string(),
    targetUrl: z.string().url(),
  }),
  // Three shapes behind one template id: a single hold (`placed`), a move-up
  // to first (`moved`), and the batch DIGEST (`placed_batch`) that folds a run
  // of dates into one email. Discriminated so `dates` is required exactly
  // where it is used and `dateLabel`/`position` exactly where they are.
  "booking.hold_placed": z.discriminatedUnion("kind", [
    z.object({
      kind: z.enum(["placed", "moved"]),
      placeName: z.string(),
      dateLabel: z.string(),
      position: z.number().int().min(1),
      targetUrl: z.string().url(),
    }),
    z.object({
      kind: z.literal("placed_batch"),
      placeName: z.string(),
      dates: z
        .array(
          z.object({
            dateLabel: z.string(),
            position: z.number().int().min(1),
          }),
        )
        .min(2),
      targetUrl: z.string().url(),
    }),
  ]),
  "booking.hold_challenged": z.object({
    placeName: z.string(),
    dateLabel: z.string(),
    respondByLabel: z.string(),
    position: z.union([z.literal(1), z.literal(2)]),
    extended: z.boolean(),
    targetUrl: z.string().url(),
    // ── booking-the-night P2d-2 ── what Keep will do (FR-014).
    keepWill: z.enum(["book_now", "ask_for_terms"]).optional(),
  }),
  "booking.hold_released": z.object({
    reason: z.enum([
      "released",
      "request_closed",
      "sibling_confirmed",
      "lost_date",
      "expired",
      "event_scheduled",
    ]),
    placeName: z.string(),
    dateLabel: z.string(),
    targetUrl: z.string().url(),
  }),
  "booking.hold_confirmed": z.object({
    placeName: z.string(),
    dateLabel: z.string(),
    targetUrl: z.string().url(),
  }),
  "booking.hold_staff_attention": z.object({
    kind: z.enum(["answered_kept", "answered_released", "expired"]),
    actName: z.string(),
    placeName: z.string(),
    dateLabel: z.string(),
    targetUrl: z.string().url(),
    // ── booking-the-night P2d-2 ── kept with no terms sent (FR-014).
    respondByLabel: z.string().optional(),
  }),
  "booking.lineup_invited": z.object({
    senderName: z.string().min(1),
    venueName: z.string().min(1),
    asGroupName: z.string().min(1).optional(),
    dateLabels: z.array(z.string()),
    targetUrl: z.string().url(),
  }),
  "booking.lineup_request_closed": z.object({
    senderName: z.string().min(1),
    venueName: z.string().min(1),
    asGroupName: z.string().min(1).optional(),
    dateLabels: z.array(z.string()),
    targetUrl: z.string().url(),
  }),
  "booking.lineup_removed": z.object({
    senderName: z.string().min(1),
    venueName: z.string().min(1),
    asGroupName: z.string().min(1).optional(),
    dateLabels: z.array(z.string()),
  }),
  "membership.renewal_notice": z.object({
    tierName: z.string(),
    ownerName: z.string(),
    amountFormatted: z.string(),
    renewalDateISO: z.string(),
    timezone: z.string().optional(),
    cancelUrl: z.string().url(),
  }),
  "settlement.payout_sent": z.object({
    kind: z.enum(["payout", "reserved", "applied_to_balance"]),
    amountCents: z.number().int(),
    currency: z.string(),
    orgName: z.string().nullable(),
    payoutDateIso: z.string(),
    displayTimezone: z.string(),
    lines: z.array(
      z.object({
        eventTitle: z.string().nullable(),
        eventStartsAtIso: z.string().nullable(),
        eventTimezone: z.string().nullable(),
        ticketCount: z.number().int().nullable(),
        amountCents: z.number().int(),
        orderId: z.string().nullable(),
      }),
    ),
    recoveredDebtCents: z.number().int(),
    connectAccountFeeCents: z.number().int(),
    reserveHeldCents: z.number().int(),
    reserveReleasedCents: z.number().int(),
    otherSalesCount: z.number().int(),
    otherSalesCents: z.number().int(),
    adjustmentsCents: z.number().int(),
    balanceAfterCents: z.number().int().nullable(),
    nextPayableAtIso: z.string().nullable(),
    bankDelayDays: z.number().int().nullable(),
    payoutsUrl: z.string().url().nullable(),
    stripeDashboardUrl: z.string().url(),
    settlementCount: z.number().int(),
  }),
} satisfies { [K in TemplateId]: z.ZodType<TemplatePropsMap[K]> };

/**
 * The "not you?" line. A sign-up mails its "verify your email" code the
 * moment anyone registers an address, so for that purpose the line tells the
 * inbox owner not to hand the code on: typed in where the other person is
 * signed in, it would verify THEIR account under this address (B2).
 */
const verificationIgnoreLine = (props: VerificationCodeProps): string => {
  const purpose = props.purpose ?? "sign-in";
  if (purpose === "sign-in") {
    return `If you didn't try to sign in or sign up for ${props.productName}, you can safely ignore this email — no account will be created at this address.`;
  }
  if (purpose === "email-verification") {
    return `If you didn't sign up for ${props.productName}, ignore this email and don't share this code.`;
  }
  return "If you didn't request this code, you can safely ignore this email.";
};

const verificationHtml = (props: VerificationCodeProps) => {
  const FONT_STACK = tokens.typography.fontFamily;
  // Inline font-family on every text-bearing element. Outlook (Word
  // renderer) ignores body-level inheritance so without this every <h1>/
  // <p>/<a> falls back to Times New Roman.
  const FONT_INLINE = `font-family:${FONT_STACK};`;
  return `<!doctype html>
<html lang="en">
<head>
	<meta charSet="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<meta name="color-scheme" content="light only" />
	<meta name="supported-color-schemes" content="light" />
	<title>Your verification code — ${props.productName}</title>
	<style>
		body { ${FONT_INLINE} background: ${tokens.colors.surfaceMuted}; color: ${tokens.colors.text}; margin: 0; padding: 0; }
		main { max-width: 480px; margin: 48px auto; background: ${tokens.colors.surface}; border: 1px solid ${tokens.colors.border}; border-radius: ${tokens.radius}px; padding: 32px; }
		h1 { ${FONT_INLINE} font-size: 24px; margin: 0 0 12px 0; color: ${tokens.colors.text}; line-height: ${tokens.typography.headingTightLH}; }
		p { ${FONT_INLINE} font-size: 16px; line-height: ${tokens.typography.lineHeight}; margin: 0 0 12px 0; color: ${tokens.colors.text}; }
		.code { ${FONT_INLINE} display: inline-block; font-size: 28px; font-weight: 700; letter-spacing: 0.2em; background: ${tokens.colors.brand}; color: #ffffff; padding: 14px 20px; border-radius: ${tokens.radius}px; }
		.expiry { ${FONT_INLINE} font-size: 14px; color: ${tokens.colors.mutedText}; margin: 0 0 12px 0; }
		.small { ${FONT_INLINE} font-size: 13px; color: ${tokens.colors.mutedText}; }
		.preheader { display: none !important; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; max-height: 0; max-width: 0; overflow: hidden; mso-hide: all; }
	</style>
</head>
<body lang="en">
	<div class="preheader">Your ${props.productName} verification code is ${props.code} — expires in ${props.expiresMinutes} minutes.</div>
	<main>
		<h1>Your verification code</h1>
		<p>Enter this code in ${props.productName} to ${VERIFICATION_PURPOSE_PHRASE[props.purpose ?? "sign-in"]}.</p>
		<p><span class="code">${props.code}</span></p>
		<p class="expiry">This code expires in ${props.expiresMinutes} minutes.</p>
		<p class="small">${verificationIgnoreLine(props)}</p>
		<p style="${FONT_INLINE}font-size:16px;line-height:${tokens.typography.lineHeight};margin:24px 0 0 0;">Thanks,<br />The ${props.productName} team</p>
	</main>
</body>
</html>`;
};

const twoFactorOtpHtml = (props: TwoFactorOtpProps) => {
  const FONT_STACK = tokens.typography.fontFamily;
  const FONT_INLINE = `font-family:${FONT_STACK};`;
  return `<!doctype html>
<html lang="en">
<head>
	<meta charSet="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<meta name="color-scheme" content="light only" />
	<meta name="supported-color-schemes" content="light" />
	<title>Your sign-in code — ${props.productName}</title>
	<style>
		body { ${FONT_INLINE} background: ${tokens.colors.surfaceMuted}; color: ${tokens.colors.text}; margin: 0; padding: 0; }
		main { max-width: 480px; margin: 48px auto; background: ${tokens.colors.surface}; border: 1px solid ${tokens.colors.border}; border-radius: ${tokens.radius}px; padding: 32px; }
		h1 { ${FONT_INLINE} font-size: 24px; margin: 0 0 12px 0; color: ${tokens.colors.text}; line-height: ${tokens.typography.headingTightLH}; }
		p { ${FONT_INLINE} font-size: 16px; line-height: ${tokens.typography.lineHeight}; margin: 0 0 12px 0; color: ${tokens.colors.text}; }
		.code { ${FONT_INLINE} display: inline-block; font-size: 28px; font-weight: 700; letter-spacing: 0.2em; background: ${tokens.colors.brand}; color: #ffffff; padding: 14px 20px; border-radius: ${tokens.radius}px; }
		.small { ${FONT_INLINE} font-size: 13px; color: ${tokens.colors.mutedText}; }
		.preheader { display: none !important; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; max-height: 0; max-width: 0; overflow: hidden; mso-hide: all; }
	</style>
</head>
<body lang="en">
	<div class="preheader">Your ${props.productName} sign-in code is ${props.otpCode}.</div>
	<main>
		<h1>Your sign-in code</h1>
		<p>Enter this code in ${props.productName} to finish signing in.</p>
		<p><span class="code">${props.otpCode}</span></p>
		<p class="small">If you didn't try to sign in, ignore this email and consider changing your password.</p>
		<p style="${FONT_INLINE}font-size:16px;line-height:${tokens.typography.lineHeight};margin:24px 0 0 0;">Thanks,<br />The ${props.productName} team</p>
	</main>
</body>
</html>`;
};

const resetPasswordLinkHtml = (props: ResetPasswordLinkProps) => {
  return `<!doctype html>
<html lang="en">
<head>
	<meta charSet="utf-8" />
	<title>Reset your password</title>
	<style>
		body { font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; background: ${tokens.colors.surfaceMuted}; color: ${tokens.colors.text}; }
		main { max-width: 520px; margin: 48px auto; background: ${tokens.colors.surface}; border: 1px solid ${tokens.colors.border}; border-radius: 0; padding: 32px; }
		h1 { font-size: 22px; margin-bottom: 12px; }
		p { font-size: 16px; line-height: 1.5; }
		.button { display: inline-block; padding: 16px 28px; background: ${tokens.colors.brandAccent}; color: #ffffff !important; text-decoration: none; border-radius: ${tokens.radius}px; font-weight: 700; }
		.button span { color: #ffffff !important; }
		.small { font-size: 13px; color: ${tokens.colors.mutedText}; word-break: break-all; }
	</style>
</head>
<body>
	<main>
		<h1>Reset your password</h1>
		<p>You requested a password reset. Click the button below to choose a new password.</p>
		<p><a class="button" href="${props.resetUrl}"><span style="color:#ffffff;">Reset password</span></a></p>
		<p class="small">Or paste this link into your browser: ${props.resetUrl}</p>
		<p>This link expires in ${props.expiresMinutes} minutes.</p>
		<p>If you didn\u2019t request this, you can safely ignore this email \u2014 your password won\u2019t change.</p>
		<p>Thanks,<br />The ${props.productName} team</p>
	</main>
</body>
</html>`;
};

// Sample ProseMirror doc for event.details template
const sampleDescriptionDoc: ProseMirrorDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Join us for an unforgettable evening at the rooftop space overlooking the city skyline.",
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "What to Expect" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Live DJ sets from " },
                {
                  type: "text",
                  text: "local artists",
                  marks: [{ type: "bold" }],
                },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Signature cocktails and food trucks" },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Golden hour photo opportunities" },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Doors open at 6pm. " },
        { type: "text", text: "21+ only", marks: [{ type: "italic" }] },
        { type: "text", text: ". Valid ID required." },
      ],
    },
  ],
};

export const templateDefinitions: { [K in TemplateId]: TemplateDefinition<K> } =
  {
    "ticket.issued": {
      id: "ticket.issued",
      subjectTemplate: "Your tickets are ready: {{eventTitle}}",
      getSubject: (props, context) =>
        translateSubject(context, "emails.ticketIssued.subject", {
          eventTitle: props.eventTitle,
        }),
      requiredProps: [
        "eventTitle",
        "eventDateISO",
        "venueName",
        "tickets",
        "orderId",
        "manageUrl",
        "supportUrl",
      ],
      component: TicketIssued,
      sample: {
        eventTitle: "Indie Fest 2025",
        eventDateISO: "2025-08-16T19:00:00.000Z",
        venueName: "Harbor Pavilion",
        tickets: createTicketSample([
          { code: "TH-001-A", seatLabel: "Front Row · A12" },
          { code: "TH-001-B" },
        ]),
        orderId: "ORD-47281",
        manageUrl: "https://ithasfire.com/orders/ORD-47281",
        supportUrl: "https://ithasfire.com/help",
        venueAddress: "713 Congress Ave, Austin, TX 78701",
        mapImageUrl:
          "https://tiles-dev.ithasfire.com/styles/streets/static/-97.7426,30.2687,14/600x200.png",
        directionsUrl:
          "https://www.google.com/maps/dir/?api=1&destination=30.2687,-97.7426",
      },
    },
    "order.receipt": {
      id: "order.receipt",
      subjectTemplate: "Receipt for Order {{orderId}}",
      requiredProps: ["orderId", "lineItems", "totalCents"],
      component: OrderReceipt,
      sample: {
        orderId: "ORD-83920",
        buyerName: "Jordan Alvarez",
        lineItems: [
          { label: "General Admission x2", amountCents: 24000 },
          { label: "Service Fee", amountCents: 1200 },
        ],
        totalCents: 25200,
        eventTitle: "Summer Sounds 2025",
        viewOrderUrl: "https://ithasfire.com/orders/ORD-83920",
      },
    },
    "order.bank_payment_failed": {
      id: "order.bank_payment_failed",
      subjectTemplate: BANK_PAYMENT_FAILED_SUBJECT,
      requiredProps: ["eventTitle", "orderCode"],
      component: BankPaymentFailed,
      sample: {
        eventTitle: "Summer Sounds 2025",
        orderCode: "DB21B2C3",
        eventUrl: "https://ithasfire.com/events/summer-sounds-2025",
      },
    },
    "event.announcement": {
      id: "event.announcement",
      subjectTemplate: "{{eventTitle}} - New date announced",
      requiredProps: ["eventTitle", "dateISO", "ctaUrl"],
      component: EventAnnouncement,
      sample: {
        eventTitle: "Night Market Sessions",
        dateISO: "2025-11-02T17:30:00.000Z",
        ctaUrl: "https://ithasfire.com/events/night-market",
        teaser:
          "We've secured a bigger place and can't wait to share the details.",
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "event.details": {
      id: "event.details",
      subjectTemplate: "{{eventTitle}} - Event Details",
      requiredProps: ["eventTitle", "startsAtISO", "eventUrl"],
      component: EventDetails,
      sample: {
        eventTitle: "Sunset Session Vol. 03",
        startsAtISO: "2025-09-20T18:00:00.000Z",
        endsAtISO: "2025-09-20T23:00:00.000Z",
        timezone: "America/Los_Angeles",
        descriptionDoc: sampleDescriptionDoc,
        venueName: "Skyline Rooftop",
        addressText: "123 Harbor Blvd, San Francisco, CA 94111",
        heroImageUrl:
          "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&h=300&fit=crop",
        eventUrl:
          "https://ithasfire.com/e/sunset-session-vol-03",
        organizerName: "Sunset Collective",
        organizerContactEmail: "events@sunsetcollective.co",
      },
    },
    "event.application_approved": {
      id: "event.application_approved",
      subjectTemplate: "You're in: {{eventTitle}}",
      requiredProps: ["eventTitle"],
      component: ApplicationApproved,
      sample: {
        eventTitle: "Night Market Sessions",
        approvalUrl:
          "https://ithasfire.com/api/events/3f6c2a9e-8b1d-4c57-9a0e-5d7b2e4f8c13/claim?token=9b2e7c41d8a54f06b3e19c7a2d5f8e60",
        eventUrl: "https://ithasfire.com/e/night-market",
        expiresAtISO: "2026-10-07T02:30:00.000Z",
        startsAtISO: "2026-11-07T03:00:00.000Z",
        endsAtISO: "2026-11-07T06:00:00.000Z",
        timezone: "America/Los_Angeles",
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "event.application_back_in_review": {
      id: "event.application_back_in_review",
      subjectTemplate: "Back in review: {{eventTitle}}",
      requiredProps: ["eventTitle"],
      component: ApplicationBackInReview,
      sample: {
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/e/night-market",
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "event.application_received": {
      id: "event.application_received",
      subjectTemplate: "Application sent: {{eventTitle}}",
      requiredProps: ["eventTitle"],
      component: ApplicationReceived,
      sample: {
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/e/night-market",
        appliedAtISO: "2026-09-29T18:12:00.000Z",
        timezone: "America/Los_Angeles",
        isGuest: true,
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "event.application_rejected": {
      id: "event.application_rejected",
      subjectTemplate: "Not approved: {{eventTitle}}",
      requiredProps: ["eventTitle"],
      component: ApplicationRejected,
      sample: {
        eventTitle: "Night Market Sessions",
        decisionReason:
          "We had far more applications than spots this round. The spring market is open to everyone.",
        organizerEventsUrl: "https://ithasfire.com/orgs/night-market-collective",
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "event.application_submission_received": {
      id: "event.application_submission_received",
      subjectTemplate: "New application for {{eventTitle}}",
      requiredProps: ["eventTitle", "applicantName", "queueUrl"],
      component: ApplicationSubmissionReceived,
      sample: {
        eventTitle: "Night Market Sessions",
        applicantName: "Jordan Alvarez",
        queueUrl:
          "https://ithasfire.com/admin/night-market/events/evt_123/applications",
      },
    },
    "event.application_waitlisted": {
      id: "event.application_waitlisted",
      subjectTemplate: "Waitlisted: {{eventTitle}}",
      requiredProps: ["eventTitle"],
      component: ApplicationWaitlisted,
      sample: {
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/e/night-market",
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "event.invite": {
      id: "event.invite",
      subjectTemplate: "You’re invited: {{eventTitle}}",
      requiredProps: ["eventTitle", "inviteUrl"],
      component: EventInvite,
      sample: {
        eventTitle: "Founders & Friends Dinner",
        inviteUrl:
          "https://ithasfire.com/e/founders-friends-dinner?invite=sample-not-a-real-token",
        eventWhen: "Sat, Oct 18, 2026, 7:00 PM PDT",
        inviteeName: "Maya",
        organizerName: "Night Owl Collective",
        startsAtIso: "2026-10-19T02:00:00.000Z",
        endsAtIso: "2026-10-19T06:00:00.000Z",
        timezone: "America/Los_Angeles",
        stopInvitesUrl:
          "https://ithasfire.com/invites/stop?token=sample-not-a-real-token",
      },
    },
    "event.waitlist_joined": {
      id: "event.waitlist_joined",
      subjectTemplate: "You're on the waitlist for {{eventTitle}}",
      requiredProps: ["eventTitle", "eventDateISO"],
      component: WaitlistJoined,
      sample: {
        eventTitle: "Night Market Sessions",
        // 7:00 PM CDT on Oct 12: 00:00Z the next day, so a preview run with
        // TZ=UTC shows whether the date follows the event's zone.
        eventDateISO: "2026-10-13T00:00:00.000Z",
        timezone: "America/Chicago",
        eventUrl: "https://ithasfire.com/events/org/us/night-market--ab12cd",
        heroImageUrl:
          "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&h=300&fit=crop",
        organizerMessageDoc: {
          type: "doc" as const,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Thanks for your interest! We'll send you a heads-up as soon as tickets drop. In the meantime, follow us on socials for sneak peeks.",
                },
              ],
            },
          ],
        },
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "event.rescheduled": {
      id: "event.rescheduled",
      subjectTemplate: "Your event has been rescheduled: {{sourceEventTitle}}",
      requiredProps: [
        "sourceEventTitle",
        "sourceEventDateISO",
        "targetEventTitle",
        "targetEventDateISO",
        "manageUrl",
      ],
      component: EventRescheduled,
      sample: {
        sourceEventTitle: "Weekly Jam Session #4",
        sourceEventDateISO: "2026-05-15T19:00:00.000Z",
        targetEventTitle: "Weekly Jam Session #5",
        targetEventDateISO: "2026-05-22T19:00:00.000Z",
        manageUrl: "https://ithasfire.com/orders/ORD-12345",
        organizerContactEmail: "events@jamsessions.co",
      },
    },
    "event.location_revealed": {
      id: "event.location_revealed",
      subjectTemplate: "The location for {{eventTitle}} is now live",
      requiredProps: ["eventTitle", "startsAtISO", "address"],
      component: EventLocationRevealed,
      sample: {
        eventTitle: "Secret Loft Session",
        startsAtISO: "2026-08-14T20:00:00.000Z",
        timezone: "America/Chicago",
        venueName: "The Attic",
        address: "1114 Fatherland St, Nashville, TN 37206",
        mapUrl:
          "https://www.google.com/maps/search/?api=1&query=36.1773,-86.7554",
        mapImageUrl:
          "https://tiles-dev.ithasfire.com/styles/streets/static/-86.7554,36.1773,14/600x200.png",
        directionsUrl:
          "https://www.google.com/maps/dir/?api=1&destination=36.1773,-86.7554",
        eventUrl: "https://ithasfire.com/events/secret-loft-session",
      },
    },
    "rsvp.confirmed": {
      id: "rsvp.confirmed",
      subjectTemplate: "You're going to {{eventTitle}}",
      requiredProps: ["eventTitle", "startsAtISO"],
      component: RsvpConfirmed,
      sample: {
        eventTitle: "Weekly Open Mic",
        startsAtISO: "2026-08-01T20:00:00.000Z",
        endsAtISO: "2026-08-01T23:00:00.000Z",
        timezone: "America/Chicago",
        venueName: "The Corner Stage",
        addressText: "123 Main St, Nashville, TN 37203",
        heroImageUrl:
          "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&h=300&fit=crop",
        eventUrl: "https://ithasfire.com/events/weekly-open-mic",
        manageRsvpsUrl: "https://ithasfire.com/my-rsvps",
      },
    },
    "rsvp.date_cancelled": {
      id: "rsvp.date_cancelled",
      subjectTemplate: "Cancelled: {{eventTitle}}",
      requiredProps: ["eventTitle", "startsAtISO"],
      component: RsvpDateCancelled,
      sample: {
        eventTitle: "Weekly Open Mic",
        startsAtISO: "2026-08-01T20:00:00.000Z",
        timezone: "America/Chicago",
        venueName: "The Corner Stage",
        heroImageUrl:
          "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&h=300&fit=crop",
        eventUrl: "https://ithasfire.com/events/weekly-open-mic",
      },
    },
    "rsvp.reminder": {
      id: "rsvp.reminder",
      subjectTemplate: "Reminder: {{eventTitle}}",
      requiredProps: ["eventTitle", "startsAtISO"],
      component: RsvpReminder,
      sample: {
        eventTitle: "Weekly Open Mic",
        dayLabel: "Tomorrow",
        startsAtISO: "2026-08-01T20:00:00.000Z",
        endsAtISO: "2026-08-01T23:00:00.000Z",
        timezone: "America/Chicago",
        venueName: "The Corner Stage",
        addressText: "123 Main St, Nashville, TN 37203",
        heroImageUrl:
          "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&h=300&fit=crop",
        eventUrl: "https://ithasfire.com/events/weekly-open-mic",
        manageRsvpsUrl: "https://ithasfire.com/my-rsvps",
      },
    },
    "org.invitation": {
      id: "org.invitation",
      subjectTemplate: "You're invited to join {{orgName}}",
      requiredProps: [
        "orgName",
        "role",
        "inviterName",
        "acceptUrl",
        "expiresInDays",
      ],
      component: OrgInvitation,
      sample: {
        orgName: "Sunset Collective",
        role: "member",
        inviterName: "Alex Rivera",
        acceptUrl:
          "https://ithasfire.com/invite/accept?token=abc123def456",
        expiresInDays: 7,
        accentColor: null,
        logoUrl: null,
      },
    },
    "scanner.onboarding": {
      id: "scanner.onboarding",
      subjectTemplate: "Get the Ithas Fire Scanner for {{orgName}}",
      requiredProps: ["orgName", "recipientEmail"],
      component: ScannerOnboarding,
      sample: {
        orgName: "Sunset Collective",
        recipientEmail: "operator@example.com",
        iosAppUrl: "https://testflight.apple.com/join/abcd1234",
        androidAppUrl: "https://play.google.com/apps/internaltest/scanner",
      },
    },
    "auth.verification_code": {
      id: "auth.verification_code",
      subjectTemplate: "Your verification code",
      requiredProps: ["code", "expiresMinutes", "productName"],
      htmlFallback: verificationHtml,
      textTemplate: verificationCodeTemplate,
      sample: {
        code: "482931",
        expiresMinutes: 10,
        productName: "Ithas Fire",
      },
    },
    "auth.2fa_otp": {
      id: "auth.2fa_otp",
      subjectTemplate: "Your sign-in code",
      requiredProps: ["otpCode", "productName"],
      htmlFallback: twoFactorOtpHtml,
      textTemplate: twoFactorOtpTemplate,
      sample: {
        otpCode: "739204",
        productName: "Ithas Fire",
      },
    },
    "auth.reset_password_link": {
      id: "auth.reset_password_link",
      subjectTemplate: "Reset your password",
      requiredProps: ["productName", "resetUrl", "expiresMinutes"],
      htmlFallback: resetPasswordLinkHtml,
      textTemplate: resetPasswordLinkTemplate,
      sample: {
        productName: "Ithas Fire",
        resetUrl:
          "https://web-dev.ithasfire.com/reset-password?token=example",
        expiresMinutes: 60,
      },
    },
    "review.recovery": {
      id: "review.recovery",
      subjectTemplate:
        "You left your review halfway — here's where you stopped",
      requiredProps: [
        "venueName",
        "lastStepLabel",
        "resumeUrl",
        "unsubscribeUrl",
      ],
      component: ReviewRecovery,
      sample: {
        venueName: "The Basement East",
        lastStepLabel: "Parking & Load-In",
        resumeUrl:
          "https://ithasfire.com/review?session=abc&step=parking",
        unsubscribeUrl:
          "https://ithasfire.com/unsubscribe/review-recovery?token=example",
      },
    },
    "volunteer.signup_received": {
      id: "volunteer.signup_received",
      subjectTemplate: "Thanks for signing up to volunteer at {{eventTitle}}",
      requiredProps: ["eventTitle", "roleName", "status"],
      component: VolunteerSignupReceived,
      sample: {
        eventTitle: "Night Market Sessions",
        roleName: "Door greeter",
        shiftLabel: "Evening",
        shiftStartsAtISO: "2026-05-02T22:00:00.000Z",
        shiftEndsAtISO: "2026-05-03T02:00:00.000Z",
        status: "PENDING",
        accountCompletionUrl:
          "https://ithasfire.com/auth/complete?email=volunteer%40example.com&src=volunteer&event=evt_123",
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "volunteer.signup_approved": {
      id: "volunteer.signup_approved",
      subjectTemplate: "You're approved to volunteer at {{eventTitle}}",
      requiredProps: ["eventTitle", "roleName"],
      component: VolunteerSignupApproved,
      sample: {
        eventTitle: "Night Market Sessions",
        roleName: "Door greeter",
        shiftLabel: "Evening",
        shiftStartsAtISO: "2026-05-02T22:00:00.000Z",
        shiftEndsAtISO: "2026-05-03T02:00:00.000Z",
        reviewerName: "Alex Rivera",
        organizerContactEmail: "hello@nightmarket.events",
        destinationUrl:
          "https://ithasfire.com/events/00000000-0000-4000-8000-000000000003",
        // Event-path sample → the renderer sends "View event" here.
        destinationLabel: "View event",
      },
    },
    "volunteer.signup_rejected": {
      id: "volunteer.signup_rejected",
      subjectTemplate:
        "Update on your volunteer application for {{eventTitle}}",
      requiredProps: ["eventTitle", "roleName"],
      component: VolunteerSignupRejected,
      sample: {
        eventTitle: "Night Market Sessions",
        roleName: "Door greeter",
        reviewerName: "Alex Rivera",
        rejectionNote:
          "We had more applicants than spots this year — thanks for wanting to help out!",
        organizerContactEmail: "hello@nightmarket.events",
      },
    },
    "volunteer.shift_reminder": {
      id: "volunteer.shift_reminder",
      // `kindLabel` is sentence-case ("Tomorrow", "In about an hour") for the
      // eyebrow and lead line; mid-sentence it is lowercased, as the
      // component's <title> does. A {{kindLabel}} template cannot do that.
      getSubject: (props) => volunteerShiftReminderSubject(props),
      requiredProps: [
        "eventTitle",
        "roleName",
        "shiftStartsAtISO",
        "shiftEndsAtISO",
        "kindLabel",
      ],
      component: VolunteerShiftReminder,
      sample: {
        eventTitle: "Night Market Sessions",
        roleName: "Door greeter",
        shiftLabel: "Evening",
        shiftStartsAtISO: "2026-05-02T22:00:00.000Z",
        shiftEndsAtISO: "2026-05-03T02:00:00.000Z",
        kindLabel: "Tomorrow",
        addressText: "404 Elm St, Austin, TX",
        manageUrl: "https://ithasfire.com/events/night-market",
      },
    },
    // Start-anchored sibling (volunteer-ask-reminders FR-004): a shiftless
    // event role or a one-time ask. Never says "your shift".
    "volunteer.start_reminder": {
      id: "volunteer.start_reminder",
      getSubject: (props) => volunteerStartReminderSubject(props),
      requiredProps: [
        "anchor",
        "title",
        "startsAtISO",
        "kindLabel",
      ],
      component: VolunteerStartReminder,
      sample: {
        anchor: "ask",
        title: "River cleanup day",
        roleName: "Litter picker",
        startsAtISO: "2026-05-02T14:00:00.000Z",
        endsAtISO: "2026-05-02T18:00:00.000Z",
        timezone: "America/Chicago",
        kindLabel: "Tomorrow",
        manageUrl:
          "https://ithasfire.com/v/00000000-0000-4000-8000-000000000001",
      },
    },
    // Coordinator assignment (generic-volunteering-asks FR-008). Subject is
    // shared with the component and mirrors the core renderer's title.
    "volunteer.group_coordinator_assigned": {
      id: "volunteer.group_coordinator_assigned",
      getSubject: (props) => volunteerGroupCoordinatorAssignedSubject(props),
      requiredProps: ["groupName", "askTitle", "coordinateUrl"],
      component: VolunteerGroupCoordinatorAssigned,
      sample: {
        assignerName: "Sam Rivera",
        groupName: "Flyer crew",
        askTitle: "Street team",
        coordinateUrl:
          "https://ithasfire.com/volunteers/coordinate/00000000-0000-4000-8000-000000000010",
        accountCompletionUrl: null,
      },
    },
    // Lineup notices (owner ruling "option A", 2026-09-30). Subjects are
    // shared with the components; lineup_added mirrors the core renderer's
    // title (comms/lineup-renderers.ts).
    "event.lineup_added": {
      id: "event.lineup_added",
      getSubject: (props) => lineupAddedSubject(props),
      requiredProps: [
        "addedByName",
        "eventTitle",
        "roleLabel",
        "lineupsUrl",
      ],
      component: LineupAdded,
      sample: {
        addedByName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "Friday, October 9, 2026 at 8:00 PM (Chicago time)",
        roleLabel: "Performer",
        lineupsUrl: "https://ithasfire.com/my-lineups",
        publiclyListed: true,
        eventEnded: false,
        organiserWillBeTold: true,
      },
    },
    "open_call.notice": {
      id: "open_call.notice",
      getSubject: (props) => openCallNoticeSubject(props),
      requiredProps: ["locale", "subject", "heading", "paragraphs", "footer"],
      component: OpenCallNotice,
      sample: {
        locale: "en",
        subject: "You're on the lineup for Friday Night Sessions",
        heading: "You're on the lineup",
        rows: [
          { label: "Event", value: "Friday Night Sessions" },
          {
            label: "When",
            value: "Friday, October 9, 2026 at 8:00 PM (Chicago time)",
          },
          { label: "Pay as posted", value: "A split of the door: 70/30 after costs" },
        ],
        paragraphs: [
          "The organizers picked you from your application to their open call.",
          "Being picked doesn't sign anything or move any money. The pay above is what the call posted; work out the details with the organizers.",
          "Can't make it after all? Drop out with one tap, and the organizers will be told.",
        ],
        quote: null,
        action: {
          label: "Open your application",
          url: "https://ithasfire.com/my-applications",
        },
        links: [{ label: "Drop out", url: "https://ithasfire.com/my-lineups" }],
        footer: "You're getting this because you applied to an open call on Ithas Fire.",
      },
    },
    "event.lineup_payout_invite": {
      id: "event.lineup_payout_invite",
      getSubject: (props) => lineupPayoutInviteSubject(props),
      requiredProps: [
        "inviterName",
        "eventTitle",
        "payoutsUrl",
        "lineupsUrl",
      ],
      component: LineupPayoutInvite,
      sample: {
        inviterName: "Sam Rivera",
        eventTitle: "Friday Night Sessions",
        whenLabel: "Friday, October 9, 2026 at 8:00 PM (Chicago time)",
        payoutsUrl: "https://ithasfire.com/admin/@the-sundowners/payments",
        accountCompletionUrl:
          "https://ithasfire.com/auth/complete?email=band%40example.org&src=lineup-invite",
        lineupsUrl: "https://ithasfire.com/my-lineups",
        paidEvent: true,
        organiserWillBeTold: true,
      },
    },
    "image.moderation.held": {
      id: "image.moderation.held",
      subjectTemplate: "Your image is being reviewed",
      requiredProps: [],
      component: ImageModerationHeld,
      sample: {
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/events/night-market-sessions",
        helpUrl: "https://ithasfire.com/help",
      },
    },
    "image.moderation.approved": {
      id: "image.moderation.approved",
      subjectTemplate: "Your image is now live",
      requiredProps: [],
      component: ImageModerationApproved,
      sample: {
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/events/night-market-sessions",
      },
    },
    "image.moderation.rejected": {
      id: "image.moderation.rejected",
      subjectTemplate: "Your image wasn't approved",
      requiredProps: [],
      component: ImageModerationRejected,
      sample: {
        note: "This image didn't meet our content guidelines.",
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/events/night-market-sessions",
      },
    },
    "booking.request_received": {
      id: "booking.request_received",
      subjectTemplate: "New booking request for {{placeName}}",
      requiredProps: ["placeName", "actName", "message", "source", "inboxUrl"],
      component: BookingRequestReceived,
      sample: {
        placeName: "The Corner Stage",
        actName: "The Midnight Ramblers",
        contactName: "Sam Torres",
        contactEmail: "sam@midnightramblers.band",
        message:
          "Hey! We're a four-piece Americana band based in East Nashville. We pack out rooms this size on weeknights and would love to bring our residency crowd to your stage.\n\nLinks and a live tape are in our press kit — happy to send more.",
        preferredDates: ["2026-08-14", "2026-08-21", "2026-08-28"],
        source: "EMBED",
        inboxUrl:
          "https://ithasfire.com/admin/corner-stage/places/plc_123/bookings",
      },
    },
    "booking.invite_to_claim": {
      id: "booking.invite_to_claim",
      subjectTemplate: "{{placeName}} wants to book you — finish setting up",
      requiredProps: ["placeName", "claimUrl", "expiresAtISO"],
      component: BookingInviteToClaim,
      sample: {
        placeName: "The Corner Stage",
        actName: "The Midnight Ramblers",
        claimUrl:
          "https://ithasfire.com/booking-requests/claim/tok_abc123def456",
        expiresAtISO: "2026-08-12T00:00:00.000Z",
      },
    },
    "booking.thread_message": {
      id: "booking.thread_message",
      // STABLE by contract: mail clients thread on References/In-Reply-To but
      // several (Gmail included) also split a conversation when the subject
      // drifts, so this string must NOT interpolate anything that changes
      // between sends — no message preview, no counter, no date.
      subjectTemplate: "Your booking request — {{placeName}}",
      requiredProps: ["placeName", "messageBody"],
      component: BookingThreadMessage,
      sample: {
        placeName: "The Corner Stage",
        messageBody:
          "Thanks for reaching out! We have a Friday in October open and we'd love to hear more about your setup — how many in the band, and do you bring your own sound?",
        replyToEmail: "booking@cornerstage.example",
      },
    },
    "booking.organizer_request_received": {
      id: "booking.organizer_request_received",
      subjectTemplate: "{{orgName}} wants to book you",
      requiredProps: ["orgName", "message", "requestsUrl"],
      component: OrganizerBookingRequestReceived,
      sample: {
        orgName: "Corner Booking Collective",
        message:
          "We're putting together a Friday-night showcase in East Nashville and your set would be a perfect fit. We can cover backline and sound — dates below, happy to talk terms.",
        preferredDates: ["2026-08-14", "2026-08-21"],
        attachedEventTitle: "East Side Showcase",
        requestsUrl: "https://ithasfire.com/account/settings",
      },
    },
    "booking.organizer_request_responded": {
      id: "booking.organizer_request_responded",
      getSubject: (props) =>
        props.action === "accepted"
          ? `${props.actName} accepted your booking request`
          : `${props.actName} declined your booking request`,
      requiredProps: ["actName", "action", "targetUrl"],
      component: OrganizerBookingRequestResponded,
      sample: {
        actName: "The Midnight Ramblers",
        action: "accepted",
        targetUrl: "https://ithasfire.com/agreements/agr_123",
      },
    },
    // booking-the-night N9 / FR-008: whoever SENT a booking request hears
    // the answer — both directions (the organiser variant above folds into
    // this one; it stays registered for rows queued before the fold).
    "booking.request_responded": {
      id: "booking.request_responded",
      getSubject: (props) => bookingRequestRespondedSubject(props),
      requiredProps: ["responderName", "action", "targetUrl"],
      component: BookingRequestResponded,
      sample: {
        responderName: "The Corner Stage",
        action: "declined",
        reason: "We're booked through the fall, but we'd love to hear from you in spring.",
        targetUrl: "https://ithasfire.com/account/settings/booking-requests",
      },
    },
    // booking-the-night N13 / FR-009: both sides hear a booked night was
    // cancelled, with the reason.
    "booking.booking_cancelled": {
      id: "booking.booking_cancelled",
      getSubject: (props) => bookingCancelledSubject(props),
      requiredProps: ["cancelledByName", "dateLabel", "reason", "eventCancelled", "targetUrl"],
      component: BookingCancelled,
      sample: {
        cancelledByName: "The Corner Stage",
        dateLabel: "Fri, Oct 17, 2026",
        reason: "The room flooded and we can't open that week.",
        eventCancelled: true,
        targetUrl: "https://ithasfire.com/account/settings/booking-requests",
      },
    },
    // ── P3b (asks) ── venue-booking-standards v1.1 FR-009b: the venue asked
    // the sender for one thing the night needs.
    "booking.ask_received": {
      id: "booking.ask_received",
      getSubject: (props) => bookingAskReceivedSubject(props),
      requiredProps: ["venueName", "label", "answerPhrase", "targetUrl"],
      component: BookingAskReceived,
      sample: {
        venueName: "The Corner Stage",
        label: "Poster",
        note: "Portrait, at least 1080px wide — we'll use it on the event page.",
        answerPhrase: "an image",
        targetUrl: "https://ithasfire.com/account/settings/booking-requests",
      },
    },
    // Booking holds (docs/specs/2026-08-25/completed/booking-holds.spec.yaml FR-016).
    // Subjects mirror the renderer titles in core comms/renderers.ts — keep
    // the two in sync.
    "booking.hold_placed": {
      id: "booking.hold_placed",
      getSubject: (props) =>
        props.kind === "placed_batch"
          ? `${props.placeName} is holding ${props.dates.length} dates for you`
          : props.kind === "moved"
            ? `You're now first in line for ${props.dateLabel}`
            : `${props.placeName} is holding ${props.dateLabel} for you`,
      // The INTERSECTION of the three shapes — `dateLabel` + `position` are
      // required for `placed` / `moved`, `dates` for `placed_batch`; the zod
      // discriminated union above is the honest per-shape contract.
      requiredProps: ["kind", "placeName", "targetUrl"],
      component: BookingHoldPlaced,
      sample: {
        kind: "placed",
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        position: 2,
        targetUrl: "https://ithasfire.com/account/settings/booking-requests",
      },
    },
    "booking.hold_challenged": {
      id: "booking.hold_challenged",
      getSubject: (props) =>
        props.position === 1
          ? props.extended
            ? `More time to answer ${props.placeName} about ${props.dateLabel}`
            : `${props.placeName} needs an answer on ${props.dateLabel}`
          : props.extended
            ? `Update on ${props.dateLabel} at ${props.placeName}`
            : `The first hold on ${props.dateLabel} was challenged`,
      requiredProps: [
        "placeName",
        "dateLabel",
        "respondByLabel",
        "position",
        "extended",
        "targetUrl",
      ],
      component: BookingHoldChallenged,
      sample: {
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        respondByLabel: "Thu, Aug 6 at 7:00 PM CDT",
        position: 1,
        extended: false,
        targetUrl: "https://ithasfire.com/account/settings/booking-requests",
      },
    },
    "booking.hold_released": {
      id: "booking.hold_released",
      getSubject: (props) =>
        props.reason === "lost_date"
          ? `${props.dateLabel} at ${props.placeName} went to another act`
          : props.reason === "expired"
            ? `Your hold on ${props.dateLabel} at ${props.placeName} lapsed`
            : `Your hold on ${props.dateLabel} at ${props.placeName} was released`,
      requiredProps: ["reason", "placeName", "dateLabel", "targetUrl"],
      component: BookingHoldReleased,
      sample: {
        reason: "lost_date",
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        targetUrl: "https://ithasfire.com/account/settings/booking-requests",
      },
    },
    "booking.hold_confirmed": {
      id: "booking.hold_confirmed",
      subjectTemplate: "{{placeName}} confirmed {{dateLabel}}",
      requiredProps: ["placeName", "dateLabel", "targetUrl"],
      component: BookingHoldConfirmed,
      sample: {
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        targetUrl: "https://ithasfire.com/account/settings/booking-requests",
      },
    },
    "booking.hold_staff_attention": {
      id: "booking.hold_staff_attention",
      getSubject: (props) =>
        props.kind === "answered_kept"
          ? `${props.actName} kept their hold on ${props.dateLabel}`
          : props.kind === "answered_released"
            ? `${props.actName} released their hold on ${props.dateLabel}`
            : `Hold for ${props.actName} on ${props.dateLabel} lapsed`,
      requiredProps: ["kind", "actName", "placeName", "dateLabel", "targetUrl"],
      component: BookingHoldStaffAttention,
      sample: {
        kind: "answered_kept",
        actName: "The Midnight Ramblers",
        placeName: "The Corner Stage",
        dateLabel: "Fri, Aug 14, 2026",
        targetUrl:
          "https://ithasfire.com/admin/corner-stage/places/plc_123/bookings",
      },
    },
    // Lineup invite (docs/specs/2026-09-25/completed/lineup-booking-requests-v2 FR-003).
    // Subject mirrors the renderer title in core comms/renderers.ts — keep
    // the two in sync.
    "booking.lineup_invited": {
      id: "booking.lineup_invited",
      getSubject: (props) =>
        `${props.senderName} added ${props.asGroupName ?? "you"} to a bill at ${props.venueName}`,
      requiredProps: ["senderName", "venueName", "dateLabels", "targetUrl"],
      component: BookingLineupInvited,
      sample: {
        senderName: "Corner Booking Collective",
        venueName: "The Corner Stage",
        dateLabels: ["Fri, Aug 14, 2026 at 8:00 PM", "Fri, Aug 21, 2026"],
        targetUrl:
          "https://ithasfire.com/bookings/acts/44444444-4444-4444-8444-444444444444",
      },
    },
    // The bill's notices after the invite (lineup-booking-requests v3,
    // FR-012). Subjects are shared with the components and mirror the core
    // renderer titles (comms/booking-lineup-notice-renderers.ts).
    "booking.lineup_request_closed": {
      id: "booking.lineup_request_closed",
      getSubject: (props) => bookingLineupRequestClosedSubject(props),
      requiredProps: ["senderName", "venueName", "dateLabels", "targetUrl"],
      component: BookingLineupRequestClosed,
      sample: {
        senderName: "Corner Booking Collective",
        venueName: "The Corner Stage",
        dateLabels: ["Fri, Aug 14, 2026 at 8:00 PM"],
        targetUrl:
          "https://ithasfire.com/bookings/acts/44444444-4444-4444-8444-444444444444",
      },
    },
    "booking.lineup_removed": {
      id: "booking.lineup_removed",
      getSubject: (props) => bookingLineupRemovedSubject(props),
      requiredProps: ["senderName", "venueName", "dateLabels"],
      component: BookingLineupRemoved,
      sample: {
        senderName: "Corner Booking Collective",
        venueName: "The Corner Stage",
        asGroupName: "Paper Moth",
        dateLabels: ["Fri, Aug 14, 2026"],
      },
    },
    "membership.renewal_notice": {
      id: "membership.renewal_notice",
      subjectTemplate:
        "Your {{tierName}} membership renews soon — {{amountFormatted}}",
      requiredProps: [
        "tierName",
        "ownerName",
        "amountFormatted",
        "renewalDateISO",
        "cancelUrl",
      ],
      component: MembershipRenewalNotice,
      sample: {
        tierName: "Sustaining Member",
        ownerName: "DRKMTTR Collective",
        amountFormatted: "$10.98",
        renewalDateISO: "2026-09-10T12:00:00.000Z",
        cancelUrl: "https://ithasfire.com/account/memberships",
      },
    },
    "settlement.payout_sent": {
      id: "settlement.payout_sent",
      getSubject: payoutSentTitle,
      requiredProps: [
        "kind",
        "amountCents",
        "currency",
        "payoutDateIso",
        "displayTimezone",
        "lines",
        "recoveredDebtCents",
        "connectAccountFeeCents",
        "reserveHeldCents",
        "reserveReleasedCents",
        "otherSalesCount",
        "otherSalesCents",
        "adjustmentsCents",
        "stripeDashboardUrl",
        "settlementCount",
      ],
      component: PayoutSent,
      // The REAL first production payout (Sun 2026-09-20): two "Test" sales
      // settled into one $10.64 transfer with nothing withheld.
      sample: {
        kind: "payout",
        amountCents: 1064,
        currency: "usd",
        orgName: "Ithas Fire",
        payoutDateIso: "2026-09-20T05:00:03.000Z",
        displayTimezone: "America/Chicago",
        lines: [
          {
            eventTitle: "Test",
            eventStartsAtIso: "2026-09-05T00:54:00.000Z",
            eventTimezone: "America/Chicago",
            ticketCount: 1,
            amountCents: 967,
            orderId: "ord_first_payout_1",
          },
          {
            eventTitle: "Test",
            eventStartsAtIso: "2026-09-05T02:08:00.000Z",
            eventTimezone: "America/Chicago",
            ticketCount: 1,
            amountCents: 97,
            orderId: "ord_first_payout_2",
          },
        ],
        recoveredDebtCents: 0,
        connectAccountFeeCents: 0,
        reserveHeldCents: 0,
        reserveReleasedCents: 0,
        otherSalesCount: 0,
        otherSalesCents: 0,
        adjustmentsCents: 0,
        balanceAfterCents: 0,
        nextPayableAtIso: null,
        bankDelayDays: 2,
        payoutsUrl: "https://ithasfire.com/admin/ithas-fire/payments",
        stripeDashboardUrl: "https://connect.stripe.com/express_login",
        settlementCount: 2,
      },
    },
  };

export const sampleInputs = Object.fromEntries(
  Object.entries(templateDefinitions).map(([id, definition]) => [
    id,
    definition.sample,
  ]),
) as { [K in TemplateId]: TemplatePropsMap[K] };

export const getDefinition = <T extends TemplateId>(templateId: T) =>
  templateDefinitions[templateId];
export const schemaFor = <T extends TemplateId>(templateId: T) =>
  templateSchemas[templateId];
