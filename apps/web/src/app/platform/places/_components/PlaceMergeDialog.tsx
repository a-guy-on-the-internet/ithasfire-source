"use client";

import { useCallback, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Modal,
  Spinner,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";
import { ArrowLeftRight } from "lucide-react";

import { trpc } from "@/trpc";
import { SecondFactorNotice } from "@/components/places/PlaceDialog";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { LINK_ACTION_WRAP_STYLE } from "./link-action-style";
import { PlaceLookup } from "./PlaceLookup";
import {
  ARRIVAL_AREA_KIND_COPY,
  ARRIVAL_AREA_SIDE_COPY,
  BLOCKER_COPY,
  FINAL_NOTE_COPY,
  PLACE_MERGE_BLOCKED,
  PLACE_MERGE_RETRY,
  RENAME_KIND_COPY,
  warningCopyKey,
  getErrorReason,
  summarizeFilled,
  summarizeMoves,
  type PlaceMergePreview,
} from "./place-merge-copy";
import type { PlatformPlaceRow } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// "Merge into…" (merge-duplicate-places FR-008). Pick the place that stays,
// read the server's preview (what moves, fills, warns and refuses), then
// merge. The admin picks which row survives (spec D1), so the preview can be
// flipped. The server re-runs the same plan under its lock, so the preview
// can never approve what the merge refuses; this dialog only says it.
// ─────────────────────────────────────────────────────────────────────────────

type Side = PlaceMergePreview["survivor"];

function sideAddress(side: Side): string {
  const street = side.address?.trim() ?? "";
  const city = [side.city, side.region].filter(Boolean).join(", ");
  if (!street) return city;
  if (!city || (side.city && street.includes(side.city))) return street;
  return `${street}, ${city}`;
}

function PlaceSide({
  label,
  side,
  slug,
  noPage,
  testId,
}: {
  label: string;
  side: Side;
  slug: string | null;
  noPage: string;
  testId: string;
}) {
  const address = sideAddress(side);
  return (
    <YStack
      gap="$1"
      paddingTop="$2"
      borderTopWidth={2}
      borderTopColor="$borderColor"
      minWidth={0}
      data-testid={testId}
    >
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      <Text variant="body" weight="bold" style={{ overflowWrap: "anywhere" }}>
        {side.name}
      </Text>
      {address ? (
        <Text
          variant="bodySmall"
          tone="muted"
          style={{ overflowWrap: "anywhere" }}
        >
          {address}
        </Text>
      ) : null}
      {slug ? (
        <Text variant="code" tone="muted" style={{ overflowWrap: "anywhere" }}>
          {`/places/${slug}`}
        </Text>
      ) : (
        <Text variant="caption" tone="muted">
          {noPage}
        </Text>
      )}
    </YStack>
  );
}

function Section({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <YStack gap="$2" data-testid={testId}>
      <Text variant="overline" tone="muted" tag="h3">
        {label}
      </Text>
      {children}
    </YStack>
  );
}

/** A label/count table: labels wrap, counts sit right in tabular figures. */
function CountList({
  rows,
}: {
  rows: { label: string; count: number; sub?: boolean }[];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) max-content",
        columnGap: 16,
        rowGap: 4,
      }}
    >
      {rows.map((row) => (
        <div key={row.label} style={{ display: "contents" }}>
          <Text
            variant="bodySmall"
            tone={row.sub ? "muted" : "default"}
            style={row.sub ? { paddingLeft: 16 } : undefined}
          >
            {row.label}
          </Text>
          <Text
            variant="bodySmall"
            weight="bold"
            style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}
          >
            {row.count.toLocaleString()}
          </Text>
        </div>
      ))}
    </div>
  );
}

/** Strict Swiss callout: a ruled left edge on the muted surface. */
function Callout({
  tone,
  children,
  testId,
  role,
}: {
  tone: "danger" | "warning";
  children: React.ReactNode;
  testId: string;
  role?: "alert" | "note";
}) {
  return (
    <YStack
      gap="$2"
      paddingVertical="$2"
      paddingHorizontal="$3"
      backgroundColor="$surfaceMuted"
      borderLeftWidth={3}
      borderLeftColor={tone === "danger" ? "$danger" : "$warning"}
      data-testid={testId}
      {...(role ? { role } : {})}
    >
      {children}
    </YStack>
  );
}

