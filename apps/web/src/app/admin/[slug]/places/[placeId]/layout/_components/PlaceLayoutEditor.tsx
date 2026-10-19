"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, Stack } from "tamagui";
import { Text, Button, Badge, Spinner, Tooltip, useNotify } from "@th/ui";
import { useTranslations } from "@th/ui";
import {
  ArrowLeft,
  Undo2,
  Upload,
  Trash2,
  Grid3x3,
  AlertTriangle,
  PenTool,
  Pencil,
} from "lucide-react";

import { trpc } from "@/trpc";
import { PlaceLayoutCanvas } from "./PlaceLayoutCanvas";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useFeatureGates } from "@/hooks/useFeatureGates";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LayoutSection = {
  sectionId: string;
  label: string;
  color?: string | null;
  capacity: number;
};

/** Matches the shape written by TicketTypeEditor. */
type ReturnToEventData = {
  eventId: string;
  eventTitle: string;
  slug: string;
};

const RETURN_TO_EVENT_KEY = "th:returnToEvent";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PlaceLayoutEditor() {
  const { slug, placeId } = useParams<{ slug: string; placeId: string }>();
  const router = useRouter();
  const { toast } = useNotify();
  const t = useTranslations();
  const isMobile = useIsMobile();
  const { gates, isLoading: gatesLoading } = useFeatureGates();

  // Redirect when seatingLayouts gate is off
  useEffect(() => {
    if (!gatesLoading && gates && !gates.seatingLayouts) {
      router.replace(`/admin/${slug}/places/${placeId}/settings`);
    }
  }, [gates, gatesLoading, router, slug, placeId]);

  // Read "return to event" context from sessionStorage (set by TicketTypeEditor)
  const [returnToEvent, setReturnToEvent] = useState<ReturnToEventData | null>(
    null,
  );
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(RETURN_TO_EVENT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ReturnToEventData;
        if (parsed.eventId && parsed.slug) {
          setReturnToEvent(parsed);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const handleReturnToEvent = useCallback(() => {
    if (!returnToEvent) return;
    // Clear the sessionStorage entry so it doesn't persist forever
    try {
      sessionStorage.removeItem(RETURN_TO_EVENT_KEY);
    } catch {
      /* ignore */
    }
    router.push(`/admin/${returnToEvent.slug}/events/${returnToEvent.eventId}`);
  }, [returnToEvent, router]);

  const {
    data: layoutData,
    isLoading,
    error,
  } = trpc.placeLayouts.getPlaceLayout.useQuery(
    { placeId },
    { staleTime: 30_000, retry: 1 },
  );

  const deleteLayout = trpc.placeLayouts.deletePlaceLayout.useMutation({
    retry: false,
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const backToEdit = useCallback(
    () => router.push(`/admin/${slug}/places/${placeId}/settings`),
    [router, slug, placeId],
  );

  const backToPlaces = useCallback(
    () => router.push(`/admin/${slug}/places`),
    [router, slug],
  );

  const goToDesigner = useCallback(
    () => router.push(`/admin/${slug}/places/${placeId}/layout/designer`),
    [router, slug, placeId],
  );

  const goToEditDesigner = useCallback(
    () =>
      router.push(`/admin/${slug}/places/${placeId}/layout/designer?edit=true`),
    [router, slug, placeId],
  );

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteLayout.mutateAsync({ placeId });
      toast.success({
        title: t("admin.layoutDeleted") as string,
        message: t("admin.layoutDeletedMessage") as string,
      });
      router.push(`/admin/${slug}/places/${placeId}/layout`);
      router.refresh();
    } catch (err) {
      console.error("Delete layout failed:", err);
      toast.danger({
        title: t("admin.layoutDeleteFailed") as string,
        message:
          err instanceof Error
            ? err.message
            : String(t("admin.layoutGenericErrorDescription")),
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [deleteLayout, placeId, router, slug, toast]);

  // ── Feature gate ──────────────────────────────────────────────────────
  if (!gatesLoading && gates && !gates.seatingLayouts) {
    return null;
  }

  // ── Loading ────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        gap="$3"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.layoutLoading"))}
        </Text>
      </YStack>
    );
  }

  // ── Error / not found ──────────────────────────────────────────────────
  if (error || !layoutData) {
    const isForbidden = error?.data?.code === "FORBIDDEN";
    const isNotFound = error?.data?.code === "NOT_FOUND";

    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        gap="$4"
        maxWidth={480}
        marginHorizontal="auto"
      >
        <YStack
          width={64}
          height={64}
          borderRadius={0}
          backgroundColor={isForbidden ? "$dangerMuted" : "$warningMuted"}
          justifyContent="center"
          alignItems="center"
        >
          {isForbidden ? (
            <AlertTriangle size={28} color="var(--danger)" />
          ) : (
            <Grid3x3 size={28} color="var(--warning)" />
          )}
        </YStack>

        <YStack gap="$2" alignItems="center">
          <Text variant="h3" textAlign="center">
            {isForbidden
              ? String(t("admin.layoutAccessDenied"))
              : isNotFound
                ? String(t("admin.layoutNotFound"))
                : String(t("admin.layoutGenericError"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center">
            {isForbidden
              ? String(t("admin.layoutAccessDeniedDescription"))
              : isNotFound
                ? String(t("admin.layoutNotFoundDescription"))
                : (error?.message ??
                  String(t("admin.layoutGenericErrorDescription")))}
          </Text>
        </YStack>

        <XStack gap="$2" flexWrap="wrap">
          <Button variant="secondary" size="$3" onPress={backToPlaces}>
            <ArrowLeft size={16} />
            {String(t("admin.layoutBackToPlaces"))}
          </Button>
          {isNotFound && !isMobile && (
            <Button variant="primary" size="$3" onPress={goToDesigner}>
              <PenTool size={16} />
              {String(t("admin.layoutDesignLayout"))}
            </Button>
          )}
          {isNotFound && (
            <Button variant="secondary" size="$3" onPress={backToEdit}>
              <Upload size={16} />
              {String(t("admin.layoutGoToPlace"))}
            </Button>
          )}
        </XStack>
      </YStack>
    );
  }

  const { layout } = layoutData;

  // ── Layout view ────────────────────────────────────────────────────────
  return (
    <YStack gap="$4" padding="$4" width="100%">
      {/* Header */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap="$2"
      >
        <XStack gap="$3" alignItems="center">
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={backToEdit}
                aria-label={t("admin.layoutBackToEdit") as string}
              >
                <ArrowLeft size={18} />
              </Button>
            }
            placement="top"
          >
            {String(t("admin.layoutBackToEdit"))}
          </Tooltip>
          {returnToEvent && (
            <Tooltip
              anchor={
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={handleReturnToEvent}
                  aria-label={returnToEvent.eventTitle}
                >
                  <XStack gap={6} alignItems="center">
                    <Undo2 size={14} />
                    <Text tone="inherit" variant="caption">
                      {String(t("admin.layoutReturnToEvent"))}
                    </Text>
                  </XStack>
                </Button>
              }
              placement="top"
            >
              {returnToEvent.eventTitle}
            </Tooltip>
          )}
          <Grid3x3 size={20} color="var(--colorMuted)" />
          <Text
            variant="h2"
            style={{
              textTransform: "uppercase",
              letterSpacing: -1,
              fontWeight: 900,
            }}
          >
            {String(t("admin.layoutHeading"))}
          </Text>
          <Badge tone="neutral" size="sm">
            {layout.name}
          </Badge>
        </XStack>
        {!isMobile && (
          <XStack gap="$2">
            <Button variant="primary" size="$3" onPress={goToEditDesigner}>
              <Pencil size={16} />
              {String(t("admin.layoutEditLayout"))}
            </Button>
            <Button variant="secondary" size="$3" onPress={goToDesigner}>
              <PenTool size={16} />
              {String(t("admin.layoutNewLayout"))}
            </Button>
            {!showDeleteConfirm ? (
              <Button
                variant="destructive"
                size="$3"
                onPress={() => setShowDeleteConfirm(true)}
              >
                <Trash2 size={16} />
                {String(t("admin.layoutDelete"))}
              </Button>
            ) : (
              <XStack gap="$2" alignItems="center">
                <Text variant="bodySmall" tone="error">
                  {String(t("admin.layoutDeleteConfirm"))}
                </Text>
                <Button
                  variant="destructive"
                  size="$3"
                  onPress={handleDelete}
                  disabled={isDeleting}
                >
                  {isDeleting
                    ? String(t("admin.layoutDeleting"))
                    : String(t("admin.layoutConfirm"))}
                </Button>
                <Button
                  variant="ghost"
                  size="$3"
                  onPress={() => setShowDeleteConfirm(false)}
                  disabled={isDeleting}
                >
                  {String(t("admin.layoutCancel"))}
                </Button>
              </XStack>
            )}
          </XStack>
        )}
      </XStack>

      {/* Stats bar */}
      <XStack
        gap="$4"
        padding="$3"
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius={0}
        backgroundColor="$surface"
        flexWrap="wrap"
      >
        <StatItem
          label={String(t("admin.layoutSeats"))}
          value={layout.seatCount.toLocaleString()}
        />
        <StatItem
          label={String(t("admin.layoutSections"))}
          value={layout.sectionCount.toString()}
        />
        <StatItem
          label={String(t("admin.layoutBounds"))}
          value={`${Math.round(layout.seatIndexBounds.maxX - layout.seatIndexBounds.minX)} x ${Math.round(layout.seatIndexBounds.maxY - layout.seatIndexBounds.minY)}`}
        />
        <StatItem
          label={String(t("admin.layoutChecksum"))}
          value={layout.checksum.slice(0, 12)}
          mono
        />
        <StatItem
          label={String(t("admin.layoutUpdated"))}
          value={new Date(layout.updatedAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        />
      </XStack>

      {/* Canvas preview — uses native style to guarantee ResizeObserver sees a non-zero height */}
      <YStack
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius={0}
        backgroundColor="$surface"
        style={{
          overflow: "hidden",
          height: isMobile ? "50vh" : "60vh",
          minHeight: isMobile ? 300 : 500,
          position: "relative",
        }}
      >
        <PlaceLayoutCanvas
          glyphBlobUrl={layout.glyphBlobUrl ?? null}
          sections={layout.sections}
          stage={layout.stage}
          seatIndexBounds={layout.seatIndexBounds}
        />
      </YStack>

      {/* Sections list */}
      {layout.sections.length > 0 && (
        <YStack
          gap="$3"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          backgroundColor="$surface"
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("admin.layoutSectionsHeading"))}
          </Text>
          <XStack gap="$2" flexWrap="wrap">
            {layout.sections.map((section: LayoutSection) => (
              <XStack
                key={section.sectionId}
                gap="$2"
                alignItems="center"
                paddingHorizontal="$3"
                paddingVertical="$2"
                borderRadius={0}
                borderWidth={2}
                borderColor="$borderColor"
                backgroundColor="$background"
              >
                <Stack
                  width={12}
                  height={12}
                  borderRadius={0}
                  backgroundColor={section.color ?? "#888"}
                />
                <Text variant="bodySmall">{section.label}</Text>
                <Text variant="caption" tone="muted">
                  {String(
                    t("admin.layoutSeatCount", { count: section.capacity }),
                  )}
                </Text>
              </XStack>
            ))}
          </XStack>
        </YStack>
      )}

      {/* Stage info */}
      {layout.stage && (
        <YStack
          gap="$2"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          backgroundColor="$surface"
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("admin.layoutStage"))}
          </Text>
          <XStack gap="$3" alignItems="center">
            <Badge tone="neutral" size="sm">
              {layout.stage.kind}
            </Badge>
            {layout.stage.label && (
              <Text variant="body" tone="muted">
                {layout.stage.label}
              </Text>
            )}
          </XStack>
        </YStack>
      )}

      {/* Metadata footer */}
      <YStack gap="$1" paddingHorizontal="$1">
        <Text variant="caption" tone="muted">
          {String(t("admin.layoutPlaceId", { placeId: layout.placeId }))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("admin.layoutId", { layoutId: layout.id }))}
        </Text>
      </YStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat item helper
// ─────────────────────────────────────────────────────────────────────────────

function StatItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <YStack gap="$1" minWidth={80}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text
        variant="bodySmall"
        weight="bold"
        {...(mono ? { fontFamily: "$mono" } : {})}
      >
        {value}
      </Text>
    </YStack>
  );
}
