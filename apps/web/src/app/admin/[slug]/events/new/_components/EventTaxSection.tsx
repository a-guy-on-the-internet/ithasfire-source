"use client";

import { useCallback, useEffect, useState } from "react";
import { YStack, XStack, styled } from "tamagui";
import { Landmark, Info } from "lucide-react";
import { Text, Switch, useNotify, useTranslations } from "@th/ui";
import { FieldLabel } from "./_form-bits";
import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

// ── Types ──────────────────────────────────────────────────────────────────

export type EventTaxSectionProps = {
  /** Event id. Section only renders in edit mode (event already saved). */
  eventId: string;
  /** Current persisted value from getEventForEdit. */
  initialInstructionalAdmission: boolean;
  /**
   * US state code from the event location (e.g. "TN", "TX"). Used only to show
   * a muted informational hint about where the exemption actually applies — the
   * exemption itself is enforced server-side per venue jurisdiction.
   */
  eventStateCode?: string | null;
};

// ── Styles ─────────────────────────────────────────────────────────────────

const Container = styled(YStack, {
  gap: 16,
  padding: 32,
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
  $xs: { padding: 16 },
});

const ToggleRow = styled(XStack, {
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  flexWrap: "wrap",
});

const ToggleCopy = styled(YStack, {
  gap: 4,
  flex: 1,
  minWidth: 240,
});

const AttestationNote = styled(XStack, {
  gap: 10,
  padding: 14,
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
  alignItems: "flex-start",
});

// ── Component ──────────────────────────────────────────────────────────────

export function EventTaxSection({
  eventId,
  initialInstructionalAdmission,
  eventStateCode,
}: EventTaxSectionProps) {
  const t = useTranslations();
  const { toast } = useNotify();

  const [instructional, setInstructional] = useState(
    initialInstructionalAdmission,
  );

  // Sync external refetch updates (e.g. after the query re-fetches on save).
  useEffect(
    () => setInstructional(initialInstructionalAdmission),
    [initialInstructionalAdmission],
  );

  const updateMutation = trpc.events.updateSettings.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const handleChange = useCallback(
    async (next: boolean) => {
      if (!eventId) return;
      const previous = instructional;
      setInstructional(next);
      try {
        await updateMutation.mutateAsync({
          eventId,
          instructionalAdmission: next,
        });
        toast.success({
          id: "tax-instructional-saved",
          title: t("admin.ebTaxSaved") as string,
        });
      } catch (err) {
        setInstructional(previous);
        toast.danger({
          id: "tax-instructional-save-fail",
          title: t("admin.ebTaxSaveFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [eventId, instructional, updateMutation, toast, t],
  );

  const isTennessee = (eventStateCode ?? "").toUpperCase() === "TN";

  return (
    <Container>
      <XStack alignItems="center" gap={8}>
        <Landmark size={18} color="var(--color)" />
        <Text variant="h4" weight="bold">
          {String(t("admin.ebTaxTitle"))}
        </Text>
      </XStack>

      <Text variant="caption" tone="muted">
        {String(t("admin.ebTaxDescription"))}
      </Text>

      {/* Instructional-admission toggle */}
      <ToggleRow>
        <ToggleCopy>
          <FieldLabel id="tax-instructional-label">
            {String(t("admin.ebTaxInstructionalLabel"))}
          </FieldLabel>
          <Text variant="caption" tone="muted">
            {String(t("admin.ebTaxInstructionalHelp"))}
          </Text>
        </ToggleCopy>
        <Switch
          checked={instructional}
          onCheckedChange={handleChange}
          saving={updateMutation.isPending}
          aria-labelledby="tax-instructional-label"
        />
      </ToggleRow>

      {/* Attestation — enabling the toggle is the attestation; this note makes
          the commitment explicit. Shown only when the exemption is claimed. */}
      {instructional ? (
        <AttestationNote>
          <Info
            size={14}
            color="var(--colorMuted)"
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text variant="caption" tone="muted">
            {String(t("admin.ebTaxAttestation"))}
          </Text>
        </AttestationNote>
      ) : null}

      {/* Jurisdiction hint — the exemption only zeroes admission tax where the
          venue is in Tennessee; elsewhere normal tax still applies. */}
      {instructional && !isTennessee ? (
        <Text variant="caption" tone="muted" style={{ fontStyle: "italic" }}>
          {String(t("admin.ebTaxNonTennesseeHint"))}
        </Text>
      ) : null}
    </Container>
  );
}
