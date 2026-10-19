/**
 * Canonical error-code contract for the Ithas Fire monorepo.
 *
 * All {@link AppErrorCode} values are SCREAMING_SNAKE (e.g. `EVENT_NOT_FOUND`).
 * {@link toKey} maps a code to its camelCase `errors.*` i18n key; the catalogs
 * are keyed by the camelCase form (e.g. `errors.eventNotFound`).
 * {@link fromLegacyCode} normalizes a legacy snake_case domain code (the form
 * carried in the message of a legacy `{ code, message }` throw) up to a
 * canonical `AppErrorCode` by direct union membership.
 *
 * This is the FULL registry produced by the error-code-registry-and-dedup P2
 * build (docs/specs/2026-06-23/error-code-map.ts is the source of truth, signed
 * off 2026-06-23). Codes are TIERED:
 *   - {@link USER_FACING_CODES} — end users can act on these; each MUST have an
 *     `errors.<key>` entry in en AND es (enforced by the i18n parity test in
 *     apps/web/src/i18n/__tests__/error-code-parity.test.ts).
 *   - {@link INTERNAL_CODES} — infra/dependency/invariant failures the user
 *     cannot act on; typed + enumerable but i18n-EXEMPT (and asserted ABSENT
 *     from the catalog so they can never leak user copy).
 *
 * Drift is a COMPILE error in three directions (see the guards below): an array
 * entry not in the union, a union member missing from the array, and a union
 * member that is in neither tier subset.
 */
