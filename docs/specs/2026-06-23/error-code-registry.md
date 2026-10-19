# Error-Code Registry — P1 harvest & triage

> **Status:** P1 output (analysis only — NO throw sites or the `AppErrorCode`
> union were touched). Canonical/tier/httpCategory/disposition for every distinct
> domain code harvested from `packages/core/src/use-cases` + `packages/ports/src`.
> **All NEEDS_DECISION items signed off by the user 2026-06-23** (see the resolved
> section + Canonical meta conventions below). P2 (build the typed registry) is
> unblocked — pending in-flight follow-up B (curate union + i18n parity test)
> landing first, so P2 extends it. P3 (codemod) additionally gates on GREEN typecheck.

Spec: [error-code-registry-and-dedup.spec.yaml](./error-code-registry-and-dedup.spec.yaml)
Machine map (P2/P3 consumes this): [error-code-map.ts](./error-code-map.ts)

## Totals

| Metric | Count |
| --- | --- |
| Distinct domain codes harvested | 489 |
| → KEEP (own canonical) | 408 |
| → COLLAPSE (merge into another) | 64 |
| → INTERNAL (typed, i18n-exempt) | 17 |
| → NEEDS_DECISION (user sign-off) | 0 |
| **Projected canonical user-facing codes** | **409** |
| **Projected canonical internal codes** | **17** |
| **Projected total canonical codes** | **426** |
| New canonical codes not yet in the union | 368 |

## Rubric

- **tier** — `user-facing` (end user can understand/act → needs en+es `errors.*` keys, parity-gated) vs `internal` (infra/dependency/invariant failure → typed but i18n-exempt, never shown raw).
- **httpCategory** — the transport bucket the canonical code maps to (`appCodeToTrpc`). **Heuristic-inferred for KEEP rows from the token shape — review the 4xx choice.** No user-facing code is allowed to resolve to `INTERNAL_SERVER_ERROR`.
- **disposition** — `KEEP` | `COLLAPSE→<canonical>` | `INTERNAL` | `NEEDS_DECISION`.
- **meta** — for collapses, the specificity preserved on the wire so identity is not lost (e.g. `{entity:"place"}`).
- ⚠️ marks a **risky collapse**: members differ in user copy and/or HTTP status today.

## NEEDS_DECISION — RESOLVED (signed off 2026-06-23)

All items the harvest flagged for user decision are resolved:

| Legacy code(s) | Decision |
| --- | --- |
| `not_authorized` (6×) | KEEP as general `NOT_AUTHORIZED`; P3 resolves each site per use-case → `INSUFFICIENT_ROLE` (+`meta.allowedRoles`) / `NOT_RESOURCE_OWNER` / stays `NOT_AUTHORIZED`. |
| `not_place_owner_or_staff`, `not_submitter_or_staff` | Collapse → `NOT_AUTHORIZED` (owner/submitter-OR-staff composites are the general authz concept). |
| `resale_agreement_missing` (+ `_fee_policy`, `_lines`) | Collapse → the shared `AGREEMENT_*` codes with `meta.scope:"resale"` — resale & agreements are one structure. |
| `event_slug_missing` / `_conflict` / `_redirect` | KEEP all three distinct. |
| `owner_can_only_escalate` | KEEP its own code (special-case action restriction). |
| `NOT_RESOURCE_OWNER` cluster (23 codes) | Collapse all 23 → `NOT_RESOURCE_OWNER` with `meta.entity`. |

## Collapse clusters

| Canonical target | ← members | n |
| --- | --- | --- |
| `NOT_RESOURCE_OWNER` | `event_owner_mismatch`, `not_place_owner`, `not_event_owner`, `not_owner`, `not_page_owner`, `not_authorized_for_place`, `actor_must_be_owner`, `not_order_owner`, `not_payee_owner`, `not_signup_owner`, `not_thread_owner`, `template_event_owner_mismatch`, `human_not_owner`, `must_be_human_owner`, `not_authorized_to_manage_event`, `not_request_owner`, `not_ticket_owner`, `not_transfer_initiator`, `org_does_not_own_place`, `org_not_owner`, `owner_mismatch`, `series_owner_mismatch`, `template_owner_mismatch` | 23 |
| `INSUFFICIENT_ROLE` | `insufficient_permissions`, `not_event_editor`, `insufficient_org_role`, `no_scanner_role`, `not_org_member`, `not_payee_org_admin`, `not_place_admin`, `admin_role_required`, `not_authorized_to_verify_place`, `not_org_admin`, `only_principal_can_add_delegates`, `only_principal_can_list_delegates`, `only_principal_can_remove_delegates`, `only_principal_can_update_delegates`, `print_token_requires_org_edit_role` | 15 |
| `HUMAN_NOT_FOUND` | `agreement_owner_not_found`, `buyer_not_found`, `event_owner_missing`, `human_not_found_for_email`, `payee_human_not_found`, `series_owner_not_found`, `template_owner_not_found` | 7 |
| `EVENT_NOT_FOUND` | `event_slug_not_found`, `event_not_found_for_terms`, `source_event_not_found`, `target_event_not_found` | 4 |
| `NOT_AUTHORIZED` | `not_place_owner_or_staff`, `not_submitter_or_staff` | 2 |
| `PLACE_NOT_FOUND` | `reuse_source_not_found`, `target_place_not_found` | 2 |
| `STAFF_ONLY` | `staff_access_required` | 1 |
| `PAGE_NOT_FOUND` | `entity_page_not_found` | 1 |
| `AGREEMENT_MISSING` | `resale_agreement_missing` | 1 |
| `AGREEMENT_MISSING_FEE_POLICY` | `resale_agreement_missing_fee_policy` | 1 |
| `FEE_POLICY_NOT_FOUND` | `resale_fee_policy_not_found` | 1 |
| `LISTING_NOT_FOUND` | `resale_unwind_listing_not_found` | 1 |
| `TICKET_NOT_FOUND` | `resale_unwind_ticket_not_found` | 1 |
| `ORDER_NOT_FOUND` | `comp_order_not_found` | 1 |
| `DUPLICATE_PROMO` | `duplicate_promo_code` | 1 |
| `ORGANIZATION_NOT_FOUND` | `payee_org_not_found` | 1 |
| `AGREEMENT_MISSING_LINES` | `resale_agreement_missing_lines` | 1 |

## Canonical meta conventions (resolved with user, 2026-06-23)

