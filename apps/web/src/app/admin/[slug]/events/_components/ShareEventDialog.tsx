"use client";

import { useCallback, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Copy, Check, ExternalLink, Tag } from "lucide-react";
import { YStack, XStack } from "tamagui";
import { formatMoneyCents } from "@th/types";
import {
  Modal,
  Button,
  Text,
  TextInput,
  StyledSelect,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// ShareEventDialog
//
// Generates a shareable checkout URL for an event, optionally with a public
// promo code pre-applied. Two usage modes:
//
//   • Event-fixed (default): the caller passes a `fixedEvent` and the dialog
//     shows a promo dropdown only. Used from the events table and event
//     editor's own header.
//   • Promo-fixed: the caller passes `fixedPromo` and the dialog shows an
//     event dropdown instead. Used from the promos table row action.
//
// Only `isPublic: true` promos are listed for sharing — private codes don't
// auto-apply from `?p=` and showing them here would be misleading.
//
// The generated URL goes straight to the checkout page so the promo applies
// immediately. Tradeoff: skips the event detail/description page. If we
// later want to keep the event page as the landing surface, the URL state
// hook would need to be plumbed onto `/events/<slug>` too.
// ─────────────────────────────────────────────────────────────────────────────

type OwnerContext =
  | { kind: "human"; humanId: string }
  | { kind: "org"; orgId: string };

type ShareableEvent = {
  id: string;
  title: string | null;
  /** Full multi-segment public slug (orgSlug/country/region/eventSlug). */
  slug: string | null;
  status?: string;
};

type ShareablePromo = {
  id: string;
  code: string;
  kind: "PERCENT" | "AMOUNT";
  value: number;
  scope: "GLOBAL" | "ORG" | "EVENT" | "TICKET_TYPE" | "HUMAN";
  scopeId?: string | null;
  isPublic: boolean;
  status: string;
};

export type ShareEventDialogProps = {
  open: boolean;
  onClose: () => void;
  ownerContext: OwnerContext;
  /** Fixed event to share. Mutually exclusive with `fixedPromo`. */
  fixedEvent?: ShareableEvent;
  /** Fixed promo to share. Mutually exclusive with `fixedEvent`. */
  fixedPromo?: ShareablePromo;
  /** When promo is fixed, the caller passes the org's published events. */
  events?: ShareableEvent[];
};

const NO_PROMO_VALUE = "__none__";

/** Build the public checkout URL for an event, optionally with a promo applied. */
function buildShareUrl(
  eventSlugOrId: string,
  promoCode: string | null,
): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const base = `${origin}/events/checkout/${eventSlugOrId}`;
  if (!promoCode) return base;
  return `${base}?p=${encodeURIComponent(promoCode)}`;
}

function promoLabel(p: ShareablePromo): string {
  // A fixed-amount promo is money, so it formats like every other amount in
  // the product rather than hardcoding a dollar sign and a division by 100 —
  // which printed dollars for any non-USD promo and disagreed with the
  // discount the same code renders at checkout.
  const value =
    p.kind === "PERCENT"
      ? `${p.value}% off`
      : `${formatMoneyCents(p.value)} off`;
  return `${p.code} — ${value}`;
}

/** Promo applies to an event under the same scope rules as `evaluatePromoApplications`. */
function isPromoApplicableToEvent(
  promo: ShareablePromo,
  event: { id: string; orgId?: string | null },
  ownerContext: OwnerContext,
): boolean {
  if (promo.status !== "ACTIVE") return false;
  if (!promo.isPublic) return false;
  switch (promo.scope) {
    case "GLOBAL":
      // GLOBAL is blocked at creation; treat existing as not shareable.
      return false;
    case "ORG":
      if (ownerContext.kind !== "org") return false;
      return promo.scopeId === ownerContext.orgId;
    case "HUMAN":
      // Seller-wide scope for direct sellers — mirrors the checkout rule:
      // only the owning human's PERSONAL events qualify. In personal-admin
      // context every listed event is the human's own, so owner match is
      // the whole check here; the authoritative guard fires at checkout.
      if (ownerContext.kind !== "human") return false;
      return promo.scopeId === ownerContext.humanId;
    case "EVENT":
      return promo.scopeId === event.id;
    case "TICKET_TYPE":
      // Without ticket-type IDs in scope here, default to "maybe applies."
      // The real check fires at checkout; conservative UI shows it.
      return true;
    default:
      return false;
  }
}