export type AppErrorCode =
  // ═══════════════ USER-FACING (parity-gated en+es copy) ═══════════════
  // ── P4b (deal terms) ── deal terms and the settlement sheet
  | "DEAL_REMAINDER_UNRESOLVED"
  /**
   * freeze-the-deal FR-004: the event's deal is frozen (first publish, or the
   * organiser froze it). A change must be sent as a frozen change
   * (`frozenChange: true`), which every payee is told about.
   */
  | "DEAL_FROZEN"
  | "SETTLEMENT_SHEET_SETTLED"
  | "SETTLEMENT_SHEET_NOT_SETTLED"
  | "SETTLEMENT_EVENT_NOT_ENDED"
  | "SETTLEMENT_SHEET_INCOMPLETE"
  | "SETTLEMENT_EVENT_NOT_PUBLISHED"
  | "PAYOUT_LINES_TOTAL_INVALID"
  | "SETTLEMENT_ENTRY_NOT_FOUND"
  // ── agreements ──
  | "AGREEMENT_NOT_EDITABLE"
  | "AGREEMENT_PERCENT_TOTAL_EXCEEDED"
  | "ANOTHER_ACTIVE_AGREEMENT_EXISTS"
  | "CANNOT_READ_OTHER_HUMAN_DEFAULTS"
  | "CANNOT_SET_DEFAULTS_FOR_ANOTHER_HUMAN"
  | "DUPLICATE_PAYEE"
  | "EVENT_ARCHIVED"
  | "FEE_POLICY_NOT_ACTIVE"
  | "FEE_POLICY_NOT_FOUND"
  | "FEE_POLICY_OUT_OF_SCOPE"
  | "HUMAN_MISMATCH"
  | "INSUFFICIENT_ROLE"
  | "INVALID_LINE_REFERENCE"
  | "MULTIPLE_ACTIVE_AGREEMENTS"
  | "NO_PAYOUT_TERMS_CONFIGURED"
  | "ORGANIZATION_INACTIVE"
  | "ORGANIZATION_NOT_FOUND"
  | "PAYEE_ALREADY_ASSIGNED"
  | "PAYEE_CHANGE_NOT_ALLOWED"
  | "PAYEE_NOT_ACTIVE"
  | "PAYOUT_TERMS_NOT_FOUND"
  // ── announcements ──
  | "ACTOR_EMAIL_NOT_FOUND"
  | "INVALID_UNSUBSCRIBE_TOKEN"
  // ── api-keys ──
  | "API_KEY_ALREADY_REVOKED"
  | "API_KEY_NOT_FOUND"
  // ── auth ──
  | "EMAIL_NOT_VERIFIED"
  | "USER_ALREADY_EXISTS"
  // ── booking-agreements ──
  | "ACT_RESPONSE_ONLY"
  | "AGREEMENT_FINALIZED"
  | "AGREEMENT_LINE_NOT_FOUND"
  | "AGREEMENT_LINKED_TO_OTHER_EVENT"
  | "AGREEMENT_MISSING_PAYOUT_TERMS"
  | "AGREEMENT_NOT_ACCEPTED"
  | "AGREEMENT_NOT_CANCELLABLE"
  | "AGREEMENT_NOT_DRAFT"
  | "AGREEMENT_NOT_FOUND"
  | "AGREEMENT_NOT_PROPOSED"
  | "EVENT_ALREADY_HAS_AGREEMENT"
  | "INVALID_STATUS"
  | "LINES_UNCONFIRMED"
  | "NOT_AGREEMENT_PARTY"
  | "PAYEE_NOT_READY"
  | "PROPOSED_END_BEFORE_START"
  | "TERMS_EDITOR_ONLY"
  // ── booking-requests ──
  | "BOOKING_DATE_UNAVAILABLE"
  | "BOOKING_REQUEST_EXPIRED"
  | "BOOKING_REQUEST_NOT_FOUND"
  | "BOOKING_REQUEST_NOT_PENDING"
  | "CANNOT_BOOK_OWN_ACT"
  | "DUPLICATE_OPEN_REQUEST"
  | "PERFORMER_MODE_REQUIRED"
  | "PERFORMER_NOT_ACCEPTING_REQUESTS"
  | "PLACE_ID_REQUIRED"
  | "PLACE_NOT_ACCEPTING_REQUESTS"
  | "PLACE_NOT_VERIFIED"
  // ── P3a (unclaimed venues) ── amendment 2026-09-25: an unclaimed place
  // takes no booking requests. Copy takes no arguments; the place rides meta.
  | "PLACE_NOT_TAKING_REQUESTS"
  // lineup-booking-requests v2 (spec 2026-09-25) — the bill
  | "BILL_NOT_ALLOWED"
  | "ACT_NOT_TAGGABLE"
  | "ACT_ALREADY_DECLINED"
  // lineup-booking-requests v3 — the bill is fixed once the event exists
  | "BILL_LOCKED"
  // ── booking-holds (spec 2026-08-25) ──
  | "BOOKING_HOLD_NOT_FOUND"
  | "HOLD_ALREADY_PLACED"
  | "HOLD_LINE_ALREADY_CONFIRMED"
  | "BOOKING_HOLD_NOT_LIVE"
  | "BOOKING_HOLD_NOT_FIRST"
  | "BOOKING_HOLD_CHALLENGE_OPEN"
  | "BOOKING_HOLD_NOT_CHALLENGED"
  | "BOOKING_HOLD_CHALLENGE_LAPSED"
  | "BOOKING_HOLDS_VENUE_ONLY"
  /**
   * holds-without-a-request FR-001: the action exists only for a hold placed
   * for a booking request (it agrees terms, writes the request's thread, or
   * answers as the act), and this hold is an outside booker's or the
   * place's own. INTERNAL until a surface can reach it (plan steps 6–9
   * build the request-less actions and their copy).
   */
  | "BOOKING_HOLD_NEEDS_REQUEST"
  /**
   * holds-without-a-request FR-005 (plan item f): the holder (a booker, or
   * the party a place hold names) already has a live hold in this line —
   * the per-holder partial uniques. One hold per holder per night.
   */
  | "BOOKING_HOLD_HOLDER_EXISTS"
  /**
   * holds-without-a-request H13 / NFR-005: a challenge on a booker's or the
   * place's own hold is answered by booking it or releasing it; there is no
   * bare "keep".
   */
  | "CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE"
  /**
   * holds-without-a-request FR-003 (the booking grant lifecycle). INTERNAL
   * until plan step 9 builds the `placeBookingGrants.*` surface and its copy:
   *  - NOT_FOUND: no such grant at this place, or not one the actor may
   *    answer (another party's grant reads the same as a missing one);
   *  - NOT_PENDING: answered the other way already (accept after decline);
   *  - ENDED: revoked, declined or expired (`meta.reason`), so it cannot be
   *    answered or edited; give a new one;
   *  - EXISTS: the grantee already holds a pending or active grant covering
   *    this scope (`meta.grantId`): edit that one instead;
   *  - GRANTEE_INVALID: not an org or a person, the place's own owner or
   *    owning org, or the giver themself (`meta.reason`);
   *  - SCOPE_HAS_HOLDS: narrowing to one calendar would strand the booker's
   *    live holds on others (`meta.holdCount`): release them or revoke.
   */
  | "PLACE_BOOKING_GRANT_NOT_FOUND"
  | "PLACE_BOOKING_GRANT_NOT_PENDING"
  | "PLACE_BOOKING_GRANT_ENDED"
  | "PLACE_BOOKING_GRANT_EXISTS"
  | "PLACE_BOOKING_GRANT_GRANTEE_INVALID"
  | "PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS"
  | "HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST"
  | "HOLD_LINE_HAS_OPEN_CHALLENGE"
  | "HOLD_LINE_CHANGED"
  | "HOLD_DATE_MISMATCHES_EVENT"
  | "BOOKING_TERMS_NOT_FINALIZED"
  | "BOOKING_TAG_NOT_FOUND"
  | "BOOKING_TAG_SLUG_TAKEN"
  | "BOOKING_ASSIGNEE_NOT_ELIGIBLE"
  | "BOOKING_ASSIGNMENT_NOT_APPLICABLE"
  // venue-booking-standards (spec 2026-09-25) — unmet REQUIRED pitch items
  | "STANDARDS_UNMET"
  // booking-the-night (spec 2026-09-25) — agree & book, book without terms,
  // cancel booking
  // NIGHT_TAKEN is venue-side only; its meta names another party's hold — the
  // sender's agree path uses NIGHT_NO_LONGER_AVAILABLE.
  | "NIGHT_TAKEN"
  | "NIGHT_NO_LONGER_AVAILABLE"
  | "DATE_NOT_ASKED_FOR"
  | "HOLD_CONFIRM_RETIRED"
  | "NO_ACT_READY"
  | "VENUE_CONFIRMATION_NOT_FOR_REQUESTS"
  | "BOOKING_NOT_CANCELLABLE"
  // P2b review: one booked night per request; terms out for another night;
  // terms that moved after the sender opened them (sender-side, no meta).
  | "BOOKING_ALREADY_HAS_NIGHT"
  | "TERMS_SENT_FOR_ANOTHER_NIGHT"
  | "TERMS_CHANGED_SINCE_VIEWED"
  // Sender side, no meta: the booking's event is on another day than the
  // terms' night (the venue is told; its twin is HOLD_DATE_MISMATCHES_EVENT).
  | "EVENT_ON_ANOTHER_NIGHT"
  // Sender side, no meta: an event-first booking whose origin event was
  // cancelled / archived / deleted (owner ruling 2026-10-01, spec N11).
  | "EVENT_FIRST_ORIGIN_GONE"
  // Sender side, no meta: the event the request's terms were finalized
  // against was cancelled or archived (spec N11, review round 4 W1).
  | "LINKED_EVENT_NOT_LIVE"
  // Sender side, no meta: the place is suspended or retired, so no night
  // there is booked (review round 4 BLOCKING / W4).
  | "PLACE_NOT_TAKING_BOOKINGS"
  // Venue side: book without terms while terms for another night are agreed.
  | "TERMS_AGREED_FOR_ANOTHER_NIGHT"
  // booking-the-night P2c (FR-009 / FR-010 / review carry d):
  // the request's booking was cancelled — it takes no new holds and is never
  // booked again (no meta, either side);
  | "BOOKING_CANCELLED"
  // withdraw / close request refused: the night is booked — undo it with
  // Cancel booking (no meta, either side);
  | "BOOKING_NIGHT_BOOKED"
  // venue side: the booking's event sits on another calendar than the line
  // being booked (the sender's twin is EVENT_ON_ANOTHER_NIGHT, no meta).
  | "EVENT_ON_ANOTHER_CALENDAR"
  // booking-the-night P2c (review round 2): the booking is linked to more than
  // one live event (venue side carries the ids; the sender's is bare);
  | "BOOKING_HAS_MULTIPLE_EVENTS"
  // an event-first request's terms finalize only against its own event
  // (venue side carries the ids; the sender's is bare).
  | "EVENT_FIRST_REQUIRES_ORIGIN_EVENT"
  // the event belongs to neither the venue side nor the sender pair: a
  // request's terms never link a third party's event (venue side carries the
  // ids; the sender's is bare).
  | "EVENT_OWNER_NOT_BOOKING_PARTY"
  // ── booking-the-night P2d-1 (saved reasons) ──
  // FR-013: a list holds at most 30 saved reasons; the snippet is gone
  // (or another owner's); the list changed under a reorder (stale client).
  | "SAVED_SNIPPET_LIMIT_REACHED"
  | "SAVED_SNIPPET_NOT_FOUND"
  | "SAVED_SNIPPET_ORDER_CHANGED"
  // ── booking-the-night P2d-2 ──
  // The 1st-hold request already agreed terms for that night: the venue books
  // it (Create event); there is nothing to challenge or keep.
  | "TERMS_AGREED_FOR_THIS_NIGHT"
  // ── P3b (asks) ── venue-booking-standards v1.1 FR-009: the ask is gone
  // (or another request's). Every other ask refusal reuses INVALID_STATUS.
  | "BOOKING_ASK_NOT_FOUND"
  // ── categories ──
  | "CATEGORY_ALREADY_EXISTS"
  // category-translations FR-007: approving a request made in another
  // language needs the English name staff chose (it is the slug source).
  | "CATEGORY_ENGLISH_NAME_REQUIRED"
  | "CATEGORY_INACTIVE"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_REQUEST_ALREADY_REVIEWED"
  | "CATEGORY_REQUEST_NOT_FOUND"
  // spanish-seo FR-009: another category holds that URL slug in that
  // language, as its current slug or an old one that still redirects.
  | "CATEGORY_SLUG_TAKEN"
  | "INVALID_CATEGORY_REQUEST_NAME"
  // spanish-seo FR-009: a staff-entered URL slug breaks the slug rules.
  | "INVALID_CATEGORY_SLUG"
  // ── comms ──
  | "ACTOR_MISMATCH"
  | "CHANNEL_INELIGIBLE"
  | "CONTACT_MUST_HAVE_EMAIL_OR_PHONE"
  | "CROSS_OWNER_MERGE_NOT_ALLOWED"
  | "EVENT_NOT_COMPLETED"
  | "IMPORT_ALREADY_COMPLETED"
  | "IMPORT_NOT_FOUND"
  | "IMPORT_OWNER_MISMATCH"
  | "INVALID_NOTIFICATION_PAYLOAD"
  | "LIST_OWNER_MISMATCH"
  | "NO_UPDATES_PROVIDED"
  | "PHONE_FORMAT_INVALID"
  | "SOURCE_CANNOT_BE_TARGET"
  | "TARGET_LIST_NAME_REQUIRED_FOR_NEW_LIST"
  | "TARGET_LIST_NOT_FOUND"
  | "TAX_JURISDICTION_UNAVAILABLE"
  | "TAX_JURISDICTION_UNSUPPORTED"
  | "TAX_RATE_UNAVAILABLE"
  /**
   * `setManualEventTaxRate` refused: the event needs no hand-entered rate.
   * `meta.reason`: `"rate_resolved"` (the event already has a looked-up
   * rate); `"no_location"` (nothing to look up, so a lookup can never fail);
   * `"lookup_available"` (the lookup answers right now — `meta.lookedUpRateBps`,
   * null for "no rate here"); `"lookup_not_configured"` (no provider, so no
   * sale is ever refused for a failed lookup); `"location_changed"` (the
   * venue moved during the entry; retry). User-facing (en/es copy landed
   * with the Sell screen's manual-rate dialog, door-sales step 9a).
   */
  | "MANUAL_TAX_RATE_NOT_ALLOWED"
  | "TOKEN_EXPIRED"
  | "TOKEN_HUMAN_MISMATCH"
  | "TOKEN_INVALID"
  | "TOKEN_NOT_SUPPORTED"
  | "TOKEN_SCOPE_MISMATCH"
  | "TRANSACTIONAL_CANNOT_BE_DISABLED"
  | "UNKNOWN_NOTIFICATION_CATEGORY"
  | "UNKNOWN_NOTIFICATION_VARIANT"
  // ── community ──
  | "EDIT_SUGGESTION_ALREADY_REVIEWED"
  | "EDIT_SUGGESTION_INVALID_FIELDS"
  | "EDIT_SUGGESTION_NOT_FOUND"
  | "EVENT_DATE_IN_PAST"
  | "EVENT_DATE_NOT_FOUND"
  | "EVENT_DATE_NOT_RSVPABLE"
  | "EVENT_NOT_COMMUNITY"
  | "EVENT_NOT_TICKETED"
  | "MODERATOR_APPLICATION_ALREADY_PENDING"
  | "MODERATOR_APPLICATION_ALREADY_REVIEWED"
  | "MODERATOR_APPLICATION_NOT_FOUND"
  // A re-expansion would call off nights people have RSVP'd to. Only a HUMAN
  // rule change is allowed to do that (it emails them); the rolling refresh
  // job refuses instead, so a cron top-up can never mail an attendee.
  | "RECURRENCE_DROP_WOULD_CANCEL_RSVPS"
  | "RECURRENCE_HAS_NO_UPCOMING_DATES"
  // ── comp ──
  | "EVENT_CANCELLED"
  // ── credits ──
  | "EXPIRES_AT_IN_PAST"
  // ── delegates ──
  | "CANNOT_DELEGATE_TO_SELF"
  | "DELEGATE_SELF_BENEFIT_FORBIDDEN"
  | "DELEGATION_NOT_FOUND"
  // ── disputes ──
  | "STRIPE_EVENT_CONFLICT"
  // ── embeds ──
  | "DOMAIN_MISMATCH"
  | "EMBED_NOT_FOUND"
  | "SEAT_SECTION_NOT_FOUND"
  | "TURNSTILE_TOKEN_REQUIRED"
  | "TURNSTILE_VERIFICATION_FAILED"
  | "UNSUPPORTED_SUBJECT_TYPE"
  // ── entity-pages ──
  | "BLOCK_NOT_FOUND"
  | "BLOCK_PINNED"
  | "INVALID_BLOCK_ORDER"
  | "OWNER_NOT_FOUND"
  | "PAGE_IMAGE_KEY_NOT_OWNED"
  | "PAGE_NOT_FOUND"
  | "SLUG_TAKEN"
  | "UNKNOWN_OWNER_TYPE"
  | "UPLOADED_PAGE_IMAGE_NOT_FOUND"
  // ── event-humans ──
  | "EVENT_HUMAN_NOT_FOUND"
  | "HUMAN_ID_OR_EXTERNAL_NAME_REQUIRED"
  // ── event-templates ──
  | "EVENT_NOT_DRAFT"
  | "SAVED_LOCATION_NOT_FOUND"
  | "TEMPLATE_ARCHIVED"
  | "TEMPLATE_INACTIVE"
  | "TEMPLATE_NAME_TAKEN"
  | "TEMPLATE_NOT_FOUND"
  | "UNKNOWN_OWNER_SCOPE"
  // ── events ──
  | "APPLICATION_ALREADY_SUBMITTED"
  | "APPLICATION_ANSWERS_INCOMPLETE"
  | "APPLICATION_CAP_REACHED"
  | "APPLICATION_SUBMISSIONS_EXIST"
  | "APPLICATION_WINDOW_CLOSED"
  | "APPLICATION_WINDOW_NOT_OPEN"
  | "ATTESTATION_INCOMPLETE"
  | "AUDIO_UPLOAD_NOT_FOUND"
  | "CURATED_UNTIL_BEFORE_EVENT"
  | "CURATED_UNTIL_UNAVAILABLE"
  | "EVENT_ALREADY_ARCHIVED"
  | "EVENT_ALREADY_CANCELLED"
  | "EVENT_ALREADY_COMPLETED"
  | "EVENT_ALREADY_ENDED"
  | "EVENT_CATEGORY_MISSING"
  // embed gating (2026-10-12): a PASSWORD/APPLICATION event is never
  // bought or detailed inside the widget — it links out to the event page
  | "EVENT_GATED"
  | "EVENT_HAS_ORDERS_USE_CANCEL_INSTEAD"
  | "EVENT_LOCATION_REQUIRED"
  // place-address-withholding N2: a freeform address that is the saver's
  // own withheld place — pick the place instead (meta: placeId, placeName)
  | "EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE"
  // R3-1: the venue confirmed a start the event no longer has (the
  // organizer moved it after the venue's screen loaded) — reload and re-check
  | "EVENT_MOVED"
  | "EVENT_NOT_APPLICATION_GATED"
  | "EVENT_NOT_ARCHIVABLE"
  | "EVENT_NOT_CANCELLABLE"
  | "EVENT_NOT_COMPLETABLE"
  | "EVENT_NOT_DELETABLE"
  | "EVENT_NOT_DRAFT_USE_CANCEL_INSTEAD"
  | "EVENT_NOT_EDITABLE"
  | "EVENT_NOT_FOUND"
  | "EVENT_NOT_ON_SALE"
  | "EVENT_NOT_PASSWORD_GATED"
  | "EVENT_NOT_PUBLISHABLE"
  | "EVENT_NOT_PUBLISHED"
  | "EVENT_PASSWORD_CHALLENGE_REQUIRED"
  | "EVENT_PASSWORD_INVALID"
  | "EVENT_PASSWORD_MISSING"
  | "EVENT_SLUG_CONFLICT"
  | "EVENT_SLUG_CONTEXT_MISSING"
  | "EVENT_SLUG_MISSING"
  | "EVENT_SLUG_REDIRECT"
  | "EVENT_SLUG_REGENERATION_NOT_ALLOWED"
  | "EVENT_WAS_PUBLISHED"
  | "EXPIRATION_MUST_BE_FUTURE"
  | "FORBIDDEN"
  | "FORM_MISMATCH"
  | "FORM_NOT_FOUND"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "IDEMPOTENCY_LOCK_IN_PROGRESS"
  | "IMAGES_WRONG_EVENT"
  | "IMAGE_NOT_FOUND"
  | "INVALID_TIME_WINDOW"
  | "LINEUP_ROW_ALREADY_REGISTERED"
  | "MAGIC_LINK_ALREADY_REDEEMED"
  | "MAGIC_LINK_EXPIRED"
  | "MAGIC_LINK_NOT_FOUND"
  | "MAGIC_LINK_WRONG_RECIPIENT"
  | "NOT_AUTHORIZED"
  | "NOT_RESOURCE_OWNER"
  | "NO_RANDOM_EVENT_AVAILABLE"
  | "OPTIONS_NOT_ALLOWED"
  | "OPTIONS_REQUIRED"
  | "PASSWORD_REQUIRED"
  | "PLACE_NOT_ACTIVE"
  | "PRIMARY_AGREEMENT_MISSING"
  | "QUESTION_NOT_FOUND"
  | "RESALE_TERMS_MISSING"
  /**
   * organiser-resale-share FR-001: the event's resale share cannot be
   * removed while any of its ticket types allows resale (tickets sold in the
   * gap would record no clause and later pick up a different one).
   */
  | "RESALE_SHARE_IN_USE"
  /**
   * organiser-resale-share: an event's RESALE lines may not add up to more
   * than 100%. Finalize would take the excess back from the lines a cent at a
   * time, so a recipient who agreed to a percentage would be paid less.
   */
  | "RESALE_SPLITS_OVER_TOTAL"
  | "SPLITS_TOTAL_INVALID"
  | "STRIPE_NOT_CONNECTED_OWNER"
  | "SUBMISSION_EVENT_MISMATCH"
  | "SUBMISSION_NOT_FOUND"
  | "SUBMISSION_NOT_REVIEWED"
  | "TICKETS_ALREADY_ISSUED"
  | "TICKET_TYPES_REQUIRED"
  | "TICKET_TYPE_CAPACITY_INVALID"
  | "TICKET_TYPE_EVENT_MISMATCH"
  | "TICKET_TYPE_NOT_FOUND"
  | "TICKET_TYPE_SCOPE_ONLY_VALID_FOR_PRIMARY"
  | "TOKEN_EXPIRATION_IN_PAST"
  | "UPLOAD_NOT_COMPLETE"
  | "WAITLIST_FULL"
  | "WAITLIST_NOT_OPEN"
  | "WAITLIST_PUBLISH_AT_REQUIRED"
  // ── follows ──
  | "FOLLOWS_DISABLED"
  | "FOLLOW_NOT_FOUND"
  | "SELF_FOLLOW_NOT_ALLOWED"
  // ── humans ──
  | "CURRENT_PASSWORD_INVALID"
  | "CURRENT_PASSWORD_REQUIRED"
  /**
   * B2 (owner ruling 2026-10-16): staff force-verify refuses an UNVERIFIED
   * account that holds orders, tickets, a coordinator seat or a lineup link
   * attached by email. The holder proves the inbox by email-code sign-in,
   * which runs the unproven-account sweep.
   */
  | "FORCE_VERIFY_HOLDS_EMAIL_ATTACHED"
  | "HUMAN_NOT_FOUND"
  | "SCANNER_TERMS_VERSION_MISMATCH"
  // ── orders ──
  | "ACTOR_NOT_FOUND"
  | "AGREEMENT_MISSING_LINES"
  | "AMOUNT_MISMATCH"
  | "BUYER_MUST_BE_ACTOR"
  | "CREDIT_BALANCE_CHANGED"
  | "CURRENCY_MISMATCH"
  | "DONATION_AMOUNT_REQUIRED"
  | "DONATION_BELOW_MINIMUM"
  | "DUPLICATE_PROMO"
  | "EVENTS_DIFFERENT_ORG"
  | "EVENTS_DIFFERENT_OWNER"
  | "EVENT_MISMATCH"
  | "EVENT_SALES_CLOSED"
  | "EXPECTED_PAID_ORDER"
  | "EXPECTED_TICKETING_ORDER"
  | "INSUFFICIENT_CAPACITY"
  | "ITEMS_NOT_REFUNDABLE"
  | "NON_POSITIVE_AMOUNT"
  | "NO_ORDERS_TO_MIGRATE"
  | "NO_PAYEE_SUBJECT"
  | "NO_REFUNDABLE_ITEMS"
  | "NO_STRIPE_ACCOUNT"
  | "NO_TICKET_TYPES"
  | "ORDER_ALREADY_REFUNDED"
  | "ORDER_EMPTY"
  | "ORDER_EVENT_MISMATCH"
  | "ORDER_ITEM_NOT_FOUND"
  | "ORDER_NON_REFUNDABLE"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_FREE"
  | "ORDER_NOT_IN_ORG"
  | "ORDER_NOT_OWNED"
  | "ORDER_NOT_PAID"
  | "ORDER_NOT_PENDING"
  | "ORDER_NOT_PROCESSABLE"
  | "ORDER_NOT_REFUNDABLE"
  | "PAYMENT_INTENT_MISMATCH"
  | "PAYMENT_INTENT_ORDER_MISMATCH"
  | "PAYMENT_NOT_SUCCEEDED"
  | "PRIMARY_ORDER_RESALE_LINKED_TRANSFER_REQUIRES_MANUAL_REVIEW"
  | "PROMO_MAX_REDEEMED"
  | "PROMO_MIN_ORDER_NOT_MET"
  | "PROMO_NOT_APPLICABLE"
  | "PROMO_NOT_STACKABLE"
  | "PROMO_REDEEMED_BY_HUMAN"
  | "QTY_EXCEEDS_ORDER"
  | "REFUND_AMOUNT_ZERO"
  | "REFUND_NOT_TERMINAL"
  | "SEAT_ASSIGNMENT_QTY_MISMATCH"
  | "SEAT_DUPLICATE_IN_REQUEST"
  | "SEAT_IDS_DUPLICATE"
  | "SEAT_IDS_INVALID"
  | "SEAT_IDS_NOT_ASSIGNED"
  | "SEAT_IDS_REQUIRED"
  | "SEAT_NOT_FOUND"
  | "SEAT_NOT_IN_ORDER"
  // `setSeatPriceOverrides` refused a seat price: a requested seat's section
  // sells through a pay-what-you-want (ADJUSTABLE) tier (ACTIVE on a published
  // event; any tier on a draft, which publish activates), where the
  // buyer names the price and an override would never be charged
  // (seat-price-overrides spec D-004 / FR-006). `meta.seatSectionIds` and
  // `meta.ticketTypeIds` name the sections and tiers. Clearing is never
  // refused. User-facing: `errors.seatPriceOverrideAdjustableTier` (en + es).
  | "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER"
  // `setSeatPriceOverrides` refused a seat price: a requested seat's section
  // has no fixed-price tier that sells it (same ACTIVE/draft reading as
  // above), so there is nothing for the override to
  // replace and no buyer can be charged it. `meta.seatSectionIds` names the
  // sections. User-facing: `errors.seatPriceOverrideNoFixedTier` (en + es).
  | "SEAT_PRICE_OVERRIDE_NO_FIXED_TIER"
  | "SEAT_SECTION_MISMATCH"
  | "SEAT_TAKEN"
  | "SOURCE_AND_TARGET_MUST_DIFFER"
  | "STRIPE_NOT_CONNECTED"
  | "TARGET_EVENT_NOT_ACTIVE"
  | "TICKETS_MISSING"
  | "TICKET_ITEM_NOT_FOUND"
  | "TICKET_NOT_VALID"
  | "TICKET_TYPE_NOT_SEATED"
  | "WAIVER_REQUIRED"
  // ── orgs ──
  | "ALREADY_A_MEMBER"
  | "CANNOT_DEMOTE_LAST_OWNER"
  | "CANNOT_REMOVE_LAST_OWNER"
  | "INVITATION_EXPIRED"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_NOT_PENDING"
  | "MEMBER_NOT_FOUND"
  | "MEMBERSHIPS_SUSPENDED"
  | "MEMBERSHIP_NOT_FOUND"
  // Promoted from internal by the admin memberships UI (2026-08-10): the tier
  // editor surfaces price/tax-category locks and benefit removal inline, so
  // these need real archive-and-replace copy instead of a generic fallback.
  | "MEMBERSHIP_BENEFIT_INVALID_TERMS"
  | "MEMBERSHIP_BENEFIT_NOT_FOUND"
  | "MEMBERSHIP_TIER_ARCHIVED"
  | "MEMBERSHIP_TIER_NOT_ACTIVE"
  | "MEMBERSHIP_TIER_NOT_FOUND"
  | "MEMBERSHIP_TIER_PRICE_LOCKED"
  | "ORG_ALREADY_ARCHIVED"
  | "ORG_HAS_ACTIVE_EVENTS"
  | "ORG_NOT_FOUND"
  // ── payout-terms ──
  | "COUNTER_FIELDS_REQUIRED"
  | "LINE_DECLINED"
  | "LINE_DOES_NOT_REQUIRE_CONFIRMATION"
  | "LINE_NOT_COUNTERABLE"
  | "LINE_NOT_DECLINABLE"
  | "PAYEE_NOT_FOUND"
  | "PAYOUT_LINE_NOT_FOUND"
  // ── payouts ──
  | "SCHEDULED_FOR_IN_PAST"
  // ── place-layouts ──
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "PLACE_LAYOUT_EMPTY"
  | "PLACE_LAYOUT_NOT_FOUND"
  | "SEAT_IDS_NOT_UNIQUE"
  // ── place-reviews ──
  // The place turned performer reviews off (venue-track-record-and-review-switch
  // FR-002); submissions and review sessions are refused before any write.
  | "PLACE_COMMUNITY_REVIEWS_DISABLED"
  // Unused since 2026-07-14 (getPlacePublicStats now serves snapshot-or-null
  // instead of throwing); remove in the error-contract cleanup.
  | "PLACE_STATS_NOT_FOUND"
  | "REVIEW_ALREADY_FLAGGED"
  | "REVIEW_ALREADY_HIDDEN"
  | "REVIEW_ALREADY_RESPONDED"
  | "REVIEW_NOT_FOUND"
  | "REVIEW_NOT_HIDDEN"
  // ── places ──
  | "AVAILABILITY_NOT_FOUND"
  // ── places: venue hierarchy (docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml)
  // Promoted INTERNAL → USER_FACING in Step 6 (management transport + UI).
  // SPACE/CALENDAR "not found" deliberately also covers a cross-place id — a
  // foreign row must be indistinguishable from a missing one (IDOR posture).
  //
  // The two ACTIVE-space codes carry the owner ruling of 2026-09-23: a
  // calendar must always have at least one ACTIVE space, at every layer.
  // CALENDAR_REQUIRES_ACTIVE_SPACE refuses a create/assign whose whole set is
  // retired; CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR refuses a retirement
  // that would strand a calendar, and names the calendars in its `meta`.
  | "CALENDAR_NOT_FOUND"
  | "CALENDAR_REQUIRES_ACTIVE_SPACE"
  | "CALENDAR_SLUG_TAKEN"
  | "CANNOT_RETIRE_LAST_ACTIVE_SPACE"
  | "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR"
  | "SPACE_NOT_FOUND"
  // ── places: claim venue (claim-venue-flow spec) ──
  | "PLACE_ALREADY_CLAIMED"
  | "PLACE_NOT_CLAIMABLE"
  | "CLAIM_ALREADY_PENDING"
  | "CLAIM_LIMIT_REACHED"
  | "CLAIM_PROOF_REQUIRED"
  | "CLAIM_EMAIL_DOMAIN_MISMATCH"
  | "CLAIM_FREE_EMAIL_NOT_ALLOWED"
  | "CLAIM_PLACE_HAS_NO_WEBSITE"
  | "CLAIM_CHALLENGE_NOT_FOUND"
  | "CLAIM_CHALLENGE_EXPIRED"
  | "CLAIM_CHALLENGE_LOCKED"
  | "CLAIM_CHALLENGE_CODE_INVALID"
  | "CLAIM_CHALLENGE_NOT_VERIFIED"
  | "CLAIM_DISPUTE_NOT_APPLICABLE"
  | "DOCUMENTS_REQUIRED"
  | "DOCUMENT_DELETED"
  | "DOCUMENT_NOT_FOUND"
  | "NOT_LOCK_HOLDER"
  /**
   * createCommunityPlace: an ACTIVE, address-public place with the same name
   * already sits within 50 m (or at the same address). `meta.existingPlace`
   * carries it so the form can offer it instead of a duplicate.
   */
  | "PLACE_ALREADY_EXISTS"
  | "PLACE_ARCHIVED"
  /**
   * updateCommunityPlace / archiveCommunityPlace / restoreCommunityPlace: a
   * moderator may not change this place. `meta.reason`: "OWNED" (a verified
   * owner), "CLAIM_PENDING" (a claim in review) or "OWNED_EVENTS_AT_PLACE"
   * (an organiser's live event uses it).
   */
  | "PLACE_HAS_OWNER"
  /**
   * archiveCommunityPlace: published community listings that have not ended
   * still use the place. `meta.reason` "LINKED_LISTINGS",
   * `meta.linkedListingCount`.
   */
  | "PLACE_HAS_LIVE_LISTINGS"
  /**
   * submitPlaceVerification: the place is already VERIFIED (by staff or a
   * claim), so an org-submitted request would only demote it.
   */
  | "PLACE_ALREADY_VERIFIED"
  | "PLACE_NOT_ELIGIBLE_FOR_VERIFICATION"
  | "PLACE_NOT_FOUND"
  | "REUSE_SOURCE_NOT_OWNED"
  | "REUSE_SOURCE_STILL_ACTIVE"
  | "TOO_MANY_DOCUMENTS"
  /**
   * submitPlaceVerification: the place is already PENDING (a claim or another
   * request is in review).
   */
  | "VERIFICATION_ALREADY_PENDING"
  | "VERIFICATION_LOCKED_TO_OTHER_REVIEWER"
  | "VERIFICATION_NOT_IN_REVIEW"
  | "VERIFICATION_NOT_PENDING"
  | "VERIFICATION_REQUEST_ALREADY_DECIDED"
  | "VERIFICATION_REQUEST_IN_PROGRESS"
  | "VERIFICATION_REQUEST_NOT_FOUND"
  | "VERIFICATION_REQUIRES_ORG_OWNER"
  | "WAIVER_NOT_FOUND"
  // ── platform ──
  | "CANNOT_CHANGE_OWN_STATUS"
  | "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY"
  | "CANNOT_DELETE_BUILTIN_PRESET"
  | "CANNOT_DELETE_OWN_ACCOUNT"
  | "CANNOT_DELETE_SOLE_ORG_OWNER"
  | "CANNOT_OVERWRITE_BUILTIN_PRESET"
  | "CONFIRMATION_PHRASE_MISMATCH"
  | "FEATURED_ITEM_TARGET_NOT_FOUND"
  | "FEATURED_ITEM_TARGET_NOT_PUBLIC"
  | "PRESET_NOT_FOUND"
  | "STAFF_ONLY"
  // ── pos ──
  | "AMOUNT_MUST_BE_POSITIVE"
  /**
   * A door cash sale whose typed amount is below the computed total (spec
   * 2026-10-07 door-sales FR-003, owner ruling R4). `meta.requiredTotalCents`
   * carries the total in cents (plus `amountCollectedCents`, `shortByCents`,
   * `currency`) so the till can say how much to collect. User-facing (en/es
   * copy landed with the web Sell screen's quote, door-sales step 9a).
   */
  | "CASH_AMOUNT_SHORT"
  /**
   * An Owner/Admin/Editor refund of a door cash sale more than 7 days after
   * the event ended (owner ruling 2026-10-07). `meta.windowClosedAt` carries
   * the instant the window closed. Platform admins are not bound by it.
   * User-facing (en/es copy landed with door-sales step 9b: shown on the
   * Sell screen's cash-sales list and the org Orders panel's "Refund cash
   * sale").
   */
  | "CASH_REFUND_WINDOW_CLOSED"
  | "EVENT_NOT_ORG_OWNED"
  | "GATE_REFUND_WINDOW_EXPIRED"
  | "NOT_A_CASH_ORDER"
  | "NOT_A_POS_CARD_ORDER"
  | "NOT_A_POS_ORDER"
  | "PAYEE_CHARGES_DISABLED"
  | "PAYEE_MISSING_STRIPE_ACCOUNT"
  | "PAYEE_NOT_CONNECTED"
  | "POS_READER_ALREADY_PAIRED"
  | "POS_READER_BUSY"
  | "POS_READER_NOT_FOUND"
  | "POS_READER_OFFLINE"
  | "POS_READER_ORG_MISMATCH"
  | "POS_READER_REGISTRATION_CODE_INVALID"
  | "SEAT_UNAVAILABLE"
  // A save that makes a location more private (or takes an event out of
  // public view) could not remove the old search entry, so it was rolled back
  // rather than leave the old address in search. Nothing changed; retrying
  // is the whole remedy (core `search/privacy-scrub.ts`).
  | "SEARCH_UPDATE_RETRY"
  | "TICKET_TYPE_TEMPORARILY_HELD"
  // ── profiles ──
  | "AVATAR_KEY_NOT_OWNED"
  | "BANNER_KEY_NOT_OWNED"
  | "UPLOADED_AVATAR_NOT_FOUND"
  | "UPLOADED_BANNER_NOT_FOUND"
  // ── promos ──
  | "END_BEFORE_START"
  | "GLOBAL_SCOPE_DISABLED"
  | "PROMO_EXPIRED"
  | "PROMO_NOT_FOUND"
  | "PROMO_NOT_OWNED"
  | "SCOPE_REQUIRES_SCOPE_ID"
  | "TICKET_TYPE_SCOPE_UNSUPPORTED"
  // ── quotas ──
  | "EXPANSION_REQUEST_ALREADY_PENDING"
  | "EXPANSION_REQUEST_ALREADY_REVIEWED"
  | "EXPANSION_REQUEST_NOT_FOUND"
  | "QUOTA_EXCEEDED"
  | "REQUESTED_LIMIT_NOT_HIGHER"
  // ── resale ──
  | "AGREEMENT_MISSING"
  | "AGREEMENT_MISSING_FEE_POLICY"
  | "CANNOT_BUY_OWN_LISTING"
  | "CLAIM_ALREADY_EXISTS"
  | "CLAIM_ALREADY_RESOLVED"
  | "CLAIM_NOT_RESALE_ORDER"
  | "CLAIM_NOT_RESPONDENT"
  | "CLAIM_TICKET_NOT_HELD"
  | "CLAIM_APPROVAL_TICKET_NOT_HELD"
  | "CLAIM_RESPONSE_DEADLINE_PASSED"
  | "CLAIM_WINDOW_EXPIRED"
  | "CLAIM_WINDOW_NOT_OPEN"
  | "LISTING_ALREADY_HELD"
  | "LISTING_NOT_ACTIVE"
  | "LISTING_NOT_FOUND"
  | "RESALE_NOT_ALLOWED_FOR_TYPE"
  | "RESALE_NOT_ENABLED"
  | "RESALE_PRICE_EXCEEDS_CAP"
  /**
   * The ticket's purchase snapshot (`OrderItem.unitPriceCents`) is
   * unreachable, so resale face value / markup split cannot be computed
   * honestly. Deliberately a hard failure: the alternative — falling back to
   * the LIVE `TicketType.priceCents` — is the FR-001 money-misrouting bug.
   */
  | "RESALE_PURCHASE_PRICE_UNKNOWN"
  | "RESALE_UNWIND_MISSING_LISTING_ID"
  | "SALE_CUTOFF_PASSED"
  | "SELLER_PAYOUT_NOT_SETUP"
  | "TICKET_NOT_ELIGIBLE_FOR_RESALE"
  // ── scanner ──
  | "MISSING_TARGET"
  | "TARGET_LACKS_SCANNER_ROLE"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_MEMBER"
  // ── series ──
  | "EVENT_ALREADY_IN_SERIES"
  | "EVENT_START_NOT_IN_SCHEDULE"
  | "INVALID_DATETIME"
  // Promoted by the admin Dates page (recurring-series redesign Phase 2):
  // skip/restore/add-date actions surface these verbatim to organizers.
  | "OCCURRENCE_DUPLICATE_DATE"
  | "OCCURRENCE_NOT_FOUND"
  | "OCCURRENCE_NOT_SKIPPABLE"
  | "OCCURRENCE_NOT_SKIPPED"
  | "SERIES_INACTIVE"
  | "SERIES_NAME_TAKEN"
  | "SERIES_NOT_FOUND"
  | "SERIES_SCHEDULE_INVALID"
  // ── open calls v1 (spec 2026-10-05) ── posting, closing, the public page
  | "OPEN_CALL_NOT_FOUND"
  | "OPEN_CALL_COVERED_BY_SERIES"
  | "SERIES_OPEN_CALL_CONFLICT"
  | "OPEN_CALL_NOT_REOPENABLE"
  // ── open calls v1 step 4 ── applying
  | "OPEN_CALL_CLOSED"
  | "OPEN_CALL_DATES_REQUIRED"
  | "OPEN_CALL_DATE_INVALID"
  | "OPEN_CALL_APPLICATION_NOT_FOUND"
  | "OPEN_CALL_LINK_EXPIRED"
  | "OPEN_CALL_APPLICATION_LOCKED"
  | "OPEN_CALL_APPLICATION_DECIDED"
  | "OPEN_CALL_APPLICATION_SUPERSEDED"
  | "OPEN_CALL_THREAD_CLOSED"
  | "OPEN_CALL_VOTE_OWN_APPLICATION"
  // ── open calls v1 step 6 ── deciding (pick, not this time, drop out)
  | "OPEN_CALL_APPLICATION_WITHDRAWN"
  | "OPEN_CALL_APPLICATION_NOT_PICKED"
  | "OPEN_CALL_DATE_UNAVAILABLE"
  | "TEMPLATE_NOT_ACTIVE"
  | "WINDOW_BOUNDS_REQUIRED"
  | "WINDOW_END_BEFORE_START"
  // ── settlements ──
  | "EVENT_MISSING_PAYOUT_TERMS"
  | "NO_SPLITS_FOUND"
  | "ORDER_DISPUTED"
  | "ORDER_NOT_SUCCEEDED"
  | "PAYEE_PAYOUTS_DISABLED"
  | "SETTLEMENT_NOT_FOUND"
  // ── stripe-connect ──
  | "NOT_CONNECTED"
  | "PAYOUTS_NOT_ENABLED"
  // ── support ──
  | "OWNER_CAN_ONLY_ESCALATE"
  | "SUPPORT_THREAD_UNAVAILABLE"
  | "THREAD_NOT_FOUND"
  // ── synthetic ──
  | "NETWORK"
  // ── ticket-types ──
  | "PAID_TICKETING_REQUIRES_FEE_POLICY"
  | "PAID_TICKETING_REQUIRES_STRIPE"
  | "SUGGESTED_BELOW_MINIMUM"
  | "TICKET_TYPE_HAS_SALES"
  | "TICKET_TYPE_LOCKED_BY_SALES"
  | "TICKET_TYPE_NAME_TAKEN"
  | "TICKET_TYPE_NOT_YET_ON_SALE"
  | "TICKET_TYPE_SALES_ENDED"
  | "TICKET_TYPE_SALES_WINDOW_INVALID"
  | "TICKET_TYPE_SCHEDULE_INCOMPLETE"
  // ── tickets ──
  | "CANNOT_TRANSFER_TO_SELF"
  | "CLIENT_KEY_TOO_SHORT"
  | "EMAIL_MISMATCH"
  | "INVALID_ARGUMENT"
  | "INVALID_ORDER_ITEM"
  | "ORDER_REQUIRED_FOR_RESALE"
  | "PENDING_TRANSFER_ALREADY_EXISTS"
  | "PENDING_TRANSFER_EXPIRED"
  | "PENDING_TRANSFER_NOT_FOUND"
  | "RECIPIENT_ALREADY_HAS_ACCOUNT"
  | "RESALE_DISABLED_FOR_EVENT"
  | "SEAT_ALLOCATION_MISMATCH"
  | "SEAT_ASSIGNMENT_COUNT_MISMATCH"
  | "TICKET_ALREADY_OWNED_BY_TARGET"
  | "TICKET_ITEM_MISSING_TICKET_TYPE"
  | "TICKET_NOT_FOUND"
  | "TICKET_NOT_SCANNED"
  | "TICKET_NOT_TRANSFERABLE"
  | "TICKET_NO_LONGER_OWNED_BY_SENDER"
  | "TICKET_REFUND_IN_PROGRESS"
  | "TICKET_TRANSFER_EVENT_PAST"
  | "TICKET_UNDER_CLAIM"
  | "TICKET_TYPE_SOLD_OUT"
  | "UNDO_WINDOW_EXPIRED"
  // ── transport ──
  | "CHARGEBACK_TERMS_REQUIRED"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "NOT_CONFIGURED"
  | "NOT_FOUND"
  | "INVITE_ALLOWANCE_EXCEEDED"
  | "INVITE_RESEND_TOO_SOON"
  | "INVITES_PAUSED"
  | "RATE_LIMITED"
  | "REFUND_POLICY_REQUIRED"
  | "SCANNER_TERMS_REQUIRED"
  | "TERMS_REQUIRED"
  | "TRANSIENT"
  // ── volunteering ──
  | "ALREADY_SIGNED_UP"
  | "PHONE_REQUIRED_FOR_SMS"
  | "ROLE_FULL"
  | "ROLE_NOT_FOUND"
  | "SHIFT_FULL"
  | "SHIFT_NOT_FOUND"
  /**
   * A NEW shift claim on a standing ask whose owner is withheld (ban that
   * sticks; owner ruling 2026-10-07: "Refuse, but tell them why"). Only a
   * volunteer already accepted on the ask can reach it (eligibility gates
   * first), and the copy says sign-ups are paused, never why: a moderation
   * action stays private to the person it concerns. Carries no meta.
   * Existing claims are untouched.
   */
  | "SHIFT_SIGNUPS_PAUSED"
  | "SIGNUP_MISSING_HUMAN"
  | "SIGNUP_NOT_APPROVED"
  | "SIGNUP_NOT_FOUND"
  | "SIGNUP_NOT_REVIEWABLE"
  | "SIGNUP_NOT_WITHDRAWABLE"
  | "TOKEN_EVENT_MISMATCH"
  | "VOLUNTEERING_DISABLED"
  /**
   * The staff-side twin of `SHIFT_SIGNUPS_PAUSED`: a coordinator or organiser
   * tried to bring a NEW volunteer onto a withheld owner's ask or event
   * (approving a pending signup, assigning someone to a shift). Owner ruling
   * 2026-10-08. Rejecting still works, so every applicant gets an answer, and
   * volunteers already on stay on. Fires only after authorization, and the
   * copy never says why. Carries no meta.
   */
  | "VOLUNTEER_APPROVALS_PAUSED"
  | "VOLUNTEER_QR_EXPIRED"
  | "VOLUNTEER_QR_INVALID"
  | "VOLUNTEER_QR_WRONG_EVENT"
  | "VOLUNTEER_PACK_NOT_FOUND"
  | "VOLUNTEER_PACK_KEY_TAKEN"
  | "VOLUNTEER_PACK_HAS_PLATFORM_ROLES"
  // ── ticket-type packs ──
  | "TICKET_PACK_NOT_FOUND"
  | "TICKET_PACK_KEY_TAKEN"
  | "TICKET_PACK_HAS_PLATFORM_TEMPLATES"
  // ── waivers ──
  | "EVENT_NOT_IN_ORG"
  | "PLATFORM_TEMPLATE_READONLY"
  | "WAIVER_TEMPLATE_NOT_ACCESSIBLE"
  | "WAIVER_TEMPLATE_NOT_FOUND"
  | "WAIVER_TEMPLATE_NOT_OWNED"
  // ── follow-up: legacy-throw migration ──
  | "CLAIM_NOT_FOUND"
  | "INVALID_BLOCK_DATA"
  | "INVALID_BLOCK_KIND"
  | "WALLET_PASS_NOT_CONFIGURED"
  // ── attendee reviews ──
  // Promoted to user-facing by the review-form loop: the form gates on
  // attendeeReviews.getEligibility, but a race (double-submit, expiry mid-flow)
  // can still reach submit and throw these — the attendee sees friendly copy
  // instead of a generic failure.
  | "ATTENDEE_REVIEW_ALREADY_SUBMITTED"
  | "ATTENDEE_REVIEW_EVENT_NOT_ENDED"
  | "ATTENDEE_REVIEW_WINDOW_CLOSED"
  // ═══════════════ INTERNAL (typed, i18n-exempt, never user-shown) ═══════════════
  | "AGREEMENT_LINE_PERSIST_FAILED"
  // Anonymous application-approval claim link: the web route redirects on
  // either outcome (no UI screen), so these stay internal-tier (no i18n copy).
  | "APPLICATION_TOKEN_EXPIRED"
  | "APPLICATION_TOKEN_INVALID"
  | "CUSTOM"
  // Processor evidence-size pre-flight (ports/dispute-evidence). Staff-only
  // ops surface today; PROMOTE to user-facing with copy if a self-serve
  // evidence form ever exists.
  | "DISPUTE_EVIDENCE_LIMIT_EXCEEDED"
  // Dispute desk (staff-only): package lifecycle + processor submit.
  | "DISPUTE_EVIDENCE_NOT_FOUND"
  | "DISPUTE_EVIDENCE_STATE_INVALID"
  | "DISPUTE_EVIDENCE_SUBMIT_FAILED"
  | "DISPUTE_NOT_ACCEPTING_EVIDENCE"
  | "DISPUTE_NOT_FOUND"
  | "DISPUTE_TARGET_OWNER_MISSING"
  | "EMAIL_DELIVERY_FAILED"
  | "EMBED_DOMAIN_INVALID"
  | "EMBED_LINK_OUT_ONLY"
  | "EMBED_ORIGIN_NOT_ALLOWED"
  | "INTERNAL"
  // A job's handler module failed to import (apps/jobs registry). Operator-only
  // — it can only surface on POST /jobs/:name — so internal-tier, no i18n copy.
  | "JOB_MODULE_LOAD_FAILED"
  | "MAILER_NOT_CONFIGURED"
  | "MISSING_IN_APP_PREFERENCES"
  | "NOTIFICATIONS_REPO_UNAVAILABLE"
  // Two writers allocated the same (seriesId, ordinal) concurrently
  // (reconcile insert vs addSeriesOccurrence). Retryable race — internal-tier
  // (PROMOTE to user-facing with copy if the Dates page wants to surface a
  // "please retry" message instead of the generic fallback).
  | "OCCURRENCE_ALLOCATION_CONFLICT"
  | "OCCURRENCE_ALLOCATION_FAILED"
  // `updateOrderItems` refused because the PENDING order already has a
  // PaymentIntent. The PI was minted at the order's CURRENT amount; re-pricing
  // the lines afterwards leaves PI amount != order amount, and
  // `finalizePaymentIntent` then refuses with AMOUNT_MISMATCH into the DLQ
  // (buyer charged, no tickets). The client must call `createCheckout` with
  // `pendingOrderId` instead — that path retires the old cart and mints a
  // fresh PI. The web client already does; only a raw API caller can hit
  // this, so internal-tier (money audit 2026-09-08 #11).
  | "ORDER_HAS_PAYMENT_INTENT"
  // Refund refused because the order's charge is under an OPEN / UNDER_REVIEW
  // / LOST dispute (Stripe `charge_disputed`, or our own pre-flight). INTERNAL
  // tier ONLY until the en/es `errors.orderDisputedRefundBlocked` entries land;
  // the human sentence lives in apps/web format-error-message.ts meanwhile.
  // PROMOTE to user-facing + catalog and drop that dictionary key.
  | "ORDER_DISPUTED_REFUND_BLOCKED"
  | "ORDER_RELOAD_FAILED"
  | "PLACE_LAYOUT_PARSER_ERROR"
  | "REFUND_FAILED"
  | "REFUND_NOT_SUCCEEDED"
  | "REFUND_REJECTED"
  // Buyer-initiated refund refused because the event's refund window has
  // closed (`now >= startsAt`, or `now >= refundCutoffAt` when the organizer
  // set one — the same rule `get-refund-eligibility.ts` displays).
  | "REFUND_WINDOW_CLOSED"
  // Per-item refund requested on a RESALE order. Resale orders are single
  // item and must take `refundFullOrder`, which unwinds the resale (ticket
  // back to the seller, listing restored).
  | "RESALE_ORDER_USE_FULL_REFUND"
  // Buyer full-refund request on a RESALE order whose claim was approved and
  // whose refund has not landed yet: the claim already owes the refund.
  | "CLAIM_REFUND_PENDING"
  // Refund retry pre-flight (money audit 2026-09-08 #10): a refund already
  // issued on this PaymentIntent names SOME of the requested items (or the
  // same items for a different amount) — an earlier attempt's transaction
  // died after Stripe accepted it. Refusing keeps the money from moving
  // twice; the `charge.refunded` reconciler flips the paid items, after
  // which a fresh request quotes only what is still live. Internal: the
  // client sees a generic conflict; `meta` carries the overlap for ops.
  | "REFUND_ALREADY_ISSUED_FOR_ITEMS"
  // A refund on this order's PaymentIntent carries metadata naming a
  // DIFFERENT order. Never expected (one PaymentIntent, one order); refuse
  // rather than reuse so an operator looks. Internal.
  | "REFUND_METADATA_ORDER_MISMATCH"
  // Resale finalization found the seller's ORIGINAL order item already
  // refunded — committing would flip `refunded` → `transferred` and pay the
  // seller twice. Invariant breach; never user copy.
  | "RESALE_ORIGINAL_ITEM_REFUNDED"
  // Defense-in-depth boundary (2FA step-up for platform/moderation staff):
  // the friendly enrollment-prompt UI (client + SSR redirect to /enroll-2fa)
  // is the layer real users see; a direct API call that reaches this is an
  // anomaly/bypass attempt, so it stays internal-tier (generic safe fallback,
  // no user-facing copy needed).
  | "SECOND_FACTOR_REQUIRED"
  | "SERVICE_UNAVAILABLE"
  | "SETTLEMENT_RELOAD_FAILED"
  | "SMS_SEND_FAILED"
  // Refused because a set of payout-terms lines cannot add up to the basis:
  // EVERY line is capped and Σ capPercent < 100%, so every order would leave
  // cents unallocated and every payee would be quietly under-paid. Thrown at
  // publish AND at every terms-writing use case (`updateEventSplits`,
  // `upsertAgreementLine`, the `upsertAgreementFor*` family).
  //
  // It takes ALL lines being capped: `distributeRemainder` never skips an
  // uncapped line, so one is enough to absorb the remainder. Do not restate
  // this as Σ min(percent, capPercent) — that predicate refuses the ordinary
  // "venue takes 20%, capped at 5%; organiser takes 80%" deal, which the split
  // math distributes exactly. See `lib/pricing/caps-satisfiable.ts`.
  //
  // INTERNAL tier ONLY until the en/es `errors.splitsCapsUnsatisfiable`
  // entries land; PROMOTE to user-facing + catalog then (the splits editor is
  // the surface that needs to explain it).
  | "SPLITS_CAPS_UNSATISFIABLE"
  | "STORAGE_ERROR"
  /**
   * arrival-areas (docs/specs/2026-10-16/arrival-areas.spec.yaml), the
   * create / update / reorder / remove / hide refusals:
   *  - NOT_FOUND: no such area on the parent the caller named (a foreign id
   *    reads the same as a missing one);
   *  - CONFLICT (NFR-004): the row changed since the editor loaded it.
   *    `meta.current` is the row as it now is (update / remove), or
   *    `meta.currentIds` the parent's areas in stored order (reorder);
   *  - LIMIT_REACHED (FR-005): `meta.limit` (10), `meta.parent` ("place" |
   *    "event");
   *  - INVALID_GEOMETRY (FR-005): `meta.reason` is the geometry rule broken
   *    (`ArrivalAreaGeometryErrorCode`: OUTSIDE_ENVELOPE, TOO_MANY_POINTS,
   *    NO_PIN, ...) plus its limit fields (`limitMeters`, `limit`, `count`,
   *    `minimum`, `minAreaM2`, `minMeanWidthM`).
   * USER-FACING since plan step 6 shipped the `arrivalAreas.*` procedures
   * (en + es copy in apps/web/src/i18n/messages).
   */
  | "ARRIVAL_AREA_NOT_FOUND"
  | "ARRIVAL_AREA_CONFLICT"
  | "ARRIVAL_AREA_LIMIT_REACHED"
  | "ARRIVAL_AREA_INVALID_GEOMETRY";