- **`INSUFFICIENT_ROLE`** carries `meta.allowedRoles` — which role(s) *can* perform the action (so the client/copy can say what's required).
- **`NOT_RESOURCE_OWNER`** carries `meta.entity` — which resource the caller doesn't own.
- **`NOT_AUTHORIZED`** — general authz-denied bucket for mixed/composite gates (owner-OR-staff, etc.). `not_authorized`'s 6 sites are resolved per-use-case in P3 (→ `INSUFFICIENT_ROLE` / `NOT_RESOURCE_OWNER` / stays `NOT_AUTHORIZED`).
- **`AGREEMENT_*`** absorbs the resale variants (`resale_agreement_*`) with `meta.scope:"resale"` — reselling and agreements are one structure.

## Per-domain detail

### agreements (24)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `organization_not_found` | 17 | message | `ORGANIZATION_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `event_archived` | 7 | message | `EVENT_ARCHIVED` | user-facing | CONFLICT | KEEP |  |  |
| `insufficient_role` | 7 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | KEEP |  | already in union |
| `organization_inactive` | 7 | message | `ORGANIZATION_INACTIVE` | user-facing | CONFLICT | KEEP |  | already in union |
| `custom` | 6 | code | `CUSTOM` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `fee_policy_not_found` | 3 | message | `FEE_POLICY_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `payout_terms_not_found` | 3 | message | `PAYOUT_TERMS_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `no_payout_terms_configured` | 2 | message | `NO_PAYOUT_TERMS_CONFIGURED` | user-facing | CONFLICT | KEEP |  |  |
| `payee_already_assigned` | 2 | message | `PAYEE_ALREADY_ASSIGNED` | user-facing | CONFLICT | KEEP |  |  |
| `payee_change_not_allowed` | 2 | message | `PAYEE_CHANGE_NOT_ALLOWED` | user-facing | CONFLICT | KEEP |  |  |
| `payee_not_active` | 2 | message | `PAYEE_NOT_ACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `agreement_line_persist_failed` | 1 | message | `AGREEMENT_LINE_PERSIST_FAILED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `agreement_not_editable` | 1 | message | `AGREEMENT_NOT_EDITABLE` | user-facing | CONFLICT | KEEP |  |  |
| `agreement_owner_not_found` | 1 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→HUMAN_NOT_FOUND | `{"role":"agreement_owner"}` |  |
| `agreement_percent_total_exceeds_100` | 1 | message | `AGREEMENT_PERCENT_TOTAL_EXCEEDS_100` | user-facing | INVALID_INPUT | KEEP |  |  |
| `another_active_agreement_exists` | 1 | message | `ANOTHER_ACTIVE_AGREEMENT_EXISTS` | user-facing | CONFLICT | KEEP |  |  |
| `cannot_read_other_human_defaults` | 1 | message | `CANNOT_READ_OTHER_HUMAN_DEFAULTS` | user-facing | FORBIDDEN | KEEP |  |  |
| `cannot_set_defaults_for_another_human` | 1 | message | `CANNOT_SET_DEFAULTS_FOR_ANOTHER_HUMAN` | user-facing | FORBIDDEN | KEEP |  |  |
| `duplicate_payee` | 1 | message | `DUPLICATE_PAYEE` | user-facing | CONFLICT | KEEP |  |  |
| `fee_policy_not_active` | 1 | message | `FEE_POLICY_NOT_ACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `fee_policy_out_of_scope` | 1 | message | `FEE_POLICY_OUT_OF_SCOPE` | user-facing | CONFLICT | KEEP |  |  |
| `human_mismatch` | 1 | message | `HUMAN_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `invalid_line_reference` | 1 | message | `INVALID_LINE_REFERENCE` | user-facing | INVALID_INPUT | KEEP |  |  |
| `multiple_active_agreements` | 1 | message | `MULTIPLE_ACTIVE_AGREEMENTS` | user-facing | CONFLICT | KEEP |  |  |

### announcements (6)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `internal` | 3 | code | `INTERNAL` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `invalid_unsubscribe_token` | 3 | message | `INVALID_UNSUBSCRIBE_TOKEN` | user-facing | INVALID_INPUT | KEEP |  |  |
| `actor_email_not_found` | 1 | message | `ACTOR_EMAIL_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `email_delivery_failed` | 1 | message | `EMAIL_DELIVERY_FAILED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `mailer_not_configured` | 1 | message | `MAILER_NOT_CONFIGURED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `service_unavailable` | 1 | code | `SERVICE_UNAVAILABLE` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |

### api-keys (2)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `api_key_already_revoked` | 1 | message | `API_KEY_ALREADY_REVOKED` | user-facing | CONFLICT | KEEP |  |  |
| `api_key_not_found` | 1 | message | `API_KEY_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |

### auth (1)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sms_send_failed` | 1 | message | `SMS_SEND_FAILED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |

### booking-agreements (16)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `invalid_status` | 13 | code | `INVALID_STATUS` | user-facing | INVALID_INPUT | KEEP |  | already in union |
| `agreement_not_found` | 9 | message | `AGREEMENT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `agreement_finalized` | 5 | message | `AGREEMENT_FINALIZED` | user-facing | CONFLICT | KEEP |  |  |
| `agreement_line_not_found` | 3 | message | `AGREEMENT_LINE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `agreement_missing_payout_terms` | 2 | message | `AGREEMENT_MISSING_PAYOUT_TERMS` | user-facing | CONFLICT | KEEP |  |  |
| `agreement_not_accepted` | 2 | message | `AGREEMENT_NOT_ACCEPTED` | user-facing | CONFLICT | KEEP |  |  |
| `agreement_not_draft` | 2 | message | `AGREEMENT_NOT_DRAFT` | user-facing | CONFLICT | KEEP |  |  |
| `agreement_not_proposed` | 2 | message | `AGREEMENT_NOT_PROPOSED` | user-facing | CONFLICT | KEEP |  |  |
| `event_already_has_agreement` | 2 | both | `EVENT_ALREADY_HAS_AGREEMENT` | user-facing | CONFLICT | KEEP |  | already in union |
| `lines_unconfirmed` | 2 | both | `LINES_UNCONFIRMED` | user-facing | CONFLICT | KEEP |  | already in union |
| `payee_not_ready` | 2 | both | `PAYEE_NOT_READY` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `agreement_linked_to_other_event` | 1 | message | `AGREEMENT_LINKED_TO_OTHER_EVENT` | user-facing | CONFLICT | KEEP |  |  |
| `not_agreement_party` | 1 | message | `NOT_AGREEMENT_PARTY` | user-facing | FORBIDDEN | KEEP |  |  |
| `payee_human_not_found` | 1 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→HUMAN_NOT_FOUND | `{"role":"payee"}` |  |
| `payee_org_not_found` | 1 | message | `ORGANIZATION_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→ORGANIZATION_NOT_FOUND | `{"role":"payee"}` |  |
| `proposed_end_before_start` | 1 | message | `PROPOSED_END_BEFORE_START` | user-facing | INVALID_INPUT | KEEP |  |  |

### booking-requests (9)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `booking_request_not_found` | 5 | message | `BOOKING_REQUEST_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `place_not_verified` | 5 | both | `PLACE_NOT_VERIFIED` | user-facing | CONFLICT | KEEP |  | already in union |
| `booking_request_expired` | 2 | message | `BOOKING_REQUEST_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |
| `duplicate_open_request` | 2 | both | `DUPLICATE_OPEN_REQUEST` | user-facing | CONFLICT | KEEP |  | already in union |
| `insufficient_org_role` | 2 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `performer_mode_required` | 2 | both | `PERFORMER_MODE_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `place_not_accepting_requests` | 2 | both | `PLACE_NOT_ACCEPTING_REQUESTS` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `booking_request_not_pending` | 1 | message | `BOOKING_REQUEST_NOT_PENDING` | user-facing | CONFLICT | KEEP |  |  |
| `place_id_required` | 1 | message | `PLACE_ID_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### categories (6)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `category_not_found` | 4 | message | `CATEGORY_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `invalid_category_request_name` | 4 | message | `INVALID_CATEGORY_REQUEST_NAME` | user-facing | INVALID_INPUT | KEEP |  |  |
| `category_already_exists` | 1 | message | `CATEGORY_ALREADY_EXISTS` | user-facing | CONFLICT | KEEP |  |  |
| `category_inactive` | 1 | message | `CATEGORY_INACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `category_request_already_reviewed` | 1 | message | `CATEGORY_REQUEST_ALREADY_REVIEWED` | user-facing | CONFLICT | KEEP |  |  |
| `category_request_not_found` | 1 | message | `CATEGORY_REQUEST_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |

### comms (25)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `channel_ineligible` | 4 | message | `CHANNEL_INELIGIBLE` | user-facing | CONFLICT | KEEP |  |  |
| `phone_must_be_e164` | 2 | message | `PHONE_MUST_BE_E164` | user-facing | INVALID_INPUT | KEEP |  |  |
| `target_list_not_found` | 2 | message | `TARGET_LIST_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `token_invalid` | 2 | message | `TOKEN_INVALID` | user-facing | INVALID_INPUT | KEEP |  |  |
| `actor_mismatch` | 1 | message | `ACTOR_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `contact_must_have_email_or_phone` | 1 | message | `CONTACT_MUST_HAVE_EMAIL_OR_PHONE` | user-facing | INVALID_INPUT | KEEP |  |  |
| `cross_owner_merge_not_allowed` | 1 | message | `CROSS_OWNER_MERGE_NOT_ALLOWED` | user-facing | CONFLICT | KEEP |  |  |
| `event_not_completed` | 1 | message | `EVENT_NOT_COMPLETED` | user-facing | CONFLICT | KEEP |  |  |
| `import_already_completed` | 1 | message | `IMPORT_ALREADY_COMPLETED` | user-facing | CONFLICT | KEEP |  |  |
| `import_not_found` | 1 | message | `IMPORT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `import_owner_mismatch` | 1 | message | `IMPORT_OWNER_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `invalid_notification_payload` | 1 | message | `INVALID_NOTIFICATION_PAYLOAD` | user-facing | INVALID_INPUT | KEEP |  |  |
| `list_owner_mismatch` | 1 | message | `LIST_OWNER_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `missing_in_app_preferences` | 1 | message | `MISSING_IN_APP_PREFERENCES` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `no_updates_provided` | 1 | message | `NO_UPDATES_PROVIDED` | user-facing | CONFLICT | KEEP |  |  |
| `notifications_repo_unavailable` | 1 | message | `NOTIFICATIONS_REPO_UNAVAILABLE` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `source_cannot_be_target` | 1 | message | `SOURCE_CANNOT_BE_TARGET` | user-facing | CONFLICT | KEEP |  |  |
| `target_list_name_required_for_new_list` | 1 | message | `TARGET_LIST_NAME_REQUIRED_FOR_NEW_LIST` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `token_expired` | 1 | message | `TOKEN_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |
| `token_human_mismatch` | 1 | message | `TOKEN_HUMAN_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `token_not_supported` | 1 | message | `TOKEN_NOT_SUPPORTED` | user-facing | CONFLICT | KEEP |  |  |
| `token_scope_mismatch` | 1 | message | `TOKEN_SCOPE_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `transactional_cannot_be_disabled` | 1 | message | `TRANSACTIONAL_CANNOT_BE_DISABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `unknown_notification_category` | 1 | message | `UNKNOWN_NOTIFICATION_CATEGORY` | user-facing | CONFLICT | KEEP |  |  |
| `unknown_notification_variant` | 1 | message | `UNKNOWN_NOTIFICATION_VARIANT` | user-facing | CONFLICT | KEEP |  |  |

### comp (2)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `comp_order_not_found` | 1 | message | `ORDER_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→ORDER_NOT_FOUND | `{"kind":"comp"}` |  |
| `event_cancelled` | 1 | message | `EVENT_CANCELLED` | user-facing | CONFLICT | KEEP |  |  |

### credits (1)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `expires_at_in_past` | 1 | message | `EXPIRES_AT_IN_PAST` | user-facing | INVALID_INPUT | KEEP |  |  |

### delegates (6)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `delegation_not_found` | 2 | message | `DELEGATION_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `cannot_delegate_to_self` | 1 | message | `CANNOT_DELEGATE_TO_SELF` | user-facing | FORBIDDEN | KEEP |  |  |
| `only_principal_can_add_delegates` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | COLLAPSE→INSUFFICIENT_ROLE | `{"action":"add"}` |  |
| `only_principal_can_list_delegates` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | COLLAPSE→INSUFFICIENT_ROLE | `{"action":"list"}` |  |
| `only_principal_can_remove_delegates` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | COLLAPSE→INSUFFICIENT_ROLE | `{"action":"remove"}` |  |
| `only_principal_can_update_delegates` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | COLLAPSE→INSUFFICIENT_ROLE | `{"action":"update"}` |  |

### disputes (1)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `stripe_event_conflict` | 4 | message | `STRIPE_EVENT_CONFLICT` | user-facing | CONFLICT | KEEP |  |  |

### embeds (7)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `not_event_owner` | 8 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"event"}` |  |
| `embed_not_found` | 7 | message | `EMBED_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `unsupported_subject_type` | 6 | message | `UNSUPPORTED_SUBJECT_TYPE` | user-facing | CONFLICT | KEEP |  |  |
| `domain_mismatch` | 1 | message | `DOMAIN_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `seat_section_not_found` | 1 | message | `SEAT_SECTION_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `turnstile_token_required` | 1 | message | `TURNSTILE_TOKEN_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `turnstile_verification_failed` | 1 | message | `TURNSTILE_VERIFICATION_FAILED` | user-facing | CONFLICT | KEEP |  |  |

### entity-pages (10)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `not_place_owner` | 12 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"place"}` |  |
| `page_not_found` | 8 | message | `PAGE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `unknown_owner_type` | 7 | message | `UNKNOWN_OWNER_TYPE` | user-facing | CONFLICT | KEEP |  |  |
| `not_page_owner` | 6 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"page"}` |  |
| `block_not_found` | 4 | message | `BLOCK_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `owner_not_found` | 3 | message | `OWNER_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `invalid_block_order` | 1 | message | `INVALID_BLOCK_ORDER` | user-facing | INVALID_INPUT | KEEP |  |  |
| `page_image_key_not_owned` | 1 | message | `PAGE_IMAGE_KEY_NOT_OWNED` | user-facing | CONFLICT | KEEP |  |  |
| `slug_taken` | 1 | message | `SLUG_TAKEN` | user-facing | CONFLICT | KEEP |  |  |
| `uploaded_page_image_not_found` | 1 | message | `UPLOADED_PAGE_IMAGE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |

### event-humans (2)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `event_human_not_found` | 2 | message | `EVENT_HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `human_id_or_external_name_required` | 1 | message | `HUMAN_ID_OR_EXTERNAL_NAME_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### event-templates (11)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `template_not_found` | 9 | message | `TEMPLATE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `saved_location_not_found` | 4 | message | `SAVED_LOCATION_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `template_name_taken` | 4 | message | `TEMPLATE_NAME_TAKEN` | user-facing | CONFLICT | KEEP |  |  |
| `not_org_member` | 2 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `template_archived` | 2 | message | `TEMPLATE_ARCHIVED` | user-facing | CONFLICT | KEEP |  |  |
| `template_event_owner_mismatch` | 2 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"template"}` |  |
| `unknown_owner_scope` | 2 | message | `UNKNOWN_OWNER_SCOPE` | user-facing | CONFLICT | KEEP |  |  |
| `event_not_draft` | 1 | message | `EVENT_NOT_DRAFT` | user-facing | CONFLICT | KEEP |  | already in union |
| `template_inactive` | 1 | message | `TEMPLATE_INACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `template_owner_mismatch` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"template"}` |  |
| `template_owner_not_found` | 1 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→HUMAN_NOT_FOUND | `{"role":"template_owner"}` |  |

### events (72)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `forbidden` | 242 | both | `FORBIDDEN` | user-facing | FORBIDDEN | KEEP |  | already in union |
| `event_not_found` | 120 | message | `EVENT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `idempotency_key_conflict` | 71 | message | `IDEMPOTENCY_KEY_CONFLICT` | user-facing | CONFLICT | KEEP |  | already in union |
| `idempotency_lock_in_progress` | 49 | message | `IDEMPOTENCY_LOCK_IN_PROGRESS` | user-facing | CONFLICT | KEEP |  | already in union |
| `event_owner_mismatch` | 30 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"event"}` | high-traffic (30) |
| `ticket_type_not_found` | 11 | message | `TICKET_TYPE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `event_not_editable` | 9 | message | `EVENT_NOT_EDITABLE` | user-facing | CONFLICT | KEEP |  | already in union |
| `event_not_application_gated` | 7 | message | `EVENT_NOT_APPLICATION_GATED` | user-facing | CONFLICT | KEEP |  |  |
| `event_not_on_sale` | 6 | message | `EVENT_NOT_ON_SALE` | user-facing | CONFLICT | KEEP |  |  |
| `not_authorized` | 6 | message | `NOT_AUTHORIZED` | user-facing | FORBIDDEN | KEEP |  | KEEP as general authz code (user). P3 resolves each of 6 sites per use-case: → INSUFFICIENT_ROLE (+meta.allowedRoles) for role gates, → NOT_RESOURCE_OWNER for ownership, stays NOT_AUTHORIZED when mixed |
| `event_not_published` | 5 | message | `EVENT_NOT_PUBLISHED` | user-facing | CONFLICT | KEEP |  |  |
| `place_not_active` | 5 | message | `PLACE_NOT_ACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `stripe_not_connected_owner` | 4 | message | `STRIPE_NOT_CONNECTED_OWNER` | user-facing | CONFLICT | KEEP |  | already in union |
| `event_slug_not_found` | 3 | message | `EVENT_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→EVENT_NOT_FOUND | `{"via":"slug"}` |  |
| `not_event_editor` | 3 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `attestation_incomplete` | 2 | both | `ATTESTATION_INCOMPLETE` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `event_location_required` | 2 | message | `EVENT_LOCATION_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `event_not_password_gated` | 2 | message | `EVENT_NOT_PASSWORD_GATED` | user-facing | CONFLICT | KEEP |  |  |
| `event_slug_conflict` | 2 | message | `EVENT_SLUG_CONFLICT` | user-facing | CONFLICT | KEEP |  |  |
| `event_slug_context_missing` | 2 | message | `EVENT_SLUG_CONTEXT_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `event_slug_redirect` | 2 | message | `EVENT_SLUG_REDIRECT` | user-facing | CONFLICT | KEEP |  |  |
| `form_mismatch` | 2 | message | `FORM_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `form_not_found` | 2 | message | `FORM_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `primary_agreement_missing` | 2 | message | `PRIMARY_AGREEMENT_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `question_not_found` | 2 | message | `QUESTION_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `storage_error` | 2 | message | `STORAGE_ERROR` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `submission_event_mismatch` | 2 | message | `SUBMISSION_EVENT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `submission_not_found` | 2 | message | `SUBMISSION_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `upload_not_complete` | 2 | message | `UPLOAD_NOT_COMPLETE` | user-facing | CONFLICT | KEEP |  |  |
| `admin_role_required` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `audio_upload_not_found` | 1 | message | `AUDIO_UPLOAD_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `curated_until_before_event` | 1 | message | `CURATED_UNTIL_BEFORE_EVENT` | user-facing | CONFLICT | KEEP |  |  |
| `curated_until_unavailable` | 1 | message | `CURATED_UNTIL_UNAVAILABLE` | user-facing | CONFLICT | KEEP |  |  |
| `event_already_cancelled` | 1 | message | `EVENT_ALREADY_CANCELLED` | user-facing | CONFLICT | KEEP |  |  |
| `event_category_missing` | 1 | message | `EVENT_CATEGORY_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `event_has_orders_use_cancel_instead` | 1 | message | `EVENT_HAS_ORDERS_USE_CANCEL_INSTEAD` | user-facing | CONFLICT | KEEP |  |  |
| `event_not_cancellable` | 1 | message | `EVENT_NOT_CANCELLABLE` | user-facing | CONFLICT | KEEP |  |  |
| `event_not_deletable` | 1 | message | `EVENT_NOT_DELETABLE` | user-facing | CONFLICT | KEEP |  |  |
| `event_not_draft_use_cancel_instead` | 1 | message | `EVENT_NOT_DRAFT_USE_CANCEL_INSTEAD` | user-facing | CONFLICT | KEEP |  |  |
| `event_not_publishable` | 1 | message | `EVENT_NOT_PUBLISHABLE` | user-facing | CONFLICT | KEEP |  | already in union |
| `event_owner_missing` | 1 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→HUMAN_NOT_FOUND | `{"role":"event_owner"}` |  |
| `event_password_invalid` | 1 | message | `EVENT_PASSWORD_INVALID` | user-facing | INVALID_INPUT | KEEP |  |  |
| `event_password_missing` | 1 | message | `EVENT_PASSWORD_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `event_slug_missing` | 1 | message | `EVENT_SLUG_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `event_slug_regeneration_not_allowed` | 1 | message | `EVENT_SLUG_REGENERATION_NOT_ALLOWED` | user-facing | CONFLICT | KEEP |  |  |
| `event_was_published` | 1 | message | `EVENT_WAS_PUBLISHED` | user-facing | CONFLICT | KEEP |  |  |
| `expiration_must_be_future` | 1 | message | `EXPIRATION_MUST_BE_FUTURE` | user-facing | INVALID_INPUT | KEEP |  |  |
| `image_not_found` | 1 | message | `IMAGE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `images_wrong_event` | 1 | message | `IMAGES_WRONG_EVENT` | user-facing | CONFLICT | KEEP |  |  |
| `invalid_time_window` | 1 | message | `INVALID_TIME_WINDOW` | user-facing | INVALID_INPUT | KEEP |  |  |
| `lineup_row_already_registered` | 1 | message | `LINEUP_ROW_ALREADY_REGISTERED` | user-facing | CONFLICT | KEEP |  |  |
| `magic_link_already_redeemed` | 1 | message | `MAGIC_LINK_ALREADY_REDEEMED` | user-facing | CONFLICT | KEEP |  |  |
| `magic_link_expired` | 1 | message | `MAGIC_LINK_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |
| `magic_link_not_found` | 1 | message | `MAGIC_LINK_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `magic_link_wrong_recipient` | 1 | message | `MAGIC_LINK_WRONG_RECIPIENT` | user-facing | CONFLICT | KEEP |  |  |
| `no_random_event_available` | 1 | message | `NO_RANDOM_EVENT_AVAILABLE` | user-facing | CONFLICT | KEEP |  |  |
| `not_authorized_to_manage_event` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"event"}` |  |
| `options_not_allowed` | 1 | message | `OPTIONS_NOT_ALLOWED` | user-facing | CONFLICT | KEEP |  |  |
| `options_required` | 1 | message | `OPTIONS_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `password_required` | 1 | message | `PASSWORD_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `resale_terms_missing` | 1 | message | `RESALE_TERMS_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `splits_total_invalid` | 1 | message | `SPLITS_TOTAL_INVALID` | user-facing | INVALID_INPUT | KEEP |  |  |
| `submission_not_reviewed` | 1 | message | `SUBMISSION_NOT_REVIEWED` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_type_capacity_invalid` | 1 | message | `TICKET_TYPE_CAPACITY_INVALID` | user-facing | INVALID_INPUT | KEEP |  |  |
| `ticket_type_event_mismatch` | 1 | message | `TICKET_TYPE_EVENT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `ticket_type_scope_only_valid_for_primary` | 1 | message | `TICKET_TYPE_SCOPE_ONLY_VALID_FOR_PRIMARY` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_types_required` | 1 | message | `TICKET_TYPES_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `tickets_already_issued` | 1 | message | `TICKETS_ALREADY_ISSUED` | user-facing | CONFLICT | KEEP |  |  |
| `token_expiration_in_past` | 1 | message | `TOKEN_EXPIRATION_IN_PAST` | user-facing | INVALID_INPUT | KEEP |  |  |
| `waitlist_full` | 1 | message | `WAITLIST_FULL` | user-facing | CONFLICT | KEEP |  |  |
| `waitlist_not_open` | 1 | message | `WAITLIST_NOT_OPEN` | user-facing | CONFLICT | KEEP |  |  |
| `waitlist_publish_at_required` | 1 | message | `WAITLIST_PUBLISH_AT_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### follows (4)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `entity_page_not_found` | 2 | message | `PAGE_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→PAGE_NOT_FOUND |  |  |
| `follow_not_found` | 1 | message | `FOLLOW_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `follows_disabled` | 1 | message | `FOLLOWS_DISABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `self_follow_not_allowed` | 1 | message | `SELF_FOLLOW_NOT_ALLOWED` | user-facing | CONFLICT | KEEP |  |  |

