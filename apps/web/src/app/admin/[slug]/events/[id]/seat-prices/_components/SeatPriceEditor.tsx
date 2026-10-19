"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
} from "react";
import { XStack, YStack } from "tamagui";

import {
  Banner,
  BottomSheet,
  Button,
  Link,
  SegmentedControl,
  Spinner,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";

import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { trpc } from "@/trpc";
import { useMinViewportWidth } from "@/hooks/useMinViewportWidth";
import { ACCENT_TEXT, BORDER, STRUCTURAL } from "@/lib/design-tokens";
import { fmtCurrency } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";

import { formatZonedInstant } from "../../../new/_components/ticket-type-schedule";
import { SeatPriceList } from "./SeatPriceList";
import { SeatPriceMap } from "./SeatPriceMap";
import { SeatPriceNotice } from "./SeatPriceNotice";
import {
  PRISTINE_DRAFT,
  SeatPricePanel,
  type SeatPriceDraft,
} from "./SeatPricePanel";
import { SeatPriceReadOnly } from "./SeatPriceReadOnly";
import { SeatPriceSectionNav } from "./SeatPriceSectionNav";
import { seatPriceSectionDomId } from "./seat-price-labels";
import { selectionBarStyle } from "./seat-price-layout";
import { buildSeatPriceModel } from "./seat-price-model";
import { currencySymbolFor } from "./seat-price-money";
import {
  notesReplacedBy,
  resolvePanelState,
} from "./seat-price-panel-state";
import { describeSaveOutcome, type SaveAction } from "./seat-price-save";
import {
  EMPTY_SELECTION,
  pruneSelection,
  selectionReducer,
  type SelectionAction,
} from "./seat-price-selection";
import {
  availableSeatPriceViews,
  defaultSeatPriceView,
  readStoredSeatPriceView,
  storeSeatPriceView,
  type SeatPriceView,
  type SeatPriceViewProps,
} from "./seat-price-views";
import { useSeatPriceSave, type SeatPriceWrite } from "./useSeatPriceSave";
import { useSheetUnderConfirm } from "./useSheetUnderConfirm";

/**
 * Below this viewport width there is no room for the 340px panel beside the
 * list (the admin rail takes its share first), so the panel moves into a
 * bottom sheet behind a "N seats selected · Set price" bar.
 */
const SIDEBAR_MIN_VIEWPORT = 1200;
const SIDEBAR_WIDTH = 340;

const VIEW_LABEL_KEY: Record<SeatPriceView, string> = {
  map: "admin.seatPricesViewMap",
  list: "admin.seatPricesViewList",
};

const centeredState = {
  padding: "$5",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 240,
  gap: "$3",
} as const;

export type SeatPriceEditorProps = {
  slug: string;
  eventId: string;
};

/**
 * The seat price editor: the read, the ONE selection, the ONE price panel and
 * the save. The views (List now, Map in step 5b-2) are handed the model and
 * the selection and report picks through `dispatch`; nothing about pricing or
 * saving lives in a view.
 */
export function SeatPriceEditor({ slug, eventId }: SeatPriceEditorProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  const readQuery = trpc.events.listEventSeatPriceOverridesForEdit.useQuery({
    eventId,
  });
  // The read carries no currency and no timezone. Both come from the event,
  // on the same key the builder uses, so this is usually already cached.
  const eventQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { staleTime: 60_000 },
  );
  // Same key and staleTime as the shell and the layout: one fetch for all.
  const titleQuery = trpc.events.getEventTitle.useQuery(
    { eventId },
    { staleTime: 60_000 },
  );
  const writeMutation = trpc.events.setSeatPriceOverrides.useMutation();

  const currency = eventQuery.data?.currency ?? "usd";
  const timeZone = eventQuery.data?.timezone ?? null;
  const formatCents = useCallback(
    (cents: number) => fmtCurrency(fmt, cents, currency),
    [fmt, currency],
  );
  const formatWhen = useCallback(
    (at: Date) =>
      timeZone
        ? formatZonedInstant(at.toISOString(), timeZone, fmt.dateTime)
        : null,
    [fmt.dateTime, timeZone],
  );

  const model = useMemo(
    () => (readQuery.data ? buildSeatPriceModel(readQuery.data) : null),
    [readQuery.data],
  );

  // ── View ───────────────────────────────────────────────────────────────
  // The view lives here and only here; both views read the same props.
  // Until the organizer picks one, it is the map when any section has seats
  // on it. Their pick is remembered in this browser.
  const anySeatOnMap = model?.sections.some((section) => section.onMap) ?? false;
  const views = availableSeatPriceViews(anySeatOnMap);
  const mapAvailable = views.includes("map");
  const [pickedView, setPickedView] = useState<SeatPriceView | null>(null);
  useEffect(() => {
    setPickedView(readStoredSeatPriceView());
  }, []);
  const view: SeatPriceView =
    pickedView && views.includes(pickedView)
      ? pickedView
      : defaultSeatPriceView(anySeatOnMap);
  const setView = useCallback((next: SeatPriceView) => {
    setPickedView(next);
    storeSeatPriceView(next);
  }, []);

  // ── Selection ──────────────────────────────────────────────────────────
  const [rawSelection, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION);
  // A refetch can turn a selected seat into a sold one. Read through the
  // pruned set at once, and tidy the stored set right after.
  const selection = useMemo(
    () => (model ? pruneSelection(rawSelection, model.selectableIds) : rawSelection),
    [model, rawSelection],
  );
  useEffect(() => {
    if (model) dispatch({ type: "prune", selectableIds: model.selectableIds });
  }, [model]);

  const panel = useMemo(
    () => (model ? resolvePanelState(model, selection) : null),
    [model, selection],
  );
  const hasSelection = panel?.kind === "selection";

  // ── Sections ───────────────────────────────────────────────────────────
  const [openOverride, setOpenOverride] = useState<ReadonlySet<string> | null>(
    null,
  );
  const firstSectionId = model?.sections[0]?.id ?? null;
  // Until the organizer opens or closes one, the first section is open.
  const openSectionIds = useMemo<ReadonlySet<string>>(
    () => openOverride ?? new Set(firstSectionId ? [firstSectionId] : []),
    [openOverride, firstSectionId],
  );
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  const toggleSection = useCallback(
    (sectionId: string) => {
      const next = new Set(openSectionIds);
      if (!next.delete(sectionId)) next.add(sectionId);
      setOpenOverride(next);
      setActiveSectionId(sectionId);
    },
    [openSectionIds],
  );
  const showSection = useCallback(
    (sectionId: string) => {
      setOpenOverride(new Set(openSectionIds).add(sectionId));
      setActiveSectionId(sectionId);
      // A section the map cannot draw is shown where it can be: the List.
      if (view === "map" && model?.sectionsById.get(sectionId)?.onMap === false) {
        setView("list");
      }
      // After the section has rendered open.
      requestAnimationFrame(() => {
        const band = document.getElementById(seatPriceSectionDomId(sectionId));
        band?.scrollIntoView({ block: "start" });
        band?.focus({ preventScroll: true });
      });
    },
    [model, openSectionIds, setView, view],
  );

  // ── Draft ──────────────────────────────────────────────────────────────
  // A field the organizer has not typed in follows the selection (the panel
  // prefills it from the stored value the selected seats share). What they
  // typed stays until a save goes through or the selection is cleared.
  const [draft, setDraft] = useState<SeatPriceDraft>(PRISTINE_DRAFT);
  useEffect(() => {
    if (!hasSelection) setDraft(PRISTINE_DRAFT);
  }, [hasSelection]);

  // ── Save ───────────────────────────────────────────────────────────────
  const [sheetOpen, setSheetOpen] = useState(false);
  const write = useCallback<SeatPriceWrite>(
    async ({ seatIds, priceOverride }) => {
      const written = await writeMutation.mutateAsync({
        eventId,
        seatIds,
        priceOverride,
      });
      return { updated: written.updated, skipped: written.skipped };
    },
    [eventId, writeMutation],
  );
  // After a save, read the seats again and the layout too: a layout replaced
  // since the page opened keeps its id with new seats, and the read signs a
  // fresh glyph link.
  const refresh = useCallback(
    () =>
      Promise.all([
        utils.events.listEventSeatPriceOverridesForEdit.invalidate({ eventId }),
        utils.placeLayouts.getPublicPlaceLayout.invalidate(),
      ]).then(() => undefined),
    [eventId, utils],
  );
  const translate = useCallback((key: string) => String(t(key)), [t]);
  const { saving, outcome, savedCount, dismiss, forgetFailure, save } = useSeatPriceSave({
    write,
    refresh,
    translate,
    dispatch,
  });

  const runSave = useCallback(
    async (action: SaveAction, note: string | null) => {
      if (panel?.kind !== "selection") return;
      const result = await save(panel.seatIds, action, note);
      if (!result) return;
      setSheetOpen(false);
      if (result.errorMessage === null) setDraft(PRISTINE_DRAFT);
    },
    [panel, save],
  );

  // Picks from a view. After a failed save the banner says "they are still
  // selected"; once the organizer changes the selection that is no longer
  // true, so that part goes. The counts of what did happen stay until Dismiss.
  const failedOutcome = outcome?.errorMessage != null;
  const editSelection = useCallback<Dispatch<SelectionAction>>(
    (action) => {
      if (failedOutcome) forgetFailure();
      dispatch(action);
    },
    [forgetFailure, failedOutcome],
  );

  // "Use section price" clears the price AND the private note. When a note
  // would go, the organizer confirms first, told how many.
  const [confirmClear, setConfirmClear] = useState(false);
  const notesLostOnClear =
    panel?.kind === "selection" ? notesReplacedBy(panel, null) : 0;
  const requestClear = useCallback(() => {
    if (panel?.kind !== "selection" || panel.clearableCount === 0) return;
    if (notesLostOnClear > 0) {
      setConfirmClear(true);
      return;
    }
    void runSave({ kind: "clear" }, null);
  }, [notesLostOnClear, panel, runSave]);

  // ── Focus ──────────────────────────────────────────────────────────────
  const resultRef = useRef<HTMLElement | null>(null);
  const sheetScopeRef = useRef<HTMLDivElement | null>(null);
  const sheetBodyRef = useRef<HTMLDivElement | null>(null);
  const sheetOpenerRef = useRef<HTMLElement | null>(null);
  const sheetWasOpenRef = useRef(false);

  // A new result takes focus: it is read out, and the button that was pressed
  // has often just unmounted with the seats it was for. Never while the sheet
  // is open: the banner sits behind it. A save closes the sheet, so the
  // result is focused on the render after, once the sheet has gone.
  // Keyed by the save count, not the outcome object: trimming a failed
  // result after a seat is picked makes a new object, and that must not pull
  // focus (and the page) up to the banner.
  const focusedSaveRef = useRef(0);
  useEffect(() => {
    if (!outcome || sheetOpen || focusedSaveRef.current === savedCount) return;
    focusedSaveRef.current = savedCount;
    const node = resultRef.current;
    node?.scrollIntoView({ block: "nearest" });
    node?.focus({ preventScroll: true });
  }, [outcome, savedCount, sheetOpen]);

  // The sheet is a dialog: focus goes into it when it opens (on the panel,
  // not the field, so the notices are met before the keyboard comes up) and
  // back to the button that opened it when it closes, unless a save result
  // has taken it.
  useEffect(() => {
    if (sheetOpen) {
      sheetWasOpenRef.current = true;
      const frame = requestAnimationFrame(() => sheetBodyRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (sheetWasOpenRef.current) {
      sheetWasOpenRef.current = false;
      const active = document.activeElement;
      const resultHasFocus = Boolean(
        resultRef.current && active && resultRef.current.contains(active),
      );
      // A result still waiting for focus takes it instead (effect above).
      const resultPending =
        outcome !== null && focusedSaveRef.current !== savedCount;
      const opener = sheetOpenerRef.current;
      if (!resultHasFocus && !resultPending && opener?.isConnected) {
        opener.focus();
      }
    }
    return undefined;
    // Runs on open and close only; `outcome` is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const requestSheetClose = useSheetUnderConfirm({
    scopeRef: sheetScopeRef,
    sheetOpen,
    confirmOpen: confirmClear,
    closeSheet,
  });

  // ── Layout ─────────────────────────────────────────────────────────────
  const hasSidebar = useMinViewportWidth(SIDEBAR_MIN_VIEWPORT);
  useEffect(() => {
    if (hasSidebar || !hasSelection) setSheetOpen(false);
  }, [hasSidebar, hasSelection]);

  // ── States ─────────────────────────────────────────────────────────────
  if (readQuery.isPending) {
    return (
      <YStack {...centeredState} data-testid="seat-price-loading">
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.seatPricesLoading"))}
        </Text>
      </YStack>
    );
  }

  if (readQuery.isError && !model) {
    const forbidden = readQuery.error.data?.code === "FORBIDDEN";
    return (
      <YStack {...centeredState} data-testid="seat-price-load-error">
        <Text variant="h4" weight="bold" textAlign="center">
          {String(
            t(
              forbidden
                ? "admin.seatPricesForbiddenTitle"
                : "admin.seatPricesLoadErrorTitle",
            ),
          )}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={480}>
          {forbidden
            ? String(t("admin.seatPricesForbiddenBody"))
            : formatErrorMessage(readQuery.error, t)}
        </Text>
        {forbidden ? null : (
          <Button
            variant="secondary"
            size="$4"
            onPress={() => void readQuery.refetch()}
            disabled={readQuery.isFetching}
          >
            {String(
              t(
                readQuery.isFetching
                  ? "admin.seatPricesLoading"
                  : "admin.seatPricesRetry",
              ),
            )}
          </Button>
        )}
      </YStack>
    );
  }

  if (!model || !panel) return null;

  if (model.seatCount === 0) {
    return (
      <YStack {...centeredState} data-testid="seat-price-empty">
        <Text variant="h4" weight="bold" textAlign="center">
          {String(t("admin.seatPricesEmptyTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={480}>
          {String(t("admin.seatPricesEmptyBody"))}
        </Text>
        <Link
          href={`/admin/${slug}/events/${eventId}/edit?section=tickets`}
          style={{
            color: ACCENT_TEXT,
            fontWeight: 700,
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          {String(t("admin.seatPricesEmptyAction"))}
        </Link>
      </YStack>
    );
  }

  const summary = (
    <Text variant="caption" tone="muted">
      {[
        String(
          t("admin.seatPricesSectionCount", { count: model.sections.length }),
        ),
        String(t("admin.seatPricesSeatCount", { count: model.seatCount })),
        String(
          t("admin.seatPricesCustomPriceCount", { count: model.customCount }),
        ),
      ].join(" · ")}
    </Text>
  );

  const resultView = outcome
    ? describeSaveOutcome(outcome, t, formatCents)
    : null;
  const resultBanner = resultView ? (
    <Banner
      // Focused after a save (tabIndex -1: reachable by script, not by
      // Tab). Banner is already a polite live region; named by its title
      // so focus landing on it says what it is.
      ref={(node: HTMLDivElement | null) => {
        resultRef.current = node;
      }}
      tabIndex={-1}
      aria-label={resultView.title}
      style={{ scrollMarginTop: 16, outline: "none" }}
      compact
      fullWidth
      tone={resultView.tone}
      title={resultView.title}
      description={resultView.skippedSummary ?? undefined}
      onDismiss={dismiss}
      dismissLabel={String(t("admin.seatPricesDismiss"))}
      data-testid="seat-price-result"
    >
      {resultView.details.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {resultView.details.map((detail) => (
            <li key={detail}>
              <Text variant="bodySmall" tone="muted">
                {detail}
              </Text>
            </li>
          ))}
        </ul>
      ) : null}
      {resultView.failure ? (
        <Text variant="bodySmall">{resultView.failure}</Text>
      ) : null}
      {resultView.failureReason ? (
        <Text variant="bodySmall" tone="muted">
          {resultView.failureReason}
        </Text>
      ) : null}
    </Banner>
  ) : null;

  // The read failed AFTER it had loaded once, usually the refetch after a
  // save: the list may show prices from before that save.
  const refreshNotice =
    readQuery.isError && !readQuery.isFetching ? (
      <SeatPriceNotice
        testId="seat-price-refresh-failed"
        title={String(t("admin.seatPricesRefreshFailedTitle"))}
        action={
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void readQuery.refetch()}
          >
            {String(t("admin.seatPricesRetry"))}
          </Button>
        }
      >
        {String(t("admin.seatPricesRefreshFailedBody"))}
      </SeatPriceNotice>
    ) : null;

  if (panel.kind === "readOnly") {
    return (
      <YStack gap="$4">
        {summary}
        {/* A save can end just as the event closes: its report still shows. */}
        {resultBanner}
        {refreshNotice}
        <SeatPriceReadOnly
          model={model}
          formatCents={formatCents}
          cancelled={titleQuery.data?.status === "CANCELLED"}
        />
      </YStack>
    );
  }

  const panelBody =
    panel.kind === "selection" ? (
      <SeatPricePanel
        panel={panel}
        draft={draft}
        onDraftChange={setDraft}
        formatCents={formatCents}
        formatWhen={formatWhen}
        currencySymbol={currencySymbolFor(currency)}
        payoutsHref={`/admin/${slug}/payouts`}
        saving={saving}
        onSetPrice={(priceCents, note) =>
          void runSave({ kind: "set", priceCents }, note)
        }
        onUseSectionPrice={requestClear}
        onClearSelection={() => editSelection({ type: "clear" })}
      />
    ) : null;

  const viewProps: SeatPriceViewProps = {
    model,
    selection,
    dispatch: editSelection,
    formatCents,
    disabled: saving,
    activeSectionId,
    onShowList: () => setView("list"),
  };

  const viewBody =
    view === "map" ? (
      <SeatPriceMap {...viewProps} />
    ) : (
      <SeatPriceList
        {...viewProps}
        openSectionIds={openSectionIds}
        onToggleSection={toggleSection}
        showMapHints={mapAvailable}
      />
    );

  const toolbar = (
    <XStack
      flexWrap="wrap"
      alignItems="center"
      justifyContent="space-between"
      gap="$3"
    >
      {views.length > 1 ? (
        <SegmentedControl<SeatPriceView>
          options={views.map((value) => ({
            value,
            label: String(t(VIEW_LABEL_KEY[value])),
          }))}
          value={view}
          onChange={setView}
          ariaLabel={String(t("admin.seatPricesViewLabel"))}
          fullWidth={!hasSidebar}
          testIdBase="seat-price-view"
        />
      ) : null}
      {summary}
    </XStack>
  );

  const clearConfirm = (
    <ConfirmDialog
      open={confirmClear}
      onCancel={() => setConfirmClear(false)}
      onConfirm={() => {
        setConfirmClear(false);
        void runSave({ kind: "clear" }, null);
      }}
      title={String(t("admin.seatPricesClearConfirmTitle"))}
      description={String(
        t("admin.seatPricesClearConfirmBody", {
          count: panel.kind === "selection" ? panel.clearableCount : 0,
          notes: notesLostOnClear,
        }),
      )}
      confirmLabel={String(t("admin.seatPricesUseSectionPrice"))}
      cancelLabel={String(t("admin.seatPricesCancel"))}
      tone="danger"
      loading={saving}
    />
  );

  if (hasSidebar) {
    return (
      <YStack gap="$3" data-testid="seat-price-editor">
        {toolbar}
        {refreshNotice}
        <div style={sidebarLayoutStyle}>
          <aside style={sidebarStyle}>
            <YStack padding="$4" gap="$3">
              <SeatPriceSectionNav
                sections={model.sections}
                activeSectionId={activeSectionId}
                onSelectSection={showSection}
                formatCents={formatCents}
                showMapHints={mapAvailable}
              />
            </YStack>
            <YStack
              padding="$4"
              gap="$3"
              style={{ borderTop: `1px solid ${BORDER}` }}
            >
              {resultBanner}
              {panelBody ?? (
                <YStack gap={4}>
                  <Text variant="overline" tone="muted">
                    {String(t("admin.seatPricesPanelEmptyTitle"))}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {String(
                      t(
                        view === "map"
                          ? "admin.seatPricesPanelEmptyBodyMap"
                          : "admin.seatPricesPanelEmptyBody",
                      ),
                    )}
                  </Text>
                </YStack>
              )}
            </YStack>
          </aside>
          <div style={{ minWidth: 0 }}>{viewBody}</div>
        </div>
        {clearConfirm}
      </YStack>
    );
  }

  return (
    <YStack gap="$3" data-testid="seat-price-editor">
      {toolbar}
      {refreshNotice}
      {resultBanner}
      {viewBody}
      {panel.kind === "selection" ? (
        <div
          role="region"
          aria-label={String(t("admin.seatPricesSelectionBarLabel"))}
          data-testid="seat-price-selection-bar"
          style={selectionBarStyle}
        >
          <XStack
            backgroundColor="$surface"
            flexWrap="wrap"
            alignItems="center"
            columnGap={12}
            rowGap={8}
            paddingVertical={12}
            paddingHorizontal={16}
          >
            {/* Text first; the button drops under it when both do not fit. */}
            <YStack flexGrow={1} flexShrink={1} flexBasis={120} minWidth={0} gap={2}>
              <Text variant="bodySmall" weight="bold">
                {String(
                  t("admin.seatPricesSelectedCount", { count: panel.seatCount }),
                )}
              </Text>
              <Text
                variant="caption"
                tone="muted"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {panel.sections.map((section) => section.name).join(", ")}
              </Text>
            </YStack>
            <Button
              ref={(node) => {
                sheetOpenerRef.current = node as HTMLElement | null;
              }}
              variant="primary"
              size="$4"
              flexGrow={1}
              onPress={() => setSheetOpen(true)}
              disabled={saving}
              aria-haspopup="dialog"
              // Its own name: the panel inside the sheet has a "Set price"
              // button too. The visible words lead, so voice control finds it.
              aria-label={String(
                t("admin.seatPricesOpenPanelAria", { count: panel.seatCount }),
              )}
              data-testid="seat-price-open-panel"
            >
              {String(t("admin.seatPricesSetPrice"))}
            </Button>
          </XStack>
        </div>
      ) : null}
      <BottomSheet open={sheetOpen} onClose={requestSheetClose}>
        <BottomSheet.Panel maxHeightVh={85}>
          {/* The dialog is a real box (not `display: contents`, which Safari
              drops from the accessibility tree): a flex column that fills
              the panel, so the body still scrolls inside the 85vh cap. */}
          <div
            ref={sheetScopeRef}
            role="dialog"
            aria-modal
            aria-label={String(t("admin.seatPricesTitle"))}
            tabIndex={-1}
            style={sheetDialogStyle}
          >
            <BottomSheet.Header
              title={String(t("admin.seatPricesTitle"))}
              onClose={requestSheetClose}
            />
            <BottomSheet.Body>
              <div ref={sheetBodyRef} tabIndex={-1} style={{ outline: "none" }}>
                {panelBody}
              </div>
            </BottomSheet.Body>
          </div>
        </BottomSheet.Panel>
      </BottomSheet>
      {clearConfirm}
    </YStack>
  );
}

SeatPriceEditor.displayName = "SeatPriceEditor";

const sheetDialogStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "1 1 auto",
  minHeight: 0,
  outline: "none",
};

// Grid for the skeleton (DS v2 §5): a fixed panel column and a fluid list.
const sidebarLayoutStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `${SIDEBAR_WIDTH}px minmax(0, 1fr)`,
  alignItems: "start",
  borderTop: `2px solid ${STRUCTURAL}`,
};

// Sticky so the panel stays beside a long section. Inline on a plain element:
// Tamagui's react-native-web layer strips `position: sticky` from stacks.
const sidebarStyle: CSSProperties = {
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
  borderRight: `1px solid ${BORDER}`,
};