export const ShareEventDialog = ({
  open,
  onClose,
  ownerContext,
  fixedEvent,
  fixedPromo,
  events,
}: ShareEventDialogProps) => {
  const t = useTranslations();
  const { toast } = useNotify();

  const ownerType =
    ownerContext.kind === "org" ? "ORGANIZATION" : ("HUMAN" as const);
  const ownerId =
    ownerContext.kind === "org" ? ownerContext.orgId : ownerContext.humanId;

  // Pull active public promos for this owner. Skipped when promo is fixed —
  // the caller already knows which promo this is.
  const promosQuery = trpc.promos.list.useQuery(
    {
      ownerType,
      ownerId,
      status: "ACTIVE",
      limit: 200,
    },
    {
      enabled: open && !fixedPromo,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const applicablePromos = useMemo<ShareablePromo[]>(() => {
    if (fixedPromo) return [fixedPromo];
    if (!promosQuery.data || !fixedEvent) return [];
    return promosQuery.data.items.filter((p) =>
      isPromoApplicableToEvent(
        p as ShareablePromo,
        { id: fixedEvent.id },
        ownerContext,
      ),
    ) as ShareablePromo[];
  }, [fixedPromo, promosQuery.data, fixedEvent, ownerContext]);

  // Selected promo (event-fixed mode) or selected event (promo-fixed mode).
  const [selectedPromoId, setSelectedPromoId] = useState<string>(NO_PROMO_VALUE);
  const [selectedEventId, setSelectedEventId] = useState<string>("");

  const selectedPromo = useMemo(() => {
    if (fixedPromo) return fixedPromo;
    if (selectedPromoId === NO_PROMO_VALUE) return null;
    return applicablePromos.find((p) => p.id === selectedPromoId) ?? null;
  }, [fixedPromo, selectedPromoId, applicablePromos]);

  const selectedEvent = useMemo(() => {
    if (fixedEvent) return fixedEvent;
    if (!events || !selectedEventId) return null;
    return events.find((e) => e.id === selectedEventId) ?? null;
  }, [fixedEvent, events, selectedEventId]);

  const shareUrl = useMemo(() => {
    if (!selectedEvent) return "";
    const target = selectedEvent.slug ?? selectedEvent.id;
    return buildShareUrl(target, selectedPromo?.code ?? null);
  }, [selectedEvent, selectedPromo]);

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success(String(t("admin.shareLinkCopied") ?? "Link copied"));
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.danger("Couldn't copy — try selecting the text and copying manually.");
    }
  }, [shareUrl, toast, t]);

  const handleOpen = useCallback(() => {
    if (shareUrl) window.open(shareUrl, "_blank", "noopener,noreferrer");
  }, [shareUrl]);

  const promoOptions = useMemo(
    () => [
      {
        value: NO_PROMO_VALUE,
        label: String(t("admin.shareNoPromo") ?? "No promo code"),
      },
      ...applicablePromos.map((p) => ({ value: p.id, label: promoLabel(p) })),
    ],
    [applicablePromos, t],
  );

  const eventOptions = useMemo(() => {
    if (!events) return [];
    return events.map((e) => ({
      value: e.id,
      label: e.title ?? "Untitled event",
    }));
  }, [events]);

  const headerTitle = fixedPromo
    ? String(t("admin.shareWithEvent") ?? `Share ${fixedPromo.code}`)
    : String(t("admin.shareEvent") ?? "Share event");

  if (!open) return null;

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={520}>
        <Modal.Header title={headerTitle} onClose={onClose} />
        <Modal.Body>
          <YStack gap="$3">
            {/* Event picker (only shown when promo is fixed) */}
            {fixedPromo && (
              <YStack gap="$1">
                <Text variant="label">
                  {String(t("admin.shareSelectEvent") ?? "Event")}
                </Text>
                <StyledSelect
                  options={eventOptions}
                  value={selectedEventId}
                  onChange={(v) => setSelectedEventId(String(v))}
                  placeholder={
                    String(
                      t("admin.shareSelectEventPlaceholder") ??
                        "Choose an event…",
                    )
                  }
                  fullWidth
                />
                <Text variant="bodySmall" tone="muted">
                  {String(
                    t("admin.shareSelectEventHint") ??
                      `This promo will only resolve on events where it applies.`,
                  )}
                </Text>
              </YStack>
            )}

            {/* Promo picker (only shown when event is fixed) */}
            {fixedEvent && (
              <YStack gap="$1">
                <XStack alignItems="center" gap="$2">
                  <Tag size={14} />
                  <Text variant="label">
                    {String(t("admin.sharePromo") ?? "Promo code")}
                  </Text>
                </XStack>
                <StyledSelect
                  options={promoOptions}
                  value={selectedPromoId}
                  onChange={(v) => setSelectedPromoId(String(v))}
                  fullWidth
                  disabled={promosQuery.isLoading || applicablePromos.length === 0}
                />
                {applicablePromos.length === 0 && !promosQuery.isLoading ? (
                  <Text variant="bodySmall" tone="muted">
                    {String(
                      t("admin.shareNoPublicPromos") ??
                        "No public promo codes apply to this event. Mark a code as Public in the promo settings to share it via URL.",
                    )}
                  </Text>
                ) : (
                  <Text variant="bodySmall" tone="muted">
                    {String(
                      t("admin.shareOnlyPublicPromos") ??
                        "Only public codes are listed — private codes don't auto-apply from a link.",
                    )}
                  </Text>
                )}
              </YStack>
            )}

            {/* Generated URL */}
            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.shareLink") ?? "Shareable link")}
              </Text>
              <XStack gap="$2" alignItems="stretch">
                <TextInput
                  value={shareUrl}
                  onChangeText={() => {}}
                  readOnly
                  placeholder={
                    fixedPromo
                      ? String(
                          t("admin.shareLinkSelectEventPrompt") ??
                            "Select an event to generate a link…",
                        )
                      : ""
                  }
                  fullWidth
                />
                <Button
                  variant={copied ? "primary" : "secondary"}
                  disabled={!shareUrl}
                  onPress={handleCopy}
                >
                  {copied ? (
                    <Check size={14} aria-hidden />
                  ) : (
                    <Copy size={14} aria-hidden />
                  )}
                  {copied
                    ? String(t("admin.shareCopied") ?? "Copied")
                    : String(t("admin.shareCopy") ?? "Copy")}
                </Button>
              </XStack>
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={onClose}>
            {String(t("common.close") ?? "Close")}
          </Button>
          <Button
            variant="secondary"
            disabled={!shareUrl}
            onPress={handleOpen}
          >
            {String(t("admin.shareOpenLink") ?? "Open")}
            <ExternalLink size={14} aria-hidden />
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
};
