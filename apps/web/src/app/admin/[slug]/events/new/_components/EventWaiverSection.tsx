"use client";

import { useState, useCallback, useEffect, type CSSProperties } from "react";
import { YStack, XStack, styled } from "tamagui";
import { ShieldCheck, Eye, X, Info } from "lucide-react";
import { Text, Button, useNotify, useTranslations } from "@th/ui";
import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

// ── Types ──────────────────────────────────────────────────────────────────

type WaiverTemplateSummary = {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
};

export type EventWaiverSectionProps = {
  eventId: string;
  /** Org owner — pass when ownerType is "org". */
  orgId?: string;
  /** Human owner — pass when ownerType is "human". Unused today: the builder
   * mounts this section only on org-owned events (assignWaiverToEvent requires an org). */
  humanId?: string;
  /** Current waiver template id from getEventForEdit, if any. */
  initialWaiverTemplateId: string | null;
  /** US state code from event location (e.g. "TN", "LA"). Drives jurisdiction warnings. */
  eventStateCode?: string | null;
};

const Container = styled(YStack, {
  gap: 16,
  padding: 32,
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

const legalTextStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 18,
};

const waiverPreviewTextStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
};

// ── Component ──────────────────────────────────────────────────────────────

// ── Jurisdiction gating ────────────────────────────────────────────────────

type JurisdictionTier = "VOID" | "RESTRICTED" | "SPECIAL" | "STANDARD";

const VOID_STATES: Record<string, string> = { LA: "Louisiana", VA: "Virginia" };
const RESTRICTED_STATES: Record<string, string> = {
  NY: "New York",
  CT: "Connecticut",
  VT: "Vermont",
  OR: "Oregon",
};

function getJurisdictionInfo(stateCode: string | null | undefined): {
  tier: JurisdictionTier;
  warning: string | null;
} {
  if (!stateCode) return { tier: "STANDARD", warning: null };
  const upper = stateCode.toUpperCase();

  if (upper in VOID_STATES) {
    return {
      tier: "VOID",
      warning: `Liability waivers for personal injury are categorically unenforceable in ${VOID_STATES[upper]}. Any waiver you deploy will serve as an acknowledgment of risk only — not a release of liability. We strongly recommend purchasing event liability insurance.`,
    };
  }

  if (upper in RESTRICTED_STATES) {
    return {
      tier: "RESTRICTED",
      warning: `${RESTRICTED_STATES[upper]} law restricts waiver enforceability for paid recreational events. Your waiver may not be enforceable under state law. Consult a ${RESTRICTED_STATES[upper]}-licensed attorney if your event involves significant risk.`,
    };
  }

  return { tier: "STANDARD", warning: null };
}

// ── Component ──────────────────────────────────────────────────────────────