/**
 * Runtime-iterable list of every {@link AppErrorCode}. Kept in sync with the
 * union by a two-way compile-time guard:
 *   - `satisfies readonly AppErrorCode[]` catches an EXTRA / typo'd entry here
 *     that isn't in the union (array → union).
 *   - the `_exhaustive` assertion below catches a union member that is MISSING
 *     from this array (union → array).
 */
export const APP_ERROR_CODES = [
  // ═══════════════ USER-FACING ═══════════════
  // ── agreements ──
  "AGREEMENT_NOT_EDITABLE",
  "AGREEMENT_PERCENT_TOTAL_EXCEEDED",
  "ANOTHER_ACTIVE_AGREEMENT_EXISTS",
  "CANNOT_READ_OTHER_HUMAN_DEFAULTS",
  "CANNOT_SET_DEFAULTS_FOR_ANOTHER_HUMAN",
  "DUPLICATE_PAYEE",
  "EVENT_ARCHIVED",
  "FEE_POLICY_NOT_ACTIVE",
  "FEE_POLICY_NOT_FOUND",
  "FEE_POLICY_OUT_OF_SCOPE",
  "HUMAN_MISMATCH",
  "INSUFFICIENT_ROLE",
  "INVALID_LINE_REFERENCE",
  "MULTIPLE_ACTIVE_AGREEMENTS",
  "NO_PAYOUT_TERMS_CONFIGURED",
  "ORGANIZATION_INACTIVE",
  "ORGANIZATION_NOT_FOUND",
  "PAYEE_ALREADY_ASSIGNED",
  "PAYEE_CHANGE_NOT_ALLOWED",
  "PAYEE_NOT_ACTIVE",
  "PAYOUT_TERMS_NOT_FOUND",
  // ── announcements ──
  "ACTOR_EMAIL_NOT_FOUND",
  "INVALID_UNSUBSCRIBE_TOKEN",
  // ── api-keys ──
  "API_KEY_ALREADY_REVOKED",
  "API_KEY_NOT_FOUND",
  // ── auth ──
  "EMAIL_NOT_VERIFIED",
  "USER_ALREADY_EXISTS",
  // ── booking-agreements ──
  "ACT_RESPONSE_ONLY",
  "AGREEMENT_FINALIZED",
  "AGREEMENT_LINE_NOT_FOUND",
  "AGREEMENT_LINKED_TO_OTHER_EVENT",
  "AGREEMENT_MISSING_PAYOUT_TERMS",
  "AGREEMENT_NOT_ACCEPTED",
  "AGREEMENT_NOT_CANCELLABLE",
  "AGREEMENT_NOT_DRAFT",
  "AGREEMENT_NOT_FOUND",
  "AGREEMENT_NOT_PROPOSED",
  "EVENT_ALREADY_HAS_AGREEMENT",
  "INVALID_STATUS",
  "LINES_UNCONFIRMED",
  "NOT_AGREEMENT_PARTY",
  "PAYEE_NOT_READY",
  "PROPOSED_END_BEFORE_START",
  "TERMS_EDITOR_ONLY",
  // ── booking-requests ──
  "BOOKING_DATE_UNAVAILABLE",
  "BOOKING_REQUEST_EXPIRED",
  "BOOKING_REQUEST_NOT_FOUND",
  "BOOKING_REQUEST_NOT_PENDING",
  "CANNOT_BOOK_OWN_ACT",
  "DUPLICATE_OPEN_REQUEST",
  "PERFORMER_MODE_REQUIRED",
  "PERFORMER_NOT_ACCEPTING_REQUESTS",
  "PLACE_ID_REQUIRED",
  "PLACE_NOT_ACCEPTING_REQUESTS",
  "PLACE_NOT_VERIFIED",
  // ── P3a (unclaimed venues) ──
  "PLACE_NOT_TAKING_REQUESTS",
  // lineup-booking-requests v2 (spec 2026-09-25) — the bill
  "BILL_NOT_ALLOWED",
  "ACT_NOT_TAGGABLE",
  "ACT_ALREADY_DECLINED",
  // lineup-booking-requests v3 — the bill is fixed once the event exists
  "BILL_LOCKED",
  // ── booking-holds (spec 2026-08-25) ──
  "BOOKING_HOLD_NOT_FOUND",
  "HOLD_ALREADY_PLACED",
  "HOLD_LINE_ALREADY_CONFIRMED",
  "BOOKING_HOLD_NOT_LIVE",
  "BOOKING_HOLD_NOT_FIRST",
  "BOOKING_HOLD_CHALLENGE_OPEN",
  "BOOKING_HOLD_NOT_CHALLENGED",
  "BOOKING_HOLD_CHALLENGE_LAPSED",
  "BOOKING_HOLDS_VENUE_ONLY",
  "BOOKING_HOLD_NEEDS_REQUEST",
  "BOOKING_HOLD_HOLDER_EXISTS",
  "CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE",
  "PLACE_BOOKING_GRANT_NOT_FOUND",
  "PLACE_BOOKING_GRANT_NOT_PENDING",
  "PLACE_BOOKING_GRANT_ENDED",
  "PLACE_BOOKING_GRANT_EXISTS",
  "PLACE_BOOKING_GRANT_GRANTEE_INVALID",
  "PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS",
  "HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST",
  "HOLD_LINE_HAS_OPEN_CHALLENGE",
  "HOLD_LINE_CHANGED",
  "HOLD_DATE_MISMATCHES_EVENT",
  "BOOKING_TERMS_NOT_FINALIZED",
  "BOOKING_TAG_NOT_FOUND",
  "BOOKING_TAG_SLUG_TAKEN",
  "BOOKING_ASSIGNEE_NOT_ELIGIBLE",
  "BOOKING_ASSIGNMENT_NOT_APPLICABLE",
  // venue-booking-standards (spec 2026-09-25) — unmet REQUIRED pitch items
  "STANDARDS_UNMET",
  // booking-the-night (spec 2026-09-25) — agree & book, book without terms,
  // cancel booking
  // NIGHT_TAKEN is venue-side only; its meta names another party's hold — the
  // sender's agree path uses NIGHT_NO_LONGER_AVAILABLE.
  "NIGHT_TAKEN",
  "NIGHT_NO_LONGER_AVAILABLE",
  "DATE_NOT_ASKED_FOR",
  "HOLD_CONFIRM_RETIRED",
  "NO_ACT_READY",
  "VENUE_CONFIRMATION_NOT_FOR_REQUESTS",
  "BOOKING_NOT_CANCELLABLE",
  "BOOKING_ALREADY_HAS_NIGHT",
  "TERMS_SENT_FOR_ANOTHER_NIGHT",
  "TERMS_CHANGED_SINCE_VIEWED",
  "EVENT_ON_ANOTHER_NIGHT",
  "EVENT_FIRST_ORIGIN_GONE",
  "LINKED_EVENT_NOT_LIVE",
  "PLACE_NOT_TAKING_BOOKINGS",
  "TERMS_AGREED_FOR_ANOTHER_NIGHT",
  "BOOKING_CANCELLED",
  "BOOKING_NIGHT_BOOKED",
  "EVENT_ON_ANOTHER_CALENDAR",
  "BOOKING_HAS_MULTIPLE_EVENTS",
  "EVENT_FIRST_REQUIRES_ORIGIN_EVENT",
  "EVENT_OWNER_NOT_BOOKING_PARTY",
  // ── booking-the-night P2d-1 (saved reasons) ──
  "SAVED_SNIPPET_LIMIT_REACHED",
  "SAVED_SNIPPET_NOT_FOUND",
  "SAVED_SNIPPET_ORDER_CHANGED",
  // ── booking-the-night P2d-2 ──
  "TERMS_AGREED_FOR_THIS_NIGHT",
  // ── P3b (asks) ──
  "BOOKING_ASK_NOT_FOUND",
  // ── categories ──
  "CATEGORY_ALREADY_EXISTS",
  "CATEGORY_ENGLISH_NAME_REQUIRED",
  "CATEGORY_INACTIVE",
  "CATEGORY_NOT_FOUND",
  "CATEGORY_REQUEST_ALREADY_REVIEWED",
  "CATEGORY_REQUEST_NOT_FOUND",
  "CATEGORY_SLUG_TAKEN",
  "INVALID_CATEGORY_REQUEST_NAME",
  "INVALID_CATEGORY_SLUG",
  // ── comms ──
  "ACTOR_MISMATCH",
  "CHANNEL_INELIGIBLE",
  "CONTACT_MUST_HAVE_EMAIL_OR_PHONE",
  "CROSS_OWNER_MERGE_NOT_ALLOWED",
  "EVENT_NOT_COMPLETED",
  "IMPORT_ALREADY_COMPLETED",
  "IMPORT_NOT_FOUND",
  "IMPORT_OWNER_MISMATCH",
  "INVALID_NOTIFICATION_PAYLOAD",
  "LIST_OWNER_MISMATCH",
  "NO_UPDATES_PROVIDED",
  "PHONE_FORMAT_INVALID",
  "SOURCE_CANNOT_BE_TARGET",
  "TARGET_LIST_NAME_REQUIRED_FOR_NEW_LIST",
  "TARGET_LIST_NOT_FOUND",
  "TAX_JURISDICTION_UNAVAILABLE",
  "TAX_JURISDICTION_UNSUPPORTED",
  "TAX_RATE_UNAVAILABLE",
  "MANUAL_TAX_RATE_NOT_ALLOWED",
  "TOKEN_EXPIRED",
  "TOKEN_HUMAN_MISMATCH",
  "TOKEN_INVALID",
  "TOKEN_NOT_SUPPORTED",
  "TOKEN_SCOPE_MISMATCH",
  "TRANSACTIONAL_CANNOT_BE_DISABLED",
  "UNKNOWN_NOTIFICATION_CATEGORY",
  "UNKNOWN_NOTIFICATION_VARIANT",
  // ── community ──
  "EDIT_SUGGESTION_ALREADY_REVIEWED",
  "EDIT_SUGGESTION_INVALID_FIELDS",
  "EDIT_SUGGESTION_NOT_FOUND",
  "EVENT_DATE_IN_PAST",
  "EVENT_DATE_NOT_FOUND",
  "EVENT_DATE_NOT_RSVPABLE",
  "EVENT_NOT_COMMUNITY",
  "EVENT_NOT_TICKETED",
  "MODERATOR_APPLICATION_ALREADY_PENDING",
  "MODERATOR_APPLICATION_ALREADY_REVIEWED",
  "MODERATOR_APPLICATION_NOT_FOUND",
  "RECURRENCE_DROP_WOULD_CANCEL_RSVPS",
  "RECURRENCE_HAS_NO_UPCOMING_DATES",
  // ── comp ──
  "EVENT_CANCELLED",
  // ── credits ──
  "EXPIRES_AT_IN_PAST",
  // ── delegates ──
  "CANNOT_DELEGATE_TO_SELF",
  "DELEGATE_SELF_BENEFIT_FORBIDDEN",
  "DELEGATION_NOT_FOUND",
  // ── disputes ──
  "STRIPE_EVENT_CONFLICT",
  // ── embeds ──
  "DOMAIN_MISMATCH",
  "EMBED_NOT_FOUND",
  "SEAT_SECTION_NOT_FOUND",
  "TURNSTILE_TOKEN_REQUIRED",
  "TURNSTILE_VERIFICATION_FAILED",
  "UNSUPPORTED_SUBJECT_TYPE",
  // ── entity-pages ──
  "BLOCK_NOT_FOUND",
  "BLOCK_PINNED",
  "INVALID_BLOCK_ORDER",
  "OWNER_NOT_FOUND",
  "PAGE_IMAGE_KEY_NOT_OWNED",
  "PAGE_NOT_FOUND",
  "SLUG_TAKEN",
  "UNKNOWN_OWNER_TYPE",
  "UPLOADED_PAGE_IMAGE_NOT_FOUND",
  // ── event-humans ──
  "EVENT_HUMAN_NOT_FOUND",
  "HUMAN_ID_OR_EXTERNAL_NAME_REQUIRED",
  // ── event-templates ──
  "EVENT_NOT_DRAFT",
  "SAVED_LOCATION_NOT_FOUND",
  "TEMPLATE_ARCHIVED",
  "TEMPLATE_INACTIVE",
  "TEMPLATE_NAME_TAKEN",
  "TEMPLATE_NOT_FOUND",
  "UNKNOWN_OWNER_SCOPE",
  // ── events ──
  "APPLICATION_ALREADY_SUBMITTED",
  "APPLICATION_ANSWERS_INCOMPLETE",
  "APPLICATION_CAP_REACHED",
  "APPLICATION_SUBMISSIONS_EXIST",
  "APPLICATION_WINDOW_CLOSED",
  "APPLICATION_WINDOW_NOT_OPEN",
  "ATTESTATION_INCOMPLETE",
  "AUDIO_UPLOAD_NOT_FOUND",
  "CURATED_UNTIL_BEFORE_EVENT",
  "CURATED_UNTIL_UNAVAILABLE",
  "EVENT_ALREADY_ARCHIVED",
  "EVENT_ALREADY_CANCELLED",
  "EVENT_ALREADY_COMPLETED",
  "EVENT_ALREADY_ENDED",
  "EVENT_CATEGORY_MISSING",
  "EVENT_GATED",
  "EVENT_HAS_ORDERS_USE_CANCEL_INSTEAD",
  "EVENT_LOCATION_REQUIRED",
  "EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE",
  "EVENT_MOVED",
  "EVENT_NOT_APPLICATION_GATED",
  "EVENT_NOT_ARCHIVABLE",
  "EVENT_NOT_CANCELLABLE",
  "EVENT_NOT_COMPLETABLE",
  "EVENT_NOT_DELETABLE",
  "EVENT_NOT_DRAFT_USE_CANCEL_INSTEAD",
  "EVENT_NOT_EDITABLE",
  "EVENT_NOT_FOUND",
  "EVENT_NOT_ON_SALE",
  "EVENT_NOT_PASSWORD_GATED",
  "EVENT_NOT_PUBLISHABLE",
  "EVENT_NOT_PUBLISHED",
  "EVENT_PASSWORD_CHALLENGE_REQUIRED",
  "EVENT_PASSWORD_INVALID",
  "EVENT_PASSWORD_MISSING",
  "EVENT_SLUG_CONFLICT",
  "EVENT_SLUG_CONTEXT_MISSING",
  "EVENT_SLUG_MISSING",
  "EVENT_SLUG_REDIRECT",
  "EVENT_SLUG_REGENERATION_NOT_ALLOWED",
  "EVENT_WAS_PUBLISHED",
  "EXPIRATION_MUST_BE_FUTURE",
  "FORBIDDEN",
  "FORM_MISMATCH",
  "FORM_NOT_FOUND",
  "IDEMPOTENCY_KEY_CONFLICT",
  "IDEMPOTENCY_LOCK_IN_PROGRESS",
  "IMAGES_WRONG_EVENT",
  "IMAGE_NOT_FOUND",
  "INVALID_TIME_WINDOW",
  "LINEUP_ROW_ALREADY_REGISTERED",
  "MAGIC_LINK_ALREADY_REDEEMED",
  "MAGIC_LINK_EXPIRED",
  "MAGIC_LINK_NOT_FOUND",
  "MAGIC_LINK_WRONG_RECIPIENT",
  "NOT_AUTHORIZED",
  "NOT_RESOURCE_OWNER",
  "NO_RANDOM_EVENT_AVAILABLE",
  "OPTIONS_NOT_ALLOWED",
  "OPTIONS_REQUIRED",
  "PASSWORD_REQUIRED",
  "PLACE_NOT_ACTIVE",
  "PRIMARY_AGREEMENT_MISSING",
  "QUESTION_NOT_FOUND",
  "RESALE_TERMS_MISSING",
  "RESALE_SHARE_IN_USE",
  "RESALE_SPLITS_OVER_TOTAL",
  "SPLITS_TOTAL_INVALID",
  "STRIPE_NOT_CONNECTED_OWNER",
  "SUBMISSION_EVENT_MISMATCH",
  "SUBMISSION_NOT_FOUND",
  "SUBMISSION_NOT_REVIEWED",
  "TICKETS_ALREADY_ISSUED",
  "TICKET_TYPES_REQUIRED",
  "TICKET_TYPE_CAPACITY_INVALID",
  "TICKET_TYPE_EVENT_MISMATCH",
  "TICKET_TYPE_NOT_FOUND",
  "TICKET_TYPE_SCOPE_ONLY_VALID_FOR_PRIMARY",
  "TOKEN_EXPIRATION_IN_PAST",
  "UPLOAD_NOT_COMPLETE",
  "WAITLIST_FULL",
  "WAITLIST_NOT_OPEN",
  "WAITLIST_PUBLISH_AT_REQUIRED",
  // ── follows ──
  "FOLLOWS_DISABLED",
  "FOLLOW_NOT_FOUND",
  "SELF_FOLLOW_NOT_ALLOWED",
  // ── humans ──
  "CURRENT_PASSWORD_INVALID",
  "CURRENT_PASSWORD_REQUIRED",
  "FORCE_VERIFY_HOLDS_EMAIL_ATTACHED",
  "HUMAN_NOT_FOUND",
  "SCANNER_TERMS_VERSION_MISMATCH",
  // ── orders ──
  "ACTOR_NOT_FOUND",
  "AGREEMENT_MISSING_LINES",
  "AMOUNT_MISMATCH",
  "BUYER_MUST_BE_ACTOR",
  "CREDIT_BALANCE_CHANGED",
  "CURRENCY_MISMATCH",
  "DONATION_AMOUNT_REQUIRED",
  "DONATION_BELOW_MINIMUM",
  "DUPLICATE_PROMO",
  "EVENTS_DIFFERENT_ORG",
  "EVENTS_DIFFERENT_OWNER",
  "EVENT_MISMATCH",
  "EVENT_SALES_CLOSED",
  "EXPECTED_PAID_ORDER",
  "EXPECTED_TICKETING_ORDER",
  "INSUFFICIENT_CAPACITY",
  "ITEMS_NOT_REFUNDABLE",
  "NON_POSITIVE_AMOUNT",
  "NO_ORDERS_TO_MIGRATE",
  "NO_PAYEE_SUBJECT",
  "NO_REFUNDABLE_ITEMS",
  "NO_STRIPE_ACCOUNT",
  "NO_TICKET_TYPES",
  "ORDER_ALREADY_REFUNDED",
  "ORDER_EMPTY",
  "ORDER_EVENT_MISMATCH",
  "ORDER_ITEM_NOT_FOUND",
  "ORDER_NON_REFUNDABLE",
  "REFUND_WINDOW_CLOSED",
  "RESALE_ORDER_USE_FULL_REFUND",
  "CLAIM_REFUND_PENDING",
  "REFUND_ALREADY_ISSUED_FOR_ITEMS",
  "REFUND_METADATA_ORDER_MISMATCH",
  "ORDER_NOT_FOUND",
  "ORDER_NOT_FREE",
  "ORDER_NOT_IN_ORG",
  "ORDER_NOT_OWNED",
  "ORDER_NOT_PAID",
  "ORDER_NOT_PENDING",
  "ORDER_NOT_PROCESSABLE",
  "ORDER_NOT_REFUNDABLE",
  "PAYMENT_INTENT_MISMATCH",
  "PAYMENT_INTENT_ORDER_MISMATCH",
  "PAYMENT_NOT_SUCCEEDED",
  "PRIMARY_ORDER_RESALE_LINKED_TRANSFER_REQUIRES_MANUAL_REVIEW",
  "PROMO_MAX_REDEEMED",
  "PROMO_MIN_ORDER_NOT_MET",
  "PROMO_NOT_APPLICABLE",
  "PROMO_NOT_STACKABLE",
  "PROMO_REDEEMED_BY_HUMAN",
  "QTY_EXCEEDS_ORDER",
  "REFUND_AMOUNT_ZERO",
  "REFUND_NOT_TERMINAL",
  "SEAT_ASSIGNMENT_QTY_MISMATCH",
  "SEAT_DUPLICATE_IN_REQUEST",
  "SEAT_IDS_DUPLICATE",
  "SEAT_IDS_INVALID",
  "SEAT_IDS_NOT_ASSIGNED",
  "SEAT_IDS_REQUIRED",
  "SEAT_NOT_FOUND",
  "SEAT_NOT_IN_ORDER",
  "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER",
  "SEAT_PRICE_OVERRIDE_NO_FIXED_TIER",
  "SEAT_SECTION_MISMATCH",
  "SEAT_TAKEN",
  "SOURCE_AND_TARGET_MUST_DIFFER",
  "STRIPE_NOT_CONNECTED",
  "TARGET_EVENT_NOT_ACTIVE",
  "TICKETS_MISSING",
  "TICKET_ITEM_NOT_FOUND",
  "TICKET_NOT_VALID",
  "TICKET_TYPE_NOT_SEATED",
  "WAIVER_REQUIRED",
  // ── orgs ──
  "ALREADY_A_MEMBER",
  "CANNOT_DEMOTE_LAST_OWNER",
  "CANNOT_REMOVE_LAST_OWNER",
  "INVITATION_EXPIRED",
  "INVITATION_NOT_FOUND",
  "INVITATION_NOT_PENDING",
  "MEMBER_NOT_FOUND",
  "MEMBERSHIPS_SUSPENDED",
  "MEMBERSHIP_NOT_FOUND",
  "MEMBERSHIP_BENEFIT_INVALID_TERMS",
  "MEMBERSHIP_BENEFIT_NOT_FOUND",
  "MEMBERSHIP_TIER_ARCHIVED",
  "MEMBERSHIP_TIER_NOT_ACTIVE",
  "MEMBERSHIP_TIER_NOT_FOUND",
  "MEMBERSHIP_TIER_PRICE_LOCKED",
  "ORG_ALREADY_ARCHIVED",
  "ORG_HAS_ACTIVE_EVENTS",
  "ORG_NOT_FOUND",
  // ── payout-terms ──
  "COUNTER_FIELDS_REQUIRED",
  "LINE_DECLINED",
  "LINE_DOES_NOT_REQUIRE_CONFIRMATION",
  "LINE_NOT_COUNTERABLE",
  "LINE_NOT_DECLINABLE",
  "PAYEE_NOT_FOUND",
  "PAYOUT_LINE_NOT_FOUND",
  // ── payouts ──
  "SCHEDULED_FOR_IN_PAST",
  // ── place-layouts ──
  "IDEMPOTENCY_KEY_REQUIRED",
  "PLACE_LAYOUT_EMPTY",
  "PLACE_LAYOUT_NOT_FOUND",
  "SEAT_IDS_NOT_UNIQUE",
  // ── place-reviews ──
  "PLACE_COMMUNITY_REVIEWS_DISABLED",
  "PLACE_STATS_NOT_FOUND",
  "REVIEW_ALREADY_FLAGGED",
  "REVIEW_ALREADY_HIDDEN",
  "REVIEW_ALREADY_RESPONDED",
  "REVIEW_NOT_FOUND",
  "REVIEW_NOT_HIDDEN",
  // ── places ──
  "AVAILABILITY_NOT_FOUND",
  // ── places: venue hierarchy (promoted to user-facing in Step 6) ──
  "CALENDAR_NOT_FOUND",
  "CALENDAR_REQUIRES_ACTIVE_SPACE",
  "CALENDAR_SLUG_TAKEN",
  "CANNOT_RETIRE_LAST_ACTIVE_SPACE",
  "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
  "SPACE_NOT_FOUND",
  // ── places: claim venue (claim-venue-flow spec) ──
  "PLACE_ALREADY_CLAIMED",
  "PLACE_NOT_CLAIMABLE",
  "CLAIM_ALREADY_PENDING",
  "CLAIM_LIMIT_REACHED",
  "CLAIM_PROOF_REQUIRED",
  "CLAIM_EMAIL_DOMAIN_MISMATCH",
  "CLAIM_FREE_EMAIL_NOT_ALLOWED",
  "CLAIM_PLACE_HAS_NO_WEBSITE",
  "CLAIM_CHALLENGE_NOT_FOUND",
  "CLAIM_CHALLENGE_EXPIRED",
  "CLAIM_CHALLENGE_LOCKED",
  "CLAIM_CHALLENGE_CODE_INVALID",
  "CLAIM_CHALLENGE_NOT_VERIFIED",
  "CLAIM_DISPUTE_NOT_APPLICABLE",
  "DOCUMENTS_REQUIRED",
  "DOCUMENT_DELETED",
  "DOCUMENT_NOT_FOUND",
  "NOT_LOCK_HOLDER",
  "PLACE_ALREADY_EXISTS",
  "PLACE_ARCHIVED",
  "PLACE_HAS_OWNER",
  "PLACE_HAS_LIVE_LISTINGS",
  "PLACE_ALREADY_VERIFIED",
  "PLACE_NOT_ELIGIBLE_FOR_VERIFICATION",
  "PLACE_NOT_FOUND",
  "REUSE_SOURCE_NOT_OWNED",
  "REUSE_SOURCE_STILL_ACTIVE",
  "TOO_MANY_DOCUMENTS",
  "VERIFICATION_ALREADY_PENDING",
  "VERIFICATION_LOCKED_TO_OTHER_REVIEWER",
  "VERIFICATION_NOT_IN_REVIEW",
  "VERIFICATION_NOT_PENDING",
  "VERIFICATION_REQUEST_ALREADY_DECIDED",
  "VERIFICATION_REQUEST_IN_PROGRESS",
  "VERIFICATION_REQUEST_NOT_FOUND",
  "VERIFICATION_REQUIRES_ORG_OWNER",
  "WAIVER_NOT_FOUND",
  // ── platform ──
  "CANNOT_CHANGE_OWN_STATUS",
  "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY",
  "CANNOT_DELETE_BUILTIN_PRESET",
  "CANNOT_DELETE_OWN_ACCOUNT",
  "CANNOT_DELETE_SOLE_ORG_OWNER",
  "CANNOT_OVERWRITE_BUILTIN_PRESET",
  "CONFIRMATION_PHRASE_MISMATCH",
  "FEATURED_ITEM_TARGET_NOT_FOUND",
  "FEATURED_ITEM_TARGET_NOT_PUBLIC",
  "PRESET_NOT_FOUND",
  "STAFF_ONLY",
  // ── pos ──
  "AMOUNT_MUST_BE_POSITIVE",
  "CASH_AMOUNT_SHORT",
  "CASH_REFUND_WINDOW_CLOSED",
  "EVENT_NOT_ORG_OWNED",
  "GATE_REFUND_WINDOW_EXPIRED",
  "NOT_A_CASH_ORDER",
  "NOT_A_POS_CARD_ORDER",
  "NOT_A_POS_ORDER",
  "PAYEE_CHARGES_DISABLED",
  "PAYEE_MISSING_STRIPE_ACCOUNT",
  "PAYEE_NOT_CONNECTED",
  "POS_READER_ALREADY_PAIRED",
  "POS_READER_BUSY",
  "POS_READER_NOT_FOUND",
  "POS_READER_OFFLINE",
  "POS_READER_ORG_MISMATCH",
  "POS_READER_REGISTRATION_CODE_INVALID",
  "SEAT_UNAVAILABLE",
  "SEARCH_UPDATE_RETRY",
  "TICKET_TYPE_TEMPORARILY_HELD",
  // ── profiles ──
  "AVATAR_KEY_NOT_OWNED",
  "BANNER_KEY_NOT_OWNED",
  "UPLOADED_AVATAR_NOT_FOUND",
  "UPLOADED_BANNER_NOT_FOUND",
  // ── promos ──
  "END_BEFORE_START",
  "GLOBAL_SCOPE_DISABLED",
  "PROMO_EXPIRED",
  "PROMO_NOT_FOUND",
  "PROMO_NOT_OWNED",
  "SCOPE_REQUIRES_SCOPE_ID",
  "TICKET_TYPE_SCOPE_UNSUPPORTED",
  // ── quotas ──
  "EXPANSION_REQUEST_ALREADY_PENDING",
  "EXPANSION_REQUEST_ALREADY_REVIEWED",
  "EXPANSION_REQUEST_NOT_FOUND",
  "QUOTA_EXCEEDED",
  "REQUESTED_LIMIT_NOT_HIGHER",
  // ── resale ──
  "AGREEMENT_MISSING",
  "AGREEMENT_MISSING_FEE_POLICY",
  "CANNOT_BUY_OWN_LISTING",
  "CLAIM_ALREADY_EXISTS",
  "CLAIM_ALREADY_RESOLVED",
  "CLAIM_NOT_RESALE_ORDER",
  "CLAIM_NOT_RESPONDENT",
  "CLAIM_TICKET_NOT_HELD",
  "CLAIM_APPROVAL_TICKET_NOT_HELD",
  "CLAIM_RESPONSE_DEADLINE_PASSED",
  "CLAIM_WINDOW_EXPIRED",
  "CLAIM_WINDOW_NOT_OPEN",
  "LISTING_ALREADY_HELD",
  "LISTING_NOT_ACTIVE",
  "LISTING_NOT_FOUND",
  "RESALE_NOT_ALLOWED_FOR_TYPE",
  "RESALE_NOT_ENABLED",
  "RESALE_PRICE_EXCEEDS_CAP",
  "RESALE_PURCHASE_PRICE_UNKNOWN",
  "RESALE_UNWIND_MISSING_LISTING_ID",
  "SALE_CUTOFF_PASSED",
  "SELLER_PAYOUT_NOT_SETUP",
  "TICKET_NOT_ELIGIBLE_FOR_RESALE",
  // ── scanner ──
  "MISSING_TARGET",
  "TARGET_LACKS_SCANNER_ROLE",
  "TARGET_NOT_FOUND",
  "TARGET_NOT_MEMBER",
  // ── series ──
  "EVENT_ALREADY_IN_SERIES",
  "EVENT_START_NOT_IN_SCHEDULE",
  "INVALID_DATETIME",
  "OCCURRENCE_DUPLICATE_DATE",
  "OCCURRENCE_NOT_FOUND",
  "OCCURRENCE_NOT_SKIPPABLE",
  "OCCURRENCE_NOT_SKIPPED",
  "SERIES_INACTIVE",
  "SERIES_NAME_TAKEN",
  "SERIES_NOT_FOUND",
  "SERIES_SCHEDULE_INVALID",
  "OPEN_CALL_NOT_FOUND",
  "OPEN_CALL_COVERED_BY_SERIES",
  "SERIES_OPEN_CALL_CONFLICT",
  "OPEN_CALL_NOT_REOPENABLE",
  "OPEN_CALL_CLOSED",
  "OPEN_CALL_DATES_REQUIRED",
  "OPEN_CALL_DATE_INVALID",
  "OPEN_CALL_APPLICATION_NOT_FOUND",
  "OPEN_CALL_LINK_EXPIRED",
  "OPEN_CALL_APPLICATION_LOCKED",
  "OPEN_CALL_APPLICATION_DECIDED",
  "OPEN_CALL_APPLICATION_SUPERSEDED",
  "OPEN_CALL_THREAD_CLOSED",
  "OPEN_CALL_VOTE_OWN_APPLICATION",
  "OPEN_CALL_APPLICATION_WITHDRAWN",
  "OPEN_CALL_APPLICATION_NOT_PICKED",
  "OPEN_CALL_DATE_UNAVAILABLE",
  "TEMPLATE_NOT_ACTIVE",
  "WINDOW_BOUNDS_REQUIRED",
  "WINDOW_END_BEFORE_START",
  // ── settlements ──
  "EVENT_MISSING_PAYOUT_TERMS",
  "NO_SPLITS_FOUND",
  "ORDER_DISPUTED",
  "ORDER_NOT_SUCCEEDED",
  "PAYEE_PAYOUTS_DISABLED",
  "SETTLEMENT_NOT_FOUND",
  // ── stripe-connect ──
  "NOT_CONNECTED",
  "PAYOUTS_NOT_ENABLED",
  // ── support ──
  "OWNER_CAN_ONLY_ESCALATE",
  "SUPPORT_THREAD_UNAVAILABLE",
  "THREAD_NOT_FOUND",
  // ── synthetic ──
  "NETWORK",
  // ── ticket-types ──
  "PAID_TICKETING_REQUIRES_FEE_POLICY",
  "PAID_TICKETING_REQUIRES_STRIPE",
  "SUGGESTED_BELOW_MINIMUM",
  "TICKET_TYPE_HAS_SALES",
  "TICKET_TYPE_LOCKED_BY_SALES",
  "TICKET_TYPE_NAME_TAKEN",
  "TICKET_TYPE_NOT_YET_ON_SALE",
  "TICKET_TYPE_SALES_ENDED",
  "TICKET_TYPE_SALES_WINDOW_INVALID",
  "TICKET_TYPE_SCHEDULE_INCOMPLETE",
  // ── tickets ──
  "CANNOT_TRANSFER_TO_SELF",
  "CLIENT_KEY_TOO_SHORT",
  "EMAIL_MISMATCH",
  "INVALID_ARGUMENT",
  "INVALID_ORDER_ITEM",
  "ORDER_REQUIRED_FOR_RESALE",
  "PENDING_TRANSFER_ALREADY_EXISTS",
  "PENDING_TRANSFER_EXPIRED",
  "PENDING_TRANSFER_NOT_FOUND",
  "RECIPIENT_ALREADY_HAS_ACCOUNT",
  "RESALE_DISABLED_FOR_EVENT",
  "SEAT_ALLOCATION_MISMATCH",
  "SEAT_ASSIGNMENT_COUNT_MISMATCH",
  "TICKET_ALREADY_OWNED_BY_TARGET",
  "TICKET_ITEM_MISSING_TICKET_TYPE",
  "TICKET_NOT_FOUND",
  "TICKET_NOT_SCANNED",
  "TICKET_NOT_TRANSFERABLE",
  "TICKET_NO_LONGER_OWNED_BY_SENDER",
  "TICKET_REFUND_IN_PROGRESS",
  "TICKET_TRANSFER_EVENT_PAST",
  "TICKET_UNDER_CLAIM",
  "TICKET_TYPE_SOLD_OUT",
  "UNDO_WINDOW_EXPIRED",
  // ── transport ──
  "CHARGEBACK_TERMS_REQUIRED",
  "CONFLICT",
  "INVALID_INPUT",
  "NOT_CONFIGURED",
  "NOT_FOUND",
  "INVITE_ALLOWANCE_EXCEEDED",
  "INVITE_RESEND_TOO_SOON",
  "INVITES_PAUSED",
  "RATE_LIMITED",
  "REFUND_POLICY_REQUIRED",
  "SCANNER_TERMS_REQUIRED",
  "TERMS_REQUIRED",
  "TRANSIENT",
  // ── volunteering ──
  "ALREADY_SIGNED_UP",
  "PHONE_REQUIRED_FOR_SMS",
  "ROLE_FULL",
  "ROLE_NOT_FOUND",
  "SHIFT_FULL",
  "SHIFT_NOT_FOUND",
  "SHIFT_SIGNUPS_PAUSED",
  "SIGNUP_MISSING_HUMAN",
  "SIGNUP_NOT_APPROVED",
  "SIGNUP_NOT_FOUND",
  "SIGNUP_NOT_REVIEWABLE",
  "SIGNUP_NOT_WITHDRAWABLE",
  "TOKEN_EVENT_MISMATCH",
  "VOLUNTEERING_DISABLED",
  "VOLUNTEER_APPROVALS_PAUSED",
  "VOLUNTEER_QR_EXPIRED",
  "VOLUNTEER_QR_INVALID",
  "VOLUNTEER_QR_WRONG_EVENT",
  "VOLUNTEER_PACK_NOT_FOUND",
  "VOLUNTEER_PACK_KEY_TAKEN",
  "VOLUNTEER_PACK_HAS_PLATFORM_ROLES",
  // ── ticket-type packs ──
  "TICKET_PACK_NOT_FOUND",
  "TICKET_PACK_KEY_TAKEN",
  "TICKET_PACK_HAS_PLATFORM_TEMPLATES",
  // ── waivers ──
  "EVENT_NOT_IN_ORG",
  "PLATFORM_TEMPLATE_READONLY",
  "WAIVER_TEMPLATE_NOT_ACCESSIBLE",
  "WAIVER_TEMPLATE_NOT_FOUND",
  "WAIVER_TEMPLATE_NOT_OWNED",
  // ── follow-up: legacy-throw migration ──
  "CLAIM_NOT_FOUND",
  "INVALID_BLOCK_DATA",
  "INVALID_BLOCK_KIND",
  "WALLET_PASS_NOT_CONFIGURED",
  // ── attendee reviews ──
  "ATTENDEE_REVIEW_ALREADY_SUBMITTED",
  "ATTENDEE_REVIEW_EVENT_NOT_ENDED",
  "ATTENDEE_REVIEW_WINDOW_CLOSED",
  // ═══════════════ INTERNAL (i18n-exempt) ═══════════════
  "AGREEMENT_LINE_PERSIST_FAILED",
  "APPLICATION_TOKEN_EXPIRED",
  "APPLICATION_TOKEN_INVALID",
  "CUSTOM",
  "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
  "DISPUTE_EVIDENCE_NOT_FOUND",
  "DISPUTE_EVIDENCE_STATE_INVALID",
  "DISPUTE_EVIDENCE_SUBMIT_FAILED",
  "DISPUTE_NOT_ACCEPTING_EVIDENCE",
  "DISPUTE_NOT_FOUND",
  "DISPUTE_TARGET_OWNER_MISSING",
  "EMAIL_DELIVERY_FAILED",
  "EMBED_DOMAIN_INVALID",
  "EMBED_LINK_OUT_ONLY",
  "EMBED_ORIGIN_NOT_ALLOWED",
  "INTERNAL",
  "JOB_MODULE_LOAD_FAILED",
  "MAILER_NOT_CONFIGURED",
  "MISSING_IN_APP_PREFERENCES",
  "NOTIFICATIONS_REPO_UNAVAILABLE",
  "OCCURRENCE_ALLOCATION_CONFLICT",
  "OCCURRENCE_ALLOCATION_FAILED",
  "ORDER_DISPUTED_REFUND_BLOCKED",
  "ORDER_HAS_PAYMENT_INTENT",
  "ORDER_RELOAD_FAILED",
  "PLACE_LAYOUT_PARSER_ERROR",
  "REFUND_FAILED",
  "REFUND_NOT_SUCCEEDED",
  "REFUND_REJECTED",
  "RESALE_ORIGINAL_ITEM_REFUNDED",
  "SECOND_FACTOR_REQUIRED",
  "SERVICE_UNAVAILABLE",
  "SETTLEMENT_RELOAD_FAILED",
  "SMS_SEND_FAILED",
  "SPLITS_CAPS_UNSATISFIABLE",
  "STORAGE_ERROR",
  // ── P4b (deal terms) ──
  "DEAL_REMAINDER_UNRESOLVED",
  "DEAL_FROZEN",
  "SETTLEMENT_SHEET_SETTLED",
  "SETTLEMENT_SHEET_NOT_SETTLED",
  "SETTLEMENT_EVENT_NOT_ENDED",
  "SETTLEMENT_SHEET_INCOMPLETE",
  "SETTLEMENT_EVENT_NOT_PUBLISHED",
  "PAYOUT_LINES_TOTAL_INVALID",
  "SETTLEMENT_ENTRY_NOT_FOUND",
  // ── arrival areas ──
  "ARRIVAL_AREA_NOT_FOUND",
  "ARRIVAL_AREA_CONFLICT",
  "ARRIVAL_AREA_LIMIT_REACHED",
  "ARRIVAL_AREA_INVALID_GEOMETRY",
] as const satisfies readonly AppErrorCode[];