### humans (4)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `human_not_found` | 25 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `insufficient_permissions` | 3 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `human_not_found_for_email` | 1 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→HUMAN_NOT_FOUND | `{"via":"email"}` |  |
| `scanner_terms_version_mismatch` | 1 | message | `SCANNER_TERMS_VERSION_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |

### orders (73)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `order_not_found` | 30 | message | `ORDER_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `actor_not_found` | 6 | message | `ACTOR_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `order_not_paid` | 5 | message | `ORDER_NOT_PAID` | user-facing | CONFLICT | KEEP |  |  |
| `stripe_not_connected` | 5 | message | `STRIPE_NOT_CONNECTED` | user-facing | CONFLICT | KEEP |  | already in union |
| `no_ticket_types` | 4 | message | `NO_TICKET_TYPES` | user-facing | CONFLICT | KEEP |  |  |
| `order_not_refundable` | 4 | message | `ORDER_NOT_REFUNDABLE` | user-facing | CONFLICT | KEEP |  | already in union |
| `seat_assignment_qty_mismatch` | 4 | message | `SEAT_ASSIGNMENT_QTY_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `seat_ids_invalid` | 4 | message | `SEAT_IDS_INVALID` | user-facing | INVALID_INPUT | KEEP |  |  |
| `agreement_missing_lines` | 3 | message | `AGREEMENT_MISSING_LINES` | user-facing | CONFLICT | KEEP |  |  |
| `currency_mismatch` | 3 | message | `CURRENCY_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `order_event_mismatch` | 3 | message | `ORDER_EVENT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `order_not_owned` | 3 | message | `ORDER_NOT_OWNED` | user-facing | CONFLICT | KEEP |  |  |
| `order_not_pending` | 3 | message | `ORDER_NOT_PENDING` | user-facing | CONFLICT | KEEP |  |  |
| `refund_not_succeeded` | 3 | message | `REFUND_NOT_SUCCEEDED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `refund_not_terminal` | 3 | message | `REFUND_NOT_TERMINAL` | user-facing | CONFLICT | KEEP |  |  |
| `seat_ids_duplicate` | 3 | message | `SEAT_IDS_DUPLICATE` | user-facing | CONFLICT | KEEP |  |  |
| `seat_not_found` | 3 | message | `SEAT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `waiver_required` | 3 | both | `WAIVER_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `buyer_must_be_actor` | 2 | message | `BUYER_MUST_BE_ACTOR` | user-facing | INVALID_INPUT | KEEP |  |  |
| `event_sales_closed` | 2 | message | `EVENT_SALES_CLOSED` | user-facing | CONFLICT | KEEP |  | already in union |
| `events_different_owner` | 2 | message | `EVENTS_DIFFERENT_OWNER` | user-facing | CONFLICT | KEEP |  |  |
| `no_stripe_account` | 2 | message | `NO_STRIPE_ACCOUNT` | user-facing | CONFLICT | KEEP |  |  |
| `non_positive_amount` | 2 | message | `NON_POSITIVE_AMOUNT` | user-facing | INVALID_INPUT | KEEP |  | already in union |
| `not_order_owner` | 2 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"order"}` |  |
| `order_already_refunded` | 2 | message | `ORDER_ALREADY_REFUNDED` | user-facing | CONFLICT | KEEP |  | already in union |
| `order_item_not_found` | 2 | message | `ORDER_ITEM_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `promo_not_applicable` | 2 | message | `PROMO_NOT_APPLICABLE` | user-facing | CONFLICT | KEEP |  |  |
| `qty_exceeds_order` | 2 | message | `QTY_EXCEEDS_ORDER` | user-facing | INVALID_INPUT | KEEP |  |  |
| `refund_amount_zero` | 2 | message | `REFUND_AMOUNT_ZERO` | user-facing | CONFLICT | KEEP |  |  |
| `seat_ids_required` | 2 | message | `SEAT_IDS_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `seat_section_mismatch` | 2 | message | `SEAT_SECTION_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `seat_taken` | 2 | message | `SEAT_TAKEN` | user-facing | CONFLICT | KEEP |  |  |
| `agreement_missing` | 1 | message | `AGREEMENT_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `agreement_missing_fee_policy` | 1 | message | `AGREEMENT_MISSING_FEE_POLICY` | user-facing | CONFLICT | KEEP |  |  |
| `amount_mismatch` | 1 | message | `AMOUNT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `buyer_not_found` | 1 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→HUMAN_NOT_FOUND | `{"role":"buyer"}` |  |
| `credit_balance_changed` | 1 | message | `CREDIT_BALANCE_CHANGED` | user-facing | CONFLICT | KEEP |  |  |
| `donation_amount_required` | 1 | message | `DONATION_AMOUNT_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `donation_below_minimum` | 1 | message | `DONATION_BELOW_MINIMUM` | user-facing | INVALID_INPUT | KEEP |  |  |
| `duplicate_promo` | 1 | message | `DUPLICATE_PROMO` | user-facing | CONFLICT | KEEP |  |  |
| `duplicate_promo_code` | 1 | message | `DUPLICATE_PROMO` | user-facing | CONFLICT | COLLAPSE→DUPLICATE_PROMO |  | clean dedup of duplicate_promo |
| `event_mismatch` | 1 | message | `EVENT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `events_different_org` | 1 | message | `EVENTS_DIFFERENT_ORG` | user-facing | CONFLICT | KEEP |  |  |
| `expected_paid_order` | 1 | message | `EXPECTED_PAID_ORDER` | user-facing | CONFLICT | KEEP |  |  |
| `insufficient_capacity` | 1 | message | `INSUFFICIENT_CAPACITY` | user-facing | CONFLICT | KEEP |  |  |
| `items_not_refundable` | 1 | message | `ITEMS_NOT_REFUNDABLE` | user-facing | CONFLICT | KEEP |  |  |
| `no_orders_to_migrate` | 1 | message | `NO_ORDERS_TO_MIGRATE` | user-facing | CONFLICT | KEEP |  |  |
| `no_payee_subject` | 1 | message | `NO_PAYEE_SUBJECT` | user-facing | CONFLICT | KEEP |  |  |
| `no_refundable_items` | 1 | message | `NO_REFUNDABLE_ITEMS` | user-facing | CONFLICT | KEEP |  |  |
| `order_empty` | 1 | message | `ORDER_EMPTY` | user-facing | CONFLICT | KEEP |  |  |
| `order_non_refundable` | 1 | message | `ORDER_NON_REFUNDABLE` | user-facing | CONFLICT | KEEP |  |  |
| `order_not_free` | 1 | message | `ORDER_NOT_FREE` | user-facing | CONFLICT | KEEP |  |  |
| `order_not_in_org` | 1 | message | `ORDER_NOT_IN_ORG` | user-facing | CONFLICT | KEEP |  |  |
| `order_not_processable` | 1 | message | `ORDER_NOT_PROCESSABLE` | user-facing | CONFLICT | KEEP |  |  |
| `payment_intent_mismatch` | 1 | message | `PAYMENT_INTENT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `payment_intent_order_mismatch` | 1 | message | `PAYMENT_INTENT_ORDER_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `payment_not_succeeded` | 1 | message | `PAYMENT_NOT_SUCCEEDED` | user-facing | CONFLICT | KEEP |  |  |
| `primary_order_resale_linked_transfer_requires_manual_review` | 1 | message | `PRIMARY_ORDER_RESALE_LINKED_TRANSFER_REQUIRES_MANUAL_REVIEW` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `promo_max_redeemed` | 1 | message | `PROMO_MAX_REDEEMED` | user-facing | CONFLICT | KEEP |  | already in union |
| `promo_min_order_not_met` | 1 | message | `PROMO_MIN_ORDER_NOT_MET` | user-facing | CONFLICT | KEEP |  |  |
| `promo_not_stackable` | 1 | message | `PROMO_NOT_STACKABLE` | user-facing | CONFLICT | KEEP |  |  |
| `promo_redeemed_by_human` | 1 | message | `PROMO_REDEEMED_BY_HUMAN` | user-facing | CONFLICT | KEEP |  |  |
| `seat_duplicate_in_request` | 1 | message | `SEAT_DUPLICATE_IN_REQUEST` | user-facing | CONFLICT | KEEP |  |  |
| `seat_ids_not_assigned` | 1 | message | `SEAT_IDS_NOT_ASSIGNED` | user-facing | CONFLICT | KEEP |  |  |
| `seat_not_in_order` | 1 | message | `SEAT_NOT_IN_ORDER` | user-facing | CONFLICT | KEEP |  |  |
| `seat_price_changed` | 1 | message | `SEAT_PRICE_CHANGED` | user-facing | CONFLICT | KEEP |  | added 2026-10-08 (seat-price-overrides D-007); not yet in the union |
| `source_and_target_must_differ` | 1 | message | `SOURCE_AND_TARGET_MUST_DIFFER` | user-facing | INVALID_INPUT | KEEP |  |  |
| `source_event_not_found` | 1 | message | `EVENT_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→EVENT_NOT_FOUND | `{"role":"source"}` |  |
| `target_event_not_active` | 1 | message | `TARGET_EVENT_NOT_ACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `target_event_not_found` | 1 | message | `EVENT_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→EVENT_NOT_FOUND | `{"role":"target"}` |  |
| `ticket_item_not_found` | 1 | message | `TICKET_ITEM_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `ticket_not_valid` | 1 | message | `TICKET_NOT_VALID` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_type_not_seated` | 1 | message | `TICKET_TYPE_NOT_SEATED` | user-facing | CONFLICT | KEEP |  |  |
| `tickets_missing` | 1 | message | `TICKETS_MISSING` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### orgs (10)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `org_not_found` | 9 | message | `ORG_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `member_not_found` | 3 | message | `MEMBER_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `cannot_demote_last_owner` | 2 | message | `CANNOT_DEMOTE_LAST_OWNER` | user-facing | FORBIDDEN | KEEP |  |  |
| `invitation_not_found` | 2 | message | `INVITATION_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `already_a_member` | 1 | message | `ALREADY_A_MEMBER` | user-facing | CONFLICT | KEEP |  |  |
| `cannot_remove_last_owner` | 1 | message | `CANNOT_REMOVE_LAST_OWNER` | user-facing | FORBIDDEN | KEEP |  |  |
| `invitation_expired` | 1 | message | `INVITATION_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |
| `invitation_not_pending` | 1 | message | `INVITATION_NOT_PENDING` | user-facing | CONFLICT | KEEP |  |  |
| `org_already_archived` | 1 | message | `ORG_ALREADY_ARCHIVED` | user-facing | CONFLICT | KEEP |  |  |
| `org_has_active_events` | 1 | message | `ORG_HAS_ACTIVE_EVENTS` | user-facing | CONFLICT | KEEP |  |  |

