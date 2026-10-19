"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import { AlertCircle, Check, Eye, Info, ShieldCheck, X } from "lucide-react";
import {
  Badge,
  Button,
  StyledSelect,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";
import { trpc } from "@/trpc";
import { SECTION_HEADING_PROPS } from "./section-heading-props";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  WRAPPING_BUTTON_ICON_STYLE,
  WRAPPING_BUTTON_LABEL_PROPS,
  WRAPPING_BUTTON_PROPS,
  WRAPPING_BUTTON_ROW_PROPS,
} from "./wrapping-button-props";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WaiverTemplateSummary = {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
  /** Audience discriminator — VOLUNTEER + isDefault marks the platform standard. */
  kind: "ATTENDEE" | "VOLUNTEER";
};

export type AskWaiverSectionProps = {
  askId: string;
  /** Ask subject — EVENT asks keep event-level waivers and render nothing. */
  subjectType: "PLACE" | "ORG" | "HUMAN" | "EVENT";
  /** Owning org for ORG/PLACE subjects — drives the template list scope. */
  orgId?: string | null;
  /** Owning human for HUMAN subjects — drives the template list scope. */
  humanId?: string | null;
  /** Current waiver template id off the ask read, if any. */
  initialWaiverTemplateId: string | null;
  /** The ask's `waiverRequired` flag — drives the "no effect yet" hint. */
  waiverRequired: boolean;
  /** Called after a successful assign/clear so the parent re-reads the ask. */
  onAssigned?: () => void;
};

const bodyTextStyle: CSSProperties = { whiteSpace: "pre-wrap" };

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Waiver template picker for a standing volunteer ask (FR-007), adapted from
 * the event builder's `EventWaiverSection`: lists the owner's templates
 * (`waivers.listTemplates`, platform defaults included), assigns/clears via
 * `volunteer.asks.assignWaiver` with an optimistic select + rollback, offers a
 * one-click "standard volunteer waiver", previews the selected body, and warns
 * when the `waiverRequired` flag has no template behind it.
 */
