"use client";

import { useState, useCallback, useEffect, type ChangeEvent } from "react";
import { useRouter } from "@bprogress/next/app";
import { styled, useTheme, XStack, YStack } from "tamagui";
import {
  Lock,
  Unlock,
  FileQuestion,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  ClipboardList,
  Edit3,
  LayoutTemplate,
  Bell,
  BellOff,
} from "lucide-react";
import { Text, Button, Switch, TextInput, Modal, useTranslations } from "@th/ui";
import type { EventGateType, EventVisibility, WaitlistStatus } from "@th/types";
import { trpc } from "@/trpc";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { guardedNavigate } from "@/hooks/navigation-guard";
import { ApplicationTemplatePickerDialog } from "./ApplicationTemplatePickerDialog";
import { EventInviteSettings } from "./EventInviteSettings";
import type { TemplateOwnerRef } from "./TicketTypeTemplateControls";
import { NativeDateTimeInput } from "./_form-bits";
import { toDateTimeLocalValue } from "./event-builder-helpers";

const Container = styled(YStack, {
  gap: 24,
  padding: 32,
  backgroundColor: "$surface",
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

const Section = styled(YStack, { gap: 12 });

const SectionTitle = styled(Text, {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "$color",
});

const GateOptionCard = styled(XStack, {
  padding: 14,
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  gap: 14,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: { borderColor: "$borderColorHover" },
  variants: {
    selected: {
      true: { borderColor: "$color", backgroundColor: "$surfaceMuted" },
    },
    disabled: { true: { opacity: 0.5, cursor: "not-allowed" } },
  },
});

const GateIconContainer = styled(XStack, {
  width: 40,
  height: 40,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$surfaceMuted",
});

const GateContent = styled(YStack, { flex: 1, gap: 2 });

const ApplicationSection = styled(YStack, {
  padding: 16,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  gap: 16,
});

export type EventGateSettingsProps = {
  eventId: string;
  /** Admin slug for the "Review applications" link. */
  slug?: string;
  /**
   * The EVENT's owner — whose application-template library the "Start from a
   * template" picker lists. Not the URL workspace: a delegate on a principal's
   * event works in the principal's library.
   */
  templateOwner: TemplateOwnerRef;
  initialVisibility?: EventVisibility;
  initialGateType?: EventGateType;
  initialPasswordSet?: boolean;
  initialWaitlistStatus?: WaitlistStatus;
  initialWaitlistDescription?: string | null;
  initialWaitlistCap?: number | null;
  onVisibilityChange?: (visibility: EventVisibility) => void;
  onGateTypeChange?: (gateType: EventGateType) => void;
  onOpenFormBuilder?: () => void;
};

type GateOption = {
  type: EventGateType;
  titleKey: string;
  subtitleKey: string;
  icon: typeof Lock;
  themeKey: "info" | "warning" | "accent";
};

const GATE_OPTIONS: GateOption[] = [
  {
    type: "NONE",
    titleKey: "admin.gsGateNone",
    subtitleKey: "admin.gsGateNoneDesc",
    icon: Unlock,
    themeKey: "info",
  },
  {
    type: "PASSWORD",
    titleKey: "admin.gsGatePassword",
    subtitleKey: "admin.gsGatePasswordDesc",
    icon: Lock,
    themeKey: "warning",
  },
  {
    type: "APPLICATION",
    titleKey: "admin.gsGateApplication",
    subtitleKey: "admin.gsGateApplicationDesc",
    icon: FileQuestion,
    themeKey: "accent",
  },
];

export function EventGateSettings({
  eventId,
  slug,
  templateOwner,
  initialVisibility = "PUBLIC",
  initialGateType = "NONE",
  initialPasswordSet = false,
  initialWaitlistStatus = "DISABLED",
  initialWaitlistDescription = null,
  initialWaitlistCap = null,
  onVisibilityChange,
  onGateTypeChange,
  onOpenFormBuilder,
}: EventGateSettingsProps) {
  const [visibility, setVisibility] =
    useState<EventVisibility>(initialVisibility);
  const [gateType, setGateType] = useState<EventGateType>(initialGateType);
  const [passwordSet, setPasswordSet] = useState(initialPasswordSet);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const router = useRouter();
  const [saveError, setSaveError] = useState<string | null>(null);
  const theme = useTheme();
  const t = useTranslations();
  const { gates } = useFeatureGates();

  // The whole waitlist ("notify me") section is behind the `waitlists` gate.
  // Fail-CLOSED (`=== true`): while the gates load, or if the API is down, the
  // section is omitted entirely rather than rendered disabled — organisers
  // shouldn't be offered a switch for a half-built capability.
  const waitlistsGateOn = gates?.waitlists === true;

  // Waitlist state — simple on/off (OPEN or DISABLED)
  const [waitlistEnabled, setWaitlistEnabled] = useState(
    initialWaitlistStatus !== "DISABLED",
  );
  const [waitlistDescription, setWaitlistDescription] = useState(
    initialWaitlistDescription ?? "",
  );
  const [waitlistCap, setWaitlistCap] = useState(
    initialWaitlistCap?.toString() ?? "",
  );

  useEffect(() => {
    setVisibility(initialVisibility);
    setGateType(initialGateType);
    setPasswordSet(initialPasswordSet);
    setWaitlistEnabled(initialWaitlistStatus !== "DISABLED");
    setWaitlistDescription(initialWaitlistDescription ?? "");
    setWaitlistCap(initialWaitlistCap?.toString() ?? "");
  }, [
    initialVisibility,
    initialGateType,
    initialPasswordSet,
    initialWaitlistStatus,
    initialWaitlistDescription,
    initialWaitlistCap,
  ]);

  // The gate the SERVER holds, as distinct from the card selected above:
  // picking Password only changes local state until a password is saved,
  // and saving a password does not itself change the gate. The invite panel
  // follows this, from the props and every access-controls response.
  const [savedGate, setSavedGate] = useState({
    gateType: initialGateType,
    passwordSet: initialPasswordSet,
  });
  useEffect(() => {
    setSavedGate({ gateType: initialGateType, passwordSet: initialPasswordSet });
  }, [initialGateType, initialPasswordSet]);
  const updateAccessControls = trpc.events.updateAccessControls.useMutation({
    onSuccess: (saved) =>
      setSavedGate({ gateType: saved.gateType, passwordSet: saved.passwordSet }),
  });

  // ── Application lifecycle settings (spec Phase 2) ─────────────────────────
  // Window (opensAt/closesAt), submission cap, and auto-approve live on the
  // EventApplicationForm row; the question builder writes its own slice of
  // the same row (upsertApplicationForm preserves fields it isn't sent).
  const trpcUtils = trpc.useUtils();
  const appFormQuery = trpc.events.getApplicationForm.useQuery(
    { eventId },
    { enabled: gateType === "APPLICATION" },
  );
  const upsertApplicationForm = trpc.events.upsertApplicationForm.useMutation();

  // ── Template picker (spec Phase 4) ────────────────────────────────────────
  // Lists the EVENT owner's library (`templateOwner`), not the URL
  // workspace's — see the prop.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  // datetime-local strings in the organizer's local timezone ("" = unset).
  const [appOpensAt, setAppOpensAt] = useState("");
  const [appClosesAt, setAppClosesAt] = useState("");
  const [appMaxSubmissions, setAppMaxSubmissions] = useState("");
  const [appAutoApprove, setAppAutoApprove] = useState(false);

  useEffect(() => {
    const form = appFormQuery.data?.form;
    if (!form) return;
    setAppOpensAt(toDateTimeLocalValue(form.opensAt));
    setAppClosesAt(toDateTimeLocalValue(form.closesAt));
    setAppMaxSubmissions(form.maxSubmissions?.toString() ?? "");
    setAppAutoApprove(form.autoApprove);
  }, [appFormQuery.data?.form]);

  // Client-side mirror of the server's closesAt-after-opensAt refinement.
  const appWindowInvalid = (() => {
    if (!appOpensAt || !appClosesAt) return false;
    const opens = new Date(appOpensAt);
    const closes = new Date(appClosesAt);
    if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) {
      return false;
    }
    return closes.getTime() <= opens.getTime();
  })();

  /**
   * The cap is optional, but when present the server requires an integer
   * >= 1. Blank = uncapped. Anything else (a pasted "0", "-1", "1.5") is a
   * VISIBLE error rather than a silent coercion: treating 0 as "uncapped"
   * would quietly do the opposite of the organizer's intent ("accept
   * nobody"), and -1 would round-trip into a raw server error.
   */
  const appCapInvalid = (() => {
    const raw = appMaxSubmissions.trim();
    if (!raw) return false;
    const parsed = Number(raw);
    return !Number.isInteger(parsed) || parsed < 1;
  })();

  const handleAppSettingsSave = useCallback(async () => {
    if (isSaving || appWindowInvalid || appCapInvalid) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const rawMax = appMaxSubmissions.trim();
      const parsedMax = rawMax ? Number(rawMax) : null;
      await upsertApplicationForm.mutateAsync({
        eventId,
        opensAt: appOpensAt ? new Date(appOpensAt) : null,
        closesAt: appClosesAt ? new Date(appClosesAt) : null,
        // Explicit null = clear the cap. The `>= 1` guard is belt-and-braces:
        // `appCapInvalid` already blocked save for anything out of range.
        maxSubmissions:
          parsedMax !== null &&
          Number.isInteger(parsedMax) &&
          parsedMax >= 1
            ? parsedMax
            : null,
        autoApprove: appAutoApprove,
      });
      await trpcUtils.events.getApplicationForm.invalidate({ eventId });
    } catch (error) {
      console.error("Failed to save application settings:", error);
      setSaveError(t("admin.gsFailedAppSettings") as string);
    } finally {
      setIsSaving(false);
    }
  }, [
    isSaving,
    appWindowInvalid,
    appCapInvalid,
    appMaxSubmissions,
    appOpensAt,
    appClosesAt,
    appAutoApprove,
    eventId,
    upsertApplicationForm,
    trpcUtils,
    t,
  ]);

  const handleVisibilitySelect = useCallback(
    async (newVisibility: EventVisibility) => {
      if (isSaving || newVisibility === visibility) return;
      setIsSaving(true);
      setSaveError(null);
      try {
        await updateAccessControls.mutateAsync({
          eventId,
          visibility: newVisibility,
        });
        setVisibility(newVisibility);
        onVisibilityChange?.(newVisibility);
      } catch (error) {
        console.error("Failed to update visibility:", error);
        setSaveError(t("admin.gsFailedVisibility") as string);
      } finally {
        setIsSaving(false);
      }
    },
    [
      eventId,
      isSaving,
      onVisibilityChange,
      t,
      updateAccessControls,
      visibility,
    ],
  );

  const handleGateTypeSelect = useCallback(
    async (newType: EventGateType) => {
      if (isSaving) return;
      // Selecting PASSWORD opens the modal so the user can set/edit the password
      if (newType === "PASSWORD") {
        setGateType("PASSWORD");
        onGateTypeChange?.("PASSWORD");
        if (!passwordSet) {
          setSaveError(null);
          setPasswordModalOpen(true);
        }
        return;
      }
      setIsSaving(true);
      setSaveError(null);
      try {
        await updateAccessControls.mutateAsync({ eventId, gateType: newType });
        setGateType(newType);
        onGateTypeChange?.(newType);
      } catch (error) {
        console.error("Failed to update gate type:", error);
        setSaveError(t("admin.gsFailedAccess") as string);
      } finally {
        setIsSaving(false);
      }
    },
    [eventId, isSaving, onGateTypeChange, passwordSet, t, updateAccessControls],
  );

  const handlePasswordSave = useCallback(async () => {
    if (!password || password.length < 4) {
      setSaveError(t("admin.gsPasswordMinLength") as string);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateAccessControls.mutateAsync({
        eventId,
        password,
        gateType: gateType !== "PASSWORD" ? "PASSWORD" : undefined,
      });
      setPasswordSet(true);
      setPassword("");
      if (gateType !== "PASSWORD") {
        setGateType("PASSWORD");
        onGateTypeChange?.("PASSWORD");
      }
      setPasswordModalOpen(false);
    } catch (error) {
      console.error("Failed to save password:", error);
      setSaveError(t("admin.gsFailedSavePassword") as string);
    } finally {
      setIsSaving(false);
    }
  }, [eventId, gateType, onGateTypeChange, password, t, updateAccessControls]);

  const handleClearPassword = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateAccessControls.mutateAsync({
        eventId,
        password: null,
        gateType: gateType === "PASSWORD" ? "NONE" : undefined,
      });
      setPasswordSet(false);
      setPassword("");
      if (gateType === "PASSWORD") {
        setGateType("NONE");
        onGateTypeChange?.("NONE");
      }
      setPasswordModalOpen(false);
    } catch (error) {
      console.error("Failed to clear password:", error);
      setSaveError(t("admin.gsFailedClearPassword") as string);
    } finally {
      setIsSaving(false);
    }
  }, [eventId, gateType, onGateTypeChange, t, updateAccessControls]);

  const handleClosePasswordModal = useCallback(() => {
    if (!passwordSet && gateType === "PASSWORD") {
      // Revert if they never actually set one
      setGateType(initialGateType === "PASSWORD" ? "PASSWORD" : "NONE");
    }
    setPassword("");
    setSaveError(null);
    setPasswordModalOpen(false);
  }, [passwordSet, gateType, initialGateType]);

  // ── Waitlist handlers ─────────────────────────────────────────────────────

  const handleWaitlistToggle = useCallback(async () => {
    if (isSaving) return;
    const newStatus: WaitlistStatus = waitlistEnabled ? "DISABLED" : "OPEN";
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateAccessControls.mutateAsync({
        eventId,
        waitlist: { status: newStatus },
      });
      setWaitlistEnabled(!waitlistEnabled);
    } catch (error) {
      console.error("Failed to update waitlist status:", error);
      setSaveError(t("admin.gsFailedWaitlistStatus") as string);
    } finally {
      setIsSaving(false);
    }
  }, [eventId, isSaving, waitlistEnabled, updateAccessControls, t]);

  const handleWaitlistDetailsSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const capValue = waitlistCap.trim() ? parseInt(waitlistCap, 10) : null;
      await updateAccessControls.mutateAsync({
        eventId,
        waitlist: {
          description: waitlistDescription.trim() || null,
          cap: capValue && !Number.isNaN(capValue) ? capValue : null,
        },
      });
    } catch (error) {
      console.error("Failed to update waitlist details:", error);
      setSaveError(t("admin.gsFailedWaitlistDetails") as string);
    } finally {
      setIsSaving(false);
    }
  }, [eventId, waitlistDescription, waitlistCap, updateAccessControls, t]);

  return (
    <Container data-testid="gate-settings">
      {/* Visibility section */}
      <Section>
        <SectionTitle>{String(t("admin.gsVisibility"))}</SectionTitle>
        <YStack gap={8}>
          <GateOptionCard
            selected={visibility === "PUBLIC"}
            disabled={isSaving}
            onPress={() => {
              void handleVisibilitySelect("PUBLIC");
            }}
            data-testid="visibility-public"
          >
            <GateIconContainer>
              <Eye size={20} color={theme.info?.val} />
            </GateIconContainer>
            <GateContent>
              <XStack alignItems="center" gap={8}>
                <Text
                  style={{ fontSize: 15, fontWeight: "700" }}
                  color="$color"
                >
                  {String(t("admin.gsPublic"))}
                </Text>
                {visibility === "PUBLIC" && (
                  <Check size={14} color={theme.success?.val} strokeWidth={3} />
                )}
              </XStack>
              <Text style={{ fontSize: 13 }} tone="muted">
                {String(t("admin.gsPublicDesc"))}
              </Text>
            </GateContent>
          </GateOptionCard>
          <GateOptionCard
            selected={visibility === "PRIVATE"}
            disabled={isSaving}
            onPress={() => {
              void handleVisibilitySelect("PRIVATE");
            }}
            data-testid="visibility-private"
          >
            <GateIconContainer>
              <EyeOff size={20} color={theme.warning?.val} />
            </GateIconContainer>
            <GateContent>
              <XStack alignItems="center" gap={8}>
                <Text
                  style={{ fontSize: 15, fontWeight: "700" }}
                  color="$color"
                >
                  {String(t("admin.gsPrivate"))}
                </Text>
                {visibility === "PRIVATE" && (
                  <Check size={14} color={theme.success?.val} strokeWidth={3} />
                )}
              </XStack>
              <Text style={{ fontSize: 13 }} tone="muted">
                {String(t("admin.gsPrivateDesc"))}
              </Text>
            </GateContent>
          </GateOptionCard>
        </YStack>
      </Section>

      {/* Gate type section */}
      <Section>
        <SectionTitle>{String(t("admin.gsAccessGate"))}</SectionTitle>
        <YStack gap={8}>
          {GATE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isSelected = gateType === option.type;
            return (
              <GateOptionCard
                key={option.type}
                selected={isSelected}
                disabled={isSaving}
                onPress={() => {
                  void handleGateTypeSelect(option.type);
                }}
                data-testid={`gate-option-${option.type.toLowerCase()}`}
              >
                <GateIconContainer>
                  <Icon size={20} color={theme[option.themeKey]?.val} />
                </GateIconContainer>
                <GateContent>
                  <XStack alignItems="center" gap={8}>
                    <Text
                      style={{ fontSize: 15, fontWeight: "700" }}
                      color="$color"
                    >
                      {String(t(option.titleKey))}
                    </Text>
                    {isSelected && (
                      <Check
                        size={14}
                        color={theme.success?.val}
                        strokeWidth={3}
                      />
                    )}
                  </XStack>
                  <Text style={{ fontSize: 13 }} tone="muted">
                    {String(t(option.subtitleKey))}
                  </Text>
                </GateContent>

                {/* Edit password button inline on the card */}
                {option.type === "PASSWORD" && isSelected && passwordSet && (
                  <Button
                    variant="ghost"
                    size="$2"
                    onPress={(e: { stopPropagation?: () => void }) => {
                      e.stopPropagation?.();
                      setSaveError(null);
                      setPasswordModalOpen(true);
                    }}
                    data-testid="gate-password-edit-btn"
                  >
                    <Edit3 size={14} aria-hidden />
                    {String(t("admin.gsEdit"))}
                  </Button>
                )}
              </GateOptionCard>
            );
          })}
        </YStack>
      </Section>

      {/* Invite link + invited guests: only behind the SAVED gate. */}
      {((savedGate.gateType === "PASSWORD" && savedGate.passwordSet) ||
        savedGate.gateType === "APPLICATION") && (
        <EventInviteSettings
          eventId={eventId}
          gateType={savedGate.gateType}
          owner={templateOwner}
        />
      )}

      {/* Application section — show only when APPLICATION gate is selected */}
      {gateType === "APPLICATION" && (
        <Section>
          <SectionTitle>{String(t("admin.gsApplicationForm"))}</SectionTitle>
          <ApplicationSection>
            <Text style={{ fontSize: 13 }} tone="muted">
              {String(t("admin.gsApplicationFormDesc"))}
            </Text>
            <XStack gap={12} flexWrap="wrap">
              {/* "Start from a template" sits BESIDE the blank-form CTA (spec
                  Phase 4). */}
              <Button
                variant="secondary"
                size="$3"
                onPress={() => setTemplatePickerOpen(true)}
                disabled={isSaving}
                data-testid="gate-start-from-template-btn"
              >
                <LayoutTemplate size={16} aria-hidden />
                {String(t("admin.aftStartFromTemplate"))}
              </Button>
              <Button
                variant="secondary"
                size="$3"
                onPress={onOpenFormBuilder}
                disabled={isSaving}
                data-testid="gate-edit-application-form-btn"
              >
                <FileQuestion size={16} aria-hidden />
                {String(t("admin.gsEditApplicationForm"))}
              </Button>
              {slug && (
                <Button
                  variant="secondary"
                  size="$3"
                  // Through the builder's unsaved-changes guard: a button,
                  // so no link click reaches it.
                  onPress={() =>
                    guardedNavigate(() =>
                      router.push(
                        `/admin/${slug}/events/${eventId}/applications`,
                      ),
                    )
                  }
                  data-testid="gate-review-applications-btn"
                >
                  <ClipboardList size={16} aria-hidden />
                  {String(t("admin.gsReviewApplications"))}
                </Button>
              )}
            </XStack>

            {/* ── Lifecycle: window, cap, auto-approve (spec Phase 2) ── */}
            <YStack
              gap={12}
              paddingTop={16}
              borderTopWidth={1}
              borderTopColor="$borderColor"
              data-testid="application-lifecycle-settings"
            >
              <Text
                style={{ fontSize: 13, fontWeight: "700" }}
                color="$color"
              >
                {String(t("admin.gsAppSettings"))}
              </Text>

              <XStack gap={12} flexWrap="wrap">
                <YStack gap={4} flex={1} minWidth={200}>
                  <Text style={{ fontSize: 13 }} color="$color">
                    {String(t("admin.gsAppOpensAt"))}
                  </Text>
                  <NativeDateTimeInput
                    type="datetime-local"
                    value={appOpensAt}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setAppOpensAt(e.target.value)
                    }
                    aria-label={String(t("admin.gsAppOpensAt"))}
                    data-testid="application-opens-at"
                  />
                </YStack>
                <YStack gap={4} flex={1} minWidth={200}>
                  <Text style={{ fontSize: 13 }} color="$color">
                    {String(t("admin.gsAppClosesAt"))}
                  </Text>
                  <NativeDateTimeInput
                    type="datetime-local"
                    value={appClosesAt}
                    min={appOpensAt || undefined}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setAppClosesAt(e.target.value)
                    }
                    aria-invalid={appWindowInvalid || undefined}
                    aria-describedby={
                      appWindowInvalid
                        ? "application-window-error"
                        : undefined
                    }
                    aria-label={String(t("admin.gsAppClosesAt"))}
                    data-testid="application-closes-at"
                  />
                </YStack>
              </XStack>
              <Text style={{ fontSize: 11 }} tone="muted">
                {String(t("admin.gsAppWindowHint"))}
              </Text>
              {appWindowInvalid && (
                <Text
                  id="application-window-error"
                  style={{ fontSize: 12 }}
                  tone="error"
                  role="alert"
                >
                  {String(t("admin.gsAppWindowError"))}
                </Text>
              )}

              <YStack gap={4} maxWidth={240}>
                <Text style={{ fontSize: 13 }} color="$color">
                  {String(t("admin.gsAppMaxSubmissions"))}
                </Text>
                {/* inputMode + digit sanitizer, never type=number (RNW
                    caret-reversal trap). Leading zeros stripped so "0" can't
                    persist into a sub-1 cap the server would reject. */}
                <TextInput
                  value={appMaxSubmissions}
                  onChangeText={(v: string) =>
                    setAppMaxSubmissions(
                      v.replace(/[^0-9]/g, "").replace(/^0+/, ""),
                    )
                  }
                  inputMode="numeric"
                  maxLength={6}
                  status={appCapInvalid ? "error" : undefined}
                  aria-invalid={appCapInvalid || undefined}
                  aria-describedby={
                    appCapInvalid ? "application-cap-error" : undefined
                  }
                  aria-label={String(t("admin.gsAppMaxSubmissions"))}
                  testId="application-max-submissions"
                />
              </YStack>
              {appCapInvalid && (
                <Text
                  id="application-cap-error"
                  style={{ fontSize: 12 }}
                  tone="error"
                  role="alert"
                >
                  {String(t("admin.gsAppMaxSubmissionsError"))}
                </Text>
              )}
              <Text style={{ fontSize: 11 }} tone="muted">
                {String(t("admin.gsAppMaxSubmissionsHint"))}
              </Text>

              <YStack gap={4}>
                <Switch
                  size="small"
                  checked={appAutoApprove}
                  onCheckedChange={setAppAutoApprove}
                  label={String(t("admin.gsAppAutoApprove"))}
                />
                <Text style={{ fontSize: 11 }} tone="muted">
                  {String(t("admin.gsAppAutoApproveDesc"))}
                </Text>
              </YStack>

              <XStack>
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={() => {
                    void handleAppSettingsSave();
                  }}
                  disabled={isSaving || appWindowInvalid || appCapInvalid}
                  data-testid="application-settings-save-btn"
                >
                  {isSaving
                    ? String(t("admin.gsSaving"))
                    : String(t("admin.gsAppSettingsSave"))}
                </Button>
              </XStack>
            </YStack>
          </ApplicationSection>
        </Section>
      )}

      {/* Notify Me / Hype List section — gated on `waitlists` (default OFF) */}
      {waitlistsGateOn && (
        <Section>
          <SectionTitle>{t("admin.gsNotifyMe")}</SectionTitle>
          <Text style={{ fontSize: 13 }} tone="muted">
            {t("admin.gsNotifyMeDesc")}
          </Text>
          <YStack gap={8}>
            <GateOptionCard
              selected={!waitlistEnabled}
              disabled={isSaving}
              onPress={() => {
                if (waitlistEnabled) {
                  void handleWaitlistToggle();
                }
              }}
              data-testid="waitlist-option-disabled"
            >
              <GateIconContainer>
                <BellOff size={20} color={theme.info?.val} />
              </GateIconContainer>
              <GateContent>
                <XStack alignItems="center" gap={8}>
                  <Text
                    style={{ fontSize: 15, fontWeight: "700" }}
                    color="$color"
                  >
                    {t("admin.gsWaitlistOff")}
                  </Text>
                  {!waitlistEnabled && (
                    <Check
                      size={14}
                      color={theme.success?.val}
                      strokeWidth={3}
                    />
                  )}
                </XStack>
                <Text style={{ fontSize: 13 }} tone="muted">
                  {t("admin.gsWaitlistOffDesc")}
                </Text>
              </GateContent>
            </GateOptionCard>
            <GateOptionCard
              selected={waitlistEnabled}
              disabled={isSaving}
              onPress={() => {
                if (!waitlistEnabled) {
                  void handleWaitlistToggle();
                }
              }}
              data-testid="waitlist-option-open"
            >
              <GateIconContainer>
                <Bell size={20} color={theme.accent?.val} />
              </GateIconContainer>
              <GateContent>
                <XStack alignItems="center" gap={8}>
                  <Text
                    style={{ fontSize: 15, fontWeight: "700" }}
                    color="$color"
                  >
                    {t("admin.gsWaitlistOpen")}
                  </Text>
                  {waitlistEnabled && (
                    <Check
                      size={14}
                      color={theme.success?.val}
                      strokeWidth={3}
                    />
                  )}
                </XStack>
                <Text style={{ fontSize: 13 }} tone="muted">
                  {t("admin.gsWaitlistOpenDesc")}
                </Text>
              </GateContent>
            </GateOptionCard>
          </YStack>

          {waitlistEnabled && (
            <YStack
              gap={12}
              marginTop={12}
              padding={16}
              borderWidth={2}
              borderColor="$borderColor"
              borderRadius={0}
            >
              <YStack gap={4}>
                <Text style={{ fontSize: 13 }} color="$color">
                  {t("admin.gsWaitlistMessage")}
                </Text>
                <TextInput
                  value={waitlistDescription}
                  onChangeText={setWaitlistDescription}
                  placeholder={
                    t("admin.gsWaitlistMessagePlaceholder") as string
                  }
                  maxLength={2000}
                  testId="waitlist-description"
                />
              </YStack>
              <YStack gap={4}>
                <Text style={{ fontSize: 13 }} color="$color">
                  {t("admin.gsWaitlistCap")}
                </Text>
                <TextInput
                  value={waitlistCap}
                  onChangeText={setWaitlistCap}
                  placeholder={t("admin.gsWaitlistCapPlaceholder") as string}
                  maxLength={8}
                  testId="waitlist-cap"
                />
                <Text style={{ fontSize: 11 }} tone="muted">
                  {t("admin.gsWaitlistCapHint")}
                </Text>
              </YStack>
              <XStack>
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={() => {
                    void handleWaitlistDetailsSave();
                  }}
                  disabled={isSaving}
                  data-testid="waitlist-save-details-btn"
                >
                  {isSaving
                    ? t("admin.gsSaving")
                    : t("admin.gsWaitlistSaveDetails")}
                </Button>
              </XStack>
            </YStack>
          )}
        </Section>
      )}

      {/* Error banner */}
      {saveError && (
        <XStack
          padding={12}
          backgroundColor="$dangerMuted"
          borderRadius={0}
          gap={8}
          alignItems="center"
        >
          <AlertCircle size={16} color={theme.danger?.val} />
          <Text style={{ fontSize: 13, flex: 1 }} tone="error">
            {saveError}
          </Text>
        </XStack>
      )}

      {/* Template picker — fork-on-use apply onto this event's form. */}
      {templatePickerOpen ? (
        <ApplicationTemplatePickerDialog
          owner={templateOwner}
          eventId={eventId}
          onApplied={() => {
            setTemplatePickerOpen(false);
            void trpcUtils.events.getApplicationForm.invalidate({ eventId });
          }}
          onClose={() => setTemplatePickerOpen(false)}
        />
      ) : null}

      {/* Password modal */}
      <Modal open={passwordModalOpen} onClose={handleClosePasswordModal}>
        <Modal.Panel width={420} data-testid="password-modal">
          <Modal.Header
            title={
              passwordSet
                ? (t("admin.gsEditPassword") as string)
                : (t("admin.gsSetPassword") as string)
            }
            onClose={handleClosePasswordModal}
          />

          <Modal.Body>
            {passwordSet && (
              <XStack
                gap={6}
                alignItems="center"
                paddingVertical={8}
                paddingHorizontal={12}
                backgroundColor="$successMuted"
                borderRadius={0}
              >
                <Lock size={12} color={theme.success?.val} />
                <Text
                  style={{ fontSize: 12, fontWeight: "500" }}
                  color="$success"
                >
                  {String(t("admin.gsPasswordCurrentlySet"))}
                </Text>
              </XStack>
            )}

            <YStack gap={8}>
              <Text style={{ fontSize: 13 }} color="$color">
                {passwordSet
                  ? String(t("admin.gsEnterNewPassword"))
                  : String(t("admin.gsChoosePassword"))}
              </Text>
              <XStack position="relative">
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder={t("admin.gsEnterPasswordPlaceholder") as string}
                  secureTextEntry={!showPassword}
                  style={{ flex: 1, paddingRight: 44 }}
                  testId="password-input"
                />
                <XStack
                  position="absolute"
                  right={8}
                  top={0}
                  bottom={0}
                  alignItems="center"
                  justifyContent="center"
                  cursor="pointer"
                  onPress={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff size={18} color="var(--color)" />
                  ) : (
                    <Eye size={18} color="var(--color)" />
                  )}
                </XStack>
              </XStack>
            </YStack>

            {saveError && (
              <Text style={{ fontSize: 12 }} tone="error">
                {saveError}
              </Text>
            )}
          </Modal.Body>

          <Modal.Footer>
            <XStack flex={1}>
              {passwordSet ? (
                <Button
                  variant="ghost"
                  color="$danger"
                  size="$2"
                  onPress={() => {
                    void handleClearPassword();
                  }}
                  disabled={isSaving}
                  data-testid="password-remove-btn"
                >
                  {String(t("admin.gsRemovePassword"))}
                </Button>
              ) : (
                <YStack />
              )}
            </XStack>
            <Button
              variant="secondary"
              size="$2"
              onPress={handleClosePasswordModal}
              data-testid="password-cancel-btn"
            >
              {String(t("admin.gsCancel"))}
            </Button>
            <Button
              variant="primary"
              size="$2"
              onPress={() => {
                void handlePasswordSave();
              }}
              disabled={isSaving || password.length < 4}
              data-testid="password-save-btn"
            >
              {isSaving
                ? String(t("admin.gsSaving"))
                : String(t("admin.gsSavePassword"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>
    </Container>
  );
}

export default EventGateSettings;
