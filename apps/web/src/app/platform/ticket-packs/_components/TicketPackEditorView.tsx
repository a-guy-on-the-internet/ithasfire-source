"use client";

/**
 * TicketPackEditorView — one pack's metadata and catalogue templates
 * (ticket-type-packs FR-012), with the DRAFT-inclusive "preview as an
 * organizer" read.
 *
 * Three deliberate separations, mirroring the use cases (and the volunteer
 * pack editor they were copied from):
 *
 * 1. **Save ≠ publish.** `upsert` never accepts a status; publishing is its
 *    own button, its own mutation and its own audit row.
 * 2. **Preview reads the SAVED pack**, not local editor state.
 * 3. **Templates are matched by NAME server-side.** Renaming one is
 *    delete + create; an owner who forked the old name keeps their copy and
 *    stops being shadowed.
 *
 * Money is entered in DOLLARS and stored in integer cents; the parse refuses
 * fractional cents rather than rounding silently.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack, styled } from "tamagui";
import { ArrowLeft, Eye, Plus, Trash2, Upload } from "lucide-react";
import {
  Button,
  Modal,
  Spinner,
  StyledSelect,
  Switch,
  Text,
  TextInput,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";

import type { TicketTypeTemplateEntry } from "@th/types";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { fmtCurrency } from "@/lib/format";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { PlatformTemplateTag } from "@/components/volunteering/PlatformTemplateTag";
import {
  PlatformContainer,
  PlatformPageTitle,
  PlatformSectionTitle,
  PlatformSubtitle,
} from "../../_components/PlatformPageParts";
import { TicketPackStatusPill } from "./TicketPackStatusPill";
import styles from "./ticket-packs.module.css";
import { lookupOwn } from "@/lib/lookup-own";

// ─────────────────────────────────────────────────────────────────────────────
// Swiss content primitives
// ─────────────────────────────────────────────────────────────────────────────

const Panel = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  padding: 16,
  gap: 12,
});

const TemplateCard = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
  padding: 16,
  gap: 12,
});

const StateFrame = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 28,
  gap: 12,
  alignItems: "center",
  justifyContent: "center",
  minHeight: 200,
  backgroundColor: "$surface",
});

/** Mirrors `MAX_PACK_TEMPLATES` in the use case. */
const MAX_PACK_TEMPLATES = 20;
const MAX_TEMPLATE_ENTRIES = 50;

/**
 * Canonical error code → existing `errors.*` copy (same resolution pattern
 * as the volunteer PackEditorView — see its PACK_ERROR_COPY_KEYS rationale).
 */
const PACK_ERROR_COPY_KEYS: Record<string, string> = {
  TICKET_PACK_NOT_FOUND: "errors.ticketPackNotFound",
  TICKET_PACK_KEY_TAKEN: "errors.ticketPackKeyTaken",
  TICKET_PACK_HAS_PLATFORM_TEMPLATES: "errors.ticketPackHasPlatformTemplates",
  TEMPLATE_NAME_TAKEN: "errors.templateNameTaken",
};

// ─────────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────────

interface EntryDraft {
  localId: string;
  name: string;
  /** Dollars, as typed. Parsed to integer cents on save. */
  price: string;
  pricingMode: "FIXED" | "ADJUSTABLE";
  minimum: string;
  suggested: string;
  capacity: string;
  transferAllowed: boolean;
  /**
   * FR-011's relative sales window / price flip, held as OPAQUE STATE.
   *
   * This editor has no anchor-and-offset control yet, and until it does the
   * only safe thing to do with a stored relative window is CARRY IT THROUGH
   * UNCHANGED. Rebuilding entries from the visible fields alone — which is what
   * `buildTemplatesPayload` does — would silently strip a catalogue template's
   * on-sale timing the first time a staff member fixed a typo in its name, and
   * "silently" is the operative word: nothing on screen would show the loss.
   *
   * `undefined` = the entry never had one. Kept as the port type rather than a
   * looser shape so a future control can bind straight to it.
   */
  salesOpen?: TicketTypeTemplateEntry["salesOpen"];
  salesClose?: TicketTypeTemplateEntry["salesClose"];
  scheduledPriceChange?: TicketTypeTemplateEntry["scheduledPriceChange"];
}

interface TemplateDraft {
  /** Local only — the server matches templates by NAME, never by id. */
  localId: string;
  name: string;
  entries: EntryDraft[];
}