export function AskWaiverSection({
  askId,
  subjectType,
  orgId,
  humanId,
  initialWaiverTemplateId,
  waiverRequired,
  onAssigned,
}: AskWaiverSectionProps) {
  const t = useTranslations();
  const { toast } = useNotify();

  const [selectedId, setSelectedId] = useState<string | null>(
    initialWaiverTemplateId,
  );
  const [previewOpen, setPreviewOpen] = useState(false);

  // The backend requires exactly one of orgId / humanId; skip the query
  // entirely until we have one (mirrors EventWaiverSection).
  const ownerParam = orgId ? { orgId } : humanId ? { humanId } : {};
  const templatesQuery = trpc.waivers.listTemplates.useQuery(ownerParam, {
    staleTime: 60_000,
    enabled: Boolean(orgId || humanId),
    retry: 1,
    meta: { silent: true },
  });

  const assignMutation = trpc.volunteer.asks.assignWaiver.useMutation({
    retry: false,
    meta: { silent: true },
  });

  // Re-sync after the parent re-reads the ask (post-assign invalidate).
  useEffect(() => {
    setSelectedId(initialWaiverTemplateId);
  }, [initialWaiverTemplateId]);

  const handleChange = useCallback(
    async (templateId: string | null) => {
      if (templateId === selectedId) return;
      const previous = selectedId;
      setSelectedId(templateId);
      setPreviewOpen(false);
      try {
        await assignMutation.mutateAsync({ askId, waiverTemplateId: templateId });
        toast.success({
          id: "ask-waiver-assign",
          title: String(
            templateId
              ? t("volunteering.waiverAssigned")
              : t("volunteering.waiverRemoved"),
          ),
        });
        onAssigned?.();
      } catch (err) {
        setSelectedId(previous);
        toast.danger({
          id: "ask-waiver-assign-fail",
          title: String(t("volunteering.waiverAssignFailed")),
          message: formatErrorMessage(err, t),
        });
      }
    },
    [selectedId, askId, assignMutation, toast, t, onAssigned],
  );

  // EVENT-subject asks carry their waiver on the event itself — defensive
  // guard (the standing-ask editor only ever renders PLACE/ORG/HUMAN).
  if (subjectType === "EVENT") return null;

  const templates: WaiverTemplateSummary[] = (
    templatesQuery.data?.templates ?? []
  ).map((tpl) => ({
    id: tpl.id,
    name: tpl.name,
    body: tpl.body,
    isDefault: tpl.isDefault,
    kind: tpl.kind,
  }));

  // The platform "Standard Volunteer Waiver" (FR-010), resolved by its honest
  // discriminator (kind VOLUNTEER + isDefault) rather than a hardcoded id —
  // a partial unique index guarantees at most one platform default per kind.
  const standardTemplate =
    templates.find((tpl) => tpl.kind === "VOLUNTEER" && tpl.isDefault) ?? null;

  const selectedTemplate =
    templates.find((tpl) => tpl.id === selectedId) ?? null;
  const standardSelected =
    selectedId !== null && selectedId === standardTemplate?.id;
  const busy = assignMutation.isPending;

  const options = [
    { value: "", label: String(t("volunteering.waiverNone")) },
    ...templates.map((tpl) => ({
      value: tpl.id,
      label:
        tpl.id === standardTemplate?.id
          ? `${tpl.name} (${String(t("volunteering.waiverStandardTag"))})`
          : tpl.isDefault
            ? `${tpl.name} (${String(t("volunteering.waiverPlatformTag"))})`
            : tpl.name,
    })),
  ];

  // Keep a selected-but-unlisted template visible (e.g. while the list is
  // still loading) so the control never renders blank.
  if (selectedId && !options.some((o) => o.value === selectedId)) {
    options.push({ value: selectedId, label: selectedId });
  }

  return (
    <YStack gap="$3" data-testid="ask-waiver-section">
      <XStack gap="$2" alignItems="center">
        <ShieldCheck size={18} color="var(--color)" />
        <Text tag="h2" variant="h4" weight="bold" {...SECTION_HEADING_PROPS}>
          {String(t("volunteering.waiverSectionTitle"))}
        </Text>
      </XStack>

      <Text variant="caption" tone="muted">
        {String(t("volunteering.waiverSectionHint"))}
      </Text>

      {/* One-click standard volunteer waiver (FR-010) */}
      {standardSelected ? (
        <XStack
          gap="$2"
          alignItems="center"
          data-testid="ask-waiver-standard-active"
        >
          <Check size={16} color="var(--success, #166534)" />
          <Badge tone="success" size="sm">
            {String(t("volunteering.waiverStandardInUse"))}
          </Badge>
        </XStack>
      ) : (
        <XStack>
          <Button
            variant="primary"
            size="$2"
            {...WRAPPING_BUTTON_PROPS}
            disabled={busy || !standardTemplate}
            onPress={() => {
              if (standardTemplate) void handleChange(standardTemplate.id);
            }}
            data-testid="ask-waiver-use-standard"
          >
            <XStack gap="$2" alignItems="center" {...WRAPPING_BUTTON_ROW_PROPS}>
              <ShieldCheck size={14} style={WRAPPING_BUTTON_ICON_STYLE} />
              <Text
                tone="inherit"
                variant="bodySmall"
                {...WRAPPING_BUTTON_LABEL_PROPS}
              >
                {String(t("volunteering.waiverUseStandard"))}
              </Text>
            </XStack>
          </Button>
        </XStack>
      )}

      {/* Full template picker */}
      <YStack gap="$1" maxWidth={520}>
        <Text variant="label">
          {String(t("volunteering.waiverTemplateLabel"))}
        </Text>
        <StyledSelect
          value={selectedId ?? ""}
          options={options}
          onChange={(value) => void handleChange(value || null)}
          disabled={busy || templatesQuery.isLoading}
          fullWidth
          aria-label={String(t("volunteering.waiverTemplateLabel"))}
          testId="ask-waiver-select"
        />
        {templatesQuery.isError ? (
          <Text variant="caption" color="$danger" role="alert">
            {String(t("volunteering.waiverTemplatesError"))}
          </Text>
        ) : null}
      </YStack>

      {/* Requirement / assignment mismatch hints (FR-007) */}
      {waiverRequired && selectedId === null ? (
        <XStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$warning"
          borderRadius={0}
          alignItems="flex-start"
          data-testid="ask-waiver-missing-warning"
        >
          <AlertCircle
            size={16}
            color="var(--warning, #92400E)"
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text variant="bodySmall" color="$warning">
            {String(t("volunteering.waiverNoTemplateWarning"))}
          </Text>
        </XStack>
      ) : null}
      {!waiverRequired && selectedId !== null ? (
        <XStack
          gap="$2"
          padding="$3"
          borderWidth={1}
          borderColor="$borderColor"
          borderRadius={0}
          alignItems="flex-start"
          data-testid="ask-waiver-not-required-note"
        >
          <Info
            size={14}
            color="var(--colorMuted)"
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.waiverNotRequiredNote"))}
          </Text>
        </XStack>
      ) : null}

      {/* Preview of the selected template body */}
      {selectedTemplate ? (
        <YStack gap="$2">
          <XStack>
            <Button
              variant="ghost"
              size="$2"
              minHeight={44}
              onPress={() => setPreviewOpen((prev) => !prev)}
              data-testid="ask-waiver-preview-toggle"
            >
              <XStack gap="$2" alignItems="center">
                {previewOpen ? <X size={14} /> : <Eye size={14} />}
                <Text variant="caption" weight="medium">
                  {String(t("volunteering.waiverPreviewLabel"))}
                </Text>
              </XStack>
            </Button>
          </XStack>
          {previewOpen ? (
            <YStack
              padding="$4"
              borderWidth={2}
              borderColor="$borderColor"
              borderRadius={0}
              backgroundColor="$backgroundHover"
              maxHeight={300}
              tabIndex={0}
              role="region"
              aria-label={selectedTemplate.name}
              style={{ overflowY: "auto" } as CSSProperties}
              data-testid="ask-waiver-preview-body"
            >
              <Text variant="body" style={bodyTextStyle}>
                {selectedTemplate.body}
              </Text>
            </YStack>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  );
}
