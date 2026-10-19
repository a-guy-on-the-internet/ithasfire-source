"use client";

import { useState, useMemo, useCallback } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { YStack, XStack } from "tamagui";
import {
  Text,
  Button,
  TextInput,
  StyledSelect,
  Checkbox,
  type StyledSelectOption,
  Modal,
  FormErrorBanner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Send, FlaskConical, Users, Info } from "lucide-react";

import type { ProseMirrorDoc } from "@th/schema";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";
import {
  ProseEditor,
  proseMirrorDocToHtml,
  createEmptyDoc,
  hasContent,
} from "@/app/admin/[slug]/events/new/_components/prose-editor";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type AudienceType =
  | "ALL_TICKET_HOLDERS"
  | "EVENT_TICKET_HOLDERS"
  | "MULTIPLE_EVENTS"
  | "EVENT_TICKET_TIER"
  | "CONTACT_LIST"
  | "WAITLIST_SUBSCRIBERS";

interface ComposeAnnouncementDialogProps {
  open: boolean;
  onClose: () => void;
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  onSent?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ComposeAnnouncementDialog({
  open,
  onClose,
  ownerType,
  ownerId,
  onSent,
}: ComposeAnnouncementDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();
  const utils = trpc.useUtils();

  // ── Form state ──────────────────────────────────────────────────────
  const [subject, setSubject] = useState("");
  const [audienceType, setAudienceType] =
    useState<AudienceType>("ALL_TICKET_HOLDERS");
  const [audienceRef, setAudienceRef] = useState<string | null>(null);
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [selectedTierEventId, setSelectedTierEventId] = useState<string | null>(
    null,
  );
  const [selectedTierIds, setSelectedTierIds] = useState<string[]>([]);
  const [excludedContactListId, setExcludedContactListId] = useState<
    string | null
  >(null);
  const [bodyDoc, setBodyDoc] = useState<ProseMirrorDoc>(createEmptyDoc());
  const [showConfirm, setShowConfirm] = useState(false);

  // ── Data queries for audience pickers ────────────────────────────────
  const shouldFetchEvents =
    open &&
    (audienceType === "EVENT_TICKET_HOLDERS" ||
      audienceType === "MULTIPLE_EVENTS" ||
      audienceType === "EVENT_TICKET_TIER" ||
      audienceType === "WAITLIST_SUBSCRIBERS");

  const { data: eventsData } = trpc.events.listMine.useQuery(
    { ownerType, ownerId, status: ["PUBLISHED"], limit: 100 },
    { enabled: shouldFetchEvents, staleTime: 60_000 },
  );

  const { data: audiencesData } = trpc.comms.listAudiences.useQuery(
    {
      owner: {
        kind: ownerType === "ORGANIZATION" ? "ORG" : "HUMAN",
        id: ownerId,
      },
    },
    { enabled: open, staleTime: 60_000 },
  );

  // Fetch ticket types when an event is selected for tier filtering
  const { data: ticketTypesData } = trpc.events.listTicketTypesForEdit.useQuery(
    { eventId: selectedTierEventId! },
    {
      enabled:
        open && audienceType === "EVENT_TICKET_TIER" && !!selectedTierEventId,
      staleTime: 60_000,
    },
  );

  // Fetch org to display physical address in the footer preview
  const { data: orgData } = trpc.orgs.getOrg.useQuery(
    { orgId: ownerId },
    { enabled: open && ownerType === "ORGANIZATION", staleTime: 120_000 },
  );

  // ── Audience filter for the count query ─────────────────────────────
  const audienceFilter = useMemo(() => {
    if (audienceType === "MULTIPLE_EVENTS" && selectedEventIds.length > 0) {
      return { eventIds: selectedEventIds };
    }
    if (
      audienceType === "EVENT_TICKET_TIER" &&
      selectedTierEventId &&
      selectedTierIds.length > 0
    ) {
      return { eventId: selectedTierEventId, tierIds: selectedTierIds };
    }
    return null;
  }, [audienceType, selectedEventIds, selectedTierEventId, selectedTierIds]);

  // ── Live recipient count ────────────────────────────────────────────
  const countEnabled = useMemo(() => {
    if (!open) return false;
    switch (audienceType) {
      case "ALL_TICKET_HOLDERS":
        return true;
      case "EVENT_TICKET_HOLDERS":
        return !!audienceRef;
      case "MULTIPLE_EVENTS":
        return selectedEventIds.length > 0;
      case "EVENT_TICKET_TIER":
        return !!selectedTierEventId && selectedTierIds.length > 0;
      case "CONTACT_LIST":
        return !!audienceRef;
      case "WAITLIST_SUBSCRIBERS":
        return !!audienceRef;
      default:
        return false;
    }
  }, [
    open,
    audienceType,
    audienceRef,
    selectedEventIds,
    selectedTierEventId,
    selectedTierIds,
  ]);

  const { data: recipientCountData, isLoading: isCountLoading } =
    trpc.announcements.previewAudienceCount.useQuery(
      {
        ownerType,
        ownerId,
        audienceType,
        audienceRef: audienceRef ?? undefined,
        audienceFilter: audienceFilter ?? undefined,
        excludedContactListId: excludedContactListId ?? undefined,
      },
      {
        enabled: countEnabled,
        staleTime: 30_000,
        placeholderData: keepPreviousData,
      },
    );

  // ── Mutations ───────────────────────────────────────────────────────
  const sendMutation = trpc.announcements.send.useMutation({
    meta: { silent: true },
  });

  const sendTestMutation = trpc.announcements.sendTest.useMutation({
    meta: { silent: true },
  });

  // ── Audience options ────────────────────────────────────────────────
  const audienceOptions: StyledSelectOption[] = useMemo(
    () => [
      {
        value: "ALL_TICKET_HOLDERS",
        label: String(t("admin.audienceAllTicketHolders")),
      },
      {
        value: "EVENT_TICKET_HOLDERS",
        label: String(t("admin.audienceEventTicketHolders")),
      },
      {
        value: "MULTIPLE_EVENTS",
        label: String(t("admin.audienceMultipleEvents")),
      },
      {
        value: "EVENT_TICKET_TIER",
        label: String(t("admin.audienceEventTicketTier")),
      },
      { value: "CONTACT_LIST", label: String(t("admin.audienceContactList")) },
      {
        value: "WAITLIST_SUBSCRIBERS",
        label: String(t("admin.audienceWaitlistSubscribers")),
      },
    ],
    [t],
  );

  const eventOptions: StyledSelectOption[] = useMemo(
    () =>
      (eventsData?.items ?? []).map((e) => ({
        value: e.id,
        label: e.title ?? "Untitled Event",
      })),
    [eventsData],
  );

  const contactListOptions: StyledSelectOption[] = useMemo(
    () =>
      (audiencesData ?? []).map((list) => ({
        value: list.id,
        label: list.name,
      })),
    [audiencesData],
  );

  const excludeOptions: StyledSelectOption[] = useMemo(
    () => [
      { value: "", label: String(t("admin.announcementExcludeNone")) },
      ...(audiencesData ?? []).map((list) => ({
        value: list.id,
        label: list.name,
      })),
    ],
    [audiencesData, t],
  );

  const tierOptions = useMemo(
    () => ticketTypesData?.ticketTypes ?? [],
    [ticketTypesData],
  );

  // ── Validation ──────────────────────────────────────────────────────
  const isValid = useMemo(() => {
    if (!subject.trim()) return false;
    if (!hasContent(bodyDoc)) return false;
    if (audienceType === "EVENT_TICKET_HOLDERS" && !audienceRef) return false;
    if (audienceType === "CONTACT_LIST" && !audienceRef) return false;
    if (audienceType === "WAITLIST_SUBSCRIBERS" && !audienceRef) return false;
    if (audienceType === "MULTIPLE_EVENTS" && selectedEventIds.length === 0)
      return false;
    if (
      audienceType === "EVENT_TICKET_TIER" &&
      (!selectedTierEventId || selectedTierIds.length === 0)
    )
      return false;
    return true;
  }, [
    subject,
    bodyDoc,
    audienceType,
    audienceRef,
    selectedEventIds,
    selectedTierEventId,
    selectedTierIds,
  ]);

  // ── Handlers ────────────────────────────────────────────────────────
  const handleAudienceTypeChange = useCallback((value: string) => {
    setAudienceType(value as AudienceType);
    setAudienceRef(null);
    setSelectedEventIds([]);
    setSelectedTierEventId(null);
    setSelectedTierIds([]);
  }, []);

  const handleToggleEvent = useCallback((eventId: string) => {
    setSelectedEventIds((prev) =>
      prev.includes(eventId)
        ? prev.filter((id) => id !== eventId)
        : [...prev, eventId],
    );
  }, []);

  const handleToggleTier = useCallback((tierId: string) => {
    setSelectedTierIds((prev) =>
      prev.includes(tierId)
        ? prev.filter((id) => id !== tierId)
        : [...prev, tierId],
    );
  }, []);

  const handleTierEventChange = useCallback((value: string) => {
    setSelectedTierEventId(value);
    setSelectedTierIds([]);
  }, []);

  const handleExcludeChange = useCallback((value: string) => {
    setExcludedContactListId(value || null);
  }, []);

  const resetForm = useCallback(() => {
    setSubject("");
    setAudienceType("ALL_TICKET_HOLDERS");
    setAudienceRef(null);
    setSelectedEventIds([]);
    setSelectedTierEventId(null);
    setSelectedTierIds([]);
    setExcludedContactListId(null);
    setBodyDoc(createEmptyDoc());
  }, []);

  const handleSend = useCallback(async () => {
    setShowConfirm(false);
    clearAll();

    const bodyHtml = proseMirrorDocToHtml(bodyDoc) || "";

    try {
      await sendMutation.mutateAsync({
        ownerType,
        ownerId,
        subject: subject.trim(),
        bodyDoc,
        bodyHtml,
        audienceType,
        audienceRef: audienceRef ?? undefined,
        audienceFilter: audienceFilter ?? undefined,
        excludedContactListId: excludedContactListId ?? undefined,
        eventId:
          audienceType === "EVENT_TICKET_HOLDERS"
            ? (audienceRef ?? undefined)
            : audienceType === "EVENT_TICKET_TIER"
              ? (selectedTierEventId ?? undefined)
              : audienceType === "WAITLIST_SUBSCRIBERS"
                ? (audienceRef ?? undefined)
                : undefined,
      });

      toast.success({
        title: String(t("admin.announcementSent")),
        message: String(t("admin.announcementSentDescription")),
      });

      resetForm();
      void utils.announcements.list.invalidate();
      onSent?.();
      onClose();
    } catch (error) {
      setError(error);
    }
  }, [
    ownerType,
    ownerId,
    subject,
    bodyDoc,
    audienceType,
    audienceRef,
    audienceFilter,
    excludedContactListId,
    selectedTierEventId,
    sendMutation,
    toast,
    t,
    utils,
    onSent,
    onClose,
    resetForm,
    clearAll,
    setError,
  ]);

  const handleSendTest = useCallback(async () => {
    clearAll();
    const bodyHtml = proseMirrorDocToHtml(bodyDoc) || "";
    if (!subject.trim() || !bodyHtml) return;

    try {
      const result = await sendTestMutation.mutateAsync({
        ownerType,
        ownerId,
        subject: subject.trim(),
        bodyHtml,
      });

      toast.success({
        title: String(t("admin.announcementTestSent")),
        message: String(
          t("admin.announcementTestSentDescription", {
            email: result.sentToEmail,
          }),
        ),
      });
    } catch (error) {
      setError(error);
    }
  }, [
    ownerType,
    ownerId,
    subject,
    bodyDoc,
    sendTestMutation,
    toast,
    t,
    clearAll,
    setError,
  ]);

  // ── Recipient count display ─────────────────────────────────────────
  const recipientCountLabel = useMemo(() => {
    if (!countEnabled) return null;
    if (isCountLoading)
      return String(t("admin.announcementRecipientCountLoading"));
    const count = recipientCountData?.count ?? 0;
    if (count === 0) return String(t("admin.announcementRecipientCountZero"));
    return String(t("admin.announcementRecipientCount", { count }));
  }, [countEnabled, isCountLoading, recipientCountData, t]);

  return (
    <>
      <Modal open={open} onClose={onClose}>
        <Modal.Panel width={640}>
          <Modal.Header
            title={String(t("admin.composeAnnouncementTitle"))}
            onClose={onClose}
          />
          <Modal.Body>
            <YStack gap="$4">
              <FormErrorBanner message={formError} onDismiss={clearAll} />
              {/* Subject */}
              <YStack gap="$2">
                <Text variant="caption" weight="bold">
                  {String(t("admin.announcementSubjectLabel"))}
                </Text>
                <TextInput
                  value={subject}
                  onChangeText={setSubject}
                  placeholder={String(
                    t("admin.announcementSubjectPlaceholder"),
                  )}
                  maxLength={200}
                />
              </YStack>

              {/* Audience type */}
              <YStack gap="$2">
                <Text variant="caption" weight="bold">
                  {String(t("admin.announcementAudienceLabel"))}
                </Text>
                <StyledSelect
                  value={audienceType}
                  options={audienceOptions}
                  onChange={handleAudienceTypeChange}
                  fullWidth
                />
              </YStack>

              {/* Event picker (when EVENT_TICKET_HOLDERS) */}
              {audienceType === "EVENT_TICKET_HOLDERS" && (
                <YStack gap="$2">
                  <StyledSelect
                    value={audienceRef ?? ""}
                    options={eventOptions}
                    onChange={setAudienceRef}
                    placeholder={String(t("admin.announcementSelectEvent"))}
                    fullWidth
                  />
                </YStack>
              )}

              {/* Event picker (when WAITLIST_SUBSCRIBERS) */}
              {audienceType === "WAITLIST_SUBSCRIBERS" && (
                <YStack gap="$2">
                  <StyledSelect
                    value={audienceRef ?? ""}
                    options={eventOptions}
                    onChange={setAudienceRef}
                    placeholder={String(t("admin.announcementSelectEvent"))}
                    fullWidth
                  />
                </YStack>
              )}

              {/* Multi-event picker (when MULTIPLE_EVENTS) */}
              {audienceType === "MULTIPLE_EVENTS" && (
                <YStack gap="$2">
                  <Text variant="caption" color="$textMuted">
                    {String(t("admin.announcementSelectEvents"))}
                  </Text>
                  <YStack
                    gap="$2"
                    padding="$2"
                    borderWidth={2}
                    borderColor="$borderColor"
                    borderRadius={0}
                    maxHeight={200}
                    overflow="hidden"
                  >
                    {eventOptions.map((evt) => (
                      <Checkbox
                        key={evt.value}
                        label={evt.label}
                        checked={selectedEventIds.includes(evt.value)}
                        onCheckedChange={() => handleToggleEvent(evt.value)}
                        size="sm"
                      />
                    ))}
                    {eventOptions.length === 0 && (
                      <Text variant="caption" color="$textMuted">
                        No published events
                      </Text>
                    )}
                  </YStack>
                </YStack>
              )}

              {/* Ticket tier picker (when EVENT_TICKET_TIER) */}
              {audienceType === "EVENT_TICKET_TIER" && (
                <YStack gap="$2">
                  <StyledSelect
                    value={selectedTierEventId ?? ""}
                    options={eventOptions}
                    onChange={handleTierEventChange}
                    placeholder={String(t("admin.announcementSelectEvent"))}
                    fullWidth
                  />
                  {selectedTierEventId && tierOptions.length > 0 && (
                    <YStack gap="$2">
                      <Text variant="caption" color="$textMuted">
                        {String(t("admin.announcementSelectTiers"))}
                      </Text>
                      <YStack
                        gap="$2"
                        padding="$2"
                        borderWidth={2}
                        borderColor="$borderColor"
                        borderRadius={0}
                      >
                        {tierOptions.map((tier) => (
                          <Checkbox
                            key={tier.id}
                            label={tier.name}
                            checked={selectedTierIds.includes(tier.id)}
                            onCheckedChange={() => handleToggleTier(tier.id)}
                            size="sm"
                          />
                        ))}
                      </YStack>
                    </YStack>
                  )}
                </YStack>
              )}

              {/* Contact list picker (when CONTACT_LIST) */}
              {audienceType === "CONTACT_LIST" && (
                <YStack gap="$2">
                  <StyledSelect
                    value={audienceRef ?? ""}
                    options={contactListOptions}
                    onChange={setAudienceRef}
                    placeholder={String(
                      t("admin.announcementSelectContactList"),
                    )}
                    fullWidth
                  />
                </YStack>
              )}

              {/* Exclusion list (available for ticket-holder audience types) */}
              {audienceType !== "CONTACT_LIST" &&
                audienceType !== "WAITLIST_SUBSCRIBERS" &&
                (audiencesData ?? []).length > 0 && (
                  <YStack gap="$2">
                    <Text variant="caption" weight="bold">
                      {String(t("admin.announcementExcludeContactList"))}
                    </Text>
                    <StyledSelect
                      value={excludedContactListId ?? ""}
                      options={excludeOptions}
                      onChange={handleExcludeChange}
                      fullWidth
                    />
                  </YStack>
                )}

              {/* Recipient count preview */}
              {recipientCountLabel && (
                <XStack
                  gap="$2"
                  alignItems="center"
                  padding="$2"
                  backgroundColor="$backgroundHover"
                  borderRadius="$0"
                >
                  <Users size={14} />
                  <Text
                    variant="caption"
                    color={
                      recipientCountData?.count === 0 && !isCountLoading
                        ? "$textDanger"
                        : "$textMuted"
                    }
                  >
                    {recipientCountLabel}
                  </Text>
                </XStack>
              )}

              {/* CAN-SPAM footer preview */}
              <YStack
                gap="$1"
                padding="$2"
                backgroundColor="$backgroundHover"
                borderRadius={0}
                borderWidth={2}
                borderColor="$borderColor"
              >
                <XStack gap="$2" alignItems="center">
                  <Info size={12} color="var(--colorMuted)" />
                  <Text variant="caption" weight="bold" color="$textMuted">
                    {String(t("admin.announcementFooterPreviewTitle"))}
                  </Text>
                </XStack>
                <XStack
                  gap="$2"
                  alignItems="center"
                  justifyContent="center"
                  paddingVertical="$2"
                  borderTopWidth={1}
                  borderColor="$borderColor"
                >
                  <Text
                    variant="caption"
                    color="$textMuted"
                    textDecorationLine="underline"
                  >
                    Unsubscribe
                  </Text>
                  {orgData?.physicalAddress ? (
                    <Text variant="caption" color="$textMuted">
                      &middot; {orgData.physicalAddress}
                    </Text>
                  ) : (
                    <Text
                      variant="caption"
                      color="$textDanger"
                      fontStyle="italic"
                    >
                      {String(t("admin.announcementFooterNoAddress"))}
                    </Text>
                  )}
                </XStack>
              </YStack>

              {/* Body editor */}
              <YStack gap="$2">
                <Text variant="caption" weight="bold">
                  {String(t("admin.announcementBodyLabel"))}
                </Text>
                {/* Announcements go out as email (announcement-html.ts), so
                    the editor previews the email typography, not the event
                    page's flourishes (gradient heading bar, quote glyph). */}
                <ProseEditor
                  initialContent={bodyDoc}
                  onChange={setBodyDoc}
                  typographyClassName="event-content-body event-content-body--email"
                />
              </YStack>
            </YStack>
          </Modal.Body>
          {/* The footer already wraps (Modal FooterContainer); the actions
              sit in it directly so that wrap can act. At 320 the Cancel +
              Send now pair drops below Send test, and marginLeft auto keeps
              it on the right edge when it does (same shape as the platform
              place panel's footer). */}
          <Modal.Footer justifyContent="space-between" gap="$2">
            <Button
              variant="ghost"
              minHeight={44}
              onPress={handleSendTest}
              disabled={
                !subject.trim() ||
                !hasContent(bodyDoc) ||
                sendTestMutation.isPending
              }
            >
              <FlaskConical size={14} />
              {String(t("admin.announcementSendTest"))}
            </Button>
            <XStack
              gap="$2"
              flexWrap="wrap"
              justifyContent="flex-end"
              marginLeft="auto"
            >
              <Button variant="ghost" minHeight={44} onPress={onClose}>
                {String(t("admin.cancel"))}
              </Button>
              <Button
                variant="primary"
                minHeight={44}
                onPress={() => setShowConfirm(true)}
                disabled={!isValid || sendMutation.isPending}
              >
                <Send size={14} />
                {sendMutation.isPending
                  ? String(t("admin.announcementSending"))
                  : String(t("admin.announcementSendNow"))}
              </Button>
            </XStack>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      {/* Confirmation modal */}
      <Modal open={showConfirm} onClose={() => setShowConfirm(false)}>
        <Modal.Panel width={440}>
          <Modal.Header
            title={String(t("admin.announcementConfirmTitle"))}
            onClose={() => setShowConfirm(false)}
          />
          <Modal.Body>
            <YStack gap="$2">
              <Text variant="body">
                {String(t("admin.announcementConfirmDescription"))}
              </Text>
              {recipientCountLabel && (
                <Text variant="caption" color="$textMuted">
                  {recipientCountLabel}
                </Text>
              )}
            </YStack>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="ghost"
              minHeight={44}
              onPress={() => setShowConfirm(false)}
            >
              {String(t("admin.cancel"))}
            </Button>
            <Button
              variant="primary"
              minHeight={44}
              onPress={handleSend}
              disabled={sendMutation.isPending}
            >
              {String(t("admin.announcementConfirmSend"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>
    </>
  );
}