### payout-terms (10)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `payee_not_found` | 5 | message | `PAYEE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `not_payee_org_admin` | 2 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `not_payee_owner` | 2 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"payee"}` |  |
| `payout_line_not_found` | 2 | message | `PAYOUT_LINE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `counter_fields_required` | 1 | message | `COUNTER_FIELDS_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `event_not_found_for_terms` | 1 | message | `EVENT_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→EVENT_NOT_FOUND | `{"via":"terms"}` |  |
| `line_declined` | 1 | message | `LINE_DECLINED` | user-facing | CONFLICT | KEEP |  |  |
| `line_does_not_require_confirmation` | 1 | message | `LINE_DOES_NOT_REQUIRE_CONFIRMATION` | user-facing | CONFLICT | KEEP |  |  |
| `line_not_counterable` | 1 | message | `LINE_NOT_COUNTERABLE` | user-facing | CONFLICT | KEEP |  |  |
| `line_not_declinable` | 1 | message | `LINE_NOT_DECLINABLE` | user-facing | CONFLICT | KEEP |  |  |

### payouts (1)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `scheduled_for_in_past` | 1 | message | `SCHEDULED_FOR_IN_PAST` | user-facing | INVALID_INPUT | KEEP |  |  |

### place-layouts (6)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `not_place_admin` | 2 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `place_layout_not_found` | 2 | message | `PLACE_LAYOUT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `idempotency_key_required` | 1 | message | `IDEMPOTENCY_KEY_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `place_layout_empty` | 1 | message | `PLACE_LAYOUT_EMPTY` | user-facing | CONFLICT | KEEP |  |  |
| `place_layout_parser_error` | 1 | message | `PLACE_LAYOUT_PARSER_ERROR` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `seat_ids_not_unique` | 1 | message | `SEAT_IDS_NOT_UNIQUE` | user-facing | INVALID_INPUT | KEEP |  |  |

### place-reviews (7)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `review_not_found` | 6 | message | `REVIEW_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `place_stats_not_found` | 1 | message | `PLACE_STATS_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `review_already_flagged` | 1 | message | `REVIEW_ALREADY_FLAGGED` | user-facing | CONFLICT | KEEP |  |  |
| `review_already_hidden` | 1 | message | `REVIEW_ALREADY_HIDDEN` | user-facing | CONFLICT | KEEP |  |  |
| `review_already_responded` | 1 | message | `REVIEW_ALREADY_RESPONDED` | user-facing | CONFLICT | KEEP |  |  |
| `review_not_hidden` | 1 | message | `REVIEW_NOT_HIDDEN` | user-facing | CONFLICT | KEEP |  |  |
| `target_place_not_found` | 1 | message | `PLACE_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→PLACE_NOT_FOUND | `{"role":"target"}` |  |

