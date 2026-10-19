import {
  HOST_ATTESTATION_FIELDS,
  type HostAttestationField,
} from "@th/core/use-cases/events/host-attestation-text";

import type { ChargebackTermsOwner } from "@/app/admin/[slug]/payouts/_components/chargeback-terms-acceptance";

/**
 * Pure helpers for the two publish gates (chargeback terms + host
 * attestation). Extracted from EventBuilder so both the builder's publish
 * funnel and the dialogs themselves can share them without either importing
 * the other.
 */

export const ATTESTATION_INCOMPLETE_CODE = "attestation_incomplete";
/**
 * Booking-holds rule (spec FR-018): publishing onto — or moving a published
 * event onto — a calendar date whose hold line has an OPEN challenge is
 * refused. Rides the error contract as `data.appCode`, not the message.
 */
export const HOLD_LINE_HAS_OPEN_CHALLENGE_CODE = "HOLD_LINE_HAS_OPEN_CHALLENGE";
export const ORGANIZER_FAQ_HREF = "/help/troubleshooting/faq";

export type HostAttestationState = Record<HostAttestationField, boolean>;
export type HostAttestationSubmission = Record<HostAttestationField, true>;

export const createEmptyHostAttestationState = (): HostAttestationState =>
  Object.fromEntries(
    HOST_ATTESTATION_FIELDS.map((field) => [field, false]),
  ) as HostAttestationState;

export const buildHostAttestationSubmission = (
  attestation: HostAttestationState,
): HostAttestationSubmission | null => {
  if (HOST_ATTESTATION_FIELDS.some((field) => attestation[field] !== true)) {
    return null;
  }

  return Object.fromEntries(
    HOST_ATTESTATION_FIELDS.map((field) => [field, true]),
  ) as HostAttestationSubmission;
};

const isHostAttestationField = (
  value: unknown,
): value is HostAttestationField =>
  typeof value === "string" &&
  HOST_ATTESTATION_FIELDS.includes(value as HostAttestationField);

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
};

export const isAttestationIncompleteError = (error: unknown): boolean => {
  const message = getErrorMessage(error);
  return (
    message === ATTESTATION_INCOMPLETE_CODE ||
    String(error).includes(ATTESTATION_INCOMPLETE_CODE)
  );
};

export const isHoldLineOpenChallengeError = (error: unknown): boolean => {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("appCode" in data)) return false;
  return (
    (data as { appCode?: unknown }).appCode === HOLD_LINE_HAS_OPEN_CHALLENGE_CODE
  );
};

export const extractMissingHostAttestationFields = (
  error: unknown,
): HostAttestationField[] => {
  if (!error || typeof error !== "object" || !("data" in error)) return [];
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("meta" in data)) return [];
  const meta = (data as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object" || !("missingFields" in meta)) {
    return [];
  }

  const missingFields = (meta as { missingFields?: unknown }).missingFields;
  if (!Array.isArray(missingFields)) return [];
  return missingFields.filter(isHostAttestationField);
};

export type ChargebackTermsModalMode = "publish-retry" | "standalone";

export type ChargebackTermsAcceptanceTarget =
  | { type: "org"; id: string }
  | { type: "human"; id: string };

type EventChargebackTermsOwnerFields = {
  orgId?: string | null;
  humanId?: string | null;
};

export const resolveChargebackTermsAcceptanceTarget = (
  eventData: EventChargebackTermsOwnerFields | null | undefined,
): ChargebackTermsAcceptanceTarget | null => {
  if (eventData?.orgId) return { type: "org", id: eventData.orgId };
  if (eventData?.humanId) return { type: "human", id: eventData.humanId };
  return null;
};

type EventStoredChargebackTermsFields = EventChargebackTermsOwnerFields & {
  viewerCanManagePayouts?: boolean;
};

/**
 * Pure: whose STORED chargeback-terms acceptance the builder may read for
 * this event, or `null` when it has no readable record (the caller then
 * relies on the in-builder acceptance alone).
 *
 * - Org-owned: `orgs.getOrg` for the event's org. The viewer is a member:
 *   `getEventForEdit` answered, and it requires an org edit role on an
 *   org-owned event (get-event-for-edit.ts), while `getOrg` admits any
 *   member. The `adminOwner` match is a guard, not the proof: the edit route
 *   (EventAdminPageShell) already swaps the workspace for the event's owner
 *   org, so it always holds there; it stops a caller that passes a different
 *   workspace (as /events/new would) from reading an org it never resolved.
 * - Human-owned: `humans.getMyProfile` is the SIGNED-IN human's row, so it
 *   answers for this event only when the viewer owns it.
 *   `viewerCanManagePayouts` is exactly `event.humanId === actor` for a
 *   human-owned event (get-event-for-edit.ts); a delegate gets `null`.
 */
export const resolveStoredChargebackTermsOwner = (
  eventData: EventStoredChargebackTermsFields | null | undefined,
  adminOwner: { ownerType: "human" | "org"; ownerId: string },
): ChargebackTermsOwner | null => {
  if (eventData?.orgId) {
    return adminOwner.ownerType === "org" &&
      adminOwner.ownerId === eventData.orgId
      ? { kind: "org", orgId: eventData.orgId }
      : null;
  }
  if (eventData?.humanId && eventData.viewerCanManagePayouts === true) {
    return { kind: "human" };
  }
  return null;
};
