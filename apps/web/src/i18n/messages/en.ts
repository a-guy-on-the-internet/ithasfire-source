import type { Messages } from "@th/ui";

const enMessages: Messages = {
  common: {
    no: "No",
    none: "None",
    yes: "Yes",
    appTitle: "Ithas Fire",
    search: "Search",
    reserveTickets: "Reserve tickets",
    getTickets: "Get tickets",
    navGetTickets: "Get tickets",
    exploreEvents: "Explore events",
    editEvent: "Edit Event",
    free: "Free",
    dateNotSet: "Date not set",
    noHeroImage: "No hero image",
    untitledEvent: "Untitled Event",
    available: "{count} available",
    fromPrice: "From {value}",
    approximateArea: "Approximate area: {label}",
    noItemsYet: "No items yet.",
    optional: "optional",
    backToEvent: "Back to event",
    expired: "Expired",
    remaining: "remaining",
    secureCheckout: "Secure checkout",
    instantConfirmation: "Instant confirmation",
    soldOut: "Sold out",
    nRemaining: "{count} remaining",
    loading: "Loading...",
    cancel: "Cancel",
    goToHome: "Go to home",
    openNotifications: "Open notifications",
    // The bell's whole accessible name. `aria-label` replaces the button's
    // content, so the badge count has to be spoken from here.
    openNotificationsCount:
      "{count, plural, =0 {Open notifications} one {Open notifications, # unread} other {Open notifications, # unread}}",
    // Live-region announcement after a row is dismissed from the Unread tab.
    notificationDismissed: "Notification dismissed",
    notificationDismissedNamed: "Notification dismissed: {subject}",
    // The bell panel's Close button name and its Inbox / Activity tablist.
    closeNotifications: "Close notifications",
    notificationViews: "Notification views",
    // Notifications panel and inbox (bell panel and /account/notifications).
    notificationsInboxTab: "Inbox",
    notificationsActivityTab: "Activity",
    notificationsActivityEmptyTitle: "You're all caught up",
    notificationsActivityEmptyBody:
      "Alerts you clear here stay out of your way elsewhere. Any new alert will pop right back in.",
    notificationsClearAll: "Clear all",
    notificationAlertDismiss: "Dismiss alert",
    notificationAlertDraggable: "Draggable alert",
    notificationAlertDropToBottom: "Drop here to move to bottom",
    notificationsFilterTabs: "Filter notifications",
    notificationsUnreadTab: "Unread",
    notificationsAllTab: "All",
    notificationsMarkAllRead: "Mark all read",
    notificationsEmptyUnreadTitle: "All caught up",
    notificationsEmptyUnreadBody: "You have no unread notifications.",
    notificationsEmptyAllTitle: "No notifications yet",
    notificationsEmptyAllBody:
      "Notifications will appear here as things happen.",
    notificationsLoadMore: "Load more",
    notificationShowMore: "Show more",
    notificationShowLess: "Show less",
    // Per-row accessible names: `subject` is the row's title (or body), cut.
    notificationShowMoreNamed: "Show more: {subject}",
    notificationShowLessNamed: "Show less: {subject}",
    notificationDismissNamed: "Dismiss: {subject}",
    notificationGenericSubject: "Notification",
    preferences: "Preferences",
    mainNavigation: "Main navigation",
    mobileNav: "Mobile navigation",
    navHome: "Home",
    navSupport: "Support",
    navExplore: "Explore",
    navEvents: "Events",
    navTickets: "Tickets",
    navAccount: "Account",
    // Cookie consent
    cookieTitle: "What we store on your device",
    cookieDescription:
      "None of it is sold or shared with advertisers, and the site works exactly the same if you choose essentials only. See our",
    cookieAlwaysOnLabel: "Always on",
    cookieAlwaysOnItems:
      "Keeping you signed in, remembering your light/dark choice, unlocking private events, and Stripe's fraud checks when you pay.",
    cookieOptionalLabel: "Only if you accept all",
    cookieOptionalAnalytics:
      "Google Analytics, to count visits and see which pages get used.",
    privacyPolicy: "Privacy Policy",
    // Link labels after every SMS opt-in disclosure (SmsLegalLinks).
    smsTermsLink: "Terms",
    smsPrivacyLink: "Privacy",
    and: "and",
    cookiePolicy: "Cookie Policy",
    forDetails: "for details.",
    essentialOnly: "Essential Only",
    acceptAll: "Accept All",
    manageCookies: "Manage cookies",
    // Footer
    footerPlatform: "Platform",
    footerHome: "Home",
    menu: "Menu",
    menuBrowse: "Browse",
    menuPreferences: "Preferences",
    menuOrganisers: "Organisers",
    theme: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    language: "Language",
    footerHelpCentre: "Help Centre",
    footerFeatures: "Features",
    footerBrowseEvents: "Browse Events",
    footerSearch: "Search",
    footerHouseShows: "House shows",
    footerCompany: "Company",
    footerAbout: "About",
    footerContact: "Contact",
    footerSupport: "Support",
    footerLegal: "Legal",
    footerTerms: "Terms of Service",
    footerAcceptableUse: "Acceptable Use",
    footerForOrganisers: "For Organizers",
    footerDashboard: "Dashboard",
    footerCopyright: "{appTitle}. All rights reserved.",
    footerConnect: "Connect",
    footerTagline:
      "Discover, book, and experience live events. Built for communities.",
    actionFailed: "Action failed",
    switchLanguage: "Switch language (current: {language})",
    switchToDark: "Switch to dark mode",
    switchToLight: "Switch to light mode",
    browseByCategory: "Browse by Category",
    findEventsMatchInterests: "Find events that match your interests",
    viewAll: "View All",
    backToHome: "Back to home",
    back: "Back",
    required: "This field is required.",
    edit: "Edit",
    delete: "Delete",
    save: "Save",
    create: "Create",
    close: "Close",
    viewPhoto: "View photo",
    viewPhotoNamed: "View photo: {name}",
    photoViewer: "Photo viewer",
    previousPhoto: "Previous photo",
    nextPhoto: "Next photo",
    viewFullImage: "View full image",
    // Shared crop dialog (entity-page images + account avatar).
    cropSubtitle: "Drag to reposition. Zoom to frame it.",
    cropRegionLabel: "Crop area",
    cropKeyboardHint:
      "Drag the image, or use the arrow buttons and arrow keys to move it. Zoom with the slider or the + and − buttons and keys. Hold Shift for finer steps; press Home to recentre.",
    cropZoomLabel: "Zoom",
    cropZoomIn: "Zoom in",
    cropZoomOut: "Zoom out",
    cropPanLeft: "Move image left",
    cropPanRight: "Move image right",
    cropPanUp: "Move image up",
    cropPanDown: "Move image down",
    cropReset: "Recentre",
    cropApply: "Apply crop",
    cropPreparing: "Preparing image…",
    cropFailed: "Couldn't prepare that image",
    dateTimeIncomplete: "Part of the date or time is missing.",
    dateTimeStartIncomplete: "Part of the start date or time is missing.",
    dateTimeEndIncomplete: "Part of the end date or time is missing.",
  },
  eventDetail: {
    calendar: "Calendar",
    payWhatYouWant: "Pay what you want",
    plusFeesAndTax: "+ fees & tax",
    plusFees: "+ fees",
    plusTax: "+ tax",
    suggestedPrice: "suggested {value}",
    feesTax: "Tax",
    feesTaxNote: "Tax calculated at checkout",
    pwTogglePw: "Show password",
    selectDate: "Select a date",
    selectDateClose: "Close",
    selectDateContinue: "Continue",
    selectDateSubtitle: "Choose which date you'd like tickets for.",
    volunteerAddDetails: "Add more details",
    volunteerApplyCta: "Apply",
    volunteerApplyEmpty: "Select shifts",
    volunteerSelectCta: "Sign up",
    volunteerSelectionMany: "shifts selected",
    volunteerSelectionNone: "No shifts selected",
    volunteerSelectionOne: "shift selected",
    volunteerShiftDateTba: "Date to be announced",
    volunteerStatusApproved: "Approved",
    volunteerStatusPending: "Pending",
    volunteerStatusRejected: "Not selected",
    volunteerSubmittingAs: "Signing up as",
    volunteerSuccessPartial: "Some of your sign-ups went through.",
    volunteerWithdrawCta: "Withdraw",
    typeLabel: "Event",
    heroAlt: "Event hero",
    audioDownload: "Download audio",
    descriptionFallback: "Join us for an unforgettable experience.",
    scheduleSection: "Schedule",
    scheduleStarts: "Starts",
    scheduleEnds: "Ends",
    locationSection: "Location",
    // Community-listing fact block (COMMUNITY stewardship only). Mono
    // overline keys over Montserrat values. Start and end share one
    // `factWhen` row (owner, 2026-10-17); a listing with only one of them
    // reuses `scheduleStarts` / `scheduleEnds` so the surfaces cannot drift.
    factWhere: "Where",
    factWhen: "When",
    factListedBy: "Listed by",
    viewOnMap: "View on map",
    viewVenuePage: "View place page",
    pricingSection: "Pricing",
    organizerSection: "Organizer",
    lineupSection: "Lineup",
    listenChip: "Listen",
    listenChipLabel: "Listen to {name}",
    ticketsSection: "Tickets",
    goingSection: "Going?",
    upcomingDates: "Upcoming dates",
    ticketCapacity: "{count} available",
    // Per-tier sale state (time-based-ticket-pricing FR-010). `{date}` is
    // pre-formatted in the EVENT's timezone by `formatEventZonedInstant` —
    // never an ICU date skeleton, which would format in the reader's zone.
    tierOnSaleFrom: "On sale {date}",
    tierNotOnSale: "Not on sale yet",
    tierSalesEnded: "Sales ended",
    // Q-002 urgency copy. All three values are pre-formatted strings.
    // `{newPrice}` is NOT decoration: this line sits directly under the
    // availability notices ("On sale …" / "Sales ended"), which ARE about
    // dates, so "$12 until Fri, Oct 3" alone reads as a sales deadline. Naming
    // the price it rises to is what makes it unmistakably about price.
    tierPriceUntil: "{price} until {date}, then {newPrice}",
    feesPlatform: "Platform fee",
    feesProcessing: "Processing fee",
    feesSuffix: "fees",
    availabilityLabel: "Availability",
    availabilityStatus: "{status}",
    priceExact: "{value}",
    priceRange: "{min} – {max}",
    priceFrom: "From {value}",
    priceUpTo: "Up to {value}",
    metadataNotFoundTitle: "Event not found",
    metadataNotFoundDescription: "The requested event could not be located.",
    // Status banner (non-published public pages)
    statusBanner: {
      cancelledTitle: "Event cancelled",
      cancelledBody:
        "This event has been cancelled and is no longer taking place.",
      archivedTitle: "No longer available",
      archivedBody: "This event is no longer available.",
      completedTitle: "Event ended",
      completedBody: "This event has already taken place.",
      draftTitle: "Draft preview",
      draftBody:
        "This event isn't published yet. Only people with the link can see this page.",
    },
    // Ticket-holder view of an event whose page is otherwise hidden
    holderSalesPausedTitle: "Ticket sales are paused",
    holderSalesPausedBody: "Your tickets for this event are still valid.",
    // Password gate
    pwAccessGranted: "Access granted!",
    pwWelcome: "Welcome",
    pwIncorrect: "Incorrect password. Please try again.",
    pwError: "Something went wrong. Please try again.",
    pwEnterPassword: "Please enter the event password.",
    pwProtected: "This event is password protected",
    pwPlaceholder: "Enter event password",
    pwAriaLabel: "Event password",
    pwChecking: "Checking...",
    pwEnterEvent: "Enter Event",
    pwStayUnlockedHint: "You'll stay unlocked on this device for 24 hours.",
    pwTooManyAttempts: "Too many attempts. Please wait a minute and try again.",
    pwChallengeRequired: "One more step: complete the security check below.",
    pwChallengeFailed: "The security check didn't go through. Try it again.",
    pwChallengeUnavailable:
      "We can't run the security check right now. Try again later.",
    pwChallengeCaption: "Complete the security check to continue.",
    pwDoorKicker: "Private event",
    pwDoorEnter: "Enter",
    pwDoorWaitlistLink: "No password? Get notified when tickets open",
    // Invite link landing (gated-event invite links FR-004 / FR-010). The
    // kicker is followed by " · <date>" in the component.
    inviteKickerFor: "Invite for {name}",
    inviteKickerYours: "Your invite",
    inviteKickerShared: "You’re invited",
    inviteBodyPersonal:
      "{organizer} invited you. This link is yours; it works on any device until the night is over.",
    inviteBodyPersonalAnon:
      "You were invited. This link is yours; it works on any device until the night is over.",
    inviteBodyShared: "{organizer} sent you this link. Tap once to come in.",
    inviteBodySharedAnon: "Someone sent you this link. Tap once to come in.",
    inviteOpen: "Open the event",
    inviteOpening: "Opening the event…",
    inviteDeadPassword:
      "This invite link doesn’t work anymore. Ask whoever sent it for a new one, or enter the password.",
    inviteDeadApplication:
      "This invite link doesn’t work anymore. Ask whoever sent it for a new one, or apply.",
    inviteRemovedPassword:
      "The organiser reset the invite link, so it no longer lets you in. Ask them for a new one, or enter the password.",
    inviteRemovedApplication:
      "The organiser reset the invite link, so it no longer lets you in. Ask them for a new one, or apply.",
    // Magic link gate
    mlLoading: "Loading...",
    mlSignInPrompt: "Sign in to access this private event with your magic link",
    mlSignInContinue: "Sign in to continue",
    mlUnlocking: "Unlocking event...",
    mlUnableToUnlock: "Unable to unlock",
    mlTryAgain: "Try again",
    mlGoToEvent: "Go to event page",
    mlAccessGranted: "Access granted! Loading event...",
    mlAccessGrantedToast: "Access granted via magic link!",
    mlUnableToRedeem: "Unable to redeem magic link",
    mlInvalidOrUsed: "This magic link is invalid or has already been used.",
    mlAlreadyRedeemed: "This magic link has already been used.",
    mlExpired: "This magic link has expired.",
    mlWrongRecipient: "This magic link was sent to a different account.",
    mlRedeemFailed: "Unable to redeem magic link. Please try again.",
    // Application gate
    appEnterEmail: "Please enter your email address.",
    appContactRequired: "Please provide a contact email.",
    appNoLongerRequired: "This event no longer requires an application.",
    appGenericError: "Something went wrong. Please try again.",
    // Form-first anonymous applying (spec Phase 3): signing in is an OPTIONAL
    // affordance beside the form, never a gate. The three
    // `appSignInRequired*` keys this replaced are gone with the sign-in
    // short-circuit that was their only consumer.
    appSignInToTrackBody:
      "Applying as a guest. Sign in first if you'd like to track your application from your account.",
    appSignInToTrackCta: "Sign in to track it",
    appVerifyToContinue: "Complete the verification to continue.",
    // Application gate, one question at a time (direction D, 2026-09-30).
    // Consumed by `@th/ui` EventApplicationGate + the web wrapper.
    appGateKicker: "Application required",
    appGateFormLabel: "Application for {title}",
    appGateQuestionOf: "Question {current} of {total}",
    appGateContactStep: "Last step · Contact",
    appGateContactOnly: "Contact",
    appGateAllQuestions: "All questions",
    appGateStateCurrent: "Current",
    appGateStateAnswered: "Answered",
    appGateStateNotAnswered: "Not answered",
    appGateOptional: "Optional",
    appGateAnswerPlaceholder: "Your answer",
    appGateAnswerRequired: "Answer this question to continue.",
    appGateContactQuestion: "Where should the decision go?",
    appGateEmailLabel: "Email",
    appGateEmailPlaceholder: "you@example.com",
    appGatePhoneLabel: "Phone (optional)",
    appGateBack: "Back",
    appGateNext: "Next",
    appGateSend: "Send application",
    appGateSending: "Sending…",
    appGateLoading: "Loading the application…",
    appGateUnavailable: "The application form isn't available yet.",
    appGateWindowKicker: "Applications",
    appTimelineLabel: "Application progress",
    appTimelineApplied: "Applied",
    appTimelineInReview: "In review",
    appTimelineDecision: "Decision",
    appTimelineApproved: "Approved",
    appTimelineNotApproved: "Not approved",
    appTimelineWaitlist: "Waitlist",
    appTimelineWithdrawn: "Withdrawn",
    appTimelineExpired: "Expired",
    appStatusKickerInReview: "In review",
    appStatusKickerDecision: "Decision",
    appStatusKickerApplication: "Application",
    appStatusSentTitle: "Application sent",
    appStatusSentBody:
      "Your spot isn't confirmed yet. The organizer reads every application, and we'll email you either way.",
    appStatusYoureInTitle: "You're in",
    appStatusNotApprovedTitle: "Not approved",
    appStatusNotApprovedBody: "The organizer didn't approve your application.",
    appStatusFromOrganizer: "From the organizer",
    // Application lifecycle (withdraw + window states)
    appWithdrawConfirmTitle: "Withdraw application?",
    appWithdrawConfirmBody:
      "This tells the organizer you're no longer interested. You can apply again while applications are open.",
    appWithdrawConfirmCta: "Withdraw",
    appWithdrawFailed: "Couldn't withdraw your application",
    // Ticket availability states
    ticketsSoldOut: "Sold out",
    ticketsSoldOutHint: "All tickets for this event have been sold.",
    ticketsComingSoon: "Tickets coming soon",
    ticketsComingSoonHint: "Check back closer to the event date.",
    joinWaitlist: "Notify me",
    onWaitlist: "You\u2019re on the list",
    // Directions & calendar
    directionsGoogle: "Google Maps",
    directionsApple: "Apple Maps",
    directionsWaze: "Waze",
    getDirections: "Get directions",
    addToCalendar: "Add to calendar",
    addToGoogleCalendar: "Google Calendar",
    addToOutlookCalendar: "Outlook Calendar",
    copyAddress: "Copy address",
    copied: "Copied!",
    feesTapHint: "Tap for fee details",
    ctaFromPrice: "Get tickets \u2014 from {value}",
    // Share
    share: "Share event",
    shareNative: "Share...",
    shareCopyLink: "Copy link",
    shareLinkCopied: "Link copied!",
    shareTwitter: "Post on X",
    shareFacebook: "Share on Facebook",
    // Organizer + venue badges
    presentedBy: "Presented by {name}",
    atVenue: "At {name}",
    confirmedByVenue: "Confirmed by the place",
    attendeeRatingLine:
      "This event · {score}/5 from {count} verified attendees",
    // Attendee count / social proof
    nGoing: "{count, plural, one {# going} other {# going}}",
    // Low-availability urgency
    lowAvailability: "Only {count} left",
    lastFew: "Almost gone",
    // The parts of the all-in "from" price, named under the figure. `long`
    // for the buy band and the classic hero; `short` for the phone's docked
    // bar. A zero part is dropped, never printed as "+ $0.00".
    priceBreakdown: {
      longFull: "{ticket} ticket + {fees} fees + {tax} tax",
      longNoTax: "{ticket} ticket + {fees} fees",
      longNoFees: "{ticket} ticket + {tax} tax",
      shortFull: "incl. {fees} fees + {tax} tax",
      shortNoTax: "incl. {fees} fees",
      shortNoFees: "incl. {tax} tax",
    },
    // Countdown timer
    startsInHours: "Starts in {count, plural, one {# hour} other {# hours}}",
    startsInMinutes:
      "Starts in {count, plural, one {# minute} other {# minutes}}",
    happeningNow: "Happening now",
    // Refund policy
    refundPolicySection: "Refund policy",
    refundPolicyUntilStart: "Full refund available until this event starts.",
    refundPolicyUntilDate: "Full refund available until {date}.",
    // Notify Me (sign-up CTA)
    waitlistJoining: "Signing up...",
    waitlistEmailPlaceholder: "Your email address",
    notifyMe: "Get notified when tickets drop",
    notifyMeButton: "Notify me",
    notifyMeSubmitting: "Signing up...",
    notifyMeRateLimited: "Too many sign-ups from here. Try again later.",
    notifyMeEmailPlaceholder: "Your email address",
    notifyMeConfirmed: "You\u2019re on the list!",
    notifyMeConfirmedHint:
      "We\u2019ll email you as soon as tickets are available.",
    notifyMeSignedInHint:
      "We\u2019ll notify you at {email} when tickets are available.",
    // More by organizer
    moreByOrganizer: "More events by {name}",
    viewAllOrgEvents: "View all events",
    fromPrice: "From {value}",
    // Organizer card (feature 10)
    aboutOrganizer: "About the organizer",
    orgContactEmail: "Contact",
    orgEventCount:
      "{count, plural, one {# upcoming event} other {# upcoming events}}",
    viewOrgProfile: "View organizer",
    // Wallet passes (feature 7 — placeholder)
    addToWallet: "Add to Wallet",
    walletComingSoon: "Apple & Google Wallet passes coming soon",
    volunteerSectionTitle: "Volunteer",
    volunteerSectionSubtitle:
      "Help make this event happen by signing up for a role below.",
    volunteerSignupCta: "Sign up",
    volunteerSpotsOpen: "Open spots",
    volunteerSpotsFull: "Full",
    volunteerShiftFull: "Shift full",
    volunteerFullWaitlist: "Full — you'll be waitlisted",
    volunteerDialogTitle: "Volunteer sign-up",
    volunteerFieldName: "Name",
    volunteerFieldEmail: "Email",
    volunteerFieldPhone: "Phone",
    volunteerFieldNote: "Note",
    volunteerFieldOptional: "optional",
    volunteerSubmit: "Submit",
    volunteerSuccessAuth: "You're signed up.",
    volunteerSuccessGuest: "Your sign-up was received.",
    volunteerSuccessEmailHint:
      "We'll email you with next steps if this role is approved.",
    volunteerSuccessEmailHintConfirmed:
      "You're all set — check your email for details.",
    volunteerResultApproved: "You're in — this spot is confirmed.",
    volunteerResultWaitlisted:
      "Currently full — you're on the waitlist. We'll email you if a spot opens.",
    volunteerAlreadySignedUp: "You already signed up for this role.",
    volunteerErrorEmailRequired: "Email is required.",
    volunteerErrorDisabled:
      "Volunteer sign-ups are currently disabled for this event.",
    volunteerErrorNotFound:
      "That volunteer role or shift is no longer available.",
    volunteerErrorInvalid: "Please review your details and try again.",
    volunteerErrorForbidden:
      "You do not have permission to submit this sign-up.",
    volunteerErrorGeneric: "We couldn't submit your sign-up. Please try again.",
    // Volunteer waiver gate (Gap 3)
    volunteerWaiverAgreeLabel: "I have read and agree to the volunteer waiver",
    volunteerWaiverOnFile: "Waiver already on file",
    volunteerErrorWaiverRequired:
      "You must accept the volunteer waiver to sign up.",
    // Per-signup SMS preference (Gap 6)
    volunteerSmsOptInLabel: "Text me a reminder before my shift",
    volunteerSmsOptInLabelEventStart:
      "Text me a reminder before the event starts",
    volunteerSmsOptInLabelMixed:
      "Text me a reminder before my shift and before the event starts",
    // TCPA / CTIA boilerplate — keep sender + frequency + msg-rate
    // disclaimer + STOP/HELP keywords in every locale (carriers match
    // the English keywords).
    volunteerSmsOptInDescription:
      "Texts from Ithas Fire about 24h and 1h before each start time, US numbers only. Optional, not required to sign up. Msg & data rates may apply. Reply STOP to opt out, HELP for help.",
    volunteerSmsToggleLabel: "Text me shift reminders",
    volunteerSmsToggleLabelEventStart:
      "Text me reminders before the event starts",
    volunteerSmsStopHint:
      "Reply STOP to any reminder text to opt out everywhere.",
    volunteerSmsMayNeedStart:
      "If this number ever replied STOP, reply START from that phone to get texts again.",
    volunteerSmsUpdateFailed:
      "Couldn't update your SMS preference. Please try again.",
    volunteerSmsUsOnly:
      "We can only text US numbers. Untick the box or use a US number.",
    volunteerSmsToggleUsOnly:
      "We can only text US numbers, and the number on this signup isn't one.",
  },
  confirmation: {
    addToCalendar: "Add to calendar",
    addToGoogleCalendar: "Google Calendar",
    addToOutlookCalendar: "Outlook Calendar",
    copied: "Copied",
    downloadIcs: "Download .ics file",
    shareEvent: "Share event",
    walletPassesAvailable:
      "Add your tickets to Apple Wallet or Google Wallet for quick access at the door.",
    whatsNext: "What's next",
    whatsNextEmail: "We sent your confirmation and tickets to {email}.",
    whatsNextEntry: "Show your QR code at the door for entry.",
    whatsNextTickets: "Your tickets are ready in My Tickets.",
    title: "You're all set!",
    subtitle: "Your tickets have been confirmed. See you there!",
    orderId: "Order",
    ticketCount: "{count, plural, one {# ticket} other {# tickets}}",
    emailSent: "Confirmation email sent",
    emailSentTo: "We sent your tickets to {email}",
    viewTickets: "View Tickets",
    backToEvent: "Back to Event",
    addToCalendarSection: "Add to your calendar",
    waiverAccepted: "Waiver accepted",
    // A US bank debit Stripe accepted but has not cleared (owner, 2026-10-14).
    processingTitle: "Payment processing",
    processingSubtitle:
      "Bank payments take a few business days to clear. Your tickets come when it does.",
    processingEmail: "We'll email your tickets to {email} when the payment clears.",
    processingEmailNoAddress: "We'll email your tickets when the payment clears.",
    processingFailNotice:
      "If the payment doesn't go through, we cancel the order and you aren't charged.",
    viewOrder: "View order",
  },
  checkout: {
    acceptTermsToContinue: "Please accept the terms to continue",
    pwywChooseAmount: "Choose your amount",
    pwywAmountForTier: "for {name}",
    pwywPresetFor: "{amount} for {name}",
    pwywMinimum: "Minimum: {amount}",
    pwywSliderFor: "Set amount for {name}",
    pwywNonRefundable: "This is a donation and is non-refundable.",
    donationAboveMaximum: "The most you can pay for one ticket is {max}.",
    enterCity: "Enter your city",
    enterEmail: "Enter your email address",
    enterFullName: "Enter your full name",
    enterPostalCode: "Enter your postal code",
    enterStateOrRegion: "Enter your state or region",
    enterStreetAddress: "Enter your street address",
    fieldsNeedAttention:
      "{count, plural, one {# field needs attention} other {# fields need attention}}",
    increaseQuantityFor: "Increase quantity — {name}",
    decreaseQuantityFor: "Decrease quantity — {name}",
    getTicketsOnHearthfire: "Get tickets on Ithas Fire",
    nextField: "Next field",
    selectYourTickets: "Select your tickets",
    completeYourPurchase: "Complete your purchase",
    orderSummary: "Order summary",
    selectTicketsPrompt: "Select tickets to see your order total",
    subtotal: "Subtotal",
    estimatedTotal: "Estimated total",
    eachPrice: "{price} each",
    serviceFees: "Service fees",
    platformFee: "Platform fee",
    platformFeeTooltip: "A service fee that supports the Ithas Fire platform.",
    processingFee: "Processing fee",
    processingFeeTooltip: "Covers card processing costs (Stripe).",
    feeRateLabel: "({rate})",
    feeTransparencyNote: "We show you the exact fees — no hidden charges.",
    processingFeesByMethod: "Processing fees by payment method",
    estimatedTaxes: "Estimated taxes",
    taxes: "Taxes",
    included: "Included",
    calculatedNext: "Calculated next",
    estimatePrefix: "Est.",
    total: "Total",
    ticketPrice: "Ticket price",
    discount: "Discount",
    memberDiscount: "Member discount",
    memberDiscountTier: "Member discount — {tier}",
    creditApplied: "Credit applied",
    calculatingTotal: "Calculating total...",
    holdExpired: "Hold expired — please re-select tickets.",
    reservedFor: "Reserved for",
    // Embed checkout: the order behind the payment step (EmbedOrderNotice,
    // EmbedCheckout). "Reserved", never "hold".
    embedBackLockedPaying:
      "Your payment is processing. You can go back when it finishes.",
    embedBackLockedCreating:
      "Your order is being created. You can go back when it finishes.",
    embedOrderChanged: "You changed your tickets, so we'll start a new order.",
    embedNotCharged: "You have not been charged.",
    embedTicketsReserved:
      "Your tickets are reserved for the next {countdown}. If you change them, you start a new order and these go back on sale.",
    embedReservationRanOut:
      "Your reservation ran out. Continue to reserve your tickets again; they may no longer be available.",
    // {typicalTime} and {latestTime}: clock times in the viewer's locale and
    // time zone, for when the server usually clears an order the buyer left
    // and the latest it can (embed-payment-order.ts). Both are later than
    // the order's own countdown. Said only of an order that was not released.
    embedEarlierOrderReserved:
      "Tickets from your earlier order usually go back on sale by {typicalTime} and can stay reserved until {latestTime}, so they may show as unavailable until then.",
    embedPaymentOutcomeUnknown:
      "We could not confirm whether your payment went through. Check your email before trying again.",
    embedPaymentNotCompleted:
      "Payment could not be completed. Please try again.",
    embedCheckoutTimedOut: "This is taking longer than expected. Try again.",
    // Embed checkout: the server's word on an order Stripe says is paid
    // (embeds.confirmGuestPayment). "Order confirmed" is said only on that
    // answer; these are what the buyer reads while it is asked for, when it
    // does not come, and when the payment is still clearing.
    embedBackLockedConfirming:
      "We are confirming your order. You can go back when it finishes.",
    embedConfirmingOrder: "Confirming your order…",
    embedPaidUnconfirmedTitle:
      "Your payment went through, but we could not confirm your order yet.",
    embedClearingUnconfirmedTitle:
      "Your payment is with your bank, and we could not confirm your order yet.",
    embedUnconfirmedBody:
      "Check your email for your tickets. Do not pay again: a second checkout could charge you twice.",
    // Under the clearing title: no ticket is sent until the bank clears.
    embedClearingUnconfirmedBody:
      "We will email your tickets when your bank clears the payment. Do not pay again: a second checkout could charge you twice.",
    // Both followed by the support email address as a link.
    embedUnconfirmedContact: "If your tickets do not arrive, write to",
    embedClearingUnconfirmedContact:
      "If your tickets have not arrived in a few days, write to",
    embedCheckAgain: "Check again",
    embedCheckingAgain: "Checking…",
    embedStillUnconfirmed: "We still could not confirm your order.",
    embedPaymentClearingTitle: "Your bank is clearing this payment",
    embedPaymentClearingBody:
      "We will email your tickets when it clears. You do not need to do anything else.",
    embedEarlierOrderPaid:
      "Your payment for an earlier order went through. Check your email for its tickets.",
    embedEarlierOrderClearing:
      "Your payment for an earlier order is with your bank. We will email its tickets when it clears.",
    embedEarlierOrderUnknown:
      "We could not confirm whether your payment for an earlier order went through. Check your email before buying again.",
    // Embed checkout: giving back the tickets of an order the buyer has not
    // paid for (embeds.releaseGuestOrder). The first three are the control
    // in the "tickets reserved" notice; the last two say a release happened.
    embedLetTicketsGo: "Let these tickets go",
    embedLetTicketsGoBusy: "Letting them go…",
    embedLetTicketsGoFailed:
      "We couldn't let these tickets go just now. They are still reserved for you.",
    embedTicketsReleased: "Your tickets are back on sale.",
    embedEarlierOrderReleased:
      "The tickets from your earlier order are back on sale.",
    // Embed confirmation: the order's tickets and its order code
    // (EmbedTickets, EmbedConfirmation, EmbedRedirectConfirmation). Shown
    // only when the server sent the tickets with its "confirmed" answer.
    embedTicketsHeading: "Your tickets",
    embedTicketsShowAtDoorOne:
      "Show this code at the door. It is also in the email.",
    embedTicketsShowAtDoorMany:
      "Show these codes at the door. They are also in the email.",
    embedTicketsCount: "Ticket {n} of {total}",
    embedTicketsFallbackName: "Ticket",
    embedTicketsQrLabel: "Ticket code for {name}",
    embedTicketsQrLabelSeat: "Ticket code for {name}, {seat}",
    embedTicketsQrLabelUnnamed: "Ticket code",
    embedTicketsQrLabelUnnamedSeat: "Ticket code, {seat}",
    embedTicketsQrLabelNth: "{label}, ticket {n} of {total}",
    embedTicketsOrderLabel: "Order",
    // Under "Payment details" in the embed: what the widget's payment form
    // offers (card, the device's wallet, bank through Link). Amazon Pay and
    // Cash App Pay are off in Stripe (owner, 2026-10-13).
    embedPaymentMethodsCaption:
      "Pay by card, Apple Pay, Google Pay or your bank through Link. Other ways to pay are on the full checkout page.",
    startingPayment: "Starting payment...",
    reserving: "Reserving...",
    checkout: "Checkout",
    proceedToPayment: "Proceed to payment",
    continueToPayment: "Continue to payment",
    confirmFreeTickets: "Get free tickets",
    reserveNTickets:
      "Reserve {count, plural, =0 {tickets} one {# ticket} other {# tickets}}",
    holdTickets: "Hold tickets",
    nTickets: "{count, plural, one {# ticket} other {# tickets}}",
    ticketsNotOnSale: "Tickets aren't on sale yet",
    checkBackLater: "Check back closer to the event date.",
    cartExpired: "Your previous cart has expired. Please select tickets again.",
    unableToHold: "Unable to hold tickets right now.",
    unableToStartPayment: "Unable to start payment. Please try again.",
    paymentConfirmationFailed:
      "Payment was processed but confirmation failed. Check your tickets.",
    selectAtLeastOne: "Select at least one ticket to continue.",
    billingAddressRequired:
      "Please enter a billing address before checking out.",
    selectSeatsOnMap: "Select seats on map",
    nSeatsSelected:
      "{count, plural, one {# seat selected} other {# seats selected}}",
    cardNumber: "Card number",
    expiry: "Expiry",
    cvc: "CVC",
    processing: "Processing...",
    payNow: "Pay now",
    payAmount: "Pay {amount}",
    payment: "Payment",
    encryption: "256-bit encryption",
    orPayWithCard: "or pay with card",
    totalUpdated: "Total updated to {amount}",
    paymentFailed: "Payment failed. Please try again.",
    paymentCouldNotComplete:
      "Payment could not be completed. Please try again.",
    // Promo code
    promoCodePlaceholder: "Promo code",
    promoCodeApply: "Apply",
    promoCodeApplied: "Applied",
    promoCodeRemove: "Remove",
    promoCodeInvalid: "Invalid promo code",
    promoCodeExpired: "This promo code has expired",
    promoCodeAlreadyApplied: "Code already applied",
    promoCodeRemovedTitle: "Promo code removed",
    pwywEnterValidAmount: "Enter a valid amount",
    platformFeeRateCapped: "{rate}, max {max}/ticket",
    platformFeeRatePctCapped: "{pct} (max {max}) + {fixed}",
    platformFeeWaived: "Fee waiver applied: \u2212{amount}",
    promoCheckUnavailable:
      "Couldn\u2019t check your discounts right now \u2014 any that are valid will be applied at payment.",
    promoUrlCheckUnavailable:
      "Couldn\u2019t check the code from your link right now. Enter it in the promo code field to try again.",
    promoOthersBlocked:
      "Your other codes and member discounts won\u2019t apply until this one does or you remove it.",
    // Stepper labels
    stepTickets: "Tickets",
    stepCheckout: "Checkout",
    stepDetails: "Details",
    stepPayment: "Payment",
    stepConfirmed: "Confirmed",
    stepPaymentProcessing: "Payment processing",
    stepPaymentUnconfirmed: "Not confirmed",
    stepPaymentChecking: "Checking payment",
    bankDebitNotice:
      "Bank payments take a few business days to clear. Your tickets arrive when it does.",
    stepProgress: "Step {current} of {total}",
    stepGoBack: "Go back to {step}",
    stepperProgressLabel: "Checkout progress: step {current} of {total}",
    stepperProgressValue: "{current} / {total} — {step}",
    continue: "Continue",
    // Contact form (step 2)
    yourDetails: "Your details",
    contactDetails: "Contact information",
    contactDetailsDescription:
      "We'll send your tickets and order confirmation here.",
    fullName: "Full name",
    emailAddress: "Email address",
    phoneNumber: "Phone number",
    optional: "optional",
    fieldRequired: "This field is required.",
    invalidEmail: "Please enter a valid email address.",
    invalidPhone: "Please enter a valid phone number.",
    billingAddressRequiredTitle: "MISSING DETAILS",
    billingAddressRequiredToast: "Fill in the highlighted fields to continue.",
    // Billing address
    billingAddress: "Billing address",
    addressLine1: "Address",
    addressLine2: "Address line 2",
    city: "City",
    state: "State / Province",
    selectState: "Select state",
    postalCode: "Postal code",
    country: "Country",
    selectCountry: "Select country",
    // Account gate
    accountRequired: "Sign in to complete checkout",
    accountRequiredDescription:
      "You'll need an account so we can send your tickets and keep your order history.",
    signInOrCreateAccount: "Sign in or create account",
    // Guest account disclosure (embeds / future guest checkout)
    guestAccountNotice:
      "By continuing, an account will be created with your email so we can deliver your tickets and keep your order history. You can claim it anytime by setting a password.",
    guestConfirmationClaimHint:
      "You can sign in with this email to view your order history and manage your tickets.",
    // Billing disclosure (auto-save)
    billingDisclosure:
      "Your billing details will be saved to speed up future checkouts. You can manage them in your account settings.",
    // Back-to-selecting / hold-release
    changeTickets: "Change tickets",
    holdWarningTitle: "Release your held tickets?",
    holdWarningDescription:
      "Going back will release your current ticket hold. You\u2019ll need to hold tickets again after making changes.",
    holdWarningConfirm: "Release and go back",
    holdWarningCancel: "Keep my tickets",
    holdWarningPaymentInProgress:
      "Payment in progress — your tickets can't be released right now.",
    confirmedOrderLoading: "Loading your order…",
    redirectConfirming: "Confirming your payment…",
    paymentReceivedFinishing:
      "Your payment was received; we're finishing your order.",
    paymentSubmittedFinishing:
      "Your payment was submitted. It can take a few days to clear — we'll email you when your order is confirmed.",
    paymentUnverified:
      "We couldn't confirm your payment. Check My tickets before trying again.",
    paymentWrongAccount:
      "This payment was made from a different account. Sign in to the account that paid to see your tickets.",
    // A redirect payment Stripe VERIFIED dead (nothing taken): back to buying.
    redirectFailedDeclined:
      "Payment was declined. Please try a different payment method.",
    redirectFailedNotCompleted: "Payment was not completed. Please try again.",
    redirectFailedCanceled: "Payment was canceled. Please try again.",
    walletNoChargeNeeded: "No charge needed — your order is confirmed.",
    confirmedOrderUnavailable:
      "Your payment went through, but we couldn't load the order summary here. Your tickets are in your order.",
    // A reloaded confirmation link this page can't show (not yours, another
    // event, refunded, signed out): the empty picker, and this notice.
    restoredOrderUnavailable:
      "We can't show that order here. Any tickets you bought are in My tickets.",
    restoredOrderMyTickets: "Go to My tickets",
    // A reloaded confirmation link we couldn't check just now (a server or
    // network hiccup). Neutral: the order id is unverified.
    restoredOrderLoadFailed:
      "We couldn't load your order just now. Try again in a moment, or find it in My tickets.",
    restoredOrderRetry: "Try again",
    restoredOrderRetrying: "Trying again…",
    // Seat map picker
    priceRange: "{min} \u2013 {max}",
    seatMapView: "Map",
    seatListView: "List",
    nOfTotalAvailable: "{available} of {total} available",
    legendAvailable: "Available",
    legendSelected: "Selected",
    legendUnavailable: "Unavailable",
    seatRowNumber: "Row {row} \u00b7 Seat {number}",
    seatDeselected: "Deselected seat {label}",
    seatSelectedIn: "Selected seat {label} in {section}",
    seatAriaSelected: "Seat {label} (selected)",
    seatAriaAvailable: "Seat {label}",
    seatAriaUnavailable: "Seat {label} (unavailable)",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomReset: "Reset zoom",
    tapToSelect: "Tap a seat to select",
    tapSectionToZoom: "Tap a section to zoom in",
    dragPinchHint: "Drag to move · pinch to zoom",
    seatMapOverview: "Overview",
    sectionJumpNav: "Jump to a section",
    // Waiver
    waiverTitle: "Waiver Agreement",
    waiverAcceptLabel: "I have read and agree to the waiver terms above",
    waiverRequired: "You must accept the waiver to continue.",
    // Refund policy acknowledgement
    oneMoreThing: "ONE MORE THING",
    refundPolicyAcceptLabel: "I have read and agree to the refund policy",
    refundPolicyRequiredToast: "Accept the refund policy to continue.",
    refundDisclosurePaidWithPolicy:
      "Paid tickets are refundable per the organizer's refund policy. Your ticket price, tax, and the platform fee are all refundable; only the payment processing fee is non-refundable, because our payment processor retains it even on a refund.",
    refundDisclosurePaidFallback:
      "Paid tickets are refundable only if the organizer has stated a refund policy or the event is cancelled. Your ticket price, tax, and the platform fee are all refundable; only the payment processing fee is non-refundable, because our payment processor retains it even on a refund.",
    refundDisclosureResalePaidWithPolicy:
      "Refundable per the organizer's refund policy. Your ticket price and tax are refundable. Only the payment processing fee isn't, because our payment processor keeps it.",
    refundDisclosureResalePaidFallback:
      "Refundable only if the organizer has stated a refund policy or the event is cancelled. Your ticket price and tax are refundable. Only the payment processing fee isn't, because our payment processor keeps it.",
    refundDisclosureDonation: "Donation tickets are non-refundable.",
    refundDisclosureFreeWithPolicy:
      "Free tickets do not create a charge. Event changes and cancellations still follow the organizer's refund policy.",
    refundDisclosureFreeFallback:
      "Free tickets do not create a charge. Event changes and cancellations are handled by the organizer.",
    refundPolicySeeFull: "See full refund policy",
    termsRequiredToast: "Accept the Terms of Service to continue.",
    termsAcceptPrefix: "I agree to the",
    termsOfService: "Terms of Service",
    termsAndRefundAcceptPrefix: "I agree to the",
    termsAndRefundAcceptSuffix: "and have read and agree to the refund policy",
    buyerProtectionIncluded: "Buyer protection included",
  },
  events: {
    // Subtle card affordance for a recurring community listing (one Event that
    // repeats on a schedule, e.g. a weekly open mic).
    recurringBadge: "Recurring",
  },
  eventCard: {
    // The poster's hover ledger (`EventCardPriceReveal` in @th/ui) prints at
    // most four tiers, then this line for the rest. Deep-merged over the
    // package catalog's `eventCard` block by the app locale provider.
    moreTiers: "+{count} more",
    // A listing with no price to show (the all-in figure is unknown, or
    // nothing is on sale). Printed where a row has a price slot to fill
    // (LineupRow); cards hide it. `useListingPriceWords` in @th/ui.
    seeDetails: "See details",
    // The card's gate row, here and in the embed widget (owner, 2026-10-13:
    // "By application", not "Application"). Overrides the package catalog.
    gateApplication: "By application",
  },
  forms: {
    validationSummaryTitle:
      "{count, plural, one {# thing needs fixing} other {# things need fixing}}",
  },
  home: {
    // Honest, date-accurate label for the lead events row. popularityScore is
    // data-starved at launch volume (≈0 for every event), so the row is really
    // ordered by start date, not popularity — see getTierTitleKey in HomeLayout.
    upcomingEvents: "Upcoming events",
    // Retained for other locales/tests; no longer rendered as a section title
    // (getTierTitleKey no longer returns any "Popular" key).
    popularEvents: "Popular Events",
    eventsNearYou: "Events Near You",
    eventsInYourRegion: "Events in Your Region",
    popularInYourCountry: "Popular in Your Country",
    popularWorldwide: "Popular Worldwide",
    emptyStateCta: "COME ON LET'S MAKE AN EVENT ALREADY",
    createAnEvent: "Create an Event",
    featuredEvents: "Featured Events",
    topEventsYouMightLike: "Top events you might like",
    // HomeHero
    heroTitle: "Go do",
    heroTitleAccent: "Something",
    // Claims no coverage and attributes nothing to organisers: COMMUNITY
    // listings are ownerless by design, so "listed by the people running them"
    // was false for exactly the rows we seed the calendar with.
    heroSubtitle:
      "Shows, open mics and weekly nights around Nashville. Anyone can add one; the place can claim it.",
    // Kicker count — rendered ONLY when the count is real and > 0 ("no number,
    // no band"), so there is no zero branch.
    heroKickerCount:
      "{count, plural, one {# event this week} other {# events this week}}",
    heroKickerCountCapped: "{count}+ events this week",
    heroKickerVenues: "{count, plural, one {# place} other {# places}}",
    heroBrowseLabel: "Browse by",
    heroChipHouseShows: "House shows",
    heroLocationNearYou: "Near You",
    heroLocationEverywhere: "Everywhere",
    heroCta: "Browse Events",
    heroCtaSecondary: "Create Event",
    heroShowOverlay: "Show info",
    // S1 hero rail (Split Hero + Rail). The stat label branches on whether the
    // count is geo-scoped: "4 events near you" and "4 events" are different
    // claims, so the label must say which one it is.
    heroRailLabel: "Event highlights",
    heroStatEvents: "Events this week",
    heroStatEventsNearYou: "Events near you this week",
    // Deliberately NOT "Trending" — nothing ranks these rows by any trend or
    // popularity signal, so that label would invent a metric. See HomeHero.tsx.
    heroWhatsOn: "What's on",
    heroStatTickets: "Instant Tickets",
    heroStatFast: "Fast Checkout",
    heroStatCommunity: "Community",
    // HeroEventMap time-window chips
    mapTimeWeek: "This Week",
    mapTimeMonth: "This Month",
    mapTime6Months: "6+ Months",
    mapNearby: "Nearby",
    mapEvents: "Events",
    mapEnterAddress: "Enter a city or address\u2026",
    mapLoading: "Loading map\u2026",
    mapUnavailable: "Map unavailable",
    // Popup qualifier under obscured-event blobs so they never read as a
    // precise venue pin.
    mapApproximateArea: "Approximate area",
  },
  search: {
    activeFilters: "{count, plural, one {# active} other {# active}}",
    allCategories: "All categories",
    clearFilters: "Clear filters",
    clearSearch: "Clear search",
    dateFrom: "From",
    dateRange: "Date range",
    dateTo: "To",
    filters: "Filters",
    free: "Free",
    freePlus: "Free+",
    freeOnly: "Free only",
    fromPrice: "From {price}",
    locationFilter: "Location",
    sort: "Sort",
    searchEvents: "Search events",
    findExperiences: "Find experiences by artist, place, or city.",
    searchPlaceholder: "Search events...",
    searchEventsArtistsVenues: "Search events, artists, places...",
    minCharsHint: "Enter at least two characters to search.",
    searchOrLocationHint:
      "Enter a search term first. Then add a location to narrow results.",
    searchingFor: 'Searching for "{query}"',
    noEventsMatch:
      'No events match "{query}". Try another artist, place, or city.',
    showingNResults:
      "Showing {count} {count, plural, one {result} other {results}}",
    loadingEvents: "Loading events",
    noEventsInCategory: "No events found in this category yet.",
    noMatches: "No matches",
    noMatchesHint: "Try a different artist, place, or organizer.",
    searchButton: "Search",
    searchEventsLabel: "Search events",
    placeholderAll: "Search events, people, places…",
    placeholderAllLabel: "Search events, people, and places",
    placeholderEvents: "Search events…",
    placeholderEventsLabel: "Search events",
    placeholderPeople: "Search people…",
    placeholderPeopleLabel: "Search people",
    placeholderGroups: "Search groups…",
    placeholderGroupsLabel: "Search groups",
    placeholderPlaces: "Search places…",
    placeholderPlacesLabel: "Search places",
    placeholderVenues: "Search places…",
    placeholderCycleLabel: "Search events, places, and people",
    removeCategoryFilter: "Remove {category} filter",
    badgePassword: "Password",
    badgeApplication: "Application",
    viewDetailsFor: "View details for {title}",
    categoryTitle: "{name} Events",
    categoryInCityTitle: "{category} in {city}",
    categoryInCityIntro:
      "{count} upcoming {category} {count, plural, one {event} other {events}} in {city}. Browse dates, places, and how to attend below.",
    noEventsInCategoryCity: "No upcoming {category} in {city} yet.",
    previous: "Previous",
    next: "Next",
    pageOf: "Page {page} of {total}",
    nearMe: "Near me",
    nearMeActive: "Searching within {radius} km",
    nearPlace: "Near {place}",
    addLocation: "Add location filter",
    clearLocation: "Clear",
    categoryUnavailableAll:
      "That category is no longer available, so it was removed from your search.",
    categoryUnavailableSome: "A category in this link is no longer available.",
    useMyLocation: "Use my location",
    myLocation: "My location",
    selectedLocation: "Selected location",
    locationPlaceholder: "City, address, or place...",
    or: "or",
    radius: "Radius",
    nationwide: "Nationwide",
    worldwide: "Worldwide",
    locationUnavailable:
      "Location unavailable. Please allow location access in your browser.",
    locating: "Getting your location...",
    mapLabel: "Search results map",
    mapLayersLabel: "Show on map",
    mapLayerEvents: "Events",
    mapLayerVenues: "Places",
    mapVenuesPrivate:
      "{count, plural, one {# place keeps its location private and isn\u2019t on the map.} other {# places keep their location private and aren\u2019t on the map.}}",
    mapApproxArea: "Approximate area",
    mapKickerEvent: "Event",
    mapKickerVenue: "Place",
    mapViewEvent: "View event",
    mapViewVenue: "View place",
  },
  saves: {
    save: "Save",
    saved: "Saved",
    saveEvent: "Save event",
    removeFromSaved: "Remove from saved",
    navSaved: "Saved",
    title: "Saved Events",
    subtitle: "Your private watchlist",
    upcoming: "Upcoming",
    past: "Past",
    emptyTitle: "Nothing saved yet",
    emptyUpcomingDescription:
      "Tap the heart on any event to keep it here for later.",
    emptyPastDescription: "Saved events that have already happened land here.",
    discoverEvents: "Discover events",
    loadMore: "Load more",
    cancelledBadge: "Cancelled",
    viewEvent: "View event",
    venueTba: "Place TBA",
    signedOutTitle: "Save events for later",
    signedOutDescription:
      "Sign in to keep a private watchlist of events you don't want to lose.",
    signIn: "Sign in",
    unableToLoad: "Unable to load saved events",
    tryAgain: "Try Again",
    homeStripTitle: "Your saved events",
  },
  myTickets: {
    title: "My Tickets",
    loadingTickets: "Loading your tickets...",
    unableToLoad: "Unable to load tickets",
    tryAgain: "Try Again",
    noTicketsYet: "No tickets yet",
    noTicketsDescription:
      "When you purchase tickets to events, they'll appear here.",
    browseEvents: "Browse Events",
    nOrders: "{count, plural, one {# order} other {# orders}}",
    nTickets: "{count, plural, one {# ticket} other {# tickets}}",
    upcoming: "Upcoming",
    past: "Past",
    viewTickets: "View Tickets",
    viewEvent: "View Event",
    rateShow: "Rate this show",
    confirmed: "Confirmed",
    pending: "Pending",
    // An order whose bank debit has not cleared (status PROCESSING): not
    // paid yet, and it can still fail.
    paymentProcessing: "Payment processing",
    partialRefund: "Partial Refund",
    refunded: "Refunded",
    disputed: "Disputed",
    cancelled: "Cancelled",
    atTime: "at {time}",
    tbd: "TBD",
  },
  // The `/my-tickets` page after the /saved merge (2026-08-31). Ticket-specific
  // strings stay in `myTickets` above — this block is only what the merged
  // page adds: its title, the two section labels, and the copy that had to
  // change because an empty section is no longer an empty page.
  myEvents: {
    title: "My events",
    tabsLabel: "Upcoming or past",
    sectionTickets: "Tickets",
    sectionSaved: "Saved",
    // The watchlist is paginated and has no count endpoint, so an unexhausted
    // list says "20+" rather than claiming a total it cannot know.
    nSaved: "{count, plural, one {# saved} other {# saved}}",
    nSavedMore: "{count}+ saved",
    unableToLoad: "Unable to load your events",
    emptyUpcomingTitle: "Nothing coming up",
    emptyUpcomingDescription:
      "Tickets you buy and events you save will show up here.",
    emptyPastTitle: "Nothing here yet",
    emptyPastDescription:
      "Events you've been to, and saved events that have already happened, land here.",
    seePast: "See past",
  },
  myVolunteering: {
    title: "My Volunteering",
    // "Active" = confirmed + standing + awaiting review. History is excluded:
    // a rejected application was never a commitment.
    countLine:
      "{count, plural, one {# active commitment} other {# active commitments}}",

    // Sections — index numbers are assigned at render, not here.
    sectionNextUp: "Next up",
    sectionConfirmed: "Confirmed",
    sectionAwaiting: "Awaiting confirmation",
    sectionHistory: "History",

    // Row detail
    windowless: "No set shift time",
    appliedOn: "Applied {date}",
    hoursRecorded:
      "{hours, plural, one {# hour logged} other {# hours logged}}",
    // Row note when the ask's owner is withheld (`signupsPaused`). Never
    // names a ban or any reason.
    signupsPausedTitle: "Shift sign-ups are paused",
    signupsPausedBody:
      "The organiser can't take new volunteers right now. Shifts you already claimed still stand.",
    smsToggleLabelAsk: "Text me reminders before it starts",

    // Totals band. The figure renders as a separate numeral above each label,
    // so `count` drives agreement only — the label never prints the number.
    totalsLabelHours:
      "{count, plural, one {Hour this year} other {Hours this year}}",
    totalsLabelShifts:
      "{count, plural, one {Shift this year} other {Shifts this year}}",
    totalsHint: "Counted from shifts you were checked in for.",
    // Entry point to `/my-volunteering/hours/print`. Gated on having any
    // checked-in shift at all, NOT on the year's figures above it — the
    // printed document covers full history.
    printStatementAction: "Print hours statement",
    // The volunteer's OWN check-in code. "My check-in code", never "badge":
    // badges are venue-issued credential stock and this is not one.
    printQrAction: "Print my check-in code",

    // States
    emptyTitle: "No volunteer commitments yet",
    emptyDescription:
      "When you sign up to help at an event, your shifts and applications show up here.",
    emptyCta: "Browse Events",
    unableToLoad: "Unable to load your volunteering",
    tryAgain: "Try Again",
  },
  // `/my-lineups` (owner ruling "option A", 2026-09-30): every event lineup
  // the signed-in person is on, and the one action they have — taking
  // themselves off. The event's editors are told when they do.
  myLineups: {
    navLabel: "My lineups",
    title: "My lineups",
    subtitle:
      "Events where an organiser has put your name on the lineup. Take yourself off any you shouldn't be on.",
    draftBadge: "Not public yet",
    cancelledBadge: "Cancelled",
    endedBadge: "Ended",
    // The organiser (org or owner) — NOT who added you; the notice names that.
    roleWithOrganiser: "{role} · {organiser}",
    viewEvent: "View event",
    // Accessible name — several cards each carry a "View event" link.
    viewEventLabel: "View event: {title}",
    removeMe: "Remove me",
    // Accessible name — several cards each carry a "Remove me" button.
    removeMeLabel: "Remove me from the lineup for {title}",
    // The confirm says only what the server does: editors are told on leave,
    // except on an ownerless community listing, where nobody is.
    confirmText:
      "Take yourself off this lineup? {organiser} will be told. They can add you again later.",
    confirmTextNoOrganiser:
      "Take yourself off this lineup? The organiser will be told. They can add you again later.",
    confirmTextNobodyTold:
      "Take yourself off this lineup? You can be added again later.",
    // Only when the person HAS a volunteer signup — the server withdraws it.
    confirmTextVolunteer:
      "Take yourself off this lineup? Your volunteer signup will be withdrawn too. {organiser} will be told.",
    confirmTextVolunteerNoOrganiser:
      "Take yourself off this lineup? Your volunteer signup will be withdrawn too. The organiser will be told.",
    confirmTextVolunteerNobodyTold:
      "Take yourself off this lineup? Your volunteer signup will be withdrawn too. You can be added again later.",
    // Appended to any confirm above when leaving also passes the person's act
    // on the booking this upcoming show came from (final on that booking).
    confirmBookingNote:
      "Your spot on the booking for this show is given up too — you can't rejoin that booking.",
    // Page-local role name (es wants a different word than the builder's).
    roleVolunteer: "Volunteer",
    // A background refresh failed while the list is already on screen.
    refreshFailed: "Couldn't refresh your lineups.",
    confirmRemove: "Remove me",
    removing: "Removing…",
    keepMeOn: "Keep me on",
    removed: "You're off the lineup for {title}",
    removeFailed: "Couldn't take you off this lineup",
    emptyTitle: "You're not on any lineups",
    emptyDescription:
      "When an organiser adds you to an event's lineup, it shows up here.",
    signedOutTitle: "See where your name is listed",
    signedOutDescription:
      "Sign in to see the events you've been added to. Only you can see this list.",
    signIn: "Sign in",
    unableToLoad: "Unable to load your lineups",
    tryAgain: "Try again",
    loadMore: "Load more",
  },
  transfer: {
    enterFullEmail: "Enter a complete email address",
    searchError: "Couldn't search right now. Please try again.",
    tryFullEmail: "Try the full email address",
    loadingOrder: "Loading order\u2026",
    orderNotFound: "Order not found",
    backToMyTickets: "Back to My Tickets",
    theRecipient: "the recipient",
    backToOrder: "\u2190 Back to Order",
    invitationSent: "Transfer Invitation Sent",
    ticketTransferred: "Ticket Transferred",
    invitationSentDesc:
      "An invitation has been sent to {recipient}. They\u2019ll need to create an account and accept the transfer.",
    transferredDesc: "Your ticket has been sent to {recipient}.",
    backToMyOrder: "Back to My Order",
    transferATicket: "Transfer a Ticket",
    sendTicketFrom: "Send a ticket from your",
    orderToAnotherUser: "order to another user, or invite someone by email.",
    step1SelectTicket: "Select a ticket",
    chooseWhichTicket: "Choose which ticket to transfer.",
    loadingTickets: "Loading tickets\u2026",
    noTransferableTickets: "No transferable tickets available.",
    noTransferableTicketsHint:
      "Tickets that have been used, refunded, or listed for resale cannot be transferred.",
    statusValid: "Valid",
    statusUsed: "Used",
    statusInvalid: "Invalid",
    statusRefunded: "Refunded",
    statusListed: "Listed for Resale",
    step2FindRecipient: "Find recipient",
    searchByEmailHint: "Search by email, username, or name.",
    willBeInvited: "Will be invited to create an account",
    change: "Change",
    searchPlaceholder: "Email, @username, or name\u2026",
    searching: "Searching\u2026",
    noUsersFound: 'No users found matching "{query}".',
    sendTo: "Send to {email}",
    inviteToClaimTicket: "They\u2019ll get an invite to claim the ticket",
    step3Confirm: "Confirm transfer",
    confirmEmailHint:
      "An invitation will be sent. The ticket remains yours until the recipient accepts.",
    confirmDirectHint:
      "This action cannot be undone. The recipient will own this ticket.",
    ticket: "Ticket",
    recipient: "Recipient",
    method: "Method",
    emailInvitation: "Email invitation",
    reviewInvitation: "Review Invitation",
    reviewTransfer: "Review Transfer",
    emailConfirmWarning:
      "The recipient will receive an email with a link to claim this ticket.",
    directConfirmWarning:
      "Are you sure? This ticket will be permanently transferred.",
    sending: "Sending\u2026",
    sendInvitation: "Send Invitation",
    confirmTransfer: "Confirm Transfer",
    eventEndedTitle: "This event has ended",
    eventEndedDesc: "Tickets can't be transferred once an event is over.",
  },
  // ── Standard profile templates (HUMAN / ORG "standard" layouts) ─────────
  profileStd: {
    artistLabel: "Artist",
    bandLabel: "Band",
    collectiveLabel: "Collective",
    promoterLabel: "Promoter",
    share: "Share",
    upcomingShows: "Upcoming shows",
    followShowsPrompt:
      "No shows on the calendar right now — follow to get alerts when new shows are announced.",
    followEventsPrompt:
      "No events on the calendar right now — follow to hear about upcoming events.",
    connectAndBooking: "Connect & booking",
    bookingCta: "Booking",
    bookingCtaAria: "Jump to booking details",
    requestToBookCta: "Request to book",
  },
  // ── Entity-page Membership tab (/p/[slug]?tab=memberships) ───────────────
  entityMemberships: {
    tabsLabel: "Page sections",
    tabOverview: "Overview",
    tabMembership: "Membership",
    kicker: "Support",
    title: "Membership",
    subtitle: "Back {name} directly with a recurring membership.",
    perMonth: "per month",
    perYear: "per year",
    taxNote: "Plus applicable sales tax",
    join: "Join",
    joinAria: "Join {tier}",
    joining: "Joining…",
    confirmJoin: "Confirm",
    cancelJoin: "Cancel",
    postalLabel: "Billing ZIP code",
    usOnlyNote:
      "Available for US billing addresses only for now. Sales tax is based on your billing ZIP.",
    errorPostalRequired: "Enter your billing ZIP code.",
    errorRegionUnsupported: "Memberships aren't available in your region yet.",
    errorTaxUnavailable:
      "We couldn't set this up just now. Nothing was charged — please try again shortly.",
    errorSuspended:
      "This membership program isn't accepting new members right now.",
    errorTierClosed: "This tier isn't open to new members right now.",
    errorGeneric: "Something went wrong. Please try again.",
    errorPortal: "We couldn't open the billing portal. Please try again.",
    memberBadge: "Member",
    renewsOn: "Renews {date}",
    endsOn: "Ends {date}",
    manageMembership: "Manage membership",
    memberContentEmpty: "Member updates from {name} will appear here.",
    joinSuccessActive: "Your membership is active. Thanks for the support!",
    joinSuccessIncomplete:
      "Almost done — finish setting up payment to activate your membership.",
    joinSuccessProcessing:
      "Payment received — we're activating your membership. This usually takes a few seconds.",
    finishPayment: "Finish payment",
    paymentPrompt: "Enter your payment details to start your membership.",
    payNow: "Start membership",
    processingPayment: "Processing…",
    paymentFinishLater: "Finish later",
    errorPayment:
      "Your payment didn't go through. You haven't been charged — please try again.",
  },
  // ── Ticket embed widget (/embed/[embedId]) ──────────────────────────────
  // Copy owned by the embed MOUNTS. The widget runs on a partner's page, so a
  // Spanish viewer must not read English there (NFR-002).
  embed: {
    // The endpoint only serves upcoming-or-ongoing events, so an empty window
    // may still have HAD events — "no events scheduled" would be wrong.
    calendarEmptyWeek: "No upcoming events this week",
    calendarEmptyMonth: "No upcoming events in {month} {year}",
    // A gated event's detail (owner ruling 2026-10-12): the widget cannot
    // unlock it, so it says so and opens the event on Ithas Fire in a new tab.
    gatedApplicationBody:
      "Getting a ticket to this event starts with an application on Ithas Fire.",
    gatedPasswordBody:
      "Tickets to this event are behind a password on Ithas Fire.",
    gatedApplyCta: "Apply on Ithas Fire",
    gatedPasswordCta: "Enter the password on Ithas Fire",
    gatedOpensInNewTab: "Opens Ithas Fire in a new tab.",
    gatedCtaAria: "{label} (opens in a new tab)",
  },
  // ── Membership embed widget (/embed/memberships/[embedId]) ───────────────
  embedMemberships: {
    kicker: "Membership",
    perMonth: "per month",
    perYear: "per year",
    taxNote: "Plus applicable sales tax",
    join: "Join",
    joinAria: "Join {tier} on Ithas Fire (opens in a new tab)",
    emptyTitle: "Memberships aren't open right now",
    emptyBody: "Check back soon — {name} isn't accepting new members yet.",
  },
  // ── booking_info block (shared by PLACE venue + HUMAN artist pages) ──────
  booking: {
    pickerHint:
      "Pick up to three nights in order of preference. Times are the place's local time.",
    pickerPrompt: "Pick a night to see when the room is free.",
    // `mode="date"` (RENT / USE): the requester types their own window, so
    // the rail shows context, not slots to choose from.
    pickerPromptDate: "Pick a day to see the place's hours and what's booked.",
    pickerTrayEmptyDate: "No day picked yet.",
    pickerCalendarLabel: "Choose a night",
    pickerPrevMonth: "Previous month",
    pickerNextMonth: "Next month",
    pickerAlreadyBooked: "Already booked",
    pickerUnavailableDate: "The place has closed this date.",
    pickerAlternatives: "Nearest nights with room",
    pickerFirstChoice: "first choice",
    pickerMoveUp: "Move this night up your list",
    pickerMoveUpShort: "Move up",
    pickerTrayEmpty: "Nothing picked yet — up to {max} nights, best first.",
    pickerUnavailable:
      "Couldn't load this place's availability. Enter dates directly instead.",
    pickerLegendFree: "Free",
    pickerLegendPartial: "Part booked",
    pickerLegendUnavailable: "Unavailable",
    pickerLegendYours: "Your pick",
    pickerPart_afternoon: "Afternoon",
    pickerPart_evening: "Evening",
    pickerPart_late: "Late",
    pickerStatus_free: "available",
    pickerStatus_partial: "part booked",
    pickerStatus_full: "no room left",
    pickerStatus_blackout: "place unavailable",
    pickerStatus_closed: "closed",
    pickerStatus_past: "past",

    // Request conversation (booking-conversation FR-001..003 /
    // venue-hierarchy FR-012) — the request IS the thread.
    threadHeading: "Conversation",
    threadUnread: "{count} unread",
    // Accessible name for the compact unread chip on LIST rows. The visible
    // label is `threadUnread` ("3 unread") beside a message icon, which reads
    // fine with the icon but announces as a bare fragment — so the chip is
    // `role="img"` + this full sentence. Pluralised: "1 unread messages" is
    // the exact wrongness a screen-reader user would hear on every quiet-ish
    // row.
    threadUnreadA11y:
      "{count, plural, one {# unread message} other {# unread messages}}",
    threadEmpty: "No messages yet. Say hello and propose a date.",
    threadPlaceholder: "Write a message…",
    threadComposerLabel: "Message",
    threadSend: "Send",
    threadYou: "You",
    threadPerformer: "Performer",
    threadVenue: "Place",
    threadAttachments: "Attachments",
    threadRetry: "Retry",
    threadRefresh: "Refresh conversation",

    // ── Venue confirmation, in the thread ─────────────────────────────────
    // The venue's vouch for the booking's event, decided next to the
    // conversation (`VenueConfirmationActions`, venue-confirmation spec
    // docs/specs/2026-08-27 "Thread"). "Confirmed", never "verified" or
    // "approved". The state lines sit beside one secondary button; the
    // dialogs own the rest.
    vcKicker: "Place confirmation",
    vcStateNone: "Confirming creates the event and puts the place's name on it.",
    vcStateUnconfirmed:
      "Not confirmed yet. The event shows its address only until you confirm.",
    vcStateWithdrawn: "Confirmation withdrawn. You can confirm again.",
    vcStateConfirmed: "Confirmed by the place.",
    vcConfirmCta: "Confirm",
    vcWithdrawCta: "Withdraw confirmation",
    vcConfirmTitle: "Confirm this event",
    vcConfirmNote:
      "The event carries the place's name and blocks the date on your calendar.",
    // Only asked when confirming MINTS the event; an existing event keeps its
    // owner. Default by intent: PERFORM → venue, RENT / USE → they own it.
    vcOwnerLegend: "Who owns the event",
    vcOwnerVenue: "Place owns it",
    vcOwnerVenueDesc: "It lives in your admin. You sell the tickets and run the night.",
    vcOwnerRequester: "They own it",
    vcOwnerRequesterDesc:
      "A draft lands in their admin. They finish the details and publish.",
    vcConfirming: "Confirming…",
    /** Confirm dialog, withheld-address venue, minting a VENUE-owned event: the event's reveal setting decides. */
    vcConfirmSharesAddressOwnEvent:
      "This event will be your place's own. Its ticket holders see your address when its Address reveal setting says: a day before it starts, unless you change it in the event builder.",
    vcWithdrawTitle: "Withdraw confirmation",
    vcWithdrawReasonLabel: "Reason",
    vcWithdrawReasonHelp:
      "The organizer is told why. The event keeps its address, drops the place's name and stops blocking the date.",
    vcWithdrawReasonRequired: "Give the organizer a reason.",
    vcWithdrawSubmit: "Withdraw",
    vcWithdrawing: "Withdrawing…",
    vcToastConfirmed: "Confirmed by the place",
    vcToastWithdrawn: "Confirmation withdrawn",
    vcConfirmBlocked: "Can't confirm yet",
    vcActionFailed: "Couldn't update the confirmation",

    // ── Terms strip ───────────────────────────────────────────────────────
    // The agreement's binding header, shown inside the conversation about it
    // (`BookingTermsStrip`). Reference copy, not instructions: the strip's job
    // is to put the date on file next to the date being discussed and let the
    // reader do the comparing.
    termsHeading: "Terms on file",
    // Same strip once the agreement can no longer change — declined,
    // cancelled, expired, disputed, or fulfilled. Past tense, because "on
    // file" would still promise these are what binds.
    termsHeadingEnded: "Terms on record",
    termsEndedNote: "This agreement is no longer in effect.",
    // Verb first: this is the route to the one page where terms change.
    termsChange: "Change terms",
    // Shown when at least one live value still carries the `From request`
    // marker, i.e. the accept seeded it from the act's pitch and nobody has
    // chosen it since. The exact condition behind a show booked on a night
    // both parties had ruled out in writing.
    termsPitchNote:
      "Marked values are still the act's original ask. Nobody has chosen them yet.",
    termsUnavailable: "Terms could not be loaded.",

    // ── Ledger entries ────────────────────────────────────────────────────
    // The thread is the booking's timeline: every lifecycle transition writes
    // a SYSTEM row, and the sentence for it lives here (the row stores a kind
    // plus params, never prose). Log voice — past tense, one short clause, no
    // trailing full stop, and NO PERSON NAMED: the row carries an actor id and
    // the messages list projects no display name, so "who" is at most a SIDE
    // and rides `entryActor*` on the meta line, where it can be dropped
    // entirely when the row does not say.
    entryOpenAgreement: "View agreement",
    entryOpenEvent: "View event",
    entryActorVenue: "by the place",
    entryActorPerformer: "by the performer",
    entryReason: "Reason: {reason}",

    entryRequestOpenedToVenue: "Request sent to the place",
    entryRequestOpenedToVenueEmbed:
      "Request sent through the place's booking form",
    entryRequestOpenedToPerformer: "Offer sent to the performer",
    entryRequestOpenedToPerformerEmbed: "Offer sent through a booking form",
    // Direction-free fallback for a row whose `direction` param is missing or
    // unreadable. The four lines above each NAME a party; this one deliberately
    // does not, because the row no longer says which.
    entryRequestOpened: "Request sent",
    entryRequestViewed: "Request viewed",
    entryRequestExpired: "Request expired — the reply deadline was {date}",
    entryRequestExpiredNoDate: "Request expired",
    entryRequestWithdrawn: "Request withdrawn",
    entryRequestAccepted: "Request accepted",
    entryRequestDeclined: "Request declined",

    entryAgreementDrafted: "Draft agreement created",
    entryAgreementSentForReview: "Agreement sent for review",
    entryAgreementCountered: "Agreement countered",
    entryAgreementAccepted: "Agreement accepted",
    entryAgreementDeclined: "Agreement declined",
    entryAgreementCancelled: "Agreement cancelled",
    entryAgreementPulledBack: "Agreement pulled back from review",
    entryAgreementReopened: "Agreement reopened",
    entryAgreementFinalized: "Agreement finalized",
    entryAgreementFulfilled: "Agreement fulfilled — the show happened",

    entryEventCreated: "Event created for {date}",
    entryEventCreatedNoDate: "Event created",
    entryEventModified: "Event updated — {fields}",
    entryEventModifiedGeneric: "Event updated",
    entryEventMoved: "Moved from {from} to {to}",
    entryEventPublished: "Event published for {date}",
    entryEventPublishedNoDate: "Event published",
    entryEventCancelled: "Event cancelled",
    entryEventCompleted: "Event completed",
    entryEventVenueConfirmed: "Place confirmed the event",
    entryEventVenueConfirmationWithdrawn: "Place withdrew its confirmation",
    // Lowercase: these are joined into the sentence above, not used as labels.
    entryEventFieldTitle: "title",
    entryEventFieldStartsAt: "start time",
    entryEventFieldEndsAt: "end time",
    entryEventFieldLocation: "location",
    entryEventFieldCalendar: "calendar",
    entryEventFieldSpace: "space",
    entryEventFieldTimezone: "time zone",

    // Holds (booking-holds FR-012). Date + place in line only — the act reads
    // this ledger too and must never learn who else is in the line.
    entryHoldPlaced: "Hold placed for {date} — {position} in line",
    entryHoldPlacedNoPosition: "Hold placed for {date}",
    entryHoldPlacedNoDate: "Hold placed",
    entryHoldReordered: "Hold moved from {from} to {to} in line",
    entryHoldReorderedGeneric: "Hold moved in line",
    entryHoldChallenged: "Hold challenged — keep or release by {date}",
    entryHoldChallengedNoDate: "Hold challenged",
    entryHoldExtended: "Challenge deadline extended to {date}",
    entryHoldExtendedNoDate: "Challenge deadline extended",
    entryHoldKept: "Hold kept",
    entryHoldReleased: "Hold released",
    entryHoldReleasedManual: "Released by the place",
    entryHoldReleasedManualByAct: "Released by the act",
    entryHoldReleasedExpired: "The challenge deadline passed",
    entryHoldReleasedConfirmedOther: "The date went to another act",
    entryHoldReleasedRequestClosed: "The request was closed",
    entryHoldReleasedSiblingConfirmed:
      "Another date on this request was confirmed",
    entryHoldReleasedPastDate: "The date passed",
    entryHoldReleasedEventScheduled: "An event was scheduled on that date",
    entryHoldConfirmed: "Hold confirmed — draft event created",
    // Ordinals ("1st", "21st") come from `admin.bkHoldPosition*` via
    // `holdPositionKey` — one catalog for every hold surface.
    // The same hold entries read from the ACT's side (FR-013): its own place,
    // its own clock, its own answer. Picked by `viewerSide` in
    // describeBookingSystemEntry; every key above with a hold sentence has a
    // twin here with identical {args}.
    entryHoldPlacedAct: "You're {position} in line for {date}",
    entryHoldPlacedNoPositionAct: "The place put a hold on {date} for you",
    entryHoldPlacedNoDateAct: "The place is holding a date for you",
    entryHoldReorderedAct: "Your spot in line moved from {from} to {to}",
    entryHoldReorderedGenericAct: "Your spot in line moved",
    entryHoldChallengedAct:
      "The place asked you to keep or release your hold by {date}",
    entryHoldChallengedNoDateAct:
      "The place asked you to keep or release your hold",
    entryHoldExtendedAct: "The place extended your reply deadline to {date}",
    entryHoldExtendedNoDateAct: "The place extended your reply deadline",
    entryHoldKeptAct: "You kept your hold",
    entryHoldReleasedAct: "Your hold was released",
    entryHoldReleasedByYouAct: "You released your hold",
    entryHoldReleasedByVenueAct: "The place released your hold",
    entryHoldReleasedEventScheduledAct:
      "The place scheduled an event on that date, so your hold was released — your request is still open",
    entryHoldConfirmedAct:
      "Your hold was confirmed — the place is creating the event",

    // ── The act's holds panel (FR-013) ────────────────────────────────────
    // What the act sees of a line: its own date and place, never the rest.
    actHoldsHeading: "Your holds",
    actHoldLine: "{date} — {position} hold",
    actHoldKeepOrReleaseBy: "Keep or release by {date}",
    actHoldLapsedLine: "Released — the reply deadline passed",
    actHoldKeep: "Keep",
    actHoldRelease: "Release",
    actHoldReleaseConfirmTitle: "Release your hold?",
    actHoldReleaseConfirmBody:
      "You give up your spot in line for {date}. The place is notified, and you can still message them here.",
    actHoldKeptToast: "You kept your hold",
    actHoldReleasedToast: "You released your hold",
    actHoldChanged: "That hold changed under you. The list has been refreshed.",
    actHoldAnswerFailed: "Couldn't answer the place",
    // P5-fixes (holds/keep/confirm) — Keep = commit (FR-014): the panel says
    // what Keep will do before the act taps it.
    actHoldKeepAndBook: "Keep — agree & book",
    actHoldKeepWillBook: "Keeping agrees these terms and books the night.",
    actHoldKeepWillAsk:
      "Keeping asks the place to send terms. You keep the night by agreeing them, with at least 48 hours to do it.",
    actHoldKeptAwaiting:
      "You kept this hold. Agree the terms the place sends by {date} to keep the night.",
    actHoldKeptAwaitingNoDate:
      "You kept this hold. Agree the terms the place sends to keep the night.",
    actHoldTermsAgreedLine:
      "Your terms for this night are agreed. The place books it from here.",
    actHoldKeepChecking: "Checking what Keep will do…",
    actHoldKeepUnknown: "We couldn't check what Keep will do, so it's paused.",
    actHoldKeepRecheck: "Check again",
    // Date-qualified accessible names: two challenged holds otherwise give
    // two buttons with the same name (same shape as bkHoldReleaseAction).
    actHoldKeepAndBookAction: "Keep — agree & book: {date}",
    actHoldKeepAction: "Keep: {date}",
    actHoldReleaseAction: "Release: {date}",
    actHoldKeepRecheckAction: "Check again: {date}",
    actHoldKeepChanged:
      "What Keep does changed since you looked. Read the new choice before you answer.",
    actHoldKeptBookedToast: "Kept — the night is booked",
    actHoldKeptAskedToast: "Kept — the place has been asked for terms",
    // end P5-fixes (holds/keep/confirm)
    // Assignment (FR-015). Venue-internal; names nobody.
    entryRequestAssigned: "Request assigned",
    entryRequestUnassigned: "Request unassigned",
    // Parked at an unclaimed venue (venue-confirmation spec 2026-08-27).
    entryRequestParkedUnclaimed: "Waiting for the place's owner to claim its page",
    entryRequestUnparked:
      "The place's owner claimed its page — your request is on its way",
    // ── P3a (unclaimed venues) ── a request parked before the 2026-09-25
    // amendment, expired by the cleanup. {place} is a name snapshot.
    entryRequestExpiredUnclaimed:
      "{place} isn't on Ithas Fire yet, so this request can't reach them.",
    entryRequestExpiredUnclaimedNoName:
      "This place isn't on Ithas Fire yet, so this request can't reach them.",
    // A tagged artist answered their spot on the bill (lineup v2 FR-003).
    entryRequestActConfirmed: "{actName} confirmed their spot on the bill",
    entryRequestActDeclined: "{actName} declined their spot on the bill",
  },
  bookingInfo: {
    heading: "Booking",
    emailLabel: "Email",
    phoneLabel: "Phone",
    bookVenueCta: "Book this place",
    bookArtistCta: "Booking enquiry",
  },
  // Public venue_stats block: aggregates reported anonymously by performers
  // (booking-review-data-weave FR-005/FR-007). Neutral, factual copy only.
  venueStats: {
    heading: "What performers report",
    // The tier stamp. A bare noun, not a sentence: it is the first thing in
    // the block and its twin in `audienceStats.tier` is the first thing in the
    // other, which is what makes the two read as one system.
    tier: "Performers",
    reportedBy: "Reported by {count} performers",
    // Names its own side. A reader comparing this percentage with the
    // attendee one must never have to work out which is which.
    wouldPlayAgain: "Performers would play again",
    medianPayout: "Median payout",
    payoutRange: "Typically {min}–{max}",
    scoreOutOf: "{score} / 5",
    scoreSound: "Sound",
    scoreStageEquipment: "Backline & stage gear",
    scoreParking: "Parking & load-in",
    scoreBooker: "Booker communication",
    scoreStaffSupport: "Staff support",
    scorePromotion: "Place promotion",
    methodMix: "How gigs here pay: {list}",
    methodGuarantee: "guarantee",
    methodDoorSplit: "door split",
    methodTicketSales: "ticket sales",
    methodBarPercentage: "bar percentage",
    methodTips: "tips",
    methodPayToPlay: "pay to play",
    methodUnpaid: "unpaid",
    methodOther: "other",
    genres: "Genres reported: {list}",
    nights: "Most-reported nights: {list}",
    updatedPeriodically: "Updated periodically",
    asOf: "as of {date}",
  },
  // Public tech_specs block (venue tech-spec sheet — the venue-side rider).
  techSpecs: {
    heading: "Tech specs",
  },
  // Public track_record block — "The door" (venue-track-record-and-review-
  // switch R8/R9). The stamp is a bare noun like `venueStats.tier` /
  // `audienceStats.tier`; the heading carries the sentence. Every figure line
  // is derived server-side; nothing here is owner-editable.
  trackRecord: {
    tier: "The door",
    heading: "What's happened here",
    // The <section>'s accessible name (FR-015): stamp + heading, so a screen
    // reader jumping between regions hears the provenance.
    blockLabel: "The door — {heading}",
    // Ledger terms.
    showsHosted: "Shows hosted",
    firstShow: "First show",
    lastShow: "Last show",
    thisYear: "{count} this year",
    // A quiet year is stated, not left blank (ruled 2026-09-25).
    thisYearNone: "None this year",
    // `years` is a pre-formatted figure ("2½"), so no ICU plural — the two
    // exact cases get their own keys.
    yearsRunningHalf: "½ year running",
    yearsRunningOne: "1 year running",
    yearsRunning: "{years} years running",
    // `since` is a month ("Apr") or month + year when the run crosses a year.
    cadenceWeekly: "Weekly since {since}",
    cadenceFortnightly: "Every other week since {since}",
    cadenceMonthly: "Monthly since {since}",
    cadenceOccasional: "Now and then since {since}",
    playedRecently: "Played here recently",
    allActs: "{count, plural, one {All # act} other {All # acts}}",
    // Screen-reader text behind the "×5" regulars marker.
    timesPlayed: "played {count} times",
    empty: "No shows on the books yet.",
    foot: "Counted from published shows and door scans. Updates itself; the people who run this place can't edit it.",
    footEmpty: "This fills in from published shows. The people who run this place can't edit it.",
  },
  audienceStats: {
    heading: "What attendees say",
    ratedBy: "Rated by {count} verified attendees",
    overall: "Overall",
    wouldRecommend: "Would recommend",
    scoreOutOf: "{score} / 5",
    scoreSound: "Sound",
    scoreVenueComfort: "Comfort & sightlines",
    scoreOrganization: "Organization",
    scoreValue: "Value for money",
    updatedPeriodically: "Updated periodically",
    asOf: "as of {date}",
    communityLabel: "Community",
    communityRatedBy: "{count} community reviews (unverified)",
    communityNote:
      "Community reviews are unverified — they don’t count toward the verified score above.",
  },
  // /p/[slug]/acts — every act that has played a venue (venue-track-record-
  // and-review-switch FR-016, R9 "Roster"). Header line is three separate
  // fragments because the figures between them render bold, and a message
  // cannot carry markup: "<b>38</b> shows · since <b>Mar 2024</b> · last
  // <b>9 days ago</b>". `count` on `headShows` only picks the plural; the
  // number itself is printed by the component.
  actsRoster: {
    // The tier stamp — the same box the venue page's track-record block
    // wears, so the roster reads as that block one level down.
    tier: "The door",
    heading: "Who's played here",
    headShows: "{count, plural, one {show} other {shows}}",
    headSince: "since",
    headLast: "last",
    regulars: "Regulars",
    recently: "Recently",
    // A repeat act's second line. A one-off prints just the date.
    tileMeta: "×{times} · last {date}",
    empty: "Nobody's played here yet.",
    // Shows hosted, but no public lineups yet — the header above has just
    // printed a show count, so "nobody" would contradict it.
    emptyNoLineups: "No lineups on record yet.",
    foot: "Counted from published shows. Updates itself; the people who run this place can't edit it.",
  },
  rateVenue: {
    // The in-page block's CTA. Deliberately NOT `cta` ("Rate this place"):
    // the hero carries that label, and the block's own heading already says
    // "Rate this place", so reusing it put two buttons with an identical
    // accessible name on one page and made the block read as a heading
    // followed by a restatement of itself.
    blockCta: "Leave a review",
    blockHeading: "Rate this place",
    blockIntro:
      "Played here or came to a show? Take a minute to say how it went.",
    cta: "Rate this place",
    modalTitle: "Rate this place",
    choosePrompt: "How did you experience this place?",
    performerChoice: "I performed here",
    performerChoiceHint: "Share what it’s like to play this room.",
    attendeeChoice: "I attended a show",
    attendeeChoiceHint: "Rate the night as a guest.",
    back: "Back",
    verifiedUpsellTitle: "You attended a show here",
    verifiedUpsellBodyOne: "Leave a verified review for {title}.",
    verifiedUpsellBodyMany: "Leave a verified review for a show you attended:",
    verifiedUpsellCta: "Leave a verified review",
    orCommunity: "Or leave a community review",
  },
  places: {
    status: "Status",
    verification: "Verification",
    upcomingEvents: "Upcoming events",
    view: "View",
    noUpcomingEvents: "No upcoming events are published for this place yet.",
    venueLabel: "Place",
    verifiedVenue: "Verified Place",
    verified: "Verified",
    follow: "Follow",
    following: "Following",
    followerCount: "{count, plural, one {# follower} other {# followers}}",
    followComingSoon: "Following places is coming soon",
    getDirections: "Get directions",
    heroRequestToBookCta: "Request to book",
    // The two booking CTAs (venue-confirmation spec): each shows only when
    // some calendar on the place accepts that intent.
    heroPlayHereCta: "Play here",
    heroPlayHereCtaAria: "Play here at {name}",
    heroRentOrUseCta: "Rent or use a space",
    getDirectionsToAria: "Get directions to {name}",
    heroRentOrUseCtaAria: "Rent or use a space at {name}",
    location: "Location",
    editPage: "Edit page",
    browseEvents: "Browse events",
    capacityChip: "Cap. {count}",
    contact: "Contact",
    website: "Website",
    phone: "Phone",
    pastShows: "Past shows at this place",
    followForUpdates: "Follow for updates",
    eventsLoading: "Loading events…",
    eventsError: "Couldn't load events.",
    retry: "Retry",

    // ── Address privacy (place-address-withholding) ─────────────────────
    // A venue can publish an exact address, an approximate circle, or nothing
    // finer than an area name. The copy stays plain on purpose: for a lot of
    // these venues the address is somebody's home, and the page should read
    // like a fact rather than an apology or a tease.
    locationAreaKicker: "Area",
    locationApproxKicker: "Approximate area",
    /** Headline slot when the venue publishes no area name either. */
    locationAreaUnknown: "Not published",
    locationWithheldBody: "This place doesn't publish its address.",
    locationApproxBody:
      "This place doesn't publish its exact address. The circle covers roughly where it is.",
    /**
     * Says where the address DOES come from without promising that it will.
     * A venue-level setting knows nothing about any particular event's reveal
     * schedule, and an event can be set to never reveal at all.
     */
    locationWithheldWhere:
      "Details come from the event you're going to, not from this page.",

    // ── Action-bar overflow actions (share / copy / report) ─────────────
    shareCopiedToast: "Link copied",
    shareCopyFailedToast:
      "Couldn't copy the link — try again or copy it from the address bar.",

    // ── Claim venue (claim-venue-flow spec) ─────────────────────────────
    claimCta: "Claim this place",
    claimSignInNote: "Sign in to claim",
    claimPendingBadge: "Claim pending review",
    claimPendingBody: "A claim on this place is being reviewed by our team.",
    // The former `claimAlreadyClaimedBadge` / `claimAlreadyClaimedBody` /
    // `claimDisputeLink` trio was deleted with the already-claimed badge block:
    // both routes now render the owner row below instead.
    claimLoading: "Loading…",

    // ── Claimed-venue owner row (place-editor-and-entity-page-batch FR-008) ──
    ownerRowLabel: "Owned by",
    /** Fallback when the owner cannot be named publicly (see NFR-003). */
    ownerRowUnnamed: "Verified owner",
    ownerRowRequestTransfer: "Request transfer",
    /**
     * MUST start with the visible `ownerRowRequestTransfer` string — the
     * accessible name has to be a superset of the visible label (WCAG 2.5.3
     * Label in Name) or voice control can't target the button.
     */
    ownerRowRequestTransferAria: "Request transfer — {name}",

    claimWizardTitle: "Claim this place",
    claimStepOwnerTitle: "Who is claiming?",
    claimStepOwnerHint: "Choose who will own this place page.",
    claimOwnerSelf: "Myself",
    claimOwnerOrgHint:
      "You can also claim on behalf of an organization you administer.",

    claimStepProofTitle: "Prove you operate this place",
    claimStepProofHint:
      "Verify with one of the options below. Claims are reviewed by our team before a place is verified.",
    claimProofMethodLabel: "How do you want to verify?",
    claimMethodDomain: "Account email",
    claimMethodChallenge: "Email code",
    claimMethodDocument: "Upload document",

    claimProofDomainTitle: "Use my account email",
    claimProofDomainBody:
      "Your verified account email matches this place’s website domain.",
    claimProofDomainFastTrack: "This verifies your place instantly.",
    claimProofDomainButton: "Verify with my account email",

    claimProofChallengeTitle: "Email a code to the place’s domain",
    claimProofChallengeBody:
      "Enter an email address at the place’s website domain. We’ll send a 6-digit code.",
    claimProofChallengeEmailLabel: "Email at the place’s domain",
    claimProofChallengeSend: "Send code",
    claimProofChallengeSent: "We sent a code to {email}. Enter it below.",
    claimProofChallengeCodeLabel: "6-digit code",
    claimProofChallengeConfirm: "Confirm code",
    claimProofChallengeResend: "Send a new code",

    claimProofDocTitle: "Upload proof documents",
    claimProofDocBody:
      "Upload 1–5 documents (PDF, JPEG, or PNG, up to 10MB each) showing you operate this place.",
    claimProofDocDrop: "Drop files here or browse",
    claimProofDocFormats: "PDF, JPEG, or PNG · up to 10MB each",
    claimProofDocMax: "Maximum files reached",
    claimFilesCount: "{count} of {max} files",
    claimFileRemove: "Remove {fileName}",
    claimFileTooLarge: "{fileName} is larger than 10MB.",
    claimFileUnsupported: "{fileName} isn’t a supported format.",

    claimBack: "Back",
    claimContinue: "Continue",
    claimCancel: "Cancel",
    claimSubmit: "Submit claim",
    claimSubmitting: "Submitting…",
    claimDone: "Done",

    claimRateLimited: "You’ve made a lot of claims. Try again {when}.",
    claimRateLimitedNoTime: "You’ve made a lot of claims. Try again later.",
    claimCodeRateLimited: "You’ve asked for a lot of codes. Try again {when}.",
    claimCodeRateLimitedNoTime:
      "You’ve asked for a lot of codes. Try again later.",
    claimUploadRateLimited: "Too many uploads at once. Try again {when}.",
    claimUploadRateLimitedNoTime: "Too many uploads at once. Try again later.",

    claimSuccessVerifiedTitle: "You now own this place",
    claimSuccessVerifiedBody:
      "Your claim was verified. You can manage this place from your dashboard.",
    claimSuccessPendingTitle: "Claim submitted",
    claimSuccessPendingBody:
      "Your claim is now pending review. We’ll notify you once it’s decided.",

    // ── FR-005: the one community-listing decision, at claim time ──────────
    // Rendered only when listings are actually attached; at zero the question
    // is abstract. The fast-track arm gets the switch (place is VERIFIED
    // already); the pending arm gets the note, because the backend refuses to
    // enable on an unverified place.
    claimCommunityAskTitle: "Accept community listings",
    claimCommunityAskBody:
      "{count, plural, one {# community event already names this place.} other {# community events already name this place.}} Show them on your place page?",
    claimCommunityPending:
      "{count, plural, one {# community event already names this place.} other {# community events already name this place.}} Once your claim is approved you can choose whether to show them on your place page — we\u2019ll ask in your booking settings.",

    claimDisputeTitle: "Dispute this place",
    claimDisputeHint:
      "Tell us why you believe you should own this place. Our team will review it.",
    claimDisputeReasonLabel: "Reason",
    claimDisputeReasonPlaceholder: "Explain why you operate this place…",
    claimDisputeReasonHint: "At least 10 characters.",
    claimDisputeSubmit: "Submit dispute",
    claimDisputeSubmitting: "Submitting…",
    claimDisputeSuccessTitle: "Dispute submitted",
    claimDisputeSuccessBody:
      "Our team will review your dispute and follow up. The current owner has been notified.",
  },
  cart: {
    cartsWaiting:
      "{count, plural, one {# cart waiting} other {# carts waiting}}",
    continueYourPurchase: "Continue your purchase",
    nPendingCarts:
      "{count, plural, one {# pending cart} other {# pending carts}}",
    expiresIn: "Expires in {time}",
    dismiss: "Dismiss",
    dismissAll: "Dismiss all",
    resume: "Resume",
    holdExpired: "Hold expired",
    minimize: "Minimize",
    viewCarts: "View carts",
  },
  orderDetail: {
    addToAppleWallet: "Add to Apple Wallet",
    addToGoogleWallet: "Add to Google Wallet",
    ticketTransferredMessage:
      "This ticket has been transferred to someone else.",
    walletDownloading: "Downloading…",
    walletError: "Couldn't add the pass. Please try again.",
    loadingOrder: "Loading order details...",
    orderNotFound: "Order not found",
    backToMyTickets: "Back to My Tickets",
    orderNumber: "Order #",
    items: "Items",
    totalPaid: "Total Paid",
    subtotal: "Subtotal",
    serviceFee: "Service Fee",
    platformFee: "Platform Fee",
    processingFee: "Processing Fee",
    tax: "Tax",
    creditApplied: "Credit applied",
    merchantOfRecord:
      "Ithas Fire is the merchant of record for this order, sold on behalf of {organiser}.",
    merchantOfRecordNoOrganiser:
      "Ithas Fire is the merchant of record for this order.",
    platformFeeRefunded: "Fully refunded",
    yourTickets: "Your Tickets",
    ticket: "Ticket",
    ticketCode: "Ticket Code",
    ticketWhen: "When",
    ticketWhere: "Where",
    ticketTier: "Tier",
    addToWallet: "Add to wallet",
    appleWallet: "Apple Wallet",
    googleWallet: "Google Wallet",
    ticketActions: "Ticket actions",
    ticketAdmit: "Admit one",
    showQrCode: "Show this QR code at the entrance",
    scanned: "Scanned: {date}",
    refund: "Refund",
    resell: "Resell",
    transfer: "Transfer",
    transferClosedEventEnded: "Transfers close when the event ends.",
    refundAmount: "Refund amount:",
    notEligible: "Not eligible:",
    ineligible: "ineligible",
    confirmRefund: "Confirm Refund",
    cancel: "Cancel",
    couldNotLoadQuote: "Could not load refund quote.",
    retry: "Retry",
    calculatingRefund: "Calculating refund...",
    ticketsPending: "Tickets will be issued once payment is confirmed.",
    noTicketsFound: "No tickets found for this order.",
    ticketsTransferredAway:
      "The tickets on this order now belong to someone else.",
    needFullRefund: "Need a full refund?",
    fullRefundDescription:
      "If you can no longer attend, you may be eligible for a refund. Refunds are subject to the event's refund policy and must be requested before the refund deadline.",
    requestFullRefund: "Request Full Refund",
    needHelp: "Need help?",
    orderSummary: "Order Summary",
    purchaseDate: "Purchased",
    processing: "Processing...",
    helpDescription:
      "If you have questions about your order or tickets, please contact the event organizer or reach out to support.",
    helpContactOrganiser: "Contact the organizer",
    helpOrganiserNote:
      "For anything about the event itself — entry, timing, schedule, or refunds outside the self-serve window.",
    helpContactSupport: "Contact support",
    helpSupportNote:
      "For account or payment problems, or anything not specific to the event.",
    helpChatDesktop:
      "Prefer to chat? Tap the chat bubble in the bottom-right corner to reach us in real time.",
    helpChatMobile:
      "Prefer to chat? Tap the “…” menu in the bottom bar, then Support, to chat with us in real time.",
    dateTbd: "Date TBD",
    valid: "Valid",
    used: "Used",
    invalid: "Invalid",
    listedForResale: "Listed for Resale",
    refundBreakdown: "Refund Breakdown",
    ticketPrice: "Ticket Price",
    stripeProcessingFee: "Payment Processing Fee",
    stripeProcessingFeeNote: "Non-refundable (charged by payment processor)",
    youWillReceive: "You Will Receive",
    printTickets: "Print tickets",
    /**
     * A ticket holder whose event (or venue) hides its address, before the
     * reveal. `never` = the organizer chose never to share it through us.
     * `venueUnconfirmed` = the venue hides its address and hasn't confirmed
     * this event, so it never shares it here. `unavailable` = the venue's
     * record couldn't be read just now (`placeUnavailable`), so the address
     * stays locked until it can be.
     */
    addressLocked: {
      revealOn:
        "The exact address will be shared on {date}. We'll send you a reminder.",
      never: "The organizer isn't sharing this address through Ithas Fire.",
      venueUnconfirmed:
        "The place shares its address with events it has confirmed. Ask the organizer where to go.",
      unavailable:
        "We couldn't load this place's address right now. Check back soon.",
      pending: "The exact address hasn't been shared yet.",
    },
  },
  /**
   * The printable ticket sheet (`/my-tickets/[orderId]/print`).
   * Door-facing copy: short, literal, and legible at 7pt on paper.
   */
  ticketPrint: {
    backToOrder: "Back to order",
    printAction: "Print tickets",
    savePdfHint:
      "Choose “Save as PDF” in the print dialog to keep a copy. Turning on “Background graphics” is not required — the codes print either way.",
    documentTitle: "Printable tickets for {event}",
    loadingTitle: "Preparing your tickets",
    loadingBody: "One moment — we're loading the tickets on this order.",
    notFoundTitle: "Order not found",
    notFoundBody:
      "We couldn't load this order. It may belong to a different account — sign in with the address the tickets were sent to, then try again.",
    nothingToPrintTitle: "Nothing to print",
    nothingToPrintBody:
      "None of the tickets on this order can be printed. Tickets that have been transferred, refunded, listed for resale, or already scanned don't produce a stub.",
    ticketsPendingBody:
      "Tickets will be issued once payment is confirmed. Come back once the order is complete and this sheet will be ready to print.",
    ticketsErrorTitle: "Couldn't load your tickets",
    ticketsErrorBody:
      "Your order is fine — we just couldn't fetch the tickets on it. Reload this page to try again. They're still on the order page and in your wallet.",
    sheetOrder: "Order {code}",
    // Two forms on purpose: "3 of 6 tickets" reads as "ticket 3 of 6" on a stub
    // that IS one of several, and paper can't be hovered for clarification.
    sheetTicketCount: "{total, plural, one {# ticket} other {# tickets}}",
    sheetShowingCount: "Showing {printable} of {total} tickets",
    sheetPrinted: "Printed {timestamp}",
    startsAt: "Starts {time}",
    fieldDate: "Date",
    fieldVenue: "Place",
    fieldHolder: "Ticket holder",
    fieldPresentedBy: "Presented by",
    venueTbd: "Place to be announced",
    tearOrder: "Order",
    tearAdmits: "Admits",
    tearAdmitsValue: "1 · {type}",
    tearDoorInitial: "Door initial",
    footerNote: "Scan at the door · One entry per code",
  },
  /**
   * The printable volunteer hours statement (`/my-volunteering/hours/print`).
   *
   * READ BEFORE EDITING. This document is handed to school registrars, court
   * officers, employer matching programmes and grant administrators, so the
   * copy is a correctness surface, not a tone one:
   *
   *  - Never "verified", "certified", "confirmed by", or any wording implying
   *    Ithas Fire audited the work. We recorded a check-in. Say that.
   *  - Never name an organisation. The record holds an event or ask title.
   *  - A shift with no hours figure is not a zero-hour shift. The footnote
   *    must keep those two things apart.
   */
  hoursStatement: {
    backToVolunteering: "Back to my volunteering",
    printAction: "Print statement",
    savePdfHint:
      "Choose “Save as PDF” in the print dialog to keep a copy. “Background graphics” does not need to be on — this sheet prints as ink on white either way.",

    // Document
    documentTitle: "Volunteer hours statement",
    generatedAt: "Generated {timestamp}",
    fieldVolunteer: "Volunteer",
    fieldPeriod: "Period",
    // En dash, spaced — a date range, not a subtraction.
    periodRange: "{start} – {end}",

    // Table
    tableCaption:
      "Volunteer shifts recorded as checked in, with the hours credited to each.",
    colDate: "Date",
    // "Event or activity", never "Organisation": the record holds an event
    // title or a volunteer ask title, and we do not invent an org from either.
    colActivity: "Event or activity",
    colRole: "Role",
    colHours: "Hours",
    dateUnknown: "Date not recorded",
    // Read out in place of the em dash, which is silent to a screen reader and
    // would otherwise leave the cell sounding empty — i.e. like a zero.
    noHoursRecorded: "No hours figure recorded for this shift",

    // Total
    totalHoursLabel: "Total hours",
    totalShifts:
      "{count, plural, one {Across # shift} other {Across # shifts}}",
    // The period travels WITH the figure, not only in the page-1 header. A
    // weekly regular's statement runs to several pages, and paper cannot be
    // scrolled back up: a reader meeting "236.25" on page 3 with no range
    // beside it has no way to tell it apart from the "12.75 hours this year"
    // the volunteer's own page shows. Two numbers both labelled hours, with
    // nothing to distinguish them, is the failure this feature exists to stop.
    totalScope: "{shifts} · {period}",
    // NEUTRAL ON CAUSE, deliberately. An earlier draft said "an ongoing
    // volunteer commitment has no scheduled shift length", which is a specific
    // causal claim and reachable-false: a ONE_TIME ask signup checked in at ask
    // level whose role has no `defaultHours` also lands here
    // (`checkInAskVolunteer` only stamps hours when `role.defaultHours != null`),
    // and nothing about it was ongoing. On a document whose whole value is
    // claiming only what we know, state the observation — no recorded length —
    // and not a story about why.
    footnoteNoHours:
      "{count, plural, one {One shift has no recorded length and is shown as “—”} other {# shifts have no recorded length and are shown as “—”}}. No hours are counted for those rows, and they add nothing to the total.",

    // Footer — plain and factual, and it stays that way.
    footerNote:
      "This document is a record of volunteer shifts recorded as checked in on Ithas Fire. It lists no other activity.",
    // The zone clause is not filler. Every date above renders in the VIEWER's
    // zone — the only option for a standing ask's claimed dates, which carry no
    // venue zone at all — and the stamp names that zone. Saying the dates share
    // it turns a possible off-by-one on a late-night shift into something the
    // reader can check, on paper that cannot re-render.
    footerGenerated:
      "Generated {timestamp} from the volunteer’s own Ithas Fire account; the dates above are shown in that same time zone.",

    // States
    loadingTitle: "Preparing your statement",
    loadingBody: "One moment — we’re loading your volunteer record.",
    errorTitle: "Couldn’t load your record",
    errorBody:
      "We couldn’t fetch your volunteer shifts just now, so this statement can’t be produced yet. Reload the page to try again.",
    emptyTitle: "No shifts to state yet",
    emptyBody:
      "This statement lists the shifts you were recorded as checked in for. Once you’ve been checked in at a shift, it will appear here.",
    signedOutTitle: "Sign in to open your statement",
    signedOutBody:
      "This record is private to your account. Sign in with the address you volunteer under, then open it again.",
    signedOutAction: "Sign in",
  },
  /**
   * The volunteer's OWN printable check-in code
   * (`/my-volunteering/qr/print`).
   *
   * READ BEFORE EDITING. This is the counterpart to `volunteerBadges`, and the
   * copy is the main thing keeping the two apart:
   *
   *  - It is a CODE, never a badge, pass, credential or accreditation. Badges
   *    are venue-issued stock printed by the organiser; this is the
   *    volunteer's own "scan me in" for when their phone is dead.
   *  - Never an issuer. Nobody issued this to them — they made it themselves.
   *  - It must SAY, on the paper, that it admits nobody on its own and that a
   *    coordinator has to scan it. That sentence is the whole boundary.
   *  - Addressed to the volunteer, in second person. `volunteerBadges` is
   *    addressed to an organiser; do not let the two drift into one voice.
   */
  volunteerQr: {
    backToVolunteering: "Back to my volunteering",
    createAction: "Create my code",
    creatingAction: "Creating…",
    printAction: "Print my code",
    retryAction: "Try again",
    savePdfHint:
      "Choose “Save as PDF” in the print dialog to keep a copy. “Background graphics” does not need to be on — the code prints as ink on white either way.",

    // Document
    documentTitle: "Volunteer check-in code",
    createdAt: "Created {timestamp}",
    codeAlt: "Your volunteer check-in code",
    fieldRole: "Role",
    fieldWhen: "When",
    fieldWhere: "Where",
    fieldEvent: "Event",
    windowUnknown: "Time to be confirmed",
    whereUnknown: "Location to be confirmed",
    shiftWindow: "{date} · {start} – {end}",
    // An overnight shift crosses midnight, so the far side repeats its date.
    shiftWindowOvernight: "{startDate} {start} – {endDate} {end}",
    // THE sentence. It is what stops this reading as a pass, and it is set at
    // body size on the sheet rather than as fine print for that reason.
    admitsNobodyNote:
      "This code does not admit you on its own. Show it at volunteer check-in and a coordinator scans it to check you in. If it won’t scan, they can find you by name instead.",
    footerNote:
      "Made from your own Ithas Fire account for the shifts listed above. Times are shown in the place’s time zone.",
    footerCreated: "Created {timestamp}.",

    // States
    loadingTitle: "Preparing your code",
    loadingBody: "One moment — we’re loading your volunteer commitments.",
    errorTitle: "Couldn’t load your commitments",
    errorBody:
      "We couldn’t fetch your volunteer shifts just now, so no code can be made yet. Reload the page to try again.",
    emptyTitle: "No approved shifts yet",
    emptyBody:
      "A check-in code is only made for shifts an organiser has approved. Once one of your applications is approved, you can print a code for it here.",
    wrongEventTitle: "No approved shift at that event",
    wrongEventBody:
      "This link points at an event you don’t have an approved shift at. Open the code from the commitment on your volunteering page instead.",
    manifestTitle: "Ready to make your code for {event}",
    manifestBody:
      "One code covers every shift you’re approved for at this event. It stays valid until shortly after the event.",
    creatingTitle: "Making your code",
    creatingBody: "One moment.",
    failedTitle: "Couldn’t make your code",
    failedBody:
      "No code was produced, so there is nothing to print yet. Check your connection and try again — and if it still won’t work, volunteer check-in can find you by name on the day.",
    signedOutTitle: "Sign in to make your code",
    signedOutBody:
      "This code is tied to your account. Sign in with the address you volunteer under, then open it again.",
    signedOutAction: "Sign in",
  },
  /**
   * The printable volunteer BADGE sheet
   * (`/admin/[slug]/events/[id]/volunteers/badges/print`).
   *
   * READ BEFORE EDITING. A badge is credential stock — it reads as
   * authorization at a door — and this copy is what makes clear WHO issued it:
   *
   *  - The issuer is the organizer or venue, never Ithas Fire. "Issued by
   *    {issuer}" names the workspace the operator printed from, because that
   *    is the party a door escalates to.
   *  - Nothing here may address a volunteer. This surface is organizer-only;
   *    the volunteer's own printable QR is a separate document with different
   *    copy, and it is a QR, NOT a badge.
   *  - Never imply the badge alone admits anyone. It carries a scan code an
   *    org-edit/scan operator still has to resolve and check in.
   *  - Door-facing text sets at 7.5–14pt on paper. Short, literal, no idiom.
   */
  volunteerBadges: {
    backToSignups: "Back to signups",
    issueAction: "{count, plural, one {Issue # badge} other {Issue # badges}}",
    issuingAction: "Issuing…",
    printAction: "Print badges",
    retryAction: "Try again",
    savePdfHint:
      "Choose “Save as PDF” in the print dialog to keep a copy. “Background graphics” does not need to be on — the scan panels print as ink on white either way. Six badges to a sheet on both US Letter and A4; cut along the dashed lines.",

    // Document
    documentTitle: "Volunteer badges for {event}",
    // The designation. Uppercased by the stylesheet, so write it in sentence
    // case here — Spanish and English capitalise differently, and a
    // hard-uppercased source string fights the locale.
    designation: "Volunteer",
    issuedBy: "Issued by {issuer}",
    // Only reachable when the workspace name has not resolved. Names the
    // event's organiser generically rather than printing a blank issuer line,
    // because an unattributed badge is the one thing this document must not be.
    issuerFallback: "the event organiser",
    fieldEvent: "Event",
    fieldVenue: "Place",
    venueTbd: "Place to be announced",
    roleUnknown: "Volunteer",
    shiftUnassigned: "Shift to be assigned",
    // "Fri 15 Aug · 5:00 – 10:00 PM CDT". The zone rides on the end time.
    shiftWindow: "{date} · {start} – {end}",
    // An overnight load-out crosses midnight, so the far side repeats its
    // date. Without this a badge reads "5:00 PM – 2:00 AM" under one date and
    // is wrong about the day the volunteer is expected.
    shiftWindowOvernight: "{startDate} {start} – {endDate} {end}",
    scanAlt: "Volunteer check-in code for {name}",
    metaBadgeCount: "{count, plural, one {# badge} other {# badges}}",
    metaIssued: "Issued {timestamp}",
    footerNote:
      "Issued by the place · Scan at volunteer check-in · Cut along the dashed lines",

    // States
    loadingTitle: "Loading the volunteer roster",
    loadingBody:
      "One moment — we’re gathering the approved volunteers for this event.",
    errorTitle: "Couldn’t load the roster",
    errorBody:
      "We couldn’t fetch this event’s volunteers just now, so no badges can be issued yet. Reload the page to try again.",
    emptyTitle: "No approved volunteers yet",
    emptyBody:
      "Badges are only issued to volunteers whose signup has been approved. Approve signups on the volunteers screen and this run will be ready.",
    manifestTitle:
      "{count, plural, one {Ready to issue # badge} other {Ready to issue # badges}}",
    manifestBody:
      "One badge per volunteer, covering every shift they’re approved for. Each badge carries a scan code that stays valid until shortly after the event. Badges are issued by {issuer} — print them on your own stock and hand them out at volunteer check-in.",
    manifestUnissuable:
      "{count, plural, one {# approved signup has no linked account and cannot be issued a badge} other {# approved signups have no linked account and cannot be issued badges}}.",
    manifestUnissuableHint:
      "Check them in from the volunteer roster instead.",
    issuingTitle: "Issuing badges",
    issuingBody: "Preparing scan code {done} of {total}.",
    issueFailedTitle: "Couldn’t issue badges",
    issueFailedBody:
      "No scan codes were produced, so there is nothing to print yet. Check your connection and try again.",
    partialTitle: "Some badges could not be issued",
    partialBody:
      "{count, plural, one {# volunteer is missing from this run} other {# volunteers are missing from this run}}. Print what’s here, then try again for the rest — these names have no badge on the sheet:",
  },
  // Venue booking standards (venue-booking-standards spec, 2026-09-25).
  // `platform` is what a venue that has set nothing shows. Its keys are
  // referenced from core (packages/core/src/use-cases/booking-standards/
  // platform-defaults.ts) and pinned to both catalogs by
  // src/i18n/__tests__/booking-standards-catalog.test.ts.
  bookingStandards: {
    platform: {
      perform: {
        preferredDates: {
          label: "The dates you want",
          hint: "Pick one or more nights, and say if you\u2019re flexible.",
        },
        linkMusic: {
          label: "A link to your music",
          hint: "Bandcamp, Spotify, SoundCloud, or anywhere we can listen.",
        },
        expectedDraw: {
          label: "How many people you usually bring",
          hint: "A rough number from your last few shows is fine.",
        },
        setLength: {
          label: "How long you want to play",
          hint: "Pick the set length that fits your act.",
        },
        exampleOne: {
          title: "A local band asking for a weekend night",
          body: "Hi, we\u2019re Low Porch, a four-piece folk band from the east side.\n\nWe\u2019d like a Friday or Saturday in March. We usually bring 30 to 40 people, and our last show had 35 through the door.\n\nOur music is on Bandcamp under Low Porch. We play a 45-minute set and bring our own gear except drums.\n\nWe\u2019re happy to share the bill. Thanks for reading.",
        },
        exampleTwo: {
          title: "A touring act passing through",
          body: "Hello, I\u2019m Dana Reyes, a singer-songwriter on a two-week run through the Southeast.\n\nI can play here on May 14 or 15. About 20 people usually come out for me in town, and I\u2019ll send the date to my mailing list.\n\nI play solo on acoustic guitar and need one vocal mic and one DI. A 60-minute set works best, and I\u2019m open to a door split.\n\nMy music and a live video are in the links with this request. Thanks for considering it.",
        },
        // P5-S1S2T1 (outline) — FR-010 / board T1: "Start from an outline"
        // drops these prompts into the message, one per line. One per intent;
        // only PERFORM has a message field today.
        outline:
          "[Who you are, in a line]\n[Why this room]\n[Who comes to your shows, and how many]\n[What the night looks like]\n[Anything else they should know]",
        // end P5-S1S2T1 (outline)
      },
      rent: {
        requestedWindow: {
          label: "The date and time you need the room",
          hint: "Include time to set up and clean up.",
        },
        purpose: {
          label: "What the event is",
          hint: "One line is enough: a birthday party, a record release, a workshop.",
        },
        expectedAttendance: {
          label: "How many people are coming",
          hint: "Your best guess. It helps us pick the right room.",
        },
        exampleOne: {
          title: "A private party",
          body: "Hi, I\u2019d like to rent the back room for my partner\u2019s 40th birthday on Saturday, June 7, from 6 to 11 pm. That includes an hour to set up.\n\nWe expect about 50 guests. We\u2019ll bring a playlist and would like to use your sound system if we can.\n\nCould you tell me the rate and whether you need a deposit?",
        },
        exampleTwo: {
          title: "A record release show",
          body: "Hello, our band has a record coming out and we\u2019d like to rent the main room on Thursday, August 21, from 7 pm to midnight.\n\nWe\u2019ll sell our own tickets and expect 120 to 150 people. We have our own sound engineer and would need to load in at 5 pm.\n\nWhat is the rental rate, and is bar staff included?",
        },
      },
      use: {
        requestedWindow: {
          label: "The date and time you need the space",
          hint: "Include time to set up and clean up.",
        },
        purpose: {
          label: "What you\u2019re planning",
          hint: "One line is enough: a reading, a meeting, a film night.",
        },
        expectedAttendance: {
          label: "How many people you expect",
          hint: "Your best guess helps us set up the room.",
        },
        exampleOne: {
          title: "A neighborhood meeting",
          body: "Hi, I help run a tenants\u2019 group in the neighborhood. We\u2019d like to meet here on Tuesday, October 7, from 6:30 to 8 pm.\n\nWe usually have 15 to 25 people. We need chairs and an outlet for a laptop, nothing else.\n\nWe\u2019ll leave the room the way we found it. If it goes well, we\u2019d like to ask about a regular night.",
        },
        exampleTwo: {
          title: "A poetry reading",
          body: "Hello, I host a small poetry reading and would like to use your space on Sunday, November 2, from 3 to 5 pm.\n\nWe expect about 30 people and four readers. One microphone would help, but we can do without.\n\nThe reading is free and open to anyone. We\u2019ll share it with our mailing list to bring people in.",
        },
      },
    },
  },
  refund: {
    checkingEligibility: "Checking refund eligibility...",
    unableToCheck: "Unable to check refund eligibility",
    backToOrder: "Back to Order",
    refundProcessed: "Refund Processed",
    refundSubmitted: "Your refund of {amount} has been submitted.",
    refundDelay:
      "The refund will appear in your account within 5-10 business days, depending on your bank.",
    requestRefund: "Request Refund",
    eventDetails: "Event Details",
    eventDate: "Event Date",
    timeUntilEvent: "Time Until Event",
    refundDeadline: "Refund Deadline",
    refundBreakdown: "Refund Breakdown",
    amountPaid: "Amount Paid",
    ticketPrice: "Ticket Price",
    platformFee: "Platform Fee",
    platformFeeIncluded: "Fully refunded",
    paymentProcessingFee: "Payment Processing Fee",
    nonRefundable: "Non-refundable (retained by payment processor)",
    processingFeeReason:
      "Payment processing fees are retained by our payment processor and can't be returned.",
    policyFeeRefundable:
      "Your ticket price, tax, and the platform fee are all refunded. Only the payment processing fee is withheld, because our payment processor keeps it even when an order is refunded.",
    policyFeeRefundableResale:
      "Your ticket price and tax are refunded. Only the payment processing fee is withheld, because our payment processor keeps it even when an order is refunded.",
    tax: "Tax",
    taxIncludedInAmount: "Included in amount paid",
    youWillReceive: "You Will Receive",
    eligible: "Eligible for Refund",
    notEligible: "Not Eligible for Refund",
    confirmRefund: "Confirm Refund ({amount})",
    refundPolicy: "Refund Policy",
    policyDeadline:
      "Refunds are available until the event starts. After the event begins, refunds are no longer available.",
    policyFee:
      "Your ticket price, tax, and the platform fee are all refunded. Only the payment processing fee is withheld, because our payment processor keeps it even when an order is refunded.",
    refundNotAvailable: "Refund Not Available",
    reasonEligible: "Your order is eligible for a refund.",
    reasonEventStarted:
      "The event has already started. Refunds are no longer available.",
    reasonAlreadyRefunded: "This order has already been refunded.",
    reasonNotPaid: "This order has not been paid for yet.",
    reasonNotFound: "Order not found.",
    reasonPastDeadline: "The refund deadline has passed.",
    reasonPaidOut:
      "This order has already been settled to the organizer. Please contact the event organizer for assistance.",
    reasonNoRefundableItems:
      "All tickets in this order have been transferred or are otherwise ineligible for a refund.",
    reasonClaimRefundPending:
      "Your claim’s refund is already on its way, so there’s nothing more to request.",
    partialRefundNotice: "Partial Refund",
    transferredItemsExplanation:
      "{refundable} of {total, plural, one {# ticket} other {# tickets}} will be refunded. Transferred tickets are not eligible for a refund.",
    skippedItemsNote:
      "{count, plural, one {# ticket was} other {# tickets were}} not refunded because they had been transferred.",
    eventStarted: "Event has started",
    nDaysUntilEvent:
      "{count, plural, one {# day until event} other {# days until event}}",
    nHoursUntilEvent:
      "{count, plural, one {# hour until event} other {# hours until event}}",
    nMinutesUntilEvent:
      "{count, plural, one {# minute until event} other {# minutes until event}}",
  },
  // Payee acknowledgement page (/payouts/acknowledge/[lineId]).
  payoutAck: {
    docTitle: "Payout \u00b7 {title}",
    kicker: "Payout invitation",
    confirmedToastTitle: "Confirmed",
    confirmedToastBody: "Thanks. The organizer has been notified.",
    confirmFailed: "Couldn\u2019t confirm",
    confirmConflict:
      "Your share changed since you opened this page. Check the new share before you confirm.",
    loadFailed: "Couldn\u2019t load this payout line",
    tryAgain: "Try again",
    untitledEvent: "Untitled event",
    shareOfTickets: "of ticket revenue",
    shareOfResale: "of the resale share",
    shareOfMerch: "of merchandise revenue",
    statusConfirmed: "CONFIRMED",
    statusPending: "PENDING",
    stripeActive: "Stripe account: active",
    stripeInactive:
      "Your Stripe account isn\u2019t active yet, so payouts can\u2019t reach you until you finish setup.",
    alreadyConfirmed: "Already confirmed",
    looksGood: "Looks good",
    confirmNote:
      "Confirming is informational: it lets the organizer know you\u2019ve seen your share. Disagree with these terms? Contact the organizer directly to renegotiate.",
    finishTitle: "Finish your Stripe setup",
    finishBody:
      "You can confirm now, but no money reaches you until your Stripe account is active. Finish setup on the Payouts page of your workspace.",
    openWorkspace: "Open your workspace",
  },
  resell: {
    backToOrder: "Back to Order",
    paymentProcessingTitle: "Payment processing",
    paymentProcessingBody:
      "Bank payments take a few business days to clear. The ticket is yours when it does, and we'll email you. If the payment doesn't go through, the order is cancelled and you aren't charged.",
    ticketResale: "Ticket Resale",
    snapshotIntro:
      "Live listings show the saved finance snapshot and release target we have on record. Release dates are targets, not proof of payment.",
    activeListings: "Your active listings",
    faceValueLabel: "Original price",
    askingPriceLabel: "Asking price",
    processingPassThroughLabel: "Buyer processing pass-through",
    processingPassThroughBeforeTaxLabel: "Buyer processing, before tax",
    saleCutoffLabel: "Sale cutoff",
    payoutReleaseTargetLabel: "Release target",
    releaseTargetDisclaimer:
      "Release targets can still slip if payout setup or review requirements are incomplete.",
    economicsTitle: "Seller economics",
    economicsLosses: "If you list below what you paid, that loss stays with you.",
    economicsProcessing:
      "The buyer pays the exact processing pass-through on top.",
    economicsRelease:
      "Release dates follow the organizer's configured hold period and appear after listing creation when available.",
    noTicketsAvailable:
      "No tickets available to resell. Tickets may already be listed or not be eligible for resale.",
    selectTicketToResell: "Select a ticket to resell",
    ownListingTitle: "This is your listing",
    ownListingBody:
      "Send this page's link to the person you want to pass the ticket to. You can't buy your own listing.",
    ticketLabel: "Ticket",
    alreadyListed: "Already listed",
    setAskPrice: "Set your asking price",
    priceInputLabel: "Price ($)",
    invalidPriceTitle: "Invalid price",
    invalidPriceMessage: "Please enter a valid price greater than $0.",
    ambiguousPriceMessage:
      "That price can be read two ways. For one thousand five hundred, type 1500. For one and a half, type 1.50 or 1,50.",
    listingInProgress: "Listing...",
    listForSale: "List for sale",
    statusActive: "Live",
    statusHeld: "Checkout in progress",
    statusSold: "Sold",
    statusCancelled: "Cancelled",
    statusExpired: "Sale window closed",
    payoutSetupTitle: "Set up payouts to sell",
    payoutSetupMessage:
      "You need a Stripe account with payouts turned on before you can list a ticket. That's how the money from a sale reaches you.",
    payoutSetupLink: "Set up payouts",
    payoutReadyNow: "Your payouts are on now. List the ticket again.",
    originalPriceFixed: "Original price {amount}",
    originalPriceComp: "Original price {amount} · given free",
    originalPriceFrom: "Original price from {amount}",
    plusTax: "plus tax",
    plusTaxIncludesProcessing: "includes processing, plus tax",
    estimatedTotalWithProcessingAndTax: "Estimated total, with processing and tax",
    taxAtCheckout: "Tax is added at checkout.",
    totalChangedPayAgain:
      "Your total with tax is {amount}. Check it, then press Pay again.",
    reservationEnded:
      "This ticket is no longer reserved for you. Press Pay to try again.",
    shareToEventSeller:
      "{amount} of the ticket price goes to the people who put on the night",
    shareToEventBuyer: "{ticket} + {amount} to the people who put on the night",
    shareLineLabel: "To the people who put on the night",
    shareNoteSeller: "Set by the organizers",
    shareNoteBuyer: "Added to the buyer's price",
    shareHeldNote:
      "The organizers set {amount}. A share is held to 10% of the sale.",
    splitTitle: "What you receive",
    splitLoading: "Working out your split...",
    youReceive: "You receive",
    youReceiveAmount: "You receive {amount}",
    buyerPaysAllIn: "Buyer pays {amount} {note}",
    youPaid: "You paid {amount}",
    buyerPaysSeller: "The buyer pays {amount} plus processing and tax.",
    buyerPaysBuyer:
      "The buyer pays {amount}, share included, plus processing and tax.",
    noPlatformCut: "Ithas Fire takes nothing on a resale.",
    lessThanPaid: "That is {amount} less than you paid for the ticket.",
    overLimit: "The most this ticket can sell for is {amount}.",
    useHighestAsk: "Ask {amount} instead",
    listForAmount: "List for {amount}",
  },
  /**
   * Resale claims: the buyer files (`/my-tickets/[orderId]/claim` and the
   * order page section), the seller replies (`/sell/claims`), support decides
   * (`/platform/claims`). Owner rulings 2026-10-06: support reviews every
   * claim and can decide at any time; the seller can reply until then; an
   * approved claim is a full refund.
   */
  resaleClaim: {
    // Order page section (buyer)
    sectionTitle: "Problem with this ticket?",
    sectionBody:
      "You bought this ticket from another fan. If it didn't get you in, or it wasn't what the listing said, file a claim. Support reviews every claim, and if they approve it you get a full refund of what you paid.",
    sectionWindow:
      "You can file a claim until {days, plural, one {# day} other {# days}} after the event ends.",
    sectionNotOpen:
      "You bought this ticket from another fan. If it doesn't get you in, you can file a claim here once the event starts, up to {days, plural, one {# day} other {# days}} after it ends. Support reviews every claim.",
    sectionCta: "File a claim",
    sectionCtaAnother: "File a claim for another ticket",
    yourClaimTitle: "Your claim",
    filedOn: "Filed {date}",
    sentOn: "Sent {date}",
    youWrote: "What you told us",
    noDescription: "No description was saved with this claim.",
    buyerSellerReply: "The seller's reply",
    buyerSellerNoReply:
      "The seller hasn't replied yet. They can reply until support decides.",
    buyerSellerNoReplyDecided: "The seller didn't reply.",
    supportNote: "Note from support",
    nextOpen:
      "Support reviews every claim. We've told the seller, and they can reply. If support approves your claim, you get a full refund of what you paid. We'll email you when it's decided.",
    nextUnderReview:
      "Support is looking at your claim now. If they approve it, you get a full refund of what you paid. We'll email you when it's decided.",
    nextApproved:
      "Support approved your claim and is refunding your full payment. Check back here for the refund status.",
    nextDenied:
      "Support denied this claim, so there's no refund. If you think that's wrong, contact support below.",
    nextExpired:
      "This claim closed without a decision. If you still need help, contact support below.",
    statusOpen: "Open",
    statusUnderReview: "Under review",
    statusApproved: "Approved",
    statusDenied: "Denied",
    statusExpired: "Closed",
    // Kinds (everyone reads these)
    kindTicketInvalid: "The ticket didn't scan",
    kindTicketInvalidDesc:
      "The code was rejected at the door or showed as not valid.",
    kindEntryDenied: "I was turned away",
    kindEntryDeniedDesc: "Door staff wouldn't let me in with this ticket.",
    kindWrongSeat: "Wrong seat or section",
    kindWrongSeatDesc:
      "The ticket wasn't for the seat or section the listing showed.",
    kindOther: "Something else",
    kindOtherDesc: "Tell us what happened below.",
    // Claim page (buyer)
    pageTitle: "File a claim",
    backToOrder: "Back to order",
    backToMyTickets: "Back to my tickets",
    loading: "Loading your order…",
    orderNotFound: "We couldn't find this order.",
    loadFailedTitle: "We couldn't load your tickets",
    intro:
      "Use this if a ticket you bought from another fan didn't work. Support reviews every claim. If they approve it, you get a full refund of what you paid.",
    stepTicket: "Which ticket?",
    ticketFallback: "Ticket",
    ticketCode: "Code {code}",
    ticketRequired: "Choose the ticket this claim is about.",
    stepKind: "What went wrong?",
    kindRequired: "Choose what went wrong.",
    stepDescription: "What happened",
    descriptionHelp:
      "Text only for now: you can't attach photos or files yet. Say what happened and when, and anything that would help support decide.",
    descriptionRequired: "Tell us what happened.",
    whatHappensNext: "What happens next",
    privacyNote:
      "We'll tell the seller about your claim and show them what you write here, so they can reply. We never share your email or contact details with them.",
    reviewNote:
      "Support reviews every claim, and it stays open until they decide. If they approve it, you get a full refund of what you paid.",
    submit: "Send claim",
    submitting: "Sending…",
    sending: "Sending…",
    cancel: "Cancel",
    optional: "(optional)",
    sentTitle: "Claim sent",
    sentStepReview:
      "Support reviews every claim, and nothing closes until they decide.",
    sentStepSeller:
      "We've told the seller. They can read what you wrote and reply.",
    sentStepRefund:
      "If support approves your claim, you get a full refund of what you paid. We'll email you either way, and you can follow it on your order page.",
    closedTitle: "Claims for this event have closed",
    notOpenTitle: "Claims open when the event starts",
    notOpenBody:
      "If this ticket doesn't get you in, come back here and file a claim. You can file one until {days, plural, one {# day} other {# days}} after the event ends.",
    nothingToClaimTitle: "There's nothing to claim on this order",
    nothingToClaimBody:
      "Claims are for tickets you bought from another fan and still hold. If you gave the ticket away, transferred it or listed it again, you can't file a claim on it.",
    alreadyFiledTitle: "You've already filed a claim",
    alreadyFiledBody:
      "You can follow it, and read the seller's reply, on your order page.",
    errorWindowNotOpen:
      "Claims for this event open when it starts. Come back then if the ticket doesn't work.",
    errorWindowExpired:
      "The time to file a claim for this event has passed: claims close {days, plural, one {# day} other {# days}} after the event ends. If you still need help, contact support.",
    errorAlreadyExists:
      "You've already filed a claim for this ticket. You can follow it on your order page.",
    errorTicketNotHeld:
      "You can only file a claim on a ticket you still hold. If you gave it away, transferred it or listed it again, a claim isn't available.",
    errorNotResale:
      "Claims are only for tickets bought from another fan. For anything else, contact support.",
    // Seller (/sell/claims)
    sellerHint:
      "Open a claim to read what the buyer said and reply. Support reviews every claim and can decide at any time, so reply soon.",
    sellerColReply: "Your reply",
    sellerReplyNotYet: "Not yet",
    sellerNeedsReply: "Needs your reply",
    sellerViewAndReply: "Read and reply to claim {claim}",
    sellerViewClaim: "Show claim {claim}",
    sellerHideClaim: "Hide claim {claim}",
    sellerNext:
      "Support reviews every claim and can decide at any time. Your reply helps them decide.",
    sellerBuyerSaid: "What the buyer said",
    sellerNoDescription: "The buyer didn't write a description with this claim.",
    sellerYourReply: "Your reply",
    sellerReplyHelp:
      "Text only. Tell support your side: when you sent the ticket, whether it was used, anything that helps. The buyer and support will read it.",
    sellerReplyRequired: "Write a reply before sending.",
    sellerReplySubmit: "Send reply",
    sellerReplyUpdate: "Update reply",
    sellerReplyEdit: "Change reply",
    sellerReplyCanChange: "You can change your reply until support decides.",
    sellerReplySentStatus: "Reply sent. Support will read it before deciding.",
    sellerNoReplyDecided: "You didn't reply to this claim.",
    sellerOutcomeApproved:
      "Support approved this claim. The buyer got a full refund, so you won't be paid for this sale.",
    sellerOutcomeDenied:
      "Support denied this claim. The money held from your sale is released and will be paid out to you.",
    sellerOutcomeExpired: "This claim closed without a decision.",
    sellerErrorResolved:
      "Support has already decided this claim, so it can't take a reply now.",
    // Staff (/platform/claims) and the org admin's resale tab
    windowClosedColumn: "Claims accepted until",
    staffShowDetails: "Show details for claim {claim}",
    staffHideDetails: "Hide details for claim {claim}",
    staffOrder: "Order",
    staffBuyer: "Buyer",
    staffSeller: "Seller",
    staffFiled: "Filed",
    staffDecided: "Decided",
    staffBuyerSaid: "Buyer's description",
    staffNoDescription: "No description saved (filed before text claims).",
    staffSellerReply: "Seller's reply",
    staffNoSellerReply:
      "No reply from the seller yet. They can reply until you decide, but you don't have to wait.",
    staffNoSellerReplyDecided: "The seller didn't reply.",
    staffReplyUnreadable:
      "The seller replied on {date}, but the reply can't be shown.",
    staffNoteLabel: "Note to the buyer and seller",
    staffNoteHelp:
      "Both of them see this note on their claim. Don't write anything you wouldn't say to both of them.",
    staffApprove: "Approve and refund",
    staffDeny: "Deny claim",
    staffMarkUnderReview: "Mark under review",
    staffConfirmApproveTitle:
      "Approve claim {claim} and refund the buyer?",
    staffConfirmApproveBody:
      "This refunds the buyer's full payment to their card through Stripe straight away. The seller isn't paid for this sale. You can't undo it.",
    staffConfirmApprove: "Yes, refund in full",
    staffConfirmDenyTitle: "Deny claim {claim}?",
    staffConfirmDenyBody:
      "Nothing is refunded. The money held from the seller's sale is released for payout. You can't undo it.",
    staffConfirmDeny: "Yes, deny",
    staffConfirmBack: "Go back",
    staffBothTold: "We'll email the buyer and the seller with the decision.",
    staffOutcomeApproved: "Approved: the buyer's full payment was refunded.",
    staffOutcomeDenied:
      "Denied: nothing was refunded, and the seller's held money was released.",
    staffOutcomeExpired: "Closed without a decision.",
    // Fix round 1 (review 2026-10-06)
    nextApprovedRefunded:
      "Support approved your claim and refunded your full payment to your card. It usually shows up within 5 to 10 business days.",
    resolutionFullRefund: "Full refund",
    resolutionRefundPending: "Refund in progress",
    resolutionNoRefund: "No refund",
    resolutionClosed: "Closed",
    dismiss: "Dismiss",
    sellerPanelLabel: "Claim {claim}",
    sellerOutcomeApprovedPending:
      "Support approved this claim. The buyer's full refund is being processed, and you won't be paid for this sale.",
    sellerReplySubmitFor: "Send reply to claim {claim}",
    sellerReplyUpdateFor: "Update reply to claim {claim}",
    sellerReplyEditFor: "Change reply to claim {claim}",
    sellerReplyCancelFor: "Cancel changing reply to claim {claim}",
    sellerDecidedBeforeReply:
      "Support decided a claim before your reply was sent, so the reply wasn't saved. See Resolved.",
    staffPanelLabel: "Claim {claim}",
    staffApproveFor: "Approve and refund claim {claim}",
    staffDenyFor: "Deny claim {claim}",
    staffMarkUnderReviewFor: "Mark claim {claim} under review",
    staffConfirmApproveFor: "Yes, refund claim {claim} in full",
    staffConfirmDenyFor: "Yes, deny claim {claim}",
    staffConfirmBackFor: "Go back, leave claim {claim} undecided",
    staffRefundNotConfirmedTitle: "Refund not confirmed",
    staffRefundNotConfirmedBody:
      "This claim is approved, but Stripe hasn't confirmed the buyer's refund. It may still be processing, or it may have failed. Retrying never pays twice. If Stripe refused the refund, a retry within about 24 hours gets the same refusal.",
    staffRetryRefund: "Retry refund",
    staffRetryRefundFor: "Retry refund for claim {claim}",
    staffErrorRefundFailed:
      "The claim is approved, but the refund didn't go through at Stripe. Retry the refund; if it keeps failing, check the payment in Stripe.",
    staffErrorRefundRejected:
      "Stripe refused the refund. A retry within about 24 hours gets the same refusal. See the payment in Stripe.",
    staffDecidedElsewhere: "Another staff member decided this claim first.",
    staffAnnounceApproved: "Approved: {kind} (claim {id}).",
    staffAnnounceDenied: "Denied: {kind} (claim {id}).",
    staffAnnounceUnderReview: "Under review: {kind} (claim {id}).",
    staffAnnounceDecidedElsewhere:
      "Another staff member decided this one first: {kind} (claim {id}).",
    // Fix round 2 (review 2026-10-06)
    staffRefundRejectedTitle: "Stripe refused this refund",
    staffRefundRejectedBody:
      "Stripe refused the refund for this payment. Retrying sends the same request, and for about 24 hours Stripe gives the same answer, so a retry now will fail the same way. Look at the payment in Stripe to see why, then ask the payments team how to refund the buyer.",
    staffRetryAnyway: "Retry anyway",
    staffRetryAnywayFor: "Retry anyway: refund for claim {claim}",
    staffAnnounceRetrySent:
      "Refund sent again: {kind} (claim {id}). It shows as confirmed once Stripe completes it.",
    staffRefundStillPending:
      "Still not confirmed. If this doesn't change within an hour, check the payment in Stripe.",
    // Fix round 3 (review 2026-10-06)
    staffAnnounceRefundFailed:
      "Approved, but the refund didn't go through: {kind} (claim {id}). Open it under Approved to retry.",
    staffAnnounceRefundRejected:
      "Approved, but Stripe refused the refund: {kind} (claim {id}). Open it under Approved to see what to do.",
    // Fix round 4 (review 2026-10-06)
    dismissMessage: "Dismiss message",
    sellerTabActive: "Active",
    sellerTabResolved: "Resolved",
  },
  admin: {
    // Dashboard tile (2026-10-13): a real 7-day count replaces "Recent orders",
    // which only repeated the page size. The no-break space keeps "7 days" on one line.
    ordersLast7DaysStat: "Orders, last 7\u00a0days",
    abProcessingTimeout: "Processing is taking longer than expected",
    abTranscodeFailedFallback:
      "Couldn't generate the optimized version — playing the original.",
    arAccountSetupMessage:
      "We couldn't load your account. Finish setting up your profile or try again in a moment.",
    arAccountSetupTitle: "Finish setting up your account",
    cpEmptyEyebrow: "No promos yet",
    cpImmediate: "Immediate",
    cpPublicCode: "Public code",
    cpPublicCodeHint:
      "Public codes can be auto-applied from shareable URLs (e.g. ?p=CODE). Leave off for comp/employee codes you don't want exposed.",
    cpShareWithEvent: "Share with event",
    csvImportPreviewHint: "Map a column to see a preview",
    ebEventUnpublishedMessage:
      "This event is now hidden from the public and no longer accepts sales.",
    ebEventUnpublishedTitle: "Event unpublished",
    ebUnpublishFailedTitle: "Couldn't unpublish event",
    ebUntitledEvent: "Untitled event",
    embedLinkOutDescription:
      "Choose whether checkout opens inside the embed or in a new tab on Ithas Fire.",
    embedLinkOutFailed: "Couldn't update embed",
    embedLinkOutLabel: "Checkout behavior",
    embedLinkOutModeInPage: "Open in page",
    embedLinkOutModeNewTab: "Open in new tab",
    embedLinkOutUpdated: "Embed updated",
    embedLinkOutUpdatedDesc: "Your checkout behavior change has been saved.",
    eventVolunteerApproved: "approved",
    eventVolunteerNone: "No volunteers yet",
    eventVolunteerPending: "pending",
    gsFailedWaitlistDetails:
      "Couldn't save waitlist details. Please try again.",
    gsFailedWaitlistStatus:
      "Couldn't update waitlist status. Please try again.",
    gsNotifyMe: "Notify-me list",
    gsNotifyMeDesc:
      "Let fans sign up to be notified when tickets go on sale or more become available.",
    gsWaitlistCap: "Sign-up limit",
    gsWaitlistCapHint: "Leave blank for no limit on how many fans can sign up.",
    gsWaitlistCapPlaceholder: "No limit",
    gsWaitlistMessage: "Message to interested fans",
    gsWaitlistMessagePlaceholder:
      "Let fans know what to expect once they sign up…",
    gsWaitlistOff: "Off",
    gsWaitlistOffDesc:
      "Fans won't be able to sign up to be notified about this event.",
    gsWaitlistOpen: "Collect sign-ups",
    gsWaitlistOpenDesc:
      "Fans can sign up to be notified when tickets become available.",
    gsWaitlistSaveDetails: "Save details",
    ibPasteImageUrl: "Paste image URL…",
    noOrgSelected: "No organization selected",
    // `orderCode` is the 8-hex `formatOrderCode` value; `orderId` is the raw
    // UUID. Both render on the attendees screen (column vs expanded panel), so
    // they must not share a label.
    orderCode: "Order code",
    orderId: "Order ID",
    peAudioDisabledTooltip: "Audio uploads aren't available here",
    peInsertMediaEmbed: "Insert media embed",
    peMediaEmbedHelp:
      "Supports YouTube, Spotify, Apple Music, SoundCloud, Vimeo, and Bandcamp links.",
    peMediaEmbedInvalid: "Paste a supported media URL.",
    peMediaEmbedUrl: "Media URL",
    peRemoveMediaEmbed: "Remove media embed",
    peUpdateMediaEmbed: "Update",
    placeVerifWithdrawFailed: "Couldn't withdraw verification request",
    placeVerifWithdrawn: "Verification request withdrawn",
    remove: "Remove",
    resaleAskPrice: "Ask price",
    resaleClaimsFailedToLoad: "Couldn't load claims: {error}",
    resaleClaimsTab: "Claims",
    resaleCreated: "Created",
    resaleFacePrice: "Face price",
    resaleFailedToLoad: "Couldn't load listings: {error}",
    resaleListingId: "Listing ID",
    resaleListingsTab: "Listings",
    resaleNoClaims: "No claims yet",
    resaleNoListings: "No listings yet",
    resaleSection: "Section",
    resaleSelectEvent: "Event",
    resaleStatus: "Status",
    resaleSubtitle:
      "Monitor fan-to-fan resale listings and claims for your events.",
    resaleTicketType: "Ticket type",
    resaleTitle: "Resale",
    resaleClaimsCount: "{count, plural, one {# claim} other {# claims}}",
    resaleListingsCount: "{count, plural, one {# listing} other {# listings}}",
    resaleLoadingEvents: "Loading events…",
    resaleNoEvents: "No events",
    resaleStatusActive: "Live",
    resaleStatusCancelled: "Cancelled",
    resaleStatusExpired: "Sale window closed",
    resaleStatusHeld: "Checkout in progress",
    resaleStatusSold: "Sold",
    saving: "Saving…",
    sellBrowseAsAttendee: "Browse events as an attendee",
    sellClaimsEmpty: "No claims yet",
    sellClaimsEmptyDescription:
      "When someone claims one of your listings, it will show up here.",
    sellClaimsFailedToLoad: "Couldn't load claims: {error}",
    sellClaimsResponded: "Responded",
    sellClaimsSubtitle:
      "Review and respond to people claiming your resale listings.",
    sellClaimsTitle: "Claims",
    sellHubTitle: "Seller Hub",
    sellNavListings: "Listings",
    sellNavPayouts: "Payouts",
    sellNavClaims: "Claims",
    sellLoading: "Loading…",
    sellNewListingBackToListings: "Back to listings",
    sellNewListingNoOrders: "No eligible orders",
    sellNewListingNoOrdersDescription:
      "You don't have any tickets that can be listed for resale right now.",
    sellNewListingPickOrder: "Pick an order",
    sellNewListingPickOrderDescription:
      "Choose which order holds the tickets you want to list.",
    sellNewListingSubtitle: "List tickets you can't use for other fans to buy.",
    sellNewListingTitle: "New listing",
    sellReturnHome: "Return home",
    sellReturnToTickets: "Back to my tickets",
    sellSignInDescription: "Sign in to list and manage your resale tickets.",
    sellSignInRequired: "Sign in required",
    shareCopied: "Copied",
    shareCopy: "Copy",
    shareLink: "Shareable link",
    shareLinkCopied: "Link copied",
    shareLinkSelectEventPrompt: "Select an event to generate a link.",
    shareNoPromo: "No promo code",
    shareNoPublicPromos: "No public promo codes available.",
    shareOnlyPublicPromos: "Only public promo codes can be shared.",
    shareOpenLink: "Open",
    sharePromo: "Promo code",
    shareSelectEvent: "Event",
    shareSelectEventHint: "Pick the event you want to share.",
    shareSelectEventPlaceholder: "Select an event",
    shareWithEvent: "Share promo",
    tax: "Tax",
    transferReversalWarning:
      "This order was received through a transfer. Refunding it will reverse the transfer.",
    ttNameTaken: 'A ticket type named "{name}" already exists.',
    volunteerShiftComposerPresetHelp:
      "Start from a preset, then adjust the times and details.",
    volunteerShiftComposerRemoveDraft: "Remove draft",
    volunteerShiftComposerRepeatDaysConfirm: "Repeat",
    volunteerShiftComposerRepeatDaysCta: "Repeat across days",
    volunteerShiftComposerRepeatDaysPrompt:
      "How many days should this shift repeat?",
    volunteerShiftFieldCapacityHint:
      "How many volunteers you need for this shift.",
    volunteerSignupsAdminNotePrefix: "Admin note:",
    volunteerSignupsNotesColumn: "Notes",
    volunteerTemplateShiftAddCta: "Add shift",
    volunteerTemplateShiftCapacityLabel: "Capacity",
    volunteerTemplateShiftCapacityPlaceholder: "e.g. 4",
    volunteerTemplateShiftDayLabel: "Day",
    volunteerTemplateShiftDayMinus1: "1 day before",
    volunteerTemplateShiftDayMinus2: "2 days before",
    volunteerTemplateShiftDayPlus1: "1 day after",
    volunteerTemplateShiftDayPlus2: "2 days after",
    volunteerTemplateShiftDayZero: "Event day",
    volunteerTemplateShiftEndLabel: "End time",
    volunteerTemplateShiftFieldLabelLabel: "Shift name",
    volunteerTemplateShiftFieldLabelPlaceholder: "e.g. Setup",
    volunteerTemplateShiftFixErrors:
      "Fix the highlighted errors before saving.",
    volunteerTemplateShiftRemoveCta: "Remove shift",
    volunteerTemplateShiftStartLabel: "Start time",
    volunteerTemplateShiftsEmpty: "No shifts added yet.",
    volunteerTemplateShiftsFellBackToTodayMessage:
      "Some shift dates were in the past, so they were moved to today. Review the times before saving.",
    volunteerTemplateShiftsFellBackToTodayTitle: "Shift dates adjusted",
    volunteerTemplateShiftsHelp:
      "Define the shifts this template creates. Days are relative to the event date.",
    volunteerTemplateShiftsLabel: "Shifts",
    // ── Volunteer role packs (catalogue + shift anchors) ────────────────
    volunteerTemplatePlatformTag: "From Ithas Fire",
    volunteerTemplateCustomiseCta: "Customise",
    volunteerTemplateCustomised: "Customised",
    volunteerTemplateCustomisedMessage: '"{name}" is now yours to edit.',
    volunteerTemplateCustomiseFailed: "Couldn't customise this role",
    volunteerTemplateCustomiseRenameTitle: "Choose a different name",
    volunteerTemplateCustomiseRenameDescription:
      'You already have a template called "{name}". Give your copy another name and we\'ll keep both.',
    volunteerTemplateCustomiseRenameSuggestion: "{name} (copy)",
    volunteerTemplateCustomiseRenameUnchanged:
      "Pick a name you aren't already using.",
    volunteerTemplateShiftsSkippedTitle:
      "{count, plural, one {# shift wasn't scheduled} other {# shifts weren't scheduled}}",
    volunteerPackPickerTitle: "Start from a pack",
    volunteerPackPickerCta: "Start from a pack",
    volunteerPackPickerDone: "Done",
    volunteerPackPickerHelp:
      "Ready-made roles curated by Ithas Fire. Use them as they are, or customise a copy you can edit.",
    volunteerPackPickerEmpty: "No packs have been published yet.",
    volunteerPackRecommendedTag: "Recommended",
    volunteerShiftAnchorLabel: "Starts",
    volunteerShiftAnchorWallClock: "At a set clock time",
    volunteerShiftAnchorEventStart: "Relative to the event start",
    volunteerShiftAnchorEventEnd: "Relative to the event end",
    volunteerShiftAnchorOffsetLabel: "By",
    volunteerShiftAnchorOffsetHours: "Offset hours",
    volunteerShiftAnchorOffsetMinutes: "Offset minutes",
    volunteerShiftAnchorDirectionLabel: "Before or after",
    volunteerShiftAnchorDirectionBefore: "before",
    volunteerShiftAnchorDirectionAfter: "after",
    volunteerShiftAnchorDurationLabel: "Lasts",
    volunteerShiftAnchorDurationHours: "Duration hours",
    volunteerShiftAnchorDurationMinutes: "Duration minutes",
    volunteerShiftAnchorDurationRequired:
      "Enter a duration — the preview still shows the last saved one.",
    volunteerShiftAnchorUnitHours: "h",
    volunteerShiftAnchorUnitMinutes: "min",
    volunteerShiftAnchorPreviewLabel: "Resolves to",
    volunteerShiftAnchorPreviewIncomplete: "Set a time to see the preview.",
    volunteerShiftAnchorPreviewThisEvent: "This event",
    volunteerShiftAnchorSampleEvening: "8:00 PM show",
    volunteerShiftAnchorSampleMatinee: "2:00 PM matinee",
    volunteerShiftAnchorMissingEventStart:
      "This event has no start time, so a shift anchored to it can't be scheduled.",
    volunteerShiftAnchorMissingEventEnd:
      "This date has no end time, so a shift anchored to it can't be scheduled.",
    volunteerShiftAnchorComposerCta: "Time it from the event",
    volunteerShiftAnchorComposerApply: "Use these times",
    // ── Staff pack catalogue (/platform/volunteer-packs) ────────────────
    volunteerPacksTitle: "Volunteer packs",
    volunteerPacksSubtitle:
      "Ready-made volunteer roles Ithas Fire publishes to every organiser. Published packs change what organisers see immediately.",
    volunteerPacksLoading: "Loading packs…",
    volunteerPacksEmptyTitle: "No packs yet",
    volunteerPacksEmptyDescription:
      "Create one above. New packs start as drafts, so nothing reaches organisers until you publish.",
    volunteerPackCreateTitle: "New pack",
    volunteerPackCreateHelp:
      "Packs are created as drafts. You'll add roles and shift presets on the next screen.",
    volunteerPackCreateCta: "Create pack",
    volunteerPackCreated: "Pack created",
    volunteerPackFieldName: "Name",
    volunteerPackFieldNamePlaceholder: "e.g. House show",
    volunteerPackFieldKey: "Key",
    volunteerPackFieldKeyPlaceholder: "house-show",
    volunteerPackFieldKeyHelp:
      "Lowercase letters, numbers and single hyphens. Permanent — it's how seeds and links find this pack.",
    volunteerPackNameRequired: "Give the pack a name.",
    volunteerPackKeyInvalid:
      "Keys use lowercase letters, numbers and single hyphens, e.g. house-show.",
    volunteerPackStatusFilter: "Status",
    volunteerPackFilterAll: "All",
    volunteerPackStatusDraft: "Draft",
    volunteerPackStatusLive: "Live",
    volunteerPackRefresh: "Refresh",
    volunteerPackRetry: "Try again",
    volunteerPackPinned: "Pinned first",
    volunteerPackTargetsValue: "Targets {categories}",
    volunteerPackTargetsNone: "No category targeting",
    volunteerPackRolesMetric: "Roles",
    volunteerPackAdoptedMetric: "Adopted",
    volunteerPackAdoptedValue: "{count}×",
    volunteerPackEditCta: "Edit",
    volunteerPackBackToList: "All packs",
    volunteerPackNotFoundTitle: "Pack not found",
    volunteerPackNotFoundDescription:
      'No pack with the key "{key}" exists. It may have been deleted.',
    volunteerPackDetailsTitle: "Details",
    volunteerPackFieldBlurb: "Blurb",
    volunteerPackFieldBlurbPlaceholder:
      "One or two lines an organiser reads before picking this pack.",
    volunteerPackFieldSortOrder: "Sort order",
    volunteerPackFieldRankFirst: "Pin above other packs",
    volunteerPackTargetingTitle: "Targeting",
    volunteerPackTargetingHelp:
      "Categories this pack suits. Ranking only — every organiser still sees every live pack.",
    volunteerPackRolesTitle: "Roles",
    volunteerPackRolesHelp:
      "Roles are matched by name, so renaming one replaces it. Organisations that already customised the old name keep their copy.",
    volunteerPackRolesEmpty:
      "No roles yet. A pack with no roles shows nothing to organisers.",
    volunteerPackAddRoleCta: "Add role",
    volunteerPackRemoveRoleCta: "Remove role",
    volunteerPackRoleGroupLabel: "Role {position}",
    volunteerPackRoleNameLabel: "Role name",
    volunteerPackRoleNamePlaceholder: "e.g. Door",
    volunteerPackRoleCapacityLabel: "Default capacity",
    volunteerPackRoleDescriptionLabel: "Description",
    volunteerPackRoleDescriptionPlaceholder:
      "What this role actually does on the night.",
    volunteerPackShiftsEmpty:
      "No shift presets. The role can still be added to an event.",
    volunteerPackShiftNotesLabel: "Organiser note",
    volunteerPackShiftNotesPlaceholder:
      "Copied onto every shift made from this preset.",
    volunteerPackSaveCta: "Save pack",
    volunteerPackSaved: "Pack saved",
    volunteerPackUnsaved: "Unsaved changes",
    volunteerPackSortOrderInvalid:
      "Sort order must be a whole number from 0 to 9999.",
    volunteerPackRoleNameRequired: "Every role needs a name.",
    volunteerPackRoleNameDuplicate:
      'Two roles are both called "{name}". Role names must be unique within a pack.',
    volunteerPackRoleCapacityInvalid:
      '"{name}" needs a whole capacity of 1 or more, or none at all.',
    volunteerPackShiftInvalid:
      'Fix the shift presets on "{name}" before saving.',
    volunteerPackPublishCta: "Publish",
    volunteerPackUnpublishCta: "Unpublish",
    volunteerPackPublished: "Pack published to every organiser",
    volunteerPackUnpublished: "Pack unpublished",
    volunteerPackPublishBlockedUnsaved:
      "Save first — Publish ships the last saved version, not what's on screen.",
    volunteerPackStatusFailed: "Couldn't change the pack's status",
    volunteerPackDeleteCta: "Delete pack",
    volunteerPackDeleteConfirmTitle: "Delete this pack?",
    volunteerPackDeleteConfirmDescription:
      "The pack and its catalogue roles are removed for every organiser. Copies organisations already customised are kept.",
    volunteerPackDeleted: "Pack deleted",
    volunteerPackDeleteFailed: "Couldn't delete the pack",
    volunteerPackPreviewCta: "Preview as organiser",
    volunteerPackPreviewTitle: "As an organiser sees it",
    volunteerPackPreviewDone: "Close",
    volunteerPackPreviewDraftNote:
      "This pack is a draft — only staff can see it. This is exactly how it will read once published.",
    volunteerPackPreviewLiveNote:
      "This pack is live. Every organiser sees it exactly like this.",
    volunteerPackPreviewUnsaved:
      "Showing the last saved version — your unsaved edits aren't in this preview.",
    volunteerPackPreviewNoRoles:
      "The saved pack has no roles, so organisers see nothing at all — not even the pack name.",
    // ── Staff ticket-pack catalogue (/platform/ticket-packs) ────────────
    navPlatformTicketPacks: "Ticket packs",
    ticketPacksTitle: "Ticket packs",
    ticketPacksSubtitle:
      "Ready-made ticket setups Ithas Fire publishes to every organiser. Published packs change what organisers see immediately.",
    ticketPacksLoading: "Loading packs…",
    ticketPacksEmptyTitle: "No packs yet",
    ticketPacksEmptyDescription:
      "Create one above. New packs start as drafts, so nothing reaches organisers until you publish.",
    ticketPackCreateTitle: "New pack",
    ticketPackCreateHelp:
      "Packs are created as drafts. You'll add ticket templates on the next screen.",
    ticketPackCreateCta: "Create pack",
    ticketPackCreated: "Pack created",
    ticketPackFieldName: "Name",
    ticketPackFieldNamePlaceholder: "e.g. General admission",
    ticketPackFieldKey: "Key",
    ticketPackFieldKeyPlaceholder: "general-admission",
    ticketPackFieldKeyHelp:
      "Lowercase letters, numbers and single hyphens. Permanent — it's how seeds and links find this pack.",
    ticketPackNameRequired: "Give the pack a name.",
    ticketPackKeyInvalid:
      "Keys use lowercase letters, numbers and single hyphens, e.g. general-admission.",
    ticketPackStatusFilter: "Status",
    ticketPackFilterAll: "All",
    ticketPackStatusDraft: "Draft",
    ticketPackStatusLive: "Live",
    ticketPackRefresh: "Refresh",
    ticketPackRetry: "Try again",
    ticketPackTemplatesMetric: "Templates",
    ticketPackEntriesMetric: "Ticket types",
    ticketPackAdoptedMetric: "Customised",
    ticketPackAdoptedValue: "{count}×",
    ticketPackEditCta: "Edit",
    ticketPackBackToList: "All packs",
    ticketPackNotFoundTitle: "Pack not found",
    ticketPackNotFoundDescription:
      'No pack with the key "{key}" exists. It may have been deleted.',
    ticketPackEditorSubtitle:
      "Templates in this pack appear in every organiser's Apply-a-template dialog while the pack is live.",
    ticketPackMetadataTitle: "Details",
    ticketPackFieldSortOrder: "Sort order",
    ticketPackFieldBlurb: "Blurb",
    ticketPackFieldBlurbHelp:
      "One or two lines an organiser reads before picking this pack.",
    ticketPackTemplatesTitle: "Templates",
    ticketPackTemplatesHelp:
      "Templates are matched by name, so renaming one replaces it. Organisers who already customised the old name keep their copy. Prices are face price only — fees are added at checkout.",
    ticketPackTemplatesEmpty:
      "No templates yet. A pack with no templates shows nothing to organisers.",
    ticketPackAddTemplateCta: "Add template",
    ticketPackRemoveTemplateCta: "Remove template",
    ticketPackTplNameLabel: "Template name",
    ticketPackTplNameRequired: "Every template needs a name.",
    ticketPackTplEntriesRequired:
      "Every template needs at least one ticket type.",
    ticketPackEntryNameLabel: "Ticket type",
    ticketPackEntryNameRequired: "Every ticket type needs a name.",
    ticketPackEntryModeLabel: "Pricing",
    ticketPackEntryModeFixed: "Fixed price",
    ticketPackEntryModeAdjustable: "Pay what you can",
    ticketPackEntryPriceLabel: "Price ($)",
    ticketPackEntryDoorLabel: "Door price ($)",
    ticketPackEntryDoorPlaceholder: "Same as price",
    ticketPackEntryMinimumLabel: "Minimum ($)",
    ticketPackEntrySuggestedLabel: "Suggested ($)",
    ticketPackEntryCapacityLabel: "Capacity",
    ticketPackEntryTransferLabel: "Transfers allowed",
    ticketPackAddEntryCta: "Add ticket type",
    ticketPackRemoveEntryCta: "Remove ticket type",
    ticketPackEntryMoneyInvalid:
      '"{name}" has an amount that isn\'t a valid dollar value.',
    ticketPackEntryCapacityInvalid:
      '"{name}" needs a whole capacity of 1 or more.',
    ticketPackSaveCta: "Save pack",
    ticketPackSaving: "Saving…",
    ticketPackSaved: "Pack saved",
    ticketPackLiveEditWarning:
      "This pack is live — saved changes reach every organiser immediately. Events it was already applied to keep their ticket types.",
    ticketPackPublishCta: "Publish",
    ticketPackUnpublishCta: "Unpublish",
    ticketPackPublished: "Pack published to every organiser",
    ticketPackUnpublished: "Pack unpublished",
    ticketPackStatusFailed: "Couldn't change the pack's status",
    ticketPackPreviewCta: "Preview as organiser",
    ticketPackPreviewTitle: "As an organiser sees it",
    ticketPackPreviewHelp:
      "Showing the last saved version — unsaved edits aren't in this preview.",
    ticketPackPreviewClose: "Close",
    ticketPackDeleteCta: "Delete pack",
    ticketPackDeleteConfirmTitle: "Delete this pack?",
    ticketPackDeleteConfirmDescription:
      "The pack and its catalogue templates are removed for every organiser. Copies organisers already customised are kept, and events keep their ticket types.",
    ticketPackDeleted: "Pack deleted",
    ticketPackDeleteFailed: "Couldn't delete the pack",
    // ── Seller resale ──────────────────────────────────────────────────
    sellListingsTitle: "Your resale listings",
    sellListingsSubtitle:
      "Track live, sold, and closed listings with the finance snapshot saved to each listing.",
    sellListingsActive: "Active",
    sellListingsSold: "Sold",
    sellListingsExpiredCancelled: "Closed",
    sellListingsListTicket: "List ticket",
    sellListingsFailedToLoad: "Failed to load listings: {error}",
    sellListingsEmpty: "No listings yet",
    sellListingsEmptyDescription:
      "Your resale listings will appear here once you publish a ticket.",
    sellListingsEvent: "Event / Ticket",
    sellListingsAskPrice: "Ask price",
    sellListingsPricing: "Pricing",
    sellListingsFaceValue: "Face value",
    sellListingsFaceValueRow: "Face value: {amount}",
    sellListingsStatus: "Status",
    sellListingsStatusLive: "Live",
    sellListingsStatusLiveHint: "Visible to buyers until the cutoff or expiry.",
    sellListingsStatusHeld: "Checkout in progress",
    sellListingsStatusHeldHint:
      "A buyer is in checkout. The listing can return if the checkout expires.",
    sellListingsStatusSold: "Sold",
    sellListingsStatusSoldHint:
      "The listing sold. Release timing is tracked separately.",
    sellListingsStatusCancelled: "Cancelled",
    sellListingsStatusCancelledHint: "You removed this listing before sale.",
    sellListingsStatusExpired: "Sale window closed",
    sellListingsStatusExpiredHint:
      "The listing is no longer sellable under the event rules.",
    sellListingsStatusUnknown: "Unknown",
    sellListingsStatusUnknownHint: "Status details are not available.",
    sellListingsReleaseOrCutoff: "Release / Cutoff",
    sellListingsReleaseTargetHint: "Target release date",
    sellListingsReleaseTargetUnavailable: "Release target unavailable",
    sellListingsSaleCutoffHint: "Sale cutoff",
    sellListingsListingExpiryHint: "Listing expiry",
    sellListingsListedAt: "Listed",
    sellListingsExplainerTitle: "Finance rules",
    sellListingsExplainerBody:
      "Below-face losses stay with you, each resale pays the organizer the share they set for the event, the buyer pays the exact processing pass-through, and any release date shown is only a target date — not confirmation that funds were paid.",

    sellPayoutsTitle: "Release timeline",
    sellPayoutsSubtitle:
      "Expected release targets for sold resale listings. These dates do not prove that funds were paid.",
    sellPayoutsHowItWorks: "How this view works",
    sellPayoutsHowItWorksDescription:
      "We show the payout release target saved on each sold listing. Reaching that date means funds may be eligible for release, not that settlement is complete.",
    sellPayoutsTotalSales: "Sold listing volume",
    sellPayoutsTotalSalesNote:
      "Across {count, plural, one {# sold listing} other {# sold listings}}.",
    sellPayoutsCurrentPageSales: "Current page sales",
    sellPayoutsCurrentPageSalesNote:
      "Showing {shown} of {total} sold listings in this view.",
    sellPayoutsTimelineSummary: "Timeline summary",
    sellPayoutsTimelineSummaryPage: "Current page timeline",
    sellPayoutsTimelineSummaryNote:
      "Counts reflect {shown} visible listings out of {total} total sold listings.",
    sellPayoutsScheduledCount: "Scheduled / pending release: {count}",
    sellPayoutsReachedCount: "Release date reached: {count}",
    sellPayoutsAttentionCount: "Attention needed: {count}",
    sellPayoutsUnavailableCount: "Release date unavailable: {count}",
    sellPayoutsDelayNote:
      "Funds can stay delayed if payout setup or readiness is incomplete. Older release targets may need support or admin review.",
    sellPayoutsFailedToLoad: "Failed to load payout timeline: {error}",
    sellPayoutsNoSales: "No sold resale listings yet",
    sellPayoutsNoSalesDescription:
      "Sold resale listings will appear here once a buyer completes checkout.",
    sellPayoutsBuyerOrder: "Buyer order",
    sellPayoutsPricing: "Sale price",
    sellPayoutsFaceValueRow: "Face value: {amount}",
    sellPayoutsTimeline: "Release status",
    sellPayoutsTimelineScheduled: "Scheduled",
    sellPayoutsTimelineScheduledHint:
      "Pending release if payout readiness stays complete.",
    sellPayoutsTimelineReached: "Release date reached",
    sellPayoutsTimelineReachedHint:
      "Release date passed, but settlement may still be pending.",
    sellPayoutsTimelineAttention: "Attention needed",
    sellPayoutsTimelineAttentionHint:
      "Older than 60 days past target. This may need manual review.",
    sellPayoutsTimelineUnavailable: "Release date unavailable",
    sellPayoutsTimelineUnavailableHint:
      "No saved release target is available for this listing.",
    sellPayoutsReleaseTarget: "Release target",
    sellPayoutsListedAt: "Listed",

    // ── Navigation ─────────────────────────────────────────────────────
    navManage: "Manage",
    navDashboard: "Dashboard",
    navEvents: "Events",
    navPlaces: "Places",
    navBookings: "Bookings",
    navOrders: "Orders",
    navAudiences: "Audiences",
    navVolunteerTemplates: "Volunteer Roles",
    navApplicationFormTemplates: "Application Forms",
    navVolunteers: "Volunteers",
    navAnnouncements: "Announcements",
    navPayments: "Payments",
    navEmbeds: "Embeds",
    navFees: "Fees",
    navFeeWaivers: "Fee waivers",
    navTeam: "Team",
    navDelegates: "Delegates",
    navSell: "Sell",
    navScannerSetup: "Scanner Setup",
    navCardReaders: "Card Readers",
    navSearch: "Search",
    navSettings: "Settings",
    navGroupOverview: "Overview",
    navGroupProgramming: "Programming",
    navGroupSales: "Sales",
    navGroupAudience: "Audience",
    navGroupDoorCrew: "Door & Crew",
    navGroupPresence: "Presence",
    navGroupWorkspace: "Workspace",
    // ── Event-context rail (event-builder regroup FR-202) ──
    evNavAllEvents: "All events",
    evNavGroupBuild: "Build",
    evNavGroupManage: "Manage",
    evNavEssentials: "Essentials",
    evNavDetails: "Details",
    evNavTickets: "Tickets",
    evNavLineup: "Lineup",
    evNavSplits: "Revenue splits",
    evNavSettings: "Settings",
    // Mono micro-note on Manage items disabled until the event is published.
    evNavPostPub: "post-pub",
    // ── Place-context rail (place-admin-rail-context FR-201/FR-202) ──
    // Item labels reuse placeTab* / volunteering.placeTabVolunteers; these
    // are only the copy the rail adds.
    plNavAllPlaces: "All places",
    plNavGroupVenue: "Place",
    plNavGroupOperate: "Operate",
    // FR-401: one rail item for the merged venue settings page. It
    // replaces the separate Details (placeTabDetails) and Verification
    // (placeVerifHeading) items, whose surfaces are now sections of it.
    plNavSettings: "Settings",
    plNavPublicPage: "Public page",
    plNavSeatLayout: "Seat layout",
    // ── Dashboard ──────────────────────────────────────────────────────
    loadingDashboard: "Loading dashboard...",
    whatsHappening: "Here's what's happening with your events.",
    totalOrders: "Total Orders",
    pendingPayout: "Pending Payout",
    recentOrdersStat: "Recent Orders",
    upcomingEventsStat: "Upcoming events",
    tonight: "Tonight",
    nextUp: "Next up",
    thisWeek: "This week",
    showFullCalendar: "Show full calendar",
    hideFullCalendar: "Hide full calendar",
    quickActions: "Quick Actions",
    createEvent: "Create Event",
    createEventDescription: "Set up a new event with tickets",
    managePlaces: "Manage Places",
    managePlacesDescription: "Add or edit your places",
    viewOrders: "View Orders",
    viewOrdersDescription: "See all ticket purchases",
    // ── Scan Ticket ────────────────────────────────────────────────────
    scanTicket: "Scan Ticket",
    scanTicketDescription:
      "Look up attendees by name or scan QR codes to validate entry.",
    scanTicketQuickDescription: "Validate tickets at the door",
    scanSelectEvent: "Select Event",
    scanManualEntry: "Look Up",
    scanCameraMode: "Camera",
    scanEnterCode: "Ticket Code",
    scanSubmit: "Scan",
    scanProcessing: "Processing...",
    scanPointCamera: "Point your camera at a ticket QR code",
    scanNext: "Scan Next",
    scanAccepted: "Ticket Accepted",
    scanReplay: "Already Scanned",
    scanRejected: "Ticket Rejected",
    scanSearchPlaceholder: "Search by attendee name or email...",
    scanSearching: "Searching...",
    scanNoResults: "No tickets found",
    scanNoResultsHint: "Try a different name or email address.",
    scanSearchHint: "Type at least 2 characters to search across all events.",
    scanSelectTicket: "Select a ticket to scan",
    scanTicketValid: "Valid",
    scanTicketScanned: "Scanned",
    scanTicketForEvent: "for {event}",
    scanConfirmTitle: "Confirm Scan",
    scanConfirmBody: "Scan this ticket for {name}?",
    scanConfirmSubmit: "Confirm Scan",
    scanOwnerLabel: "Attendee",
    scanEventLabel: "Event",
    scanTypeLabel: "Type",
    scanSeatLabel: "Seat",
    scanStatusLabel: "Status",
    recentOrders: "Recent Orders",
    viewAll: "View all",
    noOrdersYet: "No orders yet",
    ordersWillAppear:
      "Orders will appear here once customers start purchasing tickets.",
    orderNumber: "Order #{id}",
    // ── Payments ───────────────────────────────────────────────────────
    payments: "Payments",
    paymentsDescription:
      "Manage your Stripe Connect account and track payouts.",
    loadingPayments: "Loading payment settings...",
    loadingAnnouncements: "Loading announcements…",
    loadingEmbeds: "Loading embeds…",
    loadingPlaces: "Loading places…",
    loadingPromos: "Loading promos…",
    loadingScannerSetup: "Loading scanner setup…",
    loadingTeam: "Loading team…",
    loadingVolunteerTemplates: "Loading volunteer templates…",
    refresh: "Refresh",
    stripeDashboard: "Stripe Dashboard",
    stripeStatus: "Stripe Status",
    stripeActive: "Active",
    stripeIncomplete: "Incomplete",
    stripeNotConnected: "Not connected",
    pendingPayoutLabel: "Pending Payout",
    nItems: "{count, plural, one {# item} other {# items}}",
    accountId: "Account ID",
    stripeConnect: "Stripe Connect",
    connected: "Connected",
    notConnectedLabel: "Not connected",
    connectDescription:
      "Connect your Stripe account to start accepting payments and receiving payouts. Stripe Express provides a streamlined onboarding experience with automatic identity verification.",
    startingOnboarding: "Starting...",
    setupStripeConnect: "Set up Stripe Connect",
    paySetupRequired: "Payment setup required",
    onboardingIncomplete: "Onboarding incomplete",
    onboardingIncompleteDescription:
      "Your Stripe account is connected but needs additional information before you can accept payments.",
    chargesEnabled: "Charges enabled",
    payoutsEnabled: "Payouts enabled",
    payoutsBlockedTransfers:
      "Stripe hasn\u2019t cleared this account to receive transfers yet. Stripe checks this apart from payments, so its dashboard can look fine meanwhile. Finish any verification Stripe asks for; if none is outstanding, contact support.",
    payoutsBlockedRestricted:
      "This payout account was disconnected from Ithas Fire and is still restricted on our side. Reconnecting won\u2019t clear it; contact support and we\u2019ll reset it.",
    detailsSubmitted: "Details submitted",
    remainingRequirements: "Remaining requirements:",
    continueOnboarding: "Continue onboarding",
    accountFullySetUp: "Account fully set up",
    accountActiveDescription:
      "Your Stripe Connect account is active. You can accept payments and receive payouts.",
    failedToLoadStripe:
      "Failed to load Stripe Connect status. Please try refreshing.",
    onboardingFailed: "Onboarding failed",
    // ── Fees ───────────────────────────────────────────────────────────
    feesTitle: "Default Global Fee Policy",
    feesDescription:
      "The effective global fee policy applied to every ticket transaction. Event organizers choose the fee mode (absorb / pass-through) per-event in the event builder.",
    feesLoading: "Loading fee policy...",
    feesLoadError: "Could not load the fee policy",
    feesEmptyTitle: "No global fee policy",
    feesEmptyBody:
      "The GLOBAL policy row has not been written yet. It is materialized from code by the deploy-time reconciler, so it appears after the next deploy.",
    feesCodeDefinedTitle: "Defined in code",
    feesCodeDefinedBody:
      "This policy is not editable here. It is declared in code and the database row is reconciled on every deploy, so changing a number ships like a migration.",
    feesCodeDefinedSourceLabel: "Source of truth",
    feesDefaultPolicy: "Effective Policy",
    feesDefaultPolicyHint:
      "These rates become the default for every new event unless overridden at the group or event level.",
    feesFormulaLabel: "Per-ticket formula",
    feesPolicyVersion: "Policy version",
    feesNoCap: "No cap",
    feesBuyerFeePct: "Platform Fee",
    feesBuyerFeePctHint:
      "Percentage of ticket face value charged as the platform fee.",
    feesMaxFeeCents: "Cap per ticket",
    feesMaxFeeCentsHint:
      "The most the platform fee can reach on a single ticket.",
    feesMinFeeCents: "Minimum Fee",
    feesMinFeeCentsHint:
      "Floor for the platform fee on a paid ticket, applied after the cap and the fixed component. A $0 ticket pays no fee.",
    feesPlatformFixedCents: "Platform Fixed Fee",
    feesPlatformFixedCentsHint:
      "Fixed per-ticket amount added on top of the capped percentage. Not charged on a $0 ticket.",
    feesMaxPlatformFeeCents: "Cap per order",
    feesMaxPlatformFeeCentsHint:
      "Ceiling on the total platform fees of one order, across all its tickets.",
    feesProcessorRates: "Processor Rates (Stripe)",
    feesProcessorRatesReadonly:
      "Set by Stripe. These values are read-only and carried forward automatically.",
    feesProcessorFeePct: "Processor Fee",
    feesProcessorFeePctHint: "Stripe's percentage rate.",
    feesProcessorFixedCents: "Processor Fixed Fee",
    feesProcessorFixedCentsHint: "Stripe's fixed per-transaction fee.",
    feesPreviewControls: "What-if inputs",
    feesProjectionInputsNote:
      "Local to this page. Nothing you type here is saved or applied to anything.",
    feesCentsUnit: "cents",
    feesOnTicketOf: "on a ticket of",
    feesTicketsPerMonth: "tickets/mo",
    feesModeComparison: "Fee breakdown",
    feesModeComparisonHint:
      "What a buyer pays on top of the ticket price above, with fees added on top.",
    feesPassThroughLabel: "Pass-Through",
    feesPassThroughDesc: "Buyer pays the ticket price plus all fees on top.",
    feesOrganiserNet: "Organizer Net",
    feesProjection: "Revenue Projection",
    feesProjectionHint:
      "Estimated platform revenue based on theoretical ticket volumes and the current fee settings. Hover over bars for details.",
    feesTicketPrice: "Ticket Price",
    feesMonthlySales: "Monthly Sales",
    feesPerTicket: "Per Ticket",
    feesPlatformFee: "Platform Fee",
    feesProcessorFee: "Processor Fee",
    feesBuyerTotal: "Buyer Total",
    feesMonthlyRevenue: "Monthly Platform Revenue",
    feesAnnualRevenue: "Annual Projection",
    feesExamplesTitle: "Low-Price Examples",
    feesExamplesHint:
      "Fee breakdown for $1 and $5 tickets with the current policy.",
    feesExampleTicket: "Ticket",
    // ── Orders table ──────────────────────────────────────────────────
    orders: "Orders",
    ordersTab: "Orders",
    settlementsTab: "Settlements",
    loading: "Loading...",
    loadingOrders: "Loading orders...",
    ordersOrgOnly: "Orders require a group",
    ordersOrgOnlyDescription:
      "The Orders view is available for group accounts. Switch to a group dashboard to view order history.",
    ordersUnavailable: "Orders unavailable",
    ordersUnavailableDescription:
      "We couldn't resolve an admin workspace for this orders view. Switch contexts or refresh and try again.",
    failedToLoadOrders: "Failed to load orders: {error}",
    // The predicate has matched order identifiers since FR-012
    // (`orderSearchWhere` ORs the buyer arm with the id/tail arms), but this
    // string still promised only buyer fields — so nobody pasted a code here.
    searchBuyerPlaceholder: "Search by buyer, email, or order code...",
    clearFilters: "Clear filters",
    noMatchingOrders: "No matching orders",
    noMatchingOrdersDescription: "Try adjusting your search or filters.",
    noMatchingEvents: "No matching events",
    noMatchingEventsDescription: "Try adjusting your search or filters.",
    noMatchingMembers: "No matching members",
    noMatchingMembersDescription: "Try adjusting your search.",
    noOrdersYetTable: "No orders yet",
    noOrdersYetTableDescription:
      "Orders will appear here once customers purchase tickets.",
    date: "Date",
    buyer: "Buyer",
    unknownBuyer: "Unknown",
    event: "Event",
    amount: "Amount",
    platformFee: "Platform Fee",
    status: "Status",
    previous: "Previous",
    next: "Next",
    pageOf: "Page {page} of {total}",
    nOfTotal: "{start}\u2013{end} of {total}",
    noOrders: "No orders",
    // ── Order status labels ───────────────────────────────────────────
    statusPending: "Pending",
    statusSucceeded: "Succeeded",
    statusPartialRefund: "Partial Refund",
    statusRefunded: "Refunded",
    statusDisputed: "Disputed",
    statusCancelled: "Cancelled",
    // ── Order detail panel ────────────────────────────────────────────
    close: "Close",
    orderNotFoundPanel: "Order not found",
    viewInStripe: "View in Stripe",
    heldLabel: "Held:",
    paidOutLabel: "Paid out:",
    refundedLabel: "Refunded:",
    disputeBanner: "This order is disputed",
    disputeDescription:
      "The buyer has opened a dispute with their payment provider. Funds are frozen until the dispute is resolved. Review the dispute in your Stripe Dashboard and submit evidence before the deadline.",
    viewDisputeInStripe: "View dispute in Stripe",
    nTicketsLabel: "Tickets ({count})",
    deselectAll: "Deselect all",
    selectAllRefundable: "Select all refundable ({count})",
    ticketColumn: "Ticket",
    priceColumn: "Price",
    payoutColumn: "Payout",
    itemActive: "Active",
    itemRefunded: "Refunded",
    itemTransferred: "Transferred",
    held: "Held",
    quoteRefund:
      "Quote refund ({count, plural, one {# ticket} other {# tickets}})",
    refundQuote: "Refund quote",
    stripeFeeLabel: "Payment processing fee: {amount}",
    totalRefund: "Total refund",
    noteOptional: "Note (optional)",
    refundNoteRequired: "Reason for refund (required)",
    refundNoteTooShort: "Please enter a reason between 3 and 500 characters.",
    refundWholeOrder: "Refund whole order",
    resaleRefundExplainer:
      "Resale orders are refunded whole: the buyer gets their money back and the ticket returns to the seller.",
    confirmFullRefund: "Confirm full refund",
    // Refund confirm, when a ticket the refund voids was already scanned in
    // (owner ruling 2026-10-10: that refund means the person has left).
    // `One` is a one-ticket refund; `Several` counts the scanned tickets
    // among the several being refunded.
    refundScannedInOne:
      "This ticket was scanned in. Refunding it marks the person as having left: the ticket stops working and goes back on sale.",
    refundScannedInSeveral:
      "{count, plural, one {# of these tickets was scanned in. Refunding it marks that person as having left: the tickets stop working and go back on sale.} other {# of these tickets were scanned in. Refunding them marks those people as having left: the tickets stop working and go back on sale.}}",
    // The whole-order refund of a RESALE order: the ticket is not voided, it
    // returns to the seller, so it never reads "back on sale".
    refundScannedInResale:
      "This ticket was scanned in. Refunding the order marks the person as having left, and the ticket goes back to the seller.",
    refundReasonPlaceholder: "Reason for refund...",
    processingRefund: "Processing refund...",
    noTicketsEligible:
      "No tickets are eligible for refund. Tickets may have already been refunded, paid out, or transferred.",
    orderDetail: "Order Detail",
    total: "Total",
    // Order detail money: what the buyer paid, line by line, and what the
    // sale credited the event (owner ruling 2026-10-11: the buyer pays the
    // platform fee on top, the event is credited the full price; sales
    // stamped from 12 October 2026). Payout terms may divide the credit.
    odBuyerPaid: "Buyer paid",
    odOrderTotal: "Order total",
    odNothingCharged: "Nothing was charged.",
    odPaymentProcessing:
      "Payment still processing. The buyer's bank has not settled it yet.",
    odTicketPrice: "Ticket price",
    odPlatformFee: "Platform fee",
    odProcessingFee: "Processing fee",
    odTax: "Tax",
    odBuyerCredit: "Credit applied",
    odEventCredit: "Credited to the event",
    odNotCreditedYet: "Not credited yet",
    odCreditUnavailable: "Credit could not be loaded",
    odExpectedCredit: "Expected credit",
    odPayoutTermsDivide:
      "The event's payout terms divide it among {count} payees.",
    odNoBuyerLines: "No line-by-line record for this sale.",
    odPlatformFeeTakenFromPrice: "Platform fee, taken from the price",
    odFullPrice: "The full ticket price.",
    odFullPriceCredited:
      "The full ticket price. The buyer paid the platform fee on top.",
    odRefundLessProcessingFee:
      "The refund is this amount less the payment processing fee, which the payment processor keeps.",
    calculatingRefund: "Calculating refund...",
    couldNotLoadQuote: "Could not load refund quote: {error}",
    notEligible: "Not eligible",
    confirmRefund: "Confirm Refund",
    cancel: "Cancel",
    retry: "Retry",
    viewDetails: "View details",
    itemFallback: "Item",
    transfer: "Transfer",
    // ── Order detail enrichment ───────────────────────────────────────
    odPaymentMethod: "Payment Method",
    odSource: "Source",
    odPromo: "Promo",
    odBillingAddress: "Billing Address",
    odParentOrder: "Parent Order",
    odScanColumn: "Scan",
    odSeat: "Seat",
    odOwner: "Owner",
    odNotScanned: "Not scanned",
    odFeePolicySnapshot: "Fee Policy Snapshot",
    odFeeMode: "Mode",
    odBuyerFeePct: "Buyer Fee %",
    odPlatformFixed: "Platform Fixed",
    odProcessorRate: "Processor Rate",
    odFeeRange: "Fee Range",
    odStripeRefs: "Stripe References",
    odStripePI: "Payment Intent",
    odStripeTaxCalc: "Tax Calculation",
    // ── Door cash sales in the order panel (door-sales step 9b) ────────
    odCashAtDoor: "Cash at the door",
    odComp: "Comp",
    odFreeWithCode: "Free with {code}",
    odCashRefundTitle: "Refund cash sale",
    odCashRefundBody:
      "Hand the buyer back {amount} in cash. Their tickets stop working and go back on sale.",
    odCashRefundBodyZero:
      "Nothing was paid, so there\u2019s no cash to hand back. Their tickets stop working and go back on sale.",
    odCashRefundDebitNote:
      "You no longer owe Ithas Fire the {amount} this sale carried. If a payout already took it, it goes back on your balance.",
    odCashRefundConfirm: "Refund {amount}",
    odCashRefundConfirmZero: "Void sale",
    odCashRefundNotePlaceholder: "Why, for the record",
    odCashRefundWindowOpen:
      "Owners, Admins and Finance can refund this sale here until {date}. Editors can refund it from Sell until the same date, while the event is still published.",
    odCashRefundWindowClosed:
      "The refund window closed on {date}, seven days after the event ended. Contact support to refund this sale.",
    odContactSupport: "Contact support",
    odCashRefundDone: "Refunded. Hand {amount} back to the buyer.",
    odCashRefundDoneZero: "Voided. Their tickets no longer work.",
    odCashRefundAlreadyDone: "This sale was already refunded.",
    loadingEvents: "Loading events...",
    untitledEvent: "Untitled Event",
    // ── Settlements ───────────────────────────────────────────────────
    settlementsOrgOnly: "Settlements are only available for groups.",
    filters: "Filters",
    clear: "Clear",
    settlementId: "ID",
    settlementEvent: "Event",
    settlementAmount: "Amount",
    settlementStatus: "Status",
    settlementLines: "Lines",
    payoutDate: "Payout Date",
    transferId: "Transfer ID",
    created: "Created",
    settlementPending: "Pending",
    settlementTransferred: "Transferred",
    settlementFailed: "Failed",
    // ── Events manager ────────────────────────────────────────────────
    myEvents: "My Events",
    searchEventsPlaceholder: "Search events...",
    filter: "Filter",
    nOfTotalEvents: "{count} of {total} events",
    actions: "Actions",
    noEventsYet: "No events yet",
    getStartedEvents: "Get started by creating your first event.",
    createFirstEvent: "Create your first event",
    failedToLoadEvents: "Failed to load events: {error}",
    retryLoad: "Retry",
    unableToDetermineOwner: "Unable to determine owner context.",
    createFailed: "Create failed",
    viewTooltip: "View",
    attendeesTooltip: "Attendees",
    editTooltip: "Edit",
    shareEvent: "Share event",
    cancelEvent: "Cancel Event",
    deleteEvent: "Delete Event",
    deletingEvent: "Deleting...",
    cancelScopeThisOnly: "Cancel this event only",
    cancelScopeThisAndFuture: "Cancel this and all future events",
    cancelScopeAll: "Cancel all events in the series",
    cancelScopeThisOnlyDesc:
      "Only this event will be cancelled. Ticket holders will be refunded.",
    cancelScopeThisAndFutureDesc:
      "This event and all future events in the series will be cancelled. All affected ticket holders will be refunded.",
    cancelScopeAllDesc:
      "Every event in the series will be cancelled and the series will be archived. All ticket holders will be refunded.",
    eventColumn: "Event",
    statusColumn: "Status",
    attendeesColumn: "Attendees",
    dateColumn: "Date",
    createdColumn: "Created",
    // ── Event ops surface purpose lines (EventOpsShell) ────────────────
    opsApplicationsPurpose:
      "Everyone who has applied to this event. Approve an applicant to let them buy a ticket, or reject the request.",
    opsAttendeesPurpose:
      "Everyone holding a ticket to this event. Search by name or email, or filter to the orders that need reconciling.",
    opsVolunteersPurpose:
      "Set up the roles and shifts you need filled, then review who signed up.",
    opsVolunteerSetupPurpose:
      "Turn volunteering on for this event and choose how signups are handled.",
    opsVolunteerRolesPurpose:
      "The jobs you need covered, and the shifts people can claim.",
    opsVolunteerSignupsPurpose:
      "Approve or decline the people who signed up, and check them in on the day.",
    opsVolunteerRewardsPurpose:
      "Complimentary tickets earned by volunteering, and who has been granted one.",
    opsCompTicketsPurpose:
      "Issue complimentary tickets. Recipients get an email with their QR codes straight away.",
    opsDatesPurpose:
      "Every occurrence in this series. Publish, skip or add dates one at a time.",

    // ── Comp tickets ledger ───────────────────────────────────────────
    // The surface is now a LEDGER of what has already been comped; issuing
    // moved into a dialog. `opsCompTicketsPurpose` above still describes the
    // act of issuing and is reused as the dialog's subtitle.
    compTicketsTitle: "Comp tickets",
    opsCompTicketsLedgerPurpose:
      "Every complimentary ticket for this event — who received it, why, and who issued it.",
    compIssueAction: "Issue comps",
    // Deliberately NOT the same string as `compIssueAction`: both buttons are
    // on screen together in the empty state, and two controls sharing one
    // accessible name is ambiguous for screen-reader and voice-control users.
    compIssueFirstAction: "Issue the first comp",
    compIssueDialogTitle: "Issue comp tickets",
    nComps: "{count, plural, one {# comp} other {# comps}}",
    compRecipientColumn: "Recipient",
    compTicketTypeColumn: "Ticket type",
    // "Qty", not "Tickets": this counts the ticket LINES that were ordered,
    // which is not the same as the live ticket count the attendee table shows
    // for the same order (a revoked reward keeps its line).
    compQuantityColumn: "Qty",
    compOriginColumn: "Origin",
    compReasonColumn: "Reason",
    compIssuedByColumn: "Issued by",
    compUnknownRecipient: "Unknown recipient",
    compTicketTypeUnnamed: "Ticket type unavailable",
    // ── Origin (server-derived; never inferred from a null reason) ──
    compOriginHandIssued: "Hand-issued",
    compOriginVolunteerReward: "Volunteer reward",
    // ── The three null-reason states, which must never read alike ──
    // VOLUNTEER_REWARD: no reason exists and none ever will. Not missing data.
    compReasonEarnedByVolunteering: "Earned by volunteering",
    // HAND_ISSUED with a known issuer: modern comp, reason left blank.
    compReasonNoneGiven: "No reason given",
    // HAND_ISSUED with NO issuer: predates the provenance columns entirely.
    compReasonPredatesTracking: "Issued before reasons were recorded",
    // ── Issuer states ──
    compIssuerAutomatic: "Granted automatically",
    // Covers both "the account no longer resolves" and "the account has no
    // name" — never asserts that someone was deleted.
    compIssuerNameUnavailable: "Name unavailable",
    compIssuerNotRecorded: "Not recorded",
    // ── Issue dialog (fields relocated from the old page-level form) ──
    compIssueRecipientEmailLabel: "Recipient email *",
    compIssueRecipientEmailPlaceholder: "recipient@example.com",
    compIssueRecipientNameLabel: "Recipient name",
    compIssueOptionalPlaceholder: "Optional",
    compIssueTicketTypeLabel: "Ticket type *",
    compIssueNoTicketTypes: "No ticket types available for this event.",
    compIssueQuantityLabel: "Quantity *",
    compIssueReasonLabel: "Reason",
    compIssueReasonPlaceholder: "e.g., Volunteer, Speaker, VIP",
    compIssueSubmit: "Issue tickets",
    compIssuedToast: "Comp tickets issued",
    compIssuedBanner:
      "{count, plural, one {# ticket issued to {email}} other {# tickets issued to {email}}}",
    compIssuedBannerDismiss: "Dismiss",
    compNoneYetTitle: "No comps issued yet",
    compNoneYetDescription:
      "Complimentary tickets you issue — and any earned by volunteering — will be listed here.",
    compNoMatchesTitle: "No comps of this kind",
    // The ledger loads in ONE request (the server caps a page at 200) so the
    // origin filter and the column sort work over every comp rather than over
    // whichever page happened to be on screen. Past the cap, say so.
    compLedgerCapped: "Showing the first {count} of {total} comps.",
    compLoadFailed: "Couldn't load the comp ledger",

    // ── Attendees ─────────────────────────────────────────────────────
    attendees: "Attendees",
    backToEvents: "Back to events",
    nAttendees: "{count, plural, one {# attendee} other {# attendees}}",
    searchAttendeesPlaceholder: "Search by name or email...",
    nameColumn: "Name",
    emailColumn: "Email",
    ticketCount: "Tickets",
    amountColumn: "Amount",
    // The card-mode counterpart of the `ticketCount` COLUMN HEADER above: a
    // card has no header row, so the unit has to travel with the number.
    attendeeTicketCountLabel:
      "{count, plural, one {# ticket} other {# tickets}}",
    // Marks a $0 order that was comped rather than genuinely free.
    attendeeCompBadge: "Comp",
    // Row-context accessible names for the attendee row expander. A bare
    // "Expand details" put FOUR identically-named controls on one page, which
    // a screen-reader or voice user cannot distinguish. `{code}` rides along
    // unconditionally because two orders from the same buyer are ordinary.
    attendeeExpandDetailsFor: "Show details for {name}, order {code}",
    attendeeCollapseDetailsFor: "Hide details for {name}, order {code}",
    // `buyerName` and `buyerEmail` are both nullable — this keeps the label
    // from ever reading "Show details for null".
    attendeeUnnamedBuyer: "this attendee",
    attendeesExportCsv: "Export CSV",
    attendeesExportFailed: "Couldn't export the attendee list",
    attendeesExportTruncatedTitle: "Export was capped",
    attendeesExportTruncatedBody:
      "Downloaded the first {count} of {total} attendees. Narrow the filters to export the rest.",
    // Empty state for a status-chip filter, which has no query to quote back.
    noAttendeesForFilters: "No orders match the selected status.",
    failedToLoadAttendees: "Failed to load attendees: {error}",
    attendeesOrgOnly: "Attendee search is only available for group events.",
    searching: "Searching...",
    nResults: "{count, plural, one {# result} other {# results}}",
    noAttendeesYet: "No attendees yet",
    noAttendeesDescription:
      "Attendees will appear here once tickets are purchased.",
    noMatchingAttendees: "No matches",
    noMatchesForQuery:
      'No buyers found matching "{query}". Try a different name or email.',
    clearSearch: "Clear search",
    ticketsPurchased: "Tickets purchased",
    failedToLoadDetails: "Could not load order details.",
    orderTotal: "Total",
    collapseDetails: "Collapse details",
    expandDetails: "Expand details",
    // ── Applications ──────────────────────────────────────────────────
    applications: "Applications",
    filterAll: "All",
    filterPending: "Pending",
    filterApproved: "Approved",
    filterRejected: "Rejected",
    filterWaitlisted: "Waitlisted",
    filterWithdrawn: "Withdrawn",
    filterExpired: "Expired",
    // Singular badge labels — separate from the (grammatically plural in
    // Spanish) filter-chip labels above, so a single row's badge never
    // reads "Aprobadas".
    statusBadgePending: "Pending",
    statusBadgeApproved: "Approved",
    statusBadgeRejected: "Rejected",
    statusBadgeWaitlisted: "Waitlisted",
    statusBadgeWithdrawn: "Withdrawn",
    statusBadgeExpired: "Expired",
    anonymous: "Anonymous",
    reviewedAt: "Reviewed {date}",
    applicantColumn: "Applicant",
    appliedColumn: "Applied",
    collapseAnswers: "Collapse answers",
    viewAnswers: "View answers",
    approve: "Approve",
    reject: "Reject",
    rescind: "Rescind",
    applicationApproved: "Application approved",
    applicationApprovedMessage:
      "The applicant has been notified and can now purchase tickets.",
    failedToApprove: "Failed to approve",
    applicationRejected: "Application rejected",
    applicationRejectedMessage: "The applicant has been rejected.",
    failedToReject: "Failed to reject",
    applicationRejectReasonLabel: "Reason shared with the applicant (optional)",
    applicationRejectReasonPlaceholder: "Add a short note for the applicant…",
    applicationRejectReasonHint:
      "If provided, this note is included in the rejection email.",
    applicationRejectConfirm: "Reject application",
    applicationRejectionReason: "Rejection reason",
    waitlistDecision: "Waitlist",
    applicationWaitlistConfirmTitle: "Move to waitlist?",
    applicationWaitlistConfirmBody:
      "The applicant is placed on this event's waitlist and gets a neutral notification. You can still approve or reject them later.",
    applicationWaitlistConfirm: "Move to waitlist",
    applicationWaitlisted: "Application waitlisted",
    applicationWaitlistedMessage:
      "The applicant has been placed on the waitlist.",
    failedToWaitlist: "Failed to waitlist",
    decisionRescinded: "Decision rescinded",
    decisionRescindedMessage:
      "The submission has been returned to pending status.",
    failedToRescind: "Failed to rescind",
    searchEmailPhonePlaceholder: "Search by email or phone...",
    nApplicationResults: "{count, plural, one {# result} other {# results}}",
    nApplications:
      "{count, plural, one {# application} other {# applications}}",
    noApplicationMatches: "No matches",
    noStatusApplications: "No {status} applications",
    noApplicationsYet: "No applications yet",
    noApplicationsMatchingQuery: 'No applications matching "{query}".',
    applicationsWillAppear:
      "Applications will appear here once attendees apply for access.",
    // ── Team / Delegates ──────────────────────────────────────────────
    team: "Team",
    delegates: "Delegates",
    noAccountContext: "No account context found.",
    teamLoadFailed: "Failed to load members: {error}",
    nMembers: "{count, plural, one {# member} other {# members}}",
    nDelegates: "{count, plural, one {# delegate} other {# delegates}}",
    noTeamMembersYet: "No team members yet.",
    searchTeamPlaceholder: "Search members...",
    noDelegatesYet:
      "No delegates yet. Add someone you trust to help manage your events.",
    addMember: "Add Member",
    addTeamMemberHeading: "Add a team member",
    addTeamMemberDescription:
      "Enter an email address and we'll send an invitation. They join the team once they accept it.",
    emailLabel: "Email",
    emailPlaceholder: "member@example.com",
    roleLabel: "Role",
    addButtonBusy: "Adding...",
    addButton: "Add",
    addDelegate: "Add delegate",
    addDelegateHeading: "Add a delegate",
    addDelegateDescription:
      "Enter their email and we'll make an invitation link for you to send them. They get the role you pick once they open the link, signed in with that email.",
    delegateAdded: "Delegate added",
    delegateInviteCreate: "Create invite link",
    delegateInviteReady: "Invite link ready",
    delegateInviteReadyDescription:
      "Send this link to {email}. It works once, only for that email address, and expires in 7 days.",
    delegateInviteLinkLabel: "Delegate invite link",
    delegateInviteCopy: "Copy link",
    delegateInviteCopied: "Copied",
    noAccountFoundEmail: "No account found with that email address.",
    invitationSent: "Invitation sent",
    invitationSentMessage: "An invitation has been sent to {email} as {role}.",
    memberAdDirectly: "Member added directly",
    pendingInvitations: "Pending Invitations",
    pendingInvitationsDescription:
      "People who have been invited but haven't accepted yet.",
    noPendingInvitations: "No pending invitations.",
    invitedBy: "Invited by",
    expiresOn: "Expires {date}",
    revokeInvitation: "Revoke",
    revokeInvitationConfirm: "Revoke invitation to {email}?",
    invitationRevoked: "Invitation revoked",
    failedToRevokeInvitation: "Failed to revoke invitation",
    invitationStatusPending: "Pending",
    invitationStatusAccepted: "Accepted",
    invitationStatusExpired: "Expired",
    invitationStatusRevoked: "Revoked",
    roleUpdated: "Role updated",
    failedToUpdateRole: "Failed to update role",
    removeMemberConfirm: "Remove {name} from the team?",
    memberRemoved: "Member removed",
    delegateRemoved: "Delegate removed",
    failedToRemoveMember: "Failed to remove member",
    failedToRemoveDelegate: "Failed to remove delegate",
    removeMemberLabel: "Remove member",
    thisMember: "this member",
    thisDelegate: "this delegate",
    joinedColumn: "Joined",
    roleOwner: "Owner",
    roleAdmin: "Admin",
    roleEditor: "Editor",
    roleFinance: "Finance",
    roleScanner: "Scanner",
    roleViewer: "Viewer",
    transferOwnership: "Transfer Ownership",
    transferOwnershipDescription:
      "Make another member an Owner. You become an Admin.",
    selectMember: "Select a member\u2026",
    ownershipTransferred: "Ownership transferred",
    youAreNowAdmin: "You are now an Admin.",
    transferFailed: "Transfer failed",
    transferConfirmMessage:
      "{name} becomes an Owner and you become an Admin. Only an Owner can make you an Owner again.",
    transferring: "Transferring\u2026",
    confirmTransfer: "Confirm Transfer",
    memberAdded: "Member added",
    memberAddedMessage: "{name} has been added as {role}.",
    // ── Promos ─────────────────────────────────────────────────────────
    navPromos: "Promos",
    // ── Memberships (nav label; page copy lives in adminMemberships.*) ──
    navMemberships: "Memberships",
    cpCodeColumn: "Code",
    cpTypeColumn: "Type",
    cpValueColumn: "Value",
    cpStatusColumn: "Status",
    cpRedemptionsColumn: "Redemptions",
    cpExpiryColumn: "Expiry",
    cpScopeColumn: "Scope",
    cpPercent: "Percent",
    cpFixed: "Fixed amount",
    cpActive: "Active",
    cpArchived: "Archived",
    cpExpired: "Expired",
    cpNoExpiry: "No expiry",
    cpPromosLabel: "promos",
    cpFilterAll: "All",
    cpEmptyTitle: "No promos yet",
    cpEmptyDescription:
      "Create your first promo to offer discounts to your customers.",
    cpCreatePromo: "Create promo",
    cpEditPromo: "Edit promo",
    cpNoResults: "No promos found",
    cpNoResultsDescription: "Try adjusting your search or filters.",
    cpCodeLabel: "Code",
    cpCodeReadonly: "Code cannot be changed after creation.",
    cpTypeLabel: "Discount type",
    cpValueLabel: "Value",
    cpValueHintPercent: "Percentage (e.g. 20 = 20%)",
    cpValueHintCents: "Amount in cents (e.g. 500 = $5.00)",
    cpStartsAt: "Starts at",
    cpStartsAtPlaceholder: "Immediately",
    cpEndsAt: "Ends at",
    cpEndsAtPlaceholder: "No expiry",
    cpMaxRedemptions: "Max redemptions",
    cpUnlimited: "Unlimited",
    cpMinOrder: "Min order",
    cpInCents: "In cents",
    cpMaxDiscount: "Max discount",
    cpNoLimit: "No limit",
    cpMaxDiscountHint: "Cap the discount amount in cents for percent promos.",
    cpMaxDiscountHintDollars: "Cap the discount amount for percent promos.",
    cpStackable: "Stackable",
    cpStackableHint: "Allow this promo to be combined with other promos.",
    // Section labels (Identity / Discount / Eligibility / Schedule / Limits).
    // The Identity section has no explicit label — the Code field is the
    // implicit lede.
    cpSectionDiscount: "Discount",
    cpSectionEligibility: "Eligibility",
    cpSectionSchedule: "Schedule",
    cpSectionLimits: "Limits",
    // Date-toggle affordances replace the misleading "Immediately" /
    // "No expiry" placeholders. (cpNoExpiry already declared above.)
    cpStartsImmediately: "Start immediately",
    // Cancel-with-dirty-state confirmation.
    cpDiscardConfirm: "Discard changes? Anything you typed will be lost.",
    audienceDiscardConfirm: "Discard changes? Anything you typed will be lost.",
    // Inline validation messages.
    cpCodeRequired: "Code is required.",
    cpCodeTooLong: "Max 64 characters.",
    cpCodeFormat: "Use letters, numbers, dashes, or underscores only.",
    cpValueRequired: "Value is required.",
    cpValuePositive: "Must be a positive number.",
    cpValuePercentRange: "Percent must be 1\u2013100.",
    cpEndsBeforeStarts: "End must be after start.",
    cpSaving: "Saving\u2026",
    cpSave: "Save changes",
    cpCreated: "Promo created",
    cpUpdated: "Promo updated",
    cpRevoked: "Promo revoked",
    cpEdit: "Edit",
    cpRevoke: "Revoke",
    cpPromosTitle: "Promos",
    cpSearchPlaceholder: "Search by code\u2026",
    cpPlatformTitle: "All Promos",
    cpPlatformSubtitle: "Platform-wide view of all promo codes across groups.",
    cpRevokeConfirm:
      "Are you sure you want to revoke {code}? This cannot be undone.",
    // ── Announcements ─────────────────────────────────────────────────
    announcementsHeading: "Announcements",
    announcementsSubtitle:
      "Send broadcast messages to your ticket holders and contact lists.",
    announcementsComingSoon: "Announcements are coming soon",
    announcementsComingSoonDescription:
      "You\u2019ll be able to compose rich-text messages and send them to all ticket holders, attendees of a specific event, or a contact list \u2014 right from this page.",
    whatToExpect: "What to expect",
    featureComposeTitle: "Compose and send",
    featureComposeDescription:
      "Rich text editor with subject line, audience picker, and instant or scheduled delivery.",
    featureTargetingTitle: "Audience targeting",
    featureTargetingDescription:
      "Send to all ticket holders, a specific event\u2019s attendees, or a curated contact list.",
    featureHistoryTitle: "Message history",
    featureHistoryDescription:
      "Full log of every announcement sent \u2014 who sent it, when, and to which audience.",
    manageContactLists: "Manage your contact lists",
    manageContactListsDescription:
      "Build and import audiences now so they\u2019re ready when announcements launch.",
    goToAudiences: "Go to Audiences",
    composeAnnouncement: "Compose",
    composeAnnouncementTitle: "New announcement",
    announcementSubjectLabel: "Subject",
    announcementSubjectPlaceholder: "Enter a subject line...",
    announcementAudienceLabel: "Audience",
    audienceAllTicketHolders: "All ticket holders",
    audienceEventTicketHolders: "Event ticket holders",
    audienceContactList: "Contact list",
    audienceMultipleEvents: "Multiple events",
    audienceEventTicketTier: "Event ticket tier",
    audienceWaitlistSubscribers: "Waitlist subscribers",
    announcementSelectEvent: "Select an event",
    announcementSelectEvents: "Select events",
    announcementSelectContactList: "Select a contact list",
    announcementSelectTiers: "Select ticket tiers",
    announcementExcludeContactList: "Exclude a contact list",
    announcementExcludeNone: "No exclusions",
    announcementRecipientCount: "~{count} recipients",
    announcementRecipientCountLoading: "Counting recipients...",
    announcementRecipientCountZero: "No recipients match this audience",
    announcementSendTest: "Send test to me",
    announcementTestSent: "Test sent",
    announcementTestSentDescription: "A test email was sent to {email}.",
    announcementTestFailed: "Failed to send test",
    announcementBodyLabel: "Message",
    announcementFooterPreviewTitle: "Email footer (auto-appended)",
    announcementFooterNoAddress:
      "No physical address set — add one in Settings > Contact",
    announcementSendNow: "Send now",
    announcementSending: "Sending...",
    announcementSent: "Announcement sent",
    announcementSentDescription:
      "Your announcement has been sent successfully.",
    announcementSendFailed: "Failed to send announcement",
    announcementConfirmTitle: "Send announcement?",
    announcementConfirmDescription:
      "This will send your announcement immediately. This action cannot be undone.",
    announcementConfirmSend: "Send",
    announcementSubjectColumn: "Subject",
    announcementAudienceColumn: "Audience",
    announcementSentAtColumn: "Sent",
    announcementSentByColumn: "Sent by",
    announcementsEmpty: "No announcements yet",
    announcementsEmptyDescription:
      "Announcements will appear here once you send your first one.",
    announcementsLoadFailed: "Failed to load announcements: {error}",
    searchAnnouncementsPlaceholder: "Search announcements...",
    // ── Embeds ────────────────────────────────────────────────────────
    embedsHeading: "Embed Widgets",
    embedsSubtitle: "Put your events on your own website in four steps.",
    embedAddDomainDesc:
      "Enter the domain where this widget will be embedded (e.g. example.com).",
    embedAdd: "Add",
    embedDomainAdded: "Domain added",
    embedDomainAddedDesc: "The embed widget is now active for this domain.",
    embedAddFailed: "Failed to add domain",
    embedRevoked: "Embed revoked",
    embedRevokedDesc: "This domain can no longer display the widget.",
    embedRevokeFailed: "Failed to revoke embed",
    embedRevokedDomains: "Revoked",
    embedStatusRevoked: "Revoked",
    embedPreviewDesc:
      "This is how the widget will appear when embedded on an external site.",
    embedPreviewWidth: "Width",
    embedAutoResizeNote:
      "This widget sizes itself — keep the hf-resize.js line and its height stays in sync on your page.",
    embedOpenPreview: "Open preview",
    embedGuideHeading: "Setup Guides",
    embedGuidePlatforms: "5 platforms",
    embedGuideLastVerified: "Last verified: May 2026",
    embedGuideCopy: "Copy snippet",
    embedGuideCopied: "Copied!",
    embedRevoke: "Revoke",
    // ── Embeds page: the four steps (apps/web/.../admin/[slug]/embeds) ──
    embedTabLabel: "Embed type",
    embedTabEvents: "Events",
    embedTabBooking: "Booking button",
    embedTabMemberships: "Memberships",
    embedStep1Title: "What it shows",
    embedStep2Title: "Your website",
    embedStep3Title: "How it looks on your site",
    embedStep4Title: "Copy it onto your site",
    embedSubjectLabel: "What are you embedding?",
    embedSubjectCalendar: "Calendar",
    embedSubjectEvent: "Event",
    embedHintOwnerCalendar: "A calendar of your events for your own website.",
    embedHintOwnerList: "An upcoming-events list for your own website.",
    embedHintCalendarCalendar:
      "A month calendar of one place calendar's published events.",
    embedHintCalendarList: "A list of one place calendar's published events.",
    embedHintEvent: "Tickets for a single published event.",
    embedSelectEventPlaceholder: "Select a published event",
    embedDefaultView: "Default view",
    embedViewHintCalendar:
      "Visitors land on a month calendar. The code in step 4 pins it with ?view=calendar.",
    embedViewHintList:
      "Visitors land on an upcoming-events list. The code follows this setting, so you can switch later without re-pasting.",
    embedViewToggleLabel: "Let visitors switch views",
    embedViewToggleDesc:
      "Adds a List / Calendar switcher to the widget itself.",
    embedWhichEvents: "Which events",
    embedWhichEventsAria: "Which events the widget shows",
    embedScopeOwn: "My events",
    embedScopeVenues: "At my places",
    embedScopeAll: "Everything",
    embedScopeOwnHint: "Only events you created.",
    embedScopeVenuesHint:
      "Published events at places you own, including events other organisers booked into your room.",
    embedScopeAllHint:
      "Your own events plus everything published at places you own.",
    embedWhichPlace: "Which place",
    embedSelectPlace: "Select a place",
    embedBookingHint1:
      "A “Request to book” button, or an inline request form, for one of your places.",
    embedBookingHint2:
      "Visitors can send a request with just their name and email. No account needed.",
    embedMembershipsTitle: "{name}’s membership tiers",
    embedMembershipsDesc:
      "Your published membership tiers for your own website. The Join button opens your Ithas Fire page in a new tab. Joining (and billing) always happens there, never inside the widget.",
    embedLockedBooking: "Pick a place in step 1 first.",
    embedLockedCalendar:
      "Pick a place and one of its calendars in step 1 first.",
    embedLockedEvent: "Pick an event in step 1 first.",
    embedLockedLoading: "Loading your website addresses…",
    embedLockedLoadFailed:
      "Your website addresses didn’t load. Retry in step 2.",
    embedLockedPreviewEditor:
      "The preview appears once an editor adds your website’s address in step 2.",
    embedLockedCodeEditor:
      "Your code appears here once an editor adds your website’s address in step 2.",
    embedLockedPreviewAdd:
      "Add your website’s address in step 2 to see the preview.",
    embedLockedCodeAdd: "Your code appears here once the address is added.",
    embedItsAddress: "Its address",
    embedDomainConfirmed:
      "{domain} can show the widget. Your code is in step 4.",
    embedDomainsLoadFailedTitle: "Couldn’t load your domains",
    embedRetry: "Retry",
    embedCanShowWidget: "Can show the widget",
    embedNeedsEditor:
      "An editor on this account needs to add your website’s address before the preview and code appear.",
    embedLightOrDark: "Is it light or dark?",
    embedLightOrDarkAria: "Is your website light or dark?",
    embedSiteLight: "Light",
    embedSiteDark: "Dark",
    embedSiteCustom: "Custom",
    embedSiteLightDesc:
      "The widget uses the Ithas Fire theme with no background, so your page shows through.",
    embedSiteDarkDesc:
      "We'll use light text, dark form fields and a readable link colour. Your page shows through behind the widget.",
    embedSiteCustomDesc:
      "Set the four colours below yourself: Brand, Background, Text and Accent.",
    embedKnobBrand: "Brand",
    embedKnobBg: "Background",
    embedKnobText: "Text",
    embedKnobAccent: "Accent",
    embedKnobBgTransparent: "Background: Transparent",
    embedKnobBrandAria: "Brand colour",
    embedKnobBgAria: "Background colour",
    embedKnobTextAria: "Text colour",
    embedKnobAccentAria: "Accent colour",
    embedKnobBgTransparentAria: "Background colour (currently transparent)",
    embedSetColour: "Set colour",
    embedSetColourAria: "Set colour for background",
    embedClear: "Clear",
    embedClearBgAria: "Clear background, back to transparent",
    embedCustomNoBgNote:
      "With no background set, the widget is transparent and sits directly on your page. On a dark page, set Text to a light colour so the widget stays readable, or choose Dark.",
    embedPreviewBgLabel: "Preview background",
    embedYourPageColour: "Your page colour",
    embedPreviewOnlyNote:
      "Only changes this preview. It isn’t added to the snippet.",
    embedChangeBecomesCustom:
      "Change any colour and your answer becomes Custom.",
    embedDisplay: "Display",
    embedDisplayAria: "How the widget appears",
    embedDisplayInline: "Inline",
    embedDisplayButton: "Button",
    embedDisplayInlineForm: "Inline form",
    embedBookingDisplayAria: "Booking display mode",
    embedWidthFull: "Full",
    embedPreviewFrameTitle: "Widget preview",
    embedCodeFor: "Code for {domain}",
    embedCopyCodeFor: "Copy code for {domain}",
    embedCopiedCodeFor: "Copied code for {domain}",
    embedCopyShort: "Copy code",
    embedCopiedShort: "Copied",
    embedCopyEmbedCodeFor: "Copy embed code for {domain}",
    embedFormat: "Format",
    embedFormatAria: "Embed code format for {domain}",
    embedResizeSdk:
      "The widget sets its own height on your page. hf-embed.js handles it, so there is nothing to adjust.",
    embedResizeFixed:
      "This frame starts {height}px tall and stays that height. To let it grow to fit, add the hf-resize.js script tag from the HTML format to your page, or change {code}.",
    embedLinkOutLabelFor: "Checkout behavior for {domain}",
    embedOpenPreviewFor: "Open preview for {domain}",
    embedGuideHeadingFor: "Setup Guides for {domain}",
    embedSiteBuilders: "Site builders",
    embedSiteBuildersFor: "Site builders for {domain}",
    embedGuideNote: "Note: {note}",
    embedGuideCopyFor: "Copy snippet for {domain}",
    embedGuideCopiedFor: "Copied snippet for {domain}",
    embedCalendarNoneInPlace:
      "This place has no calendars yet. Add one under the place’s Calendars page.",
    embedViewList: "List",
    embedViewCalendar: "Calendar",
    embedViewUpdated: "Embed updated",
    embedViewUpdatedDesc: "Your snippet and preview now use these settings.",
    embedViewUpdateFailed: "Couldn’t update the embed",
    embedViewUpdateFailedFor: "Couldn’t update {domains}",
    embedOwnerYou: "You",
    embedAccountLoadFailed: "Couldn’t load this account",
    embedBgCheckerboard: "Checkerboard page",
    embedBgWhite: "White page",
    embedBgLightGrey: "Light grey page",
    embedBgNavy: "Navy page",
    embedBgNearBlack: "Near-black page",
    embedGuideWpStep1:
      "In your WordPress editor, click the “+” to add a new block.",
    embedGuideWpStep2: "Search for “Custom HTML” and select it.",
    embedGuideWpStep3: "Paste the code below into the block.",
    embedGuideWpStep4:
      "Click “Preview” to confirm it looks right, then click “Update” or “Publish”.",
    embedGuideWpNote:
      "On WordPress.com, iframes require a plan with hosting features activated. Self-hosted WordPress works on any setup.",
    embedGuideSqStep1:
      "Open the page editor and click an insert point to add a block.",
    embedGuideSqStep2: "Choose “Code” from the block picker.",
    embedGuideSqStep3:
      "Paste the code below into the code area (HTML is the default language).",
    embedGuideSqStep4: "Click “Apply”, then save or publish the page.",
    embedGuideSqNote:
      "Iframes require the Core plan or higher — not supported on Personal.",
    embedGuideWixStep1:
      "In the Wix Editor, open “Add Elements” on the left panel.",
    embedGuideWixStep2:
      "Go to “Embed & Social” → “Embed Code” → “Embed HTML”.",
    embedGuideWixStep3:
      "Click “Enter Code”, paste the snippet below, and click “Apply”.",
    embedGuideWixStep4:
      "Resize the element on the canvas to match your widget height.",
    embedGuideShopifyStep1: "Go to Online Store → Themes → Customize.",
    embedGuideShopifyStep2:
      "Add a “Custom Liquid” section to the desired page.",
    embedGuideShopifyStep3: "Paste the code below into the liquid editor.",
    embedGuideShopifyStep4: "Click “Save”.",
    embedGuideShopifyNote: "Works with Online Store 2.0 themes.",
    embedGuideOtherLabel: "Other / HTML",
    embedGuideOtherStep1:
      "Open the HTML editor for your page or site builder.",
    embedGuideOtherStep2:
      "Paste the code below where you want the widget to appear.",
    embedGuideOtherStep3:
      "If your site enforces a Content Security Policy, allow `frame-src {siteUrl}`.",
    embedGuideOtherStep4: "Save and publish your page.",
    // ── Embed calendar subject picker (FR-010) ────────────────────────
    // The place name is the GROUP header for that place's calendars.
    embedCalendarGroupHeading: "{place} · Calendars",
    embedCalendarListLabel: "Calendar",
    embedCalendarSpaceCount: "{count, plural, one {# space} other {# spaces}}",
    embedCalendarDefaultBadge: "Default",
    // ── Embed widget (public-facing) ──────────────────────────────────
    embedWidgetGetTickets: "Get Tickets",
    embedWidgetBack: "Back",
    embedWidgetClose: "Close",
    embedWidgetSelectTickets: "Select tickets",
    embedWidgetFree: "Free",
    embedWidgetSoldOut: "Sold out",
    embedWidgetQty: "Qty",
    embedWidgetOrderSummary: "Order summary",
    embedWidgetSubtotal: "Subtotal",
    embedWidgetTotal: "Total",
    embedWidgetContinue: "Continue",
    embedWidgetYourInfo: "Your information",
    embedWidgetName: "Full name",
    embedWidgetEmail: "Email address",
    embedWidgetPayment: "Payment",
    embedWidgetProcessing: "Processing...",
    embedWidgetPayNow: "Pay now",
    embedWidgetCompleteOrder: "Complete order",
    embedWidgetOrderConfirmed: "Order confirmed",
    embedWidgetOrderConfirmedDesc: "Your tickets have been sent to {email}.",
    embedWidgetDone: "Done",
    embedWidgetNoTickets: "Tickets are not available at this time.",
    embedWidgetCheckoutFailed: "Unable to start checkout. Please try again.",
    embedWidgetPaymentFailed: "Payment failed. Please try again.",
    // ── Event status labels ───────────────────────────────────────────
    eventStatusDraft: "Draft",
    eventStatusPublished: "Published",
    eventStatusCompleted: "Completed",
    eventStatusCancelled: "Cancelled",
    eventStatusArchived: "Archived",
    // ── Audiences ─────────────────────────────────────────────────────
    audiencesHeading: "Audiences",
    audiencesSubtitle:
      "Manage your contact lists for event announcements and messaging.",
    importButton: "Import",
    newAudience: "New Audience",
    searchAudiencesPlaceholder: "Search audiences...",
    audienceNameColumn: "Name",
    contactsColumn: "Contacts",
    lastImportColumn: "Last Import",
    deleteTooltip: "Delete",
    deleteAudienceLabel: "Delete {name}",
    loadingAudiences: "Loading...",
    unableToDetermineOwnerAudiences: "Unable to determine owner context.",
    failedToLoadAudiences: "Failed to load audiences: {error}",
    deleteConfirmAudience: 'Delete "{name}"? This cannot be undone.',
    audienceDeleted: "Deleted",
    audienceDeletedMessage: '"{name}" has been removed.',
    deleteFailed: "Delete failed",
    neverImported: "Never",
    nOfTotalAudiences: "{filtered} of {total} audiences",
    noMatchingAudiences: "No matching audiences",
    noMatchingAudiencesDescription: "Try adjusting your search.",
    noAudiencesYet: "No audiences yet",
    noAudiencesDescription:
      "Create an audience to start organizing your contacts.",
    createFirstAudience: "Create your first audience",
    // ── Audience detail ───────────────────────────────────────────────
    backToAudiences: "Back to Audiences",
    audienceNotFound: "Audience not found.",
    nContacts: "{count, plural, one {# contact} other {# contacts}}",
    deleteAudience: "Delete",
    importContacts: "Import Contacts",
    exportCsv: "Export CSV",
    exportFailed: "Export failed",
    saveChanges: "Save Changes",
    audienceNameLabel: "Name",
    audienceNamePlaceholder: "Audience name",
    audienceDescriptionLabel: "Description",
    audienceDescriptionPlaceholder: "Optional description",
    contactsHeading: "Contacts",
    addContact: "Add Contact",
    addContactEmailLabel: "Email",
    addContactEmailPlaceholder: "jane@example.com",
    addContactPhoneLabel: "Phone",
    addContactPhonePlaceholder: "+1 555-1234",
    addContactNameLabel: "Name",
    addContactNamePlaceholder: "Jane Doe",
    addContactTagsLabel: "Tags",
    addContactTagsPlaceholder: "vip, press",
    addContactButton: "Add",
    searchContactsPlaceholder: "Search by email or name...",
    noContactsYet: "No contacts yet",
    noContactsDescription: "Add a contact above or import a CSV / XLSX.",
    pageLabel: "Page {page}",
    contactEmailColumn: "Email",
    contactPhoneColumn: "Phone",
    contactNameColumn: "Name",
    contactTagsColumn: "Tags",
    contactStatusColumn: "Status",
    contactAddedColumn: "Added",
    contactStatusActive: "Active",
    contactStatusUnsubscribed: "Unsubscribed",
    saveEditsLabel: "Save edits",
    saveTooltip: "Save",
    cancelEditingLabel: "Cancel editing",
    editContactLabel: "Edit contact",
    removeContactLabel: "Remove contact",
    removeTooltip: "Remove",
    missingInfo: "Missing info",
    missingInfoMessage: "Provide at least an email or phone number.",
    validationContactRequired: "Email or phone is required.",
    validationInvalidEmail: "Enter a valid email address.",
    validationInvalidPhone: "Enter a valid phone number (at least 5 digits).",
    contactAdded: "Added",
    contactAddedMessage: "Contact added.",
    addFailed: "Add failed",
    contactUpdated: "Updated",
    contactUpdatedMessage: "Contact updated.",
    updateFailed: "Update failed",
    audienceSaved: "Saved",
    audienceSavedMessage: "Audience updated successfully.",
    saveFailed: "Save failed",
    removeEntryConfirm: 'Remove "{label}" from this audience?',
    entryRemoved: "Removed",
    entryRemovedMessage: '"{label}" has been removed.',
    removeFailed: "Remove failed",
    deleteAudienceConfirm:
      'Delete "{name}"? This will permanently remove the audience and all its contacts. This cannot be undone.',
    audienceDeletedDetail: "Deleted",
    audienceDeletedDetailMessage: '"{name}" has been deleted.',

    // ── AudienceImport ──────────────────────────────────────────────
    importContactsHeading: "Import Contacts",
    importUploadTitle: "Upload a CSV file",
    importUploadDescription:
      "Your file should include at least an email or phone column. We will auto-detect common column names.",
    importChooseFile: "Choose File",
    importParseError: "Parse error",
    importParseErrorMessage: "Could not detect any columns in the file.",
    importXlsxTitle: "XLSX support coming soon",
    importXlsxMessage:
      "For now, please export your spreadsheet as CSV and re-upload.",
    importUnsupportedTitle: "Unsupported format",
    importUnsupportedMessage: "Please upload a .csv or .xlsx file.",
    importMapColumns: "Map Columns",
    importMapDescription:
      "{fileName} - {rowCount} rows detected. Assign each column to a contact field or skip it.",
    importFieldEmail: "Email",
    importFieldPhone: "Phone",
    importFieldName: "Name",
    importFieldNotes: "Notes",
    importFieldSkip: "Skip",
    importMustMapWarning: "You must map at least one column to Email or Phone.",
    importStartOver: "Start Over",
    importContinue: "Continue",
    importDestination: "Destination",
    importDestinationDescription:
      "Import into an existing audience or create a new one.",
    importNewAudience: "New Audience",
    importAudienceNamePlaceholder: "Audience name (default: {fallback})",
    importMode: "Import Mode",
    importModeDescription:
      "Choose how imported contacts interact with existing ones.",
    importModeAppend: "Append",
    importModeReplace: "Replace All",
    importReplaceWarning:
      "All existing contacts will be removed before importing. This cannot be undone.",
    importAppendInfo:
      "New contacts will be added. Duplicates (by email/phone) are skipped.",
    importTotalRows: "Total Rows",
    importValidContacts: "Valid Contacts",
    importSkippedNoContact: "Skipped (no email/phone)",
    importPreviewLabel: "Preview (first 20 rows)",
    importBack: "Back",
    importReplaceAction: "Replace & Import {count} Contacts",
    importAction: "Import {count} Contacts",
    importImporting: "Importing...",
    importChunkProgress: "Chunk {current} of {total}",
    importProgressImported: "Imported",
    importProgressSkipped: "Skipped",
    importProgressLinked: "Linked",
    importComplete: "Import complete",
    importCompleteTitle: "Import Complete",
    importCompleteMessage: "{imported} contacts imported, {skipped} skipped.",
    importFailed: "Import failed",
    importDuplicatesSkipped: "Duplicates Skipped",
    importLinkedToAccounts: "Linked to Accounts",
    importViewAudience: "View Audience",
    importAnother: "Import Another",
    importUnableToDetermineOwner: "Unable to determine owner context.",

    // ── Organization Settings ──────────────────────────────────────
    settings: "Settings",
    settingsDescription: "Manage your group profile and preferences.",
    settingsGeneral: "General",
    settingsContact: "Contact",
    settingsPublicPage: "Public Page",

    // ── Organization Settings — grouped navigation ─────────────────
    settingsNavAria: "Settings sections",
    settingsAllSections: "All settings",
    settingsGroupOrganization: "Organization",
    settingsGroupBooking: "Getting booked",
    settingsGroupPolicies: "Policies",
    settingsBookingDefaults: "Booking defaults",
    settingsBookingTags: "Booking tags",
    settingsBookingTagsDescription:
      "Your team's private labels for received booking requests. Acts never see them.",
    settingsBookingTagsEmpty:
      "No tags yet. Add one below, or type a new one on any booking request.",
    settingsDefaultAgreement: "Default agreement",
    settingsUnsavedChanges: "Unsaved changes",
    settingsBkDefPerformerOff:
      "Turn on performer mode for this group to set up its booking defaults.",
    settingsBkDefPerformerCta: "Open performer settings",

    settingsPublicPageDescription:
      "Your group's public profile page — the storefront attendees see. Edit its layout, blocks, and content in the page builder.",
    editPublicPageButton: "Edit public page",
    settingsPublicPageVisible: "Public page visible",
    settingsPublicPageVisibleHelp:
      "Your page is live — anyone with the link can view it.",
    settingsPublicPageHiddenHelp:
      "Your page returns a 404 to visitors. You can still edit it.",
    settingsPublicPageCreateFirst:
      "Open the page editor to set up your public page first.",
    settingsHumanIntro:
      "These settings are for your personal account. Manage your profile, email, and security options below or open the full Account Settings.",
    accountSettingsLinkTitle: "Your account settings",
    accountSettingsLinkDescription:
      "Profile, email, password and notification settings live on your personal account page.",
    openAccountSettings: "Open Account Settings",
    editProfile: "Edit profile",
    loadingSettings: "Loading settings...",
    orgNameLabel: "Group name",
    orgNamePlaceholder: "Acme Events",
    orgNameHelp: "Changing the name will also update the group URL slug.",
    defaultLocaleLabel: "Default locale",
    defaultLocaleHelp:
      "Two-letter language code used for event pages and emails (e.g. en, es).",
    contactEmailLabel: "Reply-to email",
    contactEmailPlaceholder: "hello@your-org.com",
    contactEmailHelp:
      "When attendees reply to emails from your group, replies go to this address.",
    physicalAddressLabel: "Physical mailing address",
    physicalAddressPlaceholder: "123 Main St, Anytown, ST 12345",
    physicalAddressHelp:
      "Required for CAN-SPAM compliance. Shown in the footer of announcement emails.",
    settingsSaved: "Settings saved",
    settingsSaveError: "Failed to save settings",

    // ── Organization Settings — Danger Zone ─────────────────────────
    settingsDanger: "Danger Zone",
    settingsDangerDescription:
      "Irreversible actions that affect the entire group.",
    deleteOrgButton: "Delete group",
    deleteOrgDescription:
      "Once deleted, all members will be removed and the group slug will be released. Active events must be cancelled first, and any pending payouts will complete before the group is fully removed.",
    deleteOrgConfirmTitle: "Delete group",
    deleteOrgConfirmDescription:
      "This action cannot be undone. Type the group name to confirm.",
    deleteOrgConfirmLabel: "Group name",
    deleteOrgConfirmPlaceholder: "Type group name here",
    deleteOrgConfirmButton: "Permanently delete",
    deleteOrgSuccess: "Group deleted",
    deleteOrgError: "Failed to delete group",
    deleteOrgHasActiveEvents:
      "Cancel all active events before deleting the group.",
    deleteOrgNameMismatch: "Group name does not match.",
    deleteOrgPendingPayoutsTitle: "Pending payouts",
    deleteOrgPendingPayoutsDescription:
      "This group has {count, plural, one {# unsettled order item} other {# unsettled order items}} totaling {amount}. Payouts must complete before the group can be deleted.",

    // ── CreateOrganizationDialog ────────────────────────────────────
    createOrgTitle: "Create group",
    createOrgDescription:
      "Groups let you collaborate with a team, manage shared events, and keep finances separate from your personal account.",
    createOrgNameLabel: "Group name",
    createOrgNamePlaceholder: "Acme Events",
    createOrgCreated: "Group created",
    createOrgCreating: "Creating...",
    createOrgCreate: "Create",
    createOrgNameTooShort: "Group name must be at least 2 characters.",

    // ── PlacesTable ─────────────────────────────────────────────────
    placesHeading: "Places",
    placesSubtitle: "Manage your places.",
    placesNewPlace: "New Place",
    // New-place dialog (minimum honest address for the quick action)
    placesNewPlaceDialogTitle: "New place",
    placesNewPlaceDialogDescription:
      "Name the place and tell us where it is. You can fill in the rest on the next screen.",
    placesNewPlaceNameLabel: "Place name",
    placesNewPlaceNamePlaceholder: "The Velvet Room",
    placesNewPlaceCityLabel: "City",
    placesNewPlaceCityPlaceholder: "Portland",
    placesNewPlaceCountryLabel: "Country",
    placesNewPlaceCountryPlaceholder: "US",
    placesNewPlaceStreetHint:
      "No street address needed yet \u2014 add it (and everything else) in the editor.",
    placesNewPlaceCreate: "Create place",
    placesNewPlaceCreating: "Creating\u2026",
    placesSearchPlaceholder: "Search places\u2026",
    placesVerifiedOnly: "Verified only",
    placesAllVerification: "All verification",
    placesAllStatuses: "All statuses",
    placesArchivedStatus: "Archived",
    placesActiveStatus: "Active",
    placesColumnPlace: "Place",
    placesColumnStatus: "Status",
    placesColumnOwnership: "Ownership",
    placesColumnCapacity: "Capacity",
    placesColumnActions: "Actions",
    placesOwnershipYours: "Yours",
    placesOwnershipPublic: "Public",
    placesUpdated: "Updated",
    placesArchived: "Place archived",
    placesRestored: "Place restored",
    placesUpdateFailed: "Update failed",
    placesVerificationRequested: "Verification requested",
    placesVerificationRequestedMessage:
      "Your place has been submitted for review.",
    placesVerificationFailed: "Request failed",
    placesNoOwner: "No owner",
    placesNoOwnerMessage: "Unable to determine owner for new place.",
    placesCreateFailed: "Create failed",
    placesEditLabel: "Edit place",
    placesEditTooltip: "Edit",
    placesLayoutLabel: "View seat layout",
    placesLayoutTooltip: "Layout",
    placesCalendarLabel: "View calendar",
    placesCalendarTooltip: "Calendar",
    placesBookingsTooltip: "Bookings",
    placesPageEditorLabel: "Edit public page",
    placesPageEditorTooltip: "Page",
    placesRequestVerificationLabel: "Request verification",
    placesRequestVerification: "Request verification",
    placesNotReady: "Not ready: {reason}",
    placesVerificationPending: "Verification pending",
    placesVerified: "Verified",
    placesVerificationRejected: "Verification rejected",
    placesRestoreLabel: "Restore place",
    placesRestoreTooltip: "Restore",
    placesArchiveLabel: "Archive place",
    placesArchiveTooltip: "Archive",
    placesEmptyArchived: "No archived places",
    placesEmptyAll: "No places found",
    placesEmptyActive: "No places yet",
    placesEmptyCreateDescription:
      "Create your first place to use with events.",
    placesEmptyFilterDescription: "Try adjusting your search or filters.",
    placesNoSearchResults: "No matching places",
    placesNoSearchResultsDescription:
      "Try a different search term or clear the filter.",
    placesCreateFirst: "Create your first place",
    placesLoadFailed: "Failed to load places: {error}",
    placesRetry: "Retry",
    placesCount: "{shown} of {total} places",
    placesVerifiedDescription:
      "This place has been verified by the Ithas Fire team.",
    placesPendingLabel: "Pending verification",
    placesPendingDescription:
      "A verification request has been submitted and is under review.",
    placesUnverified: "Unverified",
    placesUnverifiedDescription:
      "This place has not been verified yet. Complete the place details and request verification.",
    placesRejected: "Rejected",
    placesRejectedDescription:
      "Verification was rejected. Please review your place details and try again, or contact support.",

    // ── Place edit page ──
    placeEditLoading: "Loading place\u2026",
    placeEditAccessDenied: "Access denied",
    placeEditAccessDeniedDescription:
      "You don't have permission to edit this place.",
    placeEditNotFound: "Place not found",
    placeEditNotFoundDescription:
      "This place may have been deleted or the link is invalid.",
    placeEditGenericError: "Something went wrong",
    placeEditGenericErrorDescription:
      "An unexpected error occurred while loading this place.",
    placeEditBackToPlaces: "Back to places",
    placeTabPage: "Page",
    placeTabLayout: "Layout",
    placeTabCalendar: "Calendar",
    placeEditSaving: "Saving\u2026",
    // The venue settings page's ONE Save. (Renamed from `placeEditSave`
    // when a floating dock also said "Save"; that dock is gone. The page
    // renders this button twice — header and pinned bar — but CSS displays
    // exactly one, so its accessible name is never duplicated.)
    placeEditSaveChanges: "Save changes",
    placeEditSaved: "Saved",
    placeEditSavedMessage: "Place updated successfully.",
    placeEditSaveFailed: "Save failed",
    placeEditNameLabel: "Name",
    placeEditNamePlaceholder: "e.g. The Grand Ballroom",
    // ── Address autocomplete (place-editor spec FR-016/FR-017) ──
    placeEditAddressSearchLabel: "Find address",
    placeEditAddressSearchPlaceholder: "Start typing a street address…",
    placeEditAddressSearchHint:
      "Pick a match to fill in the fields below, or enter them by hand.",
    placeEditAddressSearchSearching: "Searching addresses…",
    placeEditAddressSearchNoResults:
      "No matching addresses. Fill the fields in by hand.",
    placeEditAddressSearchError:
      "Address lookup is unavailable right now. Fill the fields in by hand.",
    placeEditAddressSearchResultCount:
      "{count, plural, one {# address found} other {# addresses found}}",
    placeEditAddressSuggestionsLabel: "Address suggestions",
    placeEditAddressManualCta: "Enter it manually",
    placeEditAddressFieldsShow: "Enter address manually",
    placeEditAddressFieldsHide: "Hide address fields",
    placeEditCountryCodeInvalidTitle: "Country code incomplete",
    placeEditCountryCodeInvalidMessage:
      "Use a two-letter country code, or leave it blank.",
    placeEditCoordinatesFromSelection:
      "Set from the address you picked. Save to store them.",
    placeEditCoordinatesPending:
      "The address changed — coordinates are re-checked when you save.",
    placeEditAddressLine1Label: "Address Line 1",
    placeEditAddressLine1Placeholder: "Street address",
    placeEditAddressLine2Label: "Address Line 2",
    placeEditAddressLine2Placeholder: "Suite, unit, building (optional)",
    placeEditCityLabel: "City",
    placeEditCityPlaceholder: "City",
    placeEditRegionLabel: "Region / State",
    placeEditRegionPlaceholder: "Region",
    placeEditPostalCodeLabel: "Postal Code",
    placeEditPostalCodePlaceholder: "Zip / Postal",
    placeEditCountryCodeLabel: "Country Code",
    placeEditCountryCodePlaceholder: "US",
    placeEditCapacityLabel: "Capacity",
    placeEditCapacityPlaceholder: "Max capacity (optional)",
    placeEditAddressUnverifiedTitle: "Address not found",
    placeEditAddressUnverifiedMessage:
      "We couldn\u2019t verify this address. Coordinates won\u2019t be updated, but you can still save.",
    placeEditGeocodeFailed: "Address check failed",
    placeEditGeocodeFailedMessage:
      "The address verification service is unavailable. Saving without updated coordinates.",
    placeEditCoordinatesLabel: "Coordinates",
    placeEditCoordinatesNote:
      "Coordinates are set when the address is geocoded. Manual editing is not yet supported.",
    // ── Contact & directory (place-admin-rail-context FR-303) ──
    placeEditListedBadge: "LISTED IN DIRECTORY",
    placeEditNotListedBadge: "NOT LISTED",
    placeEditDirectoryNote:
      "Directory listing is managed by the platform team. Verified places are listed automatically.",
    placeEditPhoneLabel: "Phone",
    placeEditPhonePlaceholder: "+15551234567",
    placeEditPhoneHint: "Use E.164 format (leading + and country code).",
    placeEditWebsiteLabel: "Website",
    placeEditWebsitePlaceholder: "https://example.com",
    placeEditPlaceId: "Place ID: {placeId}",
    // ── Two-column regroup: main-column section headings ──
    // The form stopped being one flat stack of bordered boxes; these name
    // the three groups it is assembled from. They replace the old
    // `placeEditContactHeading` ("Contact & directory"), which is gone: the
    // directory state moved to the aside's `placeEditStatusHeading` region.
    placeEditSectionIdentity: "Identity",
    placeEditSectionLocation: "Location",
    // ── Aside: ownership ──
    placeEditOwnersHeading: "Owned by",
    placeEditOwnerKindOrganization: "Organization",
    placeEditOwnerKindPerson: "Person",
    // The `owners: []` line. Deliberately NEUTRAL, not a load-failure
    // message: the array is also empty for a venue whose owner row exists
    // but has no usable name, and telling an owner their venue's ownership
    // "failed to load" would be a false statement about their own data.
    // (The `undefined` case renders no region at all — no copy needed.)
    placeEditOwnersNone: "No owner on record.",
    // ── Aside: status & directory listing (both read-only here) ──
    placeEditStatusHeading: "Status & listing",
    placeEditStatusRowLabel: "Status",
    placeEditListingRowLabel: "Directory",
    placeEditStatusActive: "Active",
    placeEditStatusSuspended: "Suspended",
    placeEditStatusArchived: "Archived",
    // ── Merged venue settings page (FR-401) ─────────────────────────
    // One page with six sections: Identity · Location · Verification ·
    // Public page · Reviews & feedback · Ownership & status. Identity and
    // Location reuse `placeEditSectionIdentity` / `placeEditSectionLocation`,
    // and the header chips reuse `placeVerif{Verified,Pending,Unverified,
    // Rejected}` plus `placeEdit{Listed,NotListed}Badge` — none of those are
    // duplicated here. Only copy with no existing key is added here: the four
    // new section names, and the page's own chrome and save messages below.
    placeSettingsHeading: "Place settings",
    placeSettingsSectionVerification: "Verification",
    placeSettingsSectionPublicPage: "Public page",
    placeSettingsSectionReviews: "Reviews & feedback",
    placeSettingsSectionOwnership: "Ownership & status",
    // Accessible name for the sticky in-page jump list. Without one it is
    // announced as a bare "navigation" next to the rail's own landmark.
    placeSettingsSectionIndexLabel: "Settings sections",
    // Group label for the header's status chip strip (verification state +
    // directory listing). The chips themselves carry the reused values.
    placeSettingsChipsLabel: "Place status",
    // Blocked save: nothing is written at all, because the address the page
    // asks for is taken. Says "web address" to match `slugTaken`, which is
    // the catalog's established user-facing word for a slug.
    placeSettingsBlockedSaveTitle: "Nothing was saved",
    placeSettingsBlockedSaveMessage:
      "The web address you chose is already taken. Pick a different one and save again.",
    // Settings → the block editor. Blocks stay over there; this page owns
    // everything else about the venue, the page's profile and theme included.
    placeSettingsOpenCanvasLabel: "Edit page content",
    // The return leg, shown on the block editor where these settings used to
    // live, so an owner who goes looking for them is not left guessing.
    placePageSettingsMovedNote:
      "Your page's web address, bio, images, visibility, theme and review settings moved to Place settings.",
    placePageSettingsMovedCta: "Open place settings",
    // Answers the obvious question about the Reviews section: why a switch
    // about the public page is set here rather than in page content.
    placeSettingsReviewsIntro:
      "Publishing attendee ratings is a place policy rather than page content, so it is set here and applies everywhere the place appears.",
    // Visible kicker above the section index (two-column widths). The
    // index's accessible name stays `placeSettingsSectionIndexLabel`.
    placeSettingsIndexKicker: "On this page",
    // Header status chips that have no existing key: the public page's
    // visibility and whether attendee ratings are published.
    // Verification's own submit, explained once under the section: it is
    // deliberately NOT part of the page's Save.
    placeSettingsVerificationOwnSubmit:
      "Verification has its own button on purpose. It reviews what is saved, so save your changes first. Save changes never sends a verification request.",
    placeSettingsChipPagePublic: "Page public",
    placeSettingsChipPageUnlisted: "Page unlisted",
    placeSettingsChipPagePrivate: "Page private",
    placeSettingsChipRatingsPublic: "Ratings public",
    placeSettingsChipRatingsPrivate: "Ratings private",
    // ── Public-page verification gate (PlaceProfileEditor, FR-302/FR-303) ──
    placePageGateHeading: "Place profile editor",
    placePageGateBody:
      "The place profile editor is available once your place has been verified. This ensures that public-facing profile pages meet quality standards.",
    placePageGateRequestCta: "Request verification",
    placePageGatePendingNote:
      "Your verification request is being reviewed. You’ll be able to edit your profile once it’s approved.",
    placePageEditorTitle: "Place profile",

    // ── Page Editor (shared) ──
    peDefaultTitle: "Edit page",
    peLoading: "Loading page\u2026",
    peNoPage: "No page found",
    peNoPageDescription:
      "This entity doesn\u2019t have a page yet. A page will be created automatically when the entity is provisioned.",
    peBack: "Back",
    peViewPage: "View page",
    peTabPage: "Page",
    peTabEdit: "Edit",
    peTabPreview: "Preview",
    peViewModeLabel: "View mode",
    peTabProfile: "Profile",
    peTabTheme: "Theme",
    peSettingsTitle: "Page settings",
    peStandardTemplateHint:
      "Want to arrange blocks yourself? Open Page settings → Theme and switch the layout to Grid or Stack.",
    peStandardTemplateLockedHint:
      "Adding, removing, and rearranging blocks is coming soon. For now you can edit each block’s content and visibility below, and your profile and theme in Page settings.",
    pePreviewMobilePublishedNotice:
      "Shows the published version \u2014 unsaved edits are not included. Save, then reload this frame.",
    peAddBlockClose: "Close block panel",
    pePreviewDeviceLabel: "Preview device",
    peSignInRequired: "Sign in required",
    peSignInRequiredDescription: "You need to be signed in to edit your page.",
    peSignIn: "Sign in",
    peOrgNotFound: "Group not found",
    peOrgNotFoundDescription: "Unable to resolve the current group.",
    peFieldsTitle: "Page details",
    peDisplayNameLabel: "Display name",
    peDisplayNamePlaceholder: "How you appear on your page",
    peBannerLabel: "Banner image",
    peBannerEmpty: "No banner",
    peAvatarLabel: "Avatar",
    peAvatarEmpty: "No avatar",
    peImageUpload: "Upload",
    peImageUploading: "Uploading",
    peImageRemove: "Remove",
    peImageSaved: "Image saved",
    // Page details IA — subsection headings + the two save models.
    peGroupIdentity: "Identity",
    peGroupImages: "Images",
    peGroupBio: "Bio",
    peGroupVisibility: "Visibility",
    peImagesAutoSaveBadge: "Saved instantly",
    peImageSavingStatus: "Saving…",
    peImageSavedStatus: "Saved",
    peManualSaveHint:
      "Name, slug, bio and visibility save when you press Save changes.",
    // A PLACE page has no display-name field: a place has one name and it
    // lives in the Identity section of the place settings page — the same page these
    // page fields now render on, one section up. These two replace the field
    // in place, and the save hint drops "Name" so the sentence stays true.
    peVenueNameLabel: "Place name",
    peVenueNameFromDetails:
      "A place has one name. Edit it under Identity, above.",
    peManualSaveHintNoName:
      "Slug, bio and visibility save when you press Save changes.",
    peSlugLabel: "Slug",
    peSlugPlaceholder: "your-page-slug",
    peSlugTaken: "This slug is already taken.",
    peSlugChecking: "Checking availability…",
    peSlugAvailable: "This slug is available.",
    peBioLabel: "Bio",
    peBioPlaceholder: "A short bio for your page",
    peVisibilityLabel: "Visibility",
    peVisibilityPublic: "Public",
    peVisibilityUnlisted: "Unlisted",
    peVisibilityPrivate: "Private",
    peVisibilityPublicHint:
      "Anyone can find this page through search engines and across Ithas Fire.",
    peVisibilityUnlistedHint:
      "Only people with the link can open it. It stays out of search and browse.",
    peVisibilityPrivateHint:
      "Only you and your admins can open it. The public link returns nothing.",
    peSaveChanges: "Save changes",
    peUpdated: "Page updated",
    peUpdatedMessage: "Your changes have been saved.",
    peUpdateFailed: "Failed to update page",
    peAddBlock: "Add block",
    peUndoFailed: "Couldn't undo the last change",
    peRedoFailed: "Couldn't redo that change",
    peUndoPartial: "Undo only partially applied",
    peRedoPartial: "Redo only partially applied",
    peHistoryPartialBody:
      "Some steps didn't go through. Your page has been re-synced to its latest saved state.",
    // Block history names its scope: undo here publishes an inverse mutation
    // to a LIVE page, so a bare "Undo" would read as "take back my typing".
    // `{name}` is either a quoted block name or the generic plural below.
    peHistoryActionAdd: "add {name}",
    peHistoryActionDelete: "delete {name}",
    peHistoryActionEdit: "edit {name}",
    peHistoryActionShow: "show {name}",
    peHistoryActionHide: "hide {name}",
    peHistoryActionReorder: "reorder {name}",
    peHistoryActionMixed: "several block changes",
    peHistoryTargetBlocks: "several blocks",
    peUndoAction: "Undo: {action}",
    peRedoAction: "Redo: {action}",
    peUndoNothing: "Nothing to undo yet",
    peRedoNothing: "Nothing to redo",
    peUndoWhileTyping:
      "{shortcut} is undoing your typing right now \u2014 click to undo the block change instead.",
    peBlockPaletteTitle: "Block palette",
    peBlockCategoryUniversal: "Universal",
    peBlockCategoryIdentity: "Identity",
    peBlockCategoryContent: "Content",
    peBlockCategoryEvents: "Events",
    peBlockCategoryMusic: "Music",
    peBlockCategoryPlace: "Place",
    peBlockCategoryOrganization: "Group",
    peBlockCategoryCustom: "Custom",
    peNoBlocks: "No blocks yet. Add one above.",
    peNoBlocksEditOnly: "This page doesn’t have any content blocks yet.",
    peBlockEmptyPlaceholder:
      "This block is blank. Add content in settings to make it useful on your public page.",
    peBlockActionFailed: "Block action failed",
    peBlockKindAbout: "About",
    peBlockKindLinks: "Links",
    peBlockKindPhotos: "Photos",
    peBlockKindUpcomingEvents: "Upcoming Events",
    peBlockKindAnnouncements: "Announcements",
    peBlockKindShows: "Shows",
    peBlockKindMusic: "Music",
    peBlockKindTracks: "Tracks",
    peBlockKindVideo: "Video",
    peBlockKindPress: "Press",
    peBlockKindStats: "Stats",
    peBlockKindPastShows: "Past Shows",
    peBlockKindRider: "Technical Rider",
    peBlockKindGenreTags: "Genre Tags",
    peBlockKindLocationMap: "Location Map",
    peBlockKindCapacityInfo: "Capacity Info",
    peBlockKindHouseRules: "House Rules",
    peBlockKindAmenities: "Amenities",
    peBlockKindTechSpecs: "Tech Specs",
    peBlockKindResidentArtists: "Resident Artists",
    peBlockKindBookingInfo: "Booking Info",
    peBlockKindRequestToPlay: "Request to Play",
    peBlockKindTrackRecord: "Track Record",
    // The editor note where a pinned block's hide/remove controls would be.
    peBlockPinned: "Pinned",
    peBlockKindVenueStats: "Performer-Reported Stats",
    peBlockKindAudienceStats: "Audience-Reported Ratings",
    peBlockKindRateVenue: "Rate This Place",
    peBlockKindTeam: "Team",
    peBlockKindMission: "Mission",
    peBlockKindManagedPlaces: "Managed Places",
    peBlockKindPastEvents: "Past Events",
    peBlockKindFaq: "FAQ / Accordion",
    peBlockSettingsTitle: "Block Settings",
    peBlockSettingsClose: "Close",
    peBlockSettingsSave: "Save",
    peBlockSettingsSaved: "Block saved",
    peBlockSettingsSaveFailed: "Failed to save block",
    peBlockSettingsUnavailable: "No settings are available for this block.",
    peBlockSettingsManagedAutomatically: "Managed automatically by Ithas Fire.",
    peBlockSettingsUnsupportedField: "Managed outside this editor.",
    peBlockSettingsItem: "Item",
    peBlockSettingsAddItem: "Add item",
    peBlockSettingsRemoveItem: "Remove item",
    peBlockImageUpload: "Upload",
    peBlockImageUploading: "Uploading",
    peBlockImageUploaded: "Photo uploaded",
    peBlockImageUploadedMessage: "Save the block to publish this photo URL.",
    peBlockImageUploadFailed: "Photo upload failed",
    peBlockImageUploadInvalidType: "Use a JPEG, PNG, GIF, or WebP image.",
    peBlockImageUploadTooLarge: "Image is too large. Max 25 MB.",
    peBlockFieldHeading: "Heading",
    peBlockFieldContent: "Content",
    peBlockFieldLinks: "Links",
    peBlockFieldPhotos: "Photos",
    peBlockFieldEvents: "Events",
    peBlockFieldAnnouncements: "Announcements",
    peBlockFieldFaqItems: "FAQ items",
    peBlockFieldDataSource: "Data source",
    peBlockFieldMusicEmbeds: "Profile embeds",
    peBlockFieldTracks: "Tracks",
    peBlockFieldEmbedProvidersHelp:
      "Paste a Spotify, Apple Music, Bandcamp, SoundCloud, YouTube, or Vimeo link. Other links are ignored.",
    peBlockFieldEmbedUrlUnsupported:
      "Unsupported link — use Spotify, Apple Music, Bandcamp, SoundCloud, YouTube, or Vimeo.",
    peBlockFieldEmbedUrlUnsupportedSave:
      "Fix or remove the flagged link before saving.",
    peBlockFieldDownloadable: "Downloadable press asset",
    peBlockFieldDownloadableHint:
      "Let press and bookers download this image directly.",
    peBlockFieldVideos: "Videos",
    peBlockFieldPressMentions: "Press mentions",
    peBlockFieldRequirements: "Requirements",
    peBlockFieldDownloadUrl: "Download URL",
    peBlockFieldTags: "Tags",
    peBlockFieldAddress: "Address",
    peBlockFieldLatitude: "Latitude",
    peBlockFieldLongitude: "Longitude",
    peBlockFieldTotalCapacity: "Total capacity",
    peBlockFieldStandingCapacity: "Standing capacity",
    peBlockFieldSeatedCapacity: "Seated capacity",
    peBlockFieldNotes: "Notes",
    peBlockFieldRequestToPlayIntro: "Intro text",
    peBlockRequestToPlayDefaultIntro:
      "Are you a performer? Send this place a request to play.",
    peBlockRequestToPlayEditorHint:
      "Performers can pitch you here — visible once your place is verified and accepting booking requests.",
    peBlockRequestToPlayComingSoon: "Coming soon",
    peBlockVenueStatsEditorHint:
      "Computed from anonymous performer reviews once enough exist — nothing to fill in. You can hide this block, but performers still see the same aggregates in the Request to Play form.",
    peBlockFieldVenueStatsHelp:
      "Computed from anonymous performer reviews. Not editable.",
    peBlockFieldTrackRecordHelp:
      "Built from shows that happened here — how many, the first and last, who has played. Not editable, and it stays on the page.",
    peBlockAudienceStatsEditorHint:
      "Computed from attendee reviews once enough exist — nothing to fill in. Hidden from the public page until you turn on “Publish attendee ratings” in Page settings.",
    peBlockFieldAudienceStatsHelp:
      "Computed from attendee reviews. Not editable.",
    peBlockFieldRateVenueIntro: "Intro text",
    peBlockRateVenueEditorHint:
      "A one-tap way for performers and attendees to rate this place. Always visible — opens a short form on your public page.",
    peHoursTitle: "Hours of operation",
    peHoursHelp:
      "When your room can host a show. Add a second window for days you open twice — a matinee and an evening are separate bookable slots.",
    peHoursFooter:
      "A closing time at or before the opening time means the night runs past midnight. Close a day and it disappears from the booking calendar entirely.",
    peHoursMonday: "Monday",
    peHoursTuesday: "Tuesday",
    peHoursWednesday: "Wednesday",
    peHoursThursday: "Thursday",
    peHoursFriday: "Friday",
    peHoursSaturday: "Saturday",
    peHoursSunday: "Sunday",
    // Aria-only labels: a weekday can hold several windows, so the time range
    // is part of the name — two windows on one day must not announce alike.
    peHoursOpensAt: "{scope} — {day} opens at ({start}–{end})",
    peHoursClosesAt: "{scope} — {day} closes at ({start}–{end})",
    peHoursNextDay: "+1 day",
    peHoursOpenDay: "Open",
    peHoursCloseDay: "Close",
    peHoursAddWindow: "Add window",
    peHoursRemoveWindow: "Remove window — {scope}, {day} ({start}–{end})",
    peHoursClosedHint: "Closed — hidden from booking",
    peHoursErrorEmpty: "Opening and closing times can't be the same.",
    peHoursErrorInvalid: "Enter a time as HH:MM.",
    peHoursUpdateFailed: "Couldn't update your hours",
    peBlackoutTitle: "Blackout dates",
    peBlackoutHelp:
      "One-off closures — holidays, maintenance, a private hire. These override your hours for the whole date.",
    peBlackoutFooter:
      "Performers see only that the date is unavailable. The note stays in this admin.",
    peBlackoutEmpty: "No blackout dates yet.",
    peBlackoutFrom: "Date",
    peBlackoutTo: "Through (optional)",
    peBlackoutNoteLabel: "Private note (optional)",
    peBlackoutNotePlaceholder: "e.g. Private hire",
    peBlackoutAdd: "Add",
    peBlackoutAddAria: "Add blackout date",
    peBlackoutRemove: "Remove blackout date",
    peBlackoutPrivateNote: "Private note",
    peBlackoutErrorNoDate: "Pick a date first.",
    peBlackoutErrorRange:
      "That range is backwards or longer than {max} days. Add it in smaller pieces.",
    peBlackoutUpdateFailed: "Couldn't update blackout dates",
    // ── Calendars management (venue hierarchy) ──
    // Rail label for the venue-STRUCTURE surface (/calendars: spaces + named
    // calendars + hours/blackouts). Deliberately not "Calendars" so it can't
    // be confused with the Operate group's day-to-day "Calendar" schedule.
    plNavCalendars: "Spaces & availability",
    calMgrTitle: "Spaces & availability",
    calMgrSubtitle:
      "Your place's named programming streams — each with its own spaces, hours, and blackout dates.",
    calMgrCalendarsTitle: "Calendars",
    calMgrCalendarsHelp:
      "A calendar is a public-facing stream of programming — “Social Club”, “Live Music”. Booking requests route to a calendar, and each calendar schedules into one or more spaces.",
    calMgrDefaultBadge: "Default",
    calMgrNoActiveSpaces: "No active spaces",
    calMgrNoSpacesAssigned: "No spaces assigned",
    calMgrNewCalendar: "New calendar",
    calMgrCreate: "Create calendar",
    calMgrEditCalendar: "Edit",
    calMgrSaveCalendar: "Save calendar",
    calMgrNameLabel: "Name",
    calMgrDescriptionLabel: "Description (optional)",
    calMgrDefaultStartLabel: "Default start time",
    calMgrDefaultStartDisplay: "Starts {time}",
    calMgrSlugLabel: "Public link name",
    calMgrSlugHint:
      "Used in public links and embeds — it can't be changed after creation.",
    calMgrSpacesAssignLabel: "Spaces",
    calMgrSpacesRequired: "Every calendar needs at least one space.",
    calMgrSpacesNoneYet:
      "This place has no spaces yet. Add one in the Spaces section below, then create the calendar.",
    calMgrCreateFailed: "Couldn't create the calendar",
    calMgrUpdateFailed: "Couldn't update the calendar",
    calMgrSpacesAssignFailed:
      "The calendar was saved, but its spaces couldn't be assigned",
    // ── Booking config layer (venue-confirmation-and-booking-intents spec,
    // docs/specs/2026-08-27): per calendar, which intents it accepts and its
    // flat rental rate. Public verbs are the spec's: Play here / Rent a space /
    // Use a space — never "request type".
    calMgrBookingLabel: "Booking",
    calMgrBookingHelp: "What people can ask this calendar for.",
    calMgrIntentPerformLabel: "Play here",
    calMgrIntentPerformHint:
      "Acts pitch a show for one of this calendar's nights.",
    calMgrIntentRentLabel: "Rent a space",
    calMgrIntentRentHint:
      "Rent one of its spaces for a window, at your flat rate.",
    calMgrIntentUseLabel: "Use a space",
    calMgrIntentUseHint:
      "Borrow a space without renting it — a rehearsal, a meeting, a community night.",
    calMgrRentalRateLabel: "Rental rate (optional)",
    calMgrRentalRateHint:
      "Flat, per booking — a day or a stated slot. Leave it blank to quote each request.",
    calMgrRentalRateCurrencyLabel: "Currency",
    calMgrRentalRateVisibleLabel: "Show the rate publicly",
    calMgrRentalRateVisibleHint:
      "Renters see it on the request form before they ask.",
    calMgrRentalRateInvalid: "Enter an amount like 500 or 500.00.",
    calMgrRentalRateAmbiguous:
      "Is that 1,500 or 1.500? Use a decimal point for cents.",
    calMgrRentalRateNegative: "A rate can't be negative.",
    calMgrRentalRateCurrencyRequired: "Pick a currency for the rate.",
    calMgrRentalRatePairError:
      "A rate needs both an amount and a currency.",
    // The one-line intent summary on a calendar's list row: "Play · Rent $500".
    calMgrIntentSummaryPerform: "Play",
    calMgrIntentSummaryRent: "Rent",
    calMgrIntentSummaryRentRate: "Rent {rate}",
    calMgrIntentSummaryUse: "Use",
    calMgrIntentSummaryNone: "Not taking requests",
    calMgrSpacesTitle: "Spaces",
    calMgrSpacesHelp:
      "The physical parts of your place that shows are scheduled into — a main stage, a back bar, a patio. Spaces are only visible to you; the public sees calendars.",
    calMgrSpaceNameLabel: "Space name",
    calMgrSpaceCapacityLabel: "Capacity (optional)",
    calMgrCapacityDisplay: "Capacity {count}",
    calMgrAddSpace: "Add space",
    calMgrSpaceRename: "Rename",
    calMgrSpaceSave: "Save space",
    calMgrRetire: "Retire",
    calMgrReactivate: "Reactivate",
    calMgrRetiredBadge: "Retired",
    calMgrLastActiveSpaceHint:
      "A place always keeps at least one active space, so its last active space can't be retired.",
    // Named-calendar refusal: the server sends the blocking calendars back in
    // the error's meta so this can say WHICH one to fix, not just "no".
    calMgrRetireBlockedByCalendars:
      "{count, plural, one {{names} would be left with no active space. Give it another space, then retire this one.} other {{names} would be left with no active space. Give them another space each, then retire this one.}}",
    calMgrSpaceUpdateFailed: "Couldn't update spaces",
    calMgrAvailabilityTitle: "Availability",
    // Orientation only — the resolved consequence is stated by
    // calMgrScopeStatement* right under the picker, so this line no longer
    // re-explains "All calendars".
    calMgrAvailabilityHelp:
      "Hours and blackout dates. Set them once for the whole place, or one calendar at a time.",
    calMgrScopeLabel: "Applies to",
    calMgrScopeAll: "All calendars",
    // The scope is the whole trap on this page: the default is place-wide, so
    // an owner can set hours believing they scoped them to one calendar. These
    // three resolve the active scope in words next to every write surface.
    calMgrScopeAppliesTo: "Applies to: {scope}",
    calMgrScopeStatementAll:
      "These hours and blackout dates apply to every calendar at this place. Pick a calendar above to set hours for just that one.",
    calMgrScopeStatementCalendar:
      "These hours and blackout dates apply only to {calendar}. Your other calendars keep their own.",
    peAttendeeReviewsPublicTitle: "Publish attendee ratings",
    peAttendeeReviewsPublicHelp:
      "Show the attendee rating summary on your public place page. Off by default — attendee feedback stays private to you until you publish it. Performer stats are separate and unaffected.",
    peAttendeeReviewsPublicUpdateFailed: "Couldn't update attendee ratings",
    // The PERFORMER-review switch (venue-track-record-and-review-switch
    // FR-007). The off-state line says what STAYS, because "off" reads as
    // "deleted" otherwise.
    peCommunityReviewsTitle: "Performer reviews",
    peCommunityReviewsHelpOn:
      "Performers can review this place and the survey shows on your page.",
    peCommunityReviewsHelpOff:
      "No new performer reviews. Reviews already written stay visible to you.",
    peCommunityReviewsUpdateFailed: "Couldn't update performer reviews",
    peAttendeeFeedbackTitle: "Attendee feedback",
    peAttendeeFeedbackSubtitle:
      "Everything attendees told us about your place — private to you, whether or not you publish the summary. Names are never shown.",
    peAttendeeFeedbackVerifiedLabel: "Verified (ticket scanned)",
    peAttendeeFeedbackCommunityLabel: "Community (unverified)",
    peAttendeeFeedbackReviewCount:
      "{count, plural, one {# review} other {# reviews}}",
    peAttendeeFeedbackAvgOverall: "Avg. overall",
    peAttendeeFeedbackSourceVerified: "Verified",
    peAttendeeFeedbackSourceCommunity: "Community",
    peAttendeeFeedbackRating: "{score} / 5",
    peAttendeeFeedbackNoText: "No written feedback",
    peAttendeeFeedbackEmpty: "No attendee feedback yet.",
    peAttendeeFeedbackLoadError: "Couldn't load attendee feedback.",
    peAttendeeFeedbackFlag: "Report",
    peAttendeeFeedbackFlagged: "Reported",
    peAttendeeFeedbackFlagFailed: "Couldn't report this review",
    peAttendeeFeedbackFlagAria: "Report this review to moderators",
    peBlockFieldRules: "Rules",
    peBlockFieldAmenities: "Amenities",
    peBlockFieldSpecs: "Specs",
    peBlockFieldValue: "Value",
    peBlockFieldContactEmail: "Contact email",
    peBlockFieldContactPhone: "Contact phone",
    peBlockFieldBookingUrl: "Booking URL",
    peBlockFieldTeamMembers: "Team members",
    peBlockFieldLabel: "Label",
    peBlockFieldUrl: "URL",
    peBlockFieldIcon: "Icon",
    peBlockFieldAltText: "Alt text",
    peBlockFieldCaption: "Caption",
    peBlockFieldQuestion: "Question",
    peBlockFieldAnswer: "Answer",
    peBlockFieldTitle: "Title",
    peBlockFieldBody: "Body",
    peBlockFieldDate: "Date",
    peBlockFieldSource: "Source",
    peBlockFieldExcerpt: "Excerpt",
    peBlockFieldName: "Name",
    peBlockFieldRole: "Role",
    peBlockFieldAvatarUrl: "Avatar URL",
    peThemeTitle: "Theme",
    peThemeDescription:
      "Customize colors, font, and layout for your page. Use CSS color values (e.g. #ff5500, rgb(255,85,0)).",
    peColorPrimaryLabel: "Primary color",
    peColorBgLabel: "Background color",
    peColorTextLabel: "Text color",
    peColorPairHint: "Set both colors, or use a valid hex, rgb or hsl value.",
    peFontKeyLabel: "Typography",
    peLayoutKeyLabel: "Page layout",
    peThemeFontMontserrat: "Montserrat",
    peThemeFontSystem: "System sans",
    peThemeFontSerif: "System serif",
    peThemeFontMono: "Monospace",
    peThemeFontEditorial: "Editorial serif",
    peThemeFontCondensed: "Condensed sans",
    peThemeLayoutStandard: "Standard template",
    peThemeLayoutStandardHelp: "Polished, industry-standard layout",
    peThemeLayoutFreeformHelp: "Freeform canvas you arrange with blocks",
    peThemeLayoutStack: "Freeform — stacked",
    peThemeLayoutGrid: "Freeform — grid",
    peThemeLayoutLockedHint:
      "The block editor is disabled, so only the Standard layout is available.",
    peThemeLayoutPreview: "Page layout preview",
    peSaveTheme: "Save theme",
    peThemeUpdated: "Theme updated",
    peThemeUpdatedMessage: "Your page theme has been saved.",
    peThemeUpdateFailed: "Failed to update theme",

    // ── Verification section ──
    placeVerifHeading: "Verification",
    placeVerifVerified: "Verified",
    placeVerifPending: "Pending verification",
    placeVerifUnverified: "Unverified",
    placeVerifRejected: "Rejected",
    placeVerifRequestButton: "Request Verification",
    placeVerifModalTitle: "Request verification",
    placeVerifBlockedHeading: "Before you can submit",
    placeVerifKeepFilesTitle: "Your documents are still attached",
    placeVerifKeepFilesMessage:
      "Use Cancel or the close button if you want to discard them.",
    placeVerifDiscardConfirm:
      "Discard the documents you attached? They will not be uploaded.",
    placeVerifUploadingCloseBlocked: "Upload in progress — hold on a moment.",
    placeVerifSaveFirst: "Save your changes before requesting verification.",
    placeVerifAllRequirementsMet: "All requirements met. Ready to submit.",
    placeVerifWhatToUpload: "What to upload",
    placeVerifUploadInstructions:
      "Upload documents proving your group operates this place. We only need the business name and place address to be visible \u2014 you may redact all other information (tax IDs, financial figures, personal details, etc.).",
    placeVerifAcceptedFormats:
      "Accepted formats: PDF, JPEG, PNG. Max 10 MB per file, up to 5 files.",
    placeVerifSecureStorage:
      "Documents are stored securely and deleted immediately after review.",
    placeVerifMaxFilesReached: "Maximum files reached",
    placeVerifDropOrBrowse: "Drop files here or click to browse",
    placeVerifFormatHint: "PDF, JPEG, PNG \u2014 up to 10 MB each",
    placeVerifFilesCount: "{count} of {max} files",
    placeVerifRemoveFile: "Remove {fileName}",
    placeVerifCancel: "Cancel",
    placeVerifUploading: "Uploading\u2026",
    placeVerifSubmitForReview: "Submit for Review",
    placeVerifPendingMessage:
      "Your place is currently under review. You'll be notified once a decision is made.",
    placeVerifVerifiedMessage:
      "This place has been verified by the Ithas Fire team.",
    placeVerifBenefitsHeading: "Why verify?",
    placeVerifBenefitDiscovery:
      "\u2022 Public place page and search visibility",
    placeVerifBenefitSeatMaps: "\u2022 Seat map and reserved-seating support",
    placeVerifBenefitTrust: "\u2022 Verified badge shown to attendees",
    placeVerifBenefitDefaults:
      "\u2022 Promoters can request to host events at your place",
    placeVerifSomeFilesNotAdded: "Some files were not added",
    placeVerifMaxFilesError: "Maximum {max} files allowed.",
    placeVerifUnsupportedFormat:
      '"{fileName}" is not a supported format. Use PDF, JPEG, or PNG.',
    placeVerifFileTooLarge: '"{fileName}" exceeds the 10 MB limit.',
    placeVerifDuplicateFile: '"{fileName}" is already added.',
    placeVerifNoDocuments: "No documents",
    placeVerifNoDocumentsMessage:
      "Please add at least one document before submitting.",
    placeVerifSaveFirstTitle: "Save first",
    placeVerifSaveFirstMessage:
      "Please save your changes before requesting verification.",
    placeVerifNoOrg: "No group",
    placeVerifNoOrgMessage:
      "This place must belong to a group to request verification.",
    placeVerifSubmitted: "Verification submitted",
    placeVerifSubmittedMessage:
      "Your documents have been uploaded and your place is now under review.",
    placeVerifSubmitFailed: "Submission failed",
    // ── Live request-state panels (queue / in-review / rejected) ──
    placeVerifQueueHeading: "In queue",
    placeVerifQueuePosition: "Position {position} of {total} pending requests.",
    placeVerifQueueWaiting:
      "Waiting for a platform admin to pick up your request.",
    placeVerifWithdraw: "Withdraw",
    placeVerifInReviewHeading: "Reviewer is looking now",
    placeVerifInReviewNamed:
      "{name} acknowledged your request and is reviewing it. A decision should be coming soon.",
    placeVerifInReviewAnon:
      "A platform admin has acknowledged your request and is reviewing it now.",
    placeVerifReviewerFeedback: "Reviewer feedback",
    placeVerifReuseDocsLabel: "Reuse documents from previous request",
    placeVerifReuseDocsHint:
      "Carry forward {count, plural, one {the # document} other {the # documents}} from your last rejected submission instead of re-uploading.",

    // ── Venue calendar ──
    venueCalendarLoading: "Loading calendar...",
    venueCalendarAccessDenied: "Access Denied",
    venueCalendarAccessDeniedDescription:
      "You don't have permission to view this place's calendar.",
    venueCalendarGenericError: "Something went wrong",
    venueCalendarGenericErrorDescription:
      "Unable to load the calendar. Please try again.",
    venueCalendarBackToVenue: "Back to place",
    venueCalendarHeading: "Place Calendar",
    venueCalendarEventCount: "{count, plural, one {# event} other {# events}}",
    venueCalendarConflictCount:
      "{count, plural, one {# double-booking} other {# double-bookings}}",
    // Venue confirmation (docs/specs/2026-08-27): third-party listings at
    // this venue. "Confirmed by venue" / "unconfirmed" — never "verified"
    // (that's the Place) or "approved".
    venueCalUnconfirmed: "Unconfirmed",
    venueCalUnconfirmedHelp:
      "Listed at your place by someone else. It doesn't block your calendar until you confirm.",
    /** Confirm dialog, at a venue that hides its address: what Confirm releases. */
    venueCalConfirmSharesAddress:
      "Confirming lets this event's ticket holders see your address — no earlier than a day before it starts, and not at all if the event never reveals it.",
    venueCalConfirm: "Confirm",
    venueCalConfirming: "Confirming\u2026",
    venueCalNotMine: "Not mine",
    venueCalNotMineReasonLabel: "Reason",
    venueCalNotMineReasonRequired: "Give the organizer a reason.",
    venueCalNotMineHelp:
      "The organizer keeps the listing but it shows an address only and won't block your calendar.",
    venueCalNotMineSubmit: "Mark as not mine",
    venueCalNotMineSending: "Sending\u2026",
    venueCalBack: "Back",
    venueCalActionFailed: "Couldn't update this event",
    venueCalConfirmed: "Confirmed. The organizer has been told.",
    venueCalNotMineDone:
      "Marked as not mine. The organizer has been told. It stays listed here as unconfirmed.",
    // Confirmed third-party event: the undo.
    venueCalConfirmedByVenue: "Confirmed by the place",
    venueCalConfirmedHelp:
      "You confirmed this event. Withdrawing sends the organizer your reason; the event stays listed with an address only and stops blocking your calendar.",
    venueCalWithdraw: "Withdraw confirmation",
    venueCalWithdrawing: "Withdrawing\u2026",
    venueCalWithdrawn: "Confirmation withdrawn. The organizer has been told.",

    // ── Place layout editor ──
    layoutLoading: "Loading layout\u2026",
    layoutAccessDenied: "Access denied",
    layoutAccessDeniedDescription:
      "You don't have permission to view this layout.",
    layoutNotFound: "No layout found",
    layoutNotFoundDescription:
      "This place doesn't have a seat layout yet. Upload one to get started.",
    layoutGenericError: "Something went wrong",
    layoutGenericErrorDescription: "An unexpected error occurred.",
    layoutBackToPlaces: "Back to Places",
    layoutDesignLayout: "Design Layout",
    layoutGoToPlace: "Go to Place",
    layoutBackToEdit: "Back to edit place",
    layoutReturnToEvent: "Back to event",
    layoutHeading: "Seat Layout",
    layoutEditLayout: "Edit Layout",
    layoutNewLayout: "New Layout",
    layoutDelete: "Delete",
    layoutDeleteConfirm: "Delete this layout?",
    layoutDeleting: "Deleting\u2026",
    layoutConfirm: "Confirm",
    layoutCancel: "Cancel",
    layoutDeleted: "Layout deleted",
    layoutDeletedMessage: "The seat layout has been removed.",
    layoutDeleteFailed: "Delete failed",
    layoutSeats: "Seats",
    layoutSections: "Sections",
    layoutBounds: "Bounds",
    layoutChecksum: "Checksum",
    layoutUpdated: "Updated",
    layoutGlyphUnavailable:
      "Glyph data is unavailable. The layout file may still be processing.",
    layoutSectionsHeading: "Sections",
    layoutSeatCount: "{count} seats",
    layoutStage: "Stage",
    layoutPlaceId: "Place ID: {placeId}",
    layoutId: "Layout ID: {layoutId}",

    // ── Place layout canvas ──
    canvasLoadingSeatData: "Loading seat data\u2026",
    canvasZoomIn: "Zoom in",
    canvasZoomOut: "Zoom out",
    canvasFitToView: "Fit to view",

    // ── Desktop-only tools ──
    desktopOnlyTitle: "Best on a larger screen",
    desktopOnlyBody:
      "This tool needs a larger screen. Switch to a desktop or a tablet in landscape mode to continue.",

    // ── Place layout designer ──
    designerDesktopRequired: "Desktop required",
    designerDesktopRequiredDesc:
      "The layout designer requires a larger screen. Please switch to a desktop or tablet in landscape mode.",
    designerBackToLayout: "Back to layout",
    designerLoadFailed: "Load failed",
    designerLoadFailedMsg:
      "Could not load the existing layout. Starting fresh.",
    designerLoadingExisting: "Loading existing layout\u2026",
    designerBackToLayoutView: "Back to layout view",
    designerHeading: "Layout Designer",
    designerInteractive: "Interactive",
    designerLayoutSaved: "Layout saved",
    designerLayoutSavedMsg: "{seatCount} seats across {sectionCount} sections.",
    designerSaveFailed: "Save failed",
    designerSaveFailedMsg: "An unexpected error occurred.",
    designerSaveNoStorage:
      "File storage is not configured. Ensure MinIO (or S3) is running and S3_BUCKET / S3_ENDPOINT env vars are set.",
    designerSaveParserError:
      "The layout data could not be parsed. Try removing invalid sections or seats and saving again.",

    // ── Floating config panel ──
    configPanelGroupKind: "{kind} group",
    configPanelSeatCount: "{count, plural, one {# seat} other {# seats}}",
    configPanelClosePanel: "Close panel",
    configPanelRow: "Row",
    configPanelSeat: "Seat",
    configPanelSeatsSelected: "{count} seats selected",
    configPanelCount: "Count",
    configPanelGap: "Gap",
    configPanelGapX: "GapX",
    configPanelGapY: "GapY",
    configPanelCols: "Cols",
    configPanelRows: "Rows",
    configPanelRadius: "Radius",
    configPanelArc: "Arc",
    configPanelDeg: "deg",
    configPanelRotate: "Rotate",

    // ── Designer toolbar ──
    toolbarLayoutName: "Layout Name",
    toolbarLayoutNamePlaceholder: "e.g. Main Hall",
    toolbarSections: "Sections",
    toolbarSeats: "Seats",
    toolbarView: "View",
    toolbarZoomIn: "Zoom in",
    toolbarZoomOut: "Zoom out",
    toolbarFitToView: "Fit to view",
    toolbarSectionDrawing: "Section Drawing",
    toolbarKind: "Kind",
    toolbarKindSeat: "Seat",
    toolbarKindGa: "GA",
    toolbarKindHelper: "Helper",
    toolbarGaCapacity: "Capacity",
    toolbarGaCapacityHint: "Maximum admissions for this section",
    toolbarGaInfo: "GA section \u2014 capacity: {capacity}",
    toolbarColor: "Color",
    toolbarVerticesHint:
      "{count} vertices \u2014 double-click or click near first vertex to close",
    toolbarSeatPlacement: "Seat Placement",
    toolbarRow: "Row",
    toolbarNextNum: "Next #",
    toolbarSeatRadius: "Radius",
    toolbarPlacedInRow: "Placed in row {row}",
    toolbarSelectASeat: "Select a seat...",
    toolbarSelectSectionFirst: "Select a section first to place seats",
    toolbarLinePlacement: "Line Placement",
    toolbarArcPlacement: "Arc Placement",
    toolbarGridPlacement: "Grid Placement",
    toolbarCount: "Count",
    toolbarCols: "Cols",
    toolbarRows: "Rows",
    toolbarGap: "Gap",
    toolbarGapX: "GapX",
    toolbarGapY: "GapY",
    toolbarGridGapHint:
      "GapX/GapY = center-to-center distance (0 = auto-fill between corners)",
    toolbarLineGapHint:
      "Gap = center-to-center distance between seats (0 = evenly distributed)",
    toolbarLineInstructions:
      "Click start, move, click end to place seats in a line",
    toolbarArcInstructions:
      "Click center, move to set radius, click to place arc",
    toolbarGridInstructions:
      "Click origin, drag to opposite corner for a seat grid",
    toolbarBoxSection: "Box Section",
    toolbarBoxSectionHint:
      "Click and drag to draw a rectangular section (min 5x5)",
    toolbarStroke: "Stroke",
    toolbarStrokeWidth: "Width",
    toolbarStrokeHint:
      "Click to place anchors, drag to curve handles. Double-click or Enter to finish.",
    toolbarBackgroundImage: "Background Image",
    toolbarImportImage: "Import reference image",
    toolbarRemoveImage: "Remove image",
    toolbarAutoDetect: "Auto-detect sections & seats",
    toolbarOpacity: "Opacity",
    toolbarSectionsCount: "Sections ({count})",
    toolbarDrawPolygonHint: "Draw a polygon to create a section",
    toolbarSeatCountLabel: "{count} seats",
    toolbarHelper: "helper",
    toolbarMoveUp: "Move up",
    toolbarMoveDown: "Move down",
    toolbarRename: "Rename",
    toolbarDeleteSection: "Delete section",
    toolbarCollapse: "Collapse seats",
    toolbarExpand: "Expand seats",
    toolbarRowLabel: "Row {row}",
    toolbarStrokesCount: "Strokes ({count})",
    toolbarPts: "{count} pts",
    toolbarDeleteStroke: "Delete stroke",
    toolbarPlaceSeatsAlongStroke: "Place Seats Along Stroke",
    toolbarPlaceSeats: "Place {count} Seats",
    toolbarPlacementGroups: "Placement Groups ({count})",
    toolbarGroupLabel: "{kind} \u00B7 {seatCount} seats",
    toolbarCountBased: "count-based",
    toolbarGapValue: "gap {spacing}",
    toolbarGridDims: "{rows}\u00D7{cols}",
    toolbarStrokeKind: "stroke",
    toolbarMoveGroupUp: "Move group up",
    toolbarMoveGroupDown: "Move group down",
    toolbarDeleteGroupSeats: "Delete group & its seats",
    toolbarEditGroup: "Edit {kind} group",
    toolbarGroupCount: "Count",
    toolbarGroupCols: "Cols",
    toolbarGroupRows: "Rows",
    toolbarGroupGap: "Gap",
    toolbarGroupGapX: "GapX",
    toolbarGroupGapY: "GapY",
    toolbarGroupRadius: "Radius",
    toolbarGroupArc: "Arc",
    toolbarGroupRotate: "Rotate",
    toolbarDragHandlesHint: "Drag handles on canvas to adjust geometry",
    toolbarActions: "Actions",
    toolbarUndo: "Undo",
    toolbarRedo: "Redo",
    toolbarImportCsv: "Import CSV",
    toolbarExportCsv: "Export CSV",
    toolbarDeleteSelected: "Delete selected",
    toolbarClearAll: "Clear all",
    toolbarSaving: "Saving\u2026",
    toolbarSaveLayout: "Save Layout",
    toolbarEnterNameToSave: "Enter a layout name to save",
    toolbarSummary: "{seats} seats \u00B7 {sections} sections",
    toolbarSummaryImage: " \u00B7 Image",
    toolbarSummaryUndo: " \u00B7 {count} undo",
    toolbarSummaryRedo: " \u00B7 {count} redo",
    toolbarSelectedSummary: "Selected: {seats} seats, {sections} sections",
    toolbarStrokeColorLabel: "Stroke color",
    toolbarStrokeWidthLabel: "Stroke width",
    toolbarImageOpacityLabel: "Image opacity",
    toolbarRenameSectionLabel: "Rename section",

    // ── Quick create (event-builder regroup FR-301) ──
    qcHeading: "New event",
    qcStep: "step 1 — the basics",
    qcStartsAt: "Starts at",
    qcVenue: "Place",
    qcCreateDraft: "Create draft",
    qcBuilderNext:
      "Next you'll land in the full builder — details, tickets, lineup, and publishing.",
    qcTitleRequired: "Give the event a title.",
    qcStartsAtRequired: "Pick a start date and time.",
    qcVenueHint:
      "Not one of your places? Leave it blank and pick any place in the builder.",
    qcVenueUnresolved:
      "Choose the address from the suggestions, or clear the box to skip it.",

    // ── EventBuilder ──
    ebEditEvent: "Edit Event",
    ebCreateEvent: "Create Event",
    ebBackToEvents: "Back to events",
    ebTabEdit: "Edit",
    ebTabPreview: "Preview",
    ebTabSuggestions: "Suggestions",
    ebTabFeedback: "Feedback",
    ebViewEvent: "View Event",
    // FR-204: header action opening the live public draft page in a new tab.
    ebPreviewEvent: "Preview",
    // D4 reversed (2026-07-28): Edit|Preview segmented toggle in the builder
    // header (group aria-label) + the demoted new-tab preview icon-button.
    ebViewModeLabel: "View mode",
    ebPreviewNewTab: "Open preview in a new tab",
    // FR-205: Tickets-section entry to the full-screen seating takeover.
    ebSeatingMap: "Seating map",
    // Leaves the builder and returns to the events list. Deliberately NOT
    // "Cancel": it used to sit right next to "Cancel Event", which cancels the
    // real event and notifies buyers.
    ebCloseBuilder: "Close",
    ebSaving: "Saving\u2026",
    ebCreateSeries: "Create Series",
    ebSaveDraft: "Save Draft",
    ebSave: "Save",
    ebSavedTitle: "Event saved",
    ebSavedMessage: "Your changes have been saved successfully.",
    ebUnsavedChanges: "Unsaved changes",
    ebLeaveTitle: "Leave this page?",
    ebLeaveBody: "Your unsaved changes to this event will be lost.",
    ebLeaveStay: "Keep editing",
    ebLeaveDiscard: "Leave and discard",
    ebPlaceNudgeTitle: "Create a place for this address?",
    ebPlaceNudgeMessage:
      "You\u2019ve used this address for {count} events. Create a Place to unlock seat maps, verification, and auto-filled details.",
    ebUnverifiedPlaceHint:
      "Verify this place to enable public discovery and reserved seating.",
    ebPublishing: "Publishing\u2026",
    ebPublish: "Publish",
    ebUnpublish: "Unpublish",
    ebCancelling: "Cancelling\u2026",
    ebCancelEvent: "Cancel Event",
    ebPublicLink: "Public link",
    ebHeroImage: "Hero Image",
    ebClickToUpload: "Click to upload hero image",
    ebRecommendedSize: "Recommended: 1200 \u00D7 600px",
    ebHeroImageTooLarge: "Image is too large. Max 25 MB.",
    ebImageInvalidType: "Use a JPEG, PNG, GIF, WebP, or SVG image.",
    ebImageInvalidTypeRaster: "Use a JPEG, PNG, GIF, or WebP image.",
    ebUploadFailedTitle: "Upload failed",
    ebUploadFailedMessage: "Image upload failed. Please try again.",
    ebUploadStorageError:
      "File storage is unavailable. Check your configuration or try again later.",
    ebEventTitle: "Event Title",
    ebEventTitlePlaceholder: "What's the event called?",
    ebDateTime: "Date & Time",
    ebStarts: "Starts",
    ebEnds: "Ends",
    ebRecurrence: "Recurrence",
    ebAdvancedSettings: "Advanced Settings",
    ebAccessVisibility: "Access & Visibility",
    ebSettingsHeading: "Settings",
    ebSettingsScheduling: "Scheduling",
    ebSettingsAccessPrivacy: "Access & privacy",
    ebSettingsMoneyCompliance: "Money & compliance",
    ebSettingsSharing: "Sharing",
    ebSummaryOneTime: "one-time event",
    ebSummaryRecurring: "recurring",
    ebSummaryRepeatsDaily: "repeats daily",
    ebSummaryRepeatsWeekly: "repeats weekly",
    ebSummaryRepeatsMonthly: "repeats monthly",
    ebSummaryRepeatsYearly: "repeats yearly",
    ebSummaryVisibilityPublic: "public",
    ebSummaryVisibilityPrivate: "private",
    ebSummaryAddressExact: "exact address",
    ebSummaryAddressRevealImmediately: "area until RSVP",
    ebSummaryAddressRevealHourBefore: "address 1h before",
    ebSummaryAddressRevealDayBefore: "address day before",
    ebSummaryAddressRevealWeekBefore: "address week before",
    ebSummaryAddressRevealCustom: "address at set time",
    ebSummaryTaxStandard: "standard tax",
    ebSummaryTaxInstructional: "instructional admission",
    ebSummaryWaiverNone: "no waiver",
    ebSummaryWaiverRequired: "waiver required",
    ebHideAddressLink: "Hide the address?",
    ebRevenueSplits: "Revenue splits",
    // ── Publish-readiness rail (FR-104) ──
    ebReadinessTitle: "Ready to publish?",
    ebReadinessCounter: "{done} of {total}",
    ebReadinessSummaryReady: "{done} of {total} ready",
    ebReadinessSummaryNext: "next: {label}",
    ebReadinessItemEssentials: "Essentials",
    ebReadinessItemEssentialsDesc: "Add a title, start time, and place.",
    ebReadinessItemCategory: "Category",
    ebReadinessItemCategoryDesc: "Pick a category for the event.",
    ebReadinessItemDetails: "Event details",
    ebReadinessItemDetailsDesc: "Tell attendees what to expect.",
    ebReadinessItemTickets: "Ticket types",
    ebReadinessItemTicketsDesc: "Add at least one ticket type.",
    ebReadinessItemLineup: "Lineup",
    ebReadinessItemLineupOptional: "Lineup — optional",
    ebReadinessItemStripe: "Stripe payouts",
    ebReadinessItemStripeDesc:
      "Finish Stripe onboarding to publish paid tickets.",
    ebReadinessItemTerms: "Chargeback terms",
    ebReadinessItemTermsDesc: "Accept the paid checkout terms.",
    ebReadinessItemAttestation: "Host attestation",
    ebReadinessItemAttestationDesc:
      "Confirm host responsibilities before publishing.",
    ebReadinessActionGo: "Go to section",
    ebReadinessActionConfirm: "Confirm",
    ebShortLink: "Short Link",
    ebPayoutSchedule: "Payout Schedule",
    ebSplitsReady: "Splits ready",
    ebSplitsNeedsAttention: "Needs attention",
    ebSplitsBalanced: "Balanced",
    ebSplitsSavedTitle: "Splits saved",
    ebSplitsSaveFailedTitle: "Could not save splits",
    ebSplitsTabTickets: "Tickets",
    ebSplitsTabResale: "Resale",
    ebSplitsTabMerch: "Merch — coming with POS",
    ebSplitsOwnerDesc:
      "Event owner — gets whatever's left after the other splits",
    ebSplitsFromLineup: "From lineup",
    ebSplitsManual: "Manual",
    ebSplitsConnectPending: "Connect pending",
    ebSplitsRemoveLine: "Remove line",
    ebSplitsAutoCalculated: "Auto-calculated",
    ebSplitsPayeePlaceholder: "Sound engineer, manager, co-promoter…",
    ebSplitsPayeeFallback: "Payee",
    ebSplitsOwnerFallback: "Owner",
    ebSplitsSharePercentAria: "{name} share percent",
    ebSplitsOverBy: "Over by {amount}",
    ebSplitsOwnerLegend: "Owner {amount}",
    ebSplitsNoPayee: "no payee",
    ebSplitsCaption:
      "Splits divide the ticket price from each sale. The buyer pays the platform fee and Stripe processing fees on top, so they don't reduce this pool.",
    ebSplitsEmpty:
      "No payees yet. Add lineup performers, vendors, or co-promoters below — the owner gets the rest automatically.",
    ebSplitsSearchLabel: "Search human (or paste id for org)",
    ebSplitsAdd: "Add",
    ebSplitsSave: "Save splits",
    ebSplitsPublishBlockersTitle: "Before you can publish",
    ebSplitsComingSoon:
      "Coming soon: set different splits for each ticket type — for example, give the place a larger cut on VIP tickets that include dinner without changing the GA breakdown.",
    ebSplitsBlockerOverAllocated:
      "Other payees are claiming {amount} more than the owner has to give. Lower one or more shares to balance.",
    ebSplitsBlockerConnectOne:
      "1 payee still needs to finish Stripe Connect setup before payouts can run. Look for the highlighted row.",
    ebSplitsBlockerConnectMany:
      "{count} payees still need to finish Stripe Connect setup before payouts can run. Look for the highlighted rows.",
    ebPayoutValue: "Payout: {label}",
    ebPayoutExpected: "Expected payout: {date}",
    ebPayoutSetDate: "Set an event date to see the expected payout date.",
    ebPayoutManageInPayments: "Manage in Payments",
    ebPayoutsOwnerOnly: "Only the event's owner can change payouts.",
    ebManagingPrincipalEvent: "Managing {name}'s event",
    ebManagingDelegatedEvent: "Managing this event for its owner",
    ebPayoutSchedAsap: "2 days after event (fastest)",
    ebPayoutSchedWeekOf: "Week of event",
    ebPayoutSchedOneWeek: "1 week after event",
    ebPayoutSchedTwoWeeks: "2 weeks after event",
    ebPayoutSchedFourWeeks: "~1 month after event",
    ebSeriesUpdatedTitle: "Series updated",
    ebSeriesUpdatedMessage: "The recurring series schedule has been updated.",
    ebSeriesConvertedTitle: "Repeats saved",
    ebSeriesConvertedMessage:
      "{count, plural, =0 {This event now repeats on the schedule you chose.} one {# upcoming date was added as a draft.} other {# upcoming dates were added as drafts.}}",
    ebSeriesConvertPartialTitle: "Repeats partially applied",
    ebSeriesConvertPartialMessage:
      "The series was created, but we couldn't finish setting up the upcoming dates: {reason}",
    ebRecurrenceFailedTitle: "Couldn't set up repeats",
    ebRecurrenceNotAppliedTitle: "Event saved without repeats",
    ebRecurrenceNotAppliedMessage:
      "The event was saved, but the repeat schedule couldn't be applied: {reason}",
    ebSeriesReconciledWithDetach:
      "{detached, plural, one {# occurrence was detached from the series.} other {# occurrences were detached from the series.}}",
    ebReconcileConfirmTitle: "Detach events with orders?",
    ebReconcileConfirmBody:
      "{count, plural, one {# published event with existing orders no longer matches the new schedule and will be detached from the series.} other {# published events with existing orders no longer match the new schedule and will be detached from the series.}}",
    ebReconcileConfirmNote:
      "Detached events keep their tickets and orders but are no longer managed by the series schedule.",
    ebReconcileConfirmAction:
      "{count, plural, one {Detach # event} other {Detach # events}}",
    ebReconcileOrderCount: "{count, plural, one {# order} other {# orders}}",
    ebScopeDialogTitle: "Apply changes to",
    ebScopeThisLabel: "This show only",
    ebScopeThisDesc:
      "Only {date} changes. Other dates keep their current details.",
    ebScopeFollowingLabel: "This and following shows",
    ebScopeFollowingDesc:
      "Applies to this show and future draft shows. Published dates stay as they are.",
    ebScopeAllLabel: "All shows",
    ebScopeAllDesc:
      "Applies to every draft show, past and future. Published dates stay as they are.",
    ebScopeScheduleNote:
      "Changes to the repeat schedule always apply to the whole series, whatever you choose here.",
    ebScopeIncludeArrivalAreas: "Also replace parking and drop-off areas on these shows",
    ebScopeSyncedTitle: "Draft shows updated",
    ebScopeSyncedMessage:
      "{count, plural, =0 {No other draft shows needed updating.} one {Updated # draft show.} other {Updated # draft shows.}}",
    ebScopeSyncedPublishedNote:
      "{count, plural, one {# published date unchanged — edit it individually.} other {# published dates unchanged — edit them individually.}}",
    ebScopeSyncFailedTitle: "Changes saved to this show only",
    ebScopeSyncFailedMessage:
      "This show was saved, but the changes couldn't be copied to the other dates: {reason} Save again with the same choice to retry.",
    ebSeriesUpdatePartialTitle: "Schedule not updated",
    ebSeriesUpdatePartialMessage:
      "Your changes to this show were saved, but the series schedule couldn't be updated: {reason}",
    rbEditingSeriesNote:
      "You're editing the schedule for all future occurrences in this series.",
    ebLocation: "Location",
    ebAddress: "Address",
    ebMyPlaces: "My Places",
    ebLocating: "Locating\u2026",
    ebUseMyLocation: "Use my location",
    ebResetLocation: "Reset location",
    ebLocationVisibility: "Location Visibility",
    ebLocationVisibilityHint:
      "Control how much location detail is shown to the public before ticket purchase.",
    ebVisibilityExact: "Exact",
    ebVisibilityApproximate: "Approximate",
    ebVisibilityHidden: "Hidden",
    ebRadiusKm: "Radius: {value} km",
    ebRadiusM: "Radius: {value} m",
    ebPublicLabel: "Public label (optional)",
    ebPublicLabelPlaceholderHidden: "e.g. \u201CDowntown Brooklyn\u201D",
    ebPublicLabelPlaceholderApprox: "e.g. \u201CNear Prospect Park\u201D",
    ebAddressRevealHint:
      "For hidden locations, choose when ticket holders can see the exact address.",
    ebRevealImmediately: "Immediately after purchase",
    ebRevealOneHour: "1 hour before start",
    ebRevealDayBefore: "24 hours before start",
    ebRevealWeekBefore: "7 days before start",
    ebRevealCustom: "Custom time",
    ebRevealCustomLabel: "Reveal at",
    ebRevealCustomRequiredTitle: "Reveal time required",
    ebRevealCustomRequiredMessage:
      "Choose the date and time when the exact address should unlock.",
    ebRevealTimezoneNote: "Times use the event timezone: {timezone}.",
    ebRevealNotice: "Exact address unlocks {date} for ticket holders.",
    /** The same notice on an RSVP listing: people who RSVP get the street too. */
    ebRevealNoticeRsvp: "Exact address unlocks {date} for people who RSVP.",
    // ── Two-mode location visibility (LocationVisibilitySection) ──
    ebVisibilityExactAddress: "Exact address",
    ebVisibilityExactAddressDesc: "Full address and map shown to everyone.",
    ebVisibilityObscured: "Obscured",
    ebVisibilityObscuredDesc:
      "Public sees a fuzzed area or none; ticket holders get the exact address at the reveal time.",
    ebPublicPrecision: "Public precision",
    ebPublicPrecisionSliderAria: "Public location precision",
    ebPublicPrecisionCircleValue: "Obfuscated circle, {distance} radius",
    ebPrecisionTightCircle: "Tight circle",
    ebPrecisionHiddenStop: "Hidden — no public map",
    ebPublicPreviewCircle:
      "Public sees: obfuscated circle, ~{distance} radius.",
    ebPublicPreviewHidden: "Public sees: area label only — no map.",
    ebAddressReveal: "Address reveal",
    ebAddressRevealSelectAria:
      "When the exact address is revealed to ticket holders",
    ebUnitsMetricAria: "Use metric units",
    ebUnitsImperialAria: "Use imperial units",

    // ── "Never reveal" (AddressRevealPreset.NEVER) ──────────────────────
    // The one preset that resolves a NULL reveal date on purpose. It is easy
    // to pick by accident, so the consequence is stated in full right under
    // the control rather than left to the summary line.
    ebRevealNever: "Never — nobody gets the address",
    ebRevealNeverConsequence:
      "Nobody gets this address through Ithas Fire, ticket holders included. You'll have to send it yourself.",

    // ── Venue ceiling (place-address-withholding) ───────────────────────
    // An event can never be more precise in public than the venue it is at.
    // The server enforces this inside the save transaction and again on read;
    // these strings are the courtesy that stops an organizer from filling in a
    // choice the server is going to overrule.
    ebVisibilityLockedByVenueHidden:
      "Set by the place. {venue} never publishes its address, so events here can't either.",
    ebVisibilityLockedByVenueArea:
      "Set by the place. {venue} publishes an approximate area, so events here can't be more precise than that.",
    /** Shown while the venue's setting is still loading — fail closed, not open. */
    ebVisibilityLockedChecking:
      "Checking what this place allows. Exact address stays off until it answers.",
    ebVisibilityExactUnavailable: "Not available here",
    /**
     * Under the reveal select, at a venue that hides its address, for anyone
     * who doesn't manage that venue: their reveal choice is not the last word.
     */
    /**
     * Toast action on EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE: switches the
     * location to My Places with the venue the typed address belongs to.
     */
    ebUseOwnWithheldPlace: "Use {placeName}",
    ebRevealGatedByVenue:
      "This place hides its address. Ticket holders get it only after the place confirms your event, and no earlier than a day before it starts.",
    ebUnlockMap: "Unlock",
    ebSaveLocation: "Save Location",
    ebEventDetails: "Event Details",
    ebStarterLabel: "Start from",
    ebStarterOpenMicName: "Open mic",
    ebStarterOpenMicIntro: "[Describe the night in a sentence or two.]",
    ebStarterOpenMicItems:
      "Sign-up: [time, and how: list at the door or online]\nSlots: [minutes per act]\nDoors: [time]\nAges: [all ages / 18+ / 21+]\nAccessibility: [step-free entry? seating?]",
    ebStarterComedyName: "Comedy night",
    ebStarterComedyIntro: "[Describe the night in a sentence or two.]",
    ebStarterComedyItems:
      "Doors: [time]\nShow starts: [time]\nRuns about: [minutes, with or without an intermission]\nContent: [clean / adult language]\nAges: [all ages / 18+ / 21+]\nAccessibility: [step-free entry? seating?]",
    ebStarterMusicName: "Live music",
    ebStarterMusicIntro: "[Describe the night in a sentence or two.]",
    ebStarterMusicItems:
      "Doors: [time]\nMusic starts: [time]\nAges: [all ages / 18+ / 21+]\nFood and drink: [what the place serves]\nAccessibility: [step-free entry? seating or standing?]",
    ebStarterOtherName: "Other",
    ebStarterOtherIntro: "[Describe the event in a sentence or two.]",
    ebStarterOtherItems:
      "Doors: [time]\nStarts: [time]\nAges: [all ages / 18+ / 21+]\nGetting there: [parking, transit]\nAccessibility: [step-free entry? seating?]",
    ebProseEditorPlaceholder:
      "Describe your event. Add images, links, and formatting\u2026",
    ebImageUploadDisabled: "Save your event first to enable image uploads",
    ebAudioUploadDisabled: "Save your event first to enable audio uploads",
    ebAudioUploadFailedTitle: "Audio upload failed",
    ebAudioUploadFailedMessage:
      "Something went wrong uploading your audio file. Please try again.",
    ebSeriesCreatedTitle: "Series created",
    ebSeriesCreatedMessage: "Your recurring event series has been created.",
    ebSaveFailedTitle: "Save failed",
    ebEventPublishedTitle: "Event published",
    ebEventPublishedMessage: "Your event is now live.",
    ebPublishFailedTitle: "Publish failed",
    ebSaveBeforePublish:
      "Save your changes before publishing — your location hasn't been saved yet.",
    ebHostAttestationTitle: "Host responsibilities",
    ebHostAttestationSubtitle: "Current version {version}",
    ebHostAttestationIntro:
      "Before this event goes live, confirm that you are authorized to publish it and responsible for the basics.",
    ebHostAttestationPrivateIntro:
      "Because this event uses a hidden address, confirm the house-show responsibilities below before publishing.",
    ebHostAttestationFaqLink: "Open organizer FAQ",
    ebHostAttestationFooter:
      "Ithas Fire records this acknowledgement with the publish event.",
    ebHostAttestationPrivateFooter:
      "Hidden-address events carry extra risk for the place and its neighbours, so each acknowledgement is required before publishing.",
    ebHostAttestationStandardLabel:
      "I confirm I have authority to publish this event and am responsible for the place's rules, required permits, alcohol compliance, taxes, refunds, chargebacks, cancellations, and payouts.",
    ebHostAttestationStandardDescription:
      "Use the organizer FAQ link if you need to review Ithas Fire policies before publishing.",
    ebHostAttestationIncompleteError:
      "All host attestations are required before publishing.",
    ebHostAttestationFieldRequired: "Required before publishing.",
    ebHostAttestationPublish: "Publish event",
    ebHostAttestationPublishing: "Publishing…",
    ebChargebackTermsTitle: "Chargeback Terms",
    ebChargebackTermsSubtitle: "Current version {version}",
    ebChargebackTermsBannerTitle: "Paid checkout terms",
    ebChargebackTermsBannerBody:
      "Paid events use the current chargeback and payout-hold terms. Review and accept the latest version here so checkout stays available after terms updates.",
    ebChargebackTermsBannerAction: "Review terms",
    ebStripeConnectBannerTitle: "Connect Stripe to publish paid tickets",
    ebStripeConnectBannerBody:
      "This event has paid ticket types. Publishing is blocked until you finish Stripe Connect onboarding so Ithas Fire can route payouts to you.",
    ebStripeConnectBannerAction: "Set up payouts",
    ebChargebackTermsIntro:
      "Paid events require this acknowledgement before publishing. Once accepted, Ithas Fire will retry publishing this event automatically.",
    ebChargebackTermsStandaloneIntro:
      "Paid checkout uses the current chargeback and payout-hold terms. Accepting here keeps this editor open and does not republish or change event status.",
    ebChargebackTermsOrgPermissionNote:
      "Group terms must be accepted by an owner or admin. Editors can ask an owner or admin to complete this step.",
    ebChargebackTermsHumanPermissionNote:
      "These terms are recorded for your direct organizer account.",
    ebChargebackTermsOwnerMissing:
      "This event owner could not be resolved. Refresh the editor before accepting terms.",
    ebChargebackTermsCurrentTextLabel: "Current server terms",
    ebChargebackTermsCheckboxLabel:
      "I understand and accept the chargeback and payout-hold terms.",
    ebChargebackTermsCheckboxDescription:
      "This acknowledgement is required for paid ticket checkout and publishing.",
    ebChargebackTermsAcceptAndPublish: "Accept and publish",
    ebChargebackTermsAcceptOnly: "Accept terms",
    ebChargebackTermsAccepting: "Accepting…",
    ebChargebackTermsAcceptedTitle: "Terms accepted",
    ebChargebackTermsAcceptedMessage:
      "Current chargeback and payout-hold terms are recorded for this organizer.",
    ebChargebackTermsAcceptFailedTitle: "Terms not accepted",
    ebChargebackTermsStillRequired:
      "The terms are still required. Confirm you have permission to accept for this organizer, then try again.",
    ebEventCancelledTitle: "Event cancelled",
    ebEventCancelledRefunds: "Event cancelled. {count} order(s) refunded.",
    ebEventCancelledNoRefunds: "Event has been cancelled.",
    ebRefundsFailedTitle: "Some refunds failed",
    ebRefundsFailedMessage:
      "{count} order(s) could not be refunded automatically. Please review manually.",
    ebCancelFailedTitle: "Cancel failed",
    ebCancelConfirmTitle: "Cancel this event?",
    ebCancelConfirmBody:
      "Are you sure you want to cancel this event? This action cannot be undone.",
    // True for card AND door cash (cancel-event.ts): card orders are refunded
    // minus the processing fee; cash orders are marked refunded and their
    // CASH_SALE_DEBIT reversed, and the organiser hands the cash back.
    ebCancelConfirmRefundNote:
      "Completed card orders are refunded automatically, minus payment processing fees. Cash sales at the door are marked refunded, their tickets stop working and they stop counting against your payouts, but handing the cash back to those buyers is up to you.",
    ebCashRefundedTitle: "Door cash sales refunded",
    ebCashRefundedMessage:
      "{count, plural, one {# cash sale was} other {# cash sales were}} marked refunded. Give back any cash those buyers paid.",
    ebCashRefundsFailedTitle: "Some cash sales aren\u2019t refunded yet",
    ebCashRefundsFailedMessage:
      "{count, plural, one {# cash sale} other {# cash sales}} couldn\u2019t be marked refunded. We\u2019ve been told. Give back any cash those buyers paid, then refund each sale from Orders \u2192 the order \u2192 Refund cash sale.",
    ebCashRefundScanFailedTitle: "Cash sales not checked",
    ebCashRefundScanFailedMessage:
      "We couldn\u2019t check this event\u2019s cash sales, so some may not be marked refunded. We\u2019ve been told. Check this event\u2019s cash sales in Orders, give back any cash buyers paid, and refund each sale still open from the order \u2192 Refund cash sale.",
    ebPosVoidsFailedTitle: "Card sales at the door still open",
    ebPosVoidsFailedMessage:
      "{count, plural, one {# card sale} other {# card sales}} waiting on a reader couldn\u2019t be cancelled. We\u2019ve been told. If one of those buyers was charged, refund them from Orders.",
    ebPosScanFailedTitle: "Card sales at the door not checked",
    ebPosScanFailedMessage:
      "We couldn\u2019t check this event\u2019s card sales at the door, so one may still be open and its buyer may have been charged. We\u2019ve been told. Check this event\u2019s orders in Orders and refund any buyer who was charged.",
    ebGoBack: "Go Back",
    ebYesCancelEvent: "Yes, Cancel Event",
    ebTakeDownListing: "Take down listing",
    ebTakingDown: "Taking down\u2026",
    ebTakeDownListingConfirmTitle: "Take down this listing?",
    ebTakeDownListingConfirmBody: "Every remaining night is called off and everyone who saved it or RSVP'd is told. It leaves search and public lists; its link says it's cancelled.",
    ebYesTakeDownListing: "Yes, Take Down Listing",
    ebListingTakenDownTitle: "Listing taken down",
    ebTakeDownFailedTitle: "Take down failed",

    // ── Migrate Orders ──
    ebMoveOrders: "Move Orders",
    ebMoveOrdersTitle: "Move orders to another event",
    ebMoveOrdersBody:
      "All orders and tickets from this event will be moved to the selected target event. Buyers will be notified automatically.",
    ebMoveOrdersSelectTarget: "Select target event",
    ebMoveOrdersSelectPlaceholder: "Choose an event\u2026",
    ebMoveOrdersNoTargets:
      "No eligible target events found. The target must be a draft or published event owned by the same account.",
    ebMoveOrdersCapacityNote:
      "The target event must have enough ticket capacity to absorb all migrated tickets.",
    ebMoveOrdersConfirm: "Move Orders",
    ebMoveOrdersMoving: "Moving\u2026",
    ebMoveOrdersSuccessTitle: "Orders moved",
    // No `{target}`: the only caller (EventBuilder's MigrateOrdersDialog
    // onSuccess) passes `count` alone, and `formatter.format` THROWS on an
    // unsupplied argument — so this string crashed the success toast in
    // English while the Spanish copy, which never referenced a target,
    // rendered fine. Naming the destination event would be a genuine
    // improvement, but `onSuccess` only carries `targetEventId`, not a title;
    // that is a feature, not a translation fix.
    ebMoveOrdersSuccessMessage:
      "{count} order(s) moved. Buyers have been notified.",
    ebMoveOrdersFailedTitle: "Move failed",

    // ── Category & Tags ──
    ebCategory: "Category",
    ebCategoryPlaceholder: "Select a category",
    ebCategorySearchPlaceholder: "Search categories",
    ebCategoryLoading: "Loading categories",
    ebCategoryMatches: "Categories",
    ebCategoryMissing: "Missing category",
    ebCategoryNoMatches: "No matching categories.",
    ebCategoryHint:
      "Required before publishing. Helps attendees discover your event.",
    ebTags: "Tags",
    ebTagsPlaceholder: "Search or create tags\u2026",
    ebTagsHint: "Add up to 10 tags to help people find your event.",
    ebTagAdded: "Tag added",
    ebTagRemoved: "Tag removed",
    ebTagsUpdated: "Tags updated",
    ebTagsUpdateFailed: "Failed to update tags",
    ebCategoryUpdated: "Category updated",
    ebCategoryUpdateFailed: "Failed to update category",
    ebSubcategory: "Sub-category",
    ebSubcategoryPlaceholder: "Select a sub-category",
    ebSubcategorySearchPlaceholder: "Search sub-categories",
    ebSubcategoryLoading: "Loading sub-categories",
    ebSubcategoryMatches: "Sub-categories",
    ebSubcategoryMissing: "Missing sub-category",
    ebSubcategoryHint:
      "Optional. Narrow down the type of event within this category.",
    ebSubcategoryUpdated: "Sub-category updated",
    ebSubcategoryUpdateFailed: "Failed to update sub-category",
    ebSubcategoryNone: "None",
    ebSubcategorySelectCategory: "Pick a category first.",
    ebSubcategoryEmpty: "No subtypes for this category.",
    ebRequestCategory: "Request a category",
    ebRequestCategoryPlaceholder: "Category name",
    ebRequestCategoryHint: "Suggest a missing top-level category.",
    ebRequestSubcategory: "Request a sub-category",
    ebRequestSubcategoryPlaceholder: "Sub-category name",
    ebRequestSubcategoryHint:
      "Choose a category first, then suggest a missing sub-category.",
    ebRequestSubmit: "Request",
    ebRequestCategoryOption: "Request \u201C{name}\u201D",
    ebRequestSubcategoryOption: "Request \u201C{name}\u201D",
    ebRequestReviewNote: "Platform review",
    ebRequestNameTooShort: "Use at least two letters or numbers.",
    ebRequestNameTooLong: "Use a shorter name.",
    ebRequestNameInvalid:
      "Use letters, numbers, spaces, &, +, apostrophes, or hyphens.",
    ebRequestNameLinkOrHandle: "Remove links, @ handles, or hashtags.",
    ebRequestNameRepeatedCharacters: "Remove repeated filler characters.",
    ebCategoryRequestSuccess: "Category request sent",
    ebCategoryRequestFailed: "Failed to request category",
    ebSubcategoryRequestSuccess: "Sub-category request sent",
    ebSubcategoryRequestFailed: "Failed to request sub-category",
    ebCreateTag: "Create \u201C{name}\u201D",
    ebNoTagResults: "No tags found. Type to create one.",

    // ── Lineup ──
    ebLineup: "Lineup",
    ebLineupHint:
      "Add performers, DJs, hosts, and other people involved in this event.",
    ebAddToLineup: "Add to Lineup",
    ebLineupNamePlaceholder: "Name",
    ebLineupUrlPlaceholder: "Link (optional)",
    ebLineupRole: "Role",
    ebLineupEmpty: "No one added yet.",
    ebLineupRemoveConfirm: "Remove from lineup?",
    ebLineupAdded: "Added to lineup",
    humanSearchLoading: "Searching…",
    humanSearchNoResults: 'No results for "{query}"',
    ebLineupRemoved: "Removed from lineup",
    ebLineupReordered: "Lineup reordered",
    ebLineupAddFailed: "Failed to add to lineup",
    ebLineupRemoveFailed: "Failed to remove from lineup",
    ebLineupReorderFailed: "Failed to reorder lineup",
    ebLineupRolePerformer: "Performer",
    ebLineupRoleHost: "Host",
    ebLineupRoleDj: "DJ",
    ebLineupRoleInstructor: "Instructor",
    ebLineupRoleSpeaker: "Speaker",
    ebLineupRoleVendor: "Vendor",
    ebLineupRoleVolunteer: "Volunteer",
    ebLineupRoleOther: "Other",
    ebLineupCustomRolePlaceholder: "e.g. Stage Manager",
    // Shown only when a real profile is picked — a free-typed name tells nobody.
    ebLineupNotifyHint:
      "{name} will be told they're on the lineup, and can take themselves off it. On a draft, they hear when you publish.",

    // ── TicketTypeEditor ──
    ttTicketTypes: "Ticket Types",
    ttLocked: "Locked \u2014 tickets have been sold",
    ttAddTicketType: "Add Ticket Type",
    ttNoTicketTypes: "No ticket types yet",
    ttAddBeforePublish: "Add at least one ticket type before publishing",
    ttEditTicketType: "Edit Ticket Type",
    ttNewTicketType: "New Ticket Type",
    ttName: "Name",
    ttNamePlaceholder: "e.g. General Admission",
    ttPrice: "Price ($)",
    ttPricePlaceholder: "0.00",
    ttCapacity: "Capacity",
    ttCapacityPlaceholder: "100",
    ttCancel: "Cancel",
    ttSaving: "Saving\u2026",
    ttSave: "Save",
    ttAdding: "Adding\u2026",
    ttAdd: "Add",
    ttFree: "Free",
    ttCapacityLabel: "{capacity} capacity",
    ttCapacityCount: "{capacity} cap.",
    ttEmptyTitle: "No ticket types",
    ttEmptyMessage: "Add your first ticket type to start selling.",
    ttInvalidPriceTitle: "Invalid price",
    ttInvalidPriceMessage: "Price must be a non-negative number.",
    ttInvalidAmountTitle: "Invalid amount",
    ttPwywAboveCap: "Must be {max} or less \u2014 the most a buyer can pay per ticket.",
    ttInvalidAmountMessage:
      "Enter a non-negative amount, for example 12.50 or 12,50.",
    ttAmbiguousAmountMessage:
      "That amount can be read two ways. For one thousand five hundred, type 1500. For one and a half, type 1.50 or 1,50.",
    ttInvalidCapacityTitle: "Invalid capacity",
    ttInvalidCapacityMessage: "Capacity must be at least 1.",
    ttAddedTitle: "Ticket type added",
    ttAddedMessage: "\u201C{name}\u201D has been created.",
    ttStripeRequired: "Stripe account required",
    ttAddFailed: "Failed to add ticket type",
    ttUpdatedTitle: "Ticket type updated",
    ttUpdatedMessage: "\u201C{name}\u201D has been saved.",
    ttUpdateFailed: "Failed to update ticket type",
    ttEdit: "Edit",
    ttDelete: "Delete",
    ttDeleting: "Deleting\u2026",
    ttDeleteConfirm: "Delete?",
    ttDeletedTitle: "Ticket type deleted",
    ttDeletedMessage: "\u201C{name}\u201D has been removed.",
    ttDeleteFailed: "Failed to delete ticket type",
    ttDeleteHasSalesTitle: "Can\u2019t delete \u2014 tickets sold",
    ttDeleteHasSalesMessage:
      "This ticket type has issued tickets and can\u2019t be removed. Edit it instead.",
    ttSeatingTitle: "Assigned seating",
    ttSeatingDescription:
      "Want to assign ticket types to specific seat sections? Create a Place with a seating layout first, then link it to this event.",
    ttSeatingCreatePlace: "Manage places",

    // ── Fee preview (per ticket type) ──
    ttFeePreview: "Fee Breakdown",
    ttFeePlatform: "Service fee",
    ttFeeProcessor: "Processing fee",
    ttFeeTax: "Tax",
    ttFeeTaxUnavailable: "Tax couldn't be calculated right now, so the buyer total isn't shown",
    ttFeeBuyerTotal: "Buyer pays",
    ttFeeEventCredit: "Your event is credited",
    ttFeePlatformFee: "Platform fee",
    ttFeeModeAbsorb: "Platform fee absorbed by organizer",
    ttFeeModePassThrough: "Fees passed to buyer",
    ttFeeHandling: "Fee Handling",
    ttFeeNone: "No fee policy configured",
    ttDefaultGALabel: "General Admission (Free)",
    ttCustomTicketLabel: "Custom ticket",

    // ── Ticket-type templates ──
    ttTplSaveButton: "Save as Template",
    ttTplApplyButton: "Apply Template",
    ttTplSaveDialogTitle: "Save as template",
    ttTplSaveDialogSubtitle:
      "Reuse this event’s ticket types on future events.",
    ttTplNameLabel: "Template name",
    ttTplNamePlaceholder: "e.g. Standard show",
    ttTplNameTaken:
      "A template named “{name}” already exists. Try a different name.",
    ttTplSummaryLabel:
      "{count, plural, one {# ticket type will be saved} other {# ticket types will be saved}}",
    ttTplTimeNotCarriedNote:
      "On-sale windows and scheduled price changes stay with this event — they aren’t saved in the template, because “3 days before the show” and “the day I announced it” look the same once they’re a date.",
    ttTplSaveCta: "Save template",
    ttTplSaving: "Saving…",
    ttTplSavedTitle: "Template saved",
    ttTplSavedMessage: "“{name}” is ready to reuse.",
    ttTplSaveFailed: "Failed to save template",
    ttTplApplyDialogTitle: "Apply a template",
    ttTplApplyDialogSubtitle: "Add a saved set of ticket types to this event.",
    ttTplListLoadFailed: "Couldn’t load templates",
    ttTplEmptyTitle: "No saved templates yet",
    ttTplEmptyMessage:
      "Save this event’s ticket types as a template to reuse them on your next event.",
    ttTplEntryCount:
      "{count, plural, one {# ticket type} other {# ticket types}}",
    ttTplApplyCta: "Apply",
    ttTplApplying: "Applying…",
    ttTplAppliedTitle: "Template applied",
    ttTplAppliedMessage:
      "{count, plural, one {Added # ticket type.} other {Added # ticket types.}}",
    ttTplAppliedSkipped: "Skipped {count} already existing: {names}.",
    ttTplAppliedTimingElapsed:
      "{count, plural, one {On-sale timing on {names} was cleared — it had already passed for this event’s date.} other {On-sale timing was cleared on # ticket types ({names}) — it had already passed for this event’s date.}}",
    ttTplAppliedTimingInverted:
      "{count, plural, one {On-sale timing on {names} was cleared — its start and end don’t line up for this event’s date.} other {On-sale timing was cleared on # ticket types ({names}) — their start and end don’t line up for this event’s date.}}",
    ttTplAppliedTimingUnreadable:
      "{count, plural, one {On-sale timing on {names} was cleared — the template’s saved timing couldn’t be read.} other {On-sale timing was cleared on # ticket types ({names}) — the template’s saved timing couldn’t be read.}}",
    ttTplAppliedNoneMessage:
      "No ticket types added — all of them already exist on this event.",
    ttTplApplyFailed: "Failed to apply template",
    ttTplEntryInvalid:
      "Nothing was added: \u201C{name}\u201D in this template can\u2019t be created as saved (for example, a pay-what-you-want minimum or suggestion above the per-ticket maximum). Edit the template and try again.",
    ttTplSeatingNote:
      "Seat sections aren’t saved in templates — applied ticket types arrive unseated.",
    ttTplArchiveLabel: "Remove template",
    ttTplArchiveConfirmTitle: "Remove this template?",
    ttTplArchiveConfirmDescription:
      "“{name}” will no longer appear in this list. Events it was already applied to keep their ticket types.",
    ttTplArchiveConfirmCta: "Remove",
    ttTplArchivedTitle: "Template removed",
    ttTplArchiveFailed: "Failed to remove template",
    // ── Ticket-type packs ("From Ithas Fire" catalogue) ──
    ttTplYourSectionTitle: "Your templates",
    ttTplCustomiseCta: "Customise",
    ttTplCustomisedTitle: "Template customised",
    ttTplCustomisedMessage: "“{name}” is now yours to edit.",
    ttTplCustomiseFailed: "Couldn’t customise this template",
    ttTplCustomiseRenameTitle: "Choose a different name",
    ttTplCustomiseRenameDescription:
      "You already have a template called “{name}”. Give your copy another name and we’ll keep both.",
    ttTplCustomiseRenameSuggestion: "{name} (copy)",
    ttTplCustomiseRenameUnchanged: "Pick a name you aren’t already using.",
    ttTplPreviewDoor: "{price} advance / {door} door",
    ttTplPreviewAdjustable: "pay what you can · {suggested} suggested",
    ttTplPreviewCapacity: "cap {capacity}",

    // ── Ticket-type "Start from" presets ──
    // The preset NAME is what gets saved as the ticket type's name, so these
    // are real translated copy, not labels for an English constant.
    ttPresetLabel: "Start from",
    ttPresetHelp: "Fills the form below. Nothing is saved until you press Add.",
    ttPresetCustom: "Custom (blank)",
    ttPresetTimingTooSoon:
      "This event starts too soon for day-of pricing, so this preset’s on-sale window was left off. Set one yourself if you want one.",
    ttPresetCustomMeta: "Start from an empty form",
    ttPresetGa: "General Admission",
    ttPresetAdvance: "Advance / Early Bird",
    ttPresetDoor: "Door",
    ttPresetVip: "VIP",
    ttPresetStudent: "Student / Senior",
    ttPresetPwyw: "Pay What You Want",
    ttPresetSliding: "Sliding Scale",
    ttPresetIndustry: "Industry / Guest List",
    ttPresetMetaFixed: "{price} · {capacity} cap",
    ttPresetMetaAdjustable:
      "min {min} · suggested {suggested} · {capacity} cap",

    // ── Waiver Section ──
    ebWaiverTitle: "Waiver",
    ebWaiverHint:
      "Require attendees to accept a waiver before purchasing tickets.",
    ebWaiverNone: "No waiver required",
    ebWaiverSelectPlaceholder: "Select a waiver template",
    ebWaiverAssigned: "Waiver updated",
    ebWaiverAssignFailed: "Failed to update waiver",
    ebWaiverRemoved: "Waiver removed",
    ebWaiverPreviewLabel: "Preview",

    // ── Volunteering Section ──
    ebVolunteeringTitle: "Volunteering",
    ebVolunteeringDescription:
      "Let attendees sign up to help run the event. You can define roles, shifts, and approval rules after you enable it.",
    ebVolunteeringEnabledLabel: "Accept volunteers",
    ebVolunteeringEnabledHelp:
      "Show a volunteer sign-up section on the public event page.",
    ebVolunteeringAutoApproveLabel: "Auto-approve sign-ups",
    ebVolunteeringAutoApproveHelp:
      "Approve new volunteers instantly instead of reviewing each sign-up.",
    ebVolunteeringIntroTextLabel: "Intro text for the volunteer page",
    ebVolunteeringIntroTextHelp:
      "Tell volunteers what to expect — meeting points, dress code, perks, anything they should know before signing up.",
    ebVolunteeringIntroTextPlaceholder:
      "Tell volunteers what they're signing up for, any meeting point instructions, etc.",
    ebVolunteeringManageRolesLink: "Manage roles & shifts",
    ebVolunteeringSaved: "Volunteering settings saved",
    ebVolunteeringSaveFailed: "Failed to save volunteering settings",
    ebVolunteeringWaiverRequiredLabel: "Require waiver",
    ebVolunteeringWaiverRequiredHelp:
      "Volunteers must accept this event's waiver when signing up. Only applies when the event has a waiver assigned.",
    ebVolunteeringWaiverRequiredNoWaiverHint:
      "No waiver is assigned to this event yet — this setting has no effect until one is assigned.",

    // ── Tax Section ──
    ebTaxTitle: "Tax",
    ebTaxDescription:
      "Settings that affect how sales tax is calculated for this event's admission.",
    ebTaxInstructionalLabel: "Instructional / educational admission",
    ebTaxInstructionalHelp:
      "Classes, lessons, courses, or workshops. In Tennessee, admission for instruction is exempt from sales tax. Only enable if this event's admission is genuinely for instruction — not recreational access.",
    ebTaxAttestation:
      "By enabling this, you confirm that admission to this event is genuinely for instruction (a class, lesson, course, or workshop) and not for recreational access. You are responsible for this attestation.",
    ebTaxNonTennesseeHint:
      "This exemption only removes admission tax where the place is in Tennessee. Everywhere else, normal tax still applies.",
    ebTaxSaved: "Tax settings saved",
    ebTaxSaveFailed: "Failed to save tax settings",

    // ── Volunteer Templates (org-scoped page) ──
    volunteerTemplatesTitle: "Volunteer roles",
    volunteerTemplatesSubtitle: "Reusable roles you can pull into any event",
    volunteerTemplatesNewCta: "New template",
    volunteerTemplatesEmptyTitle: "No volunteer role templates yet",
    volunteerTemplatesEmptyDescription: "Create one to reuse across events.",
    volunteerTemplatesCreateFirst: "Create first template",
    volunteerTemplatesHumanOwnerNotice:
      "Volunteer role templates are group-scoped. Switch to a group admin to manage templates.",
    chooseAccountLink: "Choose an account",
    volunteerTemplateNameColumn: "Title",
    volunteerTemplateDescriptionColumn: "Description",
    volunteerTemplateDefaultCapacityColumn: "Default capacity",
    volunteerTemplateStatusColumn: "Status",
    volunteerTemplateStatusActive: "Active",
    volunteerTemplateStatusArchived: "Archived",
    volunteerTemplateEditTooltip: "Edit template",
    volunteerTemplateArchiveTooltip: "Archive template",
    volunteerTemplateArchiveConfirmTitle: "Archive this template?",
    volunteerTemplateArchiveConfirmDescription:
      "Archived templates stop appearing in the picker. Existing roles on events are unaffected.",
    volunteerTemplateArchiveConfirmCta: "Archive",
    volunteerTemplateArchived: "Template archived",
    volunteerTemplateArchiveFailed: "Failed to archive template",
    volunteerTemplateDialogCreateTitle: "New volunteer role template",
    volunteerTemplateDialogEditTitle: "Edit volunteer role template",
    volunteerTemplateFieldNameLabel: "Title",
    volunteerTemplateFieldNamePlaceholder:
      "e.g. Bar Staff, Security, Stage Hand",
    volunteerTemplateFieldDescriptionLabel: "Description (optional)",
    volunteerTemplateFieldDescriptionPlaceholder:
      "What does this role involve? Any prerequisites?",
    volunteerTemplateFieldDefaultCapacityLabel: "Default capacity (optional)",
    volunteerTemplateFieldDefaultCapacityPlaceholder: "e.g. 4",
    volunteerTemplateSaveCta: "Save template",
    volunteerTemplateCreated: "Template created",
    volunteerTemplateUpdated: "Template updated",
    volunteerTemplateSaveFailed: "Failed to save template",
    volunteerTemplateIncludeArchived: "Show archived",

    // ── Event volunteers admin page ──
    volunteers: "Volunteers",
    volunteerEventPageTitle: "Volunteers",
    volunteerEventPageSubtitle: "Roles, shifts, and applicants",
    volunteerEventTabRoles: "Roles & shifts",
    volunteerEventTabSignups: "Signups",
    volunteerEventTabBadges: "Badges",
    volunteerEventTabRewards: "Comp rewards",
    volunteerSignupsRewardColumn: "Reward",

    // Roles tab
    volunteerRolesAddCta: "Add role",
    volunteerRolesFromTemplateCta: "From template",
    volunteerRolesCustomCta: "Custom",
    volunteerRolesEmptyTitle: "No volunteer roles yet",
    volunteerRolesEmptyDescription: "Add a role so people can sign up to help.",
    volunteerRoleDialogCreateTitle: "New volunteer role",
    volunteerRoleDialogEditTitle: "Edit volunteer role",
    volunteerRoleDialogFromTemplatesTitle: "Pick templates",
    volunteerRoleDialogFromTemplatesDescription:
      "Selected templates will be added as roles on this event.",
    volunteerRoleDialogFromTemplatesCta: "Create roles",
    volunteerRoleDialogNoTemplates:
      "No templates available. Create some in Volunteer Roles first.",
    volunteerRoleDialogTemplatesLoadFailed:
      "Failed to load templates. Please try again.",
    volunteerRoleFieldNameLabel: "Title",
    volunteerRoleFieldNamePlaceholder: "e.g. Door Security",
    volunteerRoleFieldDescriptionLabel: "Description (optional)",
    volunteerRoleFieldDescriptionPlaceholder:
      "Any details volunteers should know",
    volunteerRoleFieldCapacityLabel: "Slots needed (optional)",
    volunteerRoleFieldCapacityPlaceholder: "e.g. 4",
    volunteerRoleFieldAutoApproveLabel: "Signup approval for this role",
    volunteerRoleFieldAutoApproveHelp:
      "Choose whether this role follows the event's default, always auto-approves signups, or always requires manual review.",
    volunteerRoleFieldAutoApproveInherit: "Event default",
    volunteerRoleFieldAutoApproveAlways: "Always approve",
    volunteerRoleFieldAutoApproveNever: "Always review",
    volunteerRoleAutoApproveOn: "Auto-approve on",
    volunteerRoleAutoApproveOff: "Manual review",
    volunteerRoleCapacitySummary: "{filled} of {cap} filled",
    volunteerRoleCapacityOpen: "{filled} signed up",
    volunteerRoleCapacityPendingSuffix: "{pending} pending",
    volunteerRoleCreated: "Role created",
    volunteerRoleUpdated: "Role updated",
    volunteerRoleDeleted: "Role deleted",
    volunteerRoleSaveFailed: "Failed to save role",
    volunteerRoleDeleteConfirmTitle: "Delete this role?",
    volunteerRoleDeleteConfirmDescription:
      "All shifts under this role will be removed. Signups cannot be deleted while they exist.",
    volunteerRoleDeleteConfirmCta: "Delete",
    volunteerRoleDeleteFailed: "Failed to delete role",
    volunteerRolesCreatedFromTemplates: "Roles created from templates",

    // Shifts
    volunteerShiftAddCta: "Add shift",
    volunteerShiftCount: "{count, plural, one {# shift} other {# shifts}}",
    volunteerShiftEmpty:
      "No shifts yet — volunteers sign up for the whole role.",
    volunteerShiftDialogCreateTitle: "New shift",
    volunteerShiftDialogEditTitle: "Edit shift",
    volunteerShiftFieldLabelLabel: "Label (optional)",
    volunteerShiftFieldLabelPlaceholder: "e.g. Morning setup",
    volunteerShiftFieldStartsAtLabel: "Starts at",
    volunteerShiftFieldEndsAtLabel: "Ends at",
    volunteerShiftFieldCapacityLabel: "Slots needed (optional)",
    volunteerShiftFieldCapacityPlaceholder: "Inherits from role if blank",
    volunteerShiftFieldNotesLabel: "Notes (optional)",
    volunteerShiftFieldNotesPlaceholder: "Private notes for admins",
    volunteerShiftComposerTitle: "Quick add shifts",
    volunteerShiftComposerDescription:
      "Add draft rows here, save the valid ones together, and use the dialog later for notes or advanced edits.",
    volunteerShiftComposerPresetSetup: "Setup",
    volunteerShiftComposerPresetDoors: "Doors",
    volunteerShiftComposerPresetMain: "Main shift",
    volunteerShiftComposerPresetCleanup: "Cleanup",
    volunteerShiftComposerDraftLabel: "Draft {count}",
    volunteerShiftComposerDuplicateCta: "Duplicate",
    volunteerShiftComposerCreateCta: "Create shifts",
    volunteerShiftComposerEventStartHint:
      "Set an event start time to enable preset shifts.",
    volunteerShiftComposerLimitHint:
      "You can create up to 25 shifts in one save.",
    volunteerShiftComposerFieldRequired: "This field is required.",
    volunteerShiftComposerFieldEndsAfterStart:
      "End time must be after start time.",
    volunteerShiftComposerFieldCapacityInvalid:
      "Capacity must be a whole number greater than 0.",
    volunteerShiftComposerFixErrors: "Fix the highlighted rows before saving.",
    volunteerShiftComposerSaved:
      "{count, plural, one {# shift created} other {# shifts created}}",
    volunteerShiftComposerSavedWithErrors:
      "Valid shifts were created. Fix the highlighted rows to save the rest.",
    volunteerShiftCreated: "Shift created",
    volunteerShiftUpdated: "Shift updated",
    volunteerShiftDeleted: "Shift deleted",
    volunteerShiftSaveFailed: "Failed to save shift",
    volunteerShiftDeleteConfirmTitle: "Delete this shift?",
    volunteerShiftDeleteConfirmDescription:
      "Signups on this shift cannot be deleted while they exist.",
    volunteerShiftDeleteFailed: "Failed to delete shift",

    // Signups tab
    volunteerSignupsFilterStatus: "Status",
    volunteerSignupsFilterRole: "Role",
    volunteerSignupsFilterShift: "Shift",
    volunteerSignupsFilterAll: "All",
    volunteerSignupsFilterAllRoles: "All roles",
    volunteerSignupsFilterAllShifts: "All shifts",
    volunteerSignupsStatusPending: "Pending",
    volunteerSignupsStatusApproved: "Approved",
    volunteerSignupsStatusRejected: "Rejected",
    volunteerSignupsStatusWithdrawn: "Withdrawn",
    volunteerSignupsStatusCheckedIn: "Checked in",
    volunteerSignupsStatusNoShow: "No show",
    volunteerSignupsVolunteerColumn: "Volunteer",
    volunteerSignupsRoleColumn: "Role",
    volunteerSignupsShiftColumn: "Shift",
    volunteerSignupsStatusColumn: "Status",
    volunteerSignupsSubmittedColumn: "Submitted",
    volunteerSignupsActionsColumn: "Actions",
    volunteerSignupsEmptyTitle: "No signups yet",
    volunteerSignupsEmptyDescription:
      "Volunteers will appear here after they apply.",
    volunteerSignupsNoShift: "Whole role",
    volunteerSignupsApprove: "Approve",
    volunteerSignupsReject: "Reject",
    volunteerSignupsCheckIn: "Check in",
    volunteerSignupsWithdraw: "Withdraw",
    volunteerSignupsRejectDialogTitle: "Reject this signup?",
    volunteerSignupsRejectDialogNoteLabel: "Note to volunteer (optional)",
    volunteerSignupsRejectDialogNotePlaceholder:
      "Why are you rejecting this signup?",
    volunteerSignupsRejectConfirmCta: "Reject signup",
    volunteerSignupsWithdrawConfirmTitle: "Withdraw this signup?",
    volunteerSignupsWithdrawConfirmDescription:
      "This cancels the signup on the volunteer's behalf.",
    volunteerSignupsWithdrawConfirmCta: "Withdraw",
    volunteerSignupsApproved: "Signup approved",
    volunteerSignupsRejected: "Signup rejected",
    volunteerSignupsCheckedIn: "Volunteer checked in",
    volunteerSignupsWithdrawn: "Signup withdrawn",
    volunteerSignupsActionFailed: "Action failed",
    volunteerSignupsCapacityFullTitle: "Shift is full",
    volunteerSignupsShiftFullBody:
      "This shift is at capacity. Raise the shift capacity to approve more volunteers.",
    volunteerSignupsRoleFullBody:
      "This role is at capacity. Raise the role capacity to approve more volunteers.",
    volunteerSignupsSelectAllAria: "Select all pending signups",
    volunteerSignupsSelectRowAria: "Select signup from {name}",
    volunteerSignupsSelectedCount:
      "{count, plural, one {# signup selected} other {# signups selected}}",
    volunteerSignupsApproveSelected: "Approve selected ({count})",
    volunteerSignupsRejectSelected: "Reject selected ({count})",
    volunteerSignupsRejectBatchDialogTitle:
      "{count, plural, one {Reject # signup?} other {Reject # signups?}}",
    volunteerSignupsRejectBatchConfirmCta:
      "{count, plural, one {Reject # signup} other {Reject # signups}}",
    volunteerSignupsBatchApproved:
      "{count, plural, one {# signup approved} other {# signups approved}}",
    volunteerSignupsBatchRejected:
      "{count, plural, one {# signup rejected} other {# signups rejected}}",
    volunteerSignupsBatchPartialTitle: "Some signups couldn't be updated",
    volunteerSignupsBatchPartialBody:
      "{ok} of {total} succeeded. Failed rows are marked below.",
    volunteerSignupsBatchAlreadyReviewed: "Already reviewed",
    volunteerSignupsBatchRowFailed: "Couldn't update this signup",
    volunteerSignupsBatchApprovalsPaused:
      "Can't approve right now. You can still reject.",
    volunteerSignupsBatchSelectionEmpty:
      "No pending signups are selected anymore",
    volunteerSignupsWaiverChip: "Waiver ✓",
    volunteerSignupsWaiverAcceptedTooltip: "Waiver accepted {date}",
    // Hours tracking (Signups tab)
    volunteerSignupsHoursColumn: "Hours",
    volunteerSignupsHoursEdit: "Edit",
    volunteerSignupsHoursUpdated: "Hours updated",
    volunteerSignupsHoursUpdateFailed: "Couldn't update hours",
    volunteerSignupsHoursPrompt:
      "Hours worked for {name}? Empty to revert to scheduled ({scheduled}).",
    volunteerSignupsHoursInvalid: "Enter a number between 0 and 99",
    volunteerSignupsExportHoursCsv: "Export hours CSV",
    // Entry point to the organizer-issued badge sheet. "Volunteer badges", not
    // "Print badges": the button opens a document you then issue from, and the
    // print step is a separate act on that page.
    volunteerBadgesEntry: "Volunteer badges",

    /* ── Org volunteer hours (cross-event) ─────────────── */
    volunteerHoursTitle: "Volunteers",
    volunteerHoursSubtitle: "Cross-event volunteer hours",
    volunteerHoursLoading: "Loading volunteer hours...",
    volunteerHoursHumanOwnerNotice:
      "Volunteer hours are group-scoped. Switch to a group admin to view them.",
    volunteerHoursVolunteerColumn: "Volunteer",
    volunteerHoursTotalHoursColumn: "Total hours",
    volunteerHoursEventsColumn: "Events",
    volunteerHoursSignupsColumn: "Signups",
    volunteerHoursLastShiftColumn: "Last shift",
    volunteerHoursGuestBadge: "Guest",
    volunteerHoursFilterFrom: "From",
    volunteerHoursFilterTo: "To",
    volunteerHoursPresetThisYear: "This year",
    volunteerHoursExportCsv: "Export CSV",
    volunteerHoursExportFailed: "Couldn't export hours",
    volunteerHoursSearchPlaceholder: "Search by name or email...",
    volunteerHoursEmptyTitle: "No volunteer hours recorded yet",
    volunteerHoursEmptyDescription:
      "Hours appear here once volunteers sign up for shifts at your events.",
    volunteerHoursNoMatches: "No volunteers match",
    volunteerHoursNoMatchesDescription:
      "Try adjusting the search, date range, or the accepted-only filter.",
    volunteerHoursNOfTotal:
      "{start}–{end} of {total, plural, one {# volunteer} other {# volunteers}}",
    volunteerHoursAcceptedOnlyLabel: "Accepted only",
    volunteerHoursAcceptedOnlyCaption:
      "Showing approved and checked-in signups only. The all-statuses view is the one that reconciles with per-event hours exports.",

    /* ── EventGateSettings ─────────────────────────────── */
    gsVisibility: "Visibility",
    gsPublic: "Public",
    gsPublicDesc: "Visible to everyone",
    gsPrivate: "Private",
    gsPrivateDesc: "Only accessible via direct link or invite",
    gsAccessGate: "Access Gate",
    gsGateNone: "No Gate",
    gsGateNoneDesc: "Anyone can purchase tickets without restrictions.",
    gsGatePassword: "Password",
    gsGatePasswordDesc: "Attendees need a password to access the event.",
    gsGateApplication: "Application",
    gsGateApplicationDesc: "Attendees must apply and be approved.",
    gsEdit: "Edit",
    gsApplicationForm: "Application Form",
    gsApplicationFormDesc:
      "Customize the questions applicants must answer to request access.",
    gsEditApplicationForm: "Edit Application Form",
    gsReviewApplications: "Review Applications",
    gsAppSettings: "Application settings",
    gsAppOpensAt: "Applications open",
    gsAppClosesAt: "Applications close",
    gsAppWindowHint:
      "Leave either blank to accept applications any time. Times are in your local timezone.",
    gsAppWindowError: "The close time must be after the open time.",
    gsAppMaxSubmissions: "Application limit",
    gsAppMaxSubmissionsHint:
      "Leave blank for unlimited applications. Withdrawn and expired applications don't count toward the limit.",
    gsAppMaxSubmissionsError:
      "Enter a whole number of 1 or more, or leave it blank for no limit.",
    gsAppAutoApprove: "Approve automatically",
    gsAppAutoApproveDesc:
      "Applicants are approved and unlocked the moment they apply. The approval email is sent immediately.",
    gsAppSettingsSave: "Save application settings",
    gsFailedAppSettings: "Failed to save application settings.",
    gsFailedVisibility: "Failed to update visibility.",
    gsFailedAccess: "Failed to update access settings.",
    gsFailedSavePassword: "Failed to save password.",
    gsFailedClearPassword: "Failed to clear password.",
    // Access Gate invite panel (gated-event invite links, step 7).
    ginLinkTitle: "Invite link",
    ginLinkOffPassword: "One link you can post or forward. Anyone who opens it skips the password. Off until you turn it on.",
    ginLinkOffApplication: "One link you can post or forward. Anyone who opens it skips the application. Off until you turn it on.",
    ginLinkTurnOn: "Turn on invite link",
    ginLinkTurningOn: "Turning on…",
    ginLinkOnPassword: "Anyone with this link skips the password.",
    ginLinkOnApplication: "Anyone with this link skips the application. On this event it counts as approval: they skip the questions and the queue.",
    ginCopyLink: "Copy link",
    ginCopySharedA11y: "Copy link (shared invite)",
    ginCopied: "Copied",
    ginLinkCopied: "Invite link copied.",
    ginCopyFailed: "Couldn’t copy the link. Select it and copy it by hand.",
    ginLinkReset: "Reset link",
    ginLinkResetting: "Resetting…",
    ginLinkTurnOff: "Turn off",
    ginLinkTurnOffA11y: "Turn off invite link",
    ginLinkTurningOff: "Turning off…",
    ginLinkResetHint: "Reset makes a new link and stops the old one. You choose whether people who already got in stay. Turning it off stops the link and keeps everyone in.",
    ginLinkResetTitle: "Reset invite link?",
    ginLinkResetBody: "Reset makes a new link and stops the old one.",
    ginLinkResetKeepLabel: "Keep people who already got in",
    ginLinkResetKeepDesc: "They can still open the event. Only the old link stops working.",
    ginLinkResetRemoveLabel: "Remove them too",
    ginLinkResetRemoveDesc: "Everyone who got in with an old link loses access. People you invited by name keep theirs. Anyone who already has a ticket keeps it.",
    ginLinkResetRemoveConfirm: "Reset and remove",
    ginLinkResetRemoving: "Removing…",
    ginLinkUsedMeta: "{count, plural, one {Used # time} other {Used # times}} · works until the event ends",
    ginLinkTurnedOn: "Invite link is on.",
    ginLinkWasReset: "Invite link reset. The old link no longer works.",
    ginLinkWasResetRemoved: "Invite link reset. Everyone who got in with an old link has lost access.",
    ginLinkTurnedOff: "Invite link is off.",
    ginLoading: "Loading invites…",
    ginLoadError: "Couldn’t load invites.",
    ginRetry: "Try again",
    ginGuestsTitle: "Invited guests",
    ginGuestsDesc: "Each guest gets their own link by email. Revoking a guest’s invite takes their access away.",
    ginGuestsEmpty: "No guests invited yet.",
    ginNameLabel: "Name",
    ginEmailLabel: "Email",
    ginNameRequired: "Enter the guest’s name.",
    ginEmailInvalid: "Enter a valid email address.",
    ginSendInvite: "Send invite",
    ginSending: "Sending…",
    ginSentTo: "Invite sent to {email}.",
    ginAlreadyInvited: "{email} already has an invite. Use Resend to send it again.",
    ginSendFailedEmail: "The invite was saved but the email didn’t send. Use Resend to try again.",
    ginNotPublished: "Publish the event before sending invites.",
    ginRateLimited: "Too many invites sent in a short time. Wait a few minutes and try again.",
    ginSendUnavailable: "Invites can’t be sent right now. Try again in a few minutes.",
    ginOptedOut: "This person has asked not to get invites from you, so the invite wasn’t sent.",
    // Daily allowance (INVITE_ALLOWANCE_EXCEEDED): the count, then the rule.
    ginAllowanceList: "{listCount, plural, one {This list has # person,} other {This list has # people,}} {remaining, plural, one {and you can send 1 more invite today.} other {and you can send # more invites today.}}",
    // The organiser's bucket can be spent by teammates too: no "you've sent".
    ginAllowanceSpent: "This organiser has used all {limit, number} invites for today.",
    ginAllowanceRuleNew: "New organisers can send {newDaily, number} a day. Once at least {scanned, number} people with paid tickets have been scanned in at your events, or you’ve been paid out, it goes up to {trustedDaily, number}.",
    ginAllowanceRuleTrusted: "You can send up to {trustedDaily, number} invites a day.",
    ginAllowanceSpentNewAccount: "You’ve used all {limit, number} invites for today.",
    ginAllowanceRuleNewAccount: "Accounts less than a week old can send {newAccountDaily, number} invites a day.",
    ginVerifyEmailToSend: "Verify your email address before sending invites. You can do it in Settings, under Email.",
    ginInviteList: "Invite a contact list",
    ginInviteListHint: "Unsubscribed contacts, and people who’ve asked not to get invites from you, are skipped.",
    ginListLabel: "Contact list",
    ginListPlaceholder: "Choose a list",
    ginListsLoading: "Loading contact lists…",
    ginListsLoadError: "Couldn’t load your contact lists.",
    ginListsEmpty: "You don’t have any contact lists yet.",
    ginListSend: "Send invites",
    ginListSentTo: "Sent to {count}.",
    ginListAlreadyInvited: "{count} already invited.",
    ginListSkippedUnsubscribed: "{count} skipped (unsubscribed).",
    ginListSkippedNoEmail: "{count} skipped (no email).",
    ginListSkippedOptedOut: "{count, plural, one {# person has asked not to get invites from you, so they were skipped.} other {# people have asked not to get invites from you, so they were skipped.}}",
    ginListFailed: "{count} failed.",
    ginStatusSent: "Sent",
    ginStatusUsed: "Used",
    ginStatusRevoked: "Revoked",
    ginStatusUnsent: "Unsent",
    ginCopyLinkFor: "Copy link for {name}",
    ginGuestLinkCopied: "Link for {name} copied.",
    ginResend: "Resend",
    ginResendFor: "Resend invite to {name}",
    ginResent: "Invite sent again to {email}.",
    ginRevoke: "Revoke",
    ginRevokeFor: "Revoke invite for {name}",
    ginRevokeTitle: "Revoke this invite?",
    ginRevokeBody: "{name} loses access to this event and their link stops working.",
    ginRevokeConfirm: "Revoke invite",
    ginRevoking: "Revoking…",
    ginRevoked: "Invite for {name} revoked.",
    ginInviteAgain: "Invite again",
    ginInviteAgainFor: "Invite again: {name}",
    ginListTooLarge: "This list has more than 500 people. Lists that size can’t be invited from here yet.",
    ginVerifyEmail: "Verify your email to send invites.",
    ginEventEnded: "This event has ended.",
    ginInviteWasRevoked: "This invite was revoked.",
    ginEventNotGated: "This event no longer has a gate.",
    ginCopiedSharedA11y: "Copied: shared invite link",
    ginCopiedFor: "Copied: link for {name}",
    // Invite complaint auto-pause (W4): the notice on "Invited guests".
    ginPauseTitle: "Your invites are paused",
    ginPauseTitleKept: "Your invites are still paused",
    ginPauseBodyCount: "{count, plural, one {# person marked your invite emails as spam} other {# people marked your invite emails as spam}} in the last {days} days, so we stopped sending invites for you. This protects the people on your lists and keeps our email out of spam folders.",
    ginPauseBodyRate: "{count, plural, one {# of the {invited, number} people you invited in the last {days} days marked the email as spam.} other {# of the {invited, number} people you invited in the last {days} days marked the email as spam.}} Above 1 in 100, we stop sending invites until someone on our team reviews it.",
    ginPauseStillWorks: "Guests you already invited keep their links, and you can still share your invite link yourself.",
    ginPauseRequested: "You asked for a review on {date}. Someone on our team will look at it, and the answer will show here.",
    ginPauseKeptIntro: "We looked on {date} and kept invites paused:",
    ginPauseNoteLabel: "Anything we should know? (optional)",
    ginPauseAsk: "Ask for a review",
    ginPauseAskAgain: "Ask again",
    ginPauseRequesting: "Sending…",
    ginPauseLifted: "Our team lifted the pause on {date}. Invites are back on.",
    ginPauseRaced: "Your invites are paused. See the note above.",
    gsPasswordMinLength: "Password must be at least 4 characters.",
    gsEditPassword: "Edit Password",
    gsSetPassword: "Set Password",
    gsPasswordCurrentlySet: "Password is currently set",
    gsEnterNewPassword: "Enter a new password",
    gsChoosePassword: "Choose a password (min 4 characters)",
    gsEnterPasswordPlaceholder: "Enter password",
    gsRemovePassword: "Remove Password",
    gsCancel: "Cancel",
    gsSaving: "Saving\u2026",
    gsSavePassword: "Save Password",

    /* ── EventPreview ──────────────────────────────────── */
    epDesktop: "Desktop",
    epMobile: "Mobile",
    epEmail: "Email",
    epEmailFrom: "From: Ithas Fire <events@ithasfire.com>",
    epEmailSubject: "Subject: {title}",
    epUntitledEvent: "Untitled Event",
    epEmailFooter:
      "You\u2019re receiving this email because you purchased tickets on Ithas Fire.",
    epUnsubscribe: "Unsubscribe",
    epManagePreferences: "Manage preferences",

    /* ── RecurrenceBuilder ─────────────────────────────── */
    rbRepeats: "Repeats",
    rbDoesNotRepeat: "Doesn't repeat",
    rbPresetWeekly: "Every {weekday}",
    rbPresetBiweekly: "Every other {weekday}",
    rbPresetMonthly: "Monthly on the {ordinal} {weekday}",
    // The same three presets with no weekday in them, for the window where the
    // start is missing and there is no weekday to name. The select keeps the
    // option for the value it holds; see PLAIN_PRESET_LABEL_KEYS.
    rbPresetWeeklyPlain: "Every week",
    rbPresetBiweeklyPlain: "Every other week",
    rbPresetMonthlyPlain: "Every month",
    rbLast: "last",
    rbCustom: "Custom…",
    rbCustomRawNote:
      "This series uses an advanced rule ({rule}). Changing the options below replaces it.",
    // Hint under the inline start field the event builder mirrors into the
    // Scheduling section (RecurrenceBuilder `onEventStartsAtChange`). For a
    // structured rule both sentences are literal (a raw rule hides the hint):
    // the start IS the first occurrence (it becomes DTSTART), and the weekday
    // chip and monthly ordinal are derived from it.
    rbStartsHint:
      "The first date in the series. The repeat pattern is built from this day and time.",
    rbRepeatEvery: "Repeat every",
    rbUnitDays: "{count, plural, one {day} other {days}}",
    rbUnitWeeks: "{count, plural, one {week} other {weeks}}",
    rbUnitMonths: "{count, plural, one {month} other {months}}",
    rbMon: "Mon",
    rbTue: "Tue",
    rbWed: "Wed",
    rbThu: "Thu",
    rbFri: "Fri",
    rbSat: "Sat",
    rbSun: "Sun",
    rbRepeatOn: "Repeat on",
    rbEnds: "Ends",
    // Opt-in third option (RecurrenceBuilder `allowNeverEnds`) — absent from
    // the ticketed event builder, where a show series always ends.
    rbEndsNever: "Never",
    rbEndsAfter: "After",
    rbEndsAfterShows: "{count, plural, one {show} other {shows}}",
    rbEndsOnDate: "On date",
    rbEndDate: "End date",
    rbSummaryDaily: "{interval, plural, one {Every day} other {Every # days}}",
    rbSummaryWeekly:
      "{interval, plural, one {Every week} other {Every # weeks}} on {days}",
    rbSummaryMonthly:
      "{interval, plural, one {Every month} other {Every # months}}",
    rbSummaryShows: "{count, plural, one {# show} other {# shows}}",
    rbSummaryShowsCapped: "{count}+ shows",
    rbSummaryLastShow: "last show {date}",
    rbPreviewMore: "+{count} more",
    rbConsequence:
      "{count, plural, =0 {Saving creates no additional draft shows.} one {Saving creates # draft show. You publish it when it's ready.} other {Saving creates # draft shows. You publish each one when it's ready.}}",
    rbConsequenceEdit:
      "{count, plural, =0 {This schedule keeps no additional shows.} one {Keeps up to # additional show on this schedule.} other {Keeps up to # additional shows on this schedule.}}",
    rbChooseEndDate: "Choose an end date to complete the series configuration",
    // The OTHER reason the rule is incomplete. `buildConfigFromState` bails on
    // a missing or unreadable start before it looks at the end mode, so the
    // band used to ask for an end date that was already set.
    rbAddStartDate: "Add a start date. The repeat pattern is built from it.",
    rbDayAlwaysIncluded: "{weekday}, always included",
    // The trailing clause used to read "\u2026to repeat on other days only", which
    // parses as "repeat ONLY on other days" \u2014 the opposite of what it means.
    // This caption exists precisely because the organizer has just found a chip
    // they cannot unclick, so it has to read correctly on the first pass:
    // changing the event's date is the ONLY WAY to repeat on a different day,
    // not a way to repeat on different days EXCLUSIVELY.
    rbDayAlwaysIncludedNote:
      "{weekday} stays selected because it\u2019s this event\u2019s own date. To repeat on a different day, change the event\u2019s date.",

    /* ── Series Dates page (recurring-series Phase 2) ──── */
    sdTitle: "Dates",
    sdManageDates: "Manage dates",
    sdRuleWeekly: "Every {weekday}",
    sdRuleBiweekly: "Every other {weekday}",
    sdRuleWeeklyInterval: "Every {interval} weeks on {weekday}",
    sdRuleDaily: "Daily",
    sdRuleDailyInterval: "Every {interval} days",
    sdRuleMonthly: "Monthly",
    sdRuleMonthlyInterval: "Every {interval} months",
    sdRuleFixed: "Fixed dates",
    sdRuleCustom: "Custom schedule",
    sdThrough: "Through {date}",
    sdDatesCount: "{count, plural, one {# date} other {# dates}}",
    sdEditSchedule: "Edit schedule",
    sdAddDate: "Add date",
    sdStatusPublished: "Published",
    sdStatusDraft: "Draft",
    sdStatusPlanned: "Planned",
    sdStatusSkipped: "Skipped",
    sdStatusCancelled: "Cancelled",
    sdStatusCompleted: "Completed",
    sdStatusArchived: "Archived",
    sdStatusDetached: "Detached",
    sdStatusAria: "Status: {label}",
    sdManualMarker: "added",
    sdSoldCount: "{count, plural, one {# ticket sold} other {# tickets sold}}",
    sdReadyMeta: "Ready — tickets copied",
    sdNotSetUpMeta: "Tickets not set up",
    sdNoDraftMeta: "No draft yet",
    sdDraftMissingMeta: "Draft event missing",
    sdOpen: "Open",
    sdPublish: "Publish",
    sdCreateDraft: "Create draft",
    sdRestore: "Restore",
    sdSkip: "Skip",
    sdDraftsReady:
      "{count, plural, one {# draft ready} other {# drafts ready}}",
    sdPublishAllReady: "Publish all ready",
    sdBulkAllPublished:
      "{count, plural, one {# date published} other {# dates published}}",
    sdBulkPartial: "{published} published, {failed} failed: {reason}",
    sdAddDateTitle: "Add a date",
    sdAddDateStartLabel: "Starts",
    sdAddDateNoteLabel: "Note (optional)",
    sdAddDateHint: "One-off date — kept even if the schedule changes.",
    sdAddDateTimezoneNote: "Times are in {timezone}.",
    sdAddDateSubmit: "Add date",
    sdDateAddedTitle: "Date added",
    sdSkipTitle: "Skip this date?",
    sdSkipBody:
      "{date} will be struck from the schedule. You can restore it later.",
    sdSkipNoteLabel: "Note (optional)",
    sdSkipConfirm: "Skip date",
    sdLoadMore: "Load more",
    sdLoading: "Loading dates…",
    sdLoadErrorTitle: "Couldn't load dates",
    sdLoadErrorBody: "Something went wrong loading this series. Try again.",
    sdRetry: "Retry",
    sdEmpty: "No dates yet",
    sdEmptyHint: "Add a date or edit the schedule to plan this series.",
    sdNotSeriesTitle: "This event doesn't repeat",
    sdNotSeriesBody:
      "Set a repeat schedule in the event editor to manage its dates here.",
    sdNeedsEditor:
      "This date needs one more step in the event editor — open it to finish publishing.",
    sdPublishedTitle: "Date published",
    sdPublishedMessage: "{date} is now live.",
    sdDraftCreatedTitle: "Draft created",
    sdDraftCreatedMessage: "{date} now has a draft event.",
    sdDraftFailedTitle: "Couldn't create draft",
    sdDraftNotCreated:
      "This date couldn't get a draft — it's in the past or already has an event.",
    sdRestoreFailedTitle: "Couldn't restore date",

    /* ── ApplicationFormBuilder ────────────────────────── */
    afTitle: "Application Form",
    afSubtitle: "{count, plural, one {# question} other {# questions}}",
    afLoading: "Loading\u2026",
    afEmptyState: "No questions yet. Add your first question below.",
    afUntitledQuestion: "Untitled question",
    afShortText: "Short Text",
    afShortTextDesc: "Single-line text answer",
    afLongText: "Long Text",
    afLongTextDesc: "Multi-line text answer",
    afSingleChoice: "Single Choice",
    afSingleChoiceDesc: "Pick one from a list",
    afMultiChoice: "Multiple Choice",
    afMultiChoiceDesc: "Pick multiple from a list",
    afLabel: "Label",
    afLabelPlaceholder: "e.g. What is your experience with\u2026?",
    afDescriptionOptional: "Description (optional)",
    afDescriptionPlaceholder: "Help text for the applicant",
    afOptions: "Options",
    afOptionPlaceholder: "Option {number}",
    afAddOption: "Add option",
    afRequired: "Required",
    afAddQuestion: "Add Question",
    afCancel: "Cancel",
    afSaving: "Saving\u2026",
    afSave: "Save",
    afChooseType: "Choose question type",
    afRemoveQuestion: "Remove question: {label}",
    afRemoveOption: "Remove option {number}",

    /* ── Application form templates (spec Phase 4) ────── */
    afOptionsRequiredError:
      "“{label}” is a choice question, so it needs at least one option before you can save.",
    aftDiscardConfirmTitle: "Discard unsaved changes?",
    aftDiscardConfirmBody:
      "Starting from a template reloads this form from the server, so anything you haven’t saved — new questions, edits and removals — will be lost. Cancel and save first if you want to keep them.",
    aftDiscardConfirmCta: "Discard and continue",
    aftStartFromTemplate: "Start from a template",
    aftSaveAsTemplate: "Save as template",
    aftPickerTitle: "Start from a template",
    aftPickerSubtitle:
      "Pick a starting point. You can edit every question afterwards.",
    aftPickerEmpty: "No templates available yet.",
    aftPlatformHeading: "From Ithas Fire",
    aftOwnHeading: "Your templates",
    aftQuestionCount:
      "{count, plural, =0 {No questions} one {# question} other {# questions}}",
    aftAppendNote:
      "The template’s questions are added after any you already have — nothing is replaced.",
    aftApplyCta: "Use this template",
    aftApplying: "Adding…",
    aftAppliedTitle: "Template added",
    aftAppliedMessage:
      "{count, plural, =0 {No questions were added.} one {Added # question to your form.} other {Added # questions to your form.}}",
    aftApplyFailed: "Couldn’t use that template",
    aftBlockedBySubmissions:
      "Some applications are still waiting on a decision, so a template can’t be added right now. Review those applications first, or edit the questions directly.",
    aftSaveDialogTitle: "Save as template",
    aftSaveDialogSubtitle: "Reuse this form on your next event.",
    aftNameLabel: "Template name",
    aftNamePlaceholder: "e.g. Performer application",
    aftDescriptionLabel: "Description (optional)",
    aftDescriptionPlaceholder: "What is this form for?",
    aftIntroLabel: "Intro text (optional)",
    aftIntroPlaceholder: "Tell us about your act…",
    aftIntroHint: "Shown above the questions when someone applies.",
    aftSaveFromSavedNote:
      "{count, plural, =0 {Saves the form as it is stored on the event. Unsaved edits in this builder are not included.} one {Saves the # question stored on the event. Unsaved edits in this builder are not included.} other {Saves the # questions stored on the event. Unsaved edits in this builder are not included.}}",
    aftSaveCta: "Save template",
    aftSaving: "Saving…",
    aftSavedTitle: "Template saved",
    aftSavedMessage:
      "{count, plural, =0 {Saved “{name}” with no questions.} one {Saved “{name}” with # question.} other {Saved “{name}” with # questions.}}",
    aftTemplateSavedMessage: "“{name}” is ready to use.",
    aftSaveFailed: "Couldn’t save the template",
    aftNameTaken: "You already have a template called “{name}”.",

    /* ── Application form templates — workspace library ── */
    aftPageTitle: "Application forms",
    aftPageSubtitle:
      "Reusable question sets for events that need approval before people can get in.",
    aftLoading: "Loading application form templates…",
    aftNameColumn: "Template",
    aftDescriptionColumn: "Description",
    aftQuestionsColumn: "Questions",
    aftReadOnly: "Read-only",
    aftNewCta: "New template",
    aftEmptyTitle: "No application forms yet",
    aftEmptyDescription:
      "Build one here, or save an event’s form as a template from the event builder.",
    aftCreateFirst: "Create a template",
    aftNewDialogTitle: "New application form template",
    aftEditDialogTitle: "Edit application form template",
    aftQuestionsEmpty: "No questions yet. Add your first question below.",
    aftEditTooltip: "Edit template: {name}",
    aftEditTooltipShort: "Edit",
    aftArchiveTooltip: "Archive template: {name}",
    aftArchiveTooltipShort: "Archive",
    aftArchiveConfirmTitle: "Archive this template?",
    aftArchiveConfirmBody:
      "“{name}” stops appearing in the template picker. Forms already built from it are unaffected.",
    aftArchiveConfirmCta: "Archive",
    aftArchivedTitle: "Template archived",
    aftArchiveFailed: "Couldn’t archive the template",

    /* ── SeatingLayoutEditor ───────────────────────────── */
    slLoading: "Loading seating layout\u2026",
    slErrorTitle: "Unable to load place layout.",
    slErrorHint: "Make sure the place has a layout assigned.",
    slSections: "Sections",
    slSectionsHint:
      "Click a section on the map or below to assign ticket types.",
    slSeats: "{count} seats",
    slAssignTicketType: "Assign ticket type",
    slNoneUnassigned: "None (unassigned)",
    slCapacity: "{cap} cap",
    slCurrently: "Currently: {label}",
    slFree: "Free",
    slPaintMode: "Paint Mode",
    slPaintHint:
      "Select a ticket type, then click sections on the map to assign.",
    slPainting: "Painting: {name}",
    slExit: "Exit",
    slAssigned: "Assigned",
    slUnassigned: "Unassigned",
    slUnsaved: "{count} unsaved",
    slDiscard: "Discard",
    slSaving: "Saving\u2026",
    slSaveAssignments: "Save Assignments",
    slSavedTitle: "Seating assignments saved",
    slSavedMessage:
      "{count, plural, one {# ticket type} other {# ticket types}} updated.",
    slSaveFailed: "Failed to save assignments",

    // ProseEditor
    peDefaultPlaceholder: "Start writing\u2026",
    peImageDisabledTooltip: "Save your event first to enable image uploads",
    peLinkPrompt: "Enter URL:",
    peBold: "Bold",
    peItalic: "Italic",
    peStrikethrough: "Strikethrough",
    peLink: "Link",
    peHeading1: "Heading 1",
    peHeading2: "Heading 2",
    peHeading3: "Heading 3",
    peBulletList: "Bullet List",
    peNumberedList: "Numbered List",
    peQuote: "Quote",
    peHorizontalRule: "Horizontal Rule",
    peInsertImage: "Insert Image",
    peInsertAudio: "Insert Audio",
    peUploading: "Uploading image\u2026",
    peUploadingAudio: "Uploading audio\u2026",
    peUndo: "Undo",
    peRedo: "Redo",
    peUnderline: "Underline",
    peHighlight: "Highlight",
    peAlignLeft: "Align left",
    peAlignCenter: "Align center",
    peAlignRight: "Align right",
    peClearFormatting: "Clear formatting",
    peToolbar: "Formatting toolbar",
    peSelectionToolbar: "Format selection",
    peMoreFormatting: "More formatting",
    peCancel: "Cancel",
    peConfirmLink: "Confirm link",
    peOpenLink: "Open link",
    peRemoveLink: "Remove link",
    peChooseFile: "Choose file",
    peUploadFile: "Upload File",
    peImageUrl: "Image URL",
    peInsert: "Insert",
    peWords: "{count, plural, one {# word} other {# words}}",
    // Block insert menu ("/" and "+") and the block grip
    peInsertBlock: "Insert block",
    peBlockImage: "Image",
    peBlockAudio: "Audio",
    peBlockEmbed: "Media embed",
    peBlockHandle: "Block options",
    peBlockHandleHint: "Drag to move, click for options",
    peMoveBlockUp: "Move up",
    peMoveBlockDown: "Move down",
    peDeleteBlock: "Delete block",
    peBlockMovedUp: "Block moved up",
    peBlockMovedDown: "Block moved down",
    peBlockDeleted: "Block deleted",

    // ImageBlockNodeView
    ibFailedToLoad: "Failed to load image",
    ibImageLoading: "Image loading\u2026",
    ibLoading: "Loading\u2026",
    ibAlignLeft: "Align left",
    ibAlignCenter: "Align center",
    ibAlignRight: "Align right",
    ibDeleteImage: "Delete image",
    ibAddAlt: "Add alt text",
    ibAltPlaceholder: "Alt text",
    ibSaveAlt: "Save alt text",
    ibCaptionLabel: "Image caption",
    ibCaptionPlaceholder: "Add a caption",

    // AudioBlockNodeView
    abTranscoding: "Transcoding",
    abProcessing: "Processing",
    abReady: "Ready",
    abFailed: "Failed",
    abRemove: "Remove audio",
    abDefaultTitle: "Audio",
    abAllowDownload: "Allow download",
    abDownloadsAllowed: "Downloads allowed",
    abDownloadAudio: "Download audio",
    abUploading: "Uploading",
    abStillWorking: "Still working",
    abStillWorkingMinutes: "Still working · {minutes}m",
    abPlayingOriginal: "Playing the original",
    abProcessingFailed: "Processing failed",
    abProcessingFailedBody:
      "We couldn't process this file. Remove it and upload again.",
    abWaitingForTranscode:
      "Audio is being processed. Playback will be available shortly.",
    abTranscodeFailed:
      "Transcoding failed. Please try uploading the file again.",

    // AdminTableParts
    atRefresh: "Refresh",
    atSearchPlaceholder: "Search...",
    atClearFilters: "Clear filters",
    // NoResults' clear button. Deliberately distinct from atClearFilters:
    // both buttons render at once in the filtered-empty state, and two
    // controls sharing one accessible name is ambiguous for screen-reader
    // and voice-control users.
    atClearFiltersShowAll: "Clear filters and show all",
    atPrevious: "Previous",
    atNext: "Next",
    atPageOf: "Page {page} of {total}",
    // Pagination's range label. Translated, not a literal: `Pagination` is
    // reused by SELLER-facing pages (sell/listings, sell/claims, sell/payouts),
    // so a hardcoded English string would regress es users there.
    atRowsRange: "Rows {start}–{end} of {total}",
    atRowsPerPage: "Rows per page",
    atExportCsv: "Export CSV",
    atExportAll: "Export all ({total})",
    atExporting: "Exporting...",
    atColumns: "Columns",
    atShowAllColumns: "Show all",
    atExportLargeWarning: "Large export ({total} rows) — may be slow",
    atExportTooLarge: "Too many rows ({total}). Use background export.",
    atExportBackground: "Export in background ({total} rows)",
    atExportBackgroundQueued:
      "Export queued — you'll be notified when it's ready.",
    atExportBackgroundFailed:
      "Failed to start background export. Please try again.",

    // CsvImportDialog
    csvImportTitle: "Import CSV",
    csvImportStepUpload: "Upload",
    csvImportStepMap: "Map Columns",
    csvImportStepPreview: "Preview",
    csvImportUploadTitle: "Select a CSV file",
    csvImportUploadDescription:
      "Upload a .csv, .tsv, or .txt file. The first row must contain column headers.",
    csvImportChooseFile: "Choose File",
    csvImportDragHint: "or drag and drop",
    csvImportUnsupportedTitle: "Unsupported format",
    csvImportUnsupportedMessage: "Please upload a .csv, .tsv, or .txt file.",
    csvImportParseError: "Parse error",
    csvImportParseErrorMessage:
      "Could not read the file. Make sure it contains a header row.",
    csvImportMapColumns: "Map columns",
    csvImportMapDescription: "{fileName} — {rowCount} rows detected",
    csvImportSourceColumn: "CSV Column",
    csvImportTargetField: "Maps to",
    csvImportSkip: "Skip",
    csvImportMissingRequired: "Required fields not mapped: {fields}",
    csvImportContinue: "Continue",
    csvImportStartOver: "Start over",
    csvImportBack: "Back",
    csvImportTotalRows: "Total rows",
    csvImportValidRows: "Valid",
    csvImportInvalidRows: "Invalid",
    csvImportLargeWarning:
      "Large import ({total} rows). This may take a moment.",
    csvImportPreview: "Preview",
    csvImportPreviewMore: "+{remaining} more rows",
    csvImportTabValid: "Valid ({count})",
    csvImportTabInvalid: "Invalid ({count})",
    csvImportErrorsColumn: "Errors",
    csvImportAllValid: "All rows are valid",
    csvImportPage: "Page {page} of {total}",
    csvImportSubmit: "Import {count} rows",
    csvImportImporting: "Importing\u2026",
    csvImportImportingDescription: "Processing {count} rows. Please wait.",
    csvImportComplete: "Import complete",
    csvImportCompleteMessage: "{imported} imported, {skipped} skipped.",
    csvImportCompleteTitle: "Import Complete",
    csvImportImported: "Imported",
    csvImportSkipped: "Skipped",
    csvImportDone: "Done",
    csvImportAnother: "Import another",
    csvImportFailed: "Import failed",
    csvImportModeFile: "File",
    csvImportModePaste: "Paste",
    csvImportPasteTitle: "Paste CSV data",
    csvImportPasteDescription:
      "Paste comma-separated or tab-separated text. First line = column headers.",
    csvImportPastePlaceholder:
      "name,email,city\nJane Doe,jane@example.com,Portland\nJohn Smith,john@example.com,Austin",
    csvImportPasteNoHeaders:
      "No column headers detected. Make sure the first line contains headers.",
    csvImportPasteInvalid:
      "Could not parse the text. Check the formatting and try again.",
    csvImportPasteValid: "Valid",
    csvImportPasteStats: "{columns} columns \u00b7 {rows} rows",
    csvImportPasteColumnsFound: "Columns detected",
    csvImportPastedData: "Pasted data",
    csvImportPasteClear: "Clear",

    // Calendar
    calAllOwners: "All owners",
    calAllSeries: "All series",
    calChallenged: "Challenged",
    calConfirmed: "Confirmed",
    calContinued: "cont.",
    calCopied: "Copied",
    calCopyLink: "Copy link",
    calDateOf: "Date {index} of {total}",
    calEdit: "Edit",
    calEmptyWindow: "No events in this window.",
    calFilters: "Filters",
    calFiltersGroup: "Calendar filters",
    calFiltersWithCount: "Filters \u00b7 {count}",
    calHeld: "Held",
    calHoldChallengedTag: "#{position} \u00b7 {respondBy}",
    calHoldConfirmedTag: "#{position} \u00b7 Confirmed",
    calHoldLine: "Hold line",
    calHoldTag: "Hold \u00b7 #{position}",
    calHolds: "Holds",
    calHours: "Hours",
    calItemCount: "{count, plural, one {# item} other {# items}}",
    calKeyDate: "Date",
    calKeyGoing: "Going",
    calKeyLocal: "Local",
    calKeyOwner: "Owner",
    calKeySeries: "Series",
    calKeySold: "Sold",
    calKeyVenue: "Place",
    calLoading: "Loading",
    calMore: "More",
    calMoreOnDate: "{count} more on {date}",
    calNewEventOn: "New event \u00b7 {date}",
    calNothingOnDay: "Nothing on this day.",
    calOccurrenceOf: "{index} of {total}",
    calOpenBooking: "Open booking",
    calOwnerCount: "{count, plural, one {# owner} other {# owners}}",
    calOwners: "Owners",
    calPlaced: "Placed {date}",
    calPlusMore: "+{count} more",
    calPublicPage: "Public page",
    calRespondBy: "Respond by {when}",
    calSeries: "Series",
    calShowAllHours: "Show all hours",
    calShowMore: "Show more",
    calShowMoreRange: "Show more \u00b7 {range}",
    calShowVenueHours: "Show place hours",
    calSoldOut: "Sold out",
    calStatus: "Status",
    calTomorrow: "Tomorrow",
    calUntitledEvent: "Untitled event",
    calExportMonth: "Export month",
    calIcsViewEvent: "View event: {url}",
    calAllCalendars: "All calendars",
    calCalendarPicker: "Calendar",
    calCopyFailed: "Couldn't copy",
    calCreatingAs: "Creating as · {owner}",
    calDashboardEmptyWindow: "Nothing scheduled in this window.",
    calHoldAt: "Hold at {place}",
    calHoursCaption: "Hours · {scope} · {span} · {zone}",
    calHoursUnavailable: "Hours unavailable",
    calNoHoursSet: "No hours set",
    calScheduleLoadFailed: "Couldn't load your schedule.",
    calVenueEmptyWindow: "Nothing at this place in this window.",
    calVenueFallbackName: "Place",
    calVenueLocal: "Local time at the place: {time}",
    calViewGroup: "Calendar view",
    ecUntitled: "Untitled",
    ecPublished: "Published",
    ecDraft: "Draft",
    ecCompleted: "Completed",
    ecCancelled: "Cancelled",
    ecSun: "Sun",
    ecMon: "Mon",
    ecTue: "Tue",
    ecWed: "Wed",
    ecThu: "Thu",
    ecFri: "Fri",
    ecSat: "Sat",
    ecJanuary: "January",
    ecFebruary: "February",
    ecMarch: "March",
    ecApril: "April",
    ecMay: "May",
    ecJune: "June",
    ecJuly: "July",
    ecAugust: "August",
    ecSeptember: "September",
    ecOctober: "October",
    ecNovember: "November",
    ecDecember: "December",
    ecSubscribe: "Copy subscribe link ({language})",
    ecCopiedWebcal: "Copied webcal URL",
    ecPrevious: "Previous",
    ecNext: "Next",
    ecDownloadIcs: "Download .ics",
    ecToday: "Today",
    ecMonth: "Month",
    ecWeek: "Week",
    ecAgenda: "Agenda",
    ecConflict: "Double-booked",
    // Hold overlay (booking-holds FR-014) — tentative, never an event.
    ecHoldLegend: "Hold",
    ecHoldCount: "{count, plural, one {# hold} other {# holds}}",
    ecHoldUnnamedAct: "Unnamed act",
    ecHoldChallenged: "Challenged — the act's reply is due",
    ecCreateEventOn: "Create event on {date}",

    // AdminShell
    asLoading: "Loading\u2026",
    asLoadErrorTitle: "Couldn't load your admin workspace",
    asLoadErrorBody:
      "Something went wrong reaching the server. This is usually temporary.",
    asRetry: "Retry",
    asRetrying: "Retrying\u2026",
    asExitToAttendee: "Exit to attendee view",
    asBrowseEvents: "Browse and discover events",
    asGoToWorkspaceDashboard: "Go to {workspace} dashboard",
    // Ledger shell topbar: the surface name beside the wordmark.
    navRoleAdmin: "Admin",

    // AdminRoot
    arLoading: "Loading...",
    arRedirecting: "Redirecting...",
    arAdminDashboard: "Admin Dashboard",
    arSelectAccount: "Select an account to manage",
    arSelectAccountToCreate: "Create an Event",
    arSelectAccountToCreateDesc:
      "Choose which account to create the event under",
    arPersonalAccount: "Personal Account",
    arRoleLabel: "Role: {role}",
    arRoleOwner: "Owner",
    arRoleAdmin: "Admin",
    arRoleEditor: "Editor",
    // ── Platform shell ────────────────────────────────────────────────
    psLoading: "Loading\u2026",
    psAccessDenied: "Access Denied",
    psNoStaffRole:
      "You do not have the required staff role to access this area.",
    psReturnHome: "Return home",
    psExitToAttendee: "Exit to attendee view",
    psBrowseEvents: "Browse and discover events",
    // Accessible name for the rail identity block / drawer account header,
    // which is the one way back to /platform/overview now that Overview is
    // not a nav item.
    psGoToOverview: "Go to platform overview",
    // ── Platform overview ─────────────────────────────────────────────
    poPlatform: "Platform",
    poSubtitle: "Internal tools for Ithas Fire staff",
    poOrders: "Orders",
    poOrdersDesc:
      "Search and review orders across all groups. View payment details, refund history, and active carts.",
    poTickets: "Tickets",
    poTicketsDesc:
      "Look up tickets across all events. View transfer history, scan records, and ticket status.",
    poPlaceVerification: "Place Verification",
    poPlaceVerificationDesc:
      "Review and approve place verification requests from place owners.",
    poStatsTitle: "Platform at a Glance",
    poStatsLoading: "Loading platform stats\u2026",
    poStatTotalOrders: "Total Orders",
    poStatSucceededOrders: "Succeeded Orders",
    poStatCapturedOrders: "Orders with captured money",
    poStatGrossRevenue: "Gross Revenue",
    poStatPlatformFees: "Platform Fees Collected",
    poStatTotalEvents: "Events Created",
    poStatTicketsSold: "Tickets Sold",
    poStatTotalHumans: "Registered Users",
    poStatTotalOrgs: "Groups",
    poQuickLinksTitle: "Quick Links",
    // ── Platform navigation ───────────────────────────────────────────
    // Group headings for the four-group platform rail (Queues / Records /
    // Catalog & pricing / Operations). Same role as the admin rail's
    // `navGroup*` keys above.
    navGroupQueues: "Queues",
    navGroupRecords: "Records",
    navGroupCatalog: "Catalog & pricing",
    navGroupOperations: "Operations",
    navPlatformClaims: "Claims",
    navPlatformRoles: "Roles",
    navPlatformAuditLog: "Audit Log",
    navPlatformDisputes: "Disputes",
    navPlatformImageModeration: "Image moderation",
    navPlatformOverview: "Overview",
    navPlatformSettlements: "Settlements",
    navPlatformCashDebts: "Unpaid tax on cash",
    navPlatformTickets: "Tickets",
    navPlatformHumans: "Humans",
    navPlatformSupport: "Support",
    navPlatformCategories: "Categories",
    navPlatformCommunityListings: "Community listings",
    clTitle: "Community listings",
    clNew: "New listing",
    clStatusFilter: "Status",
    clStatusActive: "Live",
    clSearch: "Search by title",
    clEdit: "Edit",
    clView: "View",
    clCount: "{count, plural, one {# listing} other {# listings}}",
    clNextNight: "Next: {when}",
    clNoNextNight: "No upcoming night",
    clUpcomingNights: "{count, plural, one {# upcoming night} other {# upcoming nights}}",
    clEmpty: "No community listings yet.",
    clEmptyFiltered: "No listings match.",
    clForbidden: "Only platform admins can manage community listings.",
    clLoadMore: "Load more",
    clLoading: "Loading\u2026",
    clRetry: "Retry",
    clNoPlace: "No place",
    clColListing: "Listing",
    clColPlace: "Place",
    clColNext: "Next night",
    navPlatformVolunteerPacks: "Volunteer Packs",
    navPlatformThemeEditor: "Theme Editor",
    navPlatformSettings: "Settings",
    navPlatformWebhookDlq: "Webhook DLQ",
    navPlatformMemberships: "Memberships",
    navPlatformJobs: "Jobs",
    navPlatformQuotas: "Quotas",
    navPlatformFeatureGates: "Feature Gates",
    // Cross-area rail entries pointing at the /moderate/** review queues.
    // "Edit suggestions" rather than "Suggestions" — the admin event rail
    // already uses that word for a single event's suggestions.
    navPlatformEditSuggestions: "Edit suggestions",
    navPlatformModeratorApplications: "Moderator applications",
    // ── Platform Claims (shared with sell/claims; overrides locale pkg) ──
    pclTitle: "Claims",
    pclSubtitle: "Review and resolve buyer claims.",
    pclRefresh: "Refresh",
    pclFilters: "Filters",
    pclClear: "Clear",
    pclFailedToLoad: "Failed to load claims: {error}",
    pclNoResults: "No claims found",
    pclAdjustFilters: "Try adjusting your filters.",
    pclId: "ID",
    pclKind: "Type",
    pclStatus: "Status",
    pclBuyer: "Buyer",
    pclSeller: "Seller",
    pclResolution: "Resolution",
    pclDeadline: "Deadline",
    pclCreated: "Created",
    pclStatusOpen: "Open",
    pclStatusUnderReview: "Under review",
    pclStatusApproved: "Approved",
    pclStatusDenied: "Denied",
    pclStatusExpired: "Expired",
    pclKindTicketInvalid: "Ticket invalid",
    pclKindEntryDenied: "Entry denied",
    pclKindWrongSeat: "Wrong seat",
    pclKindOther: "Other",
    // ── Platform Humans page ──────────────────────────────────────────
    phTitle: "Humans",
    phSubtitle: "All registered users across the platform.",
    phSearchPlaceholder: "Search by name, email, or username\u2026",
    phColName: "Name",
    phColEmail: "Email",
    phColUsername: "Username",
    phColStatus: "Status",
    phColVerified: "Verified",
    phColOrganizations: "Groups",
    phColRoles: "Roles",
    phColJoined: "Joined",
    phVerified: "Verified",
    phUnverified: "Unverified",
    phNoHumansYet: "No humans yet",
    phNoHumansYetDesc: "Users will appear here once they sign up.",
    phNoMatchingHumans: "No matching humans",
    phNoMatchingHumansDesc: "Try adjusting your search or filters.",
    phFilterAll: "All",
    phFilterVerified: "Verified",
    phFilterUnverified: "Unverified",
    phStatusActive: "Active",
    phStatusInvited: "Invited",
    phStatusSuspended: "Suspended",
    phStatusBanned: "Banned",
    phFilterFlagged: "Flagged sign-ups",
    phFlagged: "Flagged",
    phFlaggedMatch: "Same network as {names}",
    phFilterFlaggedCount: "Flagged sign-ups ({count})",
    phFlaggedLoadFailed: "Flagged sign-ups could not be loaded: {error}",
    phFlaggedTruncated:
      "Showing the newest {shown} of {total} flagged sign-ups.",
    phColSameNetwork: "Same network as",
    phFlaggedMatchBanned: "Same network as a banned account: {names}",
    phFlaggedMatchSuspended: "Same network as a suspended account: {names}",
    phFlaggedAccountBanned: "{name} (banned)",
    phFlaggedAccountSuspended: "{name} (suspended)",
    // ── Platform Humans: row actions ──────────────────────────────────
    phActions: "Actions",
    phSuspend: "Suspend",
    phBan: "Ban",
    phReactivate: "Reactivate",
    phForceVerify: "Force Verify Email",
    phManageAccounts: "Manage Accounts",
    phDeleteHuman: "Delete Human",
    phStatusChanged: "Status updated",
    phStatusChangeFailed: "Failed to update status",
    phForceVerified: "Email marked as verified",
    phForceVerifyFailed: "Failed to force verify email",
    phForceVerifyBlocked:
      "Holds tickets, orders or a lineup or volunteer role sent to this email. Ask them to sign in with an email code, which verifies it.",
    phStatusConfirmBody:
      "Are you sure you want to {action} {name}? This will take effect immediately.",
    phReasonPlaceholder: "Reason for this action (optional)",
    phManageAccountsTitle: "Linked accounts \u2014 {name}",
    phNoLinkedAccounts: "No linked authentication accounts found.",
    phUnlinkConfirm:
      "Unlink {provider}? The user will no longer be able to sign in with this provider.",
    phAccountUnlinked: "Account unlinked",
    phUnlinkFailed: "Failed to unlink account",
    phUnlink: "Unlink",
    phDeleteHumanTitle: "Delete Human",
    phDeleteWarning:
      "You are about to permanently delete {name}. This action cannot be undone.",
    phDeleteCascadeWarning: "Cascading deletion",
    phDeleteCascadeDetail:
      "Auth accounts, sessions, and the profile will be permanently removed. Financial records (orders, payouts) are preserved.",
    phDeleteConfirmLabel: "Type {email} to confirm",
    phHumanDeleted: "Human deleted",
    phDeleteFailed: "Failed to delete human",
    phDeleting: "Deleting\u2026",
    phConfirmDelete: "Delete permanently",
    // ── Platform Feature Gates page ───────────────────────────────────
    fgTitle: "Feature Gates",
    fgSubtitle:
      "Toggle platform-wide feature gates. Changes take effect immediately for all users.",
    fgGateTravelTime: "Travel Time",
    fgGateTravelTimeDesc:
      "Show estimated travel time to events based on user location.",
    fgGateCreateEvents: "Event Creation",
    fgGateCreateEventsDesc: "Allow organizers to create new events.",
    fgGateBuyTickets: "Ticket Purchasing",
    fgGateBuyTicketsDesc: "Allow attendees to purchase tickets and check out.",
    fgGatePromos: "Promo Codes",
    fgGatePromosDesc: "Enable promo code creation, management, and redemption.",
    fgGateFullHomepage: "Full Homepage",
    fgGateFullHomepageDesc:
      "Show the full event discovery homepage. When off, visitors see the Coming Soon page with the place review form.",
    fgGateMaintenanceMode: "Maintenance Mode",
    fgGateMaintenanceModeDesc:
      "Put the entire public site into maintenance mode. All public routes show a maintenance notice. Admin and platform routes remain accessible.",
    fgGateEntityPageEditor: "Entity page editor",
    fgGateEntityPageEditorDesc:
      "Unlocks the freeform block editor for artist, place, and promoter pages. When off, pages use the app-controlled standard template.",
    fgGateHumanProfilesPublic: "Public human profiles",
    fgGateHumanProfilesPublicDesc:
      "Show public profile pages for user accounts. When off, human profile pages 404 and humans are hidden from search. Organizer and place profiles are unaffected.",
    fgGateResale: "Ticket resale",
    fgGateResaleDesc:
      "Let ticket holders resell their tickets to other fans. When off, the resale pages, the Seller Hub and organizers' resale settings are hidden.",
    fgGateArrivalAreas: "Arrival areas",
    fgGateArrivalAreasDesc:
      "Show parking, accessible drop-off and load-in areas on place and event maps. When off, the shapes, the \"Getting there\" list and their editors are hidden.",
    fgEnabled: "Enabled",
    fgDisabled: "Disabled",
    fgSaving: "Saving\u2026",
    fgSaved: "Saved",
    fgError: "Failed to save",
    fgEnvDefault: "Env default",
    heroStyleTitle: "Homepage Layout",
    heroStyleDesc:
      "Controls which hero component(s) appear at the top of the homepage.",
    heroStyleMap: "Map",
    heroStyleMapDesc: "Full-bleed map of places with an event ticker",
    heroStyleCarousel: "Carousel",
    heroStyleCarouselDesc: "Featured items hero carousel",
    heroStyleBoth: "Both",
    heroStyleBothDesc: "Map hero followed by carousel",
    heroStyleSaving: "Saving\u2026",
    heroStyleSaved: "Saved",
    heroStyleError: "Failed to save",
    heroStyleActiveBadge: "Current",
    // ── Maintenance page ──────────────────────────────────────────────
    maintenanceTitle: "Under Maintenance",
    maintenanceBody: "We're making some improvements. Check back shortly.",
    // ── Coming-soon route guard ───────────────────────────────────────
    comingSoonRedirectTitle: "Coming Soon",
    comingSoonRedirectBody:
      "Ithas Fire is not live yet. Head to the homepage to rate a place while you wait.",
    comingSoonRedirectCta: "Go to homepage",
    // ── Platform Jobs page ────────────────────────────────────────────
    jobsTitle: "Scheduled Jobs",
    jobsSubtitle:
      "Monitor background jobs, view run history, and manage the dead-letter queue.",
    jobsRefresh: "Refresh",
    jobsRunNow: "Run Now",
    jobsEnable: "Enable",
    jobsDisable: "Disable",
    jobsEnabled: "Enabled",
    jobsDisabled: "Disabled",
    jobsName: "Job",
    jobsSchedule: "Schedule",
    jobsLastRun: "Last Run",
    jobsStatus: "Status",
    jobsDuration: "Duration",
    jobsSuccess: "Success",
    jobsError: "Error",
    jobsNever: "Never run",
    jobsOnDemand: "On-demand",
    jobsRunHistory: "Run History",
    jobsNoRuns: "No runs recorded yet.",
    jobsDlq: "Dead-Letter Queue",
    jobsDlqEmpty: "No items in the dead-letter queue.",
    jobsDlqPurge: "Purge All",
    jobsDlqRerun: "Rerun",
    jobsDlqDelete: "Delete",
    jobsDlqPayload: "Payload",
    jobsDlqError: "Error",
    jobsDlqFailedAt: "Failed At",
    jobsDlqRerunning: "Rerunning…",
    jobsDlqRerunRan: "The job ran. The entry was removed.",
    jobsDlqRerunRanEntryKept:
      "The job ran, but its entry could not be removed and is still here. Delete it. Rerunning it would run the job a second time.",
    jobsDlqRerunPaused:
      "This job is disabled, so nothing ran. The entry is still here. Enable the job, then rerun the entry.",
    jobsDlqRerunInFlight:
      "A run of this job was already going and took this in. The entry is still here. Check the run history, then rerun or delete it.",
    jobsDlqRerunUnconfirmed:
      "The jobs service did not confirm the run. The entry is still here.",
    jobsDlqRerunClaimed:
      "A rerun of this entry started in the last few minutes and may still be running. Nothing ran this time and the entry is still here. Check the run history, then try again in a few minutes.",
    jobsDlqRerunFailed: "The rerun failed: {error} The entry is still here.",
    jobsDlqRerunGone: "That entry is no longer in the queue.",
    jobsDlqRerunMayStillRun:
      "The run may still be in progress. Check the run history before rerunning.",
    jobsDlqRanDeleteThis: "This entry already ran. Delete it.",
    jobsDlqAttempt: "Attempt {count}",
    jobsDlqConfirmPurge:
      "Are you sure you want to purge all items from this dead-letter queue? This cannot be undone.",
    jobsLoadError: "Failed to load jobs:",
    jobsHistory: "History",
    jobsNextRun: "Next run",
    jobsShowDlq: "View Dead-Letter Queue",
    jobsHideDlq: "Hide Dead-Letter Queue",
    jobsSearchPlaceholder: "Filter jobs\u2026",
    jobsCount: "{count} jobs",
    // ── Platform quotas page ───────────────────────────────────────
    pqTitle: "Resource Quotas",
    pqSubtitle:
      "Manage platform-wide resource limits and review expansion requests.",
    pqTabDefaults: "Default Limits",
    pqTabRequests: "Expansion Requests",
    pqKind: "Resource",
    pqLimit: "Limit",
    pqUsage: "Usage",
    pqStatus: "Status",
    pqActions: "Actions",
    pqApprove: "Approve",
    pqReject: "Reject",
    pqPending: "Pending",
    pqApproved: "Approved",
    pqRejected: "Rejected",
    pqSubject: "Subject",
    pqReason: "Reason",
    pqCurrentLimit: "Current Limit",
    pqRequestedLimit: "Requested Limit",
    pqRequestedBy: "Requested By",
    pqReviewedBy: "Reviewed By",
    pqCreatedAt: "Created",
    pqReviewNote: "Review Note",
    pqReviewNotePlaceholder: "Optional note for the requester\u2026",
    pqNoRequests: "No expansion requests",
    pqNoRequestsDesc:
      "Expansion requests will appear here when users hit their resource limits.",
    pqSaveLimit: "Save",
    pqSaved: "Limit updated",
    pqSaveError: "Failed to update limit",
    pqEditLimit: "Edit",
    pqConfigured: "Configured",
    pqFallback: "Default",
    pqConfirmReject: "Are you sure you want to reject this expansion request?",
    pqKindOrgsOwned: "Groups Owned",
    pqKindOrgsJoined: "Groups Joined",
    pqKindStorageBytesOrg: "Group Storage",
    pqKindStorageBytesHuman: "Personal Storage",
    pqKindStorageBytesPlace: "Community Place Page Storage",
    quotaExceededPlaceStorage: "This place has reached its image storage limit.",
    pqKindEventsPerOrg: "Events per Group",
    pqKindMembersPerOrg: "Members per Group",
    pqKindAnnouncementsPerDay: "Announcements per Day",
    // ── Quota exceeded dialog (user-facing) ──────────────────────────
    quotaExceededTitle: "Limit Reached",
    quotaExceededBody:
      "You\u2019ve reached the {kind} limit ({limit}). Request an increase to continue.",
    quotaExceededPending:
      "You already have a pending expansion request for this resource.",
    quotaRequestExpansion: "Request Increase",
    quotaRequestReasonLabel: "Why do you need a higher limit?",
    quotaRequestReasonPlaceholder: "Briefly describe your use case\u2026",
    quotaRequestNewLimit: "Requested New Limit",
    quotaRequestSubmit: "Submit Request",
    quotaRequestSuccess:
      "Your expansion request has been submitted. You\u2019ll be notified when it\u2019s reviewed.",
    quotaRequestError: "Failed to submit expansion request",
    // ── Platform settings page ────────────────────────────────────────
    psTitle: "Platform Settings",
    psSubtitle: "Global configuration for the Ithas Fire platform.",
    psSupportEmail: "Support Email",
    psSupportEmailHint:
      "Contact email shown to users and used in outbound communications.",
    psPlatformName: "Platform Name",
    psPlatformNameHint:
      "Public-facing name of the platform (used in emails, branding, and the app title).",
    psPhysicalAddress: "Mailing Address",
    psPhysicalAddressHint:
      "Physical mailing address shown in email footers to satisfy CAN-SPAM. E.g. “123 Main St, Austin, TX 78701”.",
    psMaintenanceMode: "Maintenance Mode",
    psMaintenanceModeHint:
      "When enabled, public-facing pages display a maintenance notice instead of normal content.",
    psSaving: "Saving\u2026",
    psSave: "Save",
    psSaved: "Saved",
    psSaveError: "Failed to save setting",
    psEnabled: "Enabled",
    psDisabled: "Disabled",
    // ── Platform orders page ──────────────────────────────────────────
    plOrdersTitle: "Orders",
    plOrdersSubtitle: "Cross-group order lookup for platform support and ops.",
    plTabAll: "All Orders",
    plTabActiveCarts: "Active Carts",
    plTabDisputed: "Disputed",
    plSourcePrimary: "Primary",
    plSourceResale: "Resale",
    plOrderId: "Order ID",
    plOrg: "Group",
    plGross: "Gross",
    plSource: "Source",
    plItems: "Items",
    plBuyerTotal: "Buyer Total",
    plSearchPlaceholder: "Search by buyer, email, or order ID...",
    plRefresh: "Refresh",
    plFailedToLoadOrders: "Failed to load orders: {error}",
    plNoMatchingOrders: "No matching orders",
    plNoOrdersYet: "No orders yet",
    plNoMatchingOrdersDesc: "Try adjusting your search or filters.",
    plNoOrdersYetDesc:
      "Orders will appear here once customers purchase tickets.",
    plClearFilters: "Clear filters",
    plFilteredToBuyer: "Showing orders for one buyer",
    plClearBuyerFilter: "Show all orders",
    plOrderDetail: "Order Detail",
    plOrderIdLabel: "Order ID:",
    plCopyId: "Copy ID",
    plStripe: "Stripe",
    plDetailNotice:
      "Full detail panel will be available when the get-platform-order use case is implemented.",
    plClose: "Close",
    plPrevious: "Previous",
    plNext: "Next",
    plPage: "Page {current} of {total}",
    plParentOrder: "Parent Order:",
    plBillingCountry: "Billing Country",
    plUpdatedAt: "Updated",
    plSettlement: "Settlement",
    plSplits: "Revenue Splits",
    plSplitsPayee: "Payee",
    plSplitsAmount: "Amount",
    plSplitsTotal: "Split total",
    plSplitsEmpty: "No splits recorded for this order.",
    plSplitsLoading: "Loading splits…",
    plSplitsError: "Couldn't load splits.",
    plSplitsAdminOnly: "Split amounts are visible to platform admins.",
    plSplitsPayoutsOff: "Payouts off",
    plItemsPaidOut: "Paid out",
    plItemsRefunded: "Refunded",
    plItemsDetail: "Items",
    plPaidOutOn: "Paid out",
    plStripeRefs: "Stripe References",
    plFeeSnapshot: "Fee Policy (at order time)",
    plFeeMode: "Fee Mode",
    plFeePolicyId: "Policy ID",
    plFeeComputedAt: "Computed",
    plNetCharged: "Net Charged",
    plTax: "Tax",
    plOrderCode: "Order code",
    plCopyOrderCode: "Copy order code",
    plCreatedAt: "Created",
    plPaymentMethod: "Payment Method",
    plBillingAddress: "Billing Address",
    plBuyerEmail: "Email",
    plBuyerFeePct: "Buyer Fee %",
    plBuyerId: "Buyer ID",
    plBuyerName: "Name",
    plPromo: "Promo",
    plCurrentOwner: "Current Owner",
    plDiscount: "Discount",
    plEventId: "Event ID",
    plEventInfo: "Event",
    plFinancials: "Financials",
    plHeld: "Held",
    plItemName: "Item",
    plItemPayout: "Payout",
    plItemQty: "Qty",
    plItemTotal: "Total",
    plItemUnit: "Unit",
    plMaxFee: "Fee Cap",
    plMinFee: "Min Fee",
    plPayoutTermsId: "Payout Terms ID",
    plPlatformFixed: "Platform Fixed",
    plProcessorRate: "Processor Rate",
    plRefundedOn: "Refunded",
    plScanned: "Scanned",
    plScanSummary: "{scanned}/{total} tickets scanned",
    plSeat: "Seat",
    plTicketSubtotal: "Ticket Subtotal",
    plTransferred: "Transferred",
    plTransferredOn: "Transferred",

    // ── Platform – Tickets ───────────────────────────────────────────────
    ptStatusValid: "Valid",
    ptStatusScanned: "Scanned",
    ptStatusInvalid: "Invalid",
    ptStatusRefunded: "Refunded",
    ptStatusListed: "Listed",
    ptTitle: "Tickets",
    ptSubtitle: "Cross-group ticket lookup for platform support and ops.",
    ptSearchPlaceholder: "Search by ticket code, owner name or email...",
    ptClear: "Clear",
    ptRefresh: "Refresh",
    ptTicketCode: "Ticket Code",
    ptOwner: "Owner",
    ptEvent: "Event",
    ptTicketType: "Ticket Type",
    ptOrder: "Order",
    ptIssuedAt: "Issued At",
    ptScannedAt: "Scanned At",
    ptUnknownOwner: "Unknown",
    ptSummary: "{start}\u2013{end} of {total} tickets",
    ptSummaryEmpty: "No tickets",
    ptNoMatchingTickets: "No matching tickets",
    ptNoTicketsYet: "No tickets yet",
    ptNoMatchingTicketsDesc: "Try adjusting your search or filters.",
    ptNoTicketsYetDesc: "Tickets will appear here once they are issued.",
    ptTicketDetail: "Ticket Detail",
    ptClose: "Close",
    ptCode: "Code",
    ptSeat: "Seat",
    ptIssued: "Issued",
    ptScanned: "Scanned",
    ptTransfers: "Transfers",
    ptScans: "Scans",
    ptCopyCode: "Copy Code",
    ptViewOrder: "View Order",
    ptDetailNotice:
      "Full detail panel with transfer/scan history will be available when the get-platform-ticket use case is implemented.",
    ptFailedToLoadTickets: "Failed to load tickets: {error}",

    // ── Platform – Settlements ───────────────────────────────────────────
    pstStatusPending: "Pending",
    pstStatusTransferred: "Transferred",
    pstStatusFailed: "Failed",
    pstTitle: "Settlements",
    pstRefresh: "Refresh",
    pstSearchPlaceholder: "Search by event or payee...",
    pstFilters: "Filters",
    pstClear: "Clear",
    pstId: "ID",
    pstPayee: "Payee",
    pstEvent: "Event",
    pstAmount: "Amount",
    pstLines: "Lines",
    pstPayoutDate: "Payout Date",
    pstTransferId: "Transfer ID",
    pstPaymentIntents: "Payment Intents",
    pstCreated: "Created",

    // ── Platform – Settlements → Payouts owed ────────────────────────────
    pstOwedTitle: "Payouts owed",
    pstOwedIntro:
      "Two different numbers, and they are never the same one. Payable now is the matured, unblocked ledger balance — the input to tonight's batch, before its payout minimum, eligibility checks and transfer-time withholding. Total owed is everything we owe, matured or not — read that one when you are asking whether we can cover our obligations.",
    pstOwedPayableNow: "Payable now",
    pstOwedPayableNowHint:
      "The matured, unblocked ledger balance — the same read the payout batch plans from. Not a promise that it goes out tonight: see Tonight's batch.",
    pstOwedTotalOwed: "Total owed",
    pstOwedTotalOwedHint:
      "Every cent owed to a payee at any maturity, plus reserves and dispute holds. Normally larger than Payable now.",
    pstOwedNotReported: "Not reported",
    pstOwedUnpaidCredits: "Unpaid credits",
    pstOwedReserveHeld: "Reserve held",
    pstOwedPendingHold: "Dispute holds",
    pstOwedColPayee: "Payee",
    pstOwedColPayable: "Payable now",
    pstOwedColWaiting: "Oldest money matured",
    pstOwedColTonight: "Tonight's batch",
    pstOwedSkipNone: "No known blocker",
    pstOwedCapFootnote:
      "This column covers the payout minimum and the eligibility checks. It cannot see the per-run payee cap, so a payee with no blocker here may still be deferred to the next run.",
    pstOwedSkipUnknown: "Could not check eligibility",
    pstOwedSkipMinimumUnknown: "Could not check the minimum",
    pstOwedSkipBelowMinimum: "Below minimum",
    pstOwedMinimumIs: "Minimum",
    pstOwedSkipNoPayee: "No payee record",
    pstOwedSkipNoStripe: "No Stripe account",
    pstOwedSkipPayoutsOff: "Payouts disabled",
    pstOwedCaption: "Payees with a matured ledger balance",
    pstOwedEmpty:
      "No payee has a matured, unblocked ledger balance right now. Money we still owe but cannot send yet is counted under Total owed above.",
    pstOwedTruncated:
      "Showing the {limit} longest-waiting payees of {total}. The totals above cover every payee.",
    pstOwedTimedOut: "Owed view timed out — try again.",
    pstOwedRetry: "Retry owed view",
    pstOwedNoMatured: "No matured credit",
    pstOwedColExpected: "Expected next",
    pstOwedNoUpcoming: "Nothing upcoming",
    pstOwedExpectedUnknown: "Could not check",

    // ── Platform – Settlements → Batch clock ─────────────────────────────
    pstClockNext: "Next batch",
    pstClockDisabled: "Batch schedule is OFF",
    pstClockUnknown: "Could not read the batch schedule",
    pstClockUnscheduled: "Batch is not scheduled",
    pstClockPaused: "Batch is paused from the jobs page",
    pstClockUnprojectable:
      "Next run could not be projected — check the schedule on the jobs page",

    // ── Platform – Settlements → Upcoming payouts ────────────────────────
    pstUpTitle: "Upcoming payouts",
    pstUpIntro:
      "Settlement credit that has not matured yet, by the date it matures, net of carried-forward debt — including the debt created by holds on open disputes, which are already counted in today's payable. This forecasts MATURITY, not payment — the batch still applies its minimum, its per-run cap, its eligibility checks and transfer-time withholding on the night, and a refund landing first will reduce it.",
    pstUpColDate: "Matures",
    pstUpColPayee: "Payee",
    pstUpColCredits: "Credits",
    pstUpColAmount: "Amount",
    pstUpTotal: "Upcoming total",
    pstUpEmpty: "No unmatured credit. Everything owed is already payable.",
    pstUpCaption: "Unmatured settlement credit grouped by maturity date",
    pstUpCreditCount: "{count, plural, one {# credit} other {# credits}}",
    pstUpTimedOut: "Upcoming view timed out — try again.",
    pstUpRetry: "Retry upcoming view",
    pstUpTruncated:
      "Showing the {limit} earliest tranches of {total}. The totals above cover every tranche.",
    pstUpOfCredit: "of {credit} credit",
    pstUpUnderDispute:
      "{amount} under open dispute — already counted in today's payable",
    pstUpDebt: "{amount} applied to carried-forward debt",
    pstUpDebtUnknown: "Could not check debt",

    // ── Platform – Settlements → Platform revenue ────────────────────────
    pstRevTitle: "Platform revenue",
    pstRevIntro:
      "What the platform charged, and what it kept on the orders we can fully account for.",
    pstRevTicketVolume: "Ticket volume",
    pstRevTicketVolumeHint:
      "Ticket face value after discount — before tax, platform fee and processor fee. Not what the card was charged.",
    pstRevFeesCharged: "Platform fees charged",
    pstRevFeesChargedHint: "The fee recorded at checkout, not what we kept. Under PASS_THROUGH the buyer paid it on top. Orders sold before the organiser was credited the full ticket price also had it taken out of the organiser's credit; later orders did not.",
    pstRevFeesReturned: "Fees returned on refunds",
    pstRevProcessorCost: "Processor cost",
    pstRevConnectRecovered: "Connect fee recovered",
    pstRevConnectUnknown: "Could not read recovered costs",
    pstRevNetKept: "Net kept",
    pstRevNetKeptUnavailable: "Nothing eligible yet",
    pstRevNoColumn: "No column",
    pstRevNetExplain:
      "The fee the platform actually retained, after refunds, processor cost and platform-funded credit, over the orders this figure can close exactly. Orders that are disputed, resold, missing an input, or refunded in a way the arithmetic cannot account for are left out, so this is a subset and not all-time profit. {recorded} is the fee recorded at checkout.",
    pstRevTaxHeld: "Tax held for remittance",
    pstRevTaxHeldHint:
      "We are merchant of record and remit this. It is a liability, not revenue, and is excluded from every figure above.",
    pstRevStatuses: "Counts orders in: {statuses}",
    pstRevOrders: "{count, plural, one {# order} other {# orders}}",
    pstRevTimedOut: "Revenue view timed out — try again.",
    pstRevRetry: "Retry revenue view",
    pstRevNotRead: "Not read yet",
    pstRevPartial: "Partial",
    pstRevProcessorCoverage: "Measured on {measured} of {total} charged orders — the rest have not been read from Stripe yet, so this is less than the real cost.",
    pstRevEmpty: "No settled orders yet.",
    pstRevFeesReturnedCoverage: "Measured on {measured} of {total} refunded tickets — the rest were refunded before this was recorded, so this is less than the real figure.",
    pstRevFeesByMode: "{passThrough} charged to buyers on top (PASS_THROUGH) · {absorb} taken from the organiser (ABSORB)",
    pstRevFeesModeUnknown: "· {unknown} with no recorded mode",
    pstRevProcessorParked: "Measured on {measured} of {total} charged orders — {parked} could not be read from Stripe after repeated attempts and are parked until reset; the rest have not been read yet.",
    pstRevNetKeptCoverage: "Measured on {measured} of {total} orders. The rest are disputed, missing a fee mode, a cost read or a refund stamp, resold, or refunded in a way this figure cannot close — an absorbed processor fee or a spent credit the refund gave back. A cancelled event pushes this down, which is correct.",
    pstRevFeesReturnedNothing: "No tickets refunded in this currency, so no fee has been returned.",
    pstRevProcessorCostNothing: "No card charge linked to any order in this currency, so there is no processor cost to attribute.",
    pstRevNetKeptNothing: "No orders counted in this currency, so exactly nothing was kept and nothing given back.",

    // ── Platform – Settlements → Payouts sent ────────────────────────────
    pstPaidTitle: "Payouts sent",
    pstPaidIntro:
      "Every transfer we have attempted, newest first. Money in flight sorts above settled history. Gross is what the payee earned; Sent is what reached Stripe after the deductions beside it.",
    pstPaidFilterAll: "All",
    pstPaidColWhen: "When",
    pstPaidColPayee: "Payee",
    pstPaidColGross: "Gross",
    pstPaidColDeductions: "Deductions",
    pstPaidColNet: "Sent",
    pstPaidNetNotRecorded: "Not reported",
    pstPaidScheduled: "Scheduled",
    pstPaidFee: "Stripe fee",
    pstPaidReserveHeld: "Reserve held",
    pstPaidReserveReleased: "Reserve released",
    pstPaidDebtRecovered: "Debt recovered",
    pstPaidNoDeductions: "None",
    pstPaidFailureReason: "Reason: {reason}",
    pstPaidNoTransfer: "No Stripe transfer",
    pstPaidCaption: "Payout transfers, newest first",
    pstPaidEmptyEver:
      "No payout has ever run. Nothing has been sent to a payee yet — the batch mints these rows the first time it transfers.",
    pstPaidEmptyFiltered: "No payouts match this filter.",
    pstPaidLoadMore: "Load more payouts",
    pstPaidLoading: "Loading\u2026",
    pstPaidTimedOut: "Payout history timed out — try again.",
    pstPaidRetry: "Retry payout history",
    pstPaidTimeZoneNote: "Times shown in {zone}.",
    pstPayoutKindOrg: "Group",
    pstPayoutKindHuman: "Human",

    // ── Platform – Places ────────────────────────────────────────────────
    ppVerified: "Verified",
    ppPending: "Pending",
    ppUnverified: "Unverified",
    ppRejected: "Rejected",
    ppFilterAll: "All",
    ppTitle: "Place Verification",
    ppSubtitle:
      "Review verification requests from place owners and manage places.",
    ppSearchPlaceholder: "Search places...",
    ppRefresh: "Refresh",
    ppPlace: "Place",
    ppVerification: "Verification",
    ppOwners: "Owners",
    ppCapacity: "Capacity",
    ppReview: "Review",
    ppNoPendingRequests: "No pending verification requests",
    ppNoPlacesFound: "No {status} places found",
    ppAdjustSearch: "Try adjusting your search.",
    ppFailedToLoad: "Failed to load places: {error}",
    ppRetry: "Retry",
    ppPlaceCount: "{count, plural, one {# place} other {# places}}",

    // ── Platform – Place Directory Listing ───────────────────────────────
    ppDirectory: "Directory",
    ppListed: "Listed",
    ppUnlisted: "Unlisted",
    ppList: "List",
    ppUnlist: "Unlist",
    ppApprove: "Approve",
    ppApproveSuccess: "Place approved successfully",
    ppApproveFailed: "Failed to approve place",
    ppSelectedCount: "{count} selected",
    ppDeselectAll: "Deselect all",
    ppArchiveSelected: "Archive selected",
    ppBulkArchiveSuccess:
      "Archived {count, plural, one {# place} other {# places}}",
    ppBulkArchiveFailed: "Failed to archive places",
    ppDeleteSelected: "Delete permanently",
    ppBulkDeleteSuccess:
      "Permanently deleted {count, plural, one {# place} other {# places}}",
    ppBulkDeleteFailed: "Failed to delete places",
    ppBulkDeleteConfirm:
      "This will permanently delete {count, plural, one {# place} other {# places}}. This cannot be undone. Continue?",
    ppOwnerCount: "{count, plural, one {# owner} other {# owners}}",
    ppDetailUpdated: "Place updated",
    ppDetailVerified: "Place verified",
    ppDetailVerificationFailed: "Verification failed",
    ppDetailVerifying: "Verifying...",
    ppDetailVerifyPlace: "Verify Place",
    ppDetailVerifyHint: "Mark this place as verified by platform staff",
    ppDetailReviewVerificationRequest: "Review Verification Request",
    ppDetailOverrideVerifyPlace: "Override: Verify Place",
    ppDetailOverrideVerifyHint: "Override the rejection and verify this place",
    ppDetailStatusActive: "Active",
    ppDetailStatusArchived: "Archived",

    // ── Platform – Waive verification (skips document review) ────────────
    ppDetailWaiveVerification: "Waive verification",
    ppDetailWaiveHint:
      "Marks this place verified without document review — use when we've confirmed it another way.",
    ppDetailWaiveConfirmTitle: "Waive verification?",
    ppDetailWaiveConfirmBody:
      "{name} will be marked verified without any documents being reviewed. Only do this when we've confirmed the place another way. This is recorded in the audit log against your account.",
    // Deliberately NOT "Waive verification" — that is the trigger button's
    // label, and both are in the DOM at once while the dialog is open, so
    // reusing it would put two identically-named buttons on the page.
    ppDetailWaiveConfirmCta: "Waive without review",
    // Likewise NOT plain "Cancel": a name that says what it keeps. Modal now
    // makes everything outside the topmost dialog inert and aria-hidden, so
    // the panel behind no longer competes; the specific name still reads
    // better than a bare "Cancel".
    ppDetailWaiveCancelCta: "Don't waive",
    ppDetailWaiveNoteLabel: "Reason (optional)",
    ppDetailWaiveNotePlaceholder: "e.g. Owner confirmed on a call with ops",
    ppDetailWaiveNoteHelp: "Saved to the audit log alongside your name.",
    ppDetailWaiveSuccess: "Verification waived",
    ppDetailWaiveFailed: "Could not waive verification",

    // ── Platform – Place panel (sections, lifecycle) ─────────────────────
    ppStatusFilter: "Status",
    ppDetailSectionDetails: "Details",
    ppDetailSectionVerification: "Verification",
    ppDetailSectionDirectory: "Directory",
    ppDetailViewPage: "View place page",
    ppDetailEdit: "Edit",
    ppDetailOwnerEdits: "Its owner edits this place",
    ppDetailAddress: "Address",
    ppDetailListings: "Listings",
    ppDetailListingsUpcoming:
      "{count, plural, one {# upcoming} other {# upcoming}}",
    ppDetailArchivedOn: "Archived",
    ppDetailByModerator: "by a moderator",
    ppDetailArchivedNote:
      "Hidden from place search and the picker. Past listings still show it.",
    ppDetailStateUnverified: "Nobody has checked this place yet.",
    ppDetailStatePending: "A verification request is waiting for review.",
    ppDetailStateVerified: "Verified by staff.",
    ppDetailStateRejected: "Its last verification request was turned down.",
    ppDetailDirectorySwitch: "Shown in the places directory",
    ppDetailArchivePlace: "Archive place",
    ppDetailArchivedToast: "{name} archived.",
    ppDetailRestorePlace: "Restore place",
    ppDetailRestoreConfirmTitle: "Restore {name}?",
    ppDetailRestoreConfirmBody:
      "It comes back to place search and the picker, but not the places directory.",
    ppDetailRestoreConfirmBodyListed:
      "It comes back to place search, the picker and the places directory.",
    ppDetailRestoreConfirmCta: "Restore",
    ppDetailRestoreCancelCta: "Keep archived",
    ppDetailRestoring: "Restoring…",
    ppDetailRestored: "{name} is back.",
    ppDetailRestoreFailed: "Could not restore {name}",
    ppDetailRefusedDuplicate:
      "Can’t restore: another place with this name is active within 50 m.",
    ppDetailOpenActive: "Open the active one",
    ppDetailOpenPlaceFailed: "Couldn’t open that place",
    // ── Platform – Places merge (Merge into…) ────────────────────────────
    ppMergeAction: "Merge into…",
    ppMergeTitle: "Merge {name} into another place",
    ppMergePickLabel: "Place that stays",
    ppMergePickHint: "Search for the place to keep.",
    ppMergeStays: "Stays",
    ppMergeRemoved: "Removed",
    ppMergeNoPage: "No page",
    ppMergeKeepInstead: "Keep {name} instead",
    ppMergePickAgain: "Pick another place",
    ppMergeLoading: "Checking what moves…",
    ppMergePreviewFailed: "Couldn’t check this merge.",
    ppMergeCheckAgain: "Check again",
    ppMergeSectionBlockers: "Can’t merge yet",
    ppMergeSectionWarnings: "Before you merge",
    ppMergeSectionMoves: "Moves to {name}",
    ppMergeNothingMoves:
      "Nothing moves.",
    ppMergeSectionDropped: "Not carried over",
    ppMergeSectionFilled: "Filled from {name}",
    ppMergeSectionRenames: "Renamed",
    ppMergeRenameLine: "{kind}: {from} → {to}",
    ppMergeRenameCalendar: "Calendar",
    ppMergeRenameSpace: "Space",
    ppMergeRenameSeatMap: "Seat map",
    ppMergeFinalRedirect:
      "This can\u2019t be undone. {merged} will be deleted and its page will send visitors to {survivor}.",
    ppMergeFinalTransfer:
      "This can\u2019t be undone. {merged} will be deleted and its page will become {survivor}\u2019s.",
    ppMergeFinalNone:
      "This can\u2019t be undone. {merged} will be deleted.",
    ppMergeConfirmCta: "Merge places",
    ppMergeCancelCta: "Cancel",
    ppMergeMerging: "Merging…",
    ppMergeMerged: "{merged} merged into {survivor}",
    ppMergeRetryError:
      "Another change landed at the same moment, so nothing was merged. Try again.",
    ppMergeBlockedError:
      "Something changed since the check. See what stops the merge above.",
    ppMergeBlockVerificationRequest:
      "{count, plural, one {A verification request is open. Decide it first.} other {# verification requests are open. Decide them first.}}",
    ppMergeBlockVerificationAbove:
      "The place being removed is further along in verification. Keep it instead.",
    ppMergeBlockOwnerConflict:
      "The two places have different owners. Settle ownership first.",
    ppMergeBlockEmbedCollision:
      "{count, plural, one {# embed is} other {# embeds are}} on a site where the other place is already embedded.",
    ppMergeBlockLocationPrivacy:
      "The two places hide their address differently.",
    ppMergeBlockCommunityConsent:
      "{count, plural, one {# community listing relies} other {# community listings rely}} on a yes the place that stays hasn’t given.",
    ppMergeBlockSurvivorNotActive: "The place that stays isn’t active.",
    ppMergeBlockPayoutTerms:
      "{count, plural, one {A default deal differs} other {# default deals differ}} between the two places.",
    ppMergeBlockHoldsOverlap:
      "{count, plural, one {# night is} other {# nights are}} held on both calendars.",
    ppMergeBlockRequestsDuplicate:
      "{count, plural, one {# booking request is} other {# booking requests are}} open at both places from the same person.",
    ppMergeBlockArrivalAreaLimit:
      "The two places have {count} Getting there areas between them, and a place can have {limit}. Remove some first:",
    ppMergeArrivalAreaItem: "{label} ({kind}, {side})",
    ppMergeArrivalAreaKindParking: "parking",
    ppMergeArrivalAreaKindDropOff: "accessible drop-off",
    ppMergeArrivalAreaKindLoadIn: "load-in",
    ppMergeArrivalAreaSideSurvivor: "place that stays",
    ppMergeArrivalAreaSideMerged: "place being removed",
    ppMergeWarnAvailabilityOverlap:
      "{count, plural, one {# availability rule overlaps} other {# availability rules overlap}} with the other place’s.",
    ppMergeWarnPlaceWideAvailability:
      "Place-wide availability will apply to every calendar of the place that stays.",
    ppMergeWarnHoldsSameNight:
      "{count, plural, one {# night has} other {# nights have}} a confirmed show on one side and holds on the other.",
    ppMergeWarnStandardsReplaced:
      "{survivor} keeps its own booking standards and pitch examples; {count, plural, one {# from {merged} is} other {# from {merged} are}} dropped.",
    ppMergeWarnNamesSuffixed:
      "{count, plural, one {# calendar, space or seat map gets} other {# calendars, spaces or seat maps get}} a new name.",
    ppMergeWarnWaiverActive:
      "{merged}\u2019s waiver becomes the active waiver of {survivor}.",
    ppMergeWarnWaiversDeactivated:
      "{count, plural, one {# waiver moves} other {# waivers move}} as inactive; the place that stays keeps its own.",
    ppMergeWarnPayoutDefaults:
      "The owners don\u2019t match, so {count, plural, one {{merged}\u2019s default deal doesn\u2019t} other {{merged}\u2019s # default deals don\u2019t}} carry over.",
    ppMergeWarnGrantsEnded:
      "{count, plural, one {# booking grant ends} other {# booking grants end}}.",
    ppMergeWarnGrantsSplit:
      "{count, plural, one {# whole-place booking grant becomes} other {# whole-place booking grants become}} one per calendar.",
    ppMergeWarnOwnershipTransfers:
      "{count, plural, one {The owner} other {The # owners}} of {merged} will own {survivor}, and take over its {requests, plural, one {# open booking request} other {# open booking requests}} and {agreements, plural, one {# live agreement} other {# live agreements}}.",
    ppMergeWarnEventArrivalAreasOff:
      "{count, plural, one {# Getting there area} other {# Getting there areas}} drawn on moving events {count, plural, one {is} other {are}} not within 3 km of {survivor}\u2019s map pin and will be switched off.",
    ppMergeWarnEventArrivalAreasOffNoPin:
      "{count, plural, one {# Getting there area} other {# Getting there areas}} drawn on moving events will be switched off because {survivor} has no map pin.",
    ppMergeWarnMergedAreasBecomePublic:
      "{merged} isn\u2019t active, so its place page hides its Getting there areas. On {survivor} anyone will see {count} of them.",
    ppMergeMoveEvents: "Events",
    ppMergeMoveConfirmedEvents:
      "of which the place confirmed",
    ppMergeMoveAttendeeReviews: "Attendee reviews",
    ppMergeMoveReviewPrompts: "Review prompts",
    ppMergeMoveBenefits: "Membership benefits",
    ppMergeMoveSavedLocations: "Saved locations",
    ppMergeMovePlaceReviews: "Place reviews",
    ppMergeMoveReviewSessions: "Review sessions",
    ppMergeMoveVolunteerAsks: "Volunteer asks",
    ppMergeMoveReports: "Reports",
    ppMergeMoveFeatured: "Featured spots",
    ppMergeMoveEmbeds: "Embeds",
    ppMergeMoveVerificationRequests: "Verification requests",
    ppMergeMoveFollows: "Followers",
    ppMergeMoveEventNotices: "Event notices",
    ppMergeMoveOldAddresses: "Old page addresses",
    ppMergeMoveOwners: "Owners",
    ppMergeMoveBookingRequests: "Booking requests",
    ppMergeMoveAgreements: "Agreements",
    ppMergeMoveGrants: "Booking grants",
    ppMergeMoveWaivers: "Waivers",
    ppMergeMoveCardReaders: "Card readers",
    ppMergeMoveSeatMaps: "Seat maps",
    ppMergeMoveAvailability: "Availability rules",
    ppMergeMoveHolds: "Holds",
    ppMergeMoveCalendars: "Calendars",
    ppMergeMoveSpaces: "Spaces",
    ppMergeMoveStandards: "Booking standards",
    ppMergeMovePitchExamples: "Pitch examples",
    ppMergeMoveSeries: "Series",
    ppMergeMoveTemplates: "Event templates",
    ppMergeMoveOccurrences: "Series dates",
    ppMergeMoveGrantsSplit: "Booking grants split per calendar",
    ppMergeMoveImageRecords: "Image moderation records",
    ppMergeMoveArrivalAreas: "Getting there areas",
    ppMergeNoteCalendarFolded:
      "Its main calendar and space join the other place’s.",
    ppMergeDropReviewSessions:
      "Review sessions {name} already has",
    ppMergeDropReports:
      "Open reports from people who already reported {name}",
    ppMergeDropFeatured:
      "Featured spots ({name} is already featured)",
    ppMergeDropFollows:
      "Follows from people who already follow {name}",
    ppMergeDropEventNotices:
      "Event notices {name} already has",
    ppMergeDropOwners:
      "Owner records {name} already has (duplicates)",
    ppMergeDropStandards:
      "Booking standards ({name} keeps its own)",
    ppMergeDropPitchExamples:
      "Pitch examples ({name} keeps its own)",
    ppMergeDropGrantsEnded: "Booking grants ended",
    ppMergeFillAddress: "Address",
    ppMergeFillCapacity: "Capacity",
    ppMergeFillPhone: "Phone",
    ppMergeFillLocationLabel: "Location label",
    ppMergeFillWebsite: "Website",
    ppMergeFillDefaultDeals: "Default deals",

    // ── Platform – Places lookup (queue tab) ─────────────────────────────
    ppLookupPlaceholder: "Find a place by name or slug",
    ppLookupHint: "Search any place by name or slug to review or waive it.",
    ppLookupNoResults: "No places match “{query}”",

    // ── Platform – Places CSV Import ─────────────────────────────────────
    ppImportCsv: "Import CSV",
    ppImportTitle: "Import Places",
    ppImportDescription:
      "Bulk-import places from a CSV file. Imported places will be unverified and listed in the public directory.",
    ppImportSuccess:
      "Imported {imported} of {total} places ({skipped} skipped).",
    ppReindexSearch: "Reindex Search",
    ppReindexQueued: "Search reindex started.",
    ppReindexFailed: "Failed to start reindex.",

    // ── Platform – Review Moderation ─────────────────────────────────────
    navPlatformReviews: "Reviews",
    navPlatformReports: "Reports",
    navPlatformInvitePauses: "Invite pauses",
    rmTitle: "Review Moderation",
    rmSubtitle: "Monitor, flag, and hide place reviews across the platform.",
    rmSearchPlaceholder: "Filter by place name...",
    rmRefresh: "Refresh",
    rmFilterAll: "All",
    rmFilterFlagged: "Flagged",
    rmFilterHidden: "Hidden",
    rmFilterVisible: "Visible",
    rmReviewCount: "{count, plural, one {# review} other {# reviews}}",
    rmVenue: "Place",
    rmReviewer: "Reviewer",
    rmComment: "Comment",
    rmStatus: "Status",
    rmDate: "Date",
    rmFlagged: "Flagged",
    rmHidden: "Hidden",
    rmVisible: "OK",
    rmHide: "Hide",
    rmUnhide: "Unhide",
    rmNoReviews: "No reviews match the current filter.",
    rmAdjustFilter: "Try a different filter or search.",
    rmFailedToLoad: "Failed to load reviews: {error}",
    rmRetry: "Retry",
    rmFlagReason: "Flag reason: {reason}",
    rmNoComment: "No comment",
    rmAnonymous: "Anonymous",
    rmDetailTitle: "Review Details",
    rmDetailPayment: "Payment",
    rmDetailPaymentMethod: "Payment method",
    rmDetailPaymentDetail: "Payment notes",
    rmDetailPayout: "Payout",
    rmDetailPromotion: "Promotion",
    rmDetailPromotionLevel: "Promotion level",
    rmDetailPromotionDetail: "Promotion notes",
    rmDetailSound: "Sound",
    rmDetailSoundQuality: "Sound quality",
    rmDetailSoundDetail: "Sound notes",
    rmDetailStageEquipment: "Stage & Equipment",
    rmDetailStageEquipmentRating: "Equipment rating",
    rmDetailStageEquipmentDetail: "Equipment notes",
    rmDetailAudience: "Audience",
    rmDetailAudienceFit: "Audience fit",
    rmDetailAudienceDetail: "Audience notes",
    rmDetailBooker: "Booker",
    rmDetailBookerRating: "Booker rating",
    rmDetailBookerDetail: "Booker notes",
    rmDetailParking: "Parking & Load-in",
    rmDetailParkingRating: "Parking rating",
    rmDetailParkingDetail: "Parking notes",
    rmDetailGeneral: "General",
    rmDetailWouldPlayAgain: "Would play again",
    rmDetailEstimatedDraw: "Estimated draw",
    rmDetailGenre: "Genre",
    rmDetailSource: "Source",
    rmDetailComment: "Comment",
    rmDetailResponse: "Place Response",
    rmDetailRespondedAt: "Responded",
    rmDetailNoResponse: "No response yet",
    rmDetailSubmitted: "Submitted",
    rmDetailNone: "—",
    rmReassignPlace: "Reassign Place",
    rmReassignPlaceholder: "Search places...",
    rmReassignConfirm: "Move to this place",
    rmReassignSuccess: "Review moved to {placeName}",
    rmReassignFailed: "Failed to reassign review",
    rmReassignCurrentVenue: "Current place",

    // ── Platform – Categories ───────────────────────────────────────────
    pcTitle: "Categories",
    pcSubtitle:
      "Review organizer taxonomy requests and keep event discovery clean.",
    pcOverviewTitle: "Taxonomy overview",
    pcOverviewSubtitle: "Active categories and their event types.",
    pcLoadingTaxonomy: "Loading taxonomy...",
    pcTaxonomyFailed: "Failed to load taxonomy: {error}",
    pcNoCategories: "No categories are active yet.",
    pcNoEventTypes: "No sub-categories yet.",
    pcActive: "Active",
    pcInactive: "Inactive",
    pcQueueTitle: "Request review queue",
    pcQueueSubtitle:
      "Approve new categories or reject suggestions that would fragment discovery.",
    pcStatusFilter: "Status",
    pcKindFilter: "Kind",
    pcStatusPending: "Pending",
    pcStatusApproved: "Approved",
    pcStatusRejected: "Rejected",
    pcKindAll: "All",
    pcKindCategory: "Category",
    pcKindEventType: "Sub-category",
    pcLoadingRequests: "Loading requests...",
    pcFailedToLoad: "Failed to load requests: {error}",
    pcNoRequestsTitle: "No requests match these filters.",
    pcNoRequestsDesc:
      "When organizers ask for missing categories or sub-categories, those requests will land here.",
    pcRequestCount: "{count, plural, one {# request} other {# requests}}",
    pcRefresh: "Refresh",
    pcRetry: "Retry",
    pcSlug: "Slug",
    pcScopedCategory: "Category scope",
    pcCreated: "Created",
    pcReviewNote: "Review note",
    pcNoReviewNote: "No note",
    pcUnscoped: "Top-level",
    pcNotePlaceholder: "Review note (optional)",
    pcApprove: "Approve",
    pcReject: "Reject",
    pcReadOnlyPending: "Read-only: approval requires reviewer access.",
    pcApprovedToast: "Request approved",
    pcRejectedToast: "Request rejected",
    pcReviewFailed: "Review failed",
    pcDelete: "Delete",
    pcDeleting: "Deleting...",
    pcConfirmDelete: "Delete “{name}”?",
    pcConfirmDeleteDescription:
      "Events currently in this category will fall back to uncategorized. This cannot be undone.",
    pcConfirmDeleteCta: "Delete category",
    pcCancel: "Cancel",
    pcDeletedToast: "Category deleted",
    pcDeleteFailed: "Delete failed",
    pcDeleteForbidden:
      "Read-only: deleting categories requires ADMIN or DEVELOPER access.",
    // Create form on /platform/categories (ADMIN / DEVELOPER only).
    pcAddFormLabel: "Add a category",
    pcAddSeoTypeLabel: "SEO type",
    pcAddSubmit: "Add category",
    pcAdding: "Adding...",
    pcAddedToast: "Category added",
    pcAddedToastMessage: "{name} ({slug})",
    pcAddedToastMessageWithRequests:
      "{name} ({slug}). {count, plural, one {The matching request was approved.} other {# matching requests were approved.}}",
    pcAddFailed: "Could not add the category",
    pcAddErrorExists:
      "A category with this name, or one very close to it, already exists. Use a different name.",
    pcAddErrorInvalidName:
      "Use 2 to 40 characters with at least two Latin letters or numbers. Only letters, numbers, spaces and & ' + - are allowed.",
    pcSeoTypeFor: "SEO type for {name}",
    // Category lifecycle on /platform/categories (ADMIN / DEVELOPER only).
    pcOverviewSubtitleAll:
      "Every category, active or inactive, in display order.",
    pcNameEnLabel: "English name",
    pcNameEsLabel: "Spanish name",
    pcNameMissing: "Not set",
    pcLanguageEn: "English",
    pcLanguageEs: "Spanish",
    pcSuggested: "Suggested",
    pcTranslate: "Translate",
    pcTranslateTo: "Translate to {language} in Google Translate (opens in a new tab)",
    pcTranslationErrorExists: "Another category already uses that {language} name.",
    pcEnglishNameRequired: "Add the English name to approve.",
    pcRequestLanguage: "Language",
    pcApproveNamed: "Approve {name}",
    pcNamesSavedToast: "Names saved",
    pcNamesSaveFailed: "Could not save the names",
    pcTranslationErrorInvalid: "Use 2 to 80 characters: letters, numbers, spaces and & ' + -.",
    pcEnglishSavedOtherNotToast: "The English name was saved, the {language} name was not",
    pcRequestLanguageEn: "English",
    pcRequestLanguageEs: "Spanish",
    pcEditNames: "Edit names",
    pcEditNamesNamed: "Edit names for {name}",
    pcSlugFromEnglishName: "From the English name",
    pcRenameSlugNote: "The URL ({slug}) stays the same.",
    pcRenameSave: "Save",
    pcRenameSaving: "Saving...",
    pcRenamedToast: "Category renamed",
    pcRenameFailed: "Could not rename the category",
    pcDeactivate: "Deactivate",
    pcDeactivateNamed: "Deactivate {name}",
    pcReactivate: "Reactivate",
    pcReactivateNamed: "Reactivate {name}",
    pcConfirmDeactivate: "Deactivate “{name}”?",
    pcConfirmDeactivateDescription:
      "It is hidden from category pickers, filters and category browse on the home page, its public page shows not found and it leaves the sitemap. Events already in it keep it. You can reactivate it at any time.",
    pcConfirmDeactivateCta: "Deactivate category",
    pcDeactivatedToast: "Category deactivated",
    pcReactivatedToast: "Category reactivated",
    pcSetActiveFailed: "Could not change the category",
    pcMoveUpNamed: "Move {name} up",
    pcMoveDownNamed: "Move {name} down",
    pcMovedAnnouncement: "{name} moved to position {position} of {total}",
    pcMoveFailed: "Could not move the category",
    pcListChangedToast: "The category list changed",
    pcListChangedToastMessage: "It has been reloaded. Try again.",
    pcDeleteNamed: "Delete {name}",
    pcNoCategoriesYet: "No categories yet.",
    pcLanguageLabel: "Language",
    pcLanguageFor: "Language for {name}",
    pcNameLabel: "Name",
    pcUrlLabel: "URL",
    pcRedirectsHere: "Redirects here",
    pcNotInSearchUntilNamed: "Not in search engines until it has a {language} name.",
    pcChangeUrl: "Change URL",
    pcChangeUrlNamed: "Change {language} URL for {name}",
    pcNewUrlLabel: "New URL",
    pcNewUrlNamed: "New {language} URL for {name}",
    pcSaveUrlNamed: "Save {language} URL for {name}",
    pcCancelUrlNamed: "Cancel the {language} URL change for {name}",
    pcUrlKeepsRedirecting: "The old URL keeps redirecting here.",
    pcUrlChangedToast: "URL changed",
    pcUrlChangeFailed: "Could not change the URL",
    pcSuggestionToReview: "{language}: suggested name to review",
    pcSuggestionToReviewNamed: "{language}: suggested name to review, {name}",
    pcStaleEnglishSuggestion: "This suggestion was for an earlier Spanish name. Edit it.",

    // ── Platform – Verification Review Panel ─────────────────────────────
    vrTitle: "Verification Review",
    vrLoading: "Loading verification request...",
    vrNoRequest: "No verification request found for this place.",
    vrPlaceDetails: "Place details",
    vrOwnerCount: "{count, plural, one {# owner} other {# owners}}",
    vrCapacity: "Capacity: {capacity}",
    vrDocuments: "Uploaded documents ({count})",
    vrNoDocuments: "No documents attached.",
    vrView: "View",
    vrDeleted: "Deleted",
    vrPreviewUnavailable: "Preview unavailable",
    vrChecklist: "Reviewer checklist",
    vrChecklistHint:
      "Advisory only. Not all items may apply to every submission.",
    vrCheckBusinessName: "Business name visible and matches group name",
    vrCheckAddress: "Place address visible and matches the place record",
    vrCheckAuthentic: "Document appears authentic (not obviously fabricated)",
    vrNotes: "Reviewer notes",
    vrNotesPlaceholder:
      "Optional notes (visible to the team, saved with the decision)...",
    vrCancel: "Cancel",
    vrProcessing: "Processing...",
    vrReject: "Reject",
    vrApprove: "Approve",
    vrApprovedTitle: "Place approved",
    vrApprovedMessage: "{name} has been verified.",
    vrRejectedTitle: "Place rejected",
    vrRejectedMessage: "{name} has been rejected.",
    vrDecisionFailed: "Decision failed",
    vrNoAddress: "No address",

    // ── Platform – Verification Review Detail (consolidated) ─────────────
    vrWebsite: "Website",
    vrOwnersOnFile:
      "{count, plural, one {# owner on file} other {# owners on file}}",
    vrSubmittedBy: "Submitted by {name}",
    vrAcknowledgeToReview: "Acknowledge to review",
    vrRelease: "Release",
    vrAcknowledgedToast: "Claimed for review",
    vrReleasedToast: "Lock released",
    vrAcknowledgeFailed: "Could not acknowledge",
    vrReleaseFailed: "Could not release lock",
    vrApproveConfirmTitle: "Approve this place?",
    vrApproveConfirmBody:
      "{name} will be verified and listed in the directory.",
    vrLockedBy: "{name} is reviewing this request",
    vrLockedGeneric: "Another admin is reviewing this request",
    vrRejectNotesRequired: "Rejection notes must be at least 10 characters.",
    vrDecisionBy: "Decided by {name}",

    // ── Platform – Verification Queue (workbench) ────────────────────────
    vqActive: "Active",
    vqReviewed: "Reviewed",
    vqReviewTitle: "Review request",
    vqStatPending: "Pending",
    vqStatInReview: "In review",
    vqStatReviewedMonth: "Reviewed this month",
    vqStatOldestPending: "Oldest pending",
    vqClaimedByYou: "{count} claimed by you",
    vqDocCount: "{count, plural, one {# document} other {# documents}}",
    vqSubmittedBy: "by {name}",
    vqLockedToMe: "Claimed by you",
    vqLockedToOther: "Locked",
    vqEmptyActiveTitle: "Queue is clear",
    vqEmptyActiveBody: "No verification requests are waiting.",
    vqEmptyReviewedTitle: "No review history",
    vqEmptyReviewedBody: "Reviewed requests will appear here.",
    vqSelectPrompt: "Select a request to review.",
    vqStatusPending: "Pending",
    vqStatusInReview: "In review",
    vqStatusApproved: "Approved",
    vqStatusRejected: "Rejected",
    vqStatusWithdrawn: "Withdrawn",

    // Verification queue — request source tags (claim-venue-flow spec)
    vqSourceClaim: "Ownership claim",
    vqSourceDispute: "Ownership dispute",
    vqClaimForOrg: "on behalf of an organization",
    vqClaimForSelf: "for themselves",

    // Theme editor
    teTitle: "Theme Editor",
    teSubtitle: "Edit token values for the {mode} theme.",
    teChangesPending:
      "{count, plural, one {# change} other {# changes}} pending.",
    teResetTitle: "Theme reset",
    teResetMessage: "Restored {mode} defaults",
    teCopiedTitle: "Copied",
    teCopiedMessage: "Theme JSON copied to clipboard",
    teDark: "Dark",
    teLight: "Light",
    teReset: "Reset",
    teCopyJson: "Copy JSON",
    teExport: "Export",
    teLivePreview: "Live Preview",
    teSurfaceCard: "Surface Card",
    teSurfaceCardDesc: "Muted helper text on a card surface",
    teMutedSurface: "Muted Surface",
    teMutedSurfaceDesc: "Secondary panel content",
    teStrongBg: "Strong Background",
    teStrongBgDesc: "Headers and hero areas",
    teButtons: "Buttons",
    tePrimary: "Primary",
    teOutlined: "Outlined",
    teDestructive: "Destructive",
    teAccentsBorders: "Accents & Borders",
    teStatus: "Status",
    teChanged: "changed",
    // Theme presets
    tePresetLabel: "Preset",
    tePresetDefault: "Default (Dark)",
    tePresetCustomSection: "Custom",
    tePresetBuiltInSection: "Seasonal",
    teSavePreset: "Save as Preset",
    teSavePresetTitle: "Preset saved",
    teSavePresetMessage: '"{name}" has been saved.',
    teActivate: "Activate",
    teActivateTitle: "Theme activated",
    teActivateMessage: '"{name}" is now the live theme.',
    teDeactivate: "Deactivate",
    teDeactivateTitle: "Theme deactivated",
    teDeactivateMessage: "Reverted to the default dark theme.",
    teDeletePreset: "Delete",
    teDeletePresetTitle: "Preset deleted",
    teDeletePresetMessage: '"{name}" has been removed.',
    teSavePresetSlug: "Slug (URL-safe)",
    teSavePresetName: "Name",
    teSavePresetCancel: "Cancel",
    teSavePresetConfirm: "Save",
    teActiveTag: "Active",
    teBuiltInTag: "Built-in",
    // PlacePicker (component)
    pckSelectPlace: "Select a place",
    pckClearSelection: "Clear place selection",
    pckSearchPlaces: "Search your places...",
    pckLoading: "Loading...",
    pckNoPlacesFound: "No places found",
    pckNoPlacesYet: "No places yet",
    pckAddPlacesHint: "Add places in the Places section first.",
    pckCreatePlace: "Create a place",
    pckManagePlaces: "Manage places",
    // LocationPinInput
    lpiSearchAddress: "Search address",
    lpiSearchPlaceholder: "Search for a place or address",
    lpiDropPin: "Drop pin on map",
    lpiPanHint: "Pan the map to position the pin at the desired location.",
    lpiManualCoords: "Or enter coordinates manually",
    lpiLatitude: "Latitude",
    lpiLongitude: "Longitude",
    lpiApply: "Apply",
    lpiLocationLabel: "Location label",
    lpiLabelPlaceholder: "e.g., Main Stage or 123 Main St",
    lpiLabelHint: "A friendly name for this location (shown to attendees)",
    lpiCoordinates: "Coordinates",
    lpiNotSet: "Not set",
    lpiLat: "Lat",
    lpiLng: "Lng",
    lpiSaveAsPlace: "Save this as a reusable place",
    lpiNewPlace: "New Place",
    loadingEventBuilder: "Loading event builder\u2026",
    eventBuilderLoadErrorTitle: "Couldn\u2019t load the event builder",
    eventBuilderLoadErrorDescription:
      "Something went wrong while loading this event. This is usually temporary \u2014 try again.",
    eventBuilderRetry: "Retry",
    eventBuilderRetrying: "Retrying\u2026",
    eventBuilderNoAccessTitle: "You don\u2019t have access",
    eventBuilderNoAccessDescription:
      "This event isn\u2019t available on this account, or you don\u2019t have permission to view it.",
    eventBuilderBackToAdmin: "Back to admin",
    // CoordinatesSelectorMap
    mapPickerUnavailable: "Map picker unavailable",
    mapPanHint: "Pan the map to set location",
    // LocationAutocomplete
    lacLocation: "Location",
    lacNoMatches:
      "No matching locations yet. Try a different city or neighborhood.",
    lacSearching: "Searching locations…",
    lacSearchError:
      "Location search is unavailable right now. Try again in a moment.",
    lacKeepTyping: "Keep typing to search (minimum 2 characters).",
    // ── Address privacy control (place-address-withholding) ────────────
    // ONE component (components/places/PlaceLocationPrivacyFields) renders
    // this on the admin place editor and in the admin "New place" dialog
    // (NewPlaceDialog), so the two surfaces cannot drift into describing the same setting
    // differently.
    placePrivacyHeading: "Address privacy",
    placePrivacyHint: "How much of this place's location is public.",
    /**
     * Replaces the hint on the create surfaces. New venues start with the
     * address SHOWN (ruled 2026-09-17), so the protection for a home is this
     * question, asked while the venue is being created.
     */
    placePrivacyNewPlacePrompt:
      "Is this someone's home? You can hide the address.",
    placePrivacyGroupAria: "How much of this place's location is public",
    placePrivacyExact: "Exact address",
    placePrivacyExactDesc: "The full address and a map pin are public.",
    placePrivacyApprox: "Approximate area",
    placePrivacyApproxDesc: "A circle on the map. No street address anywhere.",
    placePrivacyHidden: "Address withheld",
    placePrivacyHiddenDesc: "No map and no address. Just the area name.",
    placePrivacyRadiusLabel: "Circle size",
    placePrivacyRadiusAria: "Approximate-area circle radius",
    placePrivacyAreaLabel: "Area name",
    placePrivacyAreaPlaceholder: "East Nashville",
    placePrivacyAreaHelper:
      "Public. Anyone can see it wherever the address would be, so name an area, not a street. Leave it empty to use the city.",
    /**
     * Shown under the choices while the address is withheld. Withholding
     * covers the address and the map only; free text is published as typed.
     */
    placePrivacyFreeTextWarning:
      "Don't name the street in your bio, area name, house rules or event descriptions \u2014 those are shown as written.",
    placePrivacyPreviewExact: "Visitors see the full address and a pin.",
    placePrivacyPreviewApprox:
      "Visitors see a circle of about {distance}, and no address.",
    placePrivacyPreviewHidden: "Visitors see {area}, and nothing else.",
    /** Fallback for the preview line when no area name resolves yet. */
    placePrivacyPreviewHiddenNoArea:
      "Visitors see no map and no address. Add an area name so they know roughly where you are.",
    /**
     * The ceiling, stated where the decision is made. Withholding a venue's
     * address also clamps every event at it — including events other people
     * create — and an organizer who learns that later has already published.
     */
    placePrivacyCeiling:
      "Events at this place can't publish an address either, whatever they pick.",
    /** Marker in the venues table for a row whose address this viewer can't see. */
    placesAddressWithheld: "Address withheld",

    // ── Platform – Featured Items ────────────────────────────────────────
    navPlatformFeatured: "Featured",
    featuredPageTitle: "Featured Items",
    featuredPageSubtitle:
      "Curate which events, artists, groups, and places appear in the homepage hero carousel.",
    featuredAddTitle: "Add Featured Item",
    featuredLoading: "Loading...",
    featuredItemType: "Item Type",
    featuredItemId: "Item ID",
    featuredUuidPlaceholder: "UUID",
    featuredTitle: "Display Title",
    featuredSubtitle: "Subtitle",
    featuredHeroImage: "Hero Image URL",
    featuredHeroImagePathHint:
      "Use an internal asset path like /images/featured/homepage-hero.jpg.",
    featuredCtaUrl: "CTA Link",
    featuredCtaPathHint: "Use an internal route like /events/example-event.",
    featuredCtaPathHintEvent: "Use /events/your-event-slug.",
    featuredCtaPathHintHuman: "Use /p/your-profile-slug.",
    featuredCtaPathHintOrg: "Use /p/your-org-page-slug.",
    featuredCtaPathHintPlace: "Use /p/your-place-page-slug.",
    featuredCtaLabel: "CTA Label",
    featuredSortOrder: "Sort Order",
    featuredActive: "Active",
    featuredCuratedUntil: "Expires",
    featuredNotes: "Notes",
    featuredSubmit: "Add / Update",
    featuredRemove: "Remove",
    featuredCancel: "Cancel",
    featuredRemoveConfirm: "Remove this featured item?",
    featuredUntitled: "Untitled",
    featuredStatusOn: "ON",
    featuredStatusOff: "OFF",
    featuredEmpty: "No featured items yet. Add one above.",
    featuredLoadError: "Unable to load featured items right now.",
    featuredTypeBadgeEvent: "Event",
    featuredTypeBadgeHuman: "Artist",
    featuredTypeBadgeOrg: "Group",
    featuredTypeBadgePlace: "Place",

    // ── Booking requests (performer → venue) ──────────────────────────
    bkCtaSignInNote: "Sign in",
    bkSenderSelf: "Yourself",
    bkSenderOrgFallback: "Group",
    bkPerformerModeRequiredTitle: "Performer mode required",
    bkPerformerModeRequiredBody:
      "Turn on performer mode to send booking requests to places. You can turn it off anytime — your data is kept.",
    bkPerformerModeOrgHint:
      "Booking for a band or group? A group admin can turn on performer mode in the group's settings.",
    bkEnablePerformerMode: "Turn on performer mode",
    bkEnablePerformerModeFailed:
      "Couldn't turn on performer mode. Please try again.",
    bkFormSenderLabel: "Send as",
    bkFormMessageLabel: "Message",
    bkFormMessagePlaceholder: "Introduce yourself and your act…",
    bkFormMessageHint: "At least 10 characters.",
    bkFormDatesLabel: "Preferred dates",
    bkFormAddDate: "Add date",
    bkFormRemoveDate: "Remove date",
    bkFormDrawLabel: "Expected draw",
    bkFormDrawHint: "How many people you expect to bring.",
    bkFormGenreLabel: "Genre",
    bkFormGenrePlaceholder: "Uses your profile genres if left blank",
    bkFormLinksLabel: "Links",
    bkFormAddLink: "Add link",
    bkFormRemoveLink: "Remove link",
    bkFormOptional: "Optional",
    bkFormUnspecified: "—",
    bkFormSectionAct: "Your act",
    bkFormSectionPitch: "The pitch",
    bkFormSectionPerformance: "Performance",
    bkFormSectionFee: "Fee",
    bkFormSectionLinks: "Links",
    bkFormActNameLabel: "Act / band name",
    bkFormActNamePlaceholder: "e.g. The Wandering Echoes",
    bkFormLineupLabel: "Lineup size",
    bkFormPhoneLabel: "Contact phone",
    bkFormPhonePlaceholder: "+1 555 123 4567",
    bkFormSetLengthLabel: "Set length",
    bkFormTechNeedsLabel: "Tech & backline needs",
    bkFormTechNeedsPlaceholder: "PA, backline, inputs, stage plot…",
    bkFormFeeTypeLabel: "Fee type",
    bkFormFeeAmountLabel: "Fee amount",
    bkFeeTypeGUARANTEE: "Guarantee",
    bkFeeTypeDOOR_SPLIT: "Door split",
    bkFeeTypeNEGOTIABLE: "Negotiable",
    bkFormLinkMusicLabel: "Music / streaming",
    bkFormLinkVideoLabel: "Video",
    bkFormLinkSocialLabel: "Social",
    bkFormLinkEpkLabel: "EPK / press kit",
    bkFormIncludeStatsLabel:
      "Include my verified platform stats (draw, repeat fans) — shown to the place with this request",
    bkFormIncludeStatsHint:
      "Shared only with this place. Separate from your public page's stats block — this doesn't make it public.",
    bkFormPrefillNote:
      "Prefilled from your saved booking defaults — edit anything before sending.",
    // FR-008 compact stats line (anonymized snapshot; parts joined with "·").
    bkStatsLineReviewed: "{count} performers have reviewed this place",
    bkStatsLinePlayAgain: "{pct}% would play again",
    bkStatsLineMedianPayout: "median reported payout {amount}",
    // The DOOR clause (FR-014): checked-in band, never tickets sold. Written
    // lowercase like its siblings; the component capitalises whichever
    // clause opens the sentence.
    bkStatsLineAttendanceUnder25: "usually under 25 people checked in",
    bkStatsLineAttendance25To100: "usually 25–100 people checked in",
    bkStatsLineAttendance100To300: "usually 100–300 people checked in",
    bkStatsLineAttendanceOver300: "usually 300+ people checked in",
    bkFormSubmit: "Send request",
    bkFormSubmitting: "Sending…",
    bkSuccessTitle: "Request sent to {place}",
    bkSuccessBody:
      "The place will review it. You can track or withdraw it from your account settings.",
    bkErrMessageTooShort:
      "Please write a short message (at least 10 characters).",
    bkErrDates: "Pick at least one preferred date.",
    bkErrDraw: "Expected draw must be a whole number above zero.",
    bkErrLinkInvalid: "Links must be full URLs starting with http(s)://.",
    bkErrActName: "Act name is too long (max 120 characters).",
    bkErrLineup: "Lineup size must be a whole number between 1 and 100.",
    bkErrSetLength: "Choose a set length from the list.",
    bkErrPhone: "Enter a valid phone number.",
    bkErrTechNeeds: "Tech needs are too long (max 2000 characters).",
    bkErrFeeAmount: "Enter a valid fee amount above zero.",
    bkErrDuplicate: "You already have an open request with this place.",
    bkErrPerformerMode: "Performer mode is required to send booking requests.",
    bkErrNotAccepting: "This place isn't accepting booking requests right now.",
    bkErrForbidden: "You don't have permission to send as this performer.",
    bkErrGeneric: "Couldn't send the request. Please try again.",
    // P5-F1 (bill)
    // "The bill" inside the PERFORM pitch (lineup-booking-requests v3, board
    // F1). Words: Joined / Invited / By name; a tagged act in the form "will be
    // asked to join", it has not joined. Role names reuse admin.ebLineupRole*.
    bkBillHeading: "The bill",
    bkBillSelfLabel: "I'm on the bill",
    bkBillSelfHint: "Your own act is listed first.",
    bkBillSelfNeedsPerformerMode:
      "Turn on performer mode to put your own act on the bill.",
    bkBillHeadlining: "Headlining",
    bkBillSourceSelf: "You",
    bkBillSourceTagged: "On Ithas Fire · Will be asked to join",
    bkBillSourceExternal: "By name",
    bkBillEmpty:
      "No acts yet. The bill is optional: leave it empty and the request goes out from you alone.",
    bkBillMoveUp: "Move {name} up",
    bkBillMoveDown: "Move {name} down",
    bkBillRemove: "Remove {name}",
    bkBillAddHeading: "Add an act",
    bkBillNameLabel: "Name",
    bkBillNamePlaceholder: "Search or type a name",
    bkBillLinkLabel: "Link",
    bkBillRoleLabel: "Role",
    bkBillRoleNameLabel: "Role name",
    bkBillRoleNamePlaceholder: "e.g. Stage manager",
    bkBillAddButton: "Add to the bill",
    bkBillCount:
      "{count, plural, one {# act} other {# acts}} · Up to {max}",
    bkBillFull: "The bill is full. Remove an act to add another.",
    bkBillResultPerson: "Person",
    bkBillResultGroup: "Group",
    bkBillSearchLoading: "Searching…",
    bkBillSearchNoResults:
      "No one on Ithas Fire matches that name. Add it by name instead.",
    bkBillSearchError:
      "Search isn't working right now. You can still add the act by name.",
    bkBillAdded: "{name} added to the bill.",
    bkBillRemoved: "{name} removed from the bill.",
    bkBillMoved: "{name} moved to position {position}.",
    bkBillErrName: "Enter a name, or pick an act from the search.",
    bkBillErrLink: "The link must be a full URL starting with http:// or https://.",
    bkBillErrDuplicate: "That act is already on the bill.",
    bkBillErrSelf:
      "You're sending this request. Use I'm on the bill to put your own act on it.",
    bkErrBillTooLong: "A bill holds up to {max} acts, yours included.",
    bkErrBillActInvalid:
      "One of the acts on the bill has a name, link or role that needs fixing.",
    bkErrBillPerformerMode:
      "Turn on performer mode to put your own act on the bill, or take yourself off it.",
    bkErrBillNotTaggable:
      "One of the acts you tagged can't be invited. Remove it and add it by name instead.",
    bkErrBillDuplicate: "The same act is on the bill twice. Remove one of them.",
    bkErrBillSelfTag:
      "You tagged yourself. Remove that act and use I'm on the bill instead.",
    bkErrBillNotAllowed: "Only a request to play can carry a bill.",
    bkErrBillTagBudget:
      "You've invited as many acts as you can today. Add the rest by name, or send the request tomorrow.",
    bkBillSenderGone:
      "The identity you were sending as is no longer available. Pick who to send as.",
    bkBillRowIsSender:
      "This is who you're sending as. Remove it, or use I'm on the bill.",
    bkPanelLoadError:
      "Couldn't load the booking form. Check your connection and try again.",
    bkPanelLoadRetry: "Try again",
    // end P5-F1 (bill)
    // P5-S1S2T1 (standards rail + outline)
    // venue-booking-standards FR-005 / FR-010 / FR-011, boards S1 + S2
    // (combined) and T1. The place's own wording fills {item} / {hint};
    // these keys are only the frame around it. "Place", never "venue".
    bkStdRailTitle: "What {place} expects",
    bkStdRailTitleNoName: "What this place expects",
    bkStdForCalendar: "For {calendar}",
    bkStdProgress: "{done} of {total} done",
    bkStdFoldOneRequired: "{done} of {total} done · {item} is required",
    bkStdFoldManyRequired:
      "{done} of {total} done · {count} required items still missing",
    bkStdFoldNotesOnly:
      "{count, plural, one {# note} other {# notes}} to read before you send",
    bkStdMarkerRequired: "Required",
    bkStdMarkerSuggested: "Suggested",
    bkStdMarkerDone: "Done",
    bkStdMarkerRequiredDone: "Required · done",
    bkStdMarkerSuggestedDone: "Suggested · done",
    bkStdFromPlace: "From {place}",
    bkStdFromPlaceNoName: "From this place",
    bkStdSeeExample: "See an example pitch",
    bkStdExamplesHeading: "Example pitches",
    bkStdExampleFromPlatform: "From Ithas Fire",
    bkStdFieldRequired: "{place} needs this: {item}.",
    bkStdFieldRequiredNoName: "This place needs this: {item}.",
    bkStdFieldSuggested: "{item}.",
    bkStdFieldSuggestedHint: "{item}: {hint}",
    bkStdUnmetSummary: "Add what {place} needs before you send: {items}.",
    bkStdUnmetSummaryNoName:
      "Add what this place needs before you send: {items}.",
    bkErrStandardsUnmet:
      "This place asks for a few things in every pitch. Add what's missing and send again.",
    bkStdOutlineButton: "Start from an outline",
    bkStdOutlineHint: "Replace each [bracket] with your own words.",
    bkStdOutlineLeft:
      "{count, plural, one {# bracket left} other {# brackets left}}",
    // end P5-S1S2T1 (standards rail + outline)
    // ── Intents (venue-confirmation-and-booking-intents spec, 2026-08-27).
    // Public verbs are the spec's: Play here / Rent a space / Use a space.
    // The RENT/USE variant: calendar → space → window → what it is → contact.
    bkIntentLabel: "What are you asking for?",
    bkIntentPerform: "Play here",
    bkIntentRent: "Rent a space",
    bkIntentUse: "Use a space",
    bkFormCalendarLabel: "Calendar",
    // The room is chosen at accept/confirm on the draft event, so the RENT /
    // USE form PRINTS the calendar's rooms instead of picking one (owner
    // ruling, extending the hold picker's — see HoldDatePicker.tsx).
    // `bkFormSpaceLabel`, `bkFormSpacePlaceholder` and `bkErrSpace` below now
    // have no callers and can be swept.
    bkFormSpaceLabel: "Space",
    bkFormSpacePlaceholder: "Choose a space",
    bkFormRooms: "Rooms: {rooms}",
    bkFormRoomsHint: "The place picks the room when it accepts.",
    // Heads the calendar / rooms / rate group on the RENT-USE form. Renamed
    // from "The space" on 2026-09-22: the section no longer holds a room
    // choice, so the old heading named the one thing that isn't in it.
    bkFormSectionSpace: "The calendar",
    bkFormSectionWhen: "When",
    bkFormSectionWhat: "What it's for",
    bkFormSectionContact: "Contact",
    bkFormDateLabel: "Date",
    bkFormStartLabel: "Start",
    bkFormEndLabel: "End",
    bkFormWindowHint: "Times are the place's local time.",
    bkFormEndsNextDay: "Ends the next day.",
    bkFormPurposeLabel: "What is it",
    bkFormPurposePlaceholder:
      "One line — e.g. album release party, weekly reading group",
    bkFormAttendanceLabel: "Expected attendance",
    bkFormRentalRate: "Rent: {rate} per booking",
    bkFormRentalRateHint: "Paid to the place directly if they confirm.",
    bkErrSpace: "Choose a space.",
    bkErrWindow: "Pick a date with a start and end time.",
    bkErrWindowOrder: "The end time must be after the start.",
    bkErrPurpose: "Say what it is, in one line (up to 200 characters).",
    bkErrAttendance: "Expected attendance must be a whole number above zero.",
    bkErrCalendarRejectsIntent:
      "This calendar doesn't take that kind of request. Pick another calendar.",
    bkErrSpaceNotOnCalendar:
      "That space isn't on this calendar. Pick another space.",
    bkSuccessBodyRent:
      "The place will review your rental request. You can track or withdraw it from your account settings.",
    bkStatusPending: "Pending",
    bkStatusViewed: "Viewed",
    bkStatusAccepted: "Accepted",
    bkStatusDeclined: "Declined",
    bkStatusWithdrawn: "Withdrawn",
    bkStatusExpired: "Expired",
    // ── Booking STAGE rail (request → agreement → event) ───────────────
    // The list row used to compress the whole arc into one chip reading
    // "Pending" — a word about the REQUEST only. These name the three legs and
    // the state of each, and the request leg deliberately reuses the
    // `bkStatus*` words above: the rail ABSORBS the status chip rather than
    // repeating it.
    bkStageRequest: "Request",
    bkStageAgreement: "Agreement",
    bkStageEvent: "Event",
    // A leg the booking has not got to. Two words, because "not yet" is a
    // promise and a declined booking must not make one.
    bkStageNotYet: "Not yet",
    bkStageNotReached: "Never reached",
    // Forward-compatible fallback: a status this build has never heard of
    // exists, so say so plainly and never guess whether it is good news.
    bkStageUnknownState: "In progress",
    // Agreement leg. Only DRAFT / PROPOSED / ACCEPTED / DECLINED are ever
    // written today; the rest of the enum is handled so a future row cannot
    // crash an inbox, NOT designed around.
    bkStageAgrDraft: "Draft",
    bkStageAgrProposed: "Out for review",
    bkStageAgrCountered: "Countered",
    bkStageAgrAccepted: "Terms agreed",
    bkStageAgrFulfilled: "Fulfilled",
    bkStageAgrDeclined: "Declined",
    bkStageAgrCancelled: "Cancelled",
    bkStageAgrExpired: "Expired",
    bkStageAgrDisputed: "Disputed",
    // Event leg reuses `admin.eventStatus*`. This pairs it with the booked
    // date for the screen-reader sentence.
    bkStageEventWithDate: "{status}, {date}",
    // The ONE sentence assistive tech is given for the whole rail — the bars
    // and their labels are aria-hidden ornament.
    bkStageSummary:
      "Booking progress. Request: {request}. Agreement: {agreement}. Event: {event}.",
    // The event's start is seeded from the act's FIRST preferred date, which is
    // routinely not the night the two sides settled on in the thread. This is
    // the venue's only chance to catch that from a list row.
    bkStageDateOffPitch: "The booked date isn't one of the requested dates.",
    // The venue's vouch (venue-confirmation spec, docs/specs/2026-08-27),
    // composed onto the event leg's status word — "Draft · Confirmed by
    // venue" — so one line says what the event is AND whether the venue
    // stands behind it. "Confirmed", never "verified" (that is the Place)
    // or "approved".
    bkStageEventWithConfirmation: "{status} · {confirmation}",
    bkStageVcConfirmed: "Confirmed by the place",
    bkStageVcAwaiting: "Awaiting place confirmation",
    bkStageVcWithdrawn: "Confirmation withdrawn",
    bkStageColHeader: "Stage",
    placeTabBookings: "Bookings",
    bkInboxTitle: "Booking requests",
    bkInboxSubtitle: "Performers who want to play at this place.",
    bkInboxTabOpen: "Open",
    bkInboxTabAccepted: "Accepted",
    bkInboxTabAll: "All",
    // Stage tabs — where the booking IS (booking-inbox-tabs.ts).
    bkInboxTabAgreement: "Agreement",
    bkInboxTabEvent: "Event",
    bkInboxTabClosed: "Closed",
    // ── Holds, assignment, tags (booking-holds spec 2026-08-25) ─────────────
    bkInboxTabHolds: "Holds",
    bkInboxEmptyHolds:
      "No requests with a live hold. Place one from a request's Holds strip.",
    bkInboxColAssignee: "Assigned to",
    bkInboxFilterAssignee: "Assignee",
    bkInboxFilterCalendar: "Calendar",
    bkWsVenueAllInVenue: "all calendars",
    bkWsVenueUnit: "calendars",
    bkWsVenueClear: "Clear",
    bkWsVenueSelectedCount: "{count} of {total} selected",
    bkWsVenueSearch: "Search places and calendars…",
    bkInboxFilterCalendarAll: "All calendars",
    bkInboxFilterAssigneeAll: "Everyone",
    bkInboxFilterTags: "Tags",
    bkInboxFilterTagsPlaceholder: "Filter by tag…",
    bkAssigneeLabel: "Assigned to",
    bkAssigneeUnassigned: "Unassigned",
    bkAssigneeAssignMe: "Assign to me",
    bkAssigneeUnnamed: "Member",
    bkAssigneeFormerMember: "Former member",
    bkAssigneeRosterError: "Couldn't load the team. Assignment is unavailable.",
    bkAssigneeCardLine: "Assigned to {name}",
    bkAssignFailed: "Couldn't change the assignee",
    bkHoldsHeading: "Holds",
    bkHoldsCount: "{count, plural, one {# hold} other {# holds}}",
    bkHoldsEmpty:
      "No holds on this request. A hold keeps the act's spot in line for a date without committing to it.",
    bkHoldSummary: "{date} · {position} hold",
    bkHoldPositionLabel: "{position} hold",
    bkHoldPosition1: "1st",
    bkHoldPosition2: "2nd",
    bkHoldPosition3: "3rd",
    bkHoldPositionNth: "{position}th",
    bkHoldPositionNthOne: "{position}st",
    bkHoldPositionNthTwo: "{position}nd",
    bkHoldPositionNthFew: "{position}rd",
    bkHoldLapsed: "Lapsed",
    bkHoldHoursLeft: "{hours, plural, one {# hour left} other {# hours left}}",
    bkHoldMinutesLeft:
      "{minutes, plural, one {# minute left} other {# minutes left}}",
    bkHoldReplyBy: "Reply by {date}",
    bkHoldNewDeadline: "New deadline: {date}",
    bkHoldMoveUp: "Move the {date} hold ({position}) up the line",
    bkHoldMoveDown: "Move the {date} hold ({position}) down the line",
    // SUBJECT-QUALIFIED ACCESSIBLE NAMES for the four verb buttons, in the
    // shape the two reorder keys above already use. A request holding several
    // nights renders one row per hold — and the inbox can have several strips
    // expanded at once — so "Release" alone named N different nights. The
    // VISIBLE label stays the bare verb; only the accessible name changes.
    bkHoldChallengeAction: "Challenge the {date} hold ({position})",
    bkHoldExtendAction: "Extend the deadline on the {date} hold ({position})",
    bkHoldReleaseAction: "Release the {date} hold ({position})",
    bkHoldConfirmAction: "Confirm the {date} hold ({position})",
    // An unclaimed embed inquiry that already carries holds. The line is real
    // and the list column shows it, so the strip shows it too — with the one
    // sentence that says why two of its buttons are dead. Each clause is a
    // server fact: `notify-booking-hold-intents` skips the act leg, release /
    // reorder / extend have no claim gate, and `confirmBookingHold` refuses
    // with HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST.
    bkHoldsUnclaimedNote:
      "Nobody has claimed this inquiry yet, so the sender isn't told about these holds. Releasing and reordering still work; confirming waits until someone claims the request, and so does the reply clock.",
    bkHoldAlreadyLast: "Already last in line for {date}.",
    bkHoldChallenge: "Challenge",
    bkHoldChallengeTitle: "Challenge this hold",
    bkHoldChallengeCta: "Start the clock",
    bkHoldExtend: "Extend",
    bkHoldExtendTitle: "Extend the deadline",
    bkHoldExtendCta: "Extend",
    bkHoldDeadlineLabel: "Reply-by deadline",
    bkHoldDeadlineHint:
      "The act must keep or release the hold by this time. At least an hour from now; 24 hours by default.",
    // The unclaimed twin, for the same reason as
    // `bkHoldReleaseConfirmBodyUnclaimed`: the act leg of every hold
    // notification is skipped wholesale for an unclaimed inquiry
    // (`notify-booking-hold-intents`), so "The act must keep or release the
    // hold by this time" names an obligation on somebody who is never asked.
    // The deadline is NOT decorative, though — `settle-lapsed-holds` CASes the
    // hold to RELEASED/EXPIRED on the next read past it and emits
    // `hold.expired` for `audience: "staff"` — so the sentence says what does
    // happen instead of going quiet. The floor/default clause is unchanged:
    // it describes this field's validation, which is claim-independent.
    bkHoldDeadlineHintUnclaimed:
      "Nobody has claimed this inquiry, so nobody is being asked to answer. When this time passes the hold lapses on its own and only the place side hears about it. At least an hour from now; 24 hours by default.",
    bkHoldDeadlineTooSoon: "The deadline must be at least an hour from now.",
    bkHoldRelease: "Release",
    bkHoldReleaseConfirmTitle: "Release this hold?",
    bkHoldReleaseConfirmBody:
      "The act loses its spot in line for {date}, and everyone behind it moves up. The act is notified.",
    // The unclaimed twin of the line above. Same consequence, opposite
    // notification: `notify-booking-hold-intents` returns [] for the act leg
    // of an unclaimed inquiry, so "The act is notified." would be a lie on the
    // one dialog in this strip a destructive action opens. The movers' half
    // survives verbatim — `recordMovers` files `hold.position_changed` against
    // each mover's OWN request, which is reached through its own sender lens.
    bkHoldReleaseConfirmBodyUnclaimed:
      "This inquiry loses its spot in line for {date}, and everyone behind it moves up. Nobody has claimed it, so its sender isn't told; the acts moving up are.",
    bkHoldConfirm: "Confirm",
    bkHoldConfirmConfirmTitle: "Confirm this hold?",
    bkHoldConfirmConfirmBody:
      "Creates a draft event on {date}, accepts the request if it's still open, and releases every other hold on that date and this request's other holds. This can't be undone.",
    bkHoldConfirmedTitle: "Hold confirmed — draft event created",
    bkHoldConfirmedDetail:
      "{count, plural, =0 {No other holds were released.} one {# other hold was released.} other {# other holds were released.}}",
    bkHoldPlace: "Place hold",
    bkHoldPlaceTitle: "Place a hold",
    bkHoldPlaceCta: "Place hold",
    bkHoldPlacedToast: "Hold placed — {position} in line",
    bkHoldDateLabel: "Date",
    bkHoldOtherDate: "Another date…",
    bkHoldCalendarLabel: "Calendar",
    bkHoldSpaceLabel: "Space",
    bkHoldSpaceAny: "Any space",
    bkHoldConflict: "That hold changed under you. The list has been refreshed.",
    bkHoldActionFailed: "Couldn't update the hold",
    // P5-fixes (holds/keep/confirm) — booking-the-night FR-003 / FR-004 /
    // FR-005: the hold "Confirm" is gone; a 1st hold offers "Send terms" and,
    // on a night the pitch asked for, "Book without terms" (board W1).
    bkHoldSendTerms: "Send terms",
    bkHoldDeadlineTooLate: "The deadline can be at most 30 days from now.",
    bkHoldSendTermsAction: "Send terms: {date}",
    bkHoldSendTermsToast: "Terms sent for {date}",
    bkHoldBookWithoutTerms: "Book without terms",
    bkHoldBookWithoutTermsAction: "Book without terms: {date}",
    bkHoldBookTitle: "Book {date} without terms?",
    bkHoldBookBody:
      "This creates a draft event on {date} and tells {name} the night is booked.",
    bkHoldBookMoney: "Ticket money goes to {place} until terms are added.",
    bkHoldBookMoneyRequester:
      "Ticket money goes to {name} until terms are added.",
    bkHoldBookMoneyOrganiser:
      "Ticket money goes to the event's organiser until terms are added.",
    bkHoldBookReleases:
      "Other holds on {date} are released.{count, plural, =0 {} one { This request's other hold is released too.} other { This request's # other holds are released too.}}",
    bkHoldBookCta: "Book the night",
    bkHoldBookedTitle: "Night booked — draft event created",
    bkHoldBehindReason:
      "Another hold is ahead of this one on {date}, so this night can't be booked from here yet.",
    bkHoldNotAskedReason:
      "{name} didn't ask for this date, so it can only be booked with terms.",
    bkHoldAcceptFirstReason: "Terms can be sent once you accept the request.",
    bkHoldTermsOutReason:
      "Your terms are with {name}, so they can't be resent from here.",
    bkHoldTermsOtherNightReason:
      "The terms with {name} are for another night, so this one can't be booked.",
    bkHoldTermsAgreedReason:
      "{name} already agreed the terms, so there are none to send.",
    bkHoldTermsInProgressReason:
      "The terms with {name} are being worked out on the agreement, so this night can't be booked from here.",
    bkHoldNoTermsReason:
      "This request has no draft terms to send or book from.",
    bkHoldBookedReason: "This request already has a booked night.",
    bkHoldTermsFinalizedReason:
      "The terms with {name} are agreed. Book this night from the agreement.",
    bkHoldTermsCounteredReason:
      "{name} countered the terms. Answer them on the agreement before sending new ones.",
    bkHoldStageUnknownReason:
      "Couldn't check this request's booking. Reload to try again.",
    bkHoldEventGoneReason:
      "This booking's event was cancelled or archived, so its night can't be booked here.",
    bkHoldEventGoneOriginReason:
      "The event this request was built from was cancelled or archived, so its night can't be booked here.",
    bkHoldEventOtherCalendarReason:
      "This request's event is on another calendar, so this hold's night can't be booked here.",
    bkHoldEventOtherNightReason:
      "This request's event is on another night, so this date can't be booked here.",
    bkHoldsUnclaimedNoteBooking:
      "Nobody has claimed this inquiry yet, so the sender isn't told about these holds. Releasing and reordering still work; booking waits until someone claims the request, and so does the reply clock.",
    // end P5-fixes (holds/keep/confirm)
    // ── Hold date picker (owner rulings 2026-08-31: a hold names no space —
    // the calendar owns the room; and dates are picked from a month grid,
    // several at a time). The old three-select form's keys above
    // (bkHoldPlaceTitle, bkHoldPlaceCta, bkHoldPlacedToast, bkHoldDateLabel,
    // bkHoldOtherDate, bkHoldSpaceLabel, bkHoldSpaceAny) now have no callers
    // and can be swept. `bkHoldPlace` — the button that opens the picker —
    // is still used.
    bkHoldPickTitle: "Hold dates",
    bkHoldPickAsked: "Asked for {dates}",
    bkHoldPickAskedNone: "The request named no dates.",
    bkHoldPickRooms: "Programs into {rooms}",
    bkHoldPickRoomsNone: "No rooms on this calendar yet",
    bkHoldPickRoomNote: "The room is chosen when the hold is confirmed.",
    bkHoldPickPrevMonth: "Previous month",
    bkHoldPickNextMonth: "Next month",
    bkHoldPickGridLabel: "{month} — pick dates to hold",
    bkHoldPickSelectAsked: "Select the act's {count} dates",
    bkHoldPickSelectWeekday: "All open {weekday}s",
    bkHoldPickDayPast: "in the past",
    bkHoldPickDayDarkFree: "dark — this act would be 1st",
    bkHoldPickDayDarkLine:
      "dark — {count, plural, one {# hold} other {# holds}}, this act would be {position}",
    bkHoldPickDayTaken: "{label} has the night",
    bkHoldPickDayTakenUnnamed: "the night is taken",
    bkHoldPickDayHeld: "already held for this act, {position} in line",
    bkHoldPickDayOpen: "open, this act would be 1st",
    bkHoldPickDayLine:
      "{count, plural, one {# hold} other {# holds}}, this act would be {position}",
    bkHoldPickDayChallenged: "One hold is on the reply clock",
    bkHoldPickDayAsked: "The act asked for this date",
    bkHoldPickDayFailed: "The last attempt was refused on this date",
    bkHoldPickShortDark: "Dark",
    bkHoldPickShortTaken: "Taken",
    bkHoldPickShortHeld: "Held",
    bkHoldPickShortOffer: "→ {position}",
    bkHoldPickLegendOpen: "Open",
    bkHoldPickLegendLine: "Holds in line",
    bkHoldPickLegendAsked: "Act asked for it",
    bkHoldPickLegendDark: "Dark",
    bkHoldPickLegendTaken: "Booked",
    bkHoldPickLegendSelected: "Selected",
    bkHoldPickRailLine: "The line",
    bkHoldPickRailEmpty: "Nobody holding. This act takes 1st.",
    bkHoldPickRailYouWould: "This act would go here",
    bkHoldPickRailYouHeld: "This act — held",
    bkHoldPickRailTaken: "{label} has the night. Nothing can queue behind it.",
    bkHoldPickRailTakenUnnamed:
      "The night is taken. Nothing can queue behind it.",
    bkHoldPickRailDark:
      "The place is dark on this date. You can still hold it — whether to open is a decision for later.",
    bkHoldPickRailPast: "This date has passed.",
    bkHoldPickRailAskedLabel: "Asked for",
    bkHoldPickRailAsked: "The act named this date on its request.",
    bkHoldPickTrayEmpty: "No dates picked yet. Up to {max} in one go.",
    bkHoldPickCta:
      "{count, plural, =0 {Hold dates} one {Hold # date} other {Hold # dates}}",
    bkHoldPickRemove: "Remove {date}",
    bkHoldPickRemoveDark: "Remove {date} (dark)",
    bkHoldPickPlacedAll:
      "{count, plural, one {# date held} other {# dates held}}",
    bkHoldPickPlacedBody:
      "The act is notified, and the dates show on this calendar.",
    bkHoldPickPlacedSome: "{placed} of {total} held",
    bkHoldPickPartialBody:
      "The dates that landed are held. The rest are still picked, so you can swap them.",
    bkHoldPickPlacedToast:
      "{count, plural, one {Hold placed} other {# holds placed}}",
    bkHoldPickPlacedPartialToast:
      "{placed} held, {failed} refused — check the dates still in the tray",
    bkHoldPickFailedExists: "Already held",
    bkHoldPickFailedTaken: "Taken",
    bkHoldPickFailedPast: "Past",
    bkHoldPickFailedInvalid: "Invalid",
    bkHoldPickFailedRetry: "Try again",
    bkHoldPickFailedOther: "Refused",
    bkHoldPickNoCalendars: "This place has no calendars yet",
    bkHoldPickNoCalendarsBody:
      "Holds live on a calendar. Create one and the picker opens on it.",
    bkHoldPickOverlayError:
      "Couldn't load this month's holds. The grid may be out of date — the server still checks every date.",
    // ── Availability onboarding (spec 2026-08-31): warn an unconfigured venue
    // at the toggle, the workspace and the picker, and put the fix one click
    // away. "Hours" is the user word for weekly CalendarAvailability windows.
    bkHoursWarnTitle: "Acts can't reach you yet",
    bkHoursWarnBody:
      "Acts can't send you a request until you set your hours — every date shows as unavailable.",
    bkHoursWarnCta: "Set your hours",
    calHoursModalTitle: "Set your hours",
    calHoursModalSubtitle:
      "Weekly opening windows — acts can only request dates inside them.",
    calHoursPresetsTitle: "Start from a preset",
    calHoursPresetsHelp:
      "One click seeds a weekly schedule you can edit below — nothing is locked in.",
    calHoursPresetThuSat: "Thu–Sat evenings",
    calHoursPresetWedSun: "Wed–Sun evenings",
    calHoursPresetEveryNight: "Every night",
    calHoursPresetWeekends: "Weekends only",
    calHoursPresetApplyAria: "Apply preset: {label}, {start}–{end}",
    calHoursPresetFailed: "Couldn't apply the preset",
    bkWsHoursBannerTitle: "Hours not set",
    bkWsHoursBannerOne:
      "Acts can't send {venue} a booking request until its hours are set — every date on its public form shows as unavailable.",
    bkWsHoursBannerMany:
      "Acts can't send these places a booking request until their hours are set — every date on their public forms shows as unavailable.",
    bkWsHoursBannerCta: "Set your hours",
    bkWsHoursBannerCtaVenue: "Set hours — {venue}",
    bkWsHoursBannerCtaAria: "Set hours for {venue}",
    bkWsHoursBannerDismiss: "Dismiss this reminder for this session",
    bkHoldPickUnconfigured:
      "This place has no hours set, so every date reads as dark. You can still hold dates.",
    bkHoldPickUnconfiguredLink: "Set your hours",
    bkHoldPickCalUnconfigured:
      "No hours cover this calendar, so every date reads as dark. You can still hold dates.",
    bkTagsLabel: "Tags",
    bkTagInputLabel: "Add a tag",
    bkTagPlaceholder: "Type a tag…",
    bkTagCreateOption: 'Create "{name}"',
    bkTagNoMatches: "No tags match.",
    bkTagNoMatchesCreate: "No tags match — press Enter to create one.",
    bkTagRemove: "Remove tag {name}",
    bkTagCreateFailed: "Couldn't create the tag",
    bkTagsUpdateFailed: "Couldn't update the tags",
    bkTagSaveFailed: "Couldn't save the tag",
    bkTagAddTitle: "New tag",
    bkTagAddNameLabel: "Tag name",
    bkTagAddColorLabel: "Tag colour",
    bkTagAddCta: "Add tag",
    bkTagNameLabel: "Name of tag {name}",
    bkTagColorLabel: "Colour of tag {name}",
    bkTagMoveUp: "Move {name} up",
    bkTagMoveDown: "Move {name} down",
    bkTagDelete: "Delete tag {name}",
    bkTagDeleteConfirmTitle: "Delete this tag?",
    bkTagDeleteConfirmBody:
      '"{name}" is removed from every request it\'s on. Requests themselves are untouched.',
    bkTagDeleteCta: "Delete",
    bkTagColorNeutral: "Neutral",
    bkTagColorAccent: "Accent",
    bkTagColorInfo: "Ink",
    bkTagColorSuccess: "Green",
    bkTagColorWarning: "Amber",
    bkTagColorDanger: "Red",
    // The next step inside the conversation (CreateEventFromBookingAction).
    bkInboxCreateEventKicker: "Next step",
    bkInboxCreateEventCta: "Create event from this booking",
    bkInboxEventLinkedKicker: "Event",
    bkInboxOpenEventCta: "Open event",
    bkInboxColSender: "From",
    bkInboxColGenre: "Genre",
    bkInboxColDates: "Preferred dates",
    bkInboxColDraw: "Draw",
    bkInboxDrawEstimateLabel: "Artist's estimate",
    bkInboxVerifiedStatsAsOf: "Verified platform stats (as of {date})",
    bkInboxStatShows: "Shows performed",
    bkInboxStatAvgDraw: "Avg draw",
    bkInboxStatRefLink: "Via artist's links",
    bkInboxStatRepeatFans: "Repeat fans",
    bkInboxStatLast90Value:
      "{tickets} tickets across {events} shows (last 90 days)",
    bkInboxColStatus: "Status",
    bkInboxColReceived: "Received",
    bkInboxColAgreement: "Agreement",
    bkInboxSenderHuman: "Solo performer",
    bkInboxSenderOrg: "Group",
    // ONE line for all THREE place switches (booking acceptance, community
    // listings, publish attendee ratings), because the refusal is about the
    // reader's authority and not about the switch: the write bar is the same
    // for all three (`placeSwitchAuthorityFromMemberships`). It names who CAN
    // flip it, so the reader knows who to ask instead of only that they were
    // stopped. It BEATS the "verify your venue" line when both are true — a
    // reader who cannot flip the switch cannot act on the verification advice
    // either, and after verification they would still be refused.
    placeSwitchNoPermission:
      "Only the place's owner, or a group owner or admin, can change this.",
    // The acceptance switch, at the top of this same page.
    bkAcceptanceTitle: "Accept booking requests",
    bkAcceptanceHelpOn:
      "On. Your place page shows a “Request to book” button and performers can pitch you from it.",
    bkAcceptanceHelpOff:
      "Off. Your place page hides the “Request to book” button. Turn this on to start receiving requests.",
    bkAcceptanceUnverified: "Verify your place to accept booking requests.",
    bkAcceptanceUpdateFailed: "Couldn't update booking requests",
    bkAcceptanceSavedOn: "Booking requests on",
    bkAcceptanceSavedOff: "Booking requests off",
    // Deliberately NOT "your page is updated, go look". It is updated at the
    // origin, but the venue page is cached at the CDN edge for a couple of
    // minutes, and a promise of an instant flip is what makes an owner reload,
    // see the old button, and report the switch as broken.
    bkAcceptanceSavedNote:
      "Your place page is updated. Visitors may see the previous version for a couple of minutes while caches catch up.",
    // The flag saved but the public page's cached copy could not be refreshed,
    // so say so rather than let the owner reload and think the switch failed.
    bkAcceptanceSavedStale:
      "Saved — your place page may take a few minutes to catch up.",
    // ── Community listings (community-listings-at-claimed-venues FR-001/005/007)
    // The consent switch sits directly under the booking one, because accepting
    // community listings ALSO occupies those nights for booking availability.
    clAcceptanceTitle: "Accept community listings",
    clAcceptanceHelpOn:
      "On. Community events that name your place show on your page as confirmed by you.",
    clAcceptanceHelpOff:
      "Off. Community events that name your place show your address only.",
    clAcceptanceUnverified: "Verify your place to accept community listings.",
    clAcceptanceUpdateFailed: "Couldn't update community listings",
    clAcceptanceSavedOn: "Community listings on",
    clAcceptanceSavedOff: "Community listings off",
    // Same propagation caveat as the booking switch above — see its note.
    clAcceptanceSavedNote:
      "Your place page is updated. Visitors may see the previous version for a couple of minutes while caches catch up.",
    clAcceptanceSavedStale:
      "Saved — your place page may take a few minutes to catch up.",
    // Stated BEFORE the decision, and persistent rather than a toast: a venue
    // that learns about the booking-availability side effect by finding its
    // calendar full is the surprise this line exists to prevent.
    clAcceptanceConsequenceBody:
      "Accepted listings appear on your place page and occupy that time, so those nights stop accepting booking requests.",
    clAcceptanceConsequenceWithCount:
      "{count, plural, one {# community listing already names your place.} other {# community listings already name your place.}} Accepting shows them on your page and occupies that time, so those nights stop accepting booking requests.",
    bkInboxEmptyTitle: "No booking requests yet",
    // ONE reason, the one that is actually true. The single sentence these
    // three replaced named two conditions vaguely and pointed at a collapsed
    // settings drawer without saying the switch was inside it.
    bkInboxEmptyBodyUnverified:
      "Your place isn't verified yet, so performers can't send it requests.",
    bkInboxEmptyBodyOff:
      "Booking requests are turned off, so your place page hides the request button. Turn them on above.",
    bkInboxEmptyBodyOn:
      "You're accepting requests and nothing has come in yet. Share your place page and performers can pitch you from it.",
    bkInboxEmptyVerifyCta: "Verify your place",
    // CHROME-NEUTRAL on purpose. This copy is shared by the place inbox and the
    // org workspace — both now render the stage views as a pressed-toggle
    // group (StatusSegments), and on the workspace "tabs" means something else
    // entirely (To your venues / To you as an act / Sent to acts). Naming the
    // views is true on both; naming the chrome sent org admins hunting for tabs
    // that aren't there. (`bkInboxTabAccepted` / `bkInboxTabAll` stay: the
    // org-as-act table still filters Open/Accepted/All.)
    bkInboxEmptyOpen:
      "Nothing waiting on you. Answered requests are under Agreement, Event and Closed.",
    bkInboxEmptyAccepted:
      "No accepted requests yet. When you accept one it stays here, with its agreement.",
    bkInboxEmptyAgreement:
      "No bookings at the agreement stage. When you accept a request it moves here with its draft agreement.",
    bkInboxEmptyEvent:
      "No events created from bookings yet. Once an agreement is accepted, create the event from its conversation.",
    bkInboxEmptyClosed: "No declined, withdrawn or expired requests.",
    bkInboxMessageLabel: "Message",
    bkInboxActNameLabel: "Act",
    bkInboxLineupLabel: "Lineup",
    bkInboxSetLengthLabel: "Set length",
    bkInboxFeeLabel: "Fee",
    bkInboxPhoneLabel: "Phone",
    bkInboxTechNeedsLabel: "Tech & backline",
    bkInboxLinksLabel: "Links",
    bkInboxLinkMusicLabel: "Music / streaming",
    bkInboxLinkVideoLabel: "Video",
    bkInboxLinkSocialLabel: "Social",
    bkInboxLinkEpkLabel: "EPK / press kit",
    bkInboxAccept: "Accept",
    bkInboxDecline: "Decline",
    bkInboxAcceptConfirmTitle: "Accept this request?",
    bkInboxAcceptConfirmBody:
      "This creates a draft agreement with this performer. You can shape the terms before anything is final.",
    bkInboxAcceptSuccess: "Agreement draft created",
    // Same chrome-neutral rule as bkInboxEmptyOpen — three surfaces share this
    // toast and only one of them has an Accepted TAB.
    bkInboxAcceptSuccessMessage:
      "The request moved to Accepted and stays there.",
    // Invite-to-claim resend, on the place inbox's accepted anonymous rows.
    bkInboxResendInvite: "Resend invite",
    bkInboxInviteResent: "Invite re-sent",
    bkInboxInviteResendLimited: "Try again later — invite resends are limited.",
    bkInboxInviteExpires: "The link expires {date}.",
    bkInboxDeclineReasonLabel: "Reason",
    bkInboxDeclineReasonPlaceholder: "Let the performer know why…",
    bkInboxDeclineReasonHint:
      "At least 3 characters. Shared with the performer.",
    bkInboxDeclineConfirm: "Decline request",
    bkInboxDeclinedNote: "Declined: {reason}",
    bkInboxConflict: "This request was already handled or expired. Refreshing…",
    bkInboxActionFailed: "Couldn't update the request",
    bkInboxExpires: "Expires {date}",

    // ── Organizer → performer requests (received side) ────────────────
    bkAcceptLabel: "Open to booking requests",
    bkAcceptOnHelp:
      "On. Organizers can send this group booking requests, and a “Request to book” button appears on its public page.",
    bkAcceptOffHelp: "Off. Organizers can't send this group booking requests.",
    bkAcceptUpdateFailed: "Couldn't update booking-request acceptance",
    bkRcvEmpty:
      "No requests yet. When an organizer asks to book this act, it will show up here.",
    bkRcvLoadFailed: "Couldn't load booking requests.",
    bkRcvDetails: "Details",
    bkRcvHideDetails: "Hide details",
    bkRcvEventLabel: "Event",
    bkRcvOfferLabel: "Offer",
    bkRcvOrgFallback: "An organizer",
    bkRcvAcceptConfirmTitle: "Accept this booking request?",
    bkRcvAcceptConfirmBody:
      "This creates a draft agreement with {org}. You can shape the terms before anything is final.",
    bkRcvAcceptSuccess: "Agreement draft created",
    bkRcvDeclineReasonPlaceholder: "Let the organizer know why…",
    bkRcvDeclineReasonHint:
      "Optional. If you add one, it's shared with the organizer.",

    // ── Organizer → performer requests (send side, FR-009) ────────────
    bkOrgSendingAs: "Sending as {org}",
    bkOrgMsgPlaceholder:
      "Tell them about your show and why you'd like them on the bill…",
    bkOrgEventAttachLabel: "Attach one of your events",
    bkOrgEventAttachHint:
      "Optional — link an existing event so the act sees what they'd be playing.",
    bkOrgEventUntitled: "Untitled event",
    bkOrgNoOrgTitle: "You need a group to send booking requests",
    bkOrgNoOrgBody:
      "Booking requests are sent on behalf of a group. Create one from your admin area, then come back to this page.",
    bkOrgNoOrgCta: "Go to your admin area",
    bkOrgSuccessTitle: "Request sent to {act}",
    bkOrgSuccessBody:
      "They'll be notified and can accept or decline. You can follow it from your group's bookings.",
    bkOrgSuccessLink: "View your requests",
    bkOrgErrDuplicate: "You already have an open request with this act.",
    bkOrgErrNotAccepting:
      "This act isn't accepting booking requests right now.",
    bkOrgErrEventNotOwned:
      "That event can't be attached — choose one of your group's events.",
    bkOrgErrOwnAct: "You can't send a booking request to your own group.",

    // ── Bookings hub (org admin) ──────────────────────────────────────
    bkHubActsEmpty:
      "No requests to acts yet. Visit a performer's page and use Request to book.",
    bkHubActFallback: "Performer",
    bkHubLoadFailed: "Couldn't load booking requests. Try again shortly.",
    bkHubDeclined: "Declined: {reason}",
    bkHubVenueView: "Open inbox",
    bkHubSettingsHint:
      "Want organizers and places to book your act? Manage performer mode and booking defaults in Settings.",
    bkHubSettingsLink: "Performer settings",

    // ── Bookings workspace (org admin, tabbed) ────────────────────────
    // Three tabs, three DIFFERENT relationships. "To your venues" is acts
    // asking to play at a place you own; "To you as an act" is organizers
    // asking your group to perform. The labels must not blur — the old
    // "Requests to you" read as both.
    bkWsTabVenues: "To your places",
    bkWsTabReceived: "To you as an act",
    bkWsTabSent: "Sent to acts",
    bkWsSubtitle:
      "Requests to your places, requests to your group as an act, and requests you've sent.",
    // The "as an act" inbox is hidden for a group that has performer mode off
    // and nothing waiting in it, so the subtitle must stop promising it.
    bkWsSubtitleNoAct:
      "Requests to your places, and requests you've sent to acts.",
    bkWsSubtitleSentOnly: "Requests you've sent to acts.",
    // Human admin: the page carries ONLY the venue side. Requests to the
    // person as an act, and the ones they sent, stay in account settings.
    bkWsSubtitleHumanVenues:
      "Requests from acts to every place you own or help run.",
    bkHubHumanInboxHint:
      "Requests to you as a performer, and the ones you've sent, are in your account settings.",
    bkHubHumanInboxLink: "Your booking requests",
    bkWsRcvEmptyTitle: "Nothing waiting on you",
    bkWsFilterLabel: "Filter requests",
    bkWsVenuesTruncated:
      "Showing the first {count} places. Your group owns more, and their requests aren't in this list.",
    // Same warning for when the venue COUNT failed and the list read was
    // capped: the cap is real, but there is no honest number to quote, and
    // "Showing the first 0 venues" would be worse than the plain statement.
    bkWsVenuesTruncatedUnknown:
      "Your group owns more places than this list covers, so some requests aren't shown.",
    bkWsVenuesLoadFailed: "Couldn't load place inboxes.",
    // Accessible name for the per-venue "Open inbox" buttons — the visible
    // label repeats N times, so the venue name has to reach screen readers.
    bkWsVenueViewAria: "Open {venue}'s booking inbox",
    // Stands in for a missing venue name so the sentence above never reads
    // "Open 's booking inbox".
    bkWsVenueFallback: "this place",

    // ── Cross-venue inbox (org admin → "To your venues") ──────────────
    bkWsVenueFilterLabel: "Place",
    bkWsVenueFilterAria: "Filter requests by place",
    bkWsVenueAllOption: "All places",
    bkWsVenueAllOptionCount: "All places — {count} open",
    bkWsVenueOptionCount: "{venue} — {count} open",
    bkWsColVenue: "Place",
    bkWsVenEmptyTitle: "No booking requests yet",
    bkWsVenEmptyBody:
      "When a performer asks to play at one of your places, the request lands here. Each place has to be verified and accepting requests.",
    bkWsVenEmptyCta: "Manage your places",
    bkWsVenEmptyFiltered:
      "No requests for this place here. Switch to All places to see the rest.",
    bkWsVenAnonSource: "Via the place's website",
    bkWsVenAnonContact: "Contact email",
    // TWO CHANNELS, NOT ONE. This hint used to say email was the only way to
    // reach an unclaimed inquirer; the Conversation below is now the other, and
    // the pair has to read as complementary. So the hint says what is DIFFERENT
    // about the mailto — your own address, your own mailbox, no record on the
    // booking — rather than claiming exclusivity it no longer has.
    bkWsVenAnonReplyHint:
      "Opens your own mail app. The conversation below sends from Ithas Fire and keeps a copy on this request.",
    bkWsVenAnonReplyAria: "Reply by email to {name}",
    // ── The thread is a RELAY for an unclaimed inquiry ─────────────────────
    // A venue looking at this composer cannot tell it from the owned-request
    // one, and the two facts that matter are both invisible: what they type
    // leaves as an email, and the answer does not come back here (there is no
    // inbound email ingestion — the reply rides the Reply-To we set to the
    // organization's contact address).
    bkWsVenThreadRelayLabel: "Sent as email",
    bkWsVenThreadRelayBody:
      "{name} has no Ithas Fire account yet, so anything you send here goes out as an email to {email}. They can't reply in this thread — their answer goes to your organization's contact email, so set one if you haven't.",
    // Shown instead when the row is stamped undeliverable. The bounce/spam
    // NOTICE higher in this panel owns the alarm and the next step; this only
    // states the consequence for the box directly beneath it.
    bkWsVenThreadRelayFailedLabel: "Email isn't reaching them",
    bkWsVenThreadRelayFailedBody:
      "Our email to {email} stopped getting through — see the delivery notice above. A message sent here is still saved on this request, but {name} won't see it until you reach them another way.",
    // ── Venue reply couldn't be delivered (booking-inquirer-outreach) ──
    // TWO CAUSES, TWO MESSAGES, on purpose. A bounce means the address is
    // dead — the venue needs a different one. A complaint means the email
    // ARRIVED and was marked as junk, so we stop sending; the venue writing
    // from their own client is a different sender and may still land.
    // Collapsing these into one "delivery failed" hides the next step.
    bkWsVenUndelivBouncedBadge: "Reply bounced",
    bkWsVenUndelivBouncedAria:
      "Your reply to {name} bounced — they never received it.",
    bkWsVenUndelivBouncedTitle: "Your reply bounced",
    bkWsVenUndelivBouncedBody:
      "The email we sent to {email} came back undelivered — that address is wrong, or the mailbox is gone. {name} has not seen your reply, and nothing else you send from here will reach them.",
    bkWsVenUndelivBouncedNext:
      "Check the address below for a typo, then reach out yourself — or find another way to contact them.",
    bkWsVenUndelivSpamBadge: "Marked as spam",
    bkWsVenUndelivSpamAria:
      "{name} marked your reply as spam, so we stopped emailing them.",
    bkWsVenUndelivSpamTitle: "Your reply was marked as spam",
    bkWsVenUndelivSpamBody:
      "The email reached {email}, but {name} marked it as junk — so we have stopped emailing that address. Nothing else you send from here will reach them.",
    bkWsVenUndelivSpamNext:
      "Writing to them from your own email may still get through.",
    bkWsVenUndelivWhen: "Reported {date}",
    bkWsVenInviteSent: "Invite sent",
    bkWsVenInviteBody:
      "{name} got an email link to set up their account and finalize the booking.",
    bkWsVenInviteManage:
      "Resend or check the invite from this place's own inbox.",
    bkWsVenAcceptAnonConfirm:
      "Accept and send an invite — {name} will get an email link to set up their account and finalize the booking.",
    bkWsVenAcceptAnonCta: "Accept & send invite",

    // ── Performer mode (group settings) ───────────────────────────────
    settingsPerformer: "Performer",
    settingsPerformerDescription:
      "Turn on performer mode to send booking requests to places as this group.",
    performerModeLabel: "Performer mode",
    performerModeOnHelp:
      "On since {date}. This group can send booking requests to places.",
    performerModeOffHelp:
      "Off. Turning performer mode off hides performer features but keeps your data.",
    performerModeUpdateFailed: "Couldn't update performer mode",
    performerModeForbidden: "Only group admins can change performer mode.",
    performerModeStatusUnavailable:
      "Performer status is unavailable right now.",
    bkDefOrgDesc:
      "Save reusable pitch details for this group. Booking requests sent as this group are prefilled with these — you can still tweak them for each place.",

    // ── Booking agreements (negotiation editor) ───────────────────────
    baStatusDraft: "Draft",
    baStatusProposed: "Under review",
    baStatusCountered: "Countered",
    baStatusAccepted: "Accepted",
    baStatusDeclined: "Declined",
    baStatusCancelled: "Cancelled",
    baStatusFulfilled: "Fulfilled",
    baStatusExpired: "Expired",
    baStatusDisputed: "Disputed",
    baEditorEyebrow: "Booking agreement",
    baBackToList: "Back to booking requests",
    baAdminBackToBooking: "Back to booking",
    baAdminBackToBookings: "Back to bookings",
    baLoadFailed: "Couldn't load this agreement.",
    baRetry: "Try again",
    baNotYoursTitle: "Not your agreement",
    baNotYoursBody:
      "Only the parties on an agreement can view it. Make sure you're signed in with the right account.",
    baSignInTitle: "Sign in required",
    baSignInBody: "Sign in to view your booking agreements.",
    baSignInCta: "Sign in",
    baPartiesLabel: "Parties",
    baPlaceLabel: "Place",
    baHeaderTitleLabel: "Title",
    baProposedDateLabel: "Proposed date",
    baProposedEndDateLabel: "Proposed end",
    baGuaranteeLabel: "Guarantee",
    baGuaranteeHint:
      "Optional flat amount in dollars, owed regardless of ticket sales. Recorded here as part of the deal — the place pays it directly; Ithas Fire does not deduct it from ticket payouts.",
    baDescriptionLabel: "Notes",
    baDescriptionPlaceholder:
      "Set times, load-in, hospitality, gear — anything the deal should capture…",
    baSaveHeader: "Save changes",
    baHeaderSavedToast: "Agreement updated",
    baErrTitleTooShort: "Title needs at least 3 characters.",
    baErrEndBeforeStart: "The end must be on or after the proposed date.",
    baErrGuaranteeInvalid:
      "Guarantee must be a dollar amount of 0 or more, with up to 2 decimals.",
    baFromRequestLabel: "From booking request",
    baPitchFromRequest: "From request",
    baPitchGuaranteeHint:
      "Carried over from the booking request — change it if it isn't the right number. The place pays this directly; it is not deducted from ticket payouts.",
    baGuaranteeFromDeal: "From The deal",
    baGuaranteeFromDealHint:
      "The fixed part of the act's clauses in The deal. Change it there.",
    baGuaranteeFromDealHintReadOnly: "Set by The deal.",
    baGuaranteeFromDealLink: "Go to The deal",
    baGuaranteeSetByDeal: "The guarantee comes from The deal now. Change it there.",
    baDraftNotice:
      "Draft — both parties can shape the terms. Send it for review when it's ready.",
    baReadOnlyNotice: "This agreement is read-only.",
    baActSideTermsNotice:
      "The place or organizer sets the terms. You can accept or decline once they send them for review.",
    baActSideProposedNotice:
      "Under review — accept these terms, or decline and tell them why.",
    baEditorDraftNotice:
      "Draft — you set the terms. Send them for review when they're ready.",
    baEditorProposedNotice:
      "Under review — the act can accept or decline. Pull it back to keep editing.",
    baSendForReview: "Send for review",
    baSentToast: "Sent for review",
    baProposedNotice:
      "Under review — either party can accept, decline, or pull it back to keep editing.",
    baAccept: "Accept",
    baAcceptConfirmTitle: "Accept this agreement?",
    baAcceptConfirmBody:
      "Accepting locks the terms as written. Third-party payout lines still confirm individually before finalize.",
    baAcceptedToast: "Agreement accepted",
    baDecline: "Decline",
    baDeclineReasonLabel: "Reason",
    baDeclineReasonHint: "At least 3 characters. Shared with the other party.",
    baDeclineConfirm: "Decline agreement",
    baDeclinedToast: "Agreement declined",
    baPullBack: "Pull back to edit",
    baPulledBackToast: "Back to draft",
    baCancel: "Cancel agreement",
    baCancelReasonLabel: "Reason for cancelling",
    baCancelReasonHint:
      "At least 3 characters. The act sees this reason in the conversation, and the agreement can't be reopened afterwards.",
    baCancelDraftEventHint:
      "The draft event created for this booking stays in your drafts. Delete it if the show is off.",
    baCancelDismiss: "Keep agreement",
    baCancelConfirm: "Cancel this agreement",
    baCancelledToast: "Agreement cancelled",
    baAcceptedNotice:
      "Accepted — confirm any pending payout lines, then finalize onto an event.",
    baFinalizedNotice:
      "Finalized — the payout terms are stamped on the linked event.",
    baDeclinedNotice: "This agreement was declined.",
    baDeclinedReason: "Reason: {reason}",
    baCancelledNotice: "This agreement was cancelled.",
    baConflict: "This agreement changed on the other side. Refreshing…",
    baActionFailed: "Couldn't update the agreement",
    baLinesTitle: "Payout lines",
    baLinesSubtitle:
      "Who gets paid when this deal settles. Party lines are implied by acceptance; third parties confirm their own line.",
    baLinesEmpty:
      "No payout lines yet. Add the people or groups who get a cut.",
    baLineColPayee: "Payee",
    baLineColShare: "Share",
    baLineColConfirmation: "Confirmation",
    baLineTagHuman: "Person",
    baLineTagOrg: "Group",
    baLineImplied: "Implied",
    baLineConfPending: "Pending",
    baLineConfConfirmed: "Confirmed",
    baLineConfCountered: "Countered",
    baLineConfDeclined: "Declined",
    baLineEdit: "Edit line",
    baLineRemove: "Remove line",
    baLineSave: "Save line",
    baLineSavedToast: "Line saved",
    baLineRemovedToast: "Line removed",
    baLineUnresolvedPayee:
      "Payee record missing — remove this line and add the payee again.",
    baLineTotal: "Total share: {percent}%",
    baLineOverAllocated: "Shares exceed 100%.",
    baAddPayeeLabel: "Add payee",
    baAddPayeeSearchLabel: "Search people",
    baAddPayeeSearchPlaceholder: "Bandmate, manager, sound engineer…",
    baAddPercentLabel: "Share %",
    baAddLine: "Add line",
    baErrPercentInvalid: "Share must be a whole number from 0 to 100.",
    baConfirmYourLine: "Confirm your line",
    baConfirmYourLineHint:
      "You're the payee on this line. Confirming locks in your share.",
    baLineConfirmedToast: "Line confirmed",
    baFinalize: "Finalize onto event",
    baFinalizeTitle: "Finalize agreement",
    baFinalizeBody:
      "This stamps the agreement's payout terms onto the event you pick. Settlement pays out per these lines.",
    baFinalizeEventLabel: "Event",
    baFinalizeEventPlaceholder: "Select an event…",
    baFinalizeNoEvents:
      "No editable events found. Create the event first, then come back to finalize.",
    baFinalizeUntitledEvent: "Untitled event",
    baFinalizeConfirm: "Finalize",
    baFinalizeSuccessToast: "Agreement finalized",
    baErrLinesUnconfirmed:
      "These payout lines still need confirmation: {names}.",
    baErrPayeeNotReady:
      "A payee hasn't finished Stripe payout setup. They need to complete onboarding before money can route to them.",
    baErrEventHasAgreement:
      "That event already has a different agreement attached.",
    baErrAgreementFinalized: "This agreement is already finalized.",
    baErrAgreementNotCancellable:
      "This agreement has already ended, so there's nothing to cancel.",
    baErrTermsEditorOnly:
      "Only the place or organizer can change these terms. You can accept or decline once they send them for review.",
    baErrActResponseOnly:
      "Only the act can accept or decline these terms. Pull the agreement back if you need to change them.",
    baOpenAgreement: "Open agreement",
    baInboxAcceptedNote: "Accepted — a draft agreement was created.",
    baViewOnlyMemberNotice:
      "Your role in this group lets you view this agreement, but only owners, admins, and editors can act on it.",
    baFinalizeEventsLoadFailed: "Couldn't load some of your events.",
    baLineCounter: "Counter",
    baLineDecline: "Decline",
    baCounterPercentLabel: "Proposed share %",
    baCounterNoteLabel: "Note",
    baCounterNoteHint:
      "At least 10 characters. Your note is shared with the agreement parties.",
    baCounterSubmit: "Send counter",
    baCounteredToast: "Counter sent",
    baLineDeclinedToast: "Line declined",
    baErrCounterPercentInvalid:
      "Proposed share must be between 0 and 100, with up to 2 decimals.",
    baCounterAsk: "Countered: asks {percent}% — “{note}”",
    baApplyCounter: "Apply counter ({percent}%)",
    baDeclineLineConfirmTitle: "Decline this payout line?",
    baDeclineLineConfirmBody:
      "Declining tells the parties you won't accept this line as written. They can edit the terms, which restarts your confirmation.",
    baReopen: "Reopen draft",
    baReopenConfirmTitle: "Reopen this agreement?",
    baReopenConfirmBody:
      "Reopening returns the agreement to draft so the terms can be edited. It will need to be sent for review and accepted again before finalizing.",
    baReopenedToast: "Agreement reopened",
    baCounterBlockedHint:
      "{count, plural, one {A payout line was countered or declined} other {# payout lines were countered or declined}} — reopen the draft to adjust the terms before finalizing.",

    // ── Locale-tolerant numeric input (promos + splits) ─────────────────────
    // Free-text money/percent fields accept both `.` and `,` as the decimal
    // separator and REFUSE anything they cannot read with certainty, rather
    // than coercing it (see src/lib/money/parse-money-input.ts).
    cpAmountInvalid: "Enter a non-negative amount, for example 12.50 or 12,50.",
    cpAmountAmbiguous:
      "That amount can be read two ways. For one thousand five hundred, type 1500. For one and a half, type 1.50 or 1,50.",
    cpValuePercentWhole: "Enter a whole number of percent, for example 20.",
    ebSplitsPercentInvalid:
      "Enter a whole percent between 0 and 100, for example 50.",
    ebSplitsPercentAmbiguous:
      "That share can be read two ways. For one percent, type 1. For one hundred percent, type 100.",
    // Read fine, but shares are stored as whole percent, so a fractional one
    // would be silently rounded at write. Refused instead — see SplitsEditor.
    ebSplitsPercentWhole:
      "Shares are saved as whole percent, so 12,5 can’t be used. Enter 12 or 13.",
    ebSplitsPercentRange: "A share must be between 0 and 100 percent.",
    ebSplitsPercentBlocker:
      "{count, plural, one {One payee’s share can’t be read} other {# payees’ shares can’t be read}} — fix it before saving.",
    ebSplitsSaveBlockedTitle: "Fix the shares first",
    cpMaxDiscountPositive:
      "A $0 cap would block every discount. Leave this blank for no cap.",

    // ── Scheduled price change (TicketScheduledPriceField) ──
    // `ttScheduleReadback` is the FR-007 verification line: the organizer is
    // the only person who can catch a timezone mistake, so `{when}` always
    // arrives pre-formatted in the EVENT's timezone with its zone
    // abbreviation ("Fri, Oct 3, 12:00 AM CDT"). Never rebuild that string
    // here — Intl owns the date-part order per locale.
    ttScheduleToggle: "Price changes later",
    // Kept SHORT on purpose: this sits under an unchecked box in the common
    // case, and at 320px the previous wording ran to three lines of muted
    // text for a feature most tiers never use.
    ttScheduleHelp: "Switch to a new price at a moment you pick.",
    ttScheduleNewPrice: "New price ($)",
    ttScheduleAt: "Changes at",
    ttScheduleReadback: "Changes to {price} on {when}",
    ttScheduleZoneNote: "Times are on the event’s clock ({timeZone}).",
    ttSchedulePastWarning:
      "That moment has already passed, so the new price applies immediately.",
    ttScheduleTimezonePending:
      "Loading the event’s timezone — the change time can’t be set until it arrives.",
    ttScheduleIncompleteTitle: "Finish the scheduled price change",
    ttSchedulePriceRequiredMessage:
      "Enter the price the ticket changes to, or switch off “Price changes later”.",
    ttScheduleAtRequiredMessage:
      "Choose when the new price takes effect, or switch off “Price changes later”.",
    ttScheduleAtInvalidMessage:
      "That date and time couldn’t be read. Pick it again.",
    // Past tense for a flip that has ALREADY fired. Same arguments as
    // `ttScheduleReadback` so the two stay swappable at the call site.
    ttScheduleReadbackApplied: "Changed to {price} on {when}",
    // Sits beside the headline price once a flip has fired, naming the stored
    // list price the tier used to sell at.
    ttPriceWas: "was {price}",

    // ── Sales window (TicketSalesWindowField, FR-013) ──
    // `{when}` and the summary `{opens}`/`{closes}` always arrive PRE-FORMATTED
    // in the EVENT's timezone with a zone abbreviation ("Fri, Oct 9, 10:00 AM
    // CDT"). Never an ICU date skeleton, which would format in the READER's
    // zone and quietly undo the one check the organizer can make.
    ttWindowToggle: "Limit when this tier is on sale",
    // Short, because it sits under an unchecked box in the common case. It has
    // to carry one fact the labels alone don't: either field on its own is a
    // complete answer.
    ttWindowHelp: "Set an opening time, a closing time, or both.",
    ttWindowOpensAt: "On sale from",
    ttWindowClosesAt: "Stops selling",
    ttWindowOpensReadback: "Opens {when}",
    ttWindowClosesReadback: "Closes {when}",
    // The half-open boundary, in plain language. `salesCloseAt` is EXCLUSIVE,
    // so this is the difference between an advance/door pair that hands over
    // cleanly and one with a minute-long dead zone or an overlap.
    ttWindowBoundaryNote:
      "Selling stops the moment the closing time arrives — set 6:00 PM and the last sale is 5:59 PM. Another tier opening at 6:00 PM picks up with no gap and no overlap.",
    ttWindowZoneNote: "Times are on the event’s clock ({timeZone}).",
    ttWindowTimezonePending:
      "Loading the event’s timezone — the sales window can’t be set until it arrives.",
    ttWindowInvalidTitle: "Check the sales window",
    // TWO messages, not one, because they are two different mistakes with two
    // different fixes — and one string describing both was WRONG for whichever
    // one the organizer was actually in. The old wording ("…A tier that opens
    // and closes at the same moment can never sell.") shipped on an INVERTED
    // pair and told the organizer they had set the same moment twice, which
    // they had not. `classifySalesWindowOrder` tells the two apart; the copy
    // now follows it.
    //
    // Both are shown INLINE while typing as well as in the submit toast, so the
    // wording has to work in both places.
    ttWindowOrderMessage:
      "This tier is set to stop selling before it opens. The opening time has to be earlier than the closing time.",
    // With an EXCLUSIVE closing bound, "same moment" is an empty window — the
    // tier would look fully configured and never sell a single ticket.
    ttWindowZeroWidthMessage:
      "This tier opens and closes at the same moment, so it could never sell a ticket. Move the closing time later.",
    ttWindowEmptyMessage:
      "Choose when this tier opens, when it stops selling, or both — or switch “Limit when this tier is on sale” back off.",
    ttWindowOpenInvalidMessage:
      "That opening date and time couldn’t be read. Pick it again.",
    ttWindowCloseInvalidMessage:
      "That closing date and time couldn’t be read. Pick it again.",
    // Ticket-list summaries. Four keys rather than one built by concatenation:
    // a window may have one bound or two, and a closing bound that has already
    // passed must not read as a promise the tier is still keeping.
    ttWindowSummaryRange: "On sale {opens} – {closes}",
    ttWindowSummaryFrom: "On sale from {opens}",
    ttWindowSummaryUntil: "On sale until {closes}",
    ttWindowSummaryEnded: "Sales ended {closes}",

    // ── Event time zone (Essentials date fields + quick create) ──
    // The zone is never silently swapped: picking a venue adopts that venue's
    // zone, and the note says so, because on an already-saved event adopting a
    // new zone moves the show.
    ebTimezoneNote: "Start and end times are in {timezone}.",
    ebTimezoneVenueNote:
      "Start and end times are in {timezone} — the place’s local time.",
    ebTimezoneAdoptedNote:
      "Time zone set to {timezone}, the local time at {venue}. The times you entered keep the same clock reading, so 8:00 PM means 8:00 PM at the place.",
    // Freeform-address variants of the two above. Same rule, same
    // interpretation — but an address has no name worth repeating back at the
    // organiser, so these name the source generically instead of leaving a
    // blank where {venue} would go.
    ebTimezoneAddressNote:
      "Start and end times are in {timezone} — the local time at this address.",
    ebTimezoneAdoptedAddressNote:
      "Time zone set to {timezone}, the local time at this address. The times you entered keep the same clock reading, so 8:00 PM means 8:00 PM at the address.",

    // ── Event provenance breadcrumb (Build surface) ──────────────────
    // Only rendered on an event that actually came from a booking. The two
    // sentence keys MUST stay a pair and MUST keep identical arguments:
    // `senderDisplayName` is always the ACT, but under TO_VENUE the act is the
    // one who asked and under TO_PERFORMER the act is the one who was asked.
    // One sentence for both directions states the relationship backwards half
    // the time. `ebProvActFallback` substitutes for {name} when the act's name
    // doesn't resolve, so the DIRECTION survives a missing name.
    ebProvLabel: "From a booking",
    ebProvActFallback: "a performer",
    ebProvFromAct: "This event came from a booking request from {name}.",
    ebProvToAct: "This event came from a booking request sent to {name}.",
    ebProvAgreementOnly: "This event is linked to a booking agreement.",
    ebProvDraftNote: "The agreement isn’t finalized onto this event yet.",
    // ACTIVITY, not "message". `lastMessageAt` is bumped by every LEDGER entry
    // too (`appendBookingSystemEntry`), not just by a human message — merely
    // opening the request, or saving a title change on this very event, moves
    // it. "Last message" would then name a message nobody sent.
    ebProvLastActivity: "Last activity {date}",
    // The requester's banner (venue-confirmation spec, "Requester's admin"):
    // shown on a requester-owned event the venue has confirmed. The fallback
    // noun stands in for {place} when the place row is gone.
    ebProvVenueConfirmed:
      "Confirmed by {place}. Finish the details and publish when ready.",
    ebProvVenueFallback: "the place",
    ebProvViewAgreement: "View agreement",
    ebProvOpenThread: "Open booking thread",
    // The agreed-terms summary. "LISTED", not "agreed": `payoutLineCount`
    // counts every line on the terms, declined and countered ones included.
    ebProvAgreementLabel: "Agreement",
    ebProvDateLabel: "Date",
    ebProvGuaranteeLabel: "Guarantee",
    ebProvTermsLabel: "Terms",
    ebProvPayoutLines:
      "{count, plural, one {# payout line listed} other {# payout lines listed}}",

    // ── Event-first venue booking (venue-confirmation spec, "Event builder") ──
    // Only a THIRD PARTY at a venue sees these: owners and grant-holders keep
    // the plain picker. The three intent labels match the venue page's CTAs
    // ("Play here" / "Rent or use a space") so the two surfaces share a
    // vocabulary; "Request to book" is the dialog's title, not a control.
    ebIntentLabel: "Book this place for",
    ebIntentPlay: "Play here",
    ebIntentRent: "Rent a space",
    ebIntentUse: "Use a space",
    ebIntentUnavailableHint:
      "Disabled options aren\u2019t offered by this place.",
    ebCalendar: "Calendar",
    // The cascade stopped choosing a room (owner ruling: the request is for a
    // date on a calendar; the room is settled at accept/confirm). It PRINTS
    // the calendar's rooms instead. `ebSpace`, `ebSpaceLetVenueChoose`,
    // `ebSpaceOptionalHint` and `ebSpaceRequired` now have no callers and can
    // be swept.
    ebSpace: "Space",
    ebSpaceLetVenueChoose: "Let the place choose",
    ebSpaceOptionalHint: "Leave it blank and the place picks the room.",
    ebSpaceRequired: "Choose a space to rent or use.",
    ebRooms: "Rooms: {rooms}",
    ebRoomsHint: "The place picks the room when it accepts.",
    ebCalendarRequired: "Pick a calendar for this place.",
    // `{rate}` is a pre-formatted money string (Money.format), never a number.
    ebRentalRate: "{rate} per booking",
    ebVenueNotTakingRequests:
      "This place isn\u2019t taking requests through Ithas Fire yet \u2014 it\u2019ll show as an address on your event.",
    // NOT "and space" — the space picker went with the 2026-09-22 ruling, and
    // the line directly above this one says the venue picks the room. The two
    // sentences contradicted each other on screen.
    ebPlacementEditLater:
      "The start time can still be changed after the request is sent.",
    // Grouped venue search (PlacePicker in the builder).
    ebVenueSearchYours: "Your places",
    ebVenueSearchAll: "All places",
    ebVenueSearchAdd: "Add a place",
    ebVenueSearchTypeToSearch:
      "Type at least two characters to search all places.",
    ebVenueLoadFailed: "Couldn\u2019t load that place. Try again.",
    // The tie band: where the venue's confirmation of THIS event stands. Each
    // state's first line STARTS with the venue so the name reads first; the
    // fallback noun (`ebProvVenueFallback`) stands in for {place}.
    ebReqKicker: "Place confirmation",
    ebReqSent: "{place} has your request.",
    ebReqParked:
      "{place} hasn\u2019t claimed its page yet \u2014 we\u2019ve asked them to.",
    ebReqAddressOnly:
      "Your event shows an address only until they confirm.",
    ebReqConfirmed: "{place} confirmed this event.",
    ebReqConfirmedNote:
      "The place\u2019s name and link now show on your event page.",
    ebReqWithdrawn: "{place} withdrew its confirmation.",
    ebReqWithdrawnNote:
      "Your event shows an address only. They can confirm it again.",
    ebReqOpen: "Open the request",
    // The save's "your request wasn't sent" notice (`EventFirstSkipNotice`):
    // the venue refused the ask at the server's gates and the event saved
    // address-only. A WARNING, not an error. The venue reads first, as in
    // the band; the sentence-initial fallback stands in for {place}. The
    // performer case is the sender's to fix, so it does not name the venue.
    ebReqSkipKicker: "Request not sent",
    ebReqSkipVenueFallback: "This place",
    ebReqSkipNoHours:
      "{place} hasn’t set its opening hours yet, so your request wasn’t sent.",
    ebReqSkipNoHoursNote:
      "Your event is saved. Ask them directly, or try again once they’ve set hours.",
    ebReqSkipDate:
      "{place} isn’t open on that date, so your request wasn’t sent.",
    ebReqSkipDateNote:
      "Your event is saved. Pick another date or ask them directly.",
    ebReqSkipNotTaking:
      "{place} isn’t taking requests right now, so your request wasn’t sent.",
    ebReqSkipNotTakingNote: "Your event is saved.",
    ebReqSkipPerformer:
      "Turn on performer mode to ask places from the builder.",
    ebReqSkipPerformerNote: "Your event is saved.",
    ebReqSkipPerformerLink: "Performer settings",
    // The thread's next-step slot on a REQUESTER-owned event (RENT / USE):
    // the venue's shell cannot open that draft, so the slot says where it
    // is instead of linking it. Reads under the `bkInboxEventLinkedKicker`.
    bkInboxEventRequesterOwnedNote:
      "The draft lives in the requester\u2019s admin. They finish and publish it there.",

    // \u2500\u2500 Payouts (/admin/<slug>/payouts) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // The organiser's ledger statement. The batch runs once a night \u2014 the
    // copy never names a clock time or a weekday. A missing number is never
    // a zero: the verdict goes blank, the data stays. The subtitle says
    // "after each sale matures" so the nightly run does not read against the
    // schedule card; "after" is a lower bound, not a promise of that night.
    navPayouts: "Payouts",
    payoutsTitle: "Payouts",
    payoutsSubtitle: "In {currency}",
    payoutsLoadFailed: "Couldn\u2019t load payouts",
    payoutsOwedLabel: "Owed to you",
    payoutsReadyLabel: "Ready now",
    payoutsReadyDebtSub: "Debt \u00b7 repaid from upcoming dates",
    payoutsSendLabel: "We send it",
    payoutsSendSub: "Next nightly run · before any holds or fees",
    payoutsSendSubNight:
      "Next run: the night of {date}, Central time · before any holds or fees",
    payoutsSendSubBlocked:
      "Not sent until your Stripe account can receive payouts · the balance stays yours",
    payoutsSendBelowReason: "under the minimum",
    payoutsCantSay: "Can\u2019t say",
    payoutsCouldntCheck: "Couldn\u2019t check",
    payoutsMinimumLabel: "Payout minimum",
    payoutsMinimumOf: "{payable} of {minimum}",
    payoutsMinimumUnresolvedNote:
      "Couldn\u2019t read the payout minimum, so we can\u2019t say if it\u2019s cleared. Owed to you is still right.",
    payoutsOverdueRow: "Last payout \u00b7 Overdue \u00b7 none sent",
    payoutsOverdueNote:
      "It cleared the minimum and should have gone out. We\u2019re looking into it; you don\u2019t need to do anything, and the money is still yours.",
    payoutsReconcileTruncated:
      "Next {shown} of {total} dates. Owed to you covers all {total}.",
    payoutsReconcileUnresolved:
      "Couldn\u2019t load the dates behind this balance. Owed to you is still right.",
    payoutsReconcileEmpty: "Nothing is waiting to mature; all of it is ready.",
    payoutsNextChip: "Next",
    payoutsLineOrders:
      "{date} \u00b7 {count, plural, one {# order} other {# orders}}",
    payoutsLineOrdersNoDate: "{count, plural, one {# order} other {# orders}}",
    payoutsLineUnattributed: "Sales not tied to an event",
    payoutsLineUnnamed: "Sales (event name unavailable)",
    payoutsDebtCaption:
      "\u2212 {debt} goes to a refund from an earlier event \u00b7 we\u2019ll send {expected}",
    payoutsHoldCaption:
      "{held} held for a dispute \u00b7 already left out of Ready now",
    payoutsLinesUnresolved: "Couldn\u2019t load the sales behind this date",
    payoutsLinesMore: "and {count} more",
    payoutsTodayLine: "Today \u00b7 {date} \u00b7 balance {balance}",
    // Board B "Answer first" (owner 2026-10-14): the answer sentence, the
    // minimum as one fact line, "Coming up", and the incomplete-Stripe banner.
    payoutsAnswerLabelTonight: "We send it \u00b7 tonight",
    payoutsAnswerLabelOnHold: "We send it \u00b7 on hold",
    payoutsAnswerSends: "{amount} goes to your Stripe account tonight.",
    payoutsAnswerSendsNothing: "{amount} goes out tonight.",
    payoutsAnswerLaterBy: "{amount} more ready by {date}.",
    payoutsAnswerLater: "{amount} more maturing.",
    // No run night from the server: no "tonight" anywhere in the answer.
    payoutsAnswerNextRun: "{amount} goes out in the next run.",
    payoutsAnswerUnknownNextRun: "We can\u2019t say yet what goes out in the next run.",
    payoutsAnswerWaitingForStripe: "{amount} is ready and waiting for Stripe.",
    payoutsAnswerUnknown: "We can\u2019t say yet what goes out tonight.",
    payoutsMinimumFactClear: "Minimum {minimum} \u00b7 clear",
    payoutsComingUpHeading: "Coming up",
    payoutsStripeIncompleteTitle: "Stripe account \u00b7 Incomplete",
    payoutsStripeIncompletePaused:
      "Payouts are paused until Stripe has a few more details.",
    payoutsStripeIncompletePausedShort: "Payouts are paused.",
    payoutsStripeIncompleteNeedsDetails: "Stripe still needs a few more details.",
    payoutsStripeStateCharges: "Charges",
    payoutsStripeStatePayouts: "Payouts",
    payoutsStripeStateDetails: "Details",
    payoutsStripeStateOn: "on",
    payoutsStripeStateOff: "off",
    payoutsStripeStateSubmitted: "submitted",
    payoutsStripeStateNotSubmitted: "not submitted",
    payoutsStripeStillNeeded: "Still needed:",
    // Board B Settings band + ledger preview (2026-10-14).
    payoutsSettingsHeading: "Settings",
    payoutSchedChange: "Change schedule",
    payoutSchedSeeAll: "See all schedules",
    payoutSchedNoneYet: "Not chosen yet",
    payoutSchedSameCost: "Every schedule costs the same.",
    payoutSchedTimingLine:
      "Released at midnight CT once the sale\u2019s funds clear (2 business days), so door sales trail by a few days. Your bank gets it on Stripe\u2019s schedule.",
    payoutSchedLoadFailed: "Couldn\u2019t load your payout schedule.",
    payoutSchedAsapShort:
      "Released the day after your event ends, or once that sale\u2019s funds clear, whichever is later.",
    payoutSchedWeekOfShort: "Released on the Sunday of your event\u2019s week.",
    payoutSchedOneWeekShort: "Released the Sunday after the event week.",
    payoutSchedTwoWeeksShort: "Released 2 Sundays after the event week.",
    payoutSchedFourWeeksShort: "Released 4 weeks after the event week.",
    payoutsStripeLineOn: "Payments and payouts on",
    payoutsStripeDetails: "Details",
    payoutsStripeDetailsName: "Stripe account details",
    payoutsLedgerShowAll: "Show all entries",
    payoutsLedgerShowFewer: "Show fewer entries",
    payoutsLedgerHeading: "Ledger",
    payoutsLedgerNewestFirst: "Newest first",
    payoutsLedgerColDate: "Date",
    payoutsLedgerColEntry: "Entry",
    payoutsLedgerColChange: "Change",
    payoutsLedgerColBalance: "Balance",
    payoutsLedgerEmpty: "No entries yet.",
    payoutsLedgerBalancesUnresolved:
      "Balances couldn\u2019t be computed just now",
    payoutsLedgerLoadMore: "Load more",
    payoutsLedgerMoreNotShown:
      "Older entries aren\u2019t shown here. Download CSV has the full history.",
    payoutsLedgerDownloadCsv: "Download CSV",
    payoutsLedgerDownloadPreparing: "Preparing\u2026",
    payoutsLedgerDownloadFailed: "Couldn\u2019t build the file. Try again.",
    payoutsLedgerCsvColDate: "Date",
    payoutsLedgerCsvColType: "Type",
    payoutsLedgerCsvColDescription: "Description",
    payoutsLedgerCsvColOrder: "Order",
    payoutsLedgerCsvColEvent: "Event",
    payoutsLedgerCsvColAmount: "Amount",
    payoutsLedgerCsvColChange: "Change",
    payoutsLedgerCsvColBalanceAfter: "Balance after",
    payoutsLedgerCsvColAvailableFrom: "Available from",
    payoutsLedgerCsvColCurrency: "Currency",
    payoutsLedgerUnavailable:
      "Couldn\u2019t load the ledger. The balance above is still right.",
    payoutsLedgerStale:
      "Couldn\u2019t refresh the ledger. These rows are from the last load.",
    payoutsReserveHeld: "{amount} held in reserve",
    payoutsDisputeHeld: "{amount} held for open disputes",
    payoutsEntrySalesCredit: "Sales credit",
    payoutsEntryRefund: "Refund",
    payoutsEntryPayoutSent: "Payout sent",
    payoutsEntryDisputeLost: "Dispute lost",
    payoutsEntryDisputeReleased: "Dispute released",
    payoutsEntryTransferReversed: "Transfer reversed",
    payoutsEntryDisputeHold: "Dispute hold",
    payoutsEntryReserveHold: "Reserve hold",
    payoutsEntryReserveRelease: "Reserve released",
    payoutsEntryAdjustment: "Adjustment",
    // Key names predate the 2026-10-08 ruling (cash = no platform fee); see
    // ledger-entry-presentation.ts. A debit before it was fee + tax, one
    // after it is tax only, so the copy names what is owed without "fee".
    payoutsEntryCashSaleFees: "Cash sales: amount owed",
    payoutsEntryCashSaleRefunded: "Cash sale refunded",
    payoutsEntryHeld: "{amount} held",
    payoutsEntryReleased: "{amount} released",
    payoutsEntryOrder: "Order #{code}",
    payoutsOtherCurrencies:
      "This shows {currency} only; you also hold {count, plural, one {# other currency} other {# other currencies}}.",
    payoutsHumanNextArrival: "Next to mature: {date} \u00b7 {amount}",
    payoutsHumanNothingUpcoming: "Nothing is waiting to mature.",
    payoutsHumanArrivalUnresolved:
      "Couldn\u2019t check what\u2019s coming next.",
    // Payments merged into this page (2026-10-05): four sections in a fixed
    // order, each a rail child and a phone jump chip. Ledger reuses
    // `payoutsLedgerHeading`.
    payoutsSectionBalance: "Balance",
    payoutsSectionSchedule: "Payout schedule",
    payoutsSectionStripe: "Stripe account",
    payoutsChipSchedule: "Schedule",
    payoutsChipStripe: "Stripe",
    payoutsSectionIndexLabel: "Sections on this page",
    payoutsNothingYet: "Nothing yet.",
    payoutsStripeSetupInBalance: "Stripe setup is at the top of the page.",
    payoutsGoToBalance: "Go to Balance",
    payoutsStripeOverrideNote:
      "This test server can turn on what Stripe hasn\u2019t. The rows above show only what Stripe itself reports. The live site never does this.",
    payoutsStatusUnknown: "Unknown",
    payoutScheduleSetupRequiredBelow:
      "Finish Stripe setup under Stripe account below to choose one.",
    payoutScheduleSetupRequiredTop:
      "Finish Stripe setup at the top of the page to choose one.",
    payoutsStripeRefreshFailed:
      "Couldn\u2019t refresh Stripe status. This is the last one loaded.",
    // ── Payouts page copy pass (2026-10-06): schedule, Stripe and terms
    // strings that used to be hard-coded English, plus glossary rewrites
    // (no "settlement", "payable" is not "balance", no page named Payments).
    payoutSchedAsapTitle: "As soon as possible",
    payoutSchedAsapBody:
      "The day after your event ends, or when that sale\u2019s funds clear, whichever is later. Fastest, with the least time for refund requests.",
    payoutSchedWeekOfTitle: "Week of event",
    payoutSchedWeekOfBody:
      "The Sunday of your event\u2019s week. Saturday and Sunday events move to the next Sunday, since a day or two is too short a refund window.",
    payoutSchedOneWeekTitle: "1 week after",
    payoutSchedOneWeekBody:
      "The Sunday after the event week. A short buffer for refund requests.",
    payoutSchedTwoWeeksTitle: "2 weeks after",
    payoutSchedTwoWeeksBody:
      "2 Sundays after the event week. A longer refund window, and steadier cash flow across a series of events.",
    payoutSchedFourWeeksTitle: "~1 month after",
    payoutSchedFourWeeksBody:
      "4 weeks after the event week. The most time for refunds, and the easiest to reconcile for large events.",
    payoutSchedAppliesToNew:
      "Applies to events created after you save. Earlier events keep their schedule.",
    payoutSchedCurrent: "Current",
    payoutSchedSave: "Save schedule",
    payoutSchedSaved: "Payout schedule updated",
    payoutSchedSaveFailed: "Couldn’t update the payout schedule",
    payoutsStatusEnabled: "Enabled",
    payoutsStatusDisabled: "Disabled",
    payoutsStripeSetupTitle: "Set up Stripe to get paid",
    payoutsStripeSetupBody:
      "Connect Stripe to sell tickets and get paid. Stripe checks your identity during setup.",
    payoutsStripeLoadFailed: "Couldn’t load your Stripe account status.",
    payoutsTermsStillNeeded: "Accept these terms before starting Stripe setup.",
    payoutsTermsAcceptedLine: "{title} {version} · accepted {date}",
    payoutsTermsRead: "Read terms",
    payoutsTermsChecking: "Checking whether these terms are already accepted\u2026",
    payoutsTermsHide: "Hide terms",
    payoutsTermsIntro: "These cover chargebacks and payout holds.",
    payoutsTermsOrgOnly:
      "Only an owner or admin can accept these terms for this group.",
    payoutsTermsRequiredNote: "Required before your payouts can be set up.",
    payoutsBelowMinimumReadyNote:
      "Under the minimum, so it waits until what\u2019s ready reaches {minimum}.",
    payoutsReadyUnresolvedNote:
      "Couldn\u2019t read what\u2019s ready, so we can\u2019t say if it clears the minimum. Owed to you is still right.",
    payoutsRoleNoticeMoney:
      "Only owners, admins and finance members can see this.",
    payoutsRoleNoticeAccount:
      "Only owners, admins, editors and finance members can see this.",
    ebPayoutManageInPayouts: "Manage in Payouts",
    ttSetUpPayouts: "Set up payouts",
    payoutAckOpenWorkspace: "Open your workspace",
    ebPayoutSchedAsapNextDay: "Day after the event (fastest)",
    emPayoutLabel: "Payout",
    ttStripeRequiredTitle: "Paid tickets need a connected Stripe account",
    ttStripeRequiredBody:
      "Stripe takes the buyer\u2019s payment and sends them a receipt, and your Stripe account is where we send your payouts. Setup takes a few minutes, and you only do it once for this group.",
    ttStripeRequiredDismiss: "Dismiss",
    // ── Seat prices (/admin/[slug]/events/[id]/seat-prices) ──────────────
    // The organizer gives single seats a custom price. Glossary
    // (CONTEXT.md): "Custom price" and "Section price", never "override".
    // The note is private to people who can edit the event, and
    // `seatPricesNoteLabel` is the one key that names it (column head and
    // field label). Apostrophes are typographic (’) so ICU never reads one
    // as a quote.
    seatPricesTitle: "Seat prices",
    seatPricesPurpose:
      "Each section sells at its ticket type’s price. Select seats to give them a custom price.",
    seatPricesViewLabel: "View",
    seatPricesViewMap: "Map",
    seatPricesViewList: "List",
    // The map (Map view).
    seatPricesMapLabel: "Seat map",
    seatPricesMapHintMouse: "Drag across seats to select. Hold Shift to add.",
    seatPricesMapHintTouch: "Tap a seat to select. Drag to move, pinch to zoom.",
    seatPricesMapHintKeys:
      "Arrow keys move between seats. Enter or Space selects one.",
    // A seat's accessible name: "Balcony, seat P4, $35.00".
    seatPricesMapSeatAria: "{section}, seat {seat}, {price}",
    seatPricesMapSeatCustom: "Custom price",
    seatPricesMapSeatOffEvent: "Not a seat of this event.",
    seatPricesMapLegendAvailable: "Available",
    seatPricesMapLegendSelected: "Selected",
    seatPricesMapLegendCustom: "Custom price",
    seatPricesMapLegendLocked: "Sold or in a cart: price can’t change",
    seatPricesMapLoading: "Loading the map…",
    seatPricesMapFailedTitle: "The map didn’t load",
    seatPricesMapFailedBody: "Every seat is still in the List.",
    seatPricesMapShowList: "Show the List",
    seatPricesMapApproximate: "No saved seat positions: seats are shown in rows.",
    seatPricesMapPositionsFailedTitle: "Seat positions didn’t load",
    seatPricesMapPositionsFailedBody:
      "Seats are shown in rows inside their sections for now. Every seat is in the List.",
    seatPricesPanelEmptyBodyMap:
      "Pick seats on the map, or switch to List to tick a whole row.",
    seatPricesSectionCount:
      "{count, plural, one {# section} other {# sections}}",
    seatPricesSeatCount: "{count, plural, one {# seat} other {# seats}}",
    seatPricesCustomPriceCount:
      "{count, plural, one {# custom price} other {# custom prices}}",
    seatPricesLoading: "Loading seats…",
    seatPricesLoadErrorTitle: "The seats didn’t load",
    seatPricesRetry: "Try again",
    seatPricesForbiddenTitle: "You can’t edit seat prices for this event",
    seatPricesForbiddenBody:
      "Ask someone who manages this event to give you edit access.",
    seatPricesEmptyTitle: "This event has no seats",
    seatPricesEmptyBody:
      "Seats come from a seating map. Add one in the event’s Tickets section, then come back to price single seats.",
    seatPricesEmptyAction: "Open the event editor",
    seatPricesDismiss: "Dismiss",
    seatPricesSectionsLabel: "Sections",
    seatPricesSelectionBarLabel: "Selected seats",
    // The list: a section band, then one table per row.
    seatPricesCustomCount: "{count} custom",
    seatPricesSelectedShort: "{count} selected",
    seatPricesNotOnMap: "not on the map",
    seatPricesNotOnMapUseList: "not on the map, use List",
    seatPricesSectionPriceLabel: "Section price",
    seatPricesSectionPriceFrom: "from {ticketType}",
    seatPricesSectionPriceFromSeveral: "from {count} ticket types",
    seatPricesPriceRange: "{min} to {max}",
    seatPricesSectionOffPayWhatYouWant:
      "Pay what you want. Custom prices are off here.",
    seatPricesSectionOffNoFixed:
      "No fixed-price ticket type. Custom prices are off here.",
    seatPricesColStatus: "Status",
    seatPricesColPrice: "Price",
    seatPricesNoteLabel: "Note",
    seatPricesRowName: "Row {row}",
    seatPricesNoRowName: "Seats without a row",
    // Accessible names of the row and seat checkboxes. The section leads so
    // "Row A" in two sections never reads the same.
    seatPricesSelectRowAria: "{section}, {row}",
    seatPricesSelectSeatAria: "{section}, seat {seat}",
    seatPricesStatusAvailable: "Available",
    seatPricesStatusHeld: "In a cart",
    seatPricesStatusSold: "Sold",
    seatPricesStatusBlocked: "Blocked",
    // Shown beside the status, so neither repeats it.
    seatPricesLockedSold: "Price stays.",
    seatPricesLockedHeld: "Try again in a few minutes.",
    seatPricesCustomTag: "Custom",
    seatPricesSectionPriceWas: "section {price}",
    seatPricesPayWhatYouWant: "Pay what you want",
    seatPricesUnreadableTag: "Can’t be sold",
    seatPricesUnreadableRow: "Stored price can’t be read.",
    // The price panel (sidebar on a desktop, bottom sheet on a phone).
    seatPricesPanelEmptyTitle: "No seats selected",
    seatPricesPanelEmptyBody:
      "Tick seats in the list, or a whole row, to give them a custom price.",
    seatPricesSelectedCount:
      "{count, plural, one {# seat selected} other {# seats selected}}",
    seatPricesClearSelection: "Clear selection",
    seatPricesSeatName: "Seat {seat}",
    seatPricesRowsList: "Rows {rows}",
    seatPricesCustomPriceLabel: "Custom price ({symbol})",
    seatPricesCustomPriceUnavailable: "Not available",
    seatPricesFreeSeatHint:
      "{count, plural, one {{zero} makes this a free seat.} other {{zero} makes these free seats.}} A free ticket carries no fee.",
    seatPricesNoteHint:
      "Buyers never see the note. Anyone who can edit this event does.",
    seatPricesReplacesOne:
      "{count, plural, one {Replaces {ticketType} ({price}) for this seat.} other {Replaces {ticketType} ({price}) for these # seats.}} Buyers see and pay the custom price.",
    seatPricesReplacesBoth:
      "{count, plural, one {Replaces both ticket types for this seat:} other {Replaces both ticket types for these # seats:}}",
    seatPricesReplacesAll:
      "{count, plural, one {Replaces all {types} ticket types for this seat:} other {Replaces all {types} ticket types for these # seats:}}",
    seatPricesWhicheverType:
      "{count, plural, one {Whichever ticket type a buyer picks, this seat costs {price}.} other {Whichever ticket type a buyer picks, these seats cost {price}.}}",
    seatPricesOffTitle: "Custom prices are off in {section}.",
    seatPricesOffPayWhatYouWantBody:
      "Buyers name their own price here ({ticketTypes}, Pay what you want), so a custom price would never be charged.",
    seatPricesOffNoFixedBody:
      "A custom price replaces a fixed ticket price, and no fixed-price ticket type sells this section. Add one to the section first.",
    seatPricesOffMixedHint:
      "To set a price for the other seats, untick the seats in the sections named above.",
    seatPricesPaidStripeTitle: "A paid seat in {section} needs payouts.",
    seatPricesPaidStripeBody:
      "To charge for a seat here, set up payouts first so the money has somewhere to go. {zero} works now.",
    // Payouts exist but no fee policy covers the event: the organizer has
    // nothing to set up, so this says who does and how to reach them.
    seatPricesPaidFeePolicyTitle: "Paid seats aren’t available in {section} yet.",
    seatPricesPaidFeePolicyBody:
      "That takes a setting on our side, and there is nothing for you to change. Contact us and we’ll set it up. {zero} works now.",
    seatPricesContactUs: "Contact us",
    seatPricesPaidBlockedError: "Only {zero} can be saved here for now.",
    seatPricesUnreadableTitleOne: "This seat can’t be sold right now.",
    seatPricesUnreadableTitleMany:
      "{count} of these seats can’t be sold right now.",
    seatPricesUnreadableBody:
      "{count, plural, one {Its stored price can’t be read.} other {Their stored prices can’t be read.}} Set a price or use the section price to fix it.",
    seatPricesScheduledTitle: "{ticketType} changes to {price} on {when}.",
    seatPricesScheduledTitleNoDate:
      "{ticketType} has a scheduled change to {price}.",
    seatPricesScheduledBody:
      "Seats with a custom price keep that price. Change them here if they should move too.",
    seatPricesSetPrice: "Set price",
    seatPricesUseSectionPrice: "Use section price",
    seatPricesSaving: "Saving…",
    seatPricesPriceInvalid: "Enter a price like 60.00.",
    seatPricesPriceAmbiguous:
      "Write it with cents, like 1500.00 or 12.35, so the amount is clear.",
    seatPricesPriceNegative: "A price can’t be below {zero}.",
    seatPricesPriceTooPrecise: "Use at most two decimal places.",
    seatPricesPriceTooLarge: "A price can’t be more than {max}.",
    seatPricesOpenPanelAria:
      "{count, plural, one {Set price for the # selected seat} other {Set price for the # selected seats}}",
    seatPricesReplacesBySection:
      "Each seat’s custom price replaces the ticket types of its own section:",
    seatPricesNoteWillReplace:
      "{count, plural, one {One selected seat has a note. Saving replaces it.} other {# selected seats have a note. Saving replaces them.}}",
    seatPricesNoteWillRemove:
      "{count, plural, one {One selected seat has a note. Saving with an empty note deletes it.} other {# selected seats have a note. Saving with an empty note deletes them.}}",
    seatPricesClearConfirmTitle: "Use the section price?",
    seatPricesClearConfirmBody:
      "{count, plural, one {# seat loses its custom price} other {# seats lose their custom price}}, and {notes, plural, one {# private note is} other {# private notes are}} deleted. This can’t be undone.",
    seatPricesCancel: "Cancel",
    seatPricesRefreshFailedTitle: "The list couldn’t refresh.",
    seatPricesRefreshFailedBody:
      "It may still show prices from before your last change. Try again to load the current prices.",
    // An event that is cancelled, completed or archived opens read-only.
    seatPricesClosedTitle: "This event has ended.",
    seatPricesClosedCancelledTitle: "This event was cancelled.",
    seatPricesClosedBody: "Seat prices can no longer change.",
    seatPricesClosedNone:
      "No seat had a custom price. Every seat used its section price.",
    seatPricesClosedRest: "Every other seat used its section price.",
    // The save result. A skip is always named with its count and its cause.
    seatPricesResultSet:
      "{count, plural, one {# seat updated to {price}.} other {# seats updated to {price}.}}",
    seatPricesResultCleared:
      "{count, plural, one {# seat now uses the section price.} other {# seats now use the section price.}}",
    seatPricesResultNoneChanged: "No seats were changed.",
    seatPricesResultNothingSaved: "Nothing was saved.",
    seatPricesResultSkipped: "{count} skipped: {causes}.",
    seatPricesSkipSold: "{count} sold",
    seatPricesSkipHeld: "{count} in someone’s cart",
    seatPricesSkipBusy: "{count} being bought or edited right now",
    seatPricesSkipNotFound: "{count} no longer part of this event",
    seatPricesSkipSoldDetail:
      "{count, plural, one {The sold seat keeps its price.} other {Sold seats keep their price.}}",
    seatPricesSkipHeldDetail:
      "{count, plural, one {The seat in a cart can change once that checkout ends, usually within minutes.} other {Seats in a cart can change once those checkouts end, usually within minutes.}}",
    seatPricesSkipBusyDetail:
      "{count, plural, one {One seat was being bought or edited at that moment. Try again.} other {# seats were being bought or edited at that moment. Try again.}}",
    seatPricesSkipNotFoundDetail:
      "{count, plural, one {One seat is no longer a seat of this event.} other {# seats are no longer seats of this event.}}",
    seatPricesResultNotSaved:
      "{count, plural, one {# seat was not saved. It is still selected, so you can try again.} other {# seats were not saved. They are still selected, so you can try again.}}",
    // The error, on its own line under the result.
    seatPricesResultReason: "Reason: {reason}",
  },

  // ── Admin memberships (/admin/[slug]/memberships) ──────────────────────
  // Open to any payee — no locked state. The two policy statements
  // (policyFee* / policyDispute*) are spec-mandated setup copy
  // (docs/specs/2026-08-05/completed/recurring-memberships.spec.md): the owner must
  // have ACTIVELY seen them, so they render in the empty state AND persist
  // as a compact note once tiers exist. Don't reword them casually.
  adminMemberships: {
    title: "Memberships",
    loading: "Loading memberships…",
    createTier: "Create tier",
    createFirstTier: "Create your first tier",
    // Setup / empty state
    setupEyebrow: "Recurring memberships",
    setupTitle: "Steady support from the people who love what you do",
    setupIntro:
      "Offer membership tiers billed monthly or yearly. We take 0% — member payments reach you minus only Stripe's processing fees — and benefits apply automatically when members buy tickets.",
    policyNoteHeading: "Payout policies",
    policyFeeTitle: "The $2 payout fee",
    policyFeeBody:
      "Free in any month you sell tickets; otherwise we deduct the $2 Stripe charges us to pay you.",
    policyDisputeTitle: "Chargebacks",
    policyDisputeBody:
      "If a member disputes a charge, the disputed amount plus the card network's dispute fee is deducted from your payouts.",
    // Table
    tierColumn: "Tier",
    priceColumn: "Price",
    statusColumn: "Status",
    membersColumn: "Members",
    benefitsColumn: "Benefits",
    statusDraft: "Draft",
    statusActive: "Active",
    statusArchived: "Archived",
    priceMonthly: "{price}/month",
    priceYearly: "{price}/year",
    benefitsCount:
      "{count, plural, =0 {None} one {# benefit} other {# benefits}}",
    // Row actions
    actionEdit: "Edit",
    actionPublish: "Publish",
    actionArchive: "Archive",
    actionCopyJoinLink: "Copy join link",
    actionBenefits: "Manage benefits",
    // Publish
    publishConfirmTitle: "Publish this tier?",
    publishConfirmBody:
      "Publishing creates the Stripe billing product and opens the tier to new members at {price}. The price can't change once someone joins — you'd archive this tier and create a new one.",
    publishConfirm: "Publish",
    published: "Tier published.",
    joinLinkTitle: "Share your join link",
    joinLinkBody: "Anyone with this link can join {tierName}:",
    copyLink: "Copy link",
    linkCopied: "Join link copied.",
    copyFailed: "Couldn't copy the link. Copy it from the address field.",
    done: "Done",
    // Archive
    archiveConfirmTitle: "Archive this tier?",
    archiveConfirmBody:
      "New members can no longer join {tierName}. Existing members keep their subscription — and their price — until they cancel.",
    archived: "Tier archived.",
    // Form
    formCreateTitle: "Create membership tier",
    formEditTitle: "Edit tier",
    nameLabel: "Name",
    namePlaceholder: "Sustaining Member",
    nameRequired: "Name is required.",
    descriptionLabel: "Description",
    descriptionPlaceholder: "What members get and why it matters",
    priceLabel: "Price",
    priceRequired: "Price is required.",
    priceInvalid: "That price can't be read. Enter an amount like 10.00.",
    priceAmbiguous:
      "That amount reads two ways. Use 10.00 or 10,00 so we know the cents.",
    pricePositive: "Price must be more than $0.",
    priceTooHigh: "That price is above the $100,000 maximum.",
    priceLockedHint:
      "Price is locked once a tier has a member. Archive this tier and create a new one to change it.",
    intervalLabel: "Billing interval",
    intervalMonth: "Monthly",
    intervalYear: "Yearly",
    intervalLockedHint:
      "The billing interval can't change after the tier is created.",
    benefitsDescriptionLabel: "What do members get?",
    benefitsDescriptionPlaceholder:
      "Two free drinks a month, first dibs on tickets, your name on the wall",
    benefitsDescriptionHint:
      "Shown to members on your page and in the embed. Your description, in your words.",
    saving: "Saving…",
    save: "Save",
    created: "Tier created as a draft. Publish it when it's ready.",
    updated: "Tier saved.",
    discardConfirm: "Discard changes? Anything you typed will be lost.",
    // Benefits
    benefitsTitle: "Benefits — {tierName}",
    benefitsIntro:
      "A benefit is a discount that applies automatically at ticket checkout for active members — no code to type. It lasts exactly as long as their membership.",
    currentBenefits: "Current benefits",
    noBenefits: "No benefits yet.",
    benefitAnyEvent: "All events",
    benefitCategory: "Category: {name}",
    benefitPlace: "Place: {name}",
    benefitAmountSummary: "{amount} off",
    benefitPercentSummary: "{percent}% off",
    benefitCapSummary: "up to {amount}",
    removeBenefit: "Remove",
    benefitRemoved: "Benefit removed.",
    editBenefit: "Edit",
    benefitUpdated: "Benefit saved.",
    cancelEdit: "Cancel",
    // Benefit terms form
    addHeading: "Add a benefit",
    editHeading: "Edit benefit",
    discountKindLabel: "Discount type",
    discountKindAmount: "Amount off",
    discountKindPercent: "Percent off",
    amountLabel: "Amount off",
    percentLabel: "Percent off",
    amountRequired: "Enter an amount.",
    amountInvalid: "That amount can't be read. Enter something like 5.00.",
    amountAmbiguous:
      "That amount reads two ways. Use 5.00 or 5,00 so we know the cents.",
    amountPositive: "The discount must be more than $0.",
    percentRange: "Enter a percentage between 1 and 100.",
    maxDiscountLabel: "Never discount more than (optional)",
    maxDiscountInvalid: "That cap can't be read. Enter something like 20.00.",
    maxDiscountBelowAmount:
      "The cap is below the amount off, so the amount could never apply in full.",
    labelLabel: "Checkout label (optional)",
    labelPlaceholder: "Member discount",
    narrowingToggle: "Limit where it applies",
    narrowingCategoryLabel: "Only events in this category",
    narrowingPlaceLabel: "Only events at this place",
    anyCategory: "Any category",
    anyPlace: "Any place",
    add: "Add benefit",
    adding: "Adding…",
    benefitAttached: "Benefit added.",
    close: "Close",
    // Break-even calculator
    breakEvenHeading: "What this costs you",
    breakEvenTicketPriceLabel: "Typical ticket price",
    breakEvenTicketsLabel: "Shows a member uses this at, per {period}",
    breakEvenPeriodMonth: "month",
    breakEvenPeriodYear: "year",
    breakEvenAnswer:
      "A member who uses this at {count} shows a {period} costs you more in discounts than they pay in dues. Below {count}, they're profitable.",
    breakEvenNever:
      "This benefit never costs you more than the dues at that ticket price.",
    breakEvenNetPositive:
      "At {tickets} shows a {period} you clear {net} per member, after {given} in discounts.",
    breakEvenNetNegative:
      "At {tickets} shows a {period} this member costs you {net}, after {given} in discounts.",
    breakEvenFeeNote:
      "Platform fees on a discounted ticket are still computed on full face price; a 100% discount produces a $0 order with no fees at all. The buyer pays the platform fee on top, so it doesn't come out of what your event is credited.",
  },

  auth: {
    invalidEmail: "Enter a valid email.",
    vecContinue: "Continue",
    wpAvatarAlt: "Your profile photo",
    wpContinue: "Continue",
    wpDescription: "Tell us your name so we can personalize your experience.",
    wpNameLabel: "Display name",
    wpNamePlaceholder: "Enter your name",
    wpSaving: "Saving…",
    wpTitle: "Welcome to Ithas Fire",
    // Sign up
    signUpTitle: "Create your {appTitle} account",
    signUpSubtitle:
      "Get set up in minutes and start managing events, ticket types, and notifications from one dashboard.",
    alreadyHaveAccount: "Already have an account? Sign in",

    // Verify email
    verifyTitle: "Verify your email",
    verifying: "Verifying your email\u2026",
    verifyInvalidToken: "That verification link is invalid or expired.",
    verifyFailedParam: "Verification failed: {error}",
    verifyMissingToken: "Missing verification token.",
    verifyFailed: "Verification failed.",
    verifyToastSuccess: "Email verified. You\u2019re all set.",
    verifyAlertTitle: "Email verified",
    verifyAlertMessage: "Thanks! Your email is verified now.",
    verifyRedirecting: "Returning you to where you were\u2026",
    verifyLegacyRedirect:
      "Heads up: email verification now uses a 6-digit code instead of a link. Sending you home — open the verify-email screen on sign-in to enter your code.",
    goToSignIn: "Go to sign in",

    // Unauthorized
    unauthorizedTitle: "Unauthorized",
    unauthorizedMessage:
      "You don\u2019t have access to this page, or you\u2019re not signed in.",
    signIn: "Sign in",
    backToAdmin: "Back to admin",
    goHome: "Go Home",

    // Claim transfer
    ctInvalidLink: "Invalid Transfer Link",
    ctInvalidLinkDesc:
      "This link is missing a transfer token. Please check the link from your email and try again.",
    checkingSession: "Checking your session\u2026",
    ctClaimYourTicket: "Claim Your Ticket",
    ctClaimDesc:
      "Someone has transferred a ticket to you. Sign in or create an account to accept it.",
    ctSignInToClaim: "Sign In to Claim",
    ctUseSameEmail: "Use the same email address the ticket was sent to.",
    ctClaiming: "Claiming your ticket\u2026",
    ctTicketClaimed: "Ticket Claimed",
    ctTicketClaimedDesc:
      "The ticket has been added to your account. You can find it in My Tickets.",
    ctViewMyTickets: "View My Tickets",
    ctAlreadyClaimed: "Already Claimed",
    ctTransferExpired: "Transfer Expired",
    ctTransferFailed: "Transfer Failed",
    ctEmailMismatch:
      "The email on your account doesn\u2019t match the email this ticket was sent to. Please sign in with the correct email address.",
    ctExpiredDesc:
      "This transfer invitation has expired. Please ask the sender to send a new one.",
    ctAlreadyClaimedDesc: "This ticket transfer has already been claimed.",
    ctTicketOnHoldDesc:
      "This ticket can\u2019t be claimed right now. Ask the person who sent it.",
    ctSwitchAccount: "Switch Account",
    ctProcessing: "Processing\u2026",

    // Accept invitation
    invInvalidLink: "Invalid Invitation Link",
    invInvalidLinkDesc:
      "This link is missing an invitation token. Please check the link from your email and try again.",
    invSignInTitle: "Sign in to accept your invitation",
    invSignInDesc:
      "You need to be signed in to accept this team invitation. Sign in or create an account to continue.",
    invAccepting: "Accepting invitation...",
    invError: "Invitation Error",
    invErrorDesc:
      "Something went wrong while accepting this invitation. Please contact the group admin for a new invitation.",
    invExpired: "Invitation Expired",
    invExpiredDesc:
      "This invitation has expired. Please ask the group admin to send a new one.",
    invRevoked: "Invitation Revoked",
    invRevokedDesc: "This invitation has been revoked by the group admin.",
    invAlreadyAccepted: "Already Accepted",
    invAlreadyAcceptedDesc: "This invitation has already been accepted.",
    invYoureIn: "You\u2019re in!",
    invYoureInDesc: "You\u2019ve been added to {orgName} as {role}.",
    invGoToDashboard: "Go to Dashboard",
    invConfirmTitle: "Join {orgName}?",
    invConfirmDesc:
      "You've been invited to join {orgName} as {role}. You'll get access to the team's dashboard once you accept.",
    invAccept: "Accept invitation",
    invChecking: "Checking your invitation\u2026",
    invNoTokenDesc: "Open the invitation link from your email again.",
    delInvNoTokenDesc:
      "Open the invitation link you were sent again. If it still doesn't work, ask the person who invited you for a new one.",
    invNotValidForAccountDesc:
      "This link isn't valid for this account. Make sure you're signed in with the email address it was sent to. It may also have been replaced by a newer invitation.",

    // Accept delegate invitation (/delegate/accept)
    delInvInvalidLinkDesc:
      "This link is missing its invitation token. Ask the person who invited you to send it again.",
    delInvSignInDesc:
      "Sign in with the email address this invitation was sent to. If you don't have an account yet, create one with that address.",
    delInvConfirmTitle: "Accept delegate invitation?",
    delInvConfirmDesc:
      "{name} invited you to help manage their events as {role}. If you accept, you can work on their events from your dashboard.",
    delInvConfirmDescUnnamed:
      "You've been invited to help manage an Ithas Fire member's events as {role}. If you accept, you can work on their events from your dashboard.",
    delInvAccept: "Accept invitation",
    delInvYoureInDesc: "You're now a delegate for {name} as {role}.",
    delInvYoureInDescUnnamed: "You're now a delegate as {role}.",
    delInvErrorDesc:
      "We couldn't accept this invitation. Ask the person who invited you for a new link.",
    delInvExpiredDesc:
      "This invitation link has expired. Ask the person who invited you for a new one.",
    delInvAlreadyUsedDesc: "This invitation link has already been used.",
    delInvWrongAccountDesc:
      "This link doesn't work for the account you're signed in with. Sign in with the email address the invitation was sent to.",
    delInvVerifyEmailDesc:
      "Verify your email address first, then open this link again.",

    // Sign in (full-page)
    signInTitle: "Sign in",
    signInSubtitle:
      "Access your {appTitle} account to manage events, tickets, and more.",
    noAccount: "Don\u2019t have an account? Sign up",

    // Login
    loginTitle: "Welcome back",
    loginSubtitle:
      "Use your {appTitle} credentials to access the organizer dashboard and manage your events.",
    returnHome: "Return home",

    // LoginCard
    lcTitle: "Sign in to {appTitle}",
    lcEmail: "Email",
    lcEmailPlaceholder: "you@example.com",
    lcIdentifier: "Email or username",
    lcIdentifierPlaceholder: "you@example.com or username",
    lcPassword: "Password",
    lcPasswordPlaceholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
    lcTogglePw: "Toggle password visibility",
    lcPwVisible: "Password visible",
    lcPwHidden: "Password hidden",
    lcSignIn: "Sign in",
    lcSigningIn: "Signing in\u2026",
    lcNeedAccount: "Need an account?",
    lcCreateAccount: "Create account",
    lcOrContinueWith: "Or continue with",
    lcContinueGoogle: "Continue with Google",
    lcContinueApple: "Continue with Apple",
    lcGoogle: "Google",
    lcApple: "Apple",
    lcOAuthFailed: "Unable to sign in with {provider}",

    // SignUpCard
    scTitle: "Create your {appTitle} account",
    scSubtitle: "Sign up with your email and password.",
    scDisplayName: "Display name",
    scDisplayNamePlaceholder: "Jane Doe",
    scUsername: "Username",
    scUsernamePlaceholder: "janedoe",
    scPhoneHelper: "We\u2019ll use your number for SMS verification.",
    scPhoneHelperWithNumber: "We\u2019ll use {phone} for SMS verification.",
    scConfirmPassword: "Confirm password",
    scPasswordHint:
      "Use at least 10 characters including upper/lowercase, a number, and a symbol.",
    scPasswordStrength: "Strength: {label} ({score}/4). {detail}",
    scMeetsRequirements: "Meets requirements.",
    scDoesNotMeet: "Doesn\u2019t meet all requirements yet.",
    scPasswordNotMet: "Password doesn\u2019t meet requirements. {suggestion}",
    scPasswordsMismatch: "Passwords do not match.",
    scCreating: "Creating account\u2026",
    scContinue: "Continue",
    scCreateYourAccount: "Create your account",
    scAlreadyHaveAccount: "Already have an account?",
    scAccountExists:
      "Looks like you already have an account — sign in with your password.",
    staleSessionSignInAgain:
      "Your previous session has expired. Please sign in again to continue.",
    // Distinct from the above on purpose: here the server CONFIRMED the
    // session, but the page the user was sent to wouldn't accept it (the
    // host-only cookie case). Saying "expired" there would be a lie.
    unverifiableSessionSignInAgain:
      "We couldn't verify your session for this page. Please sign in again.",
    // Shown when the API refuses a Google / Apple sign-in for an account
    // with two-factor on (`?error=TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN`).
    twoFactorUsePrimarySignIn:
      "This account uses two-factor authentication. Sign in with your password or a passkey.",
    // `?error=STAFF_ACCOUNT_USE_PASSKEY`: a staff account whose second factor
    // is a passkey signs in only with that passkey.
    staffUsePasskeySignIn: "This is a staff account. Sign in with your passkey.",
    // `?error=account_not_active`: a banned or deactivated account.
    accountNotActiveSignIn: "This account can't sign in.",
    accountNotActiveContactSupport: "Contact support",

    lcForgotPassword: "Forgot your password?",

    // ForgotPasswordPage
    fpTitle: "Forgot your password?",
    fpDescription:
      "Enter your email and we'll send you a link to reset your password.",
    fpEmail: "Email",
    fpEmailPlaceholder: "you@example.com",
    fpSendLink: "Send link",
    fpSending: "Sending\u2026",
    fpSentTitle: "Check your inbox",
    fpSentDescription:
      "If an account exists for {email}, we've sent a password reset link. It expires in 60 minutes.",
    fpBackToSignIn: "Back to sign in",
    fpError: "Something went wrong. Please try again.",

    // ResetPasswordPage
    rpTitle: "Reset your password",
    rpDescription: "Choose a new password for your account.",
    rpNewPassword: "New password",
    rpNewPasswordPlaceholder: "Enter new password",
    rpConfirmPassword: "Confirm password",
    rpConfirmPasswordPlaceholder: "Re-enter new password",
    rpResetPassword: "Reset password",
    rpResetting: "Resetting\u2026",
    rpMinLength: "Must be at least 10 characters.",
    rpPasswordsMismatch: "Passwords do not match.",
    rpError: "Something went wrong. Please try again.",
    rpInvalidTitle: "Invalid or expired link",
    rpInvalidDescription:
      "This reset link is no longer valid. Request a new one.",
    rpRequestNewLink: "Request new link",
    rpSuccessTitle: "Password reset",
    rpSuccessDescription:
      "Your password has been updated. You can now sign in with your new password.",
    rpSignIn: "Sign in",

    // Overlays
    signInFailed: "Sign-in failed",
    signUpFailed: "Sign-up failed",
    closeSignInOverlay: "Close sign-in overlay",
    closeSignUpOverlay: "Close sign-up overlay",

    // Post-signup stepper
    stepperCreateAccount: "Create account",
    stepperVerifyEmail: "Verify email",
    stepperSecureAccount: "Secure account",

    // VerifyEmailCard (post-signup) — OTP-based flow.
    vecTitle: "Check your inbox",
    vecResending: "Sending\u2026",
    vecVerified: "Email verified",
    vecVerifiedDescription:
      "Your email address has been confirmed. Continuing\u2026",

    // OTP-specific copy. The "ve" prefix mirrors verify-email and is
    // distinct from "vec" (which kept the legacy link-flow strings still
    // referenced by verifyTitle / verifyAlertMessage on the redirect stub).
    veTitle: "Enter your verification code",
    veDescription:
      "We sent a 6-digit code to {email}. Enter it below to verify your email and continue.",
    veCodePlaceholder: "000000",
    veVerifyButton: "Verify email",
    veVerifying: "Verifying\u2026",
    veInvalidCode: "That code didn\u2019t match. Double-check and try again.",
    veResend: "Resend code",
    veResendIn: "Resend in {seconds}s",
    veResendFailed: "Couldn\u2019t resend the code. Please try again.",
    veCodeSent: "We sent a fresh code to your inbox.",

    // Setup2faCard (post-signup)
    tfaTitle: "Protect your account",
    tfaDescription:
      "Add two-factor authentication so only you can sign in, even if your password is compromised.",
    tfaEnable: "Set up 2FA",
    tfaSkip: "Skip for now",
    tfaEnabling: "Setting up\u2026",
    tfaQrTitle: "Scan this QR code",
    tfaQrDescription:
      "Open your authenticator app (Google Authenticator, Authy, etc.) and scan the code below.",
    tfaManualEntry: "Or enter this code manually:",
    tfaCopied: "Copied!",
    tfaCopySecret: "Copy",
    tfaBackupTitle: "Save your backup codes",
    tfaBackupDescription:
      "Store these somewhere safe. You can use them to sign in if you lose your authenticator.",
    tfaDone: "Done",
    tfaFailed: "Couldn\u2019t enable 2FA. Please try again.",

    // TwoFactorChallengeCard (login 2FA verification)
    tfcTitle: "Two-factor authentication",
    tfcTotpDesc: "Enter the 6-digit code from your authenticator app.",
    tfcOtpDesc: "We\u2019ll send a one-time code to your phone or email.",
    tfcBackupDesc: "Enter one of your saved backup codes.",
    tfcCodeLabel: "Verification code",
    tfcCodePlaceholder: "000000",
    tfcBackupLabel: "Backup code",
    tfcBackupPlaceholder: "xxxxxxxx",
    tfcTrustDevice: "Trust this device for 30 days",
    tfcVerify: "Verify",
    tfcVerifying: "Verifying\u2026",
    tfcInvalidCode: "Invalid code. Please try again.",
    tfcInvalidBackup: "Invalid backup code. Please try again.",
    tfcSendOtp: "Send code",
    tfcSendingOtp: "Sending\u2026",
    tfcOtpSentTitle: "Code sent",
    tfcOtpSentMsg: "Check your phone or email for the verification code.",
    tfcOtpSendFailed: "Couldn\u2019t send code. Please try again.",
    tfcResendOtp: "Resend code",
    tfcOtherMethods: "Other verification methods",
    tfcMethodTotp: "Authenticator app",
    tfcMethodOtp: "Email / SMS code",
    // Email-only variants, shown while SMS is unavailable (no provider).
    tfcOtpDescEmail: "We\u2019ll email you a one-time code.",
    tfcOtpSentMsgEmail: "Check your email for the verification code.",
    tfcMethodOtpEmail: "Email code",
    tfcMethodBackup: "Backup code",
    tfcBackToSignIn: "Back to sign in",
    tfcVerified: "Verified!",

    // AdminEmailVerificationGate
    evgMissingEmail: "Missing email",
    evgMissingEmailDesc:
      "We couldn\u2019t find your email address for this session.",
    evgSentTitle: "Verification email sent",
    evgSentMessage: "Check your inbox and spam folder.",
    evgVerifyTitle: "Verify your email",
    evgVerifyMessage:
      "We re-sent the verification email. Please verify to access admin features.",
    evgFailedTitle: "Couldn\u2019t send verification email",
    evgFailedFallback: "Please try again.",
    evgNudgeMessage:
      "Please verify your email to access admin features. You can resend the email from the banner.",
    evgBannerTitle: "Verify your email to use admin features",
    evgBannerDesc: "We sent a verification email to {email}.",
    evgYourInbox: "your inbox",
    evgRecentlyResent: "(Recently re-sent.)",
    evgSending: "Sending\u2026",
    evgResendEmail: "Resend email",
    evgBlockTitle: "Email verification required",
    evgBlockDesc: "Once you verify your email, refresh this page to continue.",

    // ProfileMenu
    pmOpenMenu: "Open profile menu",
    pmAvatarAlt: "{name} avatar",
    pmAvatarFallback: "Profile avatar",

    // AccountManagementPopover
    ampAdminDashboard: "Admin Dashboard",
    ampManageEvents: "Manage events",
    ampCreateEvent: "Create event",
    ampPlatform: "Platform",
    ampAccountSettings: "Account settings",
    ampSectionOrganize: "ORGANIZE",
    ampSectionAttend: "ATTEND",
    ampSectionAccount: "ACCOUNT",
    ampSectionGoing: "Going",
    ampSectionPlaying: "Playing",
    ampSectionOrganizing: "Organizing",
    ampYourHub: "Your hub",
    ampAllOrganizations: "All organisations",
    ampNewEvent: "New event",
    ampSettings: "Settings",
    ampMenuLabel: "Account menu",
    ampNextKickerTicket: "Next up",
    ampNextKickerLineup: "You’re playing",
    ampNextKickerRsvp: "You’re going",
    ampNextTicketCount: "{count, plural, one {# ticket} other {# tickets}}",
    ampNextShowTickets: "Show my tickets",
    ampNextOpenEvent: "Open event",
    ampNextShowTicketsAria: "Show my tickets: {title}",
    ampNextOpenEventAria: "Open event: {title}",

    // AuthOverlayShell
    authentication: "Authentication",
    modalDialog: "Modal dialog",
    authUnavailableTitle: "Authentication temporarily unavailable",
    authUnavailableDesc:
      "Authentication isn't configured for this environment.",
    closeOverlay: "Close overlay",
  },

  account: {
    notificationsBack: "Back",
    notificationsSettingsLabel: "Notification settings",
    notificationsSubtitle: "Everything Ithas Fire has sent you.",
    notificationsTitle: "Notifications",
    notSignedIn: "Not signed in",
    notSignedInDesc: "Sign in to manage your account settings.",
    userFallback: "User",
    navigate: "Navigate",
    overview: "Overview",
    myPage: "My Page",
    myTickets: "My Tickets",
    myVolunteering: "My Volunteering",
    memberships: "Memberships",
    notifications: "Notifications",
    settings: "Settings",
    support: "Support",
    signOut: "Sign Out",
    settingsBack: "Back",

    // ── Settings navigation (grouped, per-section routes) ──
    settingsNavAria: "Settings sections",
    // Accessible name for a nav row carrying a pending-count badge — the badge
    // itself is a bare numeral, so the link would read "Booking requests 3".
    settingsNavPendingAria: "{label}, {count} awaiting response",
    settingsNavLoadError: "Couldn't load your work and submission sections.",
    settingsNavRetry: "Retry",
    settingsAllSections: "All settings",
    settingsGroupAccount: "Account",
    settingsGroupWork: "Your work",
    settingsGroupBooking: "Booking",
    settingsGroupSubmissions: "Submissions",
    settingsWorkEmpty:
      "Perform, promote, or run a room? Tell us what you do and the tools show up here.",
    settingsWorkEmptyCta: "Tell us what you do",
    settingsDeleteAccount: "Delete account",
    settings2faReturnTitle: "Finish setting up your second factor",
    settings2faReturnDesc:
      "Add a passkey or authenticator app below, then continue back to where you left off.",
    settings2faReturnCta: "Continue",

    // ── Credits section ───────────────────────────────────
    credits: "Credits",
    creditsSubtitle: "Platform credit applied automatically at checkout",
    creditsBalance: "Available balance",
    creditsLoadError: "We couldn\u2019t load your credits. Please try again.",
    creditsNone: "You don\u2019t have any platform credits yet.",
    creditsExpires: "Expires {date}",
    creditsNoExpiry: "No expiry",
    creditsHistory: "Redemption history",
    creditsHistoryNone: "No credits have been redeemed yet.",
    creditsRedeemedOn: "Redeemed {date}",

    // ── Profile section ───────────────────────────────────
    sProfileTitle: "Profile",
    sViewMyPage: "View my public page",
    sPublicPageVisible: "Public page visible",
    sPublicPageVisibleHelp:
      "Your page is live — anyone with the link can view it.",
    sPublicPageHiddenHelp:
      "Your page returns a 404 to visitors. You can still edit it.",
    sNameLabel: "Name",
    sNamePlaceholder: "Your name",
    sEmailLabel: "Email",
    sProfilePictureAlt: "Profile picture",
    sAvatarUpload: "Change photo",
    sAvatarCropTitle: "Crop your photo",
    sAvatarUploading: "Uploading\u2026",
    sAvatarUploadSuccess: "Photo updated",
    sAvatarUploadSuccessMsg: "Your profile picture has been saved.",
    sAvatarUploadFailed: "Upload failed",
    sAvatarUploadFailedMsg:
      "We couldn\u2019t upload your photo. Please try again.",
    sAvatarTooLarge: "File too large. Maximum size is 5\u00A0MB.",
    sAvatarInvalidType: "Unsupported format. Use JPEG, PNG, or WebP.",

    // ── Email section ─────────────────────────────────────
    sEmailTitle: "Email",
    sCurrentEmail: "Current email",
    sNewEmail: "New email address",
    sNewEmailPlaceholder: "new@example.com",
    sEmailChangeHint:
      "We'll send a verification code to your new address. Your email won't change until you enter the code.",
    sEmailChangeBtn: "Send verification code",
    // Distinct from sEmailChangeBtn on purpose: both buttons can be on screen
    // at once (unverified current address + the change form), and two controls
    // sharing one accessible name is ambiguous for screen readers and
    // impossible to target unambiguously in a test.
    sEmailVerifyCurrentBtn: "Verify this address",
    sEmailSentTitle: "Verification code sent",
    sEmailSentMsg: "Check your inbox for the 6-digit verification code.",
    sPhoneHint: "US numbers only, starting +1. We'll text a 6-digit code to confirm the number is yours.",
    sPhoneErrUsOnly: "We can only text US numbers.",
    sPhoneErrRateLimited: "Too many codes sent right now. Try again in a few minutes.",
    sPhoneErrUnavailable: "Texts aren't available right now.",
    sEmailVerifyHint:
      "Enter the code below to finish changing your email. It may take a minute to arrive.",
    sEmailCodeLabel: "Verification code",
    sEmailCodePlaceholder: "000000",
    sEmailCodeHint: "We sent a 6-digit code to {email}.",
    sEmailVerifyBtn: "Verify code",
    sEmailChangedTitle: "Email updated",
    sEmailChangedMsg: "Your new email is verified and saved.",
    sEmailTryAnother: "Use a different address",
    sEmailFailedTitle: "Email change failed",
    sEmailFailedMsg: "Something went wrong. Please try again.",
    sEmailSameAsCurrent: "This is already your current email.",
    sEmailUndeliverableBadge: "Undeliverable",
    sEmailComplaintBadge: "Complaint",
    sEmailDeliveryIssueTitle: "Email delivery paused",
    sEmailUndeliverableDesc:
      "Messages to this address are currently blocked because the mailbox rejected a Ithas Fire email. Add a reachable address and verify it with a code to resume email delivery.",
    sEmailComplaintDesc:
      "Messages to this address are currently blocked because a Ithas Fire email was reported as spam. Add a reachable address and verify it with a code, or contact support if this was a mistake.",
    sEmailOAuthTitle: "Managed by your sign-in provider",
    sEmailOAuthDesc:
      "Your email is linked to your Google or Apple account and cannot be changed here. To use a different email, sign in with that address instead.",
    emailDeliveryUnknownEmail: "your email address",
    emailDeliveryBouncedTitle: "We cannot email you right now",
    emailDeliveryBouncedBody:
      "Messages to {email} are bouncing. Update your email address so tickets, receipts, and security codes can reach you.",
    emailDeliveryComplaintTitle: "Email delivery is paused",
    emailDeliveryComplaintBody:
      "Email to {email} is paused after a spam complaint. Update your address or contact support if this was a mistake.",
    emailDeliveryUpdateCta: "Update email",

    // ── Notifications section ─────────────────────────────
    sFollowingTitle: "Following",
    sFollowingDesc: "Choose which pages send you new event alerts. Delivery channels are controlled by Organizer updates below.",
    sFollowingLocation: "Nearby alerts use the event location from your latest paid or completed order with a usable location. Without one, nearby alerts are not sent.",
    sFollowingEvents: "New event alerts",
    sFollowingEventsAria: "New event alerts for {name}",
    sFollowingNearby: "Only nearby events",
    sFollowingNearbyAria: "Only nearby events for {name}",
    sFollowingRadius: "Distance (km)",
    sFollowingRadiusError: "Enter a whole number from 1 to 500 km.",
    sFollowingSave: "Save preferences",
    sFollowingSaved: "Following preferences saved",
    sFollowingSaveError: "Could not save these preferences. Try again.",
    sFollowingUnfollow: "Unfollow",
    sFollowingUnfollowError: "Could not unfollow this page. Try again.",
    sFollowingToggleError: "Could not change your follow. Try again.",
    sFollowingLoadError: "Could not load the pages you follow.",
    sFollowingRetry: "Try again",
    sFollowingEmpty: "You are not following any pages yet. Follow a place, artist or organiser from their page to see them here.",
    sFollowingMore: "Load more",
    sNotificationsTitle: "Notification preferences",
    sNotificationsDesc: "Choose how and when you\u2019d like to hear from us.",
    sNotifLoadError: "Couldn\u2019t load preferences",
    sNotifLoadErrorDesc:
      "We couldn\u2019t load your notification settings. Please try again later.",
    sNotifHistoryLink: "View notification history",
    sNotifHistoryBtn: "History",
    sNotifChInApp: "In-app",
    sNotifChEmail: "Email",
    sNotifChPush: "Push",
    sNotifCatTransactional: "Order confirmations & receipts",
    sNotifCatTransactionalDesc:
      "Purchase confirmations, e-tickets, refund notices, and payout updates.",
    sNotifCatTransactionalLocked: "Always on \u2014 required for purchases",
    sNotifCatAnnouncements: "Event announcements",
    sNotifCatAnnouncementsDesc:
      "Line-up changes, schedule updates, and important event news from organizers.",
    sNotifCatReminders: "Event reminders",
    sNotifCatRemindersDesc:
      "A nudge the day before an event you said you\u2019re going to.",
    sNotifCatPromotions: "Promotions & recommendations",
    sNotifCatPromotionsDesc:
      "Early-bird deals, personalized picks, and featured events near you.",
    sNotifCatOrgUpdates: "Organizer updates",
    sNotifCatOrgUpdatesDesc: "News and updates from organizers you follow.",
    sNotifSaveError: "Couldn\u2019t save preferences",
    sNotifSaveErrorDesc:
      "Something went wrong. Your changes weren\u2019t saved.",
    sNotifChSms: "SMS",
    sNotifAddPhoneBtn: "ADD PHONE NUMBER",
    // Read-only phone card shown on Security while SMS is switched off.
    phoneReadOnlyTitle: "PHONE NUMBER",
    phoneReadOnlyVerified: "VERIFIED",
    phoneReadOnlyUnverified: "UNVERIFIED",
    phoneReadOnlySmsOff: "Text messages aren\u2019t available yet.",
    // Short parenthetical reason used inside sNotifToggleAriaLocked.
    sNotifSmsRequiresPhone: "requires a verified phone number",
    // SMS opt-in disclosure shown once above the categories when SMS is on.
    // Carriers match the English STOP/HELP keywords in every locale.
    sNotifSmsDisclosure:
      "Texts from Ithas Fire when the hidden location of an event you\u2019re going to is revealed. Frequency varies. Optional, not required to sign up. Msg & data rates may apply. Reply STOP to opt out, HELP for help.",
    sNotifToggleAria: "{channel} notifications for {category}",
    sNotifToggleAriaLocked: "{channel} notifications for {category} ({reason})",

    // \u2500\u2500 Place claims section \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    sVenueClaimsTitle: "Place claims",
    // Nav label for the edit-suggestion feed. "Contributions" frames it as
    // things you filed, which is what the Submissions group is for.
    sContributionsTitle: "Contributions",
    sVenueClaimsDesc:
      "Ownership claims and disputes you filed for places and where each one stands.",
    sVenueClaimsLoadError: "We couldn\u2019t load your place claims.",
    sVenueClaimsEmpty: "You haven\u2019t filed any place claims or disputes.",
    sVenueClaimsStatusInReview: "In review",
    sVenueClaimsStatusApproved: "Approved",
    sVenueClaimsStatusRejected: "Rejected",
    sVenueClaimsStatusWithdrawn: "Withdrawn",
    sVenueClaimsSourceClaim: "Claim",
    sVenueClaimsSourceDispute: "Dispute",
    sVenueClaimsSubmittedSelf: "Submitted {date} as yourself",
    sVenueClaimsSubmittedOrg: "Submitted {date} for your organization",
    sVenueClaimsReviewed: "Reviewed {date}",

    sSave: "Save",
    sNameUpdatedTitle: "Name updated",
    sNameUpdatedMsg: "Your display name has been saved.",
    sUpdateFailedTitle: "Update failed",
    sUpdateFailedMsg: "Something went wrong. Please try again.",
    /** Heading of the standalone "Roles & craft" settings section. */
    sRolesCraftTitle: "Roles & craft",
    sWorkTitle: "Your work",
    sWorkDescription:
      "Pick the roles that fit you best. We’ll save changes automatically.",
    sWorkSaving: "Saving changes…",
    sWorkSaved: "Work roles saved",
    sWorkSaveFailed: "Couldn’t save right now. Please try again.",
    sWorkOtherLabel: "Describe your role",
    sWorkOtherPlaceholder: "e.g. Tour manager, session player, merch runner…",
    sGenresDescription: "Add a few genres if they’re relevant to your work.",
    sGenresPlaceholder: "Search or add a genre…",
    sJobMusician: "Musician",
    sJobDj: "DJ",
    sJobComedian: "Comedian",
    sJobDancer: "Dancer",
    sJobVisualArtist: "Visual Artist",
    sJobPoet: "Poet",
    sJobMagician: "Magician",
    sJobSoundEngineer: "Sound Engineer",
    sJobLightingEngineer: "Lighting Engineer",
    sJobPhotographer: "Photographer",
    sJobVideographer: "Videographer",
    sJobPromoter: "Promoter",
    sJobEventOrganizer: "Event Organizer",
    sJobBookingAgent: "Booking Agent",
    sJobOther: "Other",

    // ── Security section ──────────────────────────────────
    sSecurityTitle: "Security",
    sCurrentPw: "Current password",
    sNewPw: "New password",
    sConfirmPw: "Confirm new password",
    sTogglePw: "Toggle password visibility",
    sPwVisible: "Password visible",
    sPwHidden: "Password hidden",
    sPwMismatch: "Passwords do not match.",
    sChangePw: "Change password",
    sPwChangedTitle: "Password changed",
    sPwChangedMsg:
      "Your password has been updated and other sessions have been signed out.",
    sPwFailedTitle: "Password change failed",
    sPwFailedMsg: "Check your current password and try again.",

    // ── Two-factor authentication section ─────────────────
    s2faTitle: "Two-factor authentication",
    s2faStatusEnabled: "Enabled",
    s2faStatusDisabled: "Disabled",
    s2faEnabledDesc: "Your account is protected with an authenticator app.",
    s2faDisabledDesc:
      "Add an extra layer of security by enabling two-factor authentication with an authenticator app.",
    s2faEnableBtn: "Enable 2FA",
    s2faDisableBtn: "Disable 2FA",
    s2faEnabling: "Enabling…",
    s2faDisabling: "Disabling…",
    s2faPasswordLabel: "Confirm your password",
    s2faPasswordPlaceholder: "Enter your password",
    s2faQrTitle: "Scan this QR code",
    s2faQrDesc:
      "Use your authenticator app (Google Authenticator, Authy, etc.) to scan the code below.",
    s2faManualEntry: "Or enter this key manually:",
    s2faCopySecret: "Copy",
    s2faCopied: "Copied",
    s2faBackupTitle: "Backup codes",
    s2faBackupDesc:
      "Save these codes in a safe place. You can use them to sign in if you lose access to your authenticator app.",
    s2faBackupDone: "I've saved my codes",
    s2faRegenBackup: "Regenerate backup codes",
    s2faRegenBackupDesc:
      "This will invalidate your existing backup codes and generate new ones.",
    s2faRegenBtn: "Regenerate codes",
    s2faRegenerating: "Regenerating…",
    s2faEnabledTitle: "2FA enabled",
    s2faEnabledMsg: "Two-factor authentication is now active on your account.",
    s2faDisabledTitle: "2FA disabled",
    s2faDisabledMsg:
      "Two-factor authentication has been removed from your account.",
    s2faFailedTitle: "Action failed",
    s2faFailedMsg: "Check your password and try again.",
    s2faBackupRegenTitle: "Backup codes regenerated",
    s2faBackupRegenMsg: "Your old backup codes are no longer valid.",
    s2faCancel: "Cancel",

    // ── Billing & contact section ─────────────────────────
    sBillingTitle: "Billing & Contact",
    sBillingDesc:
      "Saved details are used to pre-fill checkout so you can buy tickets faster.",
    sBillingPhone: "Phone number",
    sBillingPhonePlaceholder: "+1 (555) 123-4567",
    sBillingLine1: "Address",
    sBillingLine1Placeholder: "123 Main St",
    sBillingLine2: "Address line 2",
    sBillingLine2Placeholder: "Apt, suite, etc.",
    sBillingCity: "City",
    sBillingState: "State / Province",
    sBillingPostalCode: "Postal code",
    sBillingCountry: "Country",
    sBillingSave: "Save",
    sBillingSaving: "Saving...",
    sBillingSavedTitle: "Billing details saved",
    sBillingSavedMsg: "Your billing info has been updated.",
    sBillingSaveFailedTitle: "Save failed",
    sBillingSaveFailedMsg: "Something went wrong. Please try again.",
    sBillingClear: "Clear saved details",
    sBillingClearing: "Clearing...",
    sBillingClearedTitle: "Details cleared",
    sBillingClearedMsg: "Your saved billing info has been removed.",
    sBillingNone:
      "No billing details saved yet. They\u2019ll be saved automatically next time you check out.",
    sPayoutsTitle: "Payouts",
    sPayoutsConnectCta: "Connect Stripe",
    sPayoutsDesc:
      "Connect a Stripe account to resell tickets. When someone buys a ticket you listed, the money goes to that account.",
    sPayoutsSetupBody:
      "Connect a Stripe account so money from tickets you resell reaches you. Stripe checks your identity as part of setup.",
    sPayoutsIncompleteBody:
      "Your Stripe account is connected, but Stripe needs more information before money from resold tickets can reach you.",
    sPayoutsActiveBody:
      "Your Stripe account is ready. Money from tickets you resell is paid out to it.",

    // ── Danger zone ───────────────────────────────────────
    sDangerTitle: "Danger zone",
    sDeleteDesc:
      "Permanently delete your account and all associated data. This action cannot be undone.",
    sDeleteBtn: "Delete account",
    sDeleteConfirm: "Are you sure? This will permanently delete your account.",
    sDeleteConfirmInstructions: "Type your account email to confirm",
    sDeleteConfirmPlaceholder: "you@example.com",
    sDeleteConfirmMismatch:
      "That doesn\u2019t match your account email. Please retype it exactly.",
    sDeleteConfirmPasswordLabel: "Enter your current password",
    sDeleteConfirmPasswordPlaceholder: "Current password",
    sDeleteConfirmPasswordRequired: "Enter your current password to confirm.",
    sDeleteConfirmPasswordInvalid:
      "That password doesn\u2019t match your account. Please try again.",
    sDeleteBlockedByHistory:
      "Your account has order or ticket history and can\u2019t be fully deleted. Contact support if you\u2019d like help with this.",
    sDeleteBlockedBySoleOwner:
      "You\u2019re the sole owner of an organization. Transfer ownership to another member before deleting your account.",
    sDeleteConfirmBtn: "Yes, delete my account",
    sCancel: "Cancel",
    sDeletedTitle: "Account deleted",
    sDeletedMsg: "Your account has been permanently removed.",
    sDeleteFailedTitle: "Deletion failed",
    sDeleteFailedMsg:
      "We couldn\u2019t delete your account right now. Please try again later.",

    // \u2500\u2500 Performer section \u2500\u2500
    sPerformerTitle: "Performer",
    sPerformerDesc:
      "Get booked: performer mode lets you send booking requests to places.",
    sPerformerToggleLabel: "Performer mode",
    sPerformerOnSince:
      "On since {date}. You can send booking requests to places.",
    sPerformerOffHelp:
      "Off. Turning performer mode off hides performer features but keeps your data.",
    sPerformerOrgHint:
      "You also manage groups \u2014 turn on their performer mode in each group's settings.",
    sPerformerRequestsTitle: "Booking requests",
    /** Sub-heading of the sent list, paired with sPerformerReceivedTitle. */
    sPerformerSentTitle: "Requests you sent",
    sPerformerRequestsDesc: "Requests you've sent to places.",
    sPerformerRequestsEmpty:
      "No booking requests yet. Find a place page that accepts requests and pitch your act.",
    sPerformerRequestsAs: "Sent as {name}",
    sPerformerWithdraw: "Withdraw",
    sPerformerWithdrawFailed: "Couldn't withdraw the request",
    sPerformerRequestsLoadFailed: "Couldn't load booking requests.",
    sPerformerRequestsPartialFailed:
      "Some booking requests couldn't be loaded.",
    sPerformerViewAgreement: "View agreement",
    sPerformerAcceptLabel: "Open to booking requests",
    sPerformerAcceptOnHelp:
      "On. Organizers can send you booking requests, and a “Request to book” button appears on your public page.",
    sPerformerAcceptOffHelp: "Off. Organizers can't send you booking requests.",
    sPerformerReceivedTitle: "Requests to you",
    sPerformerReceivedDesc: "Booking requests organizers have sent to you.",

    // ── Booking requests section (holds both directions) ──
    sBookingRequestsTitle: "Booking requests",
    sBookingRequestsDesc:
      "What organizers have sent you, and what you've sent out.",

    // ── Booking defaults editor ──
    sBkDefTitle: "Booking defaults",
    sBkDefDesc:
      "Save reusable pitch details. We'll prefill your booking requests with these — you can still tweak them for each place.",
    sBkDefPerformerOff:
      "Turn on performer mode above to set up your booking defaults.",
    sBkDefLoadFailed: "Couldn't load your booking defaults.",
    sBkDefSaving: "Saving…",
    sBkDefSaved: "Saved",
    sBkDefSaveFailed: "Couldn't save your booking defaults. Please try again.",
    sBkDefMessageLabel: "Pitch message template",
    sBkDefMessageHint:
      "Prefilled as your booking-request message. Edit it per request before sending.",
    sBkDefMsgTooLong: "Message template is too long (max 2000 characters).",
    sBkDefGenreHint: "Genre comes from your profile genre tags.",
    sBkDefIncludeStatsLabel: "Include my verified stats by default",
    sBkDefIncludeStatsHint:
      "Added to your booking requests by default. Separate from your public page's stats — this doesn't make them public.",
    sBkDefFixFields: "Fix the highlighted fields to save.",
  },

  // ── About page ────────────────────────────────────────────────────────────
  // ── /account/memberships (member self-service; renewal emails link here) ──
  accountMemberships: {
    title: "Memberships",
    subtitle: "Recurring support for the places and artists you back.",
    empty: "You don't have any memberships yet.",
    loadError: "We couldn't load your memberships. Please try again.",
    portalError: "We couldn't open the billing portal. Please try again.",
    manageBilling: "Manage billing",
    statusActive: "Active",
    statusPastDue: "Past due",
    statusCanceled: "Canceled",
    statusIncomplete: "Incomplete",
    perMonth: "per month",
    perYear: "per year",
    renewsOn: "Renews {date}",
    endsOn: "Ends {date}",
    activeSectionLabel: "Active memberships",
    otherSectionLabel: "Other memberships",
    memberSinceLabel: "Member since",
    renewalLabel: "Renewal",
    priceLabel: "Price",
  },
  aboutPage: {
    heroTitle: "Live events, better for everyone",
    heroDescription:
      "Ithas Fire is a modern event-ticketing platform built for organizers and attendees alike. We make it easy to discover events, purchase tickets, and manage every aspect of the event lifecycle \u2014 from creation to settlement.",
    missionHeading: "Our mission",
    missionBody:
      "We believe live experiences bring people together. Our goal is to give organizers powerful, transparent tools while keeping the ticket-buying experience effortless and fair. No hidden fees, no scalper bots, no runarounds \u2014 just great events and the people who make them happen.",
    valuesHeading: "What makes us different",
    valueFairPricingTitle: "Fair pricing",
    valueFairPricingDescription:
      "Transparent, upfront pricing with no hidden fees. What you see is what you pay.",
    valueInstantPayoutsTitle: "Instant payouts",
    valueInstantPayoutsDescription:
      "Real-time settlement tracking and fast payouts so organizers get paid without the wait.",
    valueResaleProtectionTitle: "Resale protection",
    valueResaleProtectionDescription:
      "Built-in resale controls that protect fans and artists from scalpers and fraud.",
    valuePrivacyFirstTitle: "Privacy first",
    valuePrivacyFirstDescription:
      "We never sell your data. Your information stays yours, full stop.",
    teamHeading: "Meet the team",
    teamDescription:
      "A small crew passionate about live events and great software.",
    teamCeo: "CEO & Co-founder",
    teamCto: "CTO & Co-founder",
    teamDesign: "Head of Design",
    teamEngineering: "Engineering",
    teamOperations: "Operations",
    statsEventsCreated: "Events created",
    statsTicketsSold: "Tickets sold",
    statsOrganisers: "Groups onboarded",
    statsCountries: "Countries",
    ctaTitle: "Ready to get started?",
    ctaDescription:
      "Whether you\u2019re looking to attend your next event or organize one of your own, we\u2019re here to help.",
    ctaBrowseEvents: "Browse events",
    ctaGetInTouch: "Get in touch",
  },

  // ── Features page ─────────────────────────────────────────────────────────
  featuresPage: {
    overline: "The platform",
    heroTitle: "Everything you need to run live events",
    heroDescription:
      "From the first ticket to the final payout, Ithas Fire gives organizers, artists, and places one connected toolkit — and gives fans an effortless way in.",
    ctaTitle: "Ready to put it to work?",
    ctaDescription:
      "Create your first event in minutes, or explore what other organizers are putting on near you.",
    ctaGetStarted: "Get started",
    ctaBrowseEvents: "Browse events",

    ticketing: {
      title: "Ticketing & checkout",
      lead: "Sell any kind of ticket, hold the cart, and get the tax right.",
      multiTierTitle: "Multi-tier pricing",
      multiTierDesc:
        "Stack early-bird, GA, and VIP tiers, each with its own price and limit.",
      freePaidTitle: "Free & paid tickets",
      freePaidDesc: "Run free RSVPs and paid admissions from the same event.",
      holdsTitle: "Timed cart holds",
      holdsDesc:
        "Reserve seats during checkout so no two buyers grab the same spot.",
      seatingTitle: "Reserved seating",
      seatingDesc:
        "Build interactive seat maps and let fans pick their exact seats.",
      walletTitle: "Wallet passes",
      walletDesc:
        "Deliver Apple and Google Wallet passes fans can scan at the door.",
      waitlistTitle: "Waitlists",
      waitlistDesc:
        "Capture demand for sold-out shows and message fans when seats free up.",
      transfersTitle: "Ticket transfers",
      transfersDesc:
        "Let buyers hand tickets to friends by email in a couple of taps.",
      compsTitle: "Complimentary tickets",
      compsDesc:
        "Issue comps for guests, press, and partners without checkout.",
      taxTitle: "Real-time tax",
      taxDesc:
        "Estimate sales tax at checkout so totals are right the first time.",
    },

    resale: {
      title: "Fan-to-fan resale",
      lead: "A safe secondary market that keeps scalpers out.",
      listingsTitle: "Safe resale listings",
      listingsDesc: "Let fans relist spare tickets with fair price guidance.",
      flowTitle: "Safe on-platform checkout",
      flowDesc:
        "Buyers purchase listed tickets directly and safely through the platform — no risky side deals.",
      policyTitle: "Resale policy controls",
      policyDesc: "Set org-level rules for when and how tickets can be resold.",
      antiScalperTitle: "Price caps",
      antiScalperDesc:
        "Per-ticket price caps stop resellers from marking tickets up beyond what you allow.",
    },

    events: {
      title: "Event management",
      lead: "Run the full event lifecycle from one place.",
      lifecycleTitle: "Full event lifecycle",
      lifecycleDesc: "Create, publish, unpublish, cancel, and delete events.",
      recurringTitle: "Recurring series",
      recurringDesc:
        "Schedule repeating events and manage every date together.",
      gatedTitle: "Gated events",
      gatedDesc: "Hide events behind passwords or private, invite-only access.",
      lineupsTitle: "Application lineups",
      lineupsDesc:
        "Open a call for artists and build lineups from applications.",
      splitsTitle: "Revenue splits",
      splitsDesc: "Divide proceeds automatically among collaborators and acts.",
      categoriesTitle: "Categories & tags",
      categoriesDesc: "Organize and surface events with categories and tags.",
      changeNotifsTitle: "Change notifications",
      changeNotifsDesc:
        "Attendees are told automatically when event details change.",
    },

    booking: {
      title: "Artist & booking loop",
      lead: "Book acts, agree the terms, and turn a deal into a show.",
      requestsTitle: "Booking requests",
      requestsDesc: "Reach out to artists and start a booking conversation.",
      agreementsTitle: "Negotiated agreements",
      agreementsDesc:
        "Build line items, review together, and finalize a signed deal.",
      toEventTitle: "Agreement to event",
      toEventDesc: "Turn a finalized agreement into a live, on-sale event.",
      payoutTermsTitle: "Payout terms",
      payoutTermsDesc: "Set guarantees, splits, and payout schedules up front.",
      performerTitle: "Performer profiles",
      performerDesc: "Give artists profiles and reusable booking defaults.",
      lineupLinksTitle: "Shareable lineups",
      lineupLinksDesc: "Publish lineups with links artists can share anywhere.",
      embedTitle: "Booking widgets",
      embedDesc: "Embed a request-to-play button on any artist or place site.",
    },

    venues: {
      title: "Places & entity pages",
      lead: "Claim your space and give artists, places, and orgs a home.",
      directoryTitle: "Public place pages",
      directoryDesc:
        "Every place gets a public page, discoverable through search.",
      claimTitle: "Claim & verify",
      claimDesc: "Claim your place and verify ownership to manage its page.",
      disputeTitle: "Dispute handling",
      disputeDesc: "Resolve competing ownership claims with a clear process.",
      availabilityTitle: "Booking calendar",
      availabilityDesc:
        "See your booked events on one calendar with double-booking detection.",
      miniSiteTitle: "Mini-site pages",
      miniSiteDesc:
        "Customizable pages for artists, places, and organizations.",
      followTitle: "Follows",
      followDesc: "Let fans follow artists, places, and orgs they love.",
    },

    payments: {
      title: "Payments & payouts",
      lead: "Take money, move it, and handle the edge cases.",
      onboardingTitle: "Stripe Connect",
      onboardingDesc:
        "Onboard organizers to Stripe Connect for direct payouts.",
      settlementsTitle: "Automated settlements",
      settlementsDesc: "Settle sales and batch transfers without spreadsheets.",
      scheduledTitle: "Scheduled payouts",
      scheduledDesc: "Pay out on a schedule that fits your cash flow.",
      refundsTitle: "Flexible refunds",
      refundsDesc: "Refund whole orders or individual items in a click.",
      disputesTitle: "Chargeback tracking",
      disputesDesc:
        "See chargeback status in-app; disputes are handled through Stripe.",
      posTitle: "In-person POS",
      posDesc:
        "Sell at the door with card or cash from the scanner app, powered by Stripe Terminal.",
      creditsTitle: "Account credits",
      creditsDesc: "Fans view and redeem account credits at checkout.",
    },

    reviews: {
      title: "Reviews & trust",
      lead: "Build reputation with feedback fans and organizers trust.",
      venueReviewsTitle: "Place reviews",
      venueReviewsDesc:
        "Guided reviews help fans size up a room before they go.",
      eventReviewsTitle: "Event reviews",
      eventReviewsDesc: "Attendees rate events and share how the night went.",
      trustProfilesTitle: "Public review ratings",
      trustProfilesDesc:
        "Places and events build a public rating from verified reviews.",
      feedbackPromptsTitle: "Feedback prompts",
      feedbackPromptsDesc: "Nudge attendees for a review right after the show.",
    },

    discovery: {
      title: "Search & discovery",
      lead: "Help the right fans find the right night out.",
      unifiedSearchTitle: "Unified search",
      unifiedSearchDesc: "Search events, places, and artists from one bar.",
      discoverTitle: "Browse by place",
      discoverDesc: "Discover events by category, city, and location.",
      mapTitle: "Map view",
      mapDesc: "See what's happening around you on an interactive map.",
      featuredTitle: "Featured & popular",
      featuredDesc:
        "Highlight standout events with featured and popular ranking.",
      surpriseTitle: "Surprise me",
      surpriseDesc: "Send curious fans to a random event with one tap.",
      seoTitle: "SEO-ready listings",
      seoDesc: "Every listing is built to rank and share cleanly.",
    },

    community: {
      title: "Community & curation",
      lead: "Let your scene help keep the calendar alive.",
      listingsTitle: "Community listings",
      listingsDesc:
        "Crowd-sourced listings for open mics and recurring nights.",
      rsvpsTitle: "RSVPs",
      rsvpsDesc: "Collect RSVPs, including for a single recurring date.",
      suggestionsTitle: "Edit suggestions",
      suggestionsDesc: "Fans can suggest fixes to keep listings accurate.",
      moderatorsTitle: "Community moderators",
      moderatorsDesc: "Empower trusted locals to curate and moderate listings.",
    },

    volunteer: {
      title: "Volunteering",
      lead: "Coordinate the crew that makes the event run.",
      asksTitle: "Asks, roles & shifts",
      asksDesc: "Post volunteer needs as roles and shifts people can fill.",
      signupsTitle: "Group signups",
      signupsDesc: "Sign up volunteers in groups with named coordinators.",
      hoursTitle: "Hours & rewards",
      hoursDesc: "Track volunteer hours and reward them from a ledger.",
      waiversTitle: "Signable waivers",
      waiversDesc: "Collect signed waivers before volunteers start a shift.",
      broadcastsTitle: "Roster broadcasts",
      broadcastsDesc: "Message your roster and send automatic shift reminders.",
      icsTitle: "Calendar feeds",
      icsDesc: "Volunteers subscribe to their shifts with an ICS feed.",
      checkinTitle: "Check-in tokens",
      checkinDesc: "Scan volunteers in with per-shift check-in tokens.",
    },

    scanning: {
      title: "Access control & scanning",
      lead: "Move the line at the door, fast and forgiving.",
      fastScanTitle: "Fast scanning",
      fastScanDesc:
        "Scan tickets in a flash, with a one-tap revert on mistakes.",
      manifestsTitle: "Operator manifests",
      manifestsDesc: "Give door staff scoped manifests for their event only.",
      passkeyTitle: "Passkey access",
      passkeyDesc:
        "Sign scanners in across devices with cross-device passkeys.",
      scannerAppTitle: "Dedicated scanner app",
      scannerAppDesc: "A purpose-built app for scanning tickets at the gate.",
    },

    orgtools: {
      title: "Notifications & organizer tools",
      lead: "Reach your audience and run the business behind the show.",
      channelsTitle: "Multi-channel messaging",
      channelsDesc:
        "Reach fans by email and push, with per-channel preferences.",
      // Shown instead of channelsDesc while SMS is unavailable (no provider).
      channelsDescNoSms:
        "Reach fans by email and push, with per-channel preferences.",
      announcementsTitle: "Targeted announcements",
      announcementsDesc:
        "Send announcements to a segment with an audience preview.",
      dashboardsTitle: "Org dashboard",
      dashboardsDesc:
        "Track sales, payouts, and event performance in one place.",
      promoTitle: "Promo & discount codes",
      promoDesc: "Drive sales with promo codes and discounts.",
      widgetsTitle: "Embeddable widgets",
      widgetsDesc: "Embed checkout widgets with guest checkout on any site.",
      exportsTitle: "Data exports",
      exportsDesc: "Export your data whenever you need it, no lock-in.",
      teamTitle: "Team & roles",
      teamDesc: "Invite team members and scope what each role can do.",
    },

    account: {
      title: "Account & security",
      lead: "Sign in safely and stay in control of your data.",
      passkeyTitle: "Passkey-first sign-in",
      passkeyDesc: "Sign in with a passkey — no password to phish or forget.",
      twoFactorTitle: "Two-factor auth",
      twoFactorDesc: "Add a second factor for an extra layer of protection.",
      delegatesTitle: "Account delegates",
      delegatesDesc: "Let trusted people help manage your account.",
      consentTitle: "Consent & privacy",
      consentDesc: "Manage consent and privacy controls on your terms.",
      deletionTitle: "Self-service deletion",
      deletionDesc: "Delete your account and data yourself, any time.",
    },
  },

  // ── Contact page ──────────────────────────────────────────────────────────
  contactPage: {
    heroTitle: "Contact our team",
    heroDescription:
      "Got any questions about our platform or need help? We\u2019re here to help. Chat to our friendly team and get a response in less than 24 hours.",
    channelsHeading: "Reach us",
    channelGeneralTitle: "Chat with us",
    channelGeneralDescription: "Speak to our team via email.",
    channelSupportTitle: "Call us",
    channelSupportDescription: "Call our team Mon\u2013Fri from 9am to 5pm.",
    channelPartnershipsTitle: "Visit us",
    channelPartnershipsDescription: "Come say hello at our office.",
    formHeading: "Send a message",
    formFirstNameLabel: "First name",
    formFirstNamePlaceholder: "First name",
    formLastNameLabel: "Last name",
    formLastNamePlaceholder: "Last name",
    formNameLabel: "Name",
    formNamePlaceholder: "Your name",
    formEmailLabel: "Email",
    formEmailPlaceholder: "you@company.com",
    formPhoneLabel: "Phone number",
    formPhonePlaceholder: "+1 (555) 000-0000",
    formMessageLabel: "Message",
    formMessagePlaceholder: "Leave us a message\u2026",
    formServicesLabel: "Services",
    formServiceEventTicketing: "Event ticketing",
    formServiceOrganiserTools: "Organizer tools",
    formServiceResaleProtection: "Resale protection",
    formServicePayouts: "Payouts & settlements",
    formServiceApiAccess: "API access",
    formServiceOther: "Other",
    formSubmit: "Send message",
    formSending: "Sending\u2026",
    formSuccessTitle: "Message sent",
    formSuccessDescription:
      "Your email client should have opened with the details pre-filled. We\u2019ll get back to you as soon as we can.",
    formSendAnother: "Send another message",
    ctaTitle: "Prefer to browse first?",
    ctaDescription:
      "Check out upcoming events near you, or learn more about what Ithas Fire can do for organizers.",
    ctaBrowseEvents: "Browse events",
    ctaAboutUs: "About us",
  },

  // ── Support page ─────────────────────────────────────────────────────
  supportPage: {
    overline: "Support",
    heroTitle: "How can we help?",
    heroDescription:
      "Start with the Help Center, reach out to the event organizer for questions about a specific event or order, or contact us for account and payment issues.",

    // 01 — Help Centre (self-serve first)
    helpSectionTitle: "Search the Help Center",
    helpSectionLead:
      "Most answers are a search away. Browse guides for buying tickets, managing your account, and solving common issues.",
    helpBrowseCta: "Browse the Help Center",
    helpCategoryGettingStartedTitle: "Getting started",
    helpCategoryGettingStartedDescription:
      "New to Ithas Fire? Learn the basics of finding and attending events.",
    helpCategoryBuyingTitle: "Buying tickets",
    helpCategoryBuyingDescription:
      "Checkout, payment, delivery, and finding your tickets after you buy.",
    helpCategoryTroubleshootingTitle: "Troubleshooting",
    helpCategoryTroubleshootingDescription:
      "Fixes for sign-in problems, missing tickets, and other common issues.",

    // 02 — Event & order questions → organiser
    organiserSectionTitle: "Questions about an event or order",
    organiserSectionLead:
      "The event organizer is your first point of contact for anything specific to an event — entry, schedule, timing, or what is included. They run the event and can answer fastest.",
    organiserStepFindTitle: "Find your order",
    organiserStepFindDescription:
      "Open My Tickets to see your order and the event details.",
    organiserStepContactTitle: "Contact the organizer",
    organiserStepContactDescription:
      "The organizer's contact details are on your order and on the event page.",
    organiserViewTicketsCta: "Go to My Tickets",

    // 03 — Refunds
    refundsSectionTitle: "Refunds",
    refundsSectionLead:
      "While the organizer's refund window is open, you can request a refund yourself from My Tickets. After it closes, contact the organizer — refund eligibility follows the organizer's stated policy and applicable law.",
    refundsPolicyLabel: "Refund policy",
    refundsPolicyText:
      "Paid tickets are refundable through Ithas Fire according to the organizer's stated refund policy and applicable law. Ithas Fire platform and processing fees are non-refundable unless required by law or the event is cancelled. Donation and pay-what-you-want tickets are non-refundable unless required by law or the event is cancelled.",
    refundsRequestCta: "Request from My Tickets",

    // 04 — Platform / account / payment → contact us
    platformSectionTitle: "Account & payment help",
    platformSectionLead:
      "For anything that is not event-specific — you can't sign in, a double charge, or an account problem — contact us directly and we'll help.",
    platformEmailLabel: "Email support",
    platformContactFormCta: "Open the contact form",
    platformContactFormDescription:
      "Prefer a form? Send us the details and we'll get back to you, usually within 24 hours.",
  },

  // ── Support chat widget ──────────────────────────────────────────────
  supportChat: {
    // Bubble / launcher
    openLabel: "Open support chat",
    closeLabel: "Close support chat",
    unreadLabel:
      "{count} new support {count, plural, one {message} other {messages}}",

    // Panel header
    title: "Support",
    subtitle: "Ask us anything — we'll reply when we can.",
    minimizeLabel: "Minimize support chat",

    // Message thread
    messagesRegionLabel: "Support conversation",
    emptyTitle: "Start a conversation",
    emptyBody:
      "Tell us what you need help with. We'll get back to you here, usually within a day.",
    loading: "Loading your conversation…",
    loadError: "We couldn't load your messages. Try again.",
    retry: "Retry",
    you: "You",
    agent: "Support",
    assistant: "Assistant",
    system: "System",
    sending: "Sending…",
    resolvedNotice:
      "This conversation is resolved. Send a message to reopen it.",

    // Composer
    composerPlaceholder: "Type your message…",
    send: "Send",
    sendLabel: "Send message",
    sendError: "Your message couldn't be sent. Try again.",
    rateLimited: "You're sending messages too fast — give it a sec.",
    talkToHuman: "Talk to a person",
    escalated: "We've flagged this for a person to look at.",

    // Sign-in gate
    signedOutTitle: "Sign in to chat with us",
    signedOutBody:
      "Signing in links the conversation to your orders and tickets so we can help faster.",
    signInCta: "Sign in",
    emailFallbackPrefix: "Prefer email? Reach us at",
  },

  // ── Support inbox (operator) ─────────────────────────────────────────
  supportInbox: {
    title: "Support inbox",
    subtitle: "Reply to attendee conversations and resolve them when done.",
    filterAll: "All",
    filterAwaiting: "Awaiting human",
    filterOpen: "Open",
    filterResolved: "Resolved",
    threadsLoading: "Loading conversations…",
    threadsError: "We couldn't load conversations. Try again.",
    noThreads: "No conversations yet.",
    noThreadsFiltered: "No conversations match this filter.",
    selectThreadTitle: "Select a conversation",
    selectThreadBody: "Pick a conversation from the list to read and reply.",
    statusOpen: "Open",
    statusAwaiting: "Awaiting",
    statusResolved: "Resolved",
    eventContext: "Event",
    orderContext: "Order",
    lastMessage: "Last activity",
    resolve: "Resolve",
    resolving: "Resolving…",
    resolved: "Resolved",
    reopen: "Reopen",
    replyPlaceholder: "Write a reply…",
    reply: "Reply",
    refresh: "Refresh",
    threadHuman: "Attendee",
    unknownAttendee: "Unknown attendee",
    attendeeFallback: "User {id}",
    needsReply: "Needs reply",
    needsReplyCount: "{count} need a reply",
    viewOrders: "View orders",
    viewUser: "View profile",
    viewOrder: "View order",
    contextLabel: "Context",
  },

  // ── Contextual action bar ────────────────────────────────────────────
  pageActions: {
    /**
     * Labels for page-owned primary actions. Named `cab.*` until the
     * floating action bar was removed (2026-08/09) — the actions outlived
     * the bar, moving inline, into hero "…" menus, and into the mobile
     * bottom bar's centre slot. Renamed here so the namespace stops
     * pointing at a component that no longer exists.
     */
    suggestEdit: "Suggest edit",
    attendees: "Attendees",
    compTickets: "Comp",
    editEvent: "Edit event",
    viewEvent: "View event",
    viewPage: "View page",
    scanTicket: "Scan",
    moreActions: "More actions",
    save: "Save",
    saving: "Saving",
    volunteers: "Volunteers",
    volunteer: "Volunteer",
    publishEvent: "Publish",
    publishing: "Publishing",
    unpublishEvent: "Unpublish",
    shareEvent: "Share",
    // Venue (PLACE) page overflow
    requestTransfer: "Request transfer",
    share: "Share",
    copyLink: "Copy link",
    report: "Report",
  },

  // ── Spotlight search overlay ─────────────────────────────────────────
  spotlight: {
    title: "Search",
    placeholder: "Search events, people, places\u2026",
    close: "Close",
    filterAll: "All",
    location: "Location",
    idleTitle: "Start typing to search",
    idleHint: "Find events, people, places, and groups.",
    // Orders are named here on purpose. FR-012 shipped the order lookup with
    // copy that listed only the other three groups, so the feature was
    // invisible — a tester reading this placeholder concluded admin search
    // could not find orders at all. Static, not role-aware: a non-finance
    // actor simply gets no order result, exactly as they would for a code that
    // does not exist (NFR-002 — no existence oracle).
    adminPlaceholder: "Search events, attendees, places, orders…",
    adminIdleHint:
      "Find events, attendees, and places in this group — or paste an order code.",
    noResults: "No results found",
    noResultsHint: "Try a different search term or broaden your filters.",
    kbdNavigate: "Navigate",
    kbdSelect: "Select",
    kbdClose: "Close",
    viewAll: "View all results",
    surprise: "Surprise me",
    searchShort: "Search…",
    resultsLabel: "Search results",
    clearLocation: "Clear location",
    unitToKilometres: "Switch radius units to kilometres",
    unitToMiles: "Switch radius units to miles",
    unitToggleTitle: "Toggle km / mi",
    // Entity pills + group headers — consumer/platform.
    typeEvents: "Events",
    typePeople: "People",
    typePlaces: "Places",
    typeGroups: "Groups",
    // Entity pills + group headers — admin. No "Groups": org documents were
    // never org-scoped, so that pill returned global organisations.
    adminTypeEvents: "Events",
    adminTypeAttendees: "Attendees",
    adminTypeVenues: "Places",
    // FR-012 — the single order an id-shaped query resolves. Not a pill: it is
    // a group of at most one row, so the header is singular.
    adminTypeOrder: "Order",
    untitledEvent: "Untitled event",
    moreEvents: "+{count} more",
    guestBuyer: "Guest buyer",
    searching: "Searching…",
    loading: "Loading…",
    // Admin facet pills (events-only).
    facetStatus: "Status",
    facetDate: "Date",
    facetCategory: "Category",
    // Results-page only: the entity-pill row carries its own label there.
    facetType: "Type",
    facetClear: "Clear {facet} filter",
    clearFilters: "Clear filters",
    /**
     * Results-page mobile disclosure. The count is baked into the LABEL rather
     * than sitting in a separate badge, because the collapsed bar is the only
     * thing telling a user that filters arrived with them from a "View all"
     * hand-off or a shared link — filters they never set themselves.
     */
    facetsToggle: "{count, plural, =0 {Filters} other {Filters (#)}}",
    statusAll: "All",
    statusDraft: "Drafts",
    statusPublished: "Published",
    // "Completed", not "Past" — the Date facet already owns "past", and these
    // two mean different things (a COMPLETED status vs. a start date behind us).
    statusCompleted: "Completed",
    statusCancelled: "Cancelled",
    statusArchived: "Archived",
    dateAny: "Any date",
    dateUpcoming: "Upcoming",
    datePast: "Past dates",
    dateCustom: "Custom range",
    dateFrom: "From",
    dateTo: "To",
    categoryAll: "All categories",
    categoryUncategorised: "Uncategorised",
    // Single-row status labels (singular — one row is one event).
    eventStatusDraft: "Draft",
    eventStatusPublished: "Published",
    eventStatusCompleted: "Completed",
    eventStatusCancelled: "Cancelled",
    eventStatusArchived: "Archived",
    // Order-row statuses (FR-012). Deliberately NOT the `admin.status*` set the
    // orders table uses — that set has no `statusProcessing` entry in either
    // catalog, so a PROCESSING order would render the raw key.
    orderStatusPending: "Pending",
    orderStatusProcessing: "Processing",
    orderStatusSucceeded: "Paid",
    orderStatusPartRefunded: "Partially refunded",
    orderStatusRefunded: "Refunded",
    orderStatusDisputed: "Disputed",
    orderStatusCancelled: "Cancelled",
    // Results page: "how many are LISTED" vs "how many EXIST". Printing a
    // scope-wide total over a capped page reads as a bug, so a capped section
    // says both.
    shownOfTotal: "{shown} of {total}",
    /**
     * A scope-wide total for a section that CANNOT express `shown of total`,
     * because its two numbers are different units (see the attendees section
     * in `admin/[slug]/search/page.tsx`). The bare word carries what the "of"
     * form carries elsewhere — "this counts the whole scope, not the rows
     * below" — without repeating the section's own noun, which is why this is
     * not `countAttendees`. That key stays: the screen-reader announcement
     * lists groups in a sentence, where "137 attendees" is exactly right.
     */
    countTotal: "{count} total",
    /**
     * FR-013 — "purchases", not "orders", and the distinction is load-bearing.
     *
     * The attendee LIST is built from every order (so an organiser can still
     * find someone who abandoned a cart), while the enrichment aggregate counts
     * only COMPLETED order statuses — PENDING holds and CANCELLED orders are
     * excluded, because an abandoned cart is not a purchase. Labelling the
     * aggregate "orders" made those two disagree on screen: a buyer sitting in
     * the list on 20 held orders rendered "0 orders", which reads as a broken
     * feature. "0 purchases" is instead exactly the signal FR-013 exists to
     * give — in your attendee list, never completed a checkout.
     */
    attendeePurchases: "{count, plural, one {# purchase} other {# purchases}}",
    /** Reads off the noun above: "3 purchases · Last Aug 2". */
    attendeeLastPurchase: "Last {date}",
    // Polite live-region counts announced when the list settles.
    countEvents: "{count, plural, one {# event} other {# events}}",
    countPeople: "{count, plural, one {# person} other {# people}}",
    countPlaces: "{count, plural, one {# place} other {# places}}",
    countGroups: "{count, plural, one {# group} other {# groups}}",
    countAttendees: "{count, plural, one {# attendee} other {# attendees}}",
    countVenues: "{count, plural, one {# place} other {# places}}",
    countOrders: "{count, plural, one {# order} other {# orders}}",
  },

  // ── Unsubscribe page ───────────────────────────────────────────────
  unsubscribe: {
    title: "Unsubscribe",
    processing: "Processing your request\u2026",
    successTitle: "You\u2019ve been unsubscribed",
    successDescription:
      "You won\u2019t receive any more emails from this list.",
    errorTitle: "Something went wrong",
    errorDescription:
      "We couldn\u2019t process your unsubscribe request. The link may be invalid or expired.",
    missingParams: "Invalid unsubscribe link. Required parameters are missing.",
    backToHome: "Go to homepage",
  },

  // ── "Stop invites from this organiser" (/invites/stop?token=) ──────
  // The invite email's footer link. Opening the page changes nothing; the
  // button does. `{link}` is replaced by the `…Link` key as a link.
  invitesStop: {
    pageTitle: "Stop invites",
    kicker: "Event invites",
    kickerConfirm: "Event invites · {organiser}",
    thisOrganiser: "this organiser",
    confirmTitle: "Stop invites?",
    confirmBody:
      "You\u2019ll stop getting event invites from {organiser}. This only affects them: other organisers can still invite you, and invites you already have keep working.",
    confirmButton: "Stop invites",
    confirmBusy: "Stopping invites\u2026",
    doneTitle: "Invites stopped",
    doneBody: "You won\u2019t get event invites from {organiser} any more.",
    doneUndo: "Changed your mind? {link} and we\u2019ll turn them back on.",
    doneUndoLink: "Contact us",
    invalidTitle: "This link doesn\u2019t work",
    invalidBody:
      "It may have been cut short when it was copied. Open the invite email again and use the link at the bottom. If that doesn\u2019t work either, {link}.",
    invalidBodyLink: "contact us",
    error: "Something went wrong. Please try again.",
    allLine: "Or {link}.",
    allLink: "stop invites from every organiser",
    allBusy: "Stopping all invites\u2026",
    allButton: "Stop all invites",
    doneAllBody:
      "You won\u2019t get event invites from any organiser on Ithas Fire any more.",
    alreadyBody: "You\u2019d already stopped invites from {organiser}.",
    alreadyAllBody:
      "You\u2019d already stopped event invites from every organiser.",
    goneBody:
      "The organiser who sent this has left Ithas Fire, so they can\u2019t invite you again. You can still stop event invites from every organiser.",
    expiredTitle: "This page has expired",
    expiredBody:
      "Anything you stopped here is still stopped. To change it, open the link in your email again.",
  },

  // ── App-wide 404 (app/not-found.tsx) ──────────────
  notFoundPage: {
    title: "Page not found",
    description:
      "The page you're looking for doesn't exist or may have been moved.",
    goHome: "Go home",
    browseEvents: "Browse events",
  },

  // ── Native-app Turnstile check (/challenge/turnstile) ──────────────
  challenge: {
    title: "Security check",
    body: "Complete the check below to go back to the app and try your password again.",
    returning: "Done. If the app doesn’t open, tap Return to the app.",
    unavailable:
      "We can’t run the security check right now. Go back to the app and try again later.",
    backToApp: "Back to the app",
    returnToApp: "Return to the app",
    invalidLink: "This link isn’t valid. Go back to the app and try again.",
  },
  attendeeReview: {
    pageTitle: "Rate this show",
    pageKicker: "Rate this show",
    progress: "Question {current} of {total}",
    deadline: "You have until {date} to share your feedback.",
    rating: {
      low: "Poor",
      high: "Great",
    },
    validation: {
      pickRating: "Pick a rating from 1 to 5.",
    },
    form: {
      overall: {
        q: "How was the show?",
        helper: "Your overall take. One tap.",
      },
      sound: {
        q: "How was the sound?",
        helper:
          "Bad sound can sink a great set — this tells the organizer where the room needs work.",
      },
      organization: {
        q: "How smoothly did it run?",
        helper:
          "Doors, set times, staff — did the night flow, or was it chaos?",
      },
      venueComfort: {
        q: "How comfortable was the place?",
        helper:
          "Sightlines, space, the basics. Optional — skip if you’d rather.",
      },
      value: {
        q: "Was it worth the price?",
        helper: "Did the night deliver for what you paid? Optional.",
      },
      text: {
        q: "Anything the organizer should hear?",
        helper:
          "This goes to the organizer without your name. Scores are only ever published in aggregate, once enough people have reviewed.",
        placeholder: "What worked, what didn’t…",
      },
    },
    nav: {
      back: "Back",
      backAria: "Go back to the previous question",
      continue: "Continue",
      continueAria: "Continue to the next question",
      submit: "Submit review",
      submitAria: "Submit your review",
      skip: "Skip the rest",
      skipAria: "Skip the remaining questions and submit",
    },
    success: {
      title: "THANK YOU",
      body: "That goes straight to the people who put this on. Scores only show up publicly once enough fans have weighed in.",
      viewEvent: "View event",
      backToTickets: "Back to my tickets",
    },
    error: {
      title: "Something went wrong",
      body: "We couldn’t load this review. Please try again.",
      retry: "Try again",
      submitFailed: "We couldn’t submit your review. Please try again.",
    },
    community: {
      pageTitle: "Rate this place",
      kicker: "Community review",
      unverified: "Unverified",
      privacyNote:
        "This goes privately to the place — including anything you write. It’s never shown with your name attached.",
      name: {
        q: "What’s your name?",
        helper: "Kept private — the place never sees it next to your review.",
        placeholder: "Your name",
      },
      email: {
        q: "What’s your email?",
        helper:
          "We won’t publish or share it. It just lets us confirm real feedback later.",
        placeholder: "you@example.com",
      },
      validation: {
        name: "Please enter your name.",
        email: "Please enter a valid email.",
      },
      success: {
        title: "THANK YOU",
        body: "Your feedback goes straight to the place. Ratings only show up publicly in aggregate, and only if the place chooses to publish them.",
        done: "Done",
      },
      error: {
        submitFailed: "We couldn’t submit your review. Please try again.",
      },
    },
    ineligible: {
      backToTickets: "Back to my tickets",
      event_not_found: {
        title: "Show not found",
        body: "We couldn’t find this show. It may have been removed.",
      },
      event_cancelled: {
        title: "This show was cancelled",
        body: "There’s nothing to review for a cancelled show.",
      },
      event_not_ended: {
        title: "The show hasn’t ended yet",
        body: "Come back once it’s over and let us know how it went.",
      },
      window_closed: {
        title: "Reviews have closed",
        body: "You can share feedback for up to 30 days after a show. This one’s window has passed.",
      },
      no_scanned_ticket: {
        title: "Reviews are from verified attendees",
        body: "We only take reviews from fans whose ticket was scanned at the door — that’s what keeps them trustworthy.",
      },
      already_reviewed: {
        title: "You’ve already reviewed this show",
        body: "Thanks — your feedback is already with the organizer. One review per show.",
      },
    },
  },
  errors: {
    // B2 gate (EmailVerificationRequired is the full prompt; this is the
    // one-line form a mutation's error text falls back to).
    emailVerificationRequired:
      "Verify your email to do this. You can send yourself a code in Account settings.",
    generic: "Something went wrong. Please try again.",
    twoFactorNeedsPasswordOrPasskey:
      "This account uses two-factor authentication and has no passkey, so its password can't be removed. Ask them to add a passkey or turn off two-factor first.",
    fieldRequired: "This field is required.",
    titleRequired: "Title is required.",
    startDateRequired: "Start date is required.",
    startDateInPast: "Start date must be in the future.",
    endDateRequired: "End date is required.",
    invalidInput:
      "Some of the information you entered is invalid. Please check the form and try again.",
    invalidImageType: "Unsupported image format. Use JPEG, PNG, GIF, or WebP.",
    forbidden: "You don\u2019t have permission to perform this action.",
    staffOnly: "This action is restricted to staff members.",
    insufficientRole:
      "You don\u2019t have the required role to perform this action.",
    humanNotFound:
      "Your user account could not be found. Please sign in again.",
    forceVerifyHoldsEmailAttached:
      "This account holds tickets, orders or a lineup or volunteer role sent to its email. Ask them to sign in with an email code, which verifies the address.",
    actorNotFound:
      "Your user account could not be found. Please sign in again.",
    organizationNotFound: "Group not found.",
    organizationInactive: "This group is no longer active.",
    eventNotFound: "Event not found.",
    eventNotDraft:
      "This event is no longer a draft and cannot be edited this way.",
    eventNotEditable: "This event can no longer be edited.",
    eventNotPublishable:
      "This event isn't ready to publish yet. Complete the required details first.",
    eventCategoryMissing: "Please select a category before publishing.",
    eventGated:
      "This event needs a password or an approved application. Open it on Ithas Fire to get in.",
    placeNotFound: "The selected place could not be found.",
    placeCommunityReviewsDisabled:
      "This place isn't taking performer reviews right now.",
    placeNotVerified:
      "This place page isn\u2019t available until the place has been verified.",
    ticketTypesRequired:
      "At least one ticket type is required before publishing.",
    ticketTypeNotFound: "Ticket type not found.",
    paidTicketingRequiresStripe:
      "Paid tickets need a connected payments account. Set up payments first.",
    paidTicketingRequiresFeePolicy:
      "Paid tickets aren’t available on this event yet because pricing hasn’t been configured on our side. Please contact support — free tickets still work.",
    chargebackTermsRequired:
      "This event is temporarily unavailable for paid checkout while the organizer updates payment terms. Please check back soon or contact the organizer.",
    orderNotFound: "Order not found.",
    orderNotRefundable: "This order is not eligible for a refund.",
    orderAlreadyRefunded: "This order has already been refunded.",
    claimRefundPending:
      "Your claim’s refund is already on its way, so there’s nothing more to request.",
    eventSalesClosed: "Ticket sales have ended for this event.",
    seatUnavailable: "One or more selected seats are no longer available.",
    stripeNotConnected:
      "The organizer\u2019s payment account isn\u2019t set up yet. Please contact the event organizer.",
    stripeNotConnectedOwner:
      "Your payout account isn\u2019t fully set up yet. Finish setup in Payments settings, or contact support if you\u2019ve already done so.",
    nonPositiveAmount:
      "The order total is invalid. Please adjust your selection and try again.",
    promoNotFound:
      "That promo code wasn\u2019t recognized. Please check and try again.",
    promoExpired: "This promo code has expired.",
    promoMaxRedeemed: "This promo code has reached its maximum number of uses.",
    idempotencyKeyConflict: "This action has already been completed.",
    // Deliberately names no noun. `IDEMPOTENCY_LOCK_IN_PROGRESS` is thrown from
    // 74 sites across 27 domains — series, events, templates, tickets,
    // memberships, comms, resale, places, volunteering, POS, agreements,
    // disputes, auth, orgs — and only the six in `orders` involve an order. The
    // old "Your order is already being processed" was wrong on ~68 of them,
    // including a booking-request claim page where no order exists.
    // "before trying again" rather than "do not retry": the lock is what makes
    // a retry safe, so the advice is to wait, not to worry.
    idempotencyLockInProgress:
      "That request is already being processed. Give it a moment before trying again.",
    searchUpdateRetry:
      "We couldn\u2019t update search just now \u2014 please try again.",
    // Checkout refused because the venue's tax rate could not be looked up
    // (the provider failed). Nothing was charged or held; retrying works.
    taxRateUnavailable:
      "We couldn\u2019t calculate tax \u2014 please try again in a moment.",
    // Door sales (Sell screen, door-sales step 9a). A cash sale below the
    // server's cash total: the till shows the new total from meta itself.
    cashAmountShort: "That\u2019s less than the cash total.",
    // "Enter tax rate" refused: the event needs no hand-entered rate. The
    // dialog shows a line per meta.reason; this is the fallback.
    manualTaxRateNotAllowed:
      "This event doesn\u2019t need a tax rate entered by hand.",
    quotaExceeded:
      "You\u2019ve reached the limit for this resource. You can request an increase.",
    // Generic transport categories (bare fallbacks when no domain code is set)
    notFound: "The requested item could not be found.",
    conflict:
      "This action conflicts with the current state. Please refresh and try again.",
    rateLimited:
      "You\u2019re doing that too quickly. Please wait a moment and try again.",
    inviteAllowanceExceeded:
      "That's more invites than you can send today. Send to fewer people, or try again tomorrow.",
    inviteResendTooSoon:
      "That invite was just sent. Wait a few minutes before sending it again.",
    invitesPaused:
      "Your invite emails are paused because someone marked them as spam. Open Invited guests on one of your gated events to see why and ask for a review.",
    transient:
      "Something went wrong temporarily. Please try again in a moment.",
    // Precondition / agreement gates
    waiverRequired: "You need to accept the waiver before continuing.",
    termsRequired: "You need to accept the terms before continuing.",
    refundPolicyRequired: "A refund policy is required before continuing.",
    scannerTermsRequired:
      "You need to accept the scanner terms before continuing.",
    attestationIncomplete:
      "Please complete the required attestation before continuing.",
    applicationAnswersIncomplete:
      "Please answer all required questions before submitting your application.",
    applicationWindowNotOpen:
      "Applications for this event haven’t opened yet. Check back once the application window opens.",
    applicationWindowClosed:
      "Applications for this event have closed and can no longer be submitted.",
    applicationCapReached:
      "This event has reached its application limit and isn’t accepting new applications.",
    applicationAlreadySubmitted:
      "You’ve already applied to this event. Check your email for updates on your application.",
    applicationSubmissionsExist:
      "Some applications for this event are still waiting on a decision, so a template can’t be added to its form right now. Review those applications first.",
    notConfigured:
      "This feature isn\u2019t set up yet. Please try again later or contact support.",
    cannotBookOwnAct:
      "You can\u2019t send a booking request to your own group.",
    performerModeRequired: "Turn on performer mode to continue.",
    billNotAllowed: "This kind of request doesn\u2019t take a lineup.",
    actNotTaggable: "One of the artists you added can\u2019t be tagged.",
    actAlreadyDeclined: "That artist already declined this request.",
    billLocked:
      "The event already exists, so the bill can\u2019t change here. Edit the event\u2019s lineup instead.",
    performerNotAcceptingRequests:
      "This performer isn\u2019t accepting booking requests right now.",
    placeNotAcceptingRequests:
      "This place isn\u2019t accepting requests right now.",
    // ── P3a (unclaimed venues) ── PLACE_NOT_TAKING_REQUESTS. Error copy takes
    // no arguments, so the place\u2019s name rides the error\u2019s meta.
    placeNotTakingRequests:
      "This place isn\u2019t taking requests on Ithas Fire yet.",
    duplicateOpenRequest: "You already have an open request for this.",
    invalidStatus: "This action isn\u2019t allowed in the current state.",
    // Venue confirmation: withdraw refused on a venue-owned event (stale chip).
    venueOwnedEvent:
      "This is your own event, so there\u2019s no confirmation to withdraw.",
    linesUnconfirmed: "All line items must be confirmed before continuing.",
    payeeNotReady: "The payee\u2019s payment details aren\u2019t ready yet.",
    eventAlreadyHasAgreement: "This event already has an agreement.",
    // Volunteer QR (scanner)
    volunteerQrExpired:
      "This volunteer QR code has expired. Ask for a new one.",
    volunteerQrInvalid: "This volunteer QR code isn\u2019t valid.",
    volunteerQrWrongEvent: "This volunteer QR code is for a different event.",
    volunteerPackNotFound: "That volunteer role pack no longer exists.",
    volunteerPackKeyTaken:
      "Another volunteer role pack already uses that key. Pick a different one.",
    volunteerPackHasPlatformRoles:
      "This pack still has catalogue roles attached. Remove its roles before deleting the pack.",
    ticketPackNotFound: "That ticket pack no longer exists.",
    ticketPackKeyTaken:
      "Another ticket pack already uses that key. Pick a different one.",
    ticketPackHasPlatformTemplates:
      "This pack still has catalogue templates attached. Remove its templates before deleting the pack.",
    // Better Auth
    emailNotVerified: "Please verify your email address before signing in.",
    userAlreadyExists: "An account with this email already exists.",
    // Network (mirrors NETWORK_ERROR_MESSAGE in @th/errors)
    network:
      "We couldn\u2019t reach Ithas Fire. Check your connection and try again.",
    // Open calls (open calls v1)
    openCallNotFound: "This open call isn't available.",
    openCallCoveredBySeries:
      "This date is part of a series that already has an open call.",
    seriesOpenCallConflict:
      "Some upcoming dates in this series have their own open call. Close those first.",
    openCallNotReopenable:
      "This call can't be reopened: its last date has started or the event has ended.",
    openCallClosed: "This call isn't taking applications any more.",
    openCallDatesRequired: "Pick at least one date you can do.",
    openCallDateInvalid:
      "One of the dates you picked isn't open on this call any more. Check your dates and try again.",
    openCallApplicationNotFound:
      "We couldn't find that application. Check the link in your email.",
    openCallLinkExpired: "This application link has expired.",
    openCallApplicationLocked:
      "The organizers have already seen your application, so it can't be changed now. You can still message them.",
    openCallApplicationDecided:
      "This application has already been decided, so it can't be changed or withdrawn. If you were picked, use Drop out instead.",
    openCallApplicationSuperseded:
      "You've applied again since this one, so change privacy on your newest application.",
    openCallThreadClosed:
      "This application was withdrawn, so its conversation is closed.",
    openCallVoteOwnApplication: "You can't vote on your own application.",
    openCallApplicationWithdrawn:
      "This application was withdrawn, so there's nothing to decide.",
    openCallApplicationNotPicked:
      "Only a picked act can drop out. If it hasn't been decided yet, withdraw your application instead.",
    openCallDateUnavailable:
      "That date can't be booked any more: it has started or been called off.",
    // ─────────────────────────────────────────────────────────────────
    // P2 error-code registry — machine-drafted copy (en). PENDING REVIEW
    // Generated from docs/specs/2026-06-23/error-code-map.ts (signed off
    // 2026-06-23). Keys are parity-gated: en.ts and es.ts must stay in sync.
    // ─────────────────────────────────────────────────────────────────
    actorEmailNotFound:
      "We couldn't process that email address. Please check it and try again.",
    actorMismatch: "You don't have permission to do this here.",
    agreementFinalized:
      "This agreement is finalized and can no longer be changed.",
    agreementLineNotFound: "We couldn't find that agreement line item.",
    agreementLinkedToOtherEvent:
      "This agreement is already linked to another event.",
    agreementMissing:
      "An agreement still needs to be signed before you can continue.",
    agreementMissingFeePolicy:
      "This agreement is missing its fee terms. Add them and try again.",
    agreementMissingLines:
      "This agreement needs at least one line item before you can continue.",
    agreementMissingPayoutTerms:
      "This agreement is missing payout terms. Add them before continuing.",
    agreementNotAccepted: "This agreement hasn't been accepted yet.",
    agreementNotCancellable:
      "This agreement has already ended, so there's nothing to cancel.",
    agreementNotDraft: "This can only be done while the agreement is a draft.",
    agreementNotEditable: "This agreement can no longer be edited.",
    agreementNotFound: "We couldn't find that agreement.",
    agreementNotProposed: "This agreement hasn't been proposed yet.",
    agreementPercentTotalExceeded:
      "The agreement splits add up to more than 100%. Please adjust the percentages.",
    alreadyAMember: "This person is already a member of this organization.",
    alreadySignedUp: "You're already signed up for this.",
    amountMismatch:
      "The amount doesn't match what we expected. Refresh and try again.",
    amountMustBePositive: "Enter an amount greater than zero.",
    anotherActiveAgreementExists:
      "There's already an active agreement for this event. Close it before creating a new one.",
    apiKeyAlreadyRevoked: "This API key has already been revoked.",
    apiKeyNotFound: "We couldn't find that api key.",
    audioUploadNotFound: "We couldn't find that audio upload.",
    availabilityNotFound: "We couldn't find that availability.",
    avatarKeyNotOwned: "You can only use an avatar image you uploaded.",
    bannerKeyNotOwned: "You can only use a banner image you uploaded.",
    blockNotFound: "We couldn't find that block.",
    blockPinned:
      "This block is pinned to the page. You can move it, but not remove or hide it.",
    bookingDateUnavailable:
      "The place isn't open at one of the times you picked. Choose another night or time.",
    bookingTermsNotFinalized:
      "Finalize the booking agreement before publishing this event.",
    bookingRequestExpired: "That booking request has expired.",
    bookingRequestNotFound: "We couldn't find that booking request.",
    bookingRequestNotPending:
      "This booking request is no longer pending, so it can't be updated.",
    // venue-booking-standards: the pitch misses an item the venue REQUIRES.
    standardsUnmet:
      "This place asks for a few things in every pitch. Add the missing items and send again.",
    bookingHoldNotFound: "We couldn't find that hold.",
    holdAlreadyPlaced: "This request already holds that date on this calendar.",
    holdLineAlreadyConfirmed:
      "Another act has already been confirmed for that date.",
    bookingHoldNotLive: "That hold has already been released or confirmed.",
    bookingHoldNotFirst: "Only the first hold in line can be challenged.",
    bookingHoldChallengeOpen:
      "There's already an open challenge on this date. Wait for the act to answer before challenging again.",
    bookingHoldNotChallenged: "That hold isn't under challenge.",
    bookingHoldChallengeLapsed:
      "The deadline on that challenge has passed and the hold was released.",
    bookingHoldsVenueOnly:
      "Holds are only available on requests sent to a place.",
    holdConfirmRequiresClaimedRequest:
      "This request hasn't been claimed by the act yet, so there's no one to book. Ask them to claim it before confirming a hold.",
    holdLineHasOpenChallenge:
      "There's an open challenge on this date. Wait for the act to answer before reordering the line, confirming another hold, or publishing an event on the date.",
    // `INVALID_STATUS: booking_request_not_accepted` from the thread's
    // venue-confirmation action — confirm never accepts (accept is the mint
    // point), so the venue is sent to the button that does.
    venueConfirmationRequestNotAccepted: "Accept the request first.",
    holdLineHasOpenChallengePublish:
      "There's an open challenge on this date in that calendar. Wait for the act to answer, or release the hold, before publishing.",
    holdLineChanged:
      "The line for that date changed while you were working. Refresh and try again.",
    holdDateMismatchesEvent:
      "This request already has an event on a different night. Move or cancel that event before confirming this hold.",
    // booking-the-night (spec 2026-09-25). Error copy takes no arguments, so
    // NIGHT_TAKEN's date and position ride its meta for the UI to show.
    nightTaken:
      "Another hold is ahead in line on that date, or the night is already booked. Challenge the hold ahead, or pick another night.",
    // The sender's side of NIGHT_TAKEN, with no meta: an act never learns
    // whose hold won the night (booking-holds FR-013).
    nightNoLongerAvailable:
      "This night is no longer available. The place has been told.",
    dateNotAskedFor:
      "That date isn't one the request asked for. To book it, send terms instead.",
    holdConfirmRetired:
      "On a booking request, the night is booked when the sender agrees the terms. Send terms, or book without terms on a date they asked for.",
    noActReady:
      "You can challenge the 1st hold only when someone else in line has terms ready for that night.",
    venueConfirmationNotForRequests:
      "Place confirmation is for events built first. For a booking request, send terms or book the night instead.",
    bookingNotCancellable:
      "Only a booked night can be cancelled, and only before the event starts.",
    bookingAlreadyHasNight: "This request already has a night booked.",
    termsSentForAnotherNight:
      "Terms for another night are with the sender. Pull the terms back, or wait for the sender's answer, before booking another night.",
    termsChangedSinceViewed:
      "These terms changed after you opened them. Look them over, then agree again.",
    // The sender's side of HOLD_DATE_MISMATCHES_EVENT, with no meta. The
    // night is NOT booked when this shows, so it names the request.
    eventOnAnotherNight:
      "The event for this request is on a different night.",
    // Event-first request whose own event was cancelled or archived (N11).
    eventFirstOriginGone:
      "The event for this request was cancelled or archived.",
    // The event these terms were finalized against was cancelled or archived.
    linkedEventNotLive:
      "The event linked to this request was cancelled or archived.",
    // The place is suspended or retired; no night there is booked.
    placeNotTakingBookings: "This place isn't taking bookings right now.",
    termsAgreedForAnotherNight:
      "Terms for another night are already agreed. Reopen the terms before booking another night.",
    // booking-the-night P2c. The booking was cancelled: no new holds, no
    // second booking on this request.
    bookingCancelled:
      "This booking was cancelled. The request can't take new holds or be booked again.",
    // Withdraw / close request after the night is booked.
    bookingNightBooked:
      "The night for this request is booked. To undo it, cancel the booking.",
    // Venue side: the event sits on another calendar than the night's line.
    eventOnAnotherCalendar:
      "This request's event is on a different calendar from the night being booked. Move the event, or book the night on its calendar.",
    // Cancel booking / finalize: the booking is linked to more than one live
    // holds-without-a-request: one live hold per holder per night (FR-005),
    // and a booker's or the place's own hold answers a challenge by booking
    // or releasing it (H13).
    bookingHoldHolderExists:
      "That person or organization already has a hold on this date in this calendar.",
    challengeAnswerNeedsBookOrRelease:
      "Book the date or release the hold to answer this challenge.",
    // event. Side-neutral: the act sees it too (bare), the venue with meta.
    bookingHasMultipleEvents:
      "More than one event is linked to this booking's night. The place needs to sort out the extra event first.",
    // Finalize: the chosen event belongs to neither the venue nor the act.
    eventOwnerNotBookingParty:
      "That event doesn't belong to either side of this booking, so these terms can't be linked to it.",
    // An event-first request's terms finalize only against its own event.
    eventFirstRequiresOriginEvent:
      "These terms can only be finalized against the event this request came from.",
    bookingTagNotFound: "We couldn't find that booking tag.",
    bookingTagSlugTaken: "A booking tag with that name already exists.",
    bookingAssigneeNotEligible:
      "That person can't be assigned — they need an edit role in the organization that owns this place.",
    bookingAssignmentNotApplicable:
      "Assignment isn't available for places owned directly by a person.",
    // ── booking-the-night P2d-1 (saved reasons) ──
    savedSnippetLimitReached:
      "You can keep up to 30 saved reasons. Delete one to add another.",
    savedSnippetNotFound: "That saved reason is gone. Refresh to see your list.",
    savedSnippetOrderChanged:
      "Your saved reasons changed while you were reordering. Refresh and try again.",
    // ── booking-the-night P2d-2 ──
    termsAgreedForThisNight:
      "Terms for this night are already agreed, so there is nothing to challenge or keep. The place books it with Create event.",
    // ── P3b (asks) ── BOOKING_ASK_NOT_FOUND
    bookingAskNotFound:
      "That ask is no longer on this booking. Refresh to see what the place is asking for.",
    buyerMustBeActor:
      "You need to be signed in as the buyer to complete this purchase.",
    calendarNotFound: "We couldn't find that calendar.",
    calendarRequiresActiveSpace:
      "Pick at least one space that is still active. A calendar with only retired spaces has nowhere to put an event.",
    calendarSlugTaken:
      "Another calendar at this place already uses that link name. Pick a different one.",
    cannotBuyOwnListing: "You can't buy your own listing.",
    cannotChangeOwnStatus: "You can't change your own status.",
    cannotDelegateToSelf:
      "You can't delegate this to yourself. Choose a different person.",
    delegateSelfBenefitForbidden: "Delegates can't send tickets to themselves.",
    cannotDeleteAccountWithOrderHistory:
      "Your account has order or ticket history and can't be fully deleted. Contact support if you'd like help with this.",
    cannotDeleteBuiltinPreset: "Built-in presets can't be deleted.",
    cannotDeleteOwnAccount: "You can't delete your own account.",
    cannotDeleteSoleOrgOwner:
      "You're the sole owner of an organization. Transfer ownership to another member before deleting your account.",
    cannotDemoteLastOwner:
      "You can't change this role because an organization must always have at least one owner.",
    cannotOverwriteBuiltinPreset:
      "Built-in presets can't be overwritten. Save a copy instead.",
    cannotReadOtherHumanDefaults:
      "You can only view your own default settings.",
    cannotRemoveLastOwner:
      "You can't remove this member because an organization must always have at least one owner.",
    cannotRetireLastActiveSpace:
      "You can't retire this space because a place must always have at least one active space.",
    cannotRetireLastActiveSpaceOnCalendar:
      "You can't retire this space because it is the only active space left on one of your calendars. Give that calendar another space first.",
    cannotSetDefaultsForAnotherHuman:
      "You can only change your own default settings.",
    cannotTransferToSelf:
      "You can't transfer a ticket to yourself. Enter a different recipient.",
    // Org cash refund (Sell → Cash taken tonight, and the Orders panel;
    // door-sales step 9b) past event end + 7 days. Platform staff are not
    // bound by the window.
    cashRefundWindowClosed:
      "The window to refund this cash sale has closed. Contact support to refund it.",
    categoryAlreadyExists: "A category with that name already exists.",
    categoryEnglishNameRequired: "This request needs an English name before it can be approved.",
    categoryInactive: "That category is inactive and can't be used right now.",
    categoryNotFound: "We couldn't find that category.",
    categoryRequestAlreadyReviewed:
      "This category request has already been reviewed.",
    categoryRequestNotFound: "We couldn't find that category request.",
    categorySlugTaken:
      "Another category uses that URL, now or as an old address.",
    channelIneligible: "That channel can't be used for this notification.",
    claimAlreadyExists: "A claim for this has already been opened.",
    claimAlreadyResolved: "This claim has already been resolved.",
    claimNotResaleOrder: "Claims can only be opened on resale orders.",
    claimNotRespondent: "Only the other party in this claim can respond to it.",
    claimResponseDeadlinePassed:
      "The deadline to respond to this claim has passed.",
    claimTicketNotHeld:
      "You can only file a claim on a ticket you still hold. If you transferred, gave away or listed it, the claim isn't available.",
    claimApprovalTicketNotHeld:
      "The buyer who filed this claim no longer holds the ticket, or has listed it for resale, so the claim can\u2019t be approved. If they listed it, they can cancel the listing and you can approve after; otherwise, deny the claim.",
    claimWindowExpired: "The window to open a claim has closed.",
    claimWindowNotOpen: "The window to open a claim isn't open yet.",
    clientKeyTooShort:
      "Something went wrong with that request. Please try again.",
    confirmationPhraseMismatch:
      "The confirmation text didn't match. Type it exactly as shown and try again.",
    contactMustHaveEmailOrPhone:
      "Add an email or a phone number for this contact.",
    counterFieldsRequired:
      "Add the required details for your counter-offer before submitting.",
    creditBalanceChanged:
      "Your credit balance changed since you started. Review it and try again.",
    crossOwnerMergeNotAllowed:
      "These records belong to different owners and can't be merged.",
    curatedUntilBeforeEvent:
      "The curation end date must be on or after the event date.",
    curatedUntilUnavailable:
      "A curation end date isn't available for this event.",
    currencyMismatch:
      "These items use different currencies and can't be combined in one order.",
    currentPasswordInvalid: "That password isn't correct.",
    currentPasswordRequired: "Enter your current password to confirm.",
    delegationNotFound: "We couldn't find that delegation.",
    documentDeleted:
      "This document has been deleted and is no longer available.",
    documentNotFound: "We couldn't find that document.",
    documentsRequired: "Upload the required documents before continuing.",
    domainMismatch:
      "This doesn't match the allowed domain. Use an address on the approved domain.",
    donationAmountRequired: "Enter a donation amount to continue.",
    donationBelowMinimum:
      "Your donation is below the minimum amount. Enter a higher amount to continue.",
    duplicatePayee: "This payee is already on the list. Add a different one.",
    duplicatePromo:
      "A promo code with this name already exists. Choose a different code.",
    editSuggestionAlreadyReviewed:
      "This edit suggestion has already been reviewed.",
    editSuggestionInvalidFields:
      "The suggestion includes fields that can't be changed through an edit suggestion.",
    editSuggestionNotFound: "We couldn't find that edit suggestion.",
    emailMismatch: "That email doesn't match. Check it and try again.",
    embedNotFound: "We couldn't find that embed.",
    endBeforeStart: "The end time can't be before the start time.",
    eventAddressIsOwnWithheldPlace:
      "This is the address of a place you manage that hides its address. Choose that place under My Places instead.",
    eventAlreadyArchived: "This event is already archived.",
    eventAlreadyCancelled: "This event has already been cancelled.",
    eventAlreadyCompleted: "This event has already been marked completed.",
    eventAlreadyEnded: "This event has already ended, so you can't RSVP to it.",
    eventAlreadyInSeries: "This event is already part of a series.",
    eventArchived: "This event is archived. Restore it before making changes.",
    eventCancelled:
      "This event has been cancelled, so this is no longer available.",
    eventDateInPast: "That date has already passed, so you can't RSVP to it.",
    eventDateNotFound: "We couldn't find that date on this event.",
    eventDateNotRsvpable: "That date isn't open for RSVPs.",
    eventHasOrdersUseCancelInstead:
      "This event has orders, so it can't be deleted. Cancel it instead.",
    eventHumanNotFound: "We couldn't find that person on the event.",
    eventLocationRequired: "Add a location before publishing this event.",
    eventMoved:
      "This event's date changed since you opened it. Check the new date, then confirm again.",
    eventMismatch:
      "These items belong to different events and can't be combined in one order.",
    eventMissingPayoutTerms:
      "This event needs payout terms before you can continue.",
    eventNotApplicationGated:
      "This event doesn't use applications, so that action doesn't apply.",
    eventNotArchivable: "This event can't be archived in its current state.",
    eventNotCancellable: "This event can't be cancelled in its current state.",
    eventNotCommunity:
      "This event isn't a community listing, so it can't be edited this way.",
    eventNotCompletable: "Only a published event can be marked completed.",
    eventNotCompleted: "This can only be done once the event has finished.",
    eventNotDeletable: "This event can't be deleted in its current state.",
    eventNotDraftUseCancelInstead:
      "This event is published, so it can't be deleted. Cancel it instead.",
    eventNotInOrg: "This event isn't part of your organization.",
    eventNotOnSale: "Tickets for this event aren't on sale right now.",
    eventNotOrgOwned:
      "This event belongs to another organization, so you can't manage it here.",
    eventNotPasswordGated: "This event doesn't require a password.",
    eventNotPublished:
      "This event needs to be published before you can do that.",
    eventNotTicketed: "This is a free RSVP event — it doesn't sell tickets.",
    eventPasswordChallengeRequired:
      "Complete the security check, then enter the password again.",
    eventPasswordInvalid:
      "That password isn't correct. Please check it and try again.",
    eventPasswordMissing:
      "This event is password protected. Enter the password to continue.",
    eventsDifferentOrg:
      "These events belong to different organizations and can't be combined.",
    eventsDifferentOwner:
      "These events have different owners and can't be combined.",
    eventSlugConflict:
      "That event web address is already taken. Try a different one.",
    eventSlugContextMissing:
      "Something required is missing. Please complete it and try again.",
    eventSlugMissing: "This event needs a web address before you can continue.",
    eventSlugRedirect: "Event slug redirect.",
    eventSlugRegenerationNotAllowed:
      "This event's web address can't be changed once it's published.",
    eventStartNotInSchedule:
      "The event's date isn't included in the repeat schedule. Make sure the schedule includes the event's own day.",
    eventWasPublished:
      "This event is already published, so that can't be changed.",
    expansionRequestAlreadyPending:
      "You already have an expansion request pending review.",
    expansionRequestAlreadyReviewed:
      "This expansion request has already been reviewed.",
    expansionRequestNotFound: "We couldn't find that expansion request.",
    expectedPaidOrder: "This action only applies to paid orders.",
    expirationMustBeFuture: "The expiration date must be in the future.",
    expiresAtInPast:
      "The expiry date must be in the future. Please pick a later date.",
    featuredItemTargetNotFound:
      "We couldn't find the item you're trying to feature.",
    featuredItemTargetNotPublic:
      "You can only feature items that are public. Make it public first.",
    feePolicyNotActive:
      "This fee policy isn't active, so it can't be used right now.",
    feePolicyNotFound: "We couldn't find that fee policy.",
    feePolicyOutOfScope:
      "This fee policy doesn't apply here, so it can't be used.",
    followNotFound: "We couldn't find that follow.",
    followsDisabled: "Following isn't available for this organizer right now.",
    formMismatch: "That isn't valid. Please check it and try again.",
    formNotFound: "We couldn't find that form.",
    gateRefundWindowExpired: "The window to refund this gate sale has closed.",
    globalScopeDisabled:
      "This can't be applied everywhere. Choose a specific scope instead.",
    humanIdOrExternalNameRequired: "Add a person or enter a name to continue.",
    humanMismatch: "That isn't valid. Please check it and try again.",
    idempotencyKeyRequired:
      "Something went wrong processing your request. Please try again.",
    imageNotFound: "We couldn't find that image.",
    imagesWrongEvent: "That image belongs to a different event.",
    importAlreadyCompleted: "This import has already finished.",
    importNotFound: "We couldn't find that import.",
    importOwnerMismatch: "You don't have permission to access this import.",
    insufficientCapacity:
      "There aren't enough tickets left for this request. Try a smaller quantity.",
    invalidArgument: "That isn't valid. Please check it and try again.",
    invalidBlockOrder:
      "The block order isn't valid. Please reorder and try again.",
    invalidCategoryRequestName:
      "That category name isn't valid. Please check it and try again.",
    invalidCategorySlug:
      "2 to 40 lowercase letters and numbers, joined by single hyphens.",
    invalidDatetime:
      "That date and time isn't valid. Please check it and try again.",
    invalidLineReference:
      "We couldn't find that line item. Please refresh and try again.",
    invalidNotificationPayload:
      "That isn't valid. Please check it and try again.",
    invalidOrderItem:
      "One of the items in your order isn't valid. Review your cart and try again.",
    invalidTimeWindow:
      "That time range isn't valid. Check the start and end times and try again.",
    invalidUnsubscribeToken: "This unsubscribe link is invalid or has expired.",
    invitationExpired:
      "This invitation has expired. Ask the sender for a new one.",
    invitationNotFound: "We couldn't find that invitation.",
    invitationNotPending:
      "This invitation has already been accepted or declined, so it can't be used again.",
    itemsNotRefundable: "These items aren't eligible for a refund.",
    lineDeclined:
      "This line has already been declined, so it can't be changed.",
    lineDoesNotRequireConfirmation:
      "This line doesn't need confirmation, so there's nothing to confirm here.",
    lineNotCounterable:
      "This line can't take a counter-offer in its current state.",
    lineNotDeclinable: "This line can't be declined in its current state.",
    lineupRowAlreadyRegistered:
      "That lineup entry has already been registered.",
    listingAlreadyHeld:
      "Someone else is currently holding this listing. Try again shortly.",
    listingNotActive: "This listing is no longer available.",
    listingNotFound: "We couldn't find that listing.",
    listOwnerMismatch: "You don't have permission to access this list.",
    magicLinkAlreadyRedeemed:
      "This sign-in link has already been used. Request a new one.",
    magicLinkExpired: "This sign-in link has expired. Request a new one.",
    magicLinkNotFound: "We couldn't find that sign-in link. Request a new one.",
    magicLinkWrongRecipient:
      "This sign-in link can't be used here. Request a new one.",
    memberNotFound: "We couldn't find that member.",
    // ── Memberships (recurring) + the order-kind guard they introduced ──
    // No ICU arguments in errors.* — the resolver's translator has no seam
    // for values, so an interpolated error THROWS from inside the handler
    // (pinned by error-code-parity's argument-free rule).
    membershipNotFound: "We couldn't find that membership.",
    membershipsSuspended:
      "Memberships are suspended for this group right now. Please contact the organizer.",
    membershipBenefitNotFound:
      "We couldn't find that benefit on this tier. It may already have been removed.",
    membershipBenefitInvalidTerms:
      "Those discount terms don't work. A percentage has to be between 1 and 100, an amount off has to be at least a cent, and a cap has to be at least as large as the amount it caps.",
    membershipTierArchived:
      "This membership tier has been archived and can't be changed or published.",
    membershipTierNotActive:
      "This membership tier isn't open to new members right now.",
    membershipTierNotFound: "We couldn't find that membership tier.",
    membershipTierPriceLocked:
      "This tier's price is locked because it has had a member. Archive it and create a new tier at the new price — existing members keep the price they agreed to.",
    // Same archive-and-replace shape as the price lock above: the billing port
    // has no way to migrate default_tax_rates on live subscriptions, so a
    // category change would re-categorize our tax records while live members
    // kept billing under the old category's rates.
    membershipTierTaxCategoryLocked:
      "This tier's tax category is locked because it has live members. Archive it and create a new tier in the category you want — existing members keep billing under the category they signed up with.",
    // Thrown when a ticket-order action (refund quote, wallet pass, scan) is
    // pointed at a non-ticketing order, e.g. a membership charge.
    expectedTicketingOrder: "This action only applies to ticket orders.",
    // Provider outage — we refuse to guess a tax rate rather than bill wrong.
    taxJurisdictionUnavailable:
      "We couldn't look up tax rates for your area just now. Nothing was charged — please try again in a few minutes.",
    // Provider answered: it does not cover this location. Normal rejection.
    taxJurisdictionUnsupported:
      "Paid memberships aren't available in your location yet.",
    missingTarget: "Please choose who this applies to and try again.",
    moderatorApplicationAlreadyPending:
      "You already have a moderator application waiting for review.",
    moderatorApplicationAlreadyReviewed:
      "This moderator application has already been reviewed.",
    moderatorApplicationNotFound:
      "We couldn't find that moderator application.",
    multipleActiveAgreements:
      "More than one agreement is active for this event. Please contact support.",
    noOrdersToMigrate: "There are no orders to migrate.",
    noPayeeSubject: "No payout recipient is set up yet. Add one to continue.",
    noPayoutTermsConfigured:
      "No payout terms are set up yet. Add them before continuing.",
    noRandomEventAvailable:
      "There aren't any events to show right now. Check back soon.",
    noRefundableItems: "There are no items left to refund on this order.",
    noSplitsFound: "No payout splits have been set up for this event.",
    noStripeAccount:
      "Connect a payout account before you can receive payments.",
    notACashOrder:
      "This action only applies to cash orders, and this isn't one.",
    notAgreementParty: "Only a party to this agreement can do this.",
    termsEditorOnly:
      "Only the place or organizer can change these terms. You can accept or decline once they send them for review.",
    actResponseOnly:
      "Only the act can accept or decline these terms. Pull the agreement back if you need to change them.",
    notAPosCardOrder:
      "This action only applies to in-person card orders, and this isn't one.",
    notAPosOrder:
      "This action only applies to in-person orders, and this isn't one.",
    notAuthorized: "You don't have permission to do this.",
    notConnected: "This account isn't connected yet. Connect it to continue.",
    noTicketTypes:
      "This event doesn't have any ticket types yet. Add one to continue.",
    notLockHolder:
      "Someone else is editing this right now. Try again once they're done.",
    notResourceOwner: "You don't have permission to manage this item.",
    noUpdatesProvided:
      "There's nothing to update. Make a change and try again.",
    occurrenceDuplicateDate:
      "This series already has a date at that time. Pick a different date or time.",
    occurrenceNotFound: "We couldn't find that occurrence.",
    occurrenceNotSkippable:
      "Only planned dates can be skipped — this one already has an event or was already skipped.",
    occurrenceNotSkipped:
      "This date isn't skipped, so there's nothing to restore.",
    optionsNotAllowed:
      "The options you selected aren't available for this item.",
    optionsRequired: "Please select the required options before continuing.",
    orderDisputed:
      "This order is under dispute and can't be changed right now.",
    orderEmpty: "Your order is empty. Add a ticket before you continue.",
    orderEventMismatch:
      "These items belong to a different event and can't be combined in one order.",
    orderItemNotFound: "We couldn't find that order item.",
    orderNonRefundable: "This order can't be refunded.",
    refundWindowClosed: "The refund window for this event has closed.",
    resaleOrderUseFullRefund:
      "Resale tickets are refunded as a whole order, not one ticket at a time.",
    orderNotFree:
      "This order has a balance due and can't be completed as a free order.",
    orderNotInOrg:
      "This order belongs to a different organization, so you can't access it.",
    orderNotOwned:
      "This order belongs to someone else, so it can't be changed.",
    orderNotPaid:
      "This order hasn't been paid yet, so this action isn't available.",
    orderNotPending: "This order is no longer pending, so it can't be changed.",
    orderNotProcessable: "This order can't be processed in its current state.",
    orderNotSucceeded:
      "This order hasn't been paid yet, so this can't be done.",
    orderRequiredForResale:
      "You need a valid order to list this ticket for resale.",
    orgAlreadyArchived: "This organization is already archived.",
    orgHasActiveEvents:
      "You can't archive this organization while it still has active events.",
    orgNotFound: "We couldn't find that org.",
    ownerCanOnlyEscalate:
      "As the owner, you can only escalate this — you can't lower its priority.",
    ownerNotFound: "We couldn't find that owner.",
    pageImageKeyNotOwned:
      "That image isn't available to use here. Upload your own and try again.",
    pageNotFound: "We couldn't find that page.",
    passwordRequired: "A password is required to continue. Please enter it.",
    payeeAlreadyAssigned: "This payee is already assigned.",
    payeeChangeNotAllowed: "The payee can't be changed in the current state.",
    payeeChargesDisabled:
      "This payout account can't accept payments yet. Finish setting it up to continue.",
    payeeMissingStripeAccount:
      "Connect a payout account before you can get paid.",
    payeeNotActive: "This payee isn't active, so it can't be used right now.",
    payeeNotConnected:
      "No payout account is connected yet. Connect one to continue.",
    payeeNotFound: "We couldn't find that payee.",
    payeePayoutsDisabled:
      "Payouts are turned off for this account. Finish your payment setup to receive funds.",
    paymentIntentMismatch:
      "We couldn't verify this payment. Please refresh and start checkout again.",
    paymentIntentOrderMismatch:
      "This payment doesn't match your order. Please refresh and start checkout again.",
    paymentNotSucceeded:
      "Your payment hasn't gone through, so this can't be completed.",
    payoutLineNotFound: "We couldn't find that payout line.",
    payoutsNotEnabled:
      "Payouts aren't enabled yet. Complete your payment setup to start receiving funds.",
    payoutTermsNotFound: "We couldn't find those payout terms.",
    pendingTransferAlreadyExists:
      "A transfer for this ticket is already pending. Cancel it before starting a new one.",
    pendingTransferExpired:
      "This pending transfer has expired. Start a new transfer to continue.",
    pendingTransferNotFound:
      "We couldn't find that pending transfer. It may have been completed or cancelled.",
    phoneFormatInvalid:
      "That phone number isn't valid. Please check it and try again.",
    posReaderAlreadyPaired:
      "This card reader is already paired. Unpair it before pairing it again.",
    posReaderBusy:
      "This card reader is busy with another transaction. Wait for it to finish, then try again.",
    posReaderNotFound: "Card reader not found.",
    posReaderOffline:
      "This card reader is offline. Check that it’s powered on and connected, then try again.",
    // Deliberately identical to posReaderNotFound: a reader belonging to
    // another group must be indistinguishable from one that doesn't exist, or
    // the message becomes an enumeration oracle.
    posReaderOrgMismatch: "Card reader not found.",
    posReaderRegistrationCodeInvalid:
      "That pairing code isn’t valid. Check the code shown on the reader and try again.",
    phoneRequiredForSms: "Add a phone number to receive SMS updates.",
    placeAlreadyExists:
      "A place with this name is already here. Use that one instead.",
    placeArchived: "This place has been archived and can't be used.",
    placeHasLiveListings:
      "Listings that haven't happened yet still use this place. Archive it after they end, or move them first.",
    placeHasOwner:
      "Moderators can't change this place: it has an owner, a claim in review, or an organiser's upcoming event.",
    placeIdRequired: "Please choose a place before you continue.",
    placeLayoutEmpty: "Add seats to this layout before you can use it.",
    placeLayoutNotFound: "We couldn't find that seating layout.",
    // Fires on `place.status !== "ACTIVE"` — SUSPENDED or ARCHIVED. It is
    // deliberately vague about which: a venue is created ACTIVE, so there is no
    // "not yet" state to describe, and naming "suspended" would be wrong for an
    // archived one. It also guards reviews and templates, not just events, so it
    // cannot say "can't host events".
    placeNotActive: "This place is no longer active, so that can't be done.",
    placeNotEligibleForVerification:
      "This place doesn't yet meet the requirements for verification.",
    placeStatsNotFound: "We couldn't load stats for this place yet.",
    platformTemplateReadonly:
      "This template is provided by the platform and can't be edited.",
    presetNotFound: "We couldn't find that preset.",
    primaryAgreementMissing:
      "A primary agreement needs to be in place before you can continue.",
    primaryOrderResaleLinkedTransferRequiresManualReview:
      "This transfer needs a manual review before it can go through.",
    promoMinOrderNotMet:
      "Your order doesn't yet meet the minimum required for this promo code.",
    promoNotApplicable:
      "This promo code doesn't apply to the items in your order.",
    promoNotOwned:
      "This promo code belongs to another organization, so you can't manage it.",
    promoNotStackable:
      "This promo code can't be combined with another offer on your order.",
    promoRedeemedByHuman: "This promo code has already been used.",
    proposedEndBeforeStart:
      "The end time can't be before the start time. Please adjust the dates.",
    qtyExceedsOrder:
      "That quantity is more than this order contains. Lower it and try again.",
    questionNotFound: "We couldn't find that question.",
    recipientAlreadyHasAccount:
      "We couldn't complete this for that recipient. Please check the address and try again.",
    recurrenceHasNoUpcomingDates:
      "This repeating schedule has no upcoming dates. Adjust the dates and try again.",
    refundAmountZero:
      "The refund amount is zero, so there's nothing to refund.",
    refundNotTerminal:
      "This refund is still processing. Please wait a moment before trying again.",
    requestedLimitNotHigher:
      "The new limit must be higher than your current one.",
    resaleDisabledForEvent:
      "The organizer has turned off ticket resale for this event.",
    resaleNotAllowedForType: "This ticket type can't be resold.",
    resaleNotEnabled: "Resale isn't enabled for this event.",
    resalePriceExceedsCap:
      "Your resale price is above the most this ticket can be listed for.",
    resalePurchasePriceUnknown:
      "We couldn't confirm this ticket's original price, so it can't be resold. Contact support.",
    resaleShareInUse:
      "Resale is on for at least one ticket type, so the resale share has to stay set. You can change it. Each ticket keeps the share recorded at its first sale; a ticket sold before any share was set takes the one in force when it is first listed.",
    resaleSplitsOverTotal:
      "The resale lines add up to more than 100%. Together they can take at most the whole resale share, so lower one or more and save again.",
    resaleTermsMissing: "Resale terms need to be set before you can continue.",
    resaleUnwindMissingListingId:
      "Something went wrong undoing this resale. Please try again.",
    reuseSourceNotOwned: "You can only reuse content from items you own.",
    reuseSourceStillActive:
      "The item you're reusing from is still active. Finish or close it first.",
    reviewAlreadyFlagged: "You've already flagged this review.",
    reviewAlreadyHidden: "This review is already hidden.",
    reviewAlreadyResponded: "You've already responded to this review.",
    reviewNotFound: "We couldn't find that review.",
    reviewNotHidden: "This review isn't hidden, so there's nothing to unhide.",
    roleFull: "This role is already full.",
    roleNotFound: "We couldn't find that role.",
    saleCutoffPassed: "Sales for this event have closed.",
    savedLocationNotFound: "We couldn't find that saved location.",
    scannerTermsVersionMismatch:
      "The scanner terms have been updated. Review and accept the latest version to continue.",
    scheduledForInPast:
      "Choose a date and time in the future to schedule this.",
    scopeRequiresScopeId: "Choose what this should apply to before saving.",
    seatAllocationMismatch:
      "Your seat selection doesn't match what's available. Please reselect your seats.",
    seatAssignmentCountMismatch:
      "The number of seats doesn't match your tickets. Assign one seat per ticket.",
    seatAssignmentQtyMismatch:
      "The number of seats selected doesn't match your ticket quantity.",
    seatDuplicateInRequest:
      "You've selected the same seat more than once. Please pick distinct seats.",
    seatIdsDuplicate:
      "Some seats are selected more than once. Please pick distinct seats.",
    seatIdsInvalid:
      "One or more selected seats are no longer valid. Please choose your seats again.",
    seatIdsNotAssigned: "These seats aren't assigned to your order.",
    seatIdsNotUnique:
      "The same seat was selected more than once. Remove duplicates and try again.",
    seatIdsRequired: "Please select your seats before you continue.",
    seatNotFound: "We couldn't find that seat.",
    seatNotInOrder: "This seat isn't part of your order.",
    seatPriceChanged:
      "The price of one of your seats changed. Check the new price and try again.",
    seatPriceOverrideAdjustableTier:
      "No prices were saved. Seats in a section with a pay-what-you-want ticket type can't have their own price, because the buyer chooses the amount there. Pick seats in another section.",
    seatPriceOverrideNoFixedTier:
      "No prices were saved. Seats can only have their own price in a section that sells a fixed-price ticket type. Add one to the section, or pick seats in another section.",
    seatSectionMismatch:
      "The selected seats aren't all in the same section. Please choose seats from one section.",
    seatSectionNotFound: "We couldn't find that seating section.",
    seatTaken: "That seat was just taken. Please choose another seat.",
    selfFollowNotAllowed: "You can't follow your own account.",
    sellerPayoutNotSetup: "Set up your payout details before you can sell.",
    seriesInactive: "This series isn't active.",
    seriesNameTaken: "That series name is already in use. Choose another.",
    seriesNotFound: "We couldn't find that series.",
    seriesScheduleInvalid:
      "This series schedule isn't valid. Please check it and try again.",
    settlementNotFound: "We couldn't find that settlement.",
    shiftFull: "This shift is already full.",
    shiftNotFound: "We couldn't find that shift.",
    shiftSignupsPaused:
      "The organiser can't take new volunteers right now. Shifts you already claimed still stand.",
    signupMissingHuman: "Add the volunteer's details to complete this signup.",
    signupNotApproved: "This signup hasn't been approved yet.",
    signupNotFound: "We couldn't find that signup.",
    signupNotReviewable: "This signup can't be reviewed in its current state.",
    signupNotWithdrawable:
      "This signup can't be withdrawn in its current state.",
    slugTaken: "That web address is already taken. Try a different one.",
    sourceAndTargetMustDiffer:
      "The source and destination can't be the same. Please pick a different destination.",
    sourceCannotBeTarget:
      "The source and destination can't be the same. Please pick a different one.",
    spaceNotFound: "We couldn't find that space.",
    splitsTotalInvalid:
      "The payout splits must add up to 100%. Adjust them and try again.",
    stripeEventConflict:
      "We've already processed this update. No action is needed.",
    submissionEventMismatch: "That submission belongs to a different event.",
    submissionNotFound: "We couldn't find that submission.",
    submissionNotReviewed:
      "This submission hasn't been reviewed yet. You can act on it once review is complete.",
    suggestedBelowMinimum:
      "That amount is below the minimum allowed. Enter a higher amount.",
    supportThreadUnavailable:
      "This support conversation is busy right now. Please wait a moment and try again.",
    targetEventNotActive:
      "The destination event isn't active, so this can't be completed.",
    targetLacksScannerRole:
      "This person isn't a scanner, so this can't be done.",
    targetListNameRequiredForNewList: "Enter a name for the new list.",
    targetListNotFound: "We couldn't find that list.",
    targetNotFound: "We couldn't find the person you selected.",
    targetNotMember: "This person isn't a member of your organization.",
    templateArchived:
      "This template is archived. Restore it or pick another to continue.",
    templateInactive:
      "This template isn't active. Activate it or choose another to continue.",
    templateNameTaken:
      "A template with that name already exists. Choose a different name.",
    templateNotActive: "This template isn't active.",
    templateNotFound: "We couldn't find that template.",
    threadNotFound: "We couldn't find that thread.",
    ticketAlreadyOwnedByTarget:
      "That person already owns this ticket, so there's nothing to transfer.",
    ticketItemMissingTicketType:
      "Something went wrong with this ticket. Please try again or contact support.",
    attendeeReviewAlreadySubmitted:
      "You've already reviewed this show. Thanks for your feedback!",
    attendeeReviewEventNotEnded:
      "This show hasn't ended yet. Come back once it's over to share your feedback.",
    attendeeReviewWindowClosed:
      "Reviews for this show have closed. You can share feedback for up to 30 days after a show.",
    // ── P4b (deal terms) ──
    dealRemainderUnresolved:
      "Choose who takes what's left of the ticket money before working out this deal.",
    dealFrozen:
      "This deal is frozen. You can still change it, but everyone on the deal is told what changed.",
    settlementSheetSettled:
      "This settlement sheet is marked settled. Reopen it to make changes.",
    settlementSheetNotSettled: "This settlement sheet isn't marked settled.",
    settlementEventNotEnded:
      "You can mark the sheet settled once the show is over.",
    settlementSheetIncomplete:
      "Some money is still missing from this sheet. Fill it in, or confirm you want to mark it settled as it stands.",
    settlementEventNotPublished:
      "This event was never published, so there's nothing to settle.",
    payoutLinesTotalInvalid:
      "The payout percentages must add up to exactly 100% before these terms can take effect.",
    settlementEntryNotFound:
      "We couldn't find that line on the settlement sheet.",
    // ── arrival areas ──
    arrivalAreaNotFound:
      "We couldn't find that area on the map. It may have been removed.",
    arrivalAreaConflict:
      "Someone changed this area since you opened it. Check their changes, then try again.",
    arrivalAreaLimitReached:
      "You can draw up to 10 areas here. Remove one to add another.",
    arrivalAreaInvalidGeometry:
      "We couldn't save that shape. Keep it close to the place and don't let its lines cross, then try again.",
    ticketItemNotFound: "We couldn't find that ticket item.",
    ticketNoLongerOwnedBySender:
      "This ticket is no longer in your account, so it can't be transferred.",
    ticketNotEligibleForResale: "This ticket isn't eligible for resale.",
    ticketNotFound: "We couldn't find that ticket.",
    ticketNotScanned:
      "This ticket hasn't been scanned yet, so there's nothing to undo.",
    ticketNotTransferable:
      "This ticket can't be transferred. The organizer may have disabled transfers.",
    ticketRefundInProgress:
      "A refund on this ticket is being processed. Try again in a few minutes.",
    ticketTransferEventPast:
      "This event is over, so its tickets can't be transferred anymore.",
    ticketUnderClaim:
      "This ticket has an open claim. You can't transfer or resell it until the claim is resolved.",
    ticketNotValid: "This ticket isn't valid for entry.",
    ticketsAlreadyIssued:
      "Tickets have already been issued for this order, so this can't be done again.",
    ticketsMissing: "No tickets were found. Please add a ticket and try again.",
    ticketTypeCapacityInvalid:
      "This ticket type's capacity isn't valid. Enter a quantity that fits the event's limits.",
    ticketTypeEventMismatch:
      "This ticket type belongs to a different event and can't be used here.",
    ticketTypeHasSales:
      "This ticket type already has sales, so it can't be deleted. You can hide it instead.",
    ticketTypeLockedBySales:
      "Tickets have already been sold for this event, so its ticket types are locked. Only capacity can still change.",
    ticketTypeNameTaken:
      "A ticket type with that name already exists. Choose a different name.",
    ticketTypeNotSeated:
      "This ticket type isn't assigned seats, so seating actions aren't available for it.",
    ticketTypeNotYetOnSale:
      "This ticket type isn't on sale yet. Check back when sales open.",
    ticketTypeSalesEnded: "Sales have ended for this ticket type.",
    ticketTypeSalesWindowInvalid:
      "The sales window has to open before it closes. Adjust the dates and try again.",
    ticketTypeScheduleIncomplete:
      "A scheduled price change needs both the new price and the date it starts. Set both, or clear both.",
    ticketTypeScopeOnlyValidForPrimary:
      "This setting only applies to primary tickets. Adjust it and try again.",
    ticketTypeScopeUnsupported:
      "This can't be limited to a specific ticket type.",
    ticketTypeSoldOut: "This is no longer available — it's sold out or full.",
    ticketTypeTemporarilyHeld:
      "These tickets are held in someone else's checkout. If they don't finish, they go back on sale.",
    tokenEventMismatch: "This link is for a different event.",
    tokenExpirationInPast:
      "The expiration date can't be in the past. Choose a future date and try again.",
    tokenExpired: "This link has expired. Please request a new one.",
    tokenHumanMismatch:
      "This link isn't valid for your account. Please request a new one.",
    tokenInvalid: "This link is no longer valid. Please request a new one.",
    tokenNotSupported:
      "This link can't be used here. Please request a new one.",
    tokenScopeMismatch:
      "This link isn't valid for this action. Please request a new one.",
    tooManyDocuments:
      "You've attached too many documents. Please remove some and try again.",
    transactionalCannotBeDisabled:
      "These are essential account notifications and can't be turned off.",
    turnstileTokenRequired: "Please complete the security check and try again.",
    turnstileVerificationFailed:
      "The security check didn't pass. Please try again.",
    undoWindowExpired: "The window to undo this scan has passed.",
    unknownNotificationCategory: "Unknown notification category.",
    unknownNotificationVariant: "Unknown notification variant.",
    unknownOwnerScope: "We couldn't complete that request. Please try again.",
    unknownOwnerType: "We couldn't complete that request. Please try again.",
    unsupportedSubjectType:
      "We couldn't complete that request. Please try again.",
    uploadedAvatarNotFound:
      "We couldn't find that uploaded avatar. Try uploading it again.",
    uploadedBannerNotFound:
      "We couldn't find that uploaded banner. Try uploading it again.",
    uploadedPageImageNotFound: "We couldn't find that uploaded image.",
    uploadNotComplete:
      "This upload hasn't finished yet. Wait for it to complete and try again.",
    verificationLockedToOtherReviewer:
      "Another reviewer is already handling this verification. Try again once they're done.",
    verificationNotInReview:
      "This verification isn't under review right now, so it can't be updated.",
    verificationNotPending:
      "This verification is no longer pending, so this action isn't available.",
    verificationAlreadyPending:
      "A verification request for this place is already in review.",
    placeAlreadyVerified: "This place is already verified.",
    verificationRequestAlreadyDecided:
      "This verification request has already been decided.",
    verificationRequestInProgress:
      "This place has a verification request open. Work it through the review queue (acknowledge, then approve or reject) instead of setting the status directly.",
    verificationRequestNotFound: "We couldn't find that verification request.",
    verificationRequiresOrgOwner:
      "Only the organization owner can request verification.",
    volunteerApprovalsPaused:
      "New volunteers can't be added right now. Volunteers already approved keep their place, and you can still reject applications.",
    volunteeringDisabled: "Volunteering isn't available for this event.",
    waitlistFull:
      "The waitlist for this event is full, so we can't add you right now.",
    waitlistNotOpen:
      "The waitlist for this event isn't open yet. Check back soon.",
    waitlistPublishAtRequired:
      "Set a publish date for the waitlist before continuing.",
    waiverNotFound: "We couldn't find that waiver.",
    waiverTemplateNotAccessible:
      "You don't have access to this waiver template.",
    waiverTemplateNotFound: "We couldn't find that waiver template.",
    waiverTemplateNotOwned:
      "This waiver template belongs to another organization.",
    windowBoundsRequired: "Add a start and end time and try again.",
    windowEndBeforeStart: "The end time must come after the start time.",

    // follow-up: legacy-throw migration codes
    claimNotFound: "We couldn’t find that claim.",
    invalidBlockData: "That block’s data isn’t valid.",
    invalidBlockKind: "That block type isn’t allowed here.",
    walletPassNotConfigured: "Wallet passes aren’t set up for this.",

    // ── Claim venue (claim-venue-flow spec) ─────────────────────────────
    placeAlreadyClaimed:
      "This place is already claimed by a verified owner. If you believe you own it, you can dispute the claim.",
    placeNotClaimable:
      "This place can’t be claimed right now. It may be archived, already verified, or have a claim in review.",
    claimAlreadyPending:
      "A claim on this place is already under review. Only one claim can be in review at a time.",
    claimLimitReached:
      "You’ve reached the limit of places you can have pending review at once. Wait for a decision before claiming another.",
    claimProofRequired:
      "Choose a way to prove you operate this place before submitting your claim.",
    claimEmailDomainMismatch:
      "That email’s domain doesn’t match the place’s website. Use an address at the place’s domain.",
    claimFreeEmailNotAllowed:
      "Public email providers (like Gmail or Outlook) can’t be used to prove ownership. Use an address at the place’s own domain.",
    claimPlaceHasNoWebsite:
      "This place has no website on file, so email-domain proof isn’t available. Upload a document instead.",
    claimChallengeNotFound:
      "We couldn’t find that verification code. Request a new one and try again.",
    claimChallengeExpired:
      "This verification code has expired. Request a new one and try again.",
    claimChallengeLocked:
      "Too many incorrect attempts. Request a new verification code to continue.",
    claimChallengeCodeInvalid:
      "That code isn’t correct. Check your email and try again.",
    claimChallengeNotVerified:
      "Verify the emailed code before submitting your claim.",
    claimDisputeNotApplicable:
      "This place isn’t claimed by anyone yet, so there’s nothing to dispute. Claim it instead.",
  },

  // ── Community moderation (/moderate) ────────────────────────────────
  invitePauseQueue: {
    title: "Invite pauses",
    subtitle: "Organisers whose invite emails were marked as spam too often. Lift the pause, or keep it with a note the organiser will see.",
    waitingCount: "{count, plural, one {# waiting} other {# waiting}}",
    waitingCountAtLeast: "{count}+ waiting",
    filterLabel: "Show",
    filterAwaiting: "Waiting for review",
    filterOpen: "All open",
    filterLifted: "Lifted",
    emptyAwaiting: "No one is waiting for a review",
    emptyOpen: "No organisers are paused",
    emptyLifted: "No pauses have been lifted yet",
    emptyHint: "An organiser shows up here when people mark their invite emails as spam too often.",
    loadError: "Couldn’t load invite pauses.",
    retry: "Try again",
    badgeReviewAsked: "Review asked",
    badgePaused: "Paused",
    badgeLifted: "Lifted",
    reasonCount: "Too many spam complaints",
    reasonRate: "Spam complaints above 1 in 100",
    pausedAge: "Paused {age}",
    ownerLabel: "Organiser",
    ownerKindOrg: "Organization",
    ownerKindHuman: "Person",
    factComplaints: "Complaints",
    factComplaintsValue: "{count, plural, one {# person} other {# people}}",
    factInvited: "Invited",
    factInvitedValue: "{count, plural, one {# person} other {# people}}",
    factInvitedValuePct: "{count, plural, one {# person} other {# people}} ({pct}%)",
    factPausedOn: "Paused on",
    factReviewAsked: "Review asked",
    factLastDecision: "Last decision",
    decisionLiftedOn: "Lifted on {date}",
    decisionKeptOn: "Kept paused on {date}",
    organiserNoteLabel: "Their note",
    organiserNoNote: "They didn’t add a note.",
    decisionNoteLabel: "Our last note to them",
    reviewCta: "Review",
    reviewAria: "Review invite pause for {owner}",
    noteLabel: "Note to the organiser",
    noteHint: "Needed to keep the pause. The organiser sees it in their invite panel and notifications.",
    lift: "Lift pause",
    liftAria: "Lift invite pause for {owner}",
    keep: "Keep paused",
    keepAria: "Keep invites paused for {owner}",
    close: "Close",
    closeAria: "Close review for {owner}",
    liftedToast: "Pause lifted. Their invites are back on.",
    keptToast: "Pause kept. The organiser will see your note.",
    alreadyDecidedToast: "Someone already lifted this pause.",
    decisionFailedToast: "Couldn’t save the decision.",
    loadMore: "Load more",
    loadMoreFailedToast: "Couldn’t load more invite pauses.",
  },
  moderation: {
    shellTitle: "Community moderation",
    navSuggestions: "Suggestions",
    navApplications: "Applications",
    navImages: "Images",

    suggestionsTitle: "Edit suggestions",
    suggestionsSubtitle:
      "Proposed edits to community listings, waiting for a moderator decision.",
    suggestionsEmpty: "No pending suggestions",
    suggestionsEmptyHint: "New edit suggestions will show up here.",
    loadMore: "Load more",
    loadError: "We couldn’t load the queue.",
    retry: "Retry",
    anonymous: "Anonymous",
    unknownEvent: "Unknown event",
    pendingBadge: "Pending",
    listingTakenDownBadge: "Taken down",
    listingEndedBadge: "Ended",
    suggestionHintTakenDown:
      "This listing was taken down, so the suggestion can only be rejected.",
    suggestionHintEnded: "This listing has ended, so the suggestion can only be rejected.",
    suggestionToastTakenDown:
      "The listing was taken down. You can still reject this.",
    suggestionToastEnded: "The listing has ended. You can still reject this.",
    submittedBy: "Suggested by {name}",
    submitterNote: "Submitter note",
    viewEvent: "View event",
    reviewTitle: "Review suggestion",
    reviewNoteLabel: "Review note",
    reviewNotePlaceholder: "Optional note for the audit record",
    approve: "Approve",
    reject: "Reject",
    close: "Close",
    approvedToast: "Suggestion approved",
    approvedPartialToast:
      "{applied} applied, {conflicted} conflicted — skipped",
    rejectedToast: "Suggestion rejected",
    alreadyReviewedToast: "This suggestion was already reviewed.",
    decisionFailedToast: "Could not record decision",
    secondFactorRequiredToast: "Second factor required",
    secondFactorRequiredToastMessage:
      "Moderation actions require a second factor (a passkey or authenticator app) on your account.",
    secondFactorRequiredToastAction: "Set up now",

    before: "Before",
    after: "After",
    conflict: "Conflict",
    material: "Material",
    emptyValue: "Not set",
    bodyPreviewFallback: "Structured content · {chars} characters",
    fieldTitle: "Title",
    fieldContent: "Description",
    fieldStartsAt: "Starts",
    fieldEndsAt: "Ends",
    fieldTimezone: "Timezone",
    fieldAddressText: "Address",
    fieldCountryCode: "Country",
    fieldRegion: "Region",
    fieldLocality: "City",
    fieldPostalCode: "Postal code",
    fieldLat: "Latitude",
    fieldLng: "Longitude",
    fieldCategoryId: "Category",
    fieldHeroImageId: "Hero image",
    fieldAgeLimit: "Age limit",

    applicationsTitle: "Moderator applications",
    applicationsSubtitle:
      "People asking to become community moderators. Platform admins only.",
    applicationsEmpty: "No pending applications",
    applicationsEmptyHint: "New moderator applications will show up here.",
    applicant: "Applicant",
    deletedUser: "Deleted user",
    noStatement: "No statement provided.",
    statementLabel: "Statement",
    applicationApprovedToast: "Application approved",
    applicationRejectedToast: "Application rejected",
    applicationAlreadyReviewedToast: "This application was already reviewed.",
    applicantMissingToast:
      "This account no longer exists. Reject the application instead.",
    applicantHumansLink: "Find {name} in Humans",

    // ── Flagged image review queue (/moderate/images — FR-008) ──
    imagesTitle: "Flagged images",
    imagesSubtitle:
      "Images an automated scan held for review. Approve to publish, or reject to remove.",
    imagesEmpty: "No images awaiting review",
    imagesEmptyHint: "Flagged images will show up here.",
    imagesCountAria: "{count} flagged images awaiting review",
    imagesReviewCta: "Review",
    imagesReveal: "Click to reveal — may contain explicit content",
    imagesHide: "Hide",
    imagesPreviewAlt: "Flagged image awaiting moderation",
    imagesNoPreview: "Preview unavailable",
    imagesDegradedBadge: "Auto-scan failed",
    imagesDegradedHint:
      "This image couldn’t be scanned automatically — review it manually.",
    imagesSeverityLabel: "Severity",
    imagesNoCategories: "No category scores",
    imagesCategorySexual: "Sexual",
    imagesCategoryViolence: "Violence",
    imagesCategoryHate: "Hate",
    imagesCategorySelfHarm: "Self-harm",
    imagesSeverityNone: "none",
    imagesSeverityLow: "low",
    imagesSeverityHigh: "high",
    imagesSeveritySevere: "severe",
    imagesOwningEntity: "Owning entity",
    imagesViewEvent: "View event",
    imagesSubjectFallback: "{type} · {id}",
    imagesSubjectUnknown: "Unknown owner",
    imagesFlaggedAt: "Flagged {date}",
    imagesRejectNoteLabel: "Reason (optional)",
    imagesRejectNotePlaceholder: "Optional note recorded on rejection",
    imagesApprovedToast: "Image approved",
    imagesRejectedToast: "Image rejected",
    imagesAlreadyDecidedToast:
      "This image was already reviewed by another moderator.",
    imagesDecisionFailedToast: "Could not record decision",

    // ── Entity report queue (/platform/reports — entity-report-intake FR-007,
    // relocated to platform trust & safety in spec v1.1; the nav label lives
    // at admin.navPlatformReports. Keys stay in this namespace because the
    // reason labels are shared with the public report dialog). ──
    reportsTitle: "Listing reports",
    reportsPendingCount:
      "{count, plural, one {# pending report} other {# pending reports}}",
    reportsSubtitle:
      "Problems visitors reported on place, person, and group listings. Resolve when handled, or dismiss.",
    reportsEmpty: "No pending reports",
    reportsEmptyHint: "New listing reports will show up here.",
    reportsReportedAt: "Reported {age}",
    reportsSubjectLabel: "Reported listing",
    reportsSubjectPlace: "Place",
    reportsSubjectHuman: "Person",
    reportsSubjectOrganization: "Group",
    reportsSubjectArrivalArea: "Getting there area",
    reportsSubjectArrivalAreaParking: "Parking",
    reportsSubjectArrivalAreaDropOff: "Accessible drop-off",
    reportsSubjectArrivalAreaLoadIn: "Load-in",
    reportsReporterLabel: "Reporter",
    reportsReasonClosedOrGone: "Closed or gone",
    reportsReasonIncorrectInfo: "Incorrect info",
    reportsReasonDuplicate: "Duplicate",
    reportsReasonInappropriate: "Inappropriate",
    reportsReasonSpam: "Spam",
    reportsReasonImpersonation: "Impersonation",
    reportsReasonOther: "Other",
    reportsDetailsLabel: "Details",
    reportsNoDetails: "No details provided.",
    reportsShowMore: "Show more",
    reportsShowLess: "Show less",
    reportsReviewCta: "Review",
    reportsReviewAria: "Review report on {subject}",
    reportsReviewNoteLabel: "Review note (optional)",
    reportsReviewNotePlaceholder:
      "Optional note — included in the reporter's notification",
    reportsResolve: "Resolve",
    reportsDismiss: "Dismiss",
    reportsResolvedToast: "Report resolved",
    reportsDismissedToast: "Report dismissed",
    reportsAlreadyReviewedToast:
      "This report was already reviewed by another staff member.",
    reportsDecisionFailedToast: "Could not record decision",

    // ── /moderate/listings/[eventId]/schedule ────────────────────────────
    // The full schedule of one community listing: the recurrence rule, what
    // changing it would destroy, and every loaded date. Reached from the
    // listing's own public page ("Manage schedule"); there is no index.
    schedKicker: "Community listing",
    schedRuleLabel: "Repeats",
    // No summarisable cadence: FIXED_DATES, or a rule outside the phrasebook
    // the read side can state. The dates below are still the truth.
    schedRuleUnsummarisable: "This schedule has no rule a sentence can state.",
    schedNoEndDate: "No end date",
    schedEndsOn: "Ends {date}",
    // What EXISTS, deliberately not the length of the series: the list is
    // capped by the read AND by how far ahead occurrences are materialised,
    // so "52 dates" would put an end on a night that has none.
    schedMaterialised:
      "{count, plural, one {# date materialised} other {# dates materialised}}",
    schedMaterialisedMore:
      "More dates are materialised as the year rolls forward — this is not the end of the series.",
    schedChangeRule: "Change rule",
    schedDiscard: "Discard",
    schedViewListing: "View listing",
    schedClosedTakenDown:
      "This listing was taken down. Its nights can't be put back and its rule can't change.",
    schedClosedEnded:
      "This listing has ended. Its nights can't be put back and its rule can't change.",

    schedEditorTitle: "New rule",
    // The prefill is the stored rule (`listEventDates.storedRule`) carried to
    // the next upcoming date, so applying it untouched leaves the same
    // schedule in place. Say so, and point at the preview, which is exactly
    // what gets written.
    schedEditorPrefillNote:
      "Prefilled with the current rule, so applying it unchanged leaves the schedule as it is. What you apply is what the preview shows.",
    schedRuleIncomplete:
      "Finish the rule above to see what it would do to these dates.",
    // The builder's own vocabulary is "shows", which is a ticketed-series word.
    schedOccurrenceUnit: "{count, plural, one {date} other {dates}}",
    schedOccurrenceTotal: "{count, plural, one {# date} other {# dates}}",
    schedOccurrenceTotalCapped: "{count}+ dates",
    schedOccurrenceLast: "last date {date}",

    schedConsequenceLabel: "Before you apply",
    schedConsequenceMechanism:
      "Changing the rule reconciles every future date. A date that drops off is called off if anyone has RSVP'd — and everyone who did is emailed — or removed if nobody has.",
    schedConsequenceIdle: "Counts appear here once a new rule is on the table.",
    schedWouldDrop:
      "{count, plural, =0 {No date now on this schedule would come off.} one {# of the {total} dates now on this schedule would come off.} other {# of the {total} dates now on this schedule would come off.}}",
    schedWouldAdd:
      "{count, plural, =0 {No new dates would be added.} one {# new date would be added.} other {# new dates would be added.}}",
    // FR-004: per-date RSVPs are personal and there is no count read surface,
    // public or moderator. Better to say the number is unavailable than to
    // imply this page checked and found none.
    schedRsvpUnknown:
      "How many of them carry RSVPs isn't shown — per-date RSVPs are private and there is no count to read.",
    // Presence per date (moderator-only, gated in the use case), never a
    // going-count: this is a count of NIGHTS, which is what the reconcile
    // decides on — a night with RSVPs is called off and its people emailed, a
    // night without is removed outright.
    schedDroppedWithRsvps:
      "{count, plural, =0 {Nobody has RSVP'd to any of them — they would be removed outright.} one {# of them has RSVPs: it would be called off, not removed, and everyone who RSVP'd emailed.} other {# of them have RSVPs: they would be called off, not removed, and everyone who RSVP'd emailed.}}",
    schedAddApprox:
      "New dates are materialised about a year ahead, so the added count can move by one at the horizon.",
    schedDropFloor:
      "Counted against the {count, plural, one {# date} other {# dates}} loaded here, which is as far as this page can see.",
    schedProducesNothing:
      "This rule materialises no dates in the next year. A listing needs at least one, so it can't be applied.",
    // A rule change is reconciled against a set that is WINDOWED *and* CAPPED
    // at one pass, and the cap is the part nobody expects: adding a second
    // weekday halves how far the pass reaches, and the stranded tail is
    // destroyed. These two say that in the moderator's terms.
    schedWouldDropBeyondHorizon:
      "{count, plural, one {# of those is a date the new rule still wants} other {# of those are dates the new rule still wants}}: one pass materialises at most {max} dates, and anything past that comes off now. Any of them carrying an RSVP stays called off for good.",
    schedCapReached:
      "This rule fills the {max}-date pass, so the schedule it writes stops earlier than the rule itself does.",
    schedOutOfReachMark: "Out of reach",
    schedApply: "Apply new rule",
    schedApplying: "Applying…",
    schedApplyConfirmTitle: "Apply the new rule?",
    // States the OUTCOME rather than asking "are you sure" — the mail is the
    // part that cannot be taken back, and the status itself can.
    schedApplyConfirmBody:
      "{dropped, plural, =0 {No date now on this schedule comes off.} one {# date comes off this schedule.} other {# dates come off this schedule.}} Any of them with RSVPs is called off and everyone who RSVP'd is emailed; the rest are removed. You can put a called-off date back.",
    schedApplyConfirmAction: "Apply new rule",
    schedApplyConfirmKeep: "Keep current rule",
    schedApplyOk: "Schedule updated",
    schedApplyOkBody:
      "{count, plural, one {# date is now on this schedule.} other {# dates are now on this schedule.}}",
    schedApplyFailed: "Couldn't apply that rule. Please try again.",
    schedApplyEmpty: "That rule produces no dates in the next year.",

    schedDatesLabel: "Dates",
    schedListAria: "Every loaded date on this schedule",
    // The mark a row carries while a rule change is staged.
    schedComesOffMark: "Comes off",
    // The only RSVP fact any endpoint exposes is the reader's OWN (FR-004),
    // so the label has to say whose it is.
    schedYourRsvp: "Your RSVP",
    schedNoDates: "No upcoming dates",
    schedNoDatesHint:
      "This listing has no upcoming dates. Set a rule to put some on the schedule.",
    schedNotCommunity: "Not a community listing",
    schedNotCommunityHint:
      "Only community listings are maintained here. An org-owned event's schedule is edited from its own event builder.",
  },

  // ── Arrival areas on the place and event pages (arrival-areas FR-006,
  // NFR-005). Area labels and notes are shown as authored, never here. ─────
  arrivalAreas: {
    heading: "Getting there",
    legendLabel: "Map key",
    legendParkingLot: "Parking lot",
    legendStreetParking: "Street parking",
    kindParking: "Parking",
    kindAccessibleDropOff: "Accessible drop-off",
    kindLoadIn: "Load-in",
    costFree: "Free",
    costPaid: "Paid",
    costUnknown: "Cost unknown",
    accessibleSpots: "Accessible spots",
    directions: "Directions",
    directionsTo: "Directions to {label}",
    report: "Report",
    reportArea: "Report {label}",
    // The report dialog, when what is reported is a parking, drop-off or
    // load-in area rather than a listing.
    reportTitle: "Report this area",
    reportSuccessBody:
      "Thanks. Our staff will check this area, and you'll get an in-app notification when they have.",
    reportAlreadyOpenBody:
      "You've already reported this area and it's waiting for review. You'll get an in-app notification once it's reviewed.",
    reportInvalidReason: "That reason doesn't apply to this area. Pick another.",
  },

  // ── Arrival-areas editor (arrival-areas FR-016; place settings and the
  // moderator place page). ──────────────────────────────────────────────
  arrivalAreasEditor: {
    heading: "Getting there",
    count: "{count} of {limit} areas",
    loading: "Loading areas…",
    loadErrorTitle: "Couldn't load the areas",
    retry: "Try again",
    toolbarLabel: "Map tools",
    toolSelect: "Select",
    toolSelectShort: "Select",
    toolPolygon: "Draw a lot",
    toolLine: "Draw street parking",
    toolUndo: "Undo point",
    toolPolygonShort: "Lot",
    toolLineShort: "Street",
    toolUndoShort: "Undo",
    mapLabel: "Map for drawing areas",
    hintPolygon: "Mark each corner of the lot, then end on the first corner.",
    hintLine: "Mark points along the curb, then end on the last point again.",
    hintRedraw: "Draw a new shape for {label}.",
    hintReshape: "Drag a point to reshape the area.",
    finishShape: "Finish shape",
    osmGuide: "Faint dots and shading are parking from OpenStreetMap, to trace over.",
    selectPrompt: "Pick an area on the map or in the list, or draw a new one.",
    drawPrompt: "Draw a lot or street parking on the map to add an area.",
    emptyTitle: "No areas yet",
    emptyBody:
      "Draw where visitors can park or get dropped off, and where acts load in. Parking and drop-off show under Getting there.",
    listLabel: "Areas",
    moveUp: "Move {label} up",
    moveDown: "Move {label} down",
    remove: "Remove",
    removeArea: "Remove {label}",
    removeConfirm: "Remove {label}? It comes off the map for everyone.",
    removeConfirmYes: "Remove",
    removeConfirmNo: "Keep",
    flagOutside: "Part of it is more than 3 km from the place. Check it.",
    flagNoShape: "No shape on the map",
    flagNoShapeLong:
      "This area has no shape on the map. Draw it again, or remove it.",
    flagSwitchedOff: "Switched off: the event moved. Redraw or remove it.",
    flagWithheld: "Shape hidden at this place",
    formNewTitle: "New area",
    formEditTitle: "Edit area",
    fieldKind: "Kind",
    fieldLabel: "Label",
    fieldLabelPlaceholder: "North lot",
    fieldCost: "Cost",
    fieldPriceText: "Price",
    fieldPriceTextPlaceholder: "$10 cash",
    fieldNote: "Note",
    fieldNotePlaceholder: "Enter from the side street. Fills up by 7 pm.",
    fieldAccessibleSpots: "Has accessible spots",
    optional: "(optional)",
    errorLabelRequired: "Give the area a label.",
    errorLabelTooLong: "Keep the label to {max} characters.",
    save: "Save area",
    saving: "Saving…",
    discard: "Discard changes",
    close: "Close",
    drawFirst: "Draw the area on the map first.",
    savedTitle: "Area saved",
    removedTitle: "Area removed",
    reorderedTitle: "Order saved",
    savedNote: "Changes can take 2 to 7 minutes to reach visitors.",
    unsavedBlock: "Save or discard this area first.",
    conflictTitle: "Someone else changed this area",
    conflictBody:
      "It now reads “{label}”. Your changes are still here. Save to replace theirs, or discard to keep them.",
    conflictRemoved:
      "Someone else removed this area. Your changes are still here. Save to add it back as a new area.",
    reorderConflict:
      "The list changed while you were reordering it. Here it is as it is now.",
    removeConflict:
      "Someone else changed this area. Check it before you remove it.",
    alreadyRemoved: "That area was already removed.",
    limitReached:
      "This place has {limit} areas, the most it can have. Remove one to add another.",
    noPin: "Set the place's address first. Areas are drawn around its pin.",
    noPinWithheld: "This place hides its address, so areas can't be drawn here.",
    noCoverage: "The map doesn't cover this place yet, so areas can't be drawn here.",
    mapUnavailable: "The map isn't available right now. Try again later.",
    openEditor: "Draw on the map",
    closeEditor: "Close the map",
    done: "Done",
    details: "Details",
    sheetLabel: "Area details",
    sheetClose: "Back to map",
    geomInvalidShape: "That shape can't be read. Draw it again.",
    geomOffTheMap: "Part of that shape is off the map. Draw it again.",
    geomTooManyPoints:
      "That shape has {count} points. Keep it to {limit}.",
    geomTooFewPoints: "That shape needs at least {minimum} points.",
    geomNotClosed: "The lot isn't closed. Finish on the first corner.",
    geomSelfIntersecting: "The lot's edges cross. Draw it without crossing lines.",
    geomTooThin: "That lot is too thin to see. Draw it wider.",
    geomCrossesAntimeridian: "That shape crosses the date line. Draw it again.",
    geomZeroLength: "That line has no length. Draw it along the curb.",
    geomOutsideEnvelope:
      "That area is more than {km} km from the place. Draw it closer.",
  },

  // ── Report-a-listing dialog (entity-report-intake FR-001/FR-002/FR-008).
  // Reason LABELS deliberately reuse moderation.reportsReason* — one shared
  // vocabulary for reporters and moderators. ─────────────────────────────
  reportEntity: {
    title: "Report this listing",
    reasonLabel: "Reason",
    reasonRequiredError: "Choose a reason for the report.",
    invalidReasonError:
      "That reason doesn't apply to this listing — pick another.",
    detailsLabelOptional: "Details (optional)",
    detailsLabelRequired: "Details (required)",
    detailsPlaceholder:
      "What's wrong? Anything specific helps us review faster.",
    detailsRequiredError: "Please add details for an “Other” report.",
    cancel: "Cancel",
    submit: "Submit report",
    successTitle: "Report submitted",
    successBody:
      "Thanks for the heads-up — our staff will review this listing. You'll get an in-app notification when it's been reviewed.",
    doneCta: "Done",
    alreadyOpenTitle: "You already have an open report",
    alreadyOpenBody:
      "You've already reported this listing and it's waiting for review — we're on it. You'll be notified in-app once it's reviewed.",
    rateLimitedToast: "Too many reports right now",
    rateLimitedHint:
      "You've submitted several reports in a short time. Please wait a few minutes and try again.",
    failedToast: "Could not submit report",
  },

  // ── Become-a-moderator CTA ───────────────────────────────────────────
  becomeModerator: {
    title: "Help keep community listings accurate",
    body: "Community moderators review suggested edits and create free community listings. Apply and a platform admin will review your request.",
    apply: "Apply to moderate",
    dialogTitle: "Apply to be a community moderator",
    statementLabel: "Statement",
    statementPlaceholder:
      "Tell us why you’d like to help keep listings accurate (optional)",
    cancel: "Cancel",
    submit: "Submit application",
    successToast: "Application submitted",
    successHint: "A platform admin will review your application.",
    alreadyModerator: "You’re already a community moderator.",
    alreadyPending: "You already have an application waiting for review.",
    failedToast: "Could not submit application",
  },

  // ── RSVP ("I'm going") toggle on community listings ──────────────────
  rsvp: {
    imGoing: "I'm going",
    youreGoing: "You're going",
    going: "Going",
    seeDates: "See dates",
    signInToRsvp: "Sign in to RSVP",
    toggleAria: "I'm going",
    toggleAriaForDate: "I'm going on {date}",
    goingAriaForDate: "Going on {date}",
    // ── Recurring listing: the "Upcoming dates" section ──────────────
    // Leads with the CADENCE rather than painting all 52 upcoming rows. The
    // weekday in {days} and the clock time in {time} are Intl-formatted from
    // the next real occurrence, so these sentences stay locale-correct without
    // a map of RRULE codes to English words.
    nextLabel: "Next",
    thenLabel: "Then",
    // The compact per-date toggle inside the full list — room for ~1 word.
    rsvpShort: "RSVP",
    cadenceEveryDay: "Every day, {time}",
    cadenceEveryNDays: "Every {interval} days, {time}",
    cadenceEveryWeek: "Every {days}, {time}",
    cadenceEveryNWeeks: "Every {interval} weeks on {days}, {time}",
    // Day-less weekly fallbacks, used when the upcoming occurrences cannot name
    // every day the rule fires on (a MO,WE,FR night with only Monday and
    // Wednesday still ahead). Stating two days of a three-day rule would be
    // confidently wrong; the time is the half that is still true.
    cadenceEveryWeekNoDays: "Every week, {time}",
    cadenceEveryNWeeksNoDays: "Every {interval} weeks, {time}",
    cadenceEveryMonth: "Every month, {time}",
    cadenceEveryNMonths: "Every {interval} months, {time}",
    datesThrough:
      "{count, plural, one {# date} other {# dates}} through {through}",
    // The same meta line WITHOUT a horizon, for a list the server truncated:
    // "through Sep 2027" would put an end date on an open-ended weekly night.
    datesNext: "{count, plural, one {Next # date} other {Next # dates}}",
    monthDateCount: "{count, plural, one {# date} other {# dates}}",
    showAllDates: "All {count} dates",
    // The disclosure when the list does not reach the end of the series — the
    // panel holds more dates, but not all of them, so it promises no count.
    showMoreDates: "Show more dates",
    hideDates: "Hide dates",
    allDatesLabel: "All upcoming dates",
    moreDatesLabel: "Upcoming dates",
    privateHint: "Only you can see this — RSVPs are never public.",
    datesSignInHint: "Sign in to RSVP to a date. Only you can see your RSVPs.",
    errToggleFailed: "Couldn't update your RSVP. Please try again.",
    // ── Zero upcoming SCHEDULED dates on a RECURRING listing ────────────
    // Two different facts, and saying the wrong one is a claim about someone
    // else's schedule. `truncated` tells them apart: more occurrences exist
    // past the loaded list (the top-up has not run yet) vs. the rule really
    // is finished. Neither state offers an RSVP — there is no date to attach
    // one to, and the event-level button would attach it to a night that has
    // already happened.
    datesPending: "Next dates are being scheduled.",
    seriesEnded: "This series has ended.",
    // ── Moderator controls, inline on the public event page ─────────────
    // Shown ONLY to a community moderator, and only after the client-side
    // access probe answers — the page itself is edge-cached and shared with
    // anonymous readers.
    moderatorTag: "Moderator",
    manageSchedule: "Manage schedule",
    callOff: "Call off",
    callOffAriaForDate: "Call off {date}",
    putBack: "Put back",
    putBackAriaForDate: "Put {date} back on",
    // The marker a called-off night carries for EVERYONE. The strike-through
    // beside it is decoration and announces nothing; this is the text a
    // screen reader reads.
    calledOff: "Called off",
    calledOffRowAria: "{date}, called off",
    callOffConfirmTitle: "Call off this date?",
    // States the OUTCOME rather than asking "are you sure" — the mail is the
    // part that cannot be taken back, and the status itself can.
    callOffConfirmBody:
      "{date} will show as called off, and everyone who RSVP'd is emailed. You can put it back.",
    callOffConfirmAction: "Call off",
    callOffConfirmKeep: "Keep this date",
    errCallOffFailed: "Couldn't call off that date. Please try again.",
    errPutBackFailed: "Couldn't put that date back. Please try again.",
    errPutBackListingTakenDown:
      "This listing is taken down; its nights can't be put back.",
    errPutBackListingEnded: "This listing has ended; its nights can't be put back.",
    // ── My RSVPs list page ──
    navMyRsvps: "My RSVPs",
    listTitle: "My RSVPs",
    listSubtitle: "Events you said you're going to",
    viewEvent: "View event",
    loadMore: "Load more",
    endedBadge: "Ended",
    cancelledBadge: "Cancelled",
    emptyTitle: "No RSVPs yet",
    emptyDescription:
      "When you say you're going to a community event, it shows up here.",
    discoverEvents: "Discover events",
    signedOutTitle: "Keep track of what you're going to",
    signedOutDescription:
      "Sign in to see the community events you've RSVP'd to. Only you can see your RSVPs.",
    signIn: "Sign in",
    unableToLoad: "Unable to load your RSVPs",
    tryAgain: "Try again",
  },

  // ── Community-maintained listing attribution ──────────────────────────
  communityListing: {
    title: "Community-maintained listing",
    body: "No single organizer runs this listing. Anyone can suggest an edit, and community moderators review every change before it goes live.",
    suggestEdit: "Suggest an edit",
    byline: "Community-maintained · anyone can suggest edits",
    howItWorks: "How this works",
    infoAria: "About community listings",
  },

  // ── Community-maintained place pages (moderator-place-page spec, FR-008) ──
  // The attribution on an unclaimed place's page, the moderator editor route,
  // and the handover notice a new owner sees in their editor.
  communityPlacePage: {
    title: "Community-maintained page",
    byline: "Community-maintained · moderators keep this page until the place is claimed",
    body: "Nobody has claimed this place yet, so community moderators write its page. When its owner claims it, they decide what stays.",
    // Once the place can't be claimed (owned, or a claim in review) but the
    // owner hasn't kept or cleared the moderators' work yet.
    bylineUnreviewed: "Community-maintained · written by moderators",
    bodyUnreviewed: "Community moderators wrote this page. Nobody who runs the place has reviewed it yet.",
    lastChanged: "Last changed {date}",
    infoAria: "About community-maintained pages",
    editorTitle: "Edit place page",
    editorBadge: "Moderator",
    editPlaceDetails: "Edit place details",
    nameHintFacts:
      "A place has one name. Change it with Edit place details, at the top.",
    nameHintLocked: "A place has one name. It can’t be changed here right now.",
    checkFailed: "Couldn’t check whether you can edit this page.",
    tryAgain: "Try again",
    ownerRedirect: "You own this place. Opening your editor…",
    ownerNoSlug: "You own this place, so its page is edited from your admin.",
    ownerOpenAdmin: "Go to admin",
    refusedOwnedTitle: "This place has an owner",
    refusedOwnedBody: "Only its owner can change the page now.",
    refusedArchivedTitle: "This place is archived",
    refusedArchivedBody: "An archived place’s page can’t be changed.",
    refusedNotAllowedTitle: "You can’t edit this page",
    refusedNotAllowedBody: "Community moderators can edit a place’s page until someone claims it.",
    secondFactorBody: "Editing a place page needs a passkey or an authenticator app on your account.",
    secondFactorLink: "Set up a second factor",
    lostOwnedTitle: "This place has just been claimed",
    lostOwnedBody: "Your last change wasn’t saved. The page is its owner’s now.",
    lostClaimTitle: "Someone has just asked to own this place",
    lostClaimBody: "Your last change wasn’t saved. The page can’t be changed while the claim is reviewed.",
    lostArchivedTitle: "This place has just been archived",
    lostArchivedBody: "Your last change wasn’t saved.",
    handoverTitle: "Moderators wrote parts of this page",
    handoverBody: "They edited it before you claimed the place. Keep their work or clear it. Until you choose, the page says it’s community-maintained.",
    handoverWriter: "{name} · {count, plural, one {# change} other {# changes}} · last {date}",
    handoverWriterUnknown: "A moderator",
    handoverMoreWriters: "{count, plural, one {and # more moderator} other {and # more moderators}}",
    handoverKeep: "Keep it",
    handoverClear: "Clear it",
    handoverConfirmTitle: "Clear what moderators wrote?",
    handoverConfirmBody: "This empties the bio, avatar and banner, and resets the main page and the theme. Your own main-page edits since the claim go too. Other sections stay as they are.",
    handoverCancel: "Cancel",
    handoverWorking: "Saving…",
    handoverKeptToast: "Kept. The page is yours now.",
    handoverClearedToast: "Cleared. The main page is back to the template.",
    handoverDraftPending: "This page has unpublished changes, so it can’t be cleared yet.",
    handoverContactSupport: "Contact support",
  },

  // ── Community listing creation (builder Community mode) ─────────────
  communityCreate: {
    modeDialogTitle: "Create event",
    modeDialogSubtitle: "Choose what kind of event to create.",
    modeTicketedLabel: "Ticketed event",
    modeTicketedHint:
      "Sell tickets, manage orders and payouts. Owned by you or your group.",
    modeCommunityLabel: "Community listing",
    modeCommunityHint:
      "A free listing the community keeps accurate. Publishes immediately — no tickets, pricing, or payouts.",
    // Supersedes `modeCommunityHint`: since the builder took over authoring, a
    // listing is created as a DRAFT and published from the editor. The old key
    // stays because catalogue edits here are additive-only.
    modeCommunityHintDraft:
      "A free listing the community keeps accurate. Saved as a draft you finish in the editor — no tickets, pricing, or payouts.",
    modeCancel: "Cancel",

    pageTitle: "New community listing",
    pageSubtitle:
      "Free, ownerless, and published immediately. Anyone can suggest edits; moderators keep it accurate.",
    fieldTitle: "Title",
    titlePlaceholder: "e.g. Tuesday open mic",
    fieldDateTime: "Date & time",
    fieldStarts: "Starts",
    fieldEnds: "Ends",
    fieldTimezone: "Timezone",
    fieldLocation: "Location",
    locationPlaceholder: "Search for an address…",
    locationSelectedHint: "Location pinned ({country}).",
    fieldCategory: "Category",
    categoryNone: "No category",
    fieldAgeLimit: "Age limit",
    ageLimitPlaceholder: "e.g. 18",
    ageLimitHint: "Optional. Leave empty for all ages.",
    fieldDetails: "Details",
    detailsPlaceholder: "Describe the event…",
    fieldBanner: "Banner image",
    bannerHint:
      "Optional. Shown at the top of the listing and on event cards. Recommended 1600×900.",

    // ── Repeats (optional recurrence) ──────────────────────────────────
    repeatsLabel: "Repeats",
    repeatNone: "Does not repeat",
    repeatWeekly: "Weekly",
    repeatMonthly: "Monthly",
    repeatOn: "Repeat on",
    repeatEvery: "Repeat every",
    repeatWeeksUnit: "{count, plural, one {week} other {weeks}}",
    repeatMonthsUnit: "{count, plural, one {month} other {months}}",
    repeatEndsLabel: "Repeat until",
    monthlyOnDay: "Day {day} of the month",
    monthlyOnDayGeneric: "The same day of the month",
    monthlyOnNth: "The {position} {weekday}",
    monthlyOnNthGeneric: "The same weekday each month",
    ord1: "first",
    ord2: "second",
    ord3: "third",
    ord4: "fourth",
    ord5: "fifth",
    repeatPreviewWeekly:
      "Repeats {interval, plural, one {weekly} other {every # weeks}} on {days}",
    repeatPreviewMonthlyDay:
      "Repeats {interval, plural, one {monthly} other {every # months}} on day {day}",
    repeatPreviewMonthlyNth:
      "Repeats {interval, plural, one {monthly} other {every # months}} on the {position} {weekday}",
    repeatPreviewUntil: "{summary} until {date}",

    cancel: "Cancel",
    submit: "Publish listing",
    submitPending: "Publishing…",
    successToast: "Community listing published",

    errTitleRequired: "Enter a title.",
    errStartsRequired: "Choose a start time.",
    errEndsRequired: "Choose an end time.",
    errStartsIncomplete: "Part of the start date or time is missing.",
    errEndsIncomplete: "Part of the end date or time is missing.",
    errEndsBeforeStarts: "The end time must be after the start time.",
    errLocationRequired: "Search for the address and pick a suggestion.",
    errCountryMissing:
      "That location doesn’t resolve to a country — pick a more specific address.",
    errAgeLimit: "Age limit must be a whole number between 0 and 99.",
    errCategoryInvalid:
      "The selected category is unavailable — pick another one.",
    errModeratorRequired:
      "You need community moderator access to publish listings.",
    errBlockedContent:
      "Some of the text was blocked by the content filter. Edit the wording and try again.",
    errRepeatWeekdayRequired: "Pick at least one weekday to repeat on.",
    errRepeatUntilRequired: "Choose when the repeat ends.",
    errRepeatUntilBeforeStart: "The repeat end must be after the first date.",
    errRepeatNoDates:
      "That schedule produces no upcoming dates. Adjust the days or end date.",
    errBannerUpload:
      "The listing was published, but the banner image couldn't be uploaded. You can add it later from the listing.",

    // ── Quick-create (the builder mints the draft, then takes over) ────
    quickCreateSubtitle:
      "Start the listing here, then add the description, banner and category in the editor. Nothing is public until you publish.",
    quickCreateSubmit: "Continue to editor",
    quickCreatePending: "Creating…",

    // ── One-box Location field: our places, then addresses (PlaceOrAddressField)
    pfPlaceholder: "Search a place or an address…",
    pfHelp:
      "Pick a place to put this listing on its page. An address only drops a pin.",
    pfGroupPlaces: "On Ithas Fire",
    pfGroupAddresses: "Addresses",
    pfSearching: "Searching…",
    pfAddPlace: "Add a place",
    pfAddQueryAsPlace: "Add “{query}” as a place",
    pfNoMatches: "No place or address matches “{query}”.",
    pfPlacesError:
      "Places on Ithas Fire can’t be searched right now. Addresses still work.",
    pfPlacesErrorNoAddress:
      "No address matches “{query}”, and places on Ithas Fire can’t be searched right now.",
    pfAllError: "Search is unavailable right now. Try again in a moment.",
    pfLoadingPlace: "Loading…",
    pfPlaceLoadFailed: "Couldn’t load that place. Try again.",
    pfClear: "Clear location",
    pfAddressOnly: "Address only",
    pfEditPlace: "Edit place",
    pfMakePlace: "Make this a place",
    pfChecking: "Checking…",
    pfTimezoneFromPlace: "Time zone set from the place: {timezone}.",
    pfDismiss: "Dismiss",
    pfEditabilityFailed: "Couldn’t check whether this place can be changed. Try again.",
    pfSecondFactorTitle: "Second factor required",
    pfSecondFactorBody:
      "Adding or changing a place needs a passkey or an authenticator app on your account. Set one up in the new tab, then come back here; your listing stays as it is.",
    pfSecondFactorLink: "Set up a second factor (opens a new tab)",
    pfRefusedOwnedTitle: "Its owner looks after this place",
    pfRefusedOwnedBody:
      "Only they can change or archive it. You can still pick it, and the listing links to it.",
    pfRefusedClaimTitle: "Someone has asked to own this place",
    pfRefusedClaimBody: "It can’t be changed while that claim is reviewed.",
    pfRefusedEventsTitle: "An organizer’s upcoming event uses this place",
    pfRefusedEventsBody:
      "Its ticket emails show this name and address, so it can’t change until that event ends.",
    pfRefusedNotActiveTitle: "This place can’t be changed here",
    pfRefusedNotActiveBody: "Ithas Fire staff look after it.",
    pfRefusedWithheldTitle: "This place keeps its address private",
    pfRefusedWithheldBody: "So its details can’t be changed here.",
    pfArchivedTitle: "{name} is archived",
    pfArchivedBody:
      "It has left place search, so this listing’s location is cleared. Pick another place or address.",

    // ── Add / edit a place dialog (PlaceDialog) ─────────────────────────
    pdAddTitle: "Add a place",
    pdAddSubtitle:
      "For a room that isn’t on Ithas Fire yet. It won’t have an owner until someone claims it.",
    pdEditTitle: "Edit {name}",
    pdEditSubtitle: "Fixes show on every listing at this place.",
    pdName: "Name",
    pdAddress: "Address",
    pdAddressPlaceholder: "Search for the address…",
    pdUnit: "Unit or room",
    pdUnitPlaceholder: "Unit A, back room…",
    pdNameFromPoi:
      "Filled from the business you picked. Change it if the room has its own name.",
    pdPin: "Pin",
    pdPinHint:
      "Check the pin sits on the building. If it doesn’t, pick a more exact address.",
    pdDirectoryNote:
      "It shows in the places directory and you can pick it for listings straight away.",
    pdCancel: "Cancel",
    pdAdd: "Add place",
    pdAdding: "Adding…",
    pdSave: "Save",
    pdSaving: "Saving…",
    pdErrNameRequired: "Give the place a name (at least 2 characters).",
    pdErrAddressRequired:
      "Pick the address from the suggestions so the place has a pin.",
    pdErrBlockedName:
      "That name can’t be used for a place. Try the name on the sign.",
    pdExistsTitle: "{name} is already here",
    pdExistsBody:
      "Same name at the same address. Use it so listings here share one page.",
    pdKeepEditing: "Keep editing",
    pdUseThis: "Use this place",
    pdRateLimitedTitle: "You’ve reached the hourly limit for places",
    pdRateLimitedBody: "Your entries are kept here. Try again after {time}.",
    pdRateLimitedBodyNoTime:
      "Your entries are kept here. Try again later in the hour.",
    pdArchive: "Archive place",
    pdArchiveBlocked:
      "{count, plural, one {# upcoming listing uses this place} other {# upcoming listings use this place}}. Archive it after they end, or move them to another place.",
    pdArchiveConfirmTitle: "Archive {name}?",
    pdArchiveConfirmBody:
      "It leaves place search and the picker. Past listings keep showing it. An admin can restore it from Platform → Places.",
    pdKeepIt: "Keep it",
    pdArchiveConfirm: "Archive",
    pdArchiving: "Archiving…",
    pfIsArchivedBody: "Pick another place.",
    pdErrAddressIncomplete: "Pick the address again to save this place.",
    pdErrMaybeAdded:
      "Your last add may have gone through. Search for it before adding again.",
  },

  // ── Community listing authored in the real EventBuilder ──────────────
  // The builder's COMMUNITY mode: an ownerless listing edited with the same
  // fields, preview and publish control a ticketed event gets, minus every
  // surface that presumes an owning org with a payee.
  communityBuilder: {
    errLocationPin:
      "Pick the address from the suggestions so the listing has a map pin.",
    categoryLoadFailed: "Categories couldn't be loaded. Try again shortly.",
    alreadyLiveTitle: "Already live",
    alreadyLiveMessage: "This listing was already published — nothing changed.",
    publishedMessage: "The listing is live and anyone can RSVP.",

    // ── A live listing, opened for editing (2026-09-16) ───────────────
    // `community.updateListing` takes a PUBLISHED listing now. These two
    // carry the difference between editing a draft (private, free) and
    // editing a live one (public on save, and sometimes an email to every
    // person who RSVP'd or saved it).
    liveKicker: "Live listing",
    liveBody:
      "Changes go on the public page as soon as you save. Changing the date or the address also tells everyone who RSVP'd or saved this listing.",
    liveSaveTitle: "Save and notify?",
    liveSaveLead:
      "This listing is live, so the change is public the moment you save.",
    liveSaveNow: "Now",
    liveSaveAfter: "After saving",
    liveSaveScheduleLabel: "Date and time",
    liveSaveScheduleNotice:
      "Anyone who RSVP'd or saved this listing gets an email and an in-app notice that it was rescheduled.",
    liveSaveVenueLabel: "Address",
    liveSaveVenueNotice:
      "Anyone who RSVP'd or saved this listing gets an email and an in-app notice that the listing's place changed.",
    liveSaveBothNote: "Two notices go out, one for each change.",
    liveSaveNotSet: "Not set",
    liveSaveCancel: "Keep editing",
    liveSaveConfirm: "Save and notify",

    // ── The three end states, where a listing really is read-only ──────
    lockedKicker: "Closed listing",
    lockedCancelledBody:
      "This listing was cancelled. It stays as it was when people were told the event was off.",
    lockedCompletedBody:
      "This event has already happened. It stays as the record of what took place.",
    lockedArchivedBody:
      "This listing is archived. Restore it before making any changes.",
    errListingLocked:
      "This listing was cancelled, completed or archived since you opened it, so it can no longer be edited.",
    /** Save refused: the linked venue withholds its address (INVALID_INPUT, meta.reason PLACE_WITHHOLDS_ADDRESS). */
    errPlaceWithholdsAddress:
      "This place keeps its address private, so a community listing can't link to it. Type the address instead.",
    /** Save refused: the linked venue has no full address and pin (INVALID_INPUT, meta.reason PLACE_LOCATION_INCOMPLETE). */
    errPlaceLocationIncomplete:
      "This place has no full address and map pin yet, so a community listing can't link to it. Type the address instead.",
  },

  // ── Private "Attendee feedback" tab (attendee-reviews FR-007) ────────
  attendeeFeedback: {
    title: "Attendee feedback",
    subtitle:
      "Ratings and comments from verified attendees who scanned in. Comments are shared with you without the attendee's name.",
    loading: "Loading feedback…",
    errorMessage: "We couldn't load attendee feedback.",
    retry: "Retry",
    emptyTitle: "No attendee feedback yet",
    emptyBody:
      "Feedback appears after the show, once attendees who scanned in leave a review.",
    reviewCount: "{count, plural, one {# review} other {# reviews}}",
    scoreOutOf: "{score} / 5",
    aggOverall: "Overall",
    aggRecommend: "Would recommend",
    aggSound: "Sound",
    aggVenueComfort: "Comfort & sightlines",
    aggOrganization: "Organization",
    aggValue: "Value for money",
    commentsIntro: "Comments are shown without attribution, newest first.",
    noComments: "No written comments yet.",
    aggregateScope:
      "Across every review of this event, including ratings left without a comment.",
    aggregateScopeFiltered:
      "Across every review of this event — the comment filter doesn't change these numbers.",
    commentCount: "{count, plural, one {# comment} other {# comments}}",
    commentCountFiltered: "{shown} of {total} comments",
    filterAriaLabel: "Comment filters",
    filterFlagged: "Reported",
    filterUnflagged: "Not reported",
    noMatchTitle: "No comments match that filter",
    noMatchBody: "Clear the filter to see every comment on this event.",
    report: "Report",
    reportAria: "Report this comment to platform staff",
    reportedLabel: "Reported",
    reportedToastTitle: "Comment reported",
    reportedToastMessage: "Our team will review it.",
    reportFailedTitle: "Couldn't report comment",
    reportFailedMessage: "Please try again.",
  },

  // ── Owner-side "Suggested edits" inbox (FR-016) ──────────────────────
  ownerSuggestions: {
    title: "Suggested edits",
    orgSubtitle:
      "Edits people have proposed to your group's events. Nothing changes unless you approve it.",
    eventSubtitle:
      "Edits people have proposed to this event. Nothing changes unless you approve it.",
    empty: "No pending suggestions",
    emptyHint:
      "When someone proposes an edit, it will wait here for your review.",
    reviewPlaceholder: "Select a suggestion to review it",
    reviewPlaceholderHint: "The proposed changes will open here.",
    bulkSelectAll: "Select all",
    // Two pending suggestions can share an event, so the name carries the
    // submitter and the time as well — checkboxes must not collide.
    bulkSelectRow: "Select the suggestion for {event} from {submitter}, {when}",
    bulkApproveSelected: "Approve selected",
    bulkRejectSelected: "Reject selected",
    bulkCancel: "Cancel",
    bulkProgress: "{done} of {total}",
    bulkApproveConfirmTitle:
      "{count, plural, one {Approve # suggestion?} other {Approve # suggestions?}}",
    bulkApproveConfirmBody:
      "The proposed changes go live on those event listings straight away, without opening each one. Rejecting instead changes nothing.",
    bulkApproveConfirmCta: "Approve them",
    bulkApprovedToast:
      "{count, plural, one {# suggestion approved} other {# suggestions approved}}",
    bulkRejectedToast:
      "{count, plural, one {# suggestion rejected} other {# suggestions rejected}}",
    bulkPartialToast: "Not every suggestion went through",
    // `conflicted` is a subset of `decided`, so it is nested rather than
    // listed as a fourth bucket a reader would add up. Empty branches drop
    // the zero cases entirely.
    bulkPartialToastMessage:
      "{decided} decided{conflicted, plural, =0 {} other { (# partly applied)}}{already, plural, =0 {} other { · # already reviewed}}{failed, plural, =0 {} other { · # failed}}",
    bulkStoppedToast: "Stopped partway",
    bulkStoppedRateLimited:
      "{decided, plural, =0 {Too many requests in a row — none went through. Wait a moment, then try again.} other {Too many requests in a row — # went through. Wait a moment, then run the rest.}}",
    bulkStoppedUnauthorized:
      "{decided, plural, =0 {Your session ended before anything went through. Sign in again to try.} other {Your session ended — # went through. Sign in again to run the rest.}}",
  },

  // ── Public propose-mode edit surface (/events/<slug>/suggest) ────────
  suggestEdit: {
    pageTitle: "Suggest an edit",
    pageSubtitle:
      "Propose changes to this event. Nothing is published until a reviewer approves it.",
    backToEvent: "Back to event",
    backHome: "Back to home",
    loadError: "We couldn't load this event's details.",
    retry: "Retry",
    gatedTitle: "This event doesn't accept public suggestions",
    gatedBody:
      "Access to this event is restricted, so its details can't be edited publicly.",
    notFoundTitle: "Event unavailable",
    notFoundBody:
      "This event doesn't exist or isn't open to public suggestions.",

    fieldTitle: "Title",
    fieldDateTime: "Date & time",
    fieldStarts: "Starts",
    fieldEnds: "Ends",
    fieldTimezone: "Timezone",
    fieldLocation: "Location",
    locationPlaceholder: "Search for an address…",
    locationSelectedHint: "Location pinned ({country}).",
    locationHiddenNote:
      "The exact location isn't shown for this event. Pick an address only if you're proposing a new one.",
    fieldCategory: "Category",
    categoryNone: "No category",
    fieldAgeLimit: "Age limit",
    ageLimitPlaceholder: "e.g. 18",
    ageLimitHint: "Optional. Leave empty for all ages.",
    fieldPhoto: "Photo",
    photoPickerAria: "Choose the event photo",
    photoOptionAria: "Photo option {number}",
    noPhotosYet: "This event has no photos yet.",
    photoUpload: "Upload a photo",
    photoUploading: "Uploading…",
    photoUnattachedNote:
      "New photos stay private until your suggestion is approved.",
    photoSignInNudge: "Want to add a photo?",
    signInLink: "Sign in to upload photos",
    uploadFailedToast: "Photo upload failed",
    fieldDetails: "Details",
    detailsPlaceholder: "Describe the event…",
    fieldNote: "Note to reviewers",
    notePlaceholder:
      "Optional — tell reviewers why you're proposing this change",

    noChangesHint: "Nothing to submit yet — change a field first.",
    cancel: "Cancel",
    submit: "Submit suggestion",
    submitPending: "Submitting…",
    successTitle: "Thanks — your suggestion is pending review",
    successBody:
      "A reviewer will look at your proposed changes. If approved, they'll appear on the event.",
    successAnonNote: "Nothing you submitted is public until it's approved.",
    rateLimitedToast: "Too many suggestions for now",
    rateLimitedHint: "Give it a few minutes, then try again.",

    errTitleRequired: "The title can't be empty.",
    errStartsRequired: "Choose a start time.",
    errEndsRequired:
      "This event has an end time — it can be moved, not removed.",
    errEndsBeforeStarts: "The end time must be after the start time.",
    errLocationPick: "Search for the address and pick a suggestion.",
    errCountryMissing:
      "That location doesn't resolve to a country — pick a more specific address.",
    errAgeLimit: "Age limit must be a whole number between 0 and 99.",
    errBlockedContent:
      "Some of the proposed content was rejected. Check the wording and try again.",
    errInvalidBody:
      "We couldn't process the event details — try simplifying the formatting, then submit again.",
    errEmptyDiff: "Nothing to submit yet — change a field first.",
    errCannotAccept:
      "We couldn't accept this change. Refresh the page and try editing again.",
    errLocationIncomplete:
      "That location is incomplete — search for the address again and pick a suggestion.",
    errNotAnEventImage:
      "That photo isn't available for this event — pick another one.",
    errUploadNotFinalized:
      "That photo hasn't finished uploading yet — wait for it to finish, then try again.",
    errUnattachedNotOwnUpload:
      "That photo isn't available to use here — pick a different one.",
    errStoredRevalidation:
      "This suggestion can no longer be applied — its saved details didn't pass validation. Reject it and ask for a fresh one.",
  },

  // ── Generic volunteering asks (generic-volunteering-asks spec) ────────
  // Org/place/personal ask dashboards, ask manage page, public signup
  // page (/v/[askId]), coordinator console, calendar export, /auth/complete.
  volunteering: {
    // Ask status / cadence
    askStatusDraft: "Draft",
    askStatusOpen: "Open",
    askStatusPaused: "Paused",
    askStatusClosed: "Closed",
    askStatusArchived: "Archived",
    cadenceOneTime: "One-time",
    cadenceOngoing: "Ongoing",
    cadenceRecurring: "Recurring",

    // Signup statuses (mirrors the event admin tab wording)
    signupStatusPending: "Pending",
    signupStatusApproved: "Approved",
    signupStatusRejected: "Rejected",
    signupStatusWithdrawn: "Withdrawn",
    signupStatusCheckedIn: "Checked in",
    signupStatusNoShow: "No-show",

    // ATTENDEE-facing wording for the same statuses (/my-volunteering). The
    // block above is the organizer's review vocabulary; a volunteer is asking
    // "am I on the schedule?" and needs an answer, not a record status.
    // NO_SHOW has no attendee wording on purpose — nothing writes that status.
    myStatusPending: "Awaiting confirmation",
    myStatusApproved: "Confirmed",
    myStatusCheckedIn: "Checked in",
    myStatusRejected: "Not this time",
    myStatusWithdrawn: "You withdrew",

    // Domain conflicts
    errAskArchived: "This ask is archived and can no longer be changed.",
    errAskNotOpen: "This ask isn't taking signups right now.",
    errDuplicateGroupName: "A group with that name already exists on this ask.",
    errDuplicateRoleName: "A role with that name already exists on this ask.",
    errGroupFull: "That group is full.",
    errAskFull: "This ask has reached its capacity.",

    // Calendar export
    addToCalendar: "Add to calendar",
    subscribeFeed: "Subscribe to my volunteering",
    feedLinkCopied: "Feed link copied",
    icsDownloadFailed: "Couldn't download the calendar file",
    feedSubscribeFailed: "Couldn't get your calendar feed link",
    feedCopyBlocked: "Couldn't copy the link — try again or copy it manually.",
    resetFeedLink: "Reset calendar link",
    resetFeedLinkConfirm:
      "Reset your calendar link? The old link stops working immediately — every calendar app using it (including yours) will need the new link.",
    feedLinkReset: "Calendar link reset",
    feedLinkResetBody: "New link copied — re-subscribe in your calendar app.",
    feedResetFailed: "Couldn't reset your calendar feed link",

    // Group assignment
    generalPool: "General pool",
    otherGroup: "Another group",
    groupAssignLabel: "Assign to group",
    groupAssignFailed: "Couldn't move the volunteer",

    // Signup review row
    signupActionFailed: "Action failed",
    signupCheckedIn: "Volunteer checked in",
    approveCta: "Approve",
    rejectCta: "Reject",
    checkInCta: "Check in",
    rejectConfirmTitle: "Reject this signup?",
    rejectConfirmBody:
      "{name} will be notified that their application was not accepted.",

    // Coordinator picker
    coordinatorLabel: "Coordinator",
    coordinatorNone: "No coordinator assigned",
    coordinatorUnnamed: "Unnamed coordinator",
    coordinatorAssignCta: "Assign",
    coordinatorReplaceCta: "Replace",
    coordinatorClearCta: "Remove",
    coordinatorEmailLabel: "Coordinator email",
    coordinatorEmailPlaceholder: "person@example.com",
    coordinatorInviteHint:
      "If they don't have an account yet, they'll receive an invite email.",
    coordinatorUpdated: "Coordinator updated",
    coordinatorUpdateFailed: "Couldn't update the coordinator",
    coordinatorClearConfirmTitle: "Remove the coordinator?",
    coordinatorClearConfirmBody:
      "They'll lose access to this group's roster. The group and its members stay put.",

    // Group card
    groupFill: "{count} / {cap} members",
    groupFillOpen: "{count} members",
    groupEmpty: "No members in this group yet.",

    // Broadcasts
    broadcastCta: "Broadcast",
    broadcastTitle: "Send an announcement",
    broadcastHint:
      "One-way announcement delivered by email and in-app notification. Replies don't come back here.",
    broadcastScopeLabel: "Send to",
    broadcastSubjectLabel: "Subject",
    broadcastBodyLabel: "Message",
    broadcastSendCta: "Send",
    broadcastSent: "Announcement sent",
    broadcastSentBody: "Delivered to {count} volunteers.",
    broadcastFailed: "Couldn't send the announcement",
    broadcastScopeAll: "Everyone on this ask",
    broadcastScopePool: "General pool (unassigned)",
    broadcastScopeRole: "Role: {name}",
    broadcastScopeGroup: "Group: {name}",
    broadcastRecipients: "{count} recipients",
    broadcastsSection: "Announcements",
    broadcastsEmpty: "No announcements sent yet.",
    deletedScope: "removed",

    // Ask form
    askFormCreateTitle: "New volunteer ask",
    askFormEditTitle: "Edit volunteer ask",
    askFieldTitle: "Title",
    askFieldTitlePlaceholder: "e.g. Standing door & setup crew",
    askFieldDescription: "Description",
    askFieldCadence: "Cadence",
    askFieldStartsAt: "Starts",
    askFieldEndsAt: "Ends",
    askWindowError: "The end must be after the start.",
    askStartsIncomplete: "Part of the start date or time is missing.",
    askEndsIncomplete: "Part of the end date or time is missing.",
    askFieldCapacity: "Capacity",
    askFieldCapacityPlaceholder: "Leave empty for no cap",
    capacityInvalid:
      "Capacity must be a whole number of at least 1 — leave it empty for no cap.",
    askFieldAutoApprove: "Auto-approve signups",
    askFieldAutoApproveHelp:
      "New signups are approved automatically while there's room.",
    askFieldWaiverRequired: "Require waiver acceptance",
    askFieldWaiverRequiredHelp:
      "Volunteers must affirmatively accept a waiver when signing up.",
    askFieldSmsOptIn: "Offer SMS reminders",
    askFieldSmsOptInHelp:
      "Volunteers who share a phone number can opt in to text reminders.",
    askCreated: "Ask created — it starts as a draft until you open it",
    askUpdated: "Ask updated",
    askSaveFailed: "Couldn't save the ask",
    askTitleRequired:
      "Add a title so volunteers know what they're signing up for.",
    askFieldTimezone: "Timezone",
    askFieldTimezoneHelp: "The start and end times are in this zone.",

    // Ask waiver section (ask-level-volunteer-waivers FR-007)
    waiverSectionTitle: "Volunteer waiver",
    waiverSectionHint:
      "Attach the waiver volunteers must accept when they sign up.",
    waiverTemplateLabel: "Waiver template",
    waiverNone: "No waiver",
    waiverStandardTag: "standard",
    waiverPlatformTag: "platform",
    waiverUseStandard: "Use the standard volunteer waiver",
    waiverStandardInUse: "Standard waiver in use",
    waiverPreviewLabel: "Preview",
    waiverAssigned: "Waiver updated",
    waiverRemoved: "Waiver removed",
    waiverAssignFailed: "Couldn't update the waiver",
    waiverNoTemplateWarning:
      "This ask requires a waiver, but none is attached yet — until you add one, volunteers won't be asked to accept anything.",
    waiverNotRequiredNote:
      "A waiver is attached, but “Require waiver acceptance” is off — volunteers won't see it until you turn that on.",
    waiverTemplatesError: "Couldn't load your waiver templates.",

    // Asks list (org / personal / place dashboards)
    newAskCta: "New ask",
    asksEmptyTitle: "No volunteer asks yet",
    asksEmptyDescription:
      "Post an ask to recruit standing volunteer help and share its public link.",
    askWindowFrom: "From {date}",
    askWindowUntil: "Until {date}",
    askCapacityBadge: "Cap {cap}",
    copyPublicLink: "Copy public link",
    publicLinkCopied: "Link copied",
    manageCta: "Manage",
    tabHours: "Hours",
    tabAsks: "Asks",
    asksTitle: "Volunteer asks",
    asksSubtitle: "Standing calls for volunteers — not tied to a single event.",
    placeTabVolunteers: "Volunteers",
    placeAsksTitle: "Volunteer asks",
    placeAsksSubtitle:
      "Recruit a standing pool of help for this place and share the public signup link.",

    // Ask manage page
    backToAsks: "Back to volunteers",
    statusActionDraft: "Back to draft",
    statusActionOpen: "Open for signups",
    statusActionPause: "Pause",
    statusActionClose: "Close",
    statusActionArchive: "Archive",
    closeConfirmTitle: "Close this ask?",
    closeConfirmBody:
      "New signups stop immediately. The roster is preserved and you can reopen later.",
    archiveConfirmTitle: "Archive this ask?",
    archiveConfirmBody:
      "Archived asks are frozen: no signups, edits, or broadcasts. This is the end of the road for this ask.",
    rolesSection: "Roles",
    addRoleCta: "Add role",
    rolesEmpty:
      "No roles yet — volunteers sign up against a role, so add at least one before opening.",
    roleFill: "{count} / {cap} filled",
    roleFillOpen: "{count} accepted",
    rolePending: "{count} pending",
    roleDefaultHours: "~{hours} h",
    roleSaved: "Role saved",
    roleSaveFailed: "Couldn't save the role",
    roleDialogCreateTitle: "Add role",
    roleDialogEditTitle: "Edit role",
    roleFieldName: "Name",
    roleFieldDescription: "Description",
    roleFieldCapacity: "Capacity",
    roleFieldDefaultHours: "Default hours",
    roleFieldDefaultHoursHelp:
      "Stamped as hours worked at check-in, since ask roles have no shift to measure.",
    defaultHoursInvalid:
      "Default hours must be a number between 0 and 99 — leave it empty for none.",
    groupsSection: "Groups",
    addGroupCta: "Add group",
    groupsEmpty:
      "No groups yet — groups let a coordinator manage a slice of the roster without org access.",
    groupDialogTitle: "New group",
    groupFieldName: "Name",
    groupFieldDescription: "Description",
    groupFieldCapacity: "Capacity",
    groupCreated: "Group created",
    groupCreateFailed: "Couldn't create the group",
    poolSection: "General pool",
    poolHint:
      "Approved volunteers not assigned to any group. Assign them to a group or check them in here.",
    poolEmpty: "Nobody in the general pool right now.",
    pendingQueueSection: "Pending review",
    pendingQueueEmpty: "No applications waiting for review.",
    roleFilterLabel: "Filter by role",
    roleFilterAll: "All roles",
    loadMoreCta: "Load more",
    showMembers: "Show members",
    hideMembers: "Hide members",
    membersLoadFailed: "Couldn't load the member list.",

    // Public signup page (/v/[askId])
    publicNotFoundTitle: "This volunteering link isn't available",
    publicNotFoundBody:
      "The ask may have been removed, or the link is wrong. Check with whoever shared it.",
    publicPausedTitle: "Signups are paused",
    publicClosedTitle: "Signups are closed",
    publicClosedBody:
      "This ask isn't taking new signups right now. Check back later or contact the organizer.",
    publicRolesTitle: "Where we need help",
    publicNoRoles: "No roles are open right now.",
    publicRoleHours: "~{hours} h per check-in",
    publicSpotsOpen: "Spots open",
    publicSpotsFull: "Full — waitlist",
    publicJoinWaitlist: "Join waitlist",
    publicSelectRole: "Count me in",
    publicSubmittingAs: "Submitting as",
    publicFieldName: "Name",
    publicFieldEmail: "Email",
    publicFieldPhone: "Phone",
    publicFieldOptional: "optional",
    publicSmsOptIn:
      "Text me a reminder before it starts: texts from Ithas Fire about 24h and 1h before, US numbers only. Optional, not required to sign up. Msg & data rates may apply. Reply STOP to opt out, HELP for help.",
    publicWaiverLabel:
      "I agree to the volunteer waiver required by the organizer.",
    publicSelectionNone: "Pick a role to get started",
    publicSelectionCount: "{count} selected",
    publicApplyCta: "Sign up",
    publicErrEmailRequired: "Enter your email so the organizer can reach you.",
    publicErrAnswersRequired: "Please answer the required questions.",
    publicErrWaiverRequired:
      "This ask requires accepting the waiver before signing up.",
    publicErrNotFound: "That role isn't available anymore.",
    publicErrGeneric: "Something went wrong — please try again.",
    publicErrSmsUsOnly:
      "We can only text US numbers. Untick the box or use a US number.",
    publicSuccessTitle: "You're signed up",
    publicSuccessPartialTitle: "Partially submitted",
    publicResultApproved: "Approved — you're confirmed.",
    publicResultPending:
      "Application received — you'll get an email when it's reviewed. If you had already applied, we kept your original application.",
    publicSuccessEmailHint: "A confirmation was sent to your email address.",
    // Waiver (ask-level-volunteer-waivers FR-006)
    publicWaiverReview:
      "Please review the volunteer waiver below before you sign up.",
    publicWaiverScrollLabel: "Volunteer waiver text",
    publicWaiverOnFile: "Waiver already on file",
    publicWaiverOnFileHint:
      "You've already accepted this waiver, so there's nothing more to sign.",
    publicWaiverLoadError:
      "We couldn't load the waiver. Refresh and try again.",

    // Coordinator console (/volunteers/coordinate/[askId])
    coordinateTitle: "Your volunteer groups",
    coordinateSubtitle:
      "Review, check in, and message the volunteers in the groups you coordinate.",
    coordinateSignInTitle: "Sign in to coordinate",
    coordinateSignInBody:
      "This page shows the volunteer groups assigned to you. Sign in with the email that received the invitation.",
    coordinateSignInCta: "Sign in",
    coordinateForbiddenTitle: "You're not coordinating this ask",
    coordinateForbiddenBody:
      "Only assigned group coordinators can see this roster. If you were expecting access, ask the organizer to assign you.",
    coordinatePoolHint:
      "Approved volunteers without a group — pull them into one of your groups.",
    pullIntoGroup: "Pull into {name}",
    pullIntoGroupSelect: "Pull into a group…",
    pulledIntoGroup: "Pulled into {name}",
    retryCta: "Retry",

    // ── Comp-ticket rewards (volunteer-comp-tickets spec) ──
    // Reward status badge
    rewardStatusGranted: "Comp granted",
    rewardStatusRedeemed: "Comp used",
    rewardStatusRevoked: "Comp voided",
    rewardBadgeTooltip: "Volunteer comp-ticket reward status",
    // Reward triggers
    rewardTriggerOnApproval: "When approved",
    rewardTriggerOnCheckIn: "When checked in",
    rewardTriggerOnApprovalHelp:
      "Grant the comp as soon as the volunteer is approved — rewards commitment, but the ticket is spent before they show up.",
    rewardTriggerOnCheckInHelp:
      "Grant the comp only when the volunteer is checked in on the day — the safer money posture (recommended).",
    // Reward config form
    rewardConfigTitle: "Volunteer comp reward",
    rewardConfigSubtitle:
      "Grant a free ticket to volunteers automatically. A comp is the maximum reward — there are no partial discounts.",
    rewardNoTicketTypes:
      "Add at least one ticket type to this event before setting a comp reward.",
    rewardScopeLabel: "Applies to",
    rewardScopeWholeAsk: "All volunteers",
    rewardTicketTypeLabel: "Comp ticket type",
    rewardTicketTypePlaceholder: "Choose a ticket type…",
    rewardTicketTypeRequired: "Choose which ticket type the comp grants.",
    rewardTicketTypeGone: "Ticket type removed",
    rewardCompHelp:
      "Volunteers receive a free ($0) ticket of this type. It scans, transfers, and refunds like any other ticket.",
    rewardTriggerLabel: "Grant the comp",
    rewardMaxGrantsLabel: "Budget cap (optional)",
    rewardMaxGrantsPlaceholder: "e.g. 50",
    rewardMaxGrantsInvalid:
      "Enter a whole number of 1 or more, or leave blank.",
    rewardMaxGrantsHelp:
      "The most comps this reward will ever issue. Leave blank for no cap.",
    rewardCurrentConfigLabel: "Current reward",
    rewardActive: "Active",
    rewardInactive: "Inactive",
    rewardCurrentConfigSummary:
      "{ticketType} · {faceValue} face value · granted {trigger}",
    rewardCurrentBudget: "{used} of {cap} comps used · {remaining} remaining",
    rewardCurrentBudgetUncapped: "{used} comps used · no cap",
    rewardSaveCta: "Save reward",
    rewardUpdateCta: "Update reward",
    rewardSaved: "Reward saved",
    rewardSaveFailed: "Couldn't save the reward",
    // Reward ledger
    rewardLedgerTitle: "Reward ledger",
    rewardLedgerGranted: "Granted",
    rewardLedgerRedeemed: "Redeemed",
    rewardLedgerRevoked: "Revoked",
    rewardLedgerRemaining: "Remaining budget",
    rewardLedgerUncapped: "No cap",
    rewardLedgerFaceValue: "Face value comped",
    rewardLedgerEmpty: "No comps have been granted yet.",
    rewardGrantTimeline:
      "Granted {granted} · Redeemed {redeemed} · Revoked {revoked}",
    // Reward tab gates
    rewardFinanceRequiredTitle: "Finance access required",
    rewardFinanceRequiredBody:
      "Comp rewards spend event revenue, so only owners, admins, and finance team members can configure or view them.",
    rewardNoAsk:
      "Add a volunteer role to this event first, then set a comp reward.",
    // Reward conflicts
    errRewardRequiresEventAsk:
      "Comp rewards can only be attached to event volunteering.",
    errDuplicateReward:
      "A reward already exists for this scope. Reload and edit the existing one.",
    // ── Void comp (manual reward revoke — finance) ──────────────────────────
    rewardVoidCta: "Void comp",
    rewardVoidConfirmTitle: "Void this comp?",
    rewardVoidConfirmBody:
      "This voids the volunteer's free ticket and cancels the comp order, returning the budget slot so it can be granted again. This can't be undone.",
    rewardVoidConfirmCta: "Void comp",
    rewardVoidSuccess: "Comp voided",
    rewardVoidFailed: "Couldn't void this comp",
    errRewardAlreadyRedeemed:
      "This comp has already been used, so it can't be voided. Refund it manually if needed.",
    // ── End void comp ───────────────────────────────────────────────────────

    // /auth/complete (account completion handoff)
    authCompleteTitle: "Finish setting up your account",
    authCompleteBody:
      "You signed up (or were invited) by email. Create an account with that same address to manage your volunteering in one place.",
    authCompleteBodyWithEmail:
      "You signed up (or were invited) as {email}. Create an account with that same address to manage your volunteering in one place.",
    authCompleteHint:
      "Already have an account? Just sign in — everything tied to your email follows automatically.",
    authCompleteAlreadyHave: "I already have an account",
  },
  platformMemberships: {
    title: "Membership standing",
    subtitle:
      "Per-account membership risk: dispute-fee exposure, rolling reserve, and suspension of new signups. Suspending blocks new members only — existing subscriptions keep billing.",
    loadError: "Could not load membership standings.",
    empty: "No owners with membership tiers yet.",
    colOwner: "Owner",
    colTiers: "Tiers",
    colMembers: "Members",
    colExposure: "Dispute exposure",
    colReserve: "Reserve",
    colStatus: "Status",
    tiersCell: "{active} active · {total} total",
    membersCell: "{count} live",
    exposureNone: "No disputes",
    exposureFees: "{value} fees",
    exposureDisputed: "{value} disputed",
    exposureCounts: "{count} total · {open} open · {lost} lost",
    reserveCell: "{bps} bps · {days}d release",
    reserveNone: "None",
    manualOverride: "Set manually by {actor}",
    statusSuspended: "Suspended",
    statusOk: "OK",
    actionSuspend: "Suspend",
    actionUnsuspend: "Unsuspend",
    actionEditReserve: "Edit reserve",
    suspendTitle: "Suspend memberships",
    unsuspendTitle: "Lift suspension",
    suspendBody:
      "New membership signups for {owner} will be refused immediately. Existing subscriptions are not canceled and keep billing.",
    unsuspendBody: "New membership signups for {owner} will be accepted again.",
    reserveTitle: "Rolling reserve",
    reserveBody:
      "A slice of {owner}'s membership payouts is held and released after the window below. Setting it manually pins it — automatic seasoning will not change it.",
    reserveBpsLabel: "Reserve (basis points)",
    reserveBpsHint: "0–10000. 500 bps = 5%. 0 clears the reserve.",
    reserveDaysLabel: "Release after (days)",
    reserveDaysHint: "0–365 days before a held slice is released.",
    reasonLabel: "Reason (required)",
    reasonPlaceholder: "Why you are intervening — lands in the audit log",
    confirmSuspend: "Suspend",
    confirmUnsuspend: "Lift suspension",
    confirmReserve: "Save reserve",
    cancel: "Cancel",
    saving: "Saving…",
    toastSuspended: "Memberships suspended",
    toastUnsuspended: "Suspension lifted",
    toastReserveSaved: "Reserve updated",
    toastError: "Could not update standing",

    // ── Visibility sections (recurring revenue / needs attention / leaving) ──
    // Prefix `mv` = "membership visibility", to keep them apart from the risk
    // keys above, which belong to MembershipStandingsView.
    mvLoading: "Loading…",
    mvLoadMore: "Load more",
    mvTimedOut: "This read timed out.",
    mvRetry: "Try again",
    mvOwnerOrg: "Organisation",
    mvOwnerHuman: "Person",
    mvUnnamedMember: "Unnamed member",
    mvIntervalMonth: "per month",
    mvIntervalYear: "per year",
    mvTimeZoneNote: "Dates shown in {zone}.",

    mvRevTitle: "Recurring revenue",
    mvRevIntro:
      "What members send their places and artists. Memberships carry no platform fee, so none of this is ours — it is money the platform moves, not money it earns.",
    mvRevEmpty: "No active or trialing memberships yet.",
    mvRevActive: "{count} paying",
    mvRevTrialing: "{count} on trial, paying nothing yet",
    mvRevMonthly: "Monthly, to owners",
    mvRevMonthlyHint:
      "The annualised total divided by twelve, once. Rounded down, so it is never more than the money that exists.",
    mvRevAnnualised: "Annualised",
    mvRevAnnualisedHint:
      "Exact. Every paying membership at its yearly value, with no division involved.",
    mvRevAnnualBilled: "{count} billed annually",
    mvRevRemainder: "Rounding down set aside",
    mvRevTiersDegraded:
      "Some tiers could not be read, so these totals cover only part of the book.",
    // NOT an empty state. Rendered when the tier lookup resolved NOTHING, where
    // saying "no memberships" would report unknown as zero.
    mvRevUnavailable:
      "Membership tiers could not be read, so no figure can be shown. This is not a report of zero — reload to try again.",
    mvRevTierCount: "Across {count} tier(s) with members.",

    mvAttentionTitle: "Needs attention",
    mvAttentionIntro:
      "Memberships whose card is failing, and signups that never completed. A past-due or unpaid member is denied every benefit at checkout while Stripe retries, and we send no dunning mail — nothing else in the system is telling them.",
    mvAttentionEmpty: "No memberships need attention.",
    mvAttentionCaption: "Memberships needing attention",
    mvColMember: "Member",
    mvColOwner: "Goes to",
    mvColAmount: "Amount",
    mvColState: "State",
    mvColSince: "For",
    mvStatusPastDue: "Card failing",
    mvStatusUnpaid: "Retries exhausted",
    mvStatusIncomplete: "Signup never finished",
    mvBenefitsDenied: "Benefits denied",
    mvSinceApprox: "about {duration}",
    mvSinceBasisSignup: "since signup",
    mvSinceBasisLastChange: "since the record last changed",

    mvLeavingTitle: "Leaving",
    mvLeavingIntro:
      "Memberships set to end when the current period does. This is the last window in which anyone can reach these members — after it, re-joining is a fresh decision. A member with a failing card can appear here and above: those are two different problems, not a duplicate row.",
    mvLeavingEmpty: "No memberships are scheduled to end soon.",
    mvLeavingCaption: "Memberships scheduled to end",
    mvColEnds: "Ends",
    mvEndsIn: "in {duration}",
  },
  // P5-I1 (invite page)
  bookingActInvite: {
    kicker: "You're on a bill",
    title: "{sender} put you on a bill at {place}",
    lede: "Nothing is booked yet. {place} and {sender} still have to agree the terms.",
    senderFallback: "Someone",
    placeFallback: "a place",
    unnamed: "Unnamed",
    fromLabel: "From",
    placeLabel: "Place",
    datesLabel: "Preferred dates",
    noDates: "No dates given",
    spotLabel: "Your spot",
    headlining: "Headlining",
    ordinalOne: "{n}st",
    ordinalTwo: "{n}nd",
    ordinalFew: "{n}rd",
    ordinalOther: "{n}th",
    billHeading: "The bill so far",
    youTag: "You",
    byName: "By name",
    passedTag: "Passed",
    answeringAs: "Answering as",
    answeringAsYou: "{name} (you)",
    countMeIn: "Count me in",
    pass: "I'll pass",
    passGroupLabel: "Pass on this bill",
    back: "Back",
    leave: "Leave the bill",
    reasonLabel: "Want to say why?",
    optional: "(optional)",
    reasonHint: "Your reason is kept with your answer.",
    reasonCounter: "{count} / {max}",
    passFinal: "Passing is final for this request.",
    leaveFinal: "Leaving is final for this request.",
    noteLeaveAndPass:
      "You can leave the bill until the night is booked. Passing is final for this request.",
    noteJoinAfterMint:
      "The night is already booked. If you join while the event is upcoming, you go straight onto its lineup, and after that only the organizer can take you off.",
    noteNews: "Later news about this bill comes under Bills you're on.",
    notificationSettings: "Notification settings",
    joinedTitle: "You joined",
    joinedBody: "You're on the bill. {place} can see that you joined.",
    passedTitle: "You passed",
    passedBody: "You passed on this bill. That answer is final for this request.",
    closedTitle: "Request closed",
    closedBody:
      "This request isn't going ahead. Nothing was booked, and there is nothing to answer.",
    bookedTitle: "Night booked: you're on the lineup",
    bookedBody:
      "{place} and {sender} agreed the night. The bill is now the event's lineup and can't be changed here.",
    blockedActDeclined: "You passed on this bill, so you can't join it now.",
    blockedRequestClosed:
      "This request isn't going ahead, so there is nothing to answer.",
    blockedOnLineup:
      "You're on the event's lineup now, so you can't leave the bill here.",
    loading: "Loading your invite",
    notFoundTitle: "Invite not found",
    notFoundBody:
      "This invite doesn't exist, or it isn't for the account you're signed in with.",
    goHome: "Go to the home page",
    errorTitle: "We couldn't load this invite",
    errorBody: "Something went wrong loading this invite.",
    retry: "Try again",
  },
  // The deal (deal-terms-and-settlement FR-003): components/deals.
  deals: {
    title: "The deal",
    lede: "Who gets paid when this night settles, and how each amount is worked out.",
    loading: "Loading the deal",
    startFromPreset: "Start from a preset",
    presetHint: "A preset rewrites the act's clause. Other payees' clauses and the costs off the top stay as they are.",
    preset: {
      guarantee: "Guarantee",
      doorSplit: "Door split",
      guaranteePlus: "Guarantee + %",
      versus: "Versus",
      straight: "Straight %",
      roomRental: "Room rental",
    },
    presetExplain: {
      GUARANTEE: "A fixed amount for the act, however many tickets sell. If the pool can't cover it, whoever takes the rest owes the difference.",
      DOOR_SPLIT: "A percentage of the pool, once the costs off the top have come out.",
      GUARANTEE_PLUS_PERCENT: "A fixed amount plus a percentage, added together.",
      VERSUS: "A fixed amount or a percentage, whichever is greater once the real numbers are in.",
      STRAIGHT_PERCENT: "A percentage of ticket money from the first ticket. Ithas Fire pays this one as tickets sell.",
      ROOM_RENTAL: "The place is paid for the room and the renter keeps the door.",
    },
    usePreset: "Use this preset",
    form: {
      act: "Act",
      place: "Place",
      rest: "The rest goes to",
      renter: "Renter (keeps the door)",
      choose: "Choose…",
      guarantee: "Guarantee",
      percentLabel: "Percentage",
      percentOfPool: "Percentage of the pool",
      percentOfTickets: "Percentage of ticket money",
      of: "Percentage of",
      ofPool: "The pool after costs",
      ofTickets: "Ticket money",
      together: "Guarantee and percentage",
      greater: "Whichever is greater",
      sum: "Added together",
      shape: "Paid as",
      fixed: "Fixed amount",
      percent: "Percentage",
      both: "Both",
      rental: "Room rental",
      rentalMode: "If the door doesn't cover the rental",
      rentalRecouped: "Recouped from the door",
      rentalFixed: "Fixed fee",
      rentalRecoupedHint: "Taken off the top from ticket money. What the door can't cover is the place's loss.",
      rentalFixedHint: "Owed in full however the night goes. If the door can't cover it, the renter owes the difference.",
      costKind: "Kind",
      costLabel: "Name",
      costAmount: "Amount",
      costPercent: "Percentage of ticket money",
      costAs: "Taken as",
      costAsAmount: "An amount",
      costAsPercent: "A percentage of ticket money",
      creditedTo: "Paid back to",
      estimated: "This is an estimate. The real cost is entered after the show.",
    },
    clauses: "Clauses",
    clausesHint: "The two parties agree the whole deal. Anyone else agrees their own line.",
    clausesHintEvent: "The organiser agrees the whole deal. Anyone else named here agrees their own line.",
    clausesHintDefault: "New events start from this deal. Anyone else named here agrees their own line.",
    noClauses: "No clauses yet. Start from a preset or add a payee.",
    clauseFixed: "{amount} guarantee",
    clausePercentPool: "{percent}% of the pool",
    clausePercentTickets: "{percent}% of ticket money",
    clausePlusPool: "{amount} guarantee plus {percent}% of the pool",
    clausePlusTickets: "{amount} guarantee plus {percent}% of ticket money",
    clauseVersusPool: "{amount} guarantee vs {percent}% of the pool",
    clauseVersusTickets: "{amount} guarantee vs {percent}% of ticket money",
    clauseVersusTail: ", whichever is greater",
    restMain: "The rest of the pool",
    restTail: ", plus the costs it fronted",
    restHint: "Whoever takes the rest also owes any shortfall, so it is always one of the parties.",
    changeRest: "Edit who takes the rest",
    changedWhileOpen: "Someone else changed this deal while you had it open. This form now shows the latest version: {now}.",
    changedWhileOpenKept: "Someone else changed this deal while you had it open. What you typed here is kept; the rest of the page shows the latest version.",
    paidThrough: "Paid through Ithas Fire",
    settledDirectly: "Settled directly",
    settleDirectly: "Settle directly",
    settledDirectlyNote: "Settled directly: Ithas Fire shows the math, {name} pays it.",
    settledDirectlyNoteNoRest: "Settled directly: Ithas Fire shows the math, the side that takes the rest pays it.",
    agreement: {
      withTheTerms: "With the terms",
      waiting: "Waiting for {name} to agree",
      agreed: "Agreed",
      declined: "Declined",
      countered: "{name} asked for a different share",
    },
    willBeAsked: "{name} isn't a party to these terms, so they'll be asked to agree their line.",
    edit: "Edit",
    editClauseFor: "Edit {name}'s clause: {words}",
    removeClauseFor: "Remove {name}'s clause: {words}",
    newClauseFor: "New clause for {name}",
    remove: "Remove",
    save: "Save",
    cancel: "Cancel",
    savedToast: "Deal saved",
    kindGroup: "Group",
    kindPerson: "Person",
    sourceParty: "Party",
    sourceBill: "From the bill",
    sourceLineup: "From the lineup",
    sourcePayee: "Payee",
    unnamed: "Unnamed payee",
    addPayee: "Add payee",
    fromTheBill: "From the bill",
    added: "Added",
    searchPayees: "Search people and groups",
    searchPlaceholder: "Bandmate, promoter, sound company…",
    searchScope: "Search in",
    scopeAll: "All",
    scopePeople: "People",
    scopeGroups: "Groups",
    searching: "Searching…",
    noResults: "No one found",
    drift: "The lines paid as tickets sell add up to {percent}%, not 100%. Saving the deal again puts them back to 100%.",
    offTheTop: "Off the top",
    offTheTopHint: "Taken from ticket money before the pool is split, and paid back to whoever fronted it.",
    noCosts: "No costs off the top.",
    addCost: "Add a cost",
    editCost: "Edit {label}",
    removeCost: "Remove cost",
    recoupedBy: "Recouped by {name}",
    frontedBy: "Fronted by {name}",
    estimated: "Estimated",
    costPercent: "{percent}% of ticket money",
    costKind: {
      rental: "Room rental",
      expense: "Expense",
      houseNut: "House nut",
    },
    calculator: "Calculator",
    calcFromEvent: "From this event's ticket types",
    calcTyped: "Your numbers",
    calcIfWeSell: "If we sell",
    calcTicketsAt: "tickets at",
    calcRow: "row {n}",
    calcReset: "Use the event's ticket types",
    calcPrompt: "Type a ticket count and a price to see who gets what.",
    calcNeedsTiers: {
      NO_EVENT: "There's no event yet. Type some numbers.",
      NO_TICKET_TYPES: "This event has no ticket types yet. Type some numbers.",
    },
    calcFailed: "We couldn't work out the numbers. Change a number to try again.",
    whoGetsWhat: "Who gets what",
    col: {
      payee: "Payee",
      entitled: "Entitled",
      how: "How it resolved",
    },
    total: "Total",
    totalChecked: "{amount} ✓",
    how: {
      fixed: "{amount} guarantee",
      percentPool: "{percent}% of the {basis} pool",
      percentTickets: "{percent}% of {basis} ticket money",
      sumPool: "{fixed} guarantee + {percent}% of the {basis} pool ({amount})",
      sumTickets: "{fixed} guarantee + {percent}% of {basis} ticket money ({amount})",
      versusPool: "{fixed} guarantee vs {percent}% of the {basis} pool ({amount})",
      versusTickets: "{fixed} guarantee vs {percent}% of {basis} ticket money ({amount})",
      pickedGuarantee: "the guarantee is greater",
      pickedPercent: "the percentage is greater",
      pickedTie: "they're equal",
      rest: "rest of the pool {amount}",
      credited: "{amount} costs paid back",
      notRecovered: "{amount} of its costs not recovered",
      uncovered: "{amount} the pool can't cover",
    },
    toThePool: "From ticket money to the pool",
    ticketRevenue: "Ticket revenue",
    paidFirst: "Paid as tickets sell",
    stepEstimated: "{label} (estimated)",
    stepNotRecovered: "{amount} not recovered, {name}'s loss",
    pool: "Pool",
    summaryOnePayer: "{payer} pays {list} directly.",
    summaryItem: "{name} {amount}",
    listJoin: ", ",
    summaryOwes: "{name} owes {amount}.",
    summaryOwed: "{name} is owed {amount}.",
    summaryNone: "Nothing to settle directly.",
    poolExplained: "The pool is ticket money, less the lines paid as tickets sell and the costs off the top.",
    shortfall: "Shortfall",
    shortfallBody: "{payer} is {amount} short. Ithas Fire doesn't cover this: {payer} owes {list} directly.",
    ownLineHint: "You're a payee on this deal, so you see your own line.",
    empty: {
      title: "No deal yet",
      bodyEvent: "Until there is one, all ticket money goes to the event's organiser. Pick a preset to start.",
      bodyDefault: "New events start from this default. Pick a preset to start.",
    },
    booking: {
      title: "This night's deal lives in its booking",
      body: "The event was booked through a request, so its deal is set on the booking's terms.",
      link: "Open the booking's deal",
    },
    notAllowed: {
      title: "You can't see this deal",
      body: "Only people who manage the money for a party to these terms can see it.",
    },
    readFailed: {
      title: "We couldn't load the deal",
      body: "Something went wrong on our side. Try again.",
    },
    retry: "Try again",
    noTerms: {
      title: "No deal on these terms",
      body: "This agreement was made without payout terms, so there is no deal to show or change here.",
    },
    bill: {
      title: "The bill",
      hint: "From the request. Acts join or pass on their own invite.",
      unavailable: "We couldn't load the bill just now. Reload the page to try again.",
      headlining: "Headlining",
      joined: "Joined",
      invited: "Invited",
      byName: "By name",
      passed: "Passed",
      unnamed: "Unnamed act",
    },
    answers: {
      titleYours: "Your line on these terms",
      hintYours: "You're paid on these terms but aren't one of the two parties, so you answer for your own line: agree, ask for a different share, or decline.",
      titleAsks: "Asked for a different share",
      hintAsks: "A payee asked for a different share. Change their clause in the deal above to answer it.",
    },
    summary: {
      label: "The deal",
      none: "No one is named in the deal yet.",
      rest: "the rest of the pool",
      offTheTop: "Off the top: {list}",
      cost: "{label} {amount}",
      costEstimated: "{label} about {amount}",
    },
    splits: {
      linesToggle: "Payout lines",
      linesHint: "The same terms, one line per payee paid as tickets sell. A change here shows in the deal above.",
      linesChanged: "These lines changed somewhere else while you were editing them. Saving yours replaces that change.",
      payeeUnknown: "One of these lines has a payee we can't find, so the lines can't be saved. Remove that line and add the person or group again.",
      payeeUnknownTitle: "A payee can't be found",
      payeeNotFound: "Payee not found",
      saveBlockersTitle: "Before you can save",
      linesReload: "Load the saved lines",
    },
    notEditable: {
      notPayoutEditor: "You can see this deal but not change it. People who manage payouts can.",
      bookingNotEditable: "This deal can't be changed here: the terms have been sent or agreed, or the other side sets them.",
      termsIsDefault: "This event is paid out under a default agreement, so changing it here would change other events too.",
      eventArchived: "This event is archived, so its deal can't change.",
      eventCancelled: "This event is cancelled, so its deal can't change.",
      eventTermsShared: "These terms are shared with another event, so changing them here would change that event's money too.",
      orgInactive: "This group isn't active, so its default can't change.",
      defaultTermsShared: "This default is also used elsewhere, so changing it here would change that too.",
    },
    errors: {
      changed: "This deal changed since you opened it. The latest version is loaded; check it and make your change again.",
      capsUnsatisfiable: "This deal would leave part of every order unpaid: the caps on the lines paid as tickets sell can't reach 100%. Raise or remove a cap in the payout lines first.",
      scopedPerOrderLine: "A payee here is paid on one ticket type only. Change that line in the payout lines first, then come back to the deal.",
      remainderNotOwner: "The rest has to go to the event's organiser, who owes any shortfall.",
      notEditable: "This deal can't be changed right now.",
      finalized: "These terms are final, so the deal can't change here.",
      payeeNotReady: "Payouts aren't set up here yet. Set them up, then save the deal.",
      amountInvalid: "Enter an amount, like 800 or 800.50.",
      percentInvalid: "Enter a whole percentage from 0 to 100.",
      labelRequired: "Name the cost.",
      pickAct: "Choose the act.",
      pickPlace: "Choose the place.",
      pickRest: "Choose who takes the rest.",
      sameAsRest: "The act can't also take the rest.",
      percentOver100: "Percentages on this deal add up to more than 100% of what they're taken from.",
      perOrderPercentOver100: "The lines paid as tickets sell add up to more than 100% of ticket money.",
      clauseZeroPercent: "A line paid as tickets sell needs a percentage above 0%.",
      duplicatePerOrderPayee: "A payee can have only one line paid as tickets sell. Put their share in one percentage.",
      remainderNotAParty: "The rest has to go to one of the two parties, who owes any shortfall.",
      remainderNotTheOrg: "On a default deal, the rest has to go to the group the default belongs to.",
      rentalRestIsRenter: "On a room rental, the rest goes to the renter.",
      guaranteeTooLarge: "The fixed amounts for the act add up to more than a guarantee can hold. Lower them.",
    },
    resale: {
      title: "Resale",
      limit: "At most 10% of each sale",
      tag: "Via Ithas Fire",
      sentencePercent: "Every time a ticket is resold, {percent}% of the sale price goes to the people who put on the night.",
      sentenceFlat: "Every time a ticket is resold, {amount} goes to the people who put on the night, never more than 10% of the sale price.",
      sentenceSeller: "The seller pays it from what they receive. This applies on every resale, however many times the ticket changes hands.",
      sentenceBuyer: "It is added to what the buyer pays. This applies on every resale, however many times the ticket changes hands.",
      notSetEvent: "Not set yet. Resale can't be turned on for this event until a share is set. 0% is a fine answer.",
      notSetDefault: "Not set yet. Resale stays off on new events until you set a share. 0% is a fine answer.",
      notSetReadOnly: "Not set yet.",
      type: "The share",
      typePercent: "Percent",
      typeFlat: "Flat",
      amount: "Amount",
      amountPercentLabel: "in percent",
      amountFlatLabel: "in dollars",
      percentHint: "A percentage of the sale price, 0 to 10.",
      flatHint: "Dollars per resale, held to 10% of the sale price on a cheaper sale.",
      payer: "Who pays it",
      payerSeller: "Seller",
      payerBuyer: "Buyer",
      payerHint: "Seller: taken from what they receive. Buyer: added on top of the price.",
      recipients: "Who gets it",
      changeRecipients: "Change who gets it",
      changeBlocked: "Save or undo the share first, then change who gets it.",
      noRecipients: "Nobody receives resale money yet. Choose who does, then set the share.",
      noRecipientsReadOnly: "Nobody receives resale money yet.",
      noRecipientsBooking: "Nobody receives resale money yet. Who gets it is chosen on the event's edit page, under Revenue splits, on the Resale tab. The share can be set here after that.",
      lines: {
        caption: "The people listed share all of the resale share. Each gets their percentage, and anything left over is split evenly between them. The organiser gets a part only if listed here.",
        empty: "Nobody receives resale money yet. Add who should get the share below.",
        ownerSource: "Organiser",
        overTotal: "These lines add up to {total}. Together they can take at most 100% of the resale share, so lower one or more before saving.",
      },
      oneTicketType: "One ticket type",
      percentOfShare: "{percent}% of the share",
      portionAll: "All of the share",
      portionVaries: "Depends on the ticket type",
      exampleKicker: "Example · a ticket first sold at {original}, resold for {ask}",
      buyerPays: "The buyer pays",
      buyerPaysHint: "Plus processing and tax",
      sellerReceives: "The seller receives",
      toTheNight: "To the people who put on the night",
      heldNote: "The flat amount is held to 10% of this sale.",
      platform: "Ithas Fire",
      platformHint: "Ithas Fire takes nothing on a resale",
      firstSale: "Each ticket keeps the resale share recorded when it was first sold. A ticket sold before any share was set takes the share in force when it is first listed for resale.",
      bookingNote: "Part of this booking's terms. The other side sees it before agreeing.",
      save: "Save the resale share",
      reset: "Undo changes",
      clear: "Clear the share",
      clearBlocked: "Resale is on for some ticket types, so the share has to stay set. You can still change it.",
      savedToast: "Resale share saved",
      clearedToast: "Resale share cleared",
      loading: "Loading the resale share",
      readFailed: "The resale share couldn't be loaded.",
      openAgreement: "Open the agreement",
      notEditable: {
        notPayoutEditor: "You can see the resale share but not change it. People who manage payouts can.",
        bookingNotEditable: "The resale share can't be changed here: the terms have been sent or agreed, or the other side sets them.",
        noEventYet: "This booking has no event yet. The resale share can be set once it does.",
        ownedByBooking: "This night's booking is still being agreed, so its resale share is set in the booking's terms.",
        eventArchived: "This event is archived, so its resale share can't change.",
        eventCancelled: "This event is cancelled, so its resale share can't change.",
        termsShared: "These resale terms are shared with another event or default, so changing them here would change that too.",
        termsLocked: "These resale terms can't be changed here.",
      },
      errors: {
        percentInvalid: "Enter a percentage from 0 to 10, like 10 or 7.5.",
        overLimit: "The share can be at most 10% of each sale.",
        flatInvalid: "Enter an amount above $0, like 2 or 2.50.",
        changed: "The resale share changed since you opened it. The latest is loaded; check it and save again.",
        missingLines: "Choose who gets resale money first, then set the share.",
        inUse: "Resale is on for at least one ticket type, so the share has to stay set. You can still change it.",
        invalid: "That share isn't one we can save. Use 0 to 10%, or an amount above $0.",
      },
    },
    defaultAgreement: {
      lede: "New events start from these terms. Change them on any event under Revenue splits. A booked night uses the terms both sides agreed.",
      releaseTitle: "When resale sellers are paid",
      releaseLabel: "Days after the event",
      releaseHint: "Never less than {days}, so a buyer can file a claim first.",
      releasePlatformDefault: "Using the platform default of {days} days.",
      releaseInvalid: "Enter a whole number of days from {min} to 365.",
      save: "Save",
      reset: "Undo changes",
      savedToast: "Payout timing saved",
      saveFailed: "Couldn't save payout timing",
      readFailed: "The default agreement couldn't be loaded.",
    },
    freeze: {
      action: "Freeze the deal",
      notice: "The deal freezes on its own when you publish. Freeze it sooner once everyone has agreed.",
      frozenToast: "The deal is frozen",
      frozen: "Frozen",
      frozenSince: "Frozen since {date}",
      frozenSinceAuto: "Frozen automatically since {date}",
      frozenSinceBy: "Frozen since {date}, by {name}",
      frozenBody: "Changing it now tells {names} what changed.",
      frozenBodyNobody: "Nobody else is on the deal, so a change tells nobody.",
      frozenReadOnly: "Any change to it is listed on this page, and everyone on the deal is told.",
      change: "Change the frozen terms",
      changingTitle: "Changing the frozen terms",
      changingBody: "Nothing changes until you save. Then the deal freezes again and everyone on it is told.",
      notSaved: "Not saved",
      removed: "Taken off the deal",
      restWas: "The rest went to {name}",
      footerNone: "No changes yet.",
      footerNoneHint: "Edit a line above. Nothing is sent until you save.",
      footerOne: "1 change.",
      footerMany: "{count} changes.",
      footerTells: "Saving tells {names}, by email and in Ithas Fire, with each line before and after.",
      footerTellsNobody: "Nobody else is on the deal, so saving tells nobody.",
      save: "Save and tell them",
      discard: "Discard changes",
      savedToast: "Saved. Everyone on the deal has been told.",
      savedToastNobody: "Saved. Nobody else is on the deal, so nobody was told.",
      savedNothingToast: "Nothing changed, so nobody was told.",
      changedUnder: "Someone else changed this deal while you were editing. Your edits stay, over their version.",
      changedUnderDroppedOne: "Someone else changed this deal while you were editing and took off a line you had edited. That edit is dropped; your other edits stay.",
      changedUnderDroppedMany: "Someone else changed this deal while you were editing and took off {count} lines you had edited. Those edits are dropped; your other edits stay.",
      frozeUnder: "This deal froze while you had it open, so your change wasn't saved. Use Change the frozen terms to make it; everyone on the deal is told.",
      resaleFailedAfterTerms: "The ticket-sale changes are saved and everyone on the deal was told. The resale share wasn't saved: {reason}",
      linesTitle: "The deal is frozen",
      linesBody: "These lines are part of the frozen deal. To change them, use Change the frozen terms above.",
      finalizeTitle: "This event's deal is frozen",
      finalizeBody: "Finalizing puts this agreement's terms on it. Everyone on the deal, before and after, is told by email and in Ithas Fire, with each line before and after.",
      finalizeNames: "From this agreement: {names}.",
      finalizeConfirm: "Finalize and tell them",
    },
    history: {
      title: "Changes since it froze",
      hint: "Everyone on the deal sees this list, including anyone a change took off it.",
      by: "{when} · {name}",
      someone: "Someone",
      frozenAuto: "{when} · Frozen automatically",
      frozenBy: "{when} · Frozen by {name}",
      noLines: "No line's share changed.",
      resaleNote: "Tickets already sold keep the resale share they were sold with. A change to the resale share applies to tickets sold after it.",
      older: "Show older changes",
      loading: "Loading changes",
      failed: "These changes couldn't be loaded.",
      before: "Before:",
      after: "Now:",
    },
    page: {
      loading: "Loading the deal",
      kicker: "The deal",
      notAllowedTitle: "This deal isn't yours to see",
      notAllowedBody: "Only the people on an event's deal, and the people who manage it, can see it and its changes.",
      notFoundTitle: "We couldn't find this event",
      notFoundBody: "It may have been deleted, or the link is incomplete.",
      failedTitle: "The deal couldn't be loaded",
      failedBody: "Try again in a moment.",
      signInTitle: "Sign in to see this deal",
      signIn: "Sign in",
      frozenBody: "Every change to it since is listed below, with each line before and after.",
      notFrozen: "This deal isn't frozen yet. It freezes when tickets go on sale; after that, every change to it is listed here.",
      nowTitle: "The deal now",
      nowHint: "This part shows the lines that concern you. The organiser sees the whole deal.",
      noChanges: "Nothing has changed since the deal froze.",
    },
  },
  // EmailVerificationRequired (B2, owner ruling 2026-10-16): an unverified
  // account sees none of the orders, tickets or seats attached to its email.
  emailGate: {
    ticketsTitle: "Verify your email to see your tickets",
    ticketsBody:
      "Tickets bought with {email} show here once you verify. The ones in your inbox still work at the door.",
    orderTitle: "Verify your email to see this order",
    orderBody:
      "Its tickets are in the inbox for {email} and still work at the door.",
    printTicketsTitle: "Verify your email to print your tickets",
    printTicketsBody:
      "They are in the inbox for {email} and still work at the door.",
    resaleTitle: "Verify your email to buy this ticket",
    resaleBody: "We'll send a 6-digit code to {email}.",
    creditsTitle: "Verify your email to see your credits",
    creditsBody: "Credits from orders on {email} show here after that.",
    reviewTitle: "Verify your email to review this night",
    reviewBody: "Reviews come from tickets bought with {email}.",
    genericTitle: "Verify your email to continue",
    genericBody:
      "Orders, tickets and listings under {email} stay hidden until you verify it.",
    coordinatorTitle: "Verify your email to coordinate",
    coordinatorBody: "Your groups open once you verify {email}.",
    lineupsTitle: "Verify your email to see your lineups",
    lineupsBody: "Lineups you're on show here once you verify {email}.",
    yourEmail: "your email",
    send: "Email me a code",
    sending: "Sending\u2026",
    enterCode: "Enter code",
    stepName: "Verify email",
    changeBlockedSent: "Verify {email} before you change it.",
    changeBlocked: "Verify your current email before you change it.",
    changeBlockedCard:
      "Enter the code we sent to {email} first. Then you can change it.",
  },
  // Page titles, descriptions and JSON-LD crumbs of the pages with a Spanish
  // twin (home, category, category in a city, about, contact). Read on the
  // server by `generateMetadata` (i18n/server-translator.ts).
  publicSeo: {
    homeDescription:
      "Discover, promote, and sell tickets for unforgettable events.",
    homeSocialDescription: "Built for communities.",
    ogImageAlt: "Ithas Fire — Built for communities",
    aboutTitle: "About",
    aboutDescription: "Learn more about Ithas Fire and our mission.",
    contactTitle: "Contact",
    contactDescription: "Get in touch with the Ithas Fire team.",
    notFoundTitle: "Not found",
    categoryDescription: "Find upcoming {category} near you.",
    cityTitle: "{category} in {city}",
    cityDescriptionOne:
      "Discover 1 upcoming {category} event in {city} — find the date, place, and how to attend.",
    cityDescriptionMany:
      "Discover {count} upcoming {category} events in {city} — find dates, places, and how to attend.",
    cityDescriptionNone:
      "No upcoming {category} in {city} yet — check back soon or explore nearby events.",
    crumbHome: "Home",
    crumbEvents: "Events",
  },
};

export default enMessages;