### places (30)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `place_not_found` | 34 | message | `PLACE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `staff_only` | 9 | message | `STAFF_ONLY` | user-facing | FORBIDDEN | KEEP |  | already in union |
| `verification_request_not_found` | 6 | message | `VERIFICATION_REQUEST_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `not_authorized_for_place` | 4 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"place"}` |  |
| `availability_not_found` | 2 | message | `AVAILABILITY_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `verification_not_in_review` | 2 | message | `VERIFICATION_NOT_IN_REVIEW` | user-facing | CONFLICT | KEEP |  |  |
| `verification_not_pending` | 2 | message | `VERIFICATION_NOT_PENDING` | user-facing | CONFLICT | KEEP |  |  |
| `verification_request_already_decided` | 2 | message | `VERIFICATION_REQUEST_ALREADY_DECIDED` | user-facing | CONFLICT | KEEP |  |  |
| `waiver_not_found` | 2 | message | `WAIVER_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `document_deleted` | 1 | message | `DOCUMENT_DELETED` | user-facing | CONFLICT | KEEP |  |  |
| `document_not_found` | 1 | message | `DOCUMENT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `documents_required` | 1 | message | `DOCUMENTS_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `human_not_owner` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"human"}` |  |
| `not_authorized_to_verify_place` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `not_lock_holder` | 1 | message | `NOT_LOCK_HOLDER` | user-facing | FORBIDDEN | KEEP |  |  |
| `not_org_admin` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `not_place_owner_or_staff` | 1 | message | `NOT_AUTHORIZED` | user-facing | FORBIDDEN | COLLAPSE→NOT_AUTHORIZED |  | owner-or-staff composite → general NOT_AUTHORIZED (user) |
| `not_request_owner` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"request"}` |  |
| `not_submitter_or_staff` | 1 | message | `NOT_AUTHORIZED` | user-facing | FORBIDDEN | COLLAPSE→NOT_AUTHORIZED |  | submitter-or-staff composite → general NOT_AUTHORIZED (user) |
| `org_does_not_own_place` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"place"}` |  |
| `org_not_owner` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"org"}` |  |
| `owner_mismatch` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→NOT_RESOURCE_OWNER |  |  |
| `place_archived` | 1 | message | `PLACE_ARCHIVED` | user-facing | CONFLICT | KEEP |  |  |
| `place_not_eligible_for_verification` | 1 | message | `PLACE_NOT_ELIGIBLE_FOR_VERIFICATION` | user-facing | CONFLICT | KEEP |  |  |
| `reuse_source_not_found` | 1 | message | `PLACE_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→PLACE_NOT_FOUND | `{"role":"reuse_source"}` |  |
| `reuse_source_not_owned` | 1 | message | `REUSE_SOURCE_NOT_OWNED` | user-facing | CONFLICT | KEEP |  |  |
| `reuse_source_still_active` | 1 | message | `REUSE_SOURCE_STILL_ACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `too_many_documents` | 1 | message | `TOO_MANY_DOCUMENTS` | user-facing | CONFLICT | KEEP |  |  |
| `verification_locked_to_other_reviewer` | 1 | message | `VERIFICATION_LOCKED_TO_OTHER_REVIEWER` | user-facing | CONFLICT | KEEP |  |  |
| `verification_requires_org_owner` | 1 | message | `VERIFICATION_REQUIRES_ORG_OWNER` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### platform (9)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `staff_access_required` | 13 | message | `STAFF_ONLY` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→STAFF_ONLY |  | platform-staff gate, same as staff_only |
| `featured_item_target_not_found` | 4 | message | `FEATURED_ITEM_TARGET_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `featured_item_target_not_public` | 4 | message | `FEATURED_ITEM_TARGET_NOT_PUBLIC` | user-facing | CONFLICT | KEEP |  |  |
| `cannot_change_own_status` | 1 | message | `CANNOT_CHANGE_OWN_STATUS` | user-facing | FORBIDDEN | KEEP |  |  |
| `cannot_delete_builtin_preset` | 1 | message | `CANNOT_DELETE_BUILTIN_PRESET` | user-facing | FORBIDDEN | KEEP |  |  |
| `cannot_delete_own_account` | 1 | message | `CANNOT_DELETE_OWN_ACCOUNT` | user-facing | FORBIDDEN | KEEP |  |  |
| `cannot_overwrite_builtin_preset` | 1 | message | `CANNOT_OVERWRITE_BUILTIN_PRESET` | user-facing | FORBIDDEN | KEEP |  |  |
| `confirmation_phrase_mismatch` | 1 | message | `CONFIRMATION_PHRASE_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `preset_not_found` | 1 | message | `PRESET_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |

### pos (11)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `event_not_org_owned` | 10 | message | `EVENT_NOT_ORG_OWNED` | user-facing | CONFLICT | KEEP |  |  |
| `seat_unavailable` | 5 | message | `SEAT_UNAVAILABLE` | user-facing | CONFLICT | KEEP |  | already in union |
| `payee_missing_stripe_account` | 3 | message | `PAYEE_MISSING_STRIPE_ACCOUNT` | user-facing | CONFLICT | KEEP |  |  |
| `gate_refund_window_expired` | 2 | message | `GATE_REFUND_WINDOW_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |
| `payee_not_connected` | 2 | message | `PAYEE_NOT_CONNECTED` | user-facing | CONFLICT | KEEP |  |  |
| `amount_must_be_positive` | 1 | message | `AMOUNT_MUST_BE_POSITIVE` | user-facing | INVALID_INPUT | KEEP |  |  |
| `not_a_cash_order` | 1 | message | `NOT_A_CASH_ORDER` | user-facing | CONFLICT | KEEP |  |  |
| `not_a_pos_card_order` | 1 | message | `NOT_A_POS_CARD_ORDER` | user-facing | CONFLICT | KEEP |  |  |
| `not_a_pos_order` | 1 | message | `NOT_A_POS_ORDER` | user-facing | CONFLICT | KEEP |  |  |
| `order_reload_failed` | 1 | message | `ORDER_RELOAD_FAILED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `payee_charges_disabled` | 1 | message | `PAYEE_CHARGES_DISABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### profiles (4)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `avatar_key_not_owned` | 1 | message | `AVATAR_KEY_NOT_OWNED` | user-facing | CONFLICT | KEEP |  |  |
| `banner_key_not_owned` | 1 | message | `BANNER_KEY_NOT_OWNED` | user-facing | CONFLICT | KEEP |  |  |
| `uploaded_avatar_not_found` | 1 | message | `UPLOADED_AVATAR_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `uploaded_banner_not_found` | 1 | message | `UPLOADED_BANNER_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |

### promos (6)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `promo_not_found` | 5 | message | `PROMO_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  | already in union |
| `promo_not_owned` | 3 | message | `PROMO_NOT_OWNED` | user-facing | CONFLICT | KEEP |  |  |
| `end_before_start` | 2 | message | `END_BEFORE_START` | user-facing | INVALID_INPUT | KEEP |  |  |
| `scope_requires_scope_id` | 2 | message | `SCOPE_REQUIRES_SCOPE_ID` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `global_scope_disabled` | 1 | message | `GLOBAL_SCOPE_DISABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `ticket_type_scope_unsupported` | 1 | message | `TICKET_TYPE_SCOPE_UNSUPPORTED` | user-facing | CONFLICT | KEEP |  |  |

### quotas (5)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `expansion_request_already_pending` | 1 | message | `EXPANSION_REQUEST_ALREADY_PENDING` | user-facing | CONFLICT | KEEP |  |  |
| `expansion_request_already_reviewed` | 1 | message | `EXPANSION_REQUEST_ALREADY_REVIEWED` | user-facing | CONFLICT | KEEP |  |  |
| `expansion_request_not_found` | 1 | message | `EXPANSION_REQUEST_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `quota_exceeded` | 1 | message | `QUOTA_EXCEEDED` | user-facing | CONFLICT | KEEP |  | already in union |
| `requested_limit_not_higher` | 1 | message | `REQUESTED_LIMIT_NOT_HIGHER` | user-facing | CONFLICT | KEEP |  |  |