export interface PlaceMergeDialogProps {
  open: boolean;
  /** The place whose panel opened the dialog. */
  place: PlatformPlaceRow;
  onClose: () => void;
  /** After a merge lands: the panel moves to the place that stayed. */
  onMerged: (result: { survivorId: string }) => void;
}

export function PlaceMergeDialog({
  open,
  place,
  onClose,
  onMerged,
}: PlaceMergeDialogProps) {
  const t = useTranslations();
  const tr = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      String(t(key, values)),
    [t],
  );
  const { toast } = useNotify();
  const pathname = usePathname();

  /** The other place, as picked. */
  const [other, setOther] = useState<PlatformPlaceRow | null>(null);
  /** True when the current place is the one that stays. */
  const [keepCurrent, setKeepCurrent] = useState(false);
  const [mergeError, setMergeError] = useState<
    | { kind: "retry" }
    | { kind: "blocked" }
    | { kind: "secondFactor" }
    | { kind: "other"; message: string }
    | null
  >(null);
  // Belt to isPending's braces: a second press in the same tick never sends.
  const submittingRef = useRef(false);

  const ids = other
    ? keepCurrent
      ? { survivorId: place.placeId, mergedId: other.placeId }
      : { survivorId: other.placeId, mergedId: place.placeId }
    : null;

  const previewQuery = trpc.platform.previewPlaceMerge.useQuery(
    ids ?? { survivorId: "", mergedId: "" },
    {
      enabled: open && ids !== null,
      staleTime: 0,
      retry: false,
      // Said inline, not as a toast.
      meta: { silent: true },
    },
  );
  const mergeMut = trpc.platform.mergePlaces.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const preview = ids ? previewQuery.data : undefined;
  const previewError = ids ? previewQuery.error : null;
  const previewNeedsSecondFactor =
    getAppErrorCode(previewError) === "SECOND_FACTOR_REQUIRED";
  const blockers = preview?.blockers ?? [];
  const merging = mergeMut.isPending;
  const canConfirm =
    preview !== undefined &&
    blockers.length === 0 &&
    !previewQuery.isFetching &&
    // A failed re-read (after PLACE_MERGE_BLOCKED) keeps the old data.
    !previewQuery.isError &&
    !merging;

  const handlePick = useCallback((picked: PlatformPlaceRow) => {
    setOther(picked);
    setKeepCurrent(false);
    setMergeError(null);
  }, []);

  const handleSwap = useCallback(() => {
    if (merging) return;
    setKeepCurrent((v) => !v);
    setMergeError(null);
  }, [merging]);

  const handleConfirm = useCallback(async () => {
    if (!ids || !canConfirm || submittingRef.current) return;
    submittingRef.current = true;
    setMergeError(null);
    try {
      const result = await mergeMut.mutateAsync(ids);
      toast.success({
        title: tr("admin.ppMergeMerged", {
          merged: preview?.merged.name ?? "",
          survivor: preview?.survivor.name ?? "",
        }),
      });
      onMerged({ survivorId: result.survivorId });
    } catch (err) {
      const reason = getErrorReason(err);
      if (reason === PLACE_MERGE_RETRY) {
        setMergeError({ kind: "retry" });
      } else if (reason === PLACE_MERGE_BLOCKED) {
        // Something changed since the preview; show the fresh blockers.
        setMergeError({ kind: "blocked" });
        void previewQuery.refetch();
      } else if (getAppErrorCode(err) === "SECOND_FACTOR_REQUIRED") {
        setMergeError({ kind: "secondFactor" });
      } else {
        setMergeError({ kind: "other", message: formatErrorMessage(err, t) });
      }
    } finally {
      submittingRef.current = false;
    }
  }, [ids, canConfirm, mergeMut, toast, tr, preview, onMerged, previewQuery, t]);

  const summary = preview ? summarizeMoves(preview.moves) : null;
  const filled = preview ? summarizeFilled(preview.filledFields) : [];
  const mergedName = preview?.merged.name ?? "";
  const survivorName = preview?.survivor.name ?? "";

  return (
    <Modal open={open} onClose={merging ? () => {} : onClose}>
      <Modal.Panel width={600}>
        <Modal.Header
          title={tr("admin.ppMergeTitle", { name: place.name })}
          onClose={merging ? undefined : onClose}
        />
        <Modal.Body>
          <YStack gap="$5" data-testid="platform-place-merge-dialog">
            {/* ── Step 1: pick the other place ─────────────────────── */}
            {!other ? (
              <YStack gap="$2">
                <Text variant="overline" tone="muted" tag="h3">
                  {tr("admin.ppMergePickLabel")}
                </Text>
                <PlaceLookup
                  onSelectPlace={handlePick}
                  excludePlaceIds={[place.placeId]}
                  hint={tr("admin.ppMergePickHint")}
                />
              </YStack>
            ) : (
              <>
                {/* ── Which stays, which goes ─────────────────────── */}
                <YStack gap="$3">
                  {preview ? (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
                        gap: 16,
                      }}
                    >
                      <PlaceSide
                        label={tr("admin.ppMergeStays")}
                        side={preview.survivor}
                        slug={preview.survivorPage?.slug ?? null}
                        noPage={tr("admin.ppMergeNoPage")}
                        testId="platform-place-merge-survivor"
                      />
                      <PlaceSide
                        label={tr("admin.ppMergeRemoved")}
                        side={preview.merged}
                        slug={preview.mergedPage?.slug ?? null}
                        noPage={tr("admin.ppMergeNoPage")}
                        testId="platform-place-merge-merged"
                      />
                    </div>
                  ) : null}
                  <XStack gap="$5" rowGap="$3" flexWrap="wrap">
                    <button
                      type="button"
                      style={{
                        ...LINK_ACTION_WRAP_STYLE,
                        opacity: merging ? 0.55 : 1,
                      }}
                      aria-disabled={merging || undefined}
                      onClick={handleSwap}
                      data-testid="platform-place-merge-swap"
                    >
                      <ArrowLeftRight size={14} aria-hidden />
                      {tr("admin.ppMergeKeepInstead", {
                        name: keepCurrent ? other.name : place.name,
                      })}
                    </button>
                    <button
                      type="button"
                      style={{
                        ...LINK_ACTION_WRAP_STYLE,
                        opacity: merging ? 0.55 : 1,
                      }}
                      aria-disabled={merging || undefined}
                      onClick={() => {
                        if (merging) return;
                        setOther(null);
                        setMergeError(null);
                      }}
                      data-testid="platform-place-merge-repick"
                    >
                      {tr("admin.ppMergePickAgain")}
                    </button>
                  </XStack>
                </YStack>

                {/* ── Preview states ──────────────────────────────── */}
                {previewNeedsSecondFactor ? (
                  <SecondFactorNotice pathname={pathname} />
                ) : previewError ? (
                  <Callout tone="danger" role="alert" testId="platform-place-merge-preview-error">
                    <Text variant="bodySmall" weight="bold">
                      {tr("admin.ppMergePreviewFailed")}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {formatErrorMessage(previewError, t)}
                    </Text>
                    <button
                      type="button"
                      style={{ ...LINK_ACTION_WRAP_STYLE, alignSelf: "flex-start" }}
                      onClick={() => void previewQuery.refetch()}
                    >
                      {tr("admin.ppMergeCheckAgain")}
                    </button>
                  </Callout>
                ) : !preview ? (
                  <XStack
                    gap="$2"
                    alignItems="center"
                    role="status"
                    data-testid="platform-place-merge-loading"
                  >
                    <Spinner size="small" />
                    <Text variant="bodySmall" tone="muted">
                      {tr("admin.ppMergeLoading")}
                    </Text>
                  </XStack>
                ) : (
                  <>
                    {blockers.length > 0 ? (
                      <Callout tone="danger" testId="platform-place-merge-blockers">
                        <Text variant="overline" tag="h3">
                          {tr("admin.ppMergeSectionBlockers")}
                        </Text>
                        {blockers.map((b) => (
                          <YStack key={b.code} gap="$1">
                            <Text variant="bodySmall">
                              {tr(BLOCKER_COPY[b.code], {
                                count: b.count,
                                limit: b.limit ?? 0,
                              })}
                            </Text>
                            {b.arrivalAreas && b.arrivalAreas.length > 0 ? (
                              <YStack tag="ul" gap="$1" paddingLeft="$3" margin={0}>
                                {b.arrivalAreas.map((a) => (
                                  <Text key={a.id} tag="li" variant="bodySmall">
                                    {tr("admin.ppMergeArrivalAreaItem", {
                                      label: a.label,
                                      kind: tr(ARRIVAL_AREA_KIND_COPY[a.kind]),
                                      side: tr(ARRIVAL_AREA_SIDE_COPY[a.side]),
                                    })}
                                  </Text>
                                ))}
                              </YStack>
                            ) : null}
                          </YStack>
                        ))}
                      </Callout>
                    ) : null}

                    {preview.warnings.length > 0 ? (
                      <Callout tone="warning" testId="platform-place-merge-warnings">
                        <Text variant="overline" tag="h3">
                          {tr("admin.ppMergeSectionWarnings")}
                        </Text>
                        {preview.warnings.map((w) => (
                          <Text key={w.code} variant="bodySmall">
                            {tr(warningCopyKey(w), {
                              count: w.count,
                              merged: mergedName,
                              survivor: survivorName,
                              requests: w.survivorOpenBookingRequests ?? 0,
                              agreements: w.survivorLiveAgreements ?? 0,
                            })}
                          </Text>
                        ))}
                      </Callout>
                    ) : null}

                    <Section
                      label={tr("admin.ppMergeSectionMoves", {
                        name: survivorName,
                      })}
                      testId="platform-place-merge-moves"
                    >
                      {summary && summary.moved.length > 0 ? (
                        <CountList
                          rows={summary.moved.map((m) => ({
                            label: tr(m.key),
                            count: m.count,
                            sub: m.sub,
                          }))}
                        />
                      ) : (
                        <Text variant="bodySmall" tone="muted">
                          {tr("admin.ppMergeNothingMoves")}
                        </Text>
                      )}
                      {summary?.notes.map((key) => (
                        <Text key={key} variant="bodySmall">
                          {tr(key)}
                        </Text>
                      ))}
                    </Section>

                    {summary && summary.dropped.length > 0 ? (
                      <Section
                        label={tr("admin.ppMergeSectionDropped")}
                        testId="platform-place-merge-dropped"
                      >
                        <CountList
                          rows={summary.dropped.map((m) => ({
                            label: tr(m.key, { name: survivorName }),
                            count: m.count,
                          }))}
                        />
                      </Section>
                    ) : null}

                    {filled.length > 0 ? (
                      <Section
                        label={tr("admin.ppMergeSectionFilled", {
                          name: mergedName,
                        })}
                        testId="platform-place-merge-filled"
                      >
                        <Text variant="bodySmall">
                          {filled.map((key) => tr(key)).join(", ")}
                        </Text>
                      </Section>
                    ) : null}

                    {preview.renames.length > 0 ? (
                      <Section
                        label={tr("admin.ppMergeSectionRenames")}
                        testId="platform-place-merge-renames"
                      >
                        {preview.renames.map((r) => (
                          <Text
                            key={r.id}
                            variant="bodySmall"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {tr("admin.ppMergeRenameLine", {
                              kind: tr(RENAME_KIND_COPY[r.kind]),
                              from: r.from.name,
                              to: r.to.name,
                            })}
                          </Text>
                        ))}
                      </Section>
                    ) : null}

                    <Text
                      variant="bodySmall"
                      weight="bold"
                      data-testid="platform-place-merge-final"
                    >
                      {tr(FINAL_NOTE_COPY[preview.pageAction], {
                        merged: mergedName,
                        survivor: survivorName,
                      })}
                    </Text>
                  </>
                )}

                {/* ── Merge errors ────────────────────────────────── */}
                {mergeError?.kind === "secondFactor" ? (
                  <SecondFactorNotice pathname={pathname} />
                ) : mergeError ? (
                  <Text
                    variant="bodySmall"
                    tone="error"
                    role="alert"
                    data-testid="platform-place-merge-error"
                  >
                    {mergeError.kind === "retry"
                      ? tr("admin.ppMergeRetryError")
                      : mergeError.kind === "blocked"
                        ? tr("admin.ppMergeBlockedError")
                        : mergeError.message}
                  </Text>
                ) : null}
              </>
            )}
          </YStack>
        </Modal.Body>
        <Modal.Footer flexWrap="wrap" gap="$2">
          <Button
            variant="outlined"
            size="$3"
            onPress={onClose}
            disabled={merging}
            data-testid="platform-place-merge-cancel"
          >
            {tr("admin.ppMergeCancelCta")}
          </Button>
          {other ? (
            <Button
              variant="destructive"
              size="$3"
              onPress={() => void handleConfirm()}
              disabled={!canConfirm}
              aria-busy={merging || undefined}
              data-testid="platform-place-merge-confirm"
            >
              {merging ? tr("admin.ppMergeMerging") : tr("admin.ppMergeConfirmCta")}
            </Button>
          ) : null}
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