/**
 * Reverse drift guard (union → array): fails to compile unless every union
 * member is also listed in {@link APP_ERROR_CODES}.
 */
type ListedCode = (typeof APP_ERROR_CODES)[number];
const _exhaustive: AppErrorCode extends ListedCode ? true : never = true;
void _exhaustive;

/**
 * User-facing tier — each code MUST have en+es `errors.*` copy (parity-gated).
 */
export const USER_FACING_CODES = [
  "AGREEMENT_NOT_EDITABLE",
  "AGREEMENT_PERCENT_TOTAL_EXCEEDED",
  "ANOTHER_ACTIVE_AGREEMENT_EXISTS",
  "APPLICATION_ALREADY_SUBMITTED",
  "APPLICATION_ANSWERS_INCOMPLETE",
  "APPLICATION_CAP_REACHED",
  "APPLICATION_SUBMISSIONS_EXIST",
  "APPLICATION_WINDOW_CLOSED",
  "APPLICATION_WINDOW_NOT_OPEN",
  "CANNOT_READ_OTHER_HUMAN_DEFAULTS",
  "CANNOT_SET_DEFAULTS_FOR_ANOTHER_HUMAN",
  "DUPLICATE_PAYEE",
  "EVENT_ARCHIVED",
  "FEE_POLICY_NOT_ACTIVE",
  "FEE_POLICY_NOT_FOUND",
  "FEE_POLICY_OUT_OF_SCOPE",
  "HUMAN_MISMATCH",
  "INSUFFICIENT_ROLE",
  "INVALID_LINE_REFERENCE",
  "MULTIPLE_ACTIVE_AGREEMENTS",
  "NO_PAYOUT_TERMS_CONFIGURED",
  "ORGANIZATION_INACTIVE",
  "ORGANIZATION_NOT_FOUND",
  "PAYEE_ALREADY_ASSIGNED",
  "PAYEE_CHANGE_NOT_ALLOWED",
  "PAYEE_NOT_ACTIVE",
  "PAYOUT_TERMS_NOT_FOUND",
  "ACTOR_EMAIL_NOT_FOUND",
  "INVALID_UNSUBSCRIBE_TOKEN",
  "API_KEY_ALREADY_REVOKED",
  "API_KEY_NOT_FOUND",
  "EMAIL_NOT_VERIFIED",
  "USER_ALREADY_EXISTS",
  "ACT_RESPONSE_ONLY",
  "AGREEMENT_FINALIZED",
  "AGREEMENT_LINE_NOT_FOUND",
  "AGREEMENT_LINKED_TO_OTHER_EVENT",
  "AGREEMENT_MISSING_PAYOUT_TERMS",
  "AGREEMENT_NOT_ACCEPTED",
  "AGREEMENT_NOT_CANCELLABLE",
  "AGREEMENT_NOT_DRAFT",
  "AGREEMENT_NOT_FOUND",
  "AGREEMENT_NOT_PROPOSED",
  "EVENT_ALREADY_HAS_AGREEMENT",
  "INVALID_STATUS",
  "LINES_UNCONFIRMED",
  "NOT_AGREEMENT_PARTY",
  "PAYEE_NOT_READY",
  "PROPOSED_END_BEFORE_START",
  "TERMS_EDITOR_ONLY",
  "BOOKING_DATE_UNAVAILABLE",
  "BOOKING_REQUEST_EXPIRED",
  "BOOKING_REQUEST_NOT_FOUND",
  "BOOKING_REQUEST_NOT_PENDING",
  "CANNOT_BOOK_OWN_ACT",
  "DUPLICATE_OPEN_REQUEST",
  "PERFORMER_MODE_REQUIRED",
  "PERFORMER_NOT_ACCEPTING_REQUESTS",
  "PLACE_ID_REQUIRED",
  "PLACE_NOT_ACCEPTING_REQUESTS",
  "PLACE_NOT_VERIFIED",
  // ── P3a (unclaimed venues) ──
  "PLACE_NOT_TAKING_REQUESTS",
  // lineup-booking-requests v2 (spec 2026-09-25) — the bill
  "BILL_NOT_ALLOWED",
  "ACT_NOT_TAGGABLE",
  "ACT_ALREADY_DECLINED",
  // lineup-booking-requests v3 — the bill is fixed once the event exists
  "BILL_LOCKED",
  // ── booking-holds (spec 2026-08-25) ──
  "BOOKING_HOLD_NOT_FOUND",
  "HOLD_ALREADY_PLACED",
  "HOLD_LINE_ALREADY_CONFIRMED",
  "BOOKING_HOLD_NOT_LIVE",
  "BOOKING_HOLD_NOT_FIRST",
  "BOOKING_HOLD_CHALLENGE_OPEN",
  "BOOKING_HOLD_NOT_CHALLENGED",
  "BOOKING_HOLD_CHALLENGE_LAPSED",
  "BOOKING_HOLDS_VENUE_ONLY",
  // holds-without-a-request (FR-005 holder unique, H13 answers)
  "BOOKING_HOLD_HOLDER_EXISTS",
  "CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE",
  "HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST",
  "HOLD_LINE_HAS_OPEN_CHALLENGE",
  "HOLD_LINE_CHANGED",
  "HOLD_DATE_MISMATCHES_EVENT",
  "BOOKING_TERMS_NOT_FINALIZED",
  "BOOKING_TAG_NOT_FOUND",
  "BOOKING_TAG_SLUG_TAKEN",
  "BOOKING_ASSIGNEE_NOT_ELIGIBLE",
  "BOOKING_ASSIGNMENT_NOT_APPLICABLE",
  // venue-booking-standards (spec 2026-09-25) — unmet REQUIRED pitch items
  "STANDARDS_UNMET",
  // booking-the-night (spec 2026-09-25) — agree & book, book without terms,
  // cancel booking
  // NIGHT_TAKEN is venue-side only; its meta names another party's hold — the
  // sender's agree path uses NIGHT_NO_LONGER_AVAILABLE.
  "NIGHT_TAKEN",
  "NIGHT_NO_LONGER_AVAILABLE",
  "DATE_NOT_ASKED_FOR",
  "HOLD_CONFIRM_RETIRED",
  "NO_ACT_READY",
  "VENUE_CONFIRMATION_NOT_FOR_REQUESTS",
  "BOOKING_NOT_CANCELLABLE",
  "BOOKING_ALREADY_HAS_NIGHT",
  "TERMS_SENT_FOR_ANOTHER_NIGHT",
  "TERMS_CHANGED_SINCE_VIEWED",
  "EVENT_ON_ANOTHER_NIGHT",
  "EVENT_FIRST_ORIGIN_GONE",
  "LINKED_EVENT_NOT_LIVE",
  "PLACE_NOT_TAKING_BOOKINGS",
  "TERMS_AGREED_FOR_ANOTHER_NIGHT",
  "BOOKING_CANCELLED",
  "BOOKING_NIGHT_BOOKED",
  "EVENT_ON_ANOTHER_CALENDAR",
  "BOOKING_HAS_MULTIPLE_EVENTS",
  "EVENT_FIRST_REQUIRES_ORIGIN_EVENT",
  "EVENT_OWNER_NOT_BOOKING_PARTY",
  // ── booking-the-night P2d-1 (saved reasons) ──
  "SAVED_SNIPPET_LIMIT_REACHED",
  "SAVED_SNIPPET_NOT_FOUND",
  "SAVED_SNIPPET_ORDER_CHANGED",
  // ── booking-the-night P2d-2 ──
  "TERMS_AGREED_FOR_THIS_NIGHT",
  // ── P3b (asks) ──
  "BOOKING_ASK_NOT_FOUND",
  "CATEGORY_ALREADY_EXISTS",
  "CATEGORY_ENGLISH_NAME_REQUIRED",
  "CATEGORY_INACTIVE",
  "CATEGORY_NOT_FOUND",
  "CATEGORY_REQUEST_ALREADY_REVIEWED",
  "CATEGORY_REQUEST_NOT_FOUND",
  "CATEGORY_SLUG_TAKEN",
  "INVALID_CATEGORY_REQUEST_NAME",
  "INVALID_CATEGORY_SLUG",
  "ACTOR_MISMATCH",
  "CHANNEL_INELIGIBLE",
  "CONTACT_MUST_HAVE_EMAIL_OR_PHONE",
  "CROSS_OWNER_MERGE_NOT_ALLOWED",
  "EVENT_NOT_COMPLETED",
  "IMPORT_ALREADY_COMPLETED",
  "IMPORT_NOT_FOUND",
  "IMPORT_OWNER_MISMATCH",
  "INVALID_NOTIFICATION_PAYLOAD",
  "LIST_OWNER_MISMATCH",
  "NO_UPDATES_PROVIDED",
  "PHONE_FORMAT_INVALID",
  "SOURCE_CANNOT_BE_TARGET",
  "TARGET_LIST_NAME_REQUIRED_FOR_NEW_LIST",
  "TARGET_LIST_NOT_FOUND",
  "TAX_JURISDICTION_UNAVAILABLE",
  "TAX_JURISDICTION_UNSUPPORTED",
  "TAX_RATE_UNAVAILABLE",
  // Promoted INTERNAL → USER_FACING with the Sell screen's "Enter tax rate"
  // dialog (door-sales step 9a), which reads `meta.reason` for its own line.
  "MANUAL_TAX_RATE_NOT_ALLOWED",
  "TOKEN_EXPIRED",
  "TOKEN_HUMAN_MISMATCH",
  "TOKEN_INVALID",
  "TOKEN_NOT_SUPPORTED",
  "TOKEN_SCOPE_MISMATCH",
  "TRANSACTIONAL_CANNOT_BE_DISABLED",
  "UNKNOWN_NOTIFICATION_CATEGORY",
  "UNKNOWN_NOTIFICATION_VARIANT",
  "EDIT_SUGGESTION_ALREADY_REVIEWED",
  "EDIT_SUGGESTION_INVALID_FIELDS",
  "EDIT_SUGGESTION_NOT_FOUND",
  "EVENT_DATE_IN_PAST",
  "EVENT_DATE_NOT_FOUND",
  "EVENT_DATE_NOT_RSVPABLE",
  "EVENT_NOT_COMMUNITY",
  "EVENT_NOT_TICKETED",
  "MODERATOR_APPLICATION_ALREADY_PENDING",
  "MODERATOR_APPLICATION_ALREADY_REVIEWED",
  "MODERATOR_APPLICATION_NOT_FOUND",
  "RECURRENCE_HAS_NO_UPCOMING_DATES",
  "EVENT_CANCELLED",
  "EXPIRES_AT_IN_PAST",
  "CANNOT_DELEGATE_TO_SELF",
  "DELEGATE_SELF_BENEFIT_FORBIDDEN",
  "DELEGATION_NOT_FOUND",
  "STRIPE_EVENT_CONFLICT",
  "DOMAIN_MISMATCH",
  "EMBED_NOT_FOUND",
  "SEAT_SECTION_NOT_FOUND",
  "TURNSTILE_TOKEN_REQUIRED",
  "TURNSTILE_VERIFICATION_FAILED",
  "UNSUPPORTED_SUBJECT_TYPE",
  "BLOCK_NOT_FOUND",
  "BLOCK_PINNED",
  "INVALID_BLOCK_ORDER",
  "OWNER_NOT_FOUND",
  "PAGE_IMAGE_KEY_NOT_OWNED",
  "PAGE_NOT_FOUND",
  "SLUG_TAKEN",
  "UNKNOWN_OWNER_TYPE",
  "UPLOADED_PAGE_IMAGE_NOT_FOUND",
  "EVENT_HUMAN_NOT_FOUND",
  "HUMAN_ID_OR_EXTERNAL_NAME_REQUIRED",
  "EVENT_NOT_DRAFT",
  "SAVED_LOCATION_NOT_FOUND",
  "TEMPLATE_ARCHIVED",
  "TEMPLATE_INACTIVE",
  "TEMPLATE_NAME_TAKEN",
  "TEMPLATE_NOT_FOUND",
  "UNKNOWN_OWNER_SCOPE",
  "ATTESTATION_INCOMPLETE",
  "AUDIO_UPLOAD_NOT_FOUND",
  "CURATED_UNTIL_BEFORE_EVENT",
  "CURATED_UNTIL_UNAVAILABLE",
  "EVENT_ALREADY_ARCHIVED",
  "EVENT_ALREADY_CANCELLED",
  "EVENT_ALREADY_COMPLETED",
  "EVENT_ALREADY_ENDED",
  "EVENT_CATEGORY_MISSING",
  "EVENT_GATED",
  "EVENT_HAS_ORDERS_USE_CANCEL_INSTEAD",
  "EVENT_LOCATION_REQUIRED",
  "EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE",
  "EVENT_MOVED",
  "EVENT_NOT_APPLICATION_GATED",
  "EVENT_NOT_ARCHIVABLE",
  "EVENT_NOT_CANCELLABLE",
  "EVENT_NOT_COMPLETABLE",
  "EVENT_NOT_DELETABLE",
  "EVENT_NOT_DRAFT_USE_CANCEL_INSTEAD",
  "EVENT_NOT_EDITABLE",
  "EVENT_NOT_FOUND",
  "EVENT_NOT_ON_SALE",
  "EVENT_NOT_PASSWORD_GATED",
  "EVENT_NOT_PUBLISHABLE",
  "EVENT_NOT_PUBLISHED",
  "EVENT_PASSWORD_CHALLENGE_REQUIRED",
  "EVENT_PASSWORD_INVALID",
  "EVENT_PASSWORD_MISSING",
  "EVENT_SLUG_CONFLICT",
  "EVENT_SLUG_CONTEXT_MISSING",
  "EVENT_SLUG_MISSING",
  "EVENT_SLUG_REDIRECT",
  "EVENT_SLUG_REGENERATION_NOT_ALLOWED",
  "EVENT_WAS_PUBLISHED",
  "EXPIRATION_MUST_BE_FUTURE",
  "FORBIDDEN",
  "FORM_MISMATCH",
  "FORM_NOT_FOUND",
  "IDEMPOTENCY_KEY_CONFLICT",
  "IDEMPOTENCY_LOCK_IN_PROGRESS",
  "IMAGES_WRONG_EVENT",
  "IMAGE_NOT_FOUND",
  "INVALID_TIME_WINDOW",
  "LINEUP_ROW_ALREADY_REGISTERED",
  "MAGIC_LINK_ALREADY_REDEEMED",
  "MAGIC_LINK_EXPIRED",
  "MAGIC_LINK_NOT_FOUND",
  "MAGIC_LINK_WRONG_RECIPIENT",
  "NOT_AUTHORIZED",
  "NOT_RESOURCE_OWNER",
  "NO_RANDOM_EVENT_AVAILABLE",
  "OPTIONS_NOT_ALLOWED",
  "OPTIONS_REQUIRED",
  "PASSWORD_REQUIRED",
  "PLACE_NOT_ACTIVE",
  "PRIMARY_AGREEMENT_MISSING",
  "QUESTION_NOT_FOUND",
  "RESALE_TERMS_MISSING",
  "RESALE_SHARE_IN_USE",
  "RESALE_SPLITS_OVER_TOTAL",
  "SPLITS_TOTAL_INVALID",
  "STRIPE_NOT_CONNECTED_OWNER",
  "SUBMISSION_EVENT_MISMATCH",
  "SUBMISSION_NOT_FOUND",
  "SUBMISSION_NOT_REVIEWED",
  "TICKETS_ALREADY_ISSUED",
  "TICKET_TYPES_REQUIRED",
  "TICKET_TYPE_CAPACITY_INVALID",
  "TICKET_TYPE_EVENT_MISMATCH",
  "TICKET_TYPE_NOT_FOUND",
  "TICKET_TYPE_SCOPE_ONLY_VALID_FOR_PRIMARY",
  "TOKEN_EXPIRATION_IN_PAST",
  "UPLOAD_NOT_COMPLETE",
  "WAITLIST_FULL",
  "WAITLIST_NOT_OPEN",
  "WAITLIST_PUBLISH_AT_REQUIRED",
  "FOLLOWS_DISABLED",
  "FOLLOW_NOT_FOUND",
  "SELF_FOLLOW_NOT_ALLOWED",
  "CURRENT_PASSWORD_INVALID",
  "CURRENT_PASSWORD_REQUIRED",
  "FORCE_VERIFY_HOLDS_EMAIL_ATTACHED",
  "HUMAN_NOT_FOUND",
  "SCANNER_TERMS_VERSION_MISMATCH",
  "ACTOR_NOT_FOUND",
  "AGREEMENT_MISSING_LINES",
  "AMOUNT_MISMATCH",
  "BUYER_MUST_BE_ACTOR",
  "CREDIT_BALANCE_CHANGED",
  "CURRENCY_MISMATCH",
  "DONATION_AMOUNT_REQUIRED",
  "DONATION_BELOW_MINIMUM",
  "DUPLICATE_PROMO",
  "EVENTS_DIFFERENT_ORG",
  "EVENTS_DIFFERENT_OWNER",
  "EVENT_MISMATCH",
  "EVENT_SALES_CLOSED",
  "EXPECTED_PAID_ORDER",
  "EXPECTED_TICKETING_ORDER",
  "INSUFFICIENT_CAPACITY",
  "ITEMS_NOT_REFUNDABLE",
  "NON_POSITIVE_AMOUNT",
  "NO_ORDERS_TO_MIGRATE",
  "NO_PAYEE_SUBJECT",
  "NO_REFUNDABLE_ITEMS",
  "NO_STRIPE_ACCOUNT",
  "NO_TICKET_TYPES",
  "ORDER_ALREADY_REFUNDED",
  "ORDER_EMPTY",
  "ORDER_EVENT_MISMATCH",
  "ORDER_ITEM_NOT_FOUND",
  "ORDER_NON_REFUNDABLE",
  "REFUND_WINDOW_CLOSED",
  "RESALE_ORDER_USE_FULL_REFUND",
  "CLAIM_REFUND_PENDING",
  "ORDER_NOT_FOUND",
  "ORDER_NOT_FREE",
  "ORDER_NOT_IN_ORG",
  "ORDER_NOT_OWNED",
  "ORDER_NOT_PAID",
  "ORDER_NOT_PENDING",
  "ORDER_NOT_PROCESSABLE",
  "ORDER_NOT_REFUNDABLE",
  "PAYMENT_INTENT_MISMATCH",
  "PAYMENT_INTENT_ORDER_MISMATCH",
  "PAYMENT_NOT_SUCCEEDED",
  "PRIMARY_ORDER_RESALE_LINKED_TRANSFER_REQUIRES_MANUAL_REVIEW",
  "PROMO_MAX_REDEEMED",
  "PROMO_MIN_ORDER_NOT_MET",
  "PROMO_NOT_APPLICABLE",
  "PROMO_NOT_STACKABLE",
  "PROMO_REDEEMED_BY_HUMAN",
  "QTY_EXCEEDS_ORDER",
  "REFUND_AMOUNT_ZERO",
  "REFUND_NOT_TERMINAL",
  "SEAT_ASSIGNMENT_QTY_MISMATCH",
  "SEAT_DUPLICATE_IN_REQUEST",
  "SEAT_IDS_DUPLICATE",
  "SEAT_IDS_INVALID",
  "SEAT_IDS_NOT_ASSIGNED",
  "SEAT_IDS_REQUIRED",
  "SEAT_NOT_FOUND",
  "SEAT_NOT_IN_ORDER",
  "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER",
  "SEAT_PRICE_OVERRIDE_NO_FIXED_TIER",
  "SEAT_SECTION_MISMATCH",
  "SEAT_TAKEN",
  "SOURCE_AND_TARGET_MUST_DIFFER",
  "STRIPE_NOT_CONNECTED",
  "TARGET_EVENT_NOT_ACTIVE",
  "TICKETS_MISSING",
  "TICKET_ITEM_NOT_FOUND",
  "TICKET_NOT_VALID",
  "TICKET_TYPE_NOT_SEATED",
  "WAIVER_REQUIRED",
  "ALREADY_A_MEMBER",
  "CANNOT_DEMOTE_LAST_OWNER",
  "CANNOT_REMOVE_LAST_OWNER",
  "INVITATION_EXPIRED",
  "INVITATION_NOT_FOUND",
  "INVITATION_NOT_PENDING",
  "MEMBER_NOT_FOUND",
  "MEMBERSHIPS_SUSPENDED",
  "MEMBERSHIP_NOT_FOUND",
  "MEMBERSHIP_BENEFIT_INVALID_TERMS",
  "MEMBERSHIP_BENEFIT_NOT_FOUND",
  "MEMBERSHIP_TIER_ARCHIVED",
  "MEMBERSHIP_TIER_NOT_ACTIVE",
  "MEMBERSHIP_TIER_NOT_FOUND",
  "MEMBERSHIP_TIER_PRICE_LOCKED",
  "ORG_ALREADY_ARCHIVED",
  "ORG_HAS_ACTIVE_EVENTS",
  "ORG_NOT_FOUND",
  "COUNTER_FIELDS_REQUIRED",
  "LINE_DECLINED",
  "LINE_DOES_NOT_REQUIRE_CONFIRMATION",
  "LINE_NOT_COUNTERABLE",
  "LINE_NOT_DECLINABLE",
  "PAYEE_NOT_FOUND",
  "PAYOUT_LINE_NOT_FOUND",
  "SCHEDULED_FOR_IN_PAST",
  "IDEMPOTENCY_KEY_REQUIRED",
  "PLACE_LAYOUT_EMPTY",
  "PLACE_LAYOUT_NOT_FOUND",
  "SEAT_IDS_NOT_UNIQUE",
  "PLACE_COMMUNITY_REVIEWS_DISABLED",
  "PLACE_STATS_NOT_FOUND",
  "REVIEW_ALREADY_FLAGGED",
  "REVIEW_ALREADY_HIDDEN",
  "REVIEW_ALREADY_RESPONDED",
  "REVIEW_NOT_FOUND",
  "REVIEW_NOT_HIDDEN",
  "AVAILABILITY_NOT_FOUND",
  // ── places: venue hierarchy (promoted to user-facing in Step 6) ──
  "CALENDAR_NOT_FOUND",
  "CALENDAR_REQUIRES_ACTIVE_SPACE",
  "CALENDAR_SLUG_TAKEN",
  "CANNOT_RETIRE_LAST_ACTIVE_SPACE",
  "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
  "SPACE_NOT_FOUND",
  // ── places: claim venue (claim-venue-flow spec) ──
  "PLACE_ALREADY_CLAIMED",
  "PLACE_NOT_CLAIMABLE",
  "CLAIM_ALREADY_PENDING",
  "CLAIM_LIMIT_REACHED",
  "CLAIM_PROOF_REQUIRED",
  "CLAIM_EMAIL_DOMAIN_MISMATCH",
  "CLAIM_FREE_EMAIL_NOT_ALLOWED",
  "CLAIM_PLACE_HAS_NO_WEBSITE",
  "CLAIM_CHALLENGE_NOT_FOUND",
  "CLAIM_CHALLENGE_EXPIRED",
  "CLAIM_CHALLENGE_LOCKED",
  "CLAIM_CHALLENGE_CODE_INVALID",
  "CLAIM_CHALLENGE_NOT_VERIFIED",
  "CLAIM_DISPUTE_NOT_APPLICABLE",
  "DOCUMENTS_REQUIRED",
  "DOCUMENT_DELETED",
  "DOCUMENT_NOT_FOUND",
  "NOT_LOCK_HOLDER",
  "PLACE_ALREADY_EXISTS",
  "PLACE_ARCHIVED",
  "PLACE_HAS_OWNER",
  "PLACE_HAS_LIVE_LISTINGS",
  "PLACE_ALREADY_VERIFIED",
  "PLACE_NOT_ELIGIBLE_FOR_VERIFICATION",
  "PLACE_NOT_FOUND",
  "REUSE_SOURCE_NOT_OWNED",
  "REUSE_SOURCE_STILL_ACTIVE",
  "TOO_MANY_DOCUMENTS",
  "VERIFICATION_ALREADY_PENDING",
  "VERIFICATION_LOCKED_TO_OTHER_REVIEWER",
  "VERIFICATION_NOT_IN_REVIEW",
  "VERIFICATION_NOT_PENDING",
  "VERIFICATION_REQUEST_ALREADY_DECIDED",
  "VERIFICATION_REQUEST_IN_PROGRESS",
  "VERIFICATION_REQUEST_NOT_FOUND",
  "VERIFICATION_REQUIRES_ORG_OWNER",
  "WAIVER_NOT_FOUND",
  "CANNOT_CHANGE_OWN_STATUS",
  "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY",
  "CANNOT_DELETE_BUILTIN_PRESET",
  "CANNOT_DELETE_OWN_ACCOUNT",
  "CANNOT_DELETE_SOLE_ORG_OWNER",
  "CANNOT_OVERWRITE_BUILTIN_PRESET",
  "CONFIRMATION_PHRASE_MISMATCH",
  "FEATURED_ITEM_TARGET_NOT_FOUND",
  "FEATURED_ITEM_TARGET_NOT_PUBLIC",
  "PRESET_NOT_FOUND",
  "STAFF_ONLY",
  "AMOUNT_MUST_BE_POSITIVE",
  // Promoted INTERNAL → USER_FACING with the web Sell screen's quote UI
  // (door-sales step 9a). The till also reads `meta.requiredTotalCents`.
  "CASH_AMOUNT_SHORT",
  "EVENT_NOT_ORG_OWNED",
  "GATE_REFUND_WINDOW_EXPIRED",
  "NOT_A_CASH_ORDER",
  "NOT_A_POS_CARD_ORDER",
  "NOT_A_POS_ORDER",
  "PAYEE_CHARGES_DISABLED",
  "PAYEE_MISSING_STRIPE_ACCOUNT",
  "PAYEE_NOT_CONNECTED",
  "POS_READER_ALREADY_PAIRED",
  "POS_READER_BUSY",
  "POS_READER_NOT_FOUND",
  "POS_READER_OFFLINE",
  "POS_READER_ORG_MISMATCH",
  "POS_READER_REGISTRATION_CODE_INVALID",
  "SEAT_UNAVAILABLE",
  // Promoted INTERNAL → USER_FACING with door-sales step 9b: the Sell
  // screen's cash-sales list and the org Orders panel's "Refund cash sale"
  // show it, and each also shows the closed window itself.
  "CASH_REFUND_WINDOW_CLOSED",
  "SEARCH_UPDATE_RETRY",
  "TICKET_TYPE_TEMPORARILY_HELD",
  "AVATAR_KEY_NOT_OWNED",
  "BANNER_KEY_NOT_OWNED",
  "UPLOADED_AVATAR_NOT_FOUND",
  "UPLOADED_BANNER_NOT_FOUND",
  "END_BEFORE_START",
  "GLOBAL_SCOPE_DISABLED",
  "PROMO_EXPIRED",
  "PROMO_NOT_FOUND",
  "PROMO_NOT_OWNED",
  "SCOPE_REQUIRES_SCOPE_ID",
  "TICKET_TYPE_SCOPE_UNSUPPORTED",
  "EXPANSION_REQUEST_ALREADY_PENDING",
  "EXPANSION_REQUEST_ALREADY_REVIEWED",
  "EXPANSION_REQUEST_NOT_FOUND",
  "QUOTA_EXCEEDED",
  "REQUESTED_LIMIT_NOT_HIGHER",
  "AGREEMENT_MISSING",
  "AGREEMENT_MISSING_FEE_POLICY",
  "CANNOT_BUY_OWN_LISTING",
  "CLAIM_ALREADY_EXISTS",
  "CLAIM_ALREADY_RESOLVED",
  "CLAIM_NOT_RESALE_ORDER",
  "CLAIM_NOT_RESPONDENT",
  "CLAIM_TICKET_NOT_HELD",
  "CLAIM_APPROVAL_TICKET_NOT_HELD",
  "CLAIM_RESPONSE_DEADLINE_PASSED",
  "CLAIM_WINDOW_EXPIRED",
  "CLAIM_WINDOW_NOT_OPEN",
  "LISTING_ALREADY_HELD",
  "LISTING_NOT_ACTIVE",
  "LISTING_NOT_FOUND",
  "RESALE_NOT_ALLOWED_FOR_TYPE",
  "RESALE_NOT_ENABLED",
  "RESALE_PRICE_EXCEEDS_CAP",
  "RESALE_PURCHASE_PRICE_UNKNOWN",
  "RESALE_UNWIND_MISSING_LISTING_ID",
  "SALE_CUTOFF_PASSED",
  "SELLER_PAYOUT_NOT_SETUP",
  "TICKET_NOT_ELIGIBLE_FOR_RESALE",
  "MISSING_TARGET",
  "TARGET_LACKS_SCANNER_ROLE",
  "TARGET_NOT_FOUND",
  "TARGET_NOT_MEMBER",
  "EVENT_ALREADY_IN_SERIES",
  "EVENT_START_NOT_IN_SCHEDULE",
  "INVALID_DATETIME",
  "OCCURRENCE_DUPLICATE_DATE",
  "OCCURRENCE_NOT_FOUND",
  "OCCURRENCE_NOT_SKIPPABLE",
  "OCCURRENCE_NOT_SKIPPED",
  "SERIES_INACTIVE",
  "SERIES_NAME_TAKEN",
  "SERIES_NOT_FOUND",
  "SERIES_SCHEDULE_INVALID",
  "OPEN_CALL_NOT_FOUND",
  "OPEN_CALL_COVERED_BY_SERIES",
  "SERIES_OPEN_CALL_CONFLICT",
  "OPEN_CALL_NOT_REOPENABLE",
  "OPEN_CALL_CLOSED",
  "OPEN_CALL_DATES_REQUIRED",
  "OPEN_CALL_DATE_INVALID",
  "OPEN_CALL_APPLICATION_NOT_FOUND",
  "OPEN_CALL_LINK_EXPIRED",
  "OPEN_CALL_APPLICATION_LOCKED",
  "OPEN_CALL_APPLICATION_DECIDED",
  "OPEN_CALL_APPLICATION_SUPERSEDED",
  "OPEN_CALL_THREAD_CLOSED",
  "OPEN_CALL_VOTE_OWN_APPLICATION",
  "OPEN_CALL_APPLICATION_WITHDRAWN",
  "OPEN_CALL_APPLICATION_NOT_PICKED",
  "OPEN_CALL_DATE_UNAVAILABLE",
  "TEMPLATE_NOT_ACTIVE",
  "WINDOW_BOUNDS_REQUIRED",
  "WINDOW_END_BEFORE_START",
  "EVENT_MISSING_PAYOUT_TERMS",
  "NO_SPLITS_FOUND",
  "ORDER_DISPUTED",
  "ORDER_NOT_SUCCEEDED",
  "PAYEE_PAYOUTS_DISABLED",
  "SETTLEMENT_NOT_FOUND",
  "NOT_CONNECTED",
  "PAYOUTS_NOT_ENABLED",
  "OWNER_CAN_ONLY_ESCALATE",
  "SUPPORT_THREAD_UNAVAILABLE",
  "THREAD_NOT_FOUND",
  "NETWORK",
  "PAID_TICKETING_REQUIRES_FEE_POLICY",
  "PAID_TICKETING_REQUIRES_STRIPE",
  "SUGGESTED_BELOW_MINIMUM",
  "TICKET_TYPE_HAS_SALES",
  "TICKET_TYPE_LOCKED_BY_SALES",
  "TICKET_TYPE_NAME_TAKEN",
  "TICKET_TYPE_NOT_YET_ON_SALE",
  "TICKET_TYPE_SALES_ENDED",
  "TICKET_TYPE_SALES_WINDOW_INVALID",
  "TICKET_TYPE_SCHEDULE_INCOMPLETE",
  "CANNOT_TRANSFER_TO_SELF",
  "CLIENT_KEY_TOO_SHORT",
  "EMAIL_MISMATCH",
  "INVALID_ARGUMENT",
  "INVALID_ORDER_ITEM",
  "ORDER_REQUIRED_FOR_RESALE",
  "PENDING_TRANSFER_ALREADY_EXISTS",
  "PENDING_TRANSFER_EXPIRED",
  "PENDING_TRANSFER_NOT_FOUND",
  "RECIPIENT_ALREADY_HAS_ACCOUNT",
  "RESALE_DISABLED_FOR_EVENT",
  "SEAT_ALLOCATION_MISMATCH",
  "SEAT_ASSIGNMENT_COUNT_MISMATCH",
  "TICKET_ALREADY_OWNED_BY_TARGET",
  "TICKET_ITEM_MISSING_TICKET_TYPE",
  "TICKET_NOT_FOUND",
  "TICKET_NOT_SCANNED",
  "TICKET_NOT_TRANSFERABLE",
  "TICKET_NO_LONGER_OWNED_BY_SENDER",
  "TICKET_REFUND_IN_PROGRESS",
  "TICKET_TRANSFER_EVENT_PAST",
  "TICKET_UNDER_CLAIM",
  "TICKET_TYPE_SOLD_OUT",
  "UNDO_WINDOW_EXPIRED",
  "CHARGEBACK_TERMS_REQUIRED",
  "CONFLICT",
  "INVALID_INPUT",
  "NOT_CONFIGURED",
  "NOT_FOUND",
  "INVITE_ALLOWANCE_EXCEEDED",
  "INVITE_RESEND_TOO_SOON",
  "INVITES_PAUSED",
  "RATE_LIMITED",
  "REFUND_POLICY_REQUIRED",
  "SCANNER_TERMS_REQUIRED",
  "TERMS_REQUIRED",
  "TRANSIENT",
  "ALREADY_SIGNED_UP",
  "PHONE_REQUIRED_FOR_SMS",
  "ROLE_FULL",
  "ROLE_NOT_FOUND",
  "SHIFT_FULL",
  "SHIFT_NOT_FOUND",
  "SHIFT_SIGNUPS_PAUSED",
  "SIGNUP_MISSING_HUMAN",
  "SIGNUP_NOT_APPROVED",
  "SIGNUP_NOT_FOUND",
  "SIGNUP_NOT_REVIEWABLE",
  "SIGNUP_NOT_WITHDRAWABLE",
  "TOKEN_EVENT_MISMATCH",
  "VOLUNTEERING_DISABLED",
  "VOLUNTEER_APPROVALS_PAUSED",
  "VOLUNTEER_QR_EXPIRED",
  "VOLUNTEER_QR_INVALID",
  "VOLUNTEER_QR_WRONG_EVENT",
  "VOLUNTEER_PACK_NOT_FOUND",
  "VOLUNTEER_PACK_KEY_TAKEN",
  "VOLUNTEER_PACK_HAS_PLATFORM_ROLES",
  "TICKET_PACK_NOT_FOUND",
  "TICKET_PACK_KEY_TAKEN",
  "TICKET_PACK_HAS_PLATFORM_TEMPLATES",
  "EVENT_NOT_IN_ORG",
  "PLATFORM_TEMPLATE_READONLY",
  "WAIVER_TEMPLATE_NOT_ACCESSIBLE",
  "WAIVER_TEMPLATE_NOT_FOUND",
  "WAIVER_TEMPLATE_NOT_OWNED",
  "CLAIM_NOT_FOUND",
  "INVALID_BLOCK_DATA",
  "INVALID_BLOCK_KIND",
  "WALLET_PASS_NOT_CONFIGURED",
  "ATTENDEE_REVIEW_ALREADY_SUBMITTED",
  "ATTENDEE_REVIEW_EVENT_NOT_ENDED",
  "ATTENDEE_REVIEW_WINDOW_CLOSED",
  // ── P4b (deal terms) ──
  "DEAL_REMAINDER_UNRESOLVED",
  "DEAL_FROZEN",
  "SETTLEMENT_SHEET_SETTLED",
  "SETTLEMENT_SHEET_NOT_SETTLED",
  "SETTLEMENT_EVENT_NOT_ENDED",
  "SETTLEMENT_SHEET_INCOMPLETE",
  "SETTLEMENT_EVENT_NOT_PUBLISHED",
  "PAYOUT_LINES_TOTAL_INVALID",
  "SETTLEMENT_ENTRY_NOT_FOUND",
  // ── arrival areas (plan step 6: the `arrivalAreas.*` procedures) ──
  "ARRIVAL_AREA_NOT_FOUND",
  "ARRIVAL_AREA_CONFLICT",
  "ARRIVAL_AREA_LIMIT_REACHED",
  "ARRIVAL_AREA_INVALID_GEOMETRY",
] as const satisfies readonly AppErrorCode[];

