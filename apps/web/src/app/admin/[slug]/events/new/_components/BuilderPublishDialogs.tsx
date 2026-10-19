"use client";

import { memo } from "react";
import { styled, useTheme, XStack, YStack } from "tamagui";
import { Ban, ExternalLink, HeartHandshake } from "lucide-react";

import { Button, Checkbox, Modal, Spinner, Text, useTranslations } from "@th/ui";
import {
  CHARGEBACK_TERMS_VERSION,
  ChargebackTermsAcceptCheckbox,
  ChargebackTermsBody,
} from "@/components/payments/ChargebackTermsContent";
import {
  HOST_ATTESTATION_FIELDS,
  HOST_ATTESTATION_TEXT,
  HOST_ATTESTATION_VERSION,
  type HostAttestationField,
} from "@th/core/use-cases/events/host-attestation-text";

import {
  ORGANIZER_FAQ_HREF,
  type ChargebackTermsModalMode,
  type HostAttestationState,
} from "./publish-gate-helpers";

/**
 * The two pre-publish gate dialogs (FR-105 path unchanged): host
 * responsibilities attestation and chargeback-terms acceptance.
 *
 * Extracted from EventBuilder and memoized so the builder stops re-creating
 * ~200 dialog elements on every keystroke — their props are booleans, strings,
 * and stable callbacks, so `React.memo` bails out until the publish flow
 * actually moves.
 */

const LINK_RESET = { textDecoration: "none", display: "inline-flex" } as const;
const SPINNER_GAP = { marginRight: 6 } as const;

const ChargebackTermsIntro = styled(XStack, {
  gap: "$3",
  alignItems: "flex-start",
  paddingBottom: "$2",
});