const newLocalId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `pack-tpl-${Math.random().toString(36).slice(2, 10)}`;

function emptyEntryDraft(): EntryDraft {
  return {
    localId: newLocalId(),
    name: "",
    price: "",
    pricingMode: "FIXED",
    minimum: "",
    suggested: "",
    capacity: "",
    transferAllowed: true,
  };
}

function emptyTemplateDraft(): TemplateDraft {
  return { localId: newLocalId(), name: "", entries: [emptyEntryDraft()] };
}

/**
 * Dollars → integer cents. Empty → null. Refuses NaN, negatives and
 * fractional cents (0.001) rather than rounding silently — a staff typo must
 * fail loudly, never ship a surprise price.
 */
function parseDollarsToCents(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replace(/^\$/, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return "invalid";
  const cents = parsed * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) return "invalid";
  return Math.round(cents);
}

function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

export function TicketPackEditorView({ packKey }: { packKey: string }) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const router = useRouter();
  const utils = trpc.useUtils();

  // `get` keys on the pack ID, the route on the stable slug — the list is
  // also the key→id lookup (same shape as the volunteer editor).
  const listQuery = trpc.platform.ticketPacks.list.useQuery(
    {},
    { staleTime: 15_000 },
  );
  const packSummary = useMemo(
    () => listQuery.data?.packs.find((pack) => pack.key === packKey) ?? null,
    [listQuery.data?.packs, packKey],
  );
  const packId = packSummary?.id ?? null;

  const packQuery = trpc.platform.ticketPacks.get.useQuery(
    { packId: packId ?? "" },
    { enabled: !!packId, staleTime: 5_000 },
  );

  // ── Editor state ─────────────────────────────────────────────────────────

  const [name, setName] = useState("");
  const [blurb, setBlurb] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [templates, setTemplates] = useState<TemplateDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  /** Re-seed after every save — server reconciles by name, ids go stale. */
  const [seedVersion, setSeedVersion] = useState(0);
  const seededForRef = useRef<string | null>(null);

  const pack = packQuery.data?.pack ?? null;

  useEffect(() => {
    if (!pack) return;
    const token = `${pack.id}:${seedVersion}`;
    if (seededForRef.current === token) return;
    seededForRef.current = token;

    setName(pack.name);
    setBlurb(pack.blurb ?? "");
    setSortOrder(String(pack.sortOrder));
    setTemplates(
      pack.templates.map((template) => ({
        localId: newLocalId(),
        name: template.name,
        entries: template.ticketTypes.map((entry) => ({
          localId: newLocalId(),
          name: entry.name,
          price: centsToDollarsInput(entry.priceCents),
          pricingMode: entry.pricingMode,
          minimum: centsToDollarsInput(entry.minimumCents),
          suggested: centsToDollarsInput(entry.suggestedCents),
          capacity: String(entry.capacity),
          transferAllowed: entry.transferAllowed,
          // Carried, not rendered — see EntryDraft.salesOpen.
          salesOpen: entry.salesOpen,
          salesClose: entry.salesClose,
          scheduledPriceChange: entry.scheduledPriceChange,
        })),
      })),
    );
    setDirty(false);
    setSaveError(null);
  }, [pack, seedVersion]);

  // ── Mutations ────────────────────────────────────────────────────────────

  const upsertMutation = trpc.platform.ticketPacks.upsert.useMutation({
    meta: { silent: true },
  });
  const setStatusMutation = trpc.platform.ticketPacks.setStatus.useMutation({
    meta: { silent: true },
  });
  const removeMutation = trpc.platform.ticketPacks.remove.useMutation({
    meta: { silent: true },
  });

  const describePackError = useCallback(
    (err: unknown): string => {
      const code = getAppErrorCode(err);
      const key = lookupOwn(PACK_ERROR_COPY_KEYS, code);
      return key ? String(t(key)) : formatErrorMessage(err, t);
    },
    [t],
  );

  // ── Draft plumbing ───────────────────────────────────────────────────────

  const touch = () => {
    setDirty(true);
    setSaveError(null);
  };

  const updateTemplate = (localId: string, patch: Partial<TemplateDraft>) => {
    setTemplates((prev) =>
      prev.map((tpl) => (tpl.localId === localId ? { ...tpl, ...patch } : tpl)),
    );
    touch();
  };

  const updateEntry = (
    templateId: string,
    entryId: string,
    patch: Partial<EntryDraft>,
  ) => {
    setTemplates((prev) =>
      prev.map((tpl) =>
        tpl.localId === templateId
          ? {
              ...tpl,
              entries: tpl.entries.map((entry) =>
                entry.localId === entryId ? { ...entry, ...patch } : entry,
              ),
            }
          : tpl,
      ),
    );
    touch();
  };

  // ── Save ─────────────────────────────────────────────────────────────────

  const buildPayloadTemplates = useCallback(():
    | { ok: true; templates: Array<{ name: string; ticketTypes: unknown[] }> }
    | { ok: false; error: string } => {
    const out: Array<{ name: string; ticketTypes: unknown[] }> = [];
    for (const tpl of templates) {
      const tplName = tpl.name.trim();
      if (!tplName) {
        return { ok: false, error: String(t("admin.ticketPackTplNameRequired")) };
      }
      const ticketTypes: unknown[] = [];
      for (const entry of tpl.entries) {
        const entryName = entry.name.trim();
        if (!entryName) {
          return {
            ok: false,
            error: String(t("admin.ticketPackEntryNameRequired")),
          };
        }
        const price = parseDollarsToCents(entry.price);
        const minimum = parseDollarsToCents(entry.minimum);
        const suggested = parseDollarsToCents(entry.suggested);
        if (
          price === "invalid" ||
          minimum === "invalid" ||
          suggested === "invalid"
        ) {
          return {
            ok: false,
            error: String(t("admin.ticketPackEntryMoneyInvalid", {
              name: entryName,
            })),
          };
        }
        const capacity = Number(entry.capacity);
        if (!Number.isInteger(capacity) || capacity < 1) {
          return {
            ok: false,
            error: String(
              t("admin.ticketPackEntryCapacityInvalid", { name: entryName }),
            ),
          };
        }
        const isAdjustable = entry.pricingMode === "ADJUSTABLE";
        ticketTypes.push({
          name: entryName,
          priceCents: isAdjustable ? 0 : (price ?? 0),
          pricingMode: entry.pricingMode,
          minimumCents: isAdjustable ? (minimum ?? 0) : null,
          suggestedCents: isAdjustable ? suggested : null,
          capacity,
          // Platform default-OFF gate: catalogue entries never ship resale.
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: entry.transferAllowed,
          // Round-tripped untouched (FR-011). `?? null` rather than omitted so
          // the payload is explicit about "no window" either way.
          salesOpen: entry.salesOpen ?? null,
          salesClose: entry.salesClose ?? null,
          scheduledPriceChange: entry.scheduledPriceChange ?? null,
        });
      }
      if (ticketTypes.length === 0) {
        return {
          ok: false,
          error: String(t("admin.ticketPackTplEntriesRequired")),
        };
      }
      out.push({ name: tplName, ticketTypes });
    }
    return { ok: true, templates: out };
  }, [templates, t]);

  const handleSave = useCallback(async () => {
    if (!pack) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveError(String(t("admin.ticketPackNameRequired")));
      return;
    }
    const payload = buildPayloadTemplates();
    if (!payload.ok) {
      setSaveError(payload.error);
      return;
    }
    const parsedSortOrder = Number(sortOrder);
    try {
      await upsertMutation.mutateAsync({
        key: pack.key,
        name: trimmedName,
        blurb: blurb.trim() === "" ? null : blurb.trim(),
        ...(Number.isInteger(parsedSortOrder) && parsedSortOrder >= 0
          ? { sortOrder: parsedSortOrder }
          : {}),
        templates: payload.templates as never,
      });
      toast.success({
        id: "ticket-pack-saved",
        title: String(t("admin.ticketPackSaved")),
      });
      setSeedVersion((v) => v + 1);
      await Promise.all([
        utils.platform.ticketPacks.get.invalidate({ packId: pack.id }),
        utils.platform.ticketPacks.list.invalidate(undefined, {
          refetchType: "all",
        }),
      ]);
    } catch (err) {
      setSaveError(describePackError(err));
    }
  }, [
    pack,
    name,
    blurb,
    sortOrder,
    buildPayloadTemplates,
    upsertMutation,
    toast,
    t,
    utils.platform.ticketPacks.get,
    utils.platform.ticketPacks.list,
    describePackError,
  ]);

  const handleSetStatus = useCallback(
    async (status: "DRAFT" | "LIVE") => {
      if (!pack) return;
      try {
        await setStatusMutation.mutateAsync({ packId: pack.id, status });
        toast.success({
          id: "ticket-pack-status",
          title: String(
            t(
              status === "LIVE"
                ? "admin.ticketPackPublished"
                : "admin.ticketPackUnpublished",
            ),
          ),
        });
        await Promise.all([
          utils.platform.ticketPacks.get.invalidate({ packId: pack.id }),
          utils.platform.ticketPacks.list.invalidate(undefined, {
            refetchType: "all",
          }),
        ]);
      } catch (err) {
        toast.danger({
          id: "ticket-pack-status-failed",
          title: String(t("admin.ticketPackStatusFailed")),
          message: describePackError(err),
        });
      }
    },
    [
      pack,
      setStatusMutation,
      toast,
      t,
      utils.platform.ticketPacks.get,
      utils.platform.ticketPacks.list,
      describePackError,
    ],
  );

  const handleDelete = useCallback(async () => {
    if (!pack) return;
    try {
      await removeMutation.mutateAsync({ packId: pack.id });
      toast.success({
        id: "ticket-pack-deleted",
        title: String(t("admin.ticketPackDeleted")),
      });
      await utils.platform.ticketPacks.list.invalidate(undefined, {
        refetchType: "all",
      });
      router.push("/platform/ticket-packs");
    } catch (err) {
      setDeleteOpen(false);
      toast.danger({
        id: "ticket-pack-delete-failed",
        title: String(t("admin.ticketPackDeleteFailed")),
        message: describePackError(err),
      });
    }
  }, [
    pack,
    removeMutation,
    toast,
    t,
    utils.platform.ticketPacks.list,
    router,
    describePackError,
  ]);

  // ── Loading / missing states ─────────────────────────────────────────────

  if (listQuery.isLoading || (packId && packQuery.isLoading)) {
    return (
      <PlatformContainer size="lg">
        <StateFrame>
          <Spinner size="large" />
          <Text variant="body" tone="muted">
            {String(t("admin.ticketPacksLoading"))}
          </Text>
        </StateFrame>
      </PlatformContainer>
    );
  }

  if (!packId || !pack) {
    return (
      <PlatformContainer size="lg">
        <StateFrame>
          <Text variant="h4" weight="bold" textAlign="center">
            {String(t("admin.ticketPackNotFoundTitle"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
            {String(t("admin.ticketPackNotFoundDescription", { key: packKey }))}
          </Text>
          <Button
            variant="secondary"
            size="$4"
            onPress={() => router.push("/platform/ticket-packs")}
          >
            <ArrowLeft size={15} aria-hidden />
            {String(t("admin.ticketPackBackToList"))}
          </Button>
        </StateFrame>
      </PlatformContainer>
    );
  }

  const isLive = pack.status === "LIVE";
  const formatPrice = (cents: number) =>
    cents === 0 ? String(t("admin.ttFree")) : fmtCurrency(fmt, cents, "usd");

  return (
    <PlatformContainer size="lg">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <YStack gap={8}>
        <XStack gap={10} alignItems="center" flexWrap="wrap">
          <Button
            variant="ghost"
            size="$2"
            icon
            onPress={() => router.push("/platform/ticket-packs")}
            aria-label={String(t("admin.ticketPackBackToList"))}
            data-testid="ticket-pack-back"
          >
            <ArrowLeft size={16} aria-hidden />
          </Button>
          <PlatformPageTitle>{pack.name}</PlatformPageTitle>
          <TicketPackStatusPill status={pack.status} testId="ticket-pack-editor-status" />
        </XStack>
        <PlatformSubtitle>
          {String(t("admin.ticketPackEditorSubtitle"))}
        </PlatformSubtitle>
        <Text variant="code" tone="muted">
          {pack.key}
        </Text>
      </YStack>

      {/* ── Actions ────────────────────────────────────────────────────── */}
      <XStack gap={8} flexWrap="wrap">
        <Button
          variant="primary"
          size="$3"
          onPress={() => void handleSave()}
          disabled={!dirty || upsertMutation.isPending}
          data-testid="ticket-pack-save"
        >
          {String(
            t(
              upsertMutation.isPending
                ? "admin.ticketPackSaving"
                : "admin.ticketPackSaveCta",
            ),
          )}
        </Button>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => void handleSetStatus(isLive ? "DRAFT" : "LIVE")}
          disabled={setStatusMutation.isPending}
          data-testid="ticket-pack-publish-toggle"
        >
          <Upload size={14} aria-hidden />
          {String(
            t(
              isLive
                ? "admin.ticketPackUnpublishCta"
                : "admin.ticketPackPublishCta",
            ),
          )}
        </Button>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => setPreviewOpen(true)}
          data-testid="ticket-pack-preview"
        >
          <Eye size={14} aria-hidden />
          {String(t("admin.ticketPackPreviewCta"))}
        </Button>
        <Button
          variant="ghost"
          size="$3"
          onPress={() => setDeleteOpen(true)}
          data-testid="ticket-pack-delete"
        >
          <Trash2 size={14} aria-hidden />
          {String(t("admin.ticketPackDeleteCta"))}
        </Button>
      </XStack>
      {saveError ? (
        <Text variant="caption" tone="error" data-testid="ticket-pack-save-error">
          {saveError}
        </Text>
      ) : null}
      {isLive ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.ticketPackLiveEditWarning"))}
        </Text>
      ) : null}

      {/* ── Metadata ───────────────────────────────────────────────────── */}
      <Panel>
        <PlatformSectionTitle>
          {String(t("admin.ticketPackMetadataTitle"))}
        </PlatformSectionTitle>
        <XStack gap={12} flexWrap="wrap">
          <YStack gap={4} flex={2} minWidth={220}>
            <Text variant="label">{String(t("admin.ticketPackFieldName"))}</Text>
            <TextInput
              value={name}
              onChangeText={(value) => {
                setName(value);
                touch();
              }}
              maxLength={120}
              fullWidth
              aria-label={String(t("admin.ticketPackFieldName"))}
              testId="ticket-pack-field-name"
            />
          </YStack>
          <YStack gap={4} width={120}>
            <Text variant="label">
              {String(t("admin.ticketPackFieldSortOrder"))}
            </Text>
            <TextInput
              value={sortOrder}
              onChangeText={(value) => {
                setSortOrder(value);
                touch();
              }}
              inputMode="numeric"
              fullWidth
              aria-label={String(t("admin.ticketPackFieldSortOrder"))}
              testId="ticket-pack-field-sort"
            />
          </YStack>
        </XStack>
        <YStack gap={4}>
          <Text variant="label">{String(t("admin.ticketPackFieldBlurb"))}</Text>
          <TextInput
            value={blurb}
            onChangeText={(value) => {
              setBlurb(value);
              touch();
            }}
            maxLength={2000}
            multiline
            numberOfLines={3}
            fullWidth
            aria-label={String(t("admin.ticketPackFieldBlurb"))}
            testId="ticket-pack-field-blurb"
          />
          <Text variant="caption" tone="muted">
            {String(t("admin.ticketPackFieldBlurbHelp"))}
          </Text>
        </YStack>
      </Panel>

      {/* ── Templates ──────────────────────────────────────────────────── */}
      <Panel>
        <XStack justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={8}>
          <PlatformSectionTitle>
            {String(t("admin.ticketPackTemplatesTitle"))}
          </PlatformSectionTitle>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => {
              setTemplates((prev) => [...prev, emptyTemplateDraft()]);
              touch();
            }}
            disabled={templates.length >= MAX_PACK_TEMPLATES}
            data-testid="ticket-pack-add-template"
          >
            <Plus size={14} aria-hidden />
            {String(t("admin.ticketPackAddTemplateCta"))}
          </Button>
        </XStack>
        <Text variant="caption" tone="muted">
          {String(t("admin.ticketPackTemplatesHelp"))}
        </Text>

        {templates.length === 0 ? (
          <Text variant="body" tone="muted">
            {String(t("admin.ticketPackTemplatesEmpty"))}
          </Text>
        ) : (
          templates.map((template, templateIndex) => (
            <TemplateCard
              key={template.localId}
              data-testid={`ticket-pack-template-${templateIndex}`}
            >
              <XStack gap={12} alignItems="flex-end" flexWrap="wrap">
                <YStack gap={4} flex={1} minWidth={220}>
                  <Text variant="label">
                    {String(t("admin.ticketPackTplNameLabel"))}
                  </Text>
                  <TextInput
                    value={template.name}
                    onChangeText={(value) =>
                      updateTemplate(template.localId, { name: value })
                    }
                    maxLength={80}
                    fullWidth
                    aria-label={String(t("admin.ticketPackTplNameLabel"))}
                    testId={`ticket-pack-template-${templateIndex}-name`}
                  />
                </YStack>
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => {
                    setTemplates((prev) =>
                      prev.filter((tpl) => tpl.localId !== template.localId),
                    );
                    touch();
                  }}
                  aria-label={String(t("admin.ticketPackRemoveTemplateCta"))}
                  data-testid={`ticket-pack-template-${templateIndex}-remove`}
                >
                  <Trash2 size={14} aria-hidden />
                  {String(t("admin.ticketPackRemoveTemplateCta"))}
                </Button>
              </XStack>

              {template.entries.map((entry, entryIndex) => {
                const isAdjustable = entry.pricingMode === "ADJUSTABLE";
                const base = `ticket-pack-template-${templateIndex}-entry-${entryIndex}`;
                return (
                  <YStack key={entry.localId} gap={8}>
                    <div className={styles.entryRow}>
                      <YStack gap={4} minWidth={0}>
                        <Text variant="label">
                          {String(t("admin.ticketPackEntryNameLabel"))}
                        </Text>
                        <TextInput
                          value={entry.name}
                          onChangeText={(value) =>
                            updateEntry(template.localId, entry.localId, {
                              name: value,
                            })
                          }
                          maxLength={80}
                          fullWidth
                          aria-label={String(
                            t("admin.ticketPackEntryNameLabel"),
                          )}
                          testId={`${base}-name`}
                        />
                      </YStack>
                      <YStack gap={4}>
                        <Text variant="label">
                          {String(t("admin.ticketPackEntryModeLabel"))}
                        </Text>
                        <StyledSelect<"FIXED" | "ADJUSTABLE">
                          value={entry.pricingMode}
                          options={[
                            {
                              value: "FIXED",
                              label: String(
                                t("admin.ticketPackEntryModeFixed"),
                              ),
                            },
                            {
                              value: "ADJUSTABLE",
                              label: String(
                                t("admin.ticketPackEntryModeAdjustable"),
                              ),
                            },
                          ]}
                          onChange={(value) =>
                            updateEntry(template.localId, entry.localId, {
                              pricingMode: value,
                            })
                          }
                          fullWidth
                          testId={`${base}-mode`}
                        />
                      </YStack>
                      {isAdjustable ? (
                        <>
                          <YStack gap={4}>
                            <Text variant="label">
                              {String(t("admin.ticketPackEntryMinimumLabel"))}
                            </Text>
                            <TextInput
                              value={entry.minimum}
                              onChangeText={(value) =>
                                updateEntry(template.localId, entry.localId, {
                                  minimum: value,
                                })
                              }
                              inputMode="decimal"
                              fullWidth
                              aria-label={String(
                                t("admin.ticketPackEntryMinimumLabel"),
                              )}
                              testId={`${base}-minimum`}
                            />
                          </YStack>
                          <YStack gap={4}>
                            <Text variant="label">
                              {String(t("admin.ticketPackEntrySuggestedLabel"))}
                            </Text>
                            <TextInput
                              value={entry.suggested}
                              onChangeText={(value) =>
                                updateEntry(template.localId, entry.localId, {
                                  suggested: value,
                                })
                              }
                              inputMode="decimal"
                              fullWidth
                              aria-label={String(
                                t("admin.ticketPackEntrySuggestedLabel"),
                              )}
                              testId={`${base}-suggested`}
                            />
                          </YStack>
                        </>
                      ) : (
                        <YStack gap={4}>
                          <Text variant="label">
                            {String(t("admin.ticketPackEntryPriceLabel"))}
                          </Text>
                          <TextInput
                            value={entry.price}
                            onChangeText={(value) =>
                              updateEntry(template.localId, entry.localId, {
                                price: value,
                              })
                            }
                            inputMode="decimal"
                            fullWidth
                            aria-label={String(
                              t("admin.ticketPackEntryPriceLabel"),
                            )}
                            testId={`${base}-price`}
                          />
                        </YStack>
                      )}
                      <YStack gap={4}>
                        <Text variant="label">
                          {String(t("admin.ticketPackEntryCapacityLabel"))}
                        </Text>
                        <TextInput
                          value={entry.capacity}
                          onChangeText={(value) =>
                            updateEntry(template.localId, entry.localId, {
                              capacity: value,
                            })
                          }
                          inputMode="numeric"
                          fullWidth
                          aria-label={String(
                            t("admin.ticketPackEntryCapacityLabel"),
                          )}
                          testId={`${base}-capacity`}
                        />
                      </YStack>
                      <XStack gap={8} alignItems="center" paddingBottom={8}>
                        <Switch
                          checked={entry.transferAllowed}
                          onCheckedChange={(checked: boolean) =>
                            updateEntry(template.localId, entry.localId, {
                              transferAllowed: checked,
                            })
                          }
                          aria-label={String(
                            t("admin.ticketPackEntryTransferLabel"),
                          )}
                          testId={`${base}-transfer`}
                        />
                        <Text variant="caption" tone="muted">
                          {String(t("admin.ticketPackEntryTransferLabel"))}
                        </Text>
                        <Button
                          variant="ghost"
                          size="$2"
                          icon
                          onPress={() => {
                            updateTemplate(template.localId, {
                              entries: template.entries.filter(
                                (row) => row.localId !== entry.localId,
                              ),
                            });
                          }}
                          disabled={template.entries.length <= 1}
                          aria-label={String(
                            t("admin.ticketPackRemoveEntryCta"),
                          )}
                          data-testid={`${base}-remove`}
                        >
                          <Trash2 size={14} aria-hidden />
                        </Button>
                      </XStack>
                    </div>
                  </YStack>
                );
              })}

              <Button
                variant="ghost"
                size="$2"
                alignSelf="flex-start"
                onPress={() =>
                  updateTemplate(template.localId, {
                    entries: [...template.entries, emptyEntryDraft()],
                  })
                }
                disabled={template.entries.length >= MAX_TEMPLATE_ENTRIES}
                data-testid={`ticket-pack-template-${templateIndex}-add-entry`}
              >
                <Plus size={14} aria-hidden />
                {String(t("admin.ticketPackAddEntryCta"))}
              </Button>
            </TemplateCard>
          ))
        )}
      </Panel>

      {/* ── Preview (reads the SAVED pack) ─────────────────────────────── */}
      {previewOpen ? (
        <Modal open onClose={() => setPreviewOpen(false)}>
          <Modal.Panel width={560}>
            <Modal.Header
              title={String(t("admin.ticketPackPreviewTitle"))}
              onClose={() => setPreviewOpen(false)}
            />
            <Modal.Body>
              <YStack gap={12} data-testid="ticket-pack-preview-body">
                <Text variant="caption" tone="muted">
                  {String(t("admin.ticketPackPreviewHelp"))}
                </Text>
                <XStack gap={8} alignItems="center" flexWrap="wrap">
                  <Text variant="overline" tone="muted">
                    {pack.name}
                  </Text>
                  <PlatformTemplateTag />
                </XStack>
                {pack.blurb ? (
                  <Text variant="caption" tone="muted">
                    {pack.blurb}
                  </Text>
                ) : null}
                {pack.templates.map((template) => (
                  <YStack
                    key={template.id}
                    gap={4}
                    borderWidth={1}
                    borderColor="$borderColor"
                    padding={12}
                  >
                    <Text variant="bodySmall" weight="bold">
                      {template.name}
                    </Text>
                    {template.ticketTypes.map((entry) => (
                      <Text key={entry.name} variant="caption" tone="muted">
                        {entry.pricingMode === "ADJUSTABLE"
                          ? String(
                              t("admin.ttTplPreviewAdjustable", {
                                suggested: formatPrice(
                                  entry.suggestedCents ?? 0,
                                ),
                              }),
                            )
                          : formatPrice(entry.priceCents)}
                        {" · "}
                        {String(
                          t("admin.ttTplPreviewCapacity", {
                            capacity: entry.capacity,
                          }),
                        )}
                        {" — "}
                        {entry.name}
                      </Text>
                    ))}
                  </YStack>
                ))}
              </YStack>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                size="$3"
                onPress={() => setPreviewOpen(false)}
              >
                {String(t("admin.ticketPackPreviewClose"))}
              </Button>
            </Modal.Footer>
          </Modal.Panel>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title={String(t("admin.ticketPackDeleteConfirmTitle"))}
        description={String(
          t("admin.ticketPackDeleteConfirmDescription", { name: pack.name }),
        )}
        confirmLabel={String(t("admin.ticketPackDeleteCta"))}
        cancelLabel={String(t("admin.ttCancel"))}
        loading={removeMutation.isPending}
      />
    </PlatformContainer>
  );
}