/**
 * Internal tier — typed + enumerable but i18n-EXEMPT. Resolve to a generic
 * safe fallback; the parity test asserts these are ABSENT from the catalog.
 */
export const INTERNAL_CODES = [
  // holds-without-a-request: promote with copy when plan steps 6–9 give
  // request-less holds their own actions.
  "BOOKING_HOLD_NEEDS_REQUEST",
  // holds-without-a-request FR-003: promote with en + es copy when plan step
  // 9 ships the `placeBookingGrants.*` procedures.
  "PLACE_BOOKING_GRANT_NOT_FOUND",
  "PLACE_BOOKING_GRANT_NOT_PENDING",
  "PLACE_BOOKING_GRANT_ENDED",
  "PLACE_BOOKING_GRANT_EXISTS",
  "PLACE_BOOKING_GRANT_GRANTEE_INVALID",
  "PLACE_BOOKING_GRANT_SCOPE_HAS_HOLDS",
  "AGREEMENT_LINE_PERSIST_FAILED",
  "APPLICATION_TOKEN_EXPIRED",
  "APPLICATION_TOKEN_INVALID",
  "CUSTOM",
  "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
  "DISPUTE_EVIDENCE_NOT_FOUND",
  "DISPUTE_EVIDENCE_STATE_INVALID",
  "DISPUTE_EVIDENCE_SUBMIT_FAILED",
  "DISPUTE_NOT_ACCEPTING_EVIDENCE",
  "DISPUTE_NOT_FOUND",
  "DISPUTE_TARGET_OWNER_MISSING",
  "EMAIL_DELIVERY_FAILED",
  "EMBED_DOMAIN_INVALID",
  "EMBED_LINK_OUT_ONLY",
  "EMBED_ORIGIN_NOT_ALLOWED",
  "INTERNAL",
  "JOB_MODULE_LOAD_FAILED",
  "MAILER_NOT_CONFIGURED",
  "MISSING_IN_APP_PREFERENCES",
  "NOTIFICATIONS_REPO_UNAVAILABLE",
  // PROMOTE-LATER: concurrent ordinal allocation race — see union comment.
  "OCCURRENCE_ALLOCATION_CONFLICT",
  "OCCURRENCE_ALLOCATION_FAILED",
  "ORDER_DISPUTED_REFUND_BLOCKED",
  // `updateOrderItems` on a PI-linked cart — see union comment.
  "ORDER_HAS_PAYMENT_INTENT",
  "ORDER_RELOAD_FAILED",
  "PLACE_LAYOUT_PARSER_ERROR",
  "REFUND_ALREADY_ISSUED_FOR_ITEMS",
  "REFUND_FAILED",
  "REFUND_METADATA_ORDER_MISMATCH",
  "REFUND_NOT_SUCCEEDED",
  "RECURRENCE_DROP_WOULD_CANCEL_RSVPS",
  "REFUND_REJECTED",
  // PROMOTE-LATER (needs en/es catalog copy) — see union comments.
  "RESALE_ORIGINAL_ITEM_REFUNDED",
  "SECOND_FACTOR_REQUIRED",
  "SERVICE_UNAVAILABLE",
  "SETTLEMENT_RELOAD_FAILED",
  "SMS_SEND_FAILED",
  // PROMOTE-LATER (needs en/es catalog copy) — see union comment.
  "SPLITS_CAPS_UNSATISFIABLE",
  "STORAGE_ERROR",
] as const satisfies readonly AppErrorCode[];