### resale (27)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claim_already_resolved` | 3 | code | `CLAIM_ALREADY_RESOLVED` | user-facing | CONFLICT | KEEP |  |  |
| `listing_not_found` | 3 | code | `LISTING_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `listing_already_held` | 2 | code | `LISTING_ALREADY_HELD` | user-facing | CONFLICT | KEEP |  |  |
| `listing_not_active` | 2 | code | `LISTING_NOT_ACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `resale_agreement_missing` | 2 | message | `AGREEMENT_MISSING` | user-facing | PRECONDITION_FAILED | COLLAPSE→AGREEMENT_MISSING | `{"scope":"resale"}` | resale bundled into agreement structure (user) |
| `resale_agreement_missing_fee_policy` | 2 | message | `AGREEMENT_MISSING_FEE_POLICY` | user-facing | CONFLICT | COLLAPSE→AGREEMENT_MISSING_FEE_POLICY | `{"scope":"resale"}` | resale bundled into agreement structure (user) |
| `resale_fee_policy_not_found` | 2 | message | `FEE_POLICY_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→FEE_POLICY_NOT_FOUND | `{"scope":"resale"}` |  |
| `resale_not_enabled` | 2 | code | `RESALE_NOT_ENABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `resale_price_exceeds_cap` | 2 | code | `RESALE_PRICE_EXCEEDS_CAP` | user-facing | INVALID_INPUT | KEEP |  |  |
| `resale_unwind_listing_not_found` | 2 | message | `LISTING_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→LISTING_NOT_FOUND | `{"via":"unwind"}` |  |
| `resale_unwind_missing_listing_id` | 2 | message | `RESALE_UNWIND_MISSING_LISTING_ID` | user-facing | CONFLICT | KEEP |  |  |
| `resale_unwind_ticket_not_found` | 2 | message | `TICKET_NOT_FOUND` | user-facing | NOT_FOUND | COLLAPSE→TICKET_NOT_FOUND | `{"via":"unwind"}` |  |
| `sale_cutoff_passed` | 2 | code | `SALE_CUTOFF_PASSED` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_not_eligible_for_resale` | 2 | code | `TICKET_NOT_ELIGIBLE_FOR_RESALE` | user-facing | CONFLICT | KEEP |  |  |
| `cannot_buy_own_listing` | 1 | code | `CANNOT_BUY_OWN_LISTING` | user-facing | FORBIDDEN | KEEP |  |  |
| `claim_already_exists` | 1 | code | `CLAIM_ALREADY_EXISTS` | user-facing | CONFLICT | KEEP |  |  |
| `claim_not_resale_order` | 1 | code | `CLAIM_NOT_RESALE_ORDER` | user-facing | CONFLICT | KEEP |  |  |
| `claim_not_respondent` | 1 | code | `CLAIM_NOT_RESPONDENT` | user-facing | CONFLICT | KEEP |  |  |
| `claim_response_deadline_passed` | 1 | code | `CLAIM_RESPONSE_DEADLINE_PASSED` | user-facing | CONFLICT | KEEP |  |  |
| `claim_window_expired` | 1 | code | `CLAIM_WINDOW_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |
| `claim_window_not_open` | 1 | code | `CLAIM_WINDOW_NOT_OPEN` | user-facing | CONFLICT | KEEP |  |  |
| `not_ticket_owner` | 1 | code | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"ticket"}` |  |
| `refund_failed` | 1 | message | `REFUND_FAILED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `refund_rejected` | 1 | message | `REFUND_REJECTED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `resale_agreement_missing_lines` | 1 | message | `AGREEMENT_MISSING_LINES` | user-facing | CONFLICT | COLLAPSE→AGREEMENT_MISSING_LINES | `{"scope":"resale"}` | resale bundled into agreement structure (user) |
| `resale_not_allowed_for_type` | 1 | code | `RESALE_NOT_ALLOWED_FOR_TYPE` | user-facing | CONFLICT | KEEP |  |  |
| `seller_payout_not_setup` | 1 | code | `SELLER_PAYOUT_NOT_SETUP` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### scanner (5)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `no_scanner_role` | 2 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `target_not_found` | 2 | message | `TARGET_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `missing_target` | 1 | message | `MISSING_TARGET` | user-facing | CONFLICT | KEEP |  |  |
| `target_lacks_scanner_role` | 1 | message | `TARGET_LACKS_SCANNER_ROLE` | user-facing | CONFLICT | KEEP |  |  |
| `target_not_member` | 1 | message | `TARGET_NOT_MEMBER` | user-facing | CONFLICT | KEEP |  |  |

### series (12)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `series_not_found` | 6 | message | `SERIES_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `invalid_datetime` | 2 | message | `INVALID_DATETIME` | user-facing | INVALID_INPUT | KEEP |  |  |
| `series_inactive` | 2 | message | `SERIES_INACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `series_name_taken` | 2 | message | `SERIES_NAME_TAKEN` | user-facing | CONFLICT | KEEP |  |  |
| `series_schedule_invalid` | 2 | message | `SERIES_SCHEDULE_INVALID` | user-facing | INVALID_INPUT | KEEP |  |  |
| `template_not_active` | 2 | message | `TEMPLATE_NOT_ACTIVE` | user-facing | CONFLICT | KEEP |  |  |
| `occurrence_allocation_failed` | 1 | message | `OCCURRENCE_ALLOCATION_FAILED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |
| `occurrence_not_found` | 1 | message | `OCCURRENCE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `series_owner_mismatch` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"series"}` |  |
| `series_owner_not_found` | 1 | message | `HUMAN_NOT_FOUND` | user-facing | NOT_FOUND | ⚠️ COLLAPSE→HUMAN_NOT_FOUND | `{"role":"series_owner"}` |  |
| `window_bounds_required` | 1 | message | `WINDOW_BOUNDS_REQUIRED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `window_end_before_start` | 1 | message | `WINDOW_END_BEFORE_START` | user-facing | INVALID_INPUT | KEEP |  |  |

### settlements (7)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `settlement_not_found` | 2 | message | `SETTLEMENT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `event_missing_payout_terms` | 1 | message | `EVENT_MISSING_PAYOUT_TERMS` | user-facing | CONFLICT | KEEP |  |  |
| `no_splits_found` | 1 | message | `NO_SPLITS_FOUND` | user-facing | CONFLICT | KEEP |  |  |
| `order_disputed` | 1 | message | `ORDER_DISPUTED` | user-facing | CONFLICT | KEEP |  |  |
| `order_not_succeeded` | 1 | message | `ORDER_NOT_SUCCEEDED` | user-facing | CONFLICT | KEEP |  | source `code` is invalid_input; proposed CONFLICT — confirm vs PRECONDITION_FAILED |
| `payee_payouts_disabled` | 1 | message | `PAYEE_PAYOUTS_DISABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `settlement_reload_failed` | 1 | message | `SETTLEMENT_RELOAD_FAILED` | internal | INTERNAL_SERVER_ERROR | INTERNAL |  |  |

### stripe-connect (3)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `not_owner` | 7 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→NOT_RESOURCE_OWNER |  | no single entity (spans 5 domains) — meta.entity can't be set generically |
| `not_connected` | 2 | message | `NOT_CONNECTED` | user-facing | FORBIDDEN | KEEP |  |  |
| `payouts_not_enabled` | 1 | message | `PAYOUTS_NOT_ENABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### support (4)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `thread_not_found` | 3 | message | `THREAD_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `not_thread_owner` | 2 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"thread"}` |  |
| `owner_can_only_escalate` | 1 | message | `OWNER_CAN_ONLY_ESCALATE` | user-facing | FORBIDDEN | KEEP |  | KEEP own code — special-case action restriction (user) |
| `support_thread_unavailable` | 1 | message | `SUPPORT_THREAD_UNAVAILABLE` | user-facing | CONFLICT | KEEP |  |  |