const ChargebackTermsError = styled(YStack, {
  padding: "$3",
  borderWidth: 2,
  borderColor: "$danger",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

const HostAttestationIntro = styled(XStack, {
  gap: "$3",
  alignItems: "flex-start",
  paddingBottom: "$2",
});

const HostAttestationChecklist = styled(YStack, {
  gap: "$3",
});

const HostAttestationCheckboxRow = styled(YStack, {
  padding: "$3",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  variants: {
    missing: {
      true: {
        borderColor: "$danger",
        backgroundColor: "$surfaceMuted",
      },
    },
  },
});

const HostAttestationError = styled(YStack, {
  padding: "$3",
  borderWidth: 2,
  borderColor: "$danger",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

export type HostAttestationDialogProps = {
  open: boolean;
  onClose: () => void;
  /** OBSCURED location ⇒ the per-item private-host checklist. */
  usesPrivateHostAttestation: boolean;
  attestation: HostAttestationState;
  missingFields: HostAttestationField[];
  allChecked: boolean;
  submitting: boolean;
  error: string | null;
  onFieldChange: (field: HostAttestationField, checked: boolean) => void;
  onStandardChange: (checked: boolean) => void;
  onSubmit: () => void;
};

function HostAttestationDialogImpl({
  open,
  onClose,
  usesPrivateHostAttestation,
  attestation,
  missingFields,
  allChecked,
  submitting,
  error,
  onFieldChange,
  onStandardChange,
  onSubmit,
}: HostAttestationDialogProps) {
  const t = useTranslations();
  const theme = useTheme();

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel
        width={640}
        role="dialog"
        aria-modal={true}
        aria-label={String(t("admin.ebHostAttestationTitle"))}
        aria-describedby="host-attestation-description"
      >
        <Modal.Header
          title={t("admin.ebHostAttestationTitle") as string}
          subtitle={
            t("admin.ebHostAttestationSubtitle", {
              version: HOST_ATTESTATION_VERSION,
            }) as string
          }
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$4">
            <HostAttestationIntro>
              <HeartHandshake size={20} color={theme.brandSecondary?.val} />
              <YStack gap="$2" flex={1} minWidth={0}>
                <Text id="host-attestation-description" variant="body">
                  {String(
                    t(
                      usesPrivateHostAttestation
                        ? "admin.ebHostAttestationPrivateIntro"
                        : "admin.ebHostAttestationIntro",
                    ),
                  )}
                </Text>
                <a
                  href={ORGANIZER_FAQ_HREF}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={LINK_RESET}
                >
                  <XStack gap="$2" alignItems="center">
                    <Text
                      variant="bodySmall"
                      weight="bold"
                      color="$brandSecondary"
                      tag="span"
                    >
                      {String(t("admin.ebHostAttestationFaqLink"))}
                    </Text>
                    <ExternalLink
                      size={12}
                      color={theme.brandSecondary?.val}
                      aria-hidden
                    />
                  </XStack>
                </a>
              </YStack>
            </HostAttestationIntro>

            {usesPrivateHostAttestation ? (
              <HostAttestationChecklist>
                {HOST_ATTESTATION_FIELDS.map((field) => {
                  const isMissing = missingFields.includes(field);

                  return (
                    <HostAttestationCheckboxRow key={field} missing={isMissing}>
                      <Checkbox
                        id={`host-attestation-${field}`}
                        label={HOST_ATTESTATION_TEXT[field]}
                        errorMessage={
                          isMissing
                            ? String(t("admin.ebHostAttestationFieldRequired"))
                            : undefined
                        }
                        required
                        checked={attestation[field]}
                        onCheckedChange={(checked) => {
                          onFieldChange(field, checked === true);
                        }}
                        disabled={submitting}
                        size="md"
                        testIdBase={`host-attestation-${field}`}
                      />
                    </HostAttestationCheckboxRow>
                  );
                })}
              </HostAttestationChecklist>
            ) : (
              <HostAttestationCheckboxRow missing={missingFields.length > 0}>
                <Checkbox
                  id="host-attestation-standard"
                  label={String(t("admin.ebHostAttestationStandardLabel"))}
                  description={String(
                    t("admin.ebHostAttestationStandardDescription"),
                  )}
                  errorMessage={
                    missingFields.length > 0
                      ? String(t("admin.ebHostAttestationFieldRequired"))
                      : undefined
                  }
                  required
                  checked={allChecked}
                  onCheckedChange={(checked) => {
                    onStandardChange(checked === true);
                  }}
                  disabled={submitting}
                  size="md"
                  testIdBase="host-attestation-standard"
                />
              </HostAttestationCheckboxRow>
            )}

            <Text variant="bodySmall" tone="muted">
              {String(
                t(
                  usesPrivateHostAttestation
                    ? "admin.ebHostAttestationPrivateFooter"
                    : "admin.ebHostAttestationFooter",
                ),
              )}
            </Text>

            {error && (
              <HostAttestationError role="alert">
                <Text variant="bodySmall" tone="error">
                  {error}
                </Text>
              </HostAttestationError>
            )}
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={onClose} disabled={submitting}>
            {String(t("admin.ebGoBack"))}
          </Button>
          <Button
            variant="primary"
            onPress={onSubmit}
            disabled={!allChecked || submitting}
            data-testid="host-attestation-submit"
          >
            {submitting && (
              <Spinner
                width={14}
                height={14}
                borderWidth={2}
                style={SPINNER_GAP}
              />
            )}
            {submitting
              ? String(t("admin.ebHostAttestationPublishing"))
              : String(t("admin.ebHostAttestationPublish"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

export const HostAttestationDialog = memo(HostAttestationDialogImpl);
HostAttestationDialog.displayName = "HostAttestationDialog";

export type ChargebackTermsDialogProps = {
  open: boolean;
  onClose: () => void;
  mode: ChargebackTermsModalMode;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  /** Null when neither an org nor a human owner could be resolved. */
  targetType: "org" | "human" | null;
  submitting: boolean;
  error: string | null;
  onAccept: () => void;
};

function ChargebackTermsDialogImpl({
  open,
  onClose,
  mode,
  accepted,
  onAcceptedChange,
  targetType,
  submitting,
  error,
  onAccept,
}: ChargebackTermsDialogProps) {
  const t = useTranslations();
  const theme = useTheme();

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel
        width={600}
        role="dialog"
        aria-modal={true}
        aria-label={String(t("admin.ebChargebackTermsTitle"))}
        aria-describedby="chargeback-terms-description"
      >
        <Modal.Header
          title={t("admin.ebChargebackTermsTitle") as string}
          subtitle={
            t("admin.ebChargebackTermsSubtitle", {
              version: CHARGEBACK_TERMS_VERSION,
            }) as string
          }
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$4">
            <ChargebackTermsIntro>
              <Ban size={20} color={theme.brandSecondary?.val} />
              <YStack gap="$2" flex={1} minWidth={0}>
                <Text id="chargeback-terms-description" variant="body">
                  {String(
                    t(
                      mode === "publish-retry"
                        ? "admin.ebChargebackTermsIntro"
                        : "admin.ebChargebackTermsStandaloneIntro",
                    ),
                  )}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  {String(
                    !targetType
                      ? t("admin.ebChargebackTermsOwnerMissing")
                      : targetType === "org"
                        ? t("admin.ebChargebackTermsOrgPermissionNote")
                        : t("admin.ebChargebackTermsHumanPermissionNote"),
                  )}
                </Text>
              </YStack>
            </ChargebackTermsIntro>

            <YStack gap="$2">
              <Text variant="label">
                {String(t("admin.ebChargebackTermsCurrentTextLabel"))}
              </Text>
              <ChargebackTermsBody frame="rules" maxHeight={260} />
            </YStack>

            <ChargebackTermsAcceptCheckbox
              id="chargeback-terms-acceptance"
              checked={accepted}
              onCheckedChange={onAcceptedChange}
              disabled={submitting}
            />

            {error && (
              <ChargebackTermsError role="alert">
                <Text variant="bodySmall" tone="error">
                  {error}
                </Text>
              </ChargebackTermsError>
            )}
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={onClose} disabled={submitting}>
            {String(t("admin.ebGoBack"))}
          </Button>
          <Button
            variant="primary"
            onPress={onAccept}
            disabled={!accepted || !targetType || submitting}
            data-testid="chargeback-terms-accept-submit"
          >
            {submitting && (
              <Spinner
                width={14}
                height={14}
                borderWidth={2}
                style={SPINNER_GAP}
              />
            )}
            {submitting
              ? String(t("admin.ebChargebackTermsAccepting"))
              : String(
                  t(
                    mode === "publish-retry"
                      ? "admin.ebChargebackTermsAcceptAndPublish"
                      : "admin.ebChargebackTermsAcceptOnly",
                  ),
                )}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

export const ChargebackTermsDialog = memo(ChargebackTermsDialogImpl);
ChargebackTermsDialog.displayName = "ChargebackTermsDialog";