/**
 * Tier partition guard: every {@link AppErrorCode} must belong to exactly one
 * of {@link USER_FACING_CODES} / {@link INTERNAL_CODES}. This assertion proves
 * the UNION (no code is in neither tier); the `satisfies` above prove no tier
 * entry is a non-code; disjointness (no code in BOTH) is asserted at runtime in
 * the codes unit test.
 */
type TieredCode =
  | (typeof USER_FACING_CODES)[number]
  | (typeof INTERNAL_CODES)[number];
const _partitioned: AppErrorCode extends TieredCode ? true : never = true;
void _partitioned;

const APP_ERROR_CODE_SET: ReadonlySet<string> = new Set(APP_ERROR_CODES);
const INTERNAL_CODE_SET: ReadonlySet<AppErrorCode> = new Set(INTERNAL_CODES);

/** Whether a canonical code is internal-tier (i18n-exempt, never user-shown). */
export function isInternalCode(code: AppErrorCode): boolean {
  return INTERNAL_CODE_SET.has(code);
}

/**
 * User-facing copy for an unreachable API host. Hardcoded English — the
 * resolver returns this directly rather than going through the i18n catalog.
 */
export const NETWORK_ERROR_MESSAGE =
  "We couldn't reach Ithas Fire. Check your connection and try again.";