### ticket-types (4)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `paid_ticketing_requires_stripe` | 2 | message | `PAID_TICKETING_REQUIRES_STRIPE` | user-facing | PRECONDITION_FAILED | KEEP |  | already in union |
| `ticket_type_name_taken` | 2 | message | `TICKET_TYPE_NAME_TAKEN` | user-facing | CONFLICT | KEEP |  |  |
| `suggested_below_minimum` | 1 | message | `SUGGESTED_BELOW_MINIMUM` | user-facing | INVALID_INPUT | KEEP |  |  |
| `ticket_type_has_sales` | 1 | message | `TICKET_TYPE_HAS_SALES` | user-facing | CONFLICT | KEEP |  |  |

### tickets (23)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ticket_not_found` | 7 | message | `TICKET_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `actor_must_be_owner` | 2 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→NOT_RESOURCE_OWNER |  |  |
| `pending_transfer_not_found` | 2 | message | `PENDING_TRANSFER_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `ticket_not_transferable` | 2 | message | `TICKET_NOT_TRANSFERABLE` | user-facing | CONFLICT | KEEP |  |  |
| `cannot_transfer_to_self` | 1 | message | `CANNOT_TRANSFER_TO_SELF` | user-facing | FORBIDDEN | KEEP |  |  |
| `client_key_too_short` | 1 | message | `CLIENT_KEY_TOO_SHORT` | user-facing | INVALID_INPUT | KEEP |  |  |
| `email_mismatch` | 1 | message | `EMAIL_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `invalid_argument` | 1 | code | `INVALID_ARGUMENT` | user-facing | INVALID_INPUT | KEEP |  |  |
| `invalid_order_item` | 1 | code | `INVALID_ORDER_ITEM` | user-facing | INVALID_INPUT | KEEP |  |  |
| `not_transfer_initiator` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"transfer"}` |  |
| `order_required_for_resale` | 1 | message | `ORDER_REQUIRED_FOR_RESALE` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `pending_transfer_already_exists` | 1 | message | `PENDING_TRANSFER_ALREADY_EXISTS` | user-facing | CONFLICT | KEEP |  |  |
| `pending_transfer_expired` | 1 | message | `PENDING_TRANSFER_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |
| `recipient_already_has_account` | 1 | message | `RECIPIENT_ALREADY_HAS_ACCOUNT` | user-facing | CONFLICT | KEEP |  |  |
| `resale_disabled_for_event` | 1 | message | `RESALE_DISABLED_FOR_EVENT` | user-facing | CONFLICT | KEEP |  |  |
| `seat_allocation_mismatch` | 1 | message | `SEAT_ALLOCATION_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `seat_assignment_count_mismatch` | 1 | message | `SEAT_ASSIGNMENT_COUNT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `ticket_already_owned_by_target` | 1 | message | `TICKET_ALREADY_OWNED_BY_TARGET` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_item_missing_ticket_type` | 1 | message | `TICKET_ITEM_MISSING_TICKET_TYPE` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_no_longer_owned_by_sender` | 1 | message | `TICKET_NO_LONGER_OWNED_BY_SENDER` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_not_scanned` | 1 | message | `TICKET_NOT_SCANNED` | user-facing | CONFLICT | KEEP |  |  |
| `ticket_type_sold_out` | 1 | message | `TICKET_TYPE_SOLD_OUT` | user-facing | CONFLICT | KEEP |  |  |
| `undo_window_expired` | 1 | message | `UNDO_WINDOW_EXPIRED` | user-facing | CONFLICT | KEEP |  |  |

### volunteering (17)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `signup_not_found` | 6 | message | `SIGNUP_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `role_not_found` | 4 | message | `ROLE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `not_signup_owner` | 2 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"signup"}` |  |
| `shift_not_found` | 2 | message | `SHIFT_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `signup_not_approved` | 2 | message | `SIGNUP_NOT_APPROVED` | user-facing | CONFLICT | KEEP |  |  |
| `already_signed_up` | 1 | message | `ALREADY_SIGNED_UP` | user-facing | CONFLICT | KEEP |  |  |
| `phone_required_for_sms` | 1 | message | `PHONE_REQUIRED_FOR_SMS` | user-facing | PRECONDITION_FAILED | KEEP |  |  |
| `print_token_requires_org_edit_role` | 1 | message | `INSUFFICIENT_ROLE` | user-facing | FORBIDDEN | ⚠️ COLLAPSE→INSUFFICIENT_ROLE |  |  |
| `role_full` | 1 | message | `ROLE_FULL` | user-facing | CONFLICT | KEEP |  |  |
| `shift_full` | 1 | message | `SHIFT_FULL` | user-facing | CONFLICT | KEEP |  |  |
| `signup_missing_human` | 1 | message | `SIGNUP_MISSING_HUMAN` | user-facing | CONFLICT | KEEP |  |  |
| `signup_not_reviewable` | 1 | message | `SIGNUP_NOT_REVIEWABLE` | user-facing | CONFLICT | KEEP |  |  |
| `signup_not_withdrawable` | 1 | message | `SIGNUP_NOT_WITHDRAWABLE` | user-facing | CONFLICT | KEEP |  |  |
| `token_event_mismatch` | 1 | message | `TOKEN_EVENT_MISMATCH` | user-facing | INVALID_INPUT | KEEP |  |  |
| `volunteer_qr_invalid` | 1 | code | `VOLUNTEER_QR_INVALID` | user-facing | INVALID_INPUT | KEEP |  | already in union |
| `volunteer_qr_wrong_event` | 1 | code | `VOLUNTEER_QR_WRONG_EVENT` | user-facing | CONFLICT | KEEP |  | already in union |
| `volunteering_disabled` | 1 | message | `VOLUNTEERING_DISABLED` | user-facing | PRECONDITION_FAILED | KEEP |  |  |

### waivers (6)

| Legacy code | × | field | Canonical | tier | http | Disposition | meta | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `waiver_template_not_found` | 2 | message | `WAIVER_TEMPLATE_NOT_FOUND` | user-facing | NOT_FOUND | KEEP |  |  |
| `event_not_in_org` | 1 | message | `EVENT_NOT_IN_ORG` | user-facing | CONFLICT | KEEP |  |  |
| `must_be_human_owner` | 1 | message | `NOT_RESOURCE_OWNER` | user-facing | FORBIDDEN | COLLAPSE→NOT_RESOURCE_OWNER | `{"entity":"human"}` |  |
| `platform_template_readonly` | 1 | message | `PLATFORM_TEMPLATE_READONLY` | user-facing | CONFLICT | KEEP |  |  |
| `waiver_template_not_accessible` | 1 | message | `WAIVER_TEMPLATE_NOT_ACCESSIBLE` | user-facing | CONFLICT | KEEP |  |  |
| `waiver_template_not_owned` | 1 | message | `WAIVER_TEMPLATE_NOT_OWNED` | user-facing | CONFLICT | KEEP |  |  |

