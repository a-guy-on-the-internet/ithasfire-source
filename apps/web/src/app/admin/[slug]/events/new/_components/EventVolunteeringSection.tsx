"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { YStack, XStack, styled } from "tamagui";
import { HeartHandshake, ArrowRight } from "lucide-react";
import {
  NextLinkAnchor,
  Text,
  Switch,
  CharCountTextarea,
  useNotify,
  useTranslations,
} from "@th/ui";
import { FieldLabel } from "./_form-bits";
import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { shouldShowManageRolesLink } from "./event-volunteering-section.helpers";

// ── Types ──────────────────────────────────────────────────────────────────

export type EventVolunteeringSectionProps = {
  /** Event id. When empty, the manage-roles link is hidden (event not yet saved). */
  eventId: string;
  /** Admin slug used to build the manage-roles link. */
  slug?: string;
  initialVolunteeringEnabled: boolean;
  initialVolunteerAutoApprove: boolean;
  initialVolunteerWaiverRequired: boolean;
  initialVolunteerIntroText: string | null;
  /**
   * Whether the event has a waiver template assigned. When explicitly
   * false, the require-waiver toggle still saves but shows a muted hint
   * that it has no effect until a waiver is assigned — the backend treats
   * "required but no template" as no-gate. Leave undefined when unknown.
   */
  hasWaiverAssigned?: boolean;
  /**
   * When true, suppresses the "Manage roles & shifts" link. Set this when
   * rendering the section inside the Volunteers tab itself — the link
   * would just point back to the page the user is already on.
   */
  hideManageRolesLink?: boolean;
  /**
   * When true, drops the section heading + description, removes the
   * Container's outer padding/maxWidth, and hides the auto-approve and
   * intro-text fields whenever volunteering is off — so the parent can
   * progressively disclose them after the user opts in.
   */
  embedded?: boolean;
  /** Notifies the parent when the enabled toggle flips, for live UI gating. */
  onEnabledChange?: (next: boolean) => void;
};

// ── Styles ─────────────────────────────────────────────────────────────────