/**
 * Map a canonical `AppErrorCode` to its camelCase `errors.*` i18n key.
 * SCREAMING_SNAKE → camelCase, e.g. `EVENT_NOT_FOUND` → `eventNotFound`.
 *
 * NOTE: codes must be digit-free for the round-trip test's reverse transform to
 * hold. No current union member has a digit; keep it that way.
 */
export function toKey(code: AppErrorCode): string {
  return code
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Normalize a legacy snake_case (or already-SCREAMING) token into a canonical
 * {@link AppErrorCode} by direct union membership. Returns `null` for unknown
 * tokens so callers fall back to humanization / generic copy.
 *
 * Used at the tRPC boundary to resolve the domain code carried in a legacy
 * `{ code, message }` throw (e.g. zod field-validation messages) and on the
 * client to map Better Auth shapes. The P1 collapse/rename aliases that this
 * once consulted are retired: every throw site now uses the canonical code
 * directly (the codemod + rbac migration), so a plain upcase + Set lookup is
 * exhaustive.
 *
 * e.g. `event_not_found` → `EVENT_NOT_FOUND`; `made_up_code` → `null`.
 */
export function fromLegacyCode(raw: string): AppErrorCode | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const upper = raw.toUpperCase();
  return APP_ERROR_CODE_SET.has(upper) ? (upper as AppErrorCode) : null;
}