export function EventWaiverSection({
  eventId,
  orgId,
  humanId,
  initialWaiverTemplateId,
  eventStateCode,
}: EventWaiverSectionProps) {
  const t = useTranslations();
  const { toast } = useNotify();

  const [selectedId, setSelectedId] = useState<string | null>(
    initialWaiverTemplateId,
  );
  const [previewBody, setPreviewBody] = useState<string | null>(null);

  const jurisdiction = getJurisdictionInfo(eventStateCode);

  // Fetch available waiver templates (includes platform defaults).
  // The backend requires exactly one of orgId or humanId.
  const ownerParam = orgId ? { orgId } : humanId ? { humanId } : {};
  const templatesQuery = trpc.waivers.listTemplates.useQuery(ownerParam, {
    staleTime: 60_000,
    enabled: Boolean(orgId || humanId),
  });

  const assignMutation = trpc.waivers.assignToEvent.useMutation({
    retry: false,
    meta: { silent: true },
  });

  // Sync external changes (e.g. re-fetch after save)
  useEffect(() => {
    setSelectedId(initialWaiverTemplateId);
  }, [initialWaiverTemplateId]);

  const handleChange = useCallback(
    async (templateId: string | null) => {
      const previous = selectedId;
      setSelectedId(templateId);

      try {
        await assignMutation.mutateAsync({
          eventId,
          waiverTemplateId: templateId,
          ...(orgId ? { orgId } : { humanId }),
        });
        toast.success({
          id: "waiver-assign",
          title: (templateId
            ? t("admin.ebWaiverAssigned")
            : t("admin.ebWaiverRemoved")) as string,
        });
      } catch (err) {
        setSelectedId(previous);
        toast.danger({
          id: "waiver-assign-fail",
          title: t("admin.ebWaiverAssignFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [selectedId, orgId, humanId, eventId, assignMutation, toast, t],
  );

  const templates: WaiverTemplateSummary[] = (
    templatesQuery.data?.templates ?? []
  ).map(
    (tpl: { id: string; name: string; body: string; isDefault: boolean }) => ({
      id: tpl.id,
      name: tpl.name,
      body: tpl.body,
      isDefault: tpl.isDefault,
    }),
  );

  const selectedTemplate =
    templates.find((tpl) => tpl.id === selectedId) ?? null;

  return (
    <Container>
      <XStack alignItems="center" gap={8}>
        <ShieldCheck size={18} color="var(--color)" />
        <Text variant="h4" weight="bold">
          {String(t("admin.ebWaiverTitle"))}
        </Text>
      </XStack>

      <Text variant="caption" tone="muted">
        {String(t("admin.ebWaiverHint"))}
      </Text>

      {/* Legal disclaimer — UPL protection */}
      <XStack
        gap={10}
        padding={14}
        borderWidth={1}
        borderColor="$borderColor"
        backgroundColor="$surfaceMuted"
        alignItems="flex-start"
      >
        <Info
          size={14}
          color="var(--colorMuted)"
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <Text variant="caption" tone="muted" style={legalTextStyle}>
          Ithas Fire provides waiver templates as informational tools only.
          Ithas Fire is not a law firm and does not provide legal advice. Use of
          the waiver builder does not create an attorney-client relationship.
          Templates are not guaranteed to be enforceable in any jurisdiction.
          Waiver law varies by state — including states where pre-injury
          liability waivers are unenforceable. You are responsible for the
          waiver you deploy and should consult a licensed attorney in your state
          for events involving significant risk.
        </Text>
      </XStack>

      {/* Jurisdiction warning */}
      {jurisdiction.warning && (
        <XStack
          gap={10}
          padding={14}
          borderWidth={2}
          borderColor={jurisdiction.tier === "VOID" ? "$danger" : "$warning"}
          backgroundColor={
            jurisdiction.tier === "VOID"
              ? "rgba(239,68,68,0.06)"
              : "rgba(250,204,21,0.06)"
          }
          alignItems="flex-start"
        >
          <ShieldCheck
            size={16}
            color={
              jurisdiction.tier === "VOID" ? "var(--danger)" : "var(--warning)"
            }
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <YStack gap={4}>
            <Text
              variant="caption"
              weight="bold"
              color={jurisdiction.tier === "VOID" ? "$danger" : "$warning"}
            >
              {jurisdiction.tier === "VOID"
                ? "Waivers unenforceable in this state"
                : "Waiver enforceability restricted"}
            </Text>
            <Text variant="caption" tone="muted" style={legalTextStyle}>
              {jurisdiction.warning}
            </Text>
          </YStack>
        </XStack>
      )}

      {/* Template picker */}
      <select
        value={selectedId ?? ""}
        onChange={(e) => {
          const val = e.target.value;
          void handleChange(val || null);
        }}
        disabled={assignMutation.isPending || templatesQuery.isLoading}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: 14,
          fontFamily: "inherit",
          color: "var(--color)",
          background: "var(--surface)",
          border: "1px solid var(--borderColor)",
          borderRadius: 0,
          cursor: assignMutation.isPending ? "not-allowed" : "pointer",
          opacity: assignMutation.isPending ? 0.6 : 1,
        }}
      >
        <option value="">{String(t("admin.ebWaiverNone"))}</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.name}
            {tpl.isDefault ? " (platform)" : ""}
          </option>
        ))}
      </select>

      {/* Preview toggle */}
      {selectedTemplate && (
        <YStack gap={8}>
          <Button
            variant="ghost"
            size="$2"
            onPress={() =>
              setPreviewBody((prev) =>
                prev === selectedTemplate.body ? null : selectedTemplate.body,
              )
            }
          >
            {previewBody ? (
              <X size={14} aria-hidden />
            ) : (
              <Eye size={14} aria-hidden />
            )}
            {String(t("admin.ebWaiverPreviewLabel"))}
          </Button>

          {previewBody && (
            <YStack
              padding={16}
              borderRadius={0}
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$backgroundHover"
              maxHeight={300}
              style={{ overflowY: "auto" } as React.CSSProperties}
            >
              <Text variant="body" style={waiverPreviewTextStyle}>
                {previewBody}
              </Text>
            </YStack>
          )}
        </YStack>
      )}
    </Container>
  );
}