const Container = styled(YStack, {
  gap: 16,
  padding: 32,
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

const EmbeddedWrapper = styled(YStack, {
  gap: 16,
  width: "100%",
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

const FieldLabelRow = styled(XStack, {
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
});

const ManageRolesLinkRow = styled(XStack, {
  alignItems: "center",
  gap: 6,
  paddingVertical: 8,
  hoverStyle: { opacity: 0.8 },
  cursor: "pointer",
});

const INTRO_MAX_LENGTH = 2000;
const INTRO_DEBOUNCE_MS = 600;

// ── Component ──────────────────────────────────────────────────────────────

export function EventVolunteeringSection({
  eventId,
  slug,
  initialVolunteeringEnabled,
  initialVolunteerAutoApprove,
  initialVolunteerWaiverRequired,
  initialVolunteerIntroText,
  hasWaiverAssigned,
  hideManageRolesLink,
  embedded,
  onEnabledChange,
}: EventVolunteeringSectionProps) {
  const t = useTranslations();
  const { toast } = useNotify();

  const [enabled, setEnabled] = useState(initialVolunteeringEnabled);
  const [autoApprove, setAutoApprove] = useState(initialVolunteerAutoApprove);
  const [waiverRequired, setWaiverRequired] = useState(
    initialVolunteerWaiverRequired,
  );
  const [introText, setIntroText] = useState(initialVolunteerIntroText ?? "");

  // Sync external refetch updates.
  useEffect(
    () => setEnabled(initialVolunteeringEnabled),
    [initialVolunteeringEnabled],
  );
  useEffect(
    () => setAutoApprove(initialVolunteerAutoApprove),
    [initialVolunteerAutoApprove],
  );
  useEffect(
    () => setWaiverRequired(initialVolunteerWaiverRequired),
    [initialVolunteerWaiverRequired],
  );
  useEffect(
    () => setIntroText(initialVolunteerIntroText ?? ""),
    [initialVolunteerIntroText],
  );

  const updateMutation = trpc.events.updateSettings.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const save = useCallback(
    async (patch: {
      volunteeringEnabled?: boolean;
      volunteerAutoApprove?: boolean;
      volunteerWaiverRequired?: boolean;
      volunteerIntroText?: string | null;
    }) => {
      if (!eventId) return;
      try {
        await updateMutation.mutateAsync({ eventId, ...patch });
        toast.success({
          id: "volunteering-saved",
          title: t("admin.ebVolunteeringSaved") as string,
        });
      } catch (err) {
        toast.danger({
          id: "volunteering-save-fail",
          title: t("admin.ebVolunteeringSaveFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [eventId, updateMutation, toast, t],
  );

  // Debounced save for intro text.
  const introTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnabledChange = useCallback(
    (next: boolean) => {
      setEnabled(next);
      onEnabledChange?.(next);
      if (!next && introTimerRef.current) {
        clearTimeout(introTimerRef.current);
        introTimerRef.current = null;
      }
      void save({ volunteeringEnabled: next });
    },
    [save, onEnabledChange],
  );

  const handleAutoApproveChange = useCallback(
    (next: boolean) => {
      setAutoApprove(next);
      void save({ volunteerAutoApprove: next });
    },
    [save],
  );

  const handleWaiverRequiredChange = useCallback(
    (next: boolean) => {
      setWaiverRequired(next);
      void save({ volunteerWaiverRequired: next });
    },
    [save],
  );

  const handleIntroChange = useCallback(
    (next: string) => {
      setIntroText(next);
      if (introTimerRef.current) clearTimeout(introTimerRef.current);
      introTimerRef.current = setTimeout(() => {
        introTimerRef.current = null;
        const trimmed = next.trim();
        void save({
          volunteerIntroText: trimmed.length === 0 ? null : trimmed,
        });
      }, INTRO_DEBOUNCE_MS);
    },
    [save],
  );

  useEffect(() => {
    return () => {
      if (introTimerRef.current) clearTimeout(introTimerRef.current);
    };
  }, []);

  const introHelpId = "volunteer-intro-help";

  const Wrapper = embedded ? EmbeddedWrapper : Container;
  const showSecondaryFields = !embedded || enabled;

  return (
    <Wrapper>
      {embedded ? null : (
        <>
          <XStack alignItems="center" gap={8}>
            <HeartHandshake size={18} color="var(--color)" />
            <Text variant="h4" weight="bold">
              {String(t("admin.ebVolunteeringTitle"))}
            </Text>
          </XStack>

          <Text variant="caption" tone="muted">
            {String(t("admin.ebVolunteeringDescription"))}
          </Text>
        </>
      )}

      {/* Enabled toggle */}
      <ToggleRow>
        <ToggleCopy>
          <FieldLabel id="volunteering-enabled-label">
            {String(t("admin.ebVolunteeringEnabledLabel"))}
          </FieldLabel>
          <Text variant="caption" tone="muted">
            {String(t("admin.ebVolunteeringEnabledHelp"))}
          </Text>
        </ToggleCopy>
        <Switch
          checked={enabled}
          onCheckedChange={handleEnabledChange}
          saving={updateMutation.isPending}
          aria-labelledby="volunteering-enabled-label"
        />
      </ToggleRow>

      {/* Auto-approve toggle — rendered disabled when volunteering is off, or hidden entirely in embedded mode. */}
      {showSecondaryFields ? (
        <ToggleRow>
          <ToggleCopy>
            <FieldLabel id="volunteering-auto-approve-label">
              {String(t("admin.ebVolunteeringAutoApproveLabel"))}
            </FieldLabel>
            <Text variant="caption" tone="muted">
              {String(t("admin.ebVolunteeringAutoApproveHelp"))}
            </Text>
          </ToggleCopy>
          <Switch
            checked={autoApprove}
            onCheckedChange={handleAutoApproveChange}
            disabled={!enabled}
            saving={updateMutation.isPending}
            aria-labelledby="volunteering-auto-approve-label"
          />
        </ToggleRow>
      ) : null}

      {/* Require-waiver toggle (Gap 3) — same row anatomy as auto-approve.
          Saving is allowed even without an assigned waiver template (the
          backend treats that as no-gate); the muted hint below explains
          why nothing changes until a waiver is assigned. */}
      {showSecondaryFields ? (
        <ToggleRow>
          <ToggleCopy>
            <FieldLabel id="volunteering-waiver-required-label">
              {String(t("admin.ebVolunteeringWaiverRequiredLabel"))}
            </FieldLabel>
            <Text variant="caption" tone="muted">
              {String(t("admin.ebVolunteeringWaiverRequiredHelp"))}
            </Text>
            {hasWaiverAssigned === false ? (
              <Text
                variant="caption"
                tone="muted"
                style={{ fontStyle: "italic" }}
              >
                {String(t("admin.ebVolunteeringWaiverRequiredNoWaiverHint"))}
              </Text>
            ) : null}
          </ToggleCopy>
          <Switch
            checked={waiverRequired}
            onCheckedChange={handleWaiverRequiredChange}
            disabled={!enabled}
            saving={updateMutation.isPending}
            aria-labelledby="volunteering-waiver-required-label"
          />
        </ToggleRow>
      ) : null}

      {/* Intro text — rendered disabled when volunteering is off, or hidden entirely in embedded mode. */}
      {showSecondaryFields ? (
        <YStack gap={8}>
          <FieldLabelRow>
            <FieldLabel id="volunteer-intro-label">
              {String(t("admin.ebVolunteeringIntroTextLabel"))}
            </FieldLabel>
          </FieldLabelRow>
          <Text id={introHelpId} variant="caption" tone="muted">
            {String(t("admin.ebVolunteeringIntroTextHelp"))}
          </Text>
          <div
            role="group"
            aria-labelledby="volunteer-intro-label"
            aria-describedby={introHelpId}
          >
            <CharCountTextarea
              value={introText}
              onChange={handleIntroChange}
              maxLength={INTRO_MAX_LENGTH}
              disabled={!enabled}
              placeholder={String(
                t("admin.ebVolunteeringIntroTextPlaceholder"),
              )}
              testIdBase="volunteer-intro-text"
            />
          </div>
        </YStack>
      ) : null}

      {/* Manage roles & shifts — only available once event is saved. */}
      {!hideManageRolesLink && shouldShowManageRolesLink(eventId, slug) ? (
        <NextLinkAnchor
          href={`/admin/${slug}/events/${eventId}/volunteers`}
          style={{ textDecoration: "none" }}
        >
          <ManageRolesLinkRow>
            <Text variant="caption" weight="bold" color="$brandSecondary">
              {String(t("admin.ebVolunteeringManageRolesLink"))}
            </Text>
            <ArrowRight size={14} color="var(--brandSecondary)" />
          </ManageRolesLinkRow>
        </NextLinkAnchor>
      ) : null}
    </Wrapper>
  );
}
