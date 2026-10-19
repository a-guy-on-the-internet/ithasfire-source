"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { keepPreviousData } from "@tanstack/react-query";
import { MapPin, Pencil, Plus, Store, X } from "lucide-react";

import { Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useGeocodeSuggestions } from "@/hooks/use-geocode-suggestions";
import type { GeocodingResult } from "@/lib/maps/geocoding";
import {
  ACCENT_TEXT,
  BORDER,
  DANGER_TEXT,
  FOREGROUND,
  MUTED,
  MUTED_TEXT,
  STRUCTURAL,
  SURFACE,
} from "@/lib/design-tokens";

import type { PlacePickerItem } from "./PlacePicker";
import {
  PlaceDialog,
  REFUSAL_COPY,
  SecondFactorNotice,
  type PlaceDialogMode,
} from "./PlaceDialog";
import {
  geocodingResultToAddressValue,
  placeRowSubtitle,
  toRefusalReason,
  type AddressValue,
  type PlaceOrAddressValue,
  type PlaceRefusalReason,
} from "./place-or-address.helpers";

export type { AddressValue, PlaceOrAddressValue } from "./place-or-address.helpers";

/** Typed characters before either source is asked. */
const MIN_QUERY = 2;
const PLACES_DEBOUNCE_MS = 250;
/**
 * "On Ithas Fire" rows. Five keeps a city word from burying the addresses
 * below (board option A, "Against").
 */
const PLACES_LIMIT = 5;

type PlaceHit = {
  placeId: string;
  title: string;
  subtitle: string | null;
  city: string | null;
};

type Option =
  | { kind: "place"; key: string; hit: PlaceHit }
  | { kind: "address"; key: string; result: GeocodingResult }
  | { kind: "add"; key: string };

type FieldNotice =
  | { kind: "secondFactor" }
  | {
      kind: "refused";
      reason: PlaceRefusalReason;
      /** ADDRESS_WITHHELD may still be archived; the notice offers it. */
      archive: PlaceDialogMode | null;
    }
  /** This session archived it; the field was cleared. */
  | { kind: "archived"; name: string }
  /** It was archived before (by a moderator or staff); the field keeps it. */
  | { kind: "isArchived"; name: string }
  | { kind: "error"; text: string };

export type PlaceOrAddressFieldProps = {
  value: PlaceOrAddressValue;
  /** A place on Ithas Fire was picked (hydrated: pin and zone included). */
  onPickPlace: (place: PlacePickerItem) => void;
  /** A geocoded address was picked; no place is linked. */
  onPickAddress: (address: AddressValue) => void;
  onClear: () => void;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  /** The combobox's id, so a label can point at it. */
  inputId?: string;
  /** The visible label's id: the combobox and the listbox are named by it. */
  labelledBy?: string;
  testIdBase?: string;
  /** A line under the chosen value (the quick-create's time-zone note). */
  selectedNote?: ReactNode;
  /**
   * The chosen place is known to be ARCHIVED (its name), or null. The field
   * then opens with the same "<name> is archived. Pick another place." notice
   * "Edit place" would show, without waiting for that click. The caller knows
   * from its own read (the event builder's place-privacy read).
   */
  archivedName?: string | null;
};

/**
 * ONE box for a community listing's Location (board option A, owner
 * 2026-10-13: "A: one box, places first"; and for the editor, "Ideally it
 * should be the same component").
 *
 * Results come back in two groups: "On Ithas Fire" (our places, the
 * `search.autocomplete` place index PlacePicker uses) above "Addresses" (the
 * geocoder, business name leading), then "Add a place". Picking a place links
 * the listing to it; picking an address pins it and offers "Make this a
 * place". Add / Edit / Make-a-place show only to someone the moderator check
 * lets through, and open `PlaceDialog` over the unsaved form.
 */
export function PlaceOrAddressField({
  value,
  onPickPlace,
  onPickAddress,
  onClear,
  required,
  invalid,
  describedBy,
  placeholder,
  inputId,
  labelledBy,
  testIdBase = "place-or-address",
  selectedNote,
  archivedName = null,
}: PlaceOrAddressFieldProps) {
  const t = useTranslations();
  const tr = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      String(t(key, values)),
    [t],
  );
  const pathname = usePathname();
  const utils = trpc.useUtils();
  const listboxId = `${testIdBase}-listbox`;

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [hydratingId, setHydratingId] = useState<string | null>(null);
  const [hydrateFailed, setHydrateFailed] = useState(false);
  const [notice, setNotice] = useState<FieldNotice | null>(null);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [dialog, setDialog] = useState<PlaceDialogMode | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInputNext = useRef(false);
  /** Set by a pick or a dialog close: the card that replaced the box takes focus. */
  const focusCardNext = useRef(false);
  /** Bumped by every pick, clear and close; a stale hydration hands up nothing. */
  const selectionToken = useRef(0);

  const trimmed = query.trim();
  const typedEnough = trimmed.length >= MIN_QUERY;

  // ── Who may add / edit places ────────────────────────────────────────
  const moderator = trpc.community.checkModeratorAccess.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
    meta: { silent: true },
  });
  const canManage = moderator.data?.allowed === true;

  // ── Source 1: our places ─────────────────────────────────────────────
  const debounced = useDebouncedValue(trimmed, PLACES_DEBOUNCE_MS);
  const placesQuery = trpc.search.autocomplete.useQuery(
    { query: debounced, types: ["place"], limit: PLACES_LIMIT },
    {
      enabled: open && debounced.length >= MIN_QUERY,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      retry: false,
      meta: { silent: true },
    },
  );
  const placesLoading =
    typedEnough && (debounced !== trimmed || placesQuery.isFetching);
  const placesError = typedEnough && !placesLoading && placesQuery.isError;
  // keepPreviousData serves the LAST key's rows while a new one loads; rows
  // are shown only for the query in the box, so nobody picks a place that
  // answered something they no longer typed.
  const placesCurrent =
    debounced === trimmed && !placesQuery.isPlaceholderData;
  const placeHits = useMemo<PlaceHit[]>(() => {
    if (!typedEnough || placesError || !placesCurrent) return [];
    return (placesQuery.data?.suggestions ?? [])
      .flatMap((s) =>
        s.type === "place"
          ? [
              {
                placeId: s.placeId,
                title: s.title,
                subtitle: s.subtitle ?? null,
                city: s.city ?? null,
              },
            ]
          : [],
      )
      .slice(0, PLACES_LIMIT);
  }, [typedEnough, placesError, placesCurrent, placesQuery.data?.suggestions]);

  // ── Source 2: the geocoder ───────────────────────────────────────────
  const geo = useGeocodeSuggestions({ minQueryLength: MIN_QUERY });
  const addressLoading =
    typedEnough && (geo.isFetching || geo.settledQuery !== trimmed);
  const addressError = typedEnough && !addressLoading && geo.error;
  // Same rule for the geocoder: its rows belong to `settledQuery`, and
  // until that is the query in the box they stay hidden (the list shows
  // Searching… only while no other rows are on screen).
  const addressCurrent = geo.settledQuery === trimmed;
  const addressHits = useMemo(
    () => (typedEnough && addressCurrent ? geo.suggestions : []),
    [typedEnough, addressCurrent, geo.suggestions],
  );

  // ── One flat option list: keyboard order = visual order ─────────────
  const options = useMemo<Option[]>(() => {
    const list: Option[] = [
      ...placeHits.map(
        (hit): Option => ({ kind: "place", key: `p-${hit.placeId}`, hit }),
      ),
      ...addressHits.map(
        (result, i): Option => ({
          kind: "address",
          key: `a-${result.lat},${result.lng}-${i}`,
          result,
        }),
      ),
    ];
    if (canManage) list.push({ kind: "add", key: "add" });
    return list;
  }, [placeHits, addressHits, canManage]);
  const resultCount = placeHits.length + addressHits.length;

  // The active row is an index into `options`; when the rows change under
  // it (a source settles), it would point at a different row. Start over.
  const optionKeys = options.map((o) => o.key).join("|");
  useEffect(() => {
    setActiveIdx(-1);
  }, [optionKeys]);
  const anyLoading = placesLoading || addressLoading;

  const popupVisible =
    open && typedEnough && (options.length > 0 || anyLoading);
  const hasOptions = popupVisible && options.length > 0;

  // What the field says about an empty answer: in flow under the input
  // (step 1's rule: never a popup message floating over the next field).
  const emptyStatus: string | null =
    open && typedEnough && !anyLoading && resultCount === 0
      ? placesError && addressError
        ? tr("communityCreate.pfAllError")
        : addressError
          ? tr("admin.lacSearchError")
          : placesError
            ? tr("communityCreate.pfPlacesErrorNoAddress", { query: trimmed })
            : tr("communityCreate.pfNoMatches", { query: trimmed })
      : null;
  // A group that failed while the other answered says so inside the popup.
  const groupStatus: string | null =
    open && typedEnough && resultCount > 0
      ? placesError
        ? tr("communityCreate.pfPlacesError")
        : addressError
          ? tr("admin.lacSearchError")
          : null
      : null;

  // ── Open / close ─────────────────────────────────────────────────────
  const close = useCallback(() => {
    setOpen(false);
    setActiveIdx(-1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  // Hand focus back to the box after a clear (the card it replaced is gone).
  useEffect(() => {
    if (value === null && focusInputNext.current) {
      focusInputNext.current = false;
      inputRef.current?.focus();
    }
  }, [value]);

  // After a pick, a save or "Use this place" the input (or the dialog's
  // opener) is gone; focus lands on the card's first control instead of
  // falling to <body>. rAF: after Modal hands focus back to its opener.
  const valueKind = value?.kind ?? null;
  useEffect(() => {
    if (valueKind === null || dialog !== null || !focusCardNext.current) return;
    focusCardNext.current = false;
    const raf = requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLElement>("[data-card-primary]")
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [valueKind, value, dialog]);

  // Any new value retires a notice about the old one.
  useEffect(() => {
    setNotice((n) => (n?.kind === "archived" && value === null ? n : null));
  }, [value]);

  // A place the caller knows is archived says so on its own. DERIVED, not
  // stored: a caller that rebuilds `value` for the same place (the builder
  // does, on any location change) would otherwise retire it through the
  // effect above. Any notice already set (a refusal, "Edit place"'s own) wins;
  // a dismissal holds for that place only.
  const [archivedDismissedFor, setArchivedDismissedFor] = useState<
    string | null
  >(null);
  const archivedPlaceId =
    archivedName !== null && value?.kind === "place"
      ? value.place.placeId
      : null;
  const shownNotice: FieldNotice | null =
    notice ??
    (archivedPlaceId !== null &&
    archivedName !== null &&
    archivedDismissedFor !== archivedPlaceId
      ? { kind: "isArchived", name: archivedName }
      : null);
  // Only dismissing the archived notice itself silences it; closing a
  // refusal shown over it brings it back.
  const dismissNotice = useCallback(() => {
    setNotice(null);
    if (archivedPlaceId !== null && shownNotice?.kind === "isArchived") {
      setArchivedDismissedFor(archivedPlaceId);
    }
  }, [archivedPlaceId, shownNotice?.kind]);

  // Keep the active row in view inside the scrolling listbox.
  useEffect(() => {
    if (activeIdx < 0) return;
    document
      .getElementById(`${testIdBase}-option-${activeIdx}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIdx, testIdBase]);

  const handleQueryChange = useCallback(
    (next: string) => {
      selectionToken.current += 1;
      setQuery(next);
      setActiveIdx(-1);
      setHydrateFailed(false);
      setOpen(next.trim().length >= MIN_QUERY);
      geo.feed(next);
    },
    [geo],
  );

  // ── Picks ────────────────────────────────────────────────────────────
  const finishPick = useCallback(() => {
    close();
    setQuery("");
    geo.feed("");
  }, [close, geo]);

  /**
   * A search hit carries only id / title / subtitle / city; the listing
   * needs the pin and the zone. Same hydration as PlacePicker's "All venues".
   */
  const pickPlace = useCallback(
    async (hit: PlaceHit) => {
      selectionToken.current += 1;
      const token = selectionToken.current;
      setHydratingId(hit.placeId);
      setHydrateFailed(false);
      try {
        const { place } = await utils.places.getPlacePublic.fetch(
          { placeId: hit.placeId },
          { staleTime: 60_000 },
        );
        let timezone: string | null = null;
        if (place.lat !== null && place.lng !== null) {
          try {
            timezone = (
              await utils.places.resolveTimezone.fetch(
                { lat: place.lat, lng: place.lng },
                { staleTime: Infinity },
              )
            ).timezone;
          } catch (err) {
            traceIgnoredError("placeOrAddress.resolveTimezone")(err);
          }
        }
        if (selectionToken.current !== token) return;
        onPickPlace({
          placeId: place.placeId,
          name: place.name,
          formattedAddress: place.formattedAddress,
          city: place.city,
          region: place.region,
          lat: place.lat,
          lng: place.lng,
          timezone,
          status: place.status,
          verificationStatus: place.verificationStatus,
        });
        focusCardNext.current = true;
        finishPick();
      } catch (err) {
        if (selectionToken.current === token) setHydrateFailed(true);
        else traceIgnoredError("placeOrAddress.hydratePlace")(err);
      } finally {
        setHydratingId((cur) => (cur === hit.placeId ? null : cur));
      }
    },
    [utils, onPickPlace, finishPick],
  );

  // ── The moderator gate, asked fresh before any dialog opens ─────────
  // Returns a kind and leaves the notice to the caller: a stale Edit must
  // say nothing, so it checks stale() before showing "secondFactor".
  const ensureCanWrite = useCallback(async (): Promise<
    "ok" | "denied" | "secondFactor"
  > => {
    let access = moderator.data;
    if (!access?.allowed || !access.secondFactorEnrolled) {
      // Enrolment happens in another tab; ask again rather than trust 60s.
      access = (await moderator.refetch()).data;
    }
    if (!access?.allowed) return "denied";
    if (!access.secondFactorEnrolled) return "secondFactor";
    return "ok";
  }, [moderator]);

  const openCreate = useCallback(
    async (initialName: string, initialAddress: AddressValue | null) => {
      close();
      setNotice(null);
      const can = await ensureCanWrite();
      if (can === "secondFactor") setNotice({ kind: "secondFactor" });
      if (can !== "ok") return;
      setDialog({ kind: "create", initialName, initialAddress });
    },
    [close, ensureCanWrite],
  );

  const openEdit = useCallback(
    async (place: PlacePickerItem) => {
      // A Clear or a new pick while this runs makes the answer stale: its
      // dialog must not open over a field that no longer holds this place.
      const token = selectionToken.current;
      const stale = () => selectionToken.current !== token;
      // One check at a time: a second click before the re-render is a no-op.
      if (checkingRef.current) return;
      checkingRef.current = true;
      setNotice(null);
      setChecking(true);
      try {
        const can = await ensureCanWrite();
        if (stale()) return;
        if (can === "secondFactor") setNotice({ kind: "secondFactor" });
        if (can !== "ok") return;
        const e = await utils.community.getPlaceEditability.fetch(
          { placeId: place.placeId },
          { staleTime: 0 },
        );
        if (stale()) return;
        const mode: PlaceDialogMode = {
          kind: "edit",
          place,
          canEdit: e.canEdit,
          canArchive: e.canArchive,
          linkedListingCount: e.linkedListingCount,
        };
        if (e.status === "ARCHIVED") {
          // Archived before this session (a DRAFT linked to it reopened):
          // say so, not "staff look after it". A platform ADMIN restores it from
          // Platform → Places (PlaceDetailPanel).
          setNotice({ kind: "isArchived", name: place.name });
        } else if (e.canEdit) {
          setDialog(mode);
        } else {
          // Said BEFORE the form, so nobody fills a dialog the write refuses.
          setNotice({
            kind: "refused",
            reason: toRefusalReason(e.reason),
            archive: e.canArchive ? mode : null,
          });
        }
      } catch (err) {
        if (stale()) {
          traceIgnoredError("placeOrAddress.editability")(err);
        } else if (getAppErrorCode(err) === "SECOND_FACTOR_REQUIRED") {
          setNotice({ kind: "secondFactor" });
        } else {
          traceIgnoredError("placeOrAddress.editability")(err);
          setNotice({
            kind: "error",
            text: tr("communityCreate.pfEditabilityFailed"),
          });
        }
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [ensureCanWrite, utils, tr],
  );

  const commit = useCallback(
    (option: Option) => {
      if (option.kind === "place") {
        if (hydratingId === null) void pickPlace(option.hit);
      } else if (option.kind === "address") {
        selectionToken.current += 1;
        focusCardNext.current = true;
        onPickAddress(geocodingResultToAddressValue(option.result));
        finishPick();
      } else {
        void openCreate(trimmed, null);
      }
    },
    [hydratingId, pickPlace, onPickAddress, finishPick, openCreate, trimmed],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        if (popupVisible) {
          // Owned: an Escape that bubbles closes a surrounding sheet too.
          e.preventDefault();
          e.stopPropagation();
        }
        // With nothing showing, the Escape is the surrounding sheet's.
        if (open) close();
        return;
      }
      if (e.key === "Tab") {
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!open && typedEnough) {
          setOpen(true);
          return;
        }
        if (options.length > 0) {
          setActiveIdx((i) => Math.min(i + 1, options.length - 1));
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (options.length > 0) setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && hasOptions && activeIdx >= 0) {
        e.preventDefault();
        const option = options[activeIdx];
        if (option) commit(option);
      }
    },
    [open, popupVisible, close, typedEnough, options, hasOptions, activeIdx, commit],
  );

  const handleClear = useCallback(() => {
    selectionToken.current += 1;
    focusInputNext.current = true;
    setNotice(null);
    onClear();
  }, [onClear]);

  // ── Dialog outcomes ──────────────────────────────────────────────────
  const closeDialog = useCallback(() => {
    // Opened from the card: Modal's opener may be a button that re-rendered.
    if (value !== null) focusCardNext.current = true;
    setDialog(null);
  }, [value]);
  const selectFromDialog = useCallback(
    (place: PlacePickerItem) => {
      setDialog(null);
      selectionToken.current += 1;
      focusCardNext.current = true;
      onPickPlace(place);
      finishPick();
      // A saved or archived place is stale in every cached read.
      void utils.places.getPlacePublic.invalidate({ placeId: place.placeId });
      void utils.search.autocomplete.invalidate();
    },
    [onPickPlace, finishPick, utils],
  );
  const handleArchived = useCallback(
    (place: PlacePickerItem) => {
      setDialog(null);
      selectionToken.current += 1;
      focusInputNext.current = true;
      onClear();
      setNotice({ kind: "archived", name: place.name });
      void utils.places.getPlacePublic.invalidate({ placeId: place.placeId });
      void utils.search.autocomplete.invalidate();
    },
    [onClear, utils],
  );

  // ── Render ───────────────────────────────────────────────────────────
  let optionIndex = -1;
  const renderOption = (option: Option): ReactNode => {
    optionIndex += 1;
    const idx = optionIndex;
    const active = idx === activeIdx;
    const common = {
      id: `${testIdBase}-option-${idx}`,
      role: "option" as const,
      "aria-selected": active,
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      onMouseEnter: () => setActiveIdx(idx),
      onClick: () => commit(option),
    };
    if (option.kind === "add") {
      return (
        <div
          key={option.key}
          {...common}
          data-testid={`${testIdBase}-add`}
          style={{
            ...rowStyle(active),
            borderTop: `2px solid ${STRUCTURAL}`,
            color: ACCENT_TEXT,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          <Plus size={14} aria-hidden style={{ flexShrink: 0 }} />
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {resultCount === 0 && !anyLoading
              ? tr("communityCreate.pfAddQueryAsPlace", { query: trimmed })
              : tr("communityCreate.pfAddPlace")}
          </span>
        </div>
      );
    }
    const isPlace = option.kind === "place";
    const primary = isPlace
      ? option.hit.title
      : (option.result.name ??
        option.result.streetLine ??
        option.result.formattedAddress);
    const secondary = isPlace
      ? placeRowSubtitle(option.hit.subtitle, option.hit.city)
      : [
          option.result.name ? option.result.streetLine : null,
          option.result.locality,
          option.result.regionCode ?? option.result.region,
          option.result.postalCode,
        ]
          .filter(Boolean)
          .join(", ") || null;
    const hydrating = isPlace && hydratingId === option.hit.placeId;
    return (
      <div
        key={option.key}
        {...common}
        aria-busy={hydrating || undefined}
        data-testid={
          isPlace
            ? `${testIdBase}-place-${option.hit.placeId}`
            : `${testIdBase}-address-${idx}`
        }
        style={rowStyle(active)}
      >
        {isPlace ? (
          <Store size={15} aria-hidden style={{ flexShrink: 0, color: FOREGROUND }} />
        ) : (
          <MapPin size={15} aria-hidden style={{ flexShrink: 0, color: MUTED_TEXT }} />
        )}
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>
            {primary}
          </span>
          {secondary ? (
            <span
              style={{
                display: "block",
                marginTop: 2,
                fontSize: 12,
                color: MUTED_TEXT,
                overflowWrap: "anywhere",
              }}
            >
              {secondary}
            </span>
          ) : null}
        </span>
        {hydrating ? (
          <span style={{ fontSize: 12, color: MUTED_TEXT, flexShrink: 0 }}>
            {tr("communityCreate.pfLoadingPlace")}
          </span>
        ) : null}
      </div>
    );
  };

  const placeOptions = options.filter((o) => o.kind === "place");
  const addressOptions = options.filter((o) => o.kind === "address");
  const addOption = options.find((o) => o.kind === "add");

  const liveText = emptyStatus ?? groupStatus ?? "";

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}
      data-testid={testIdBase}
    >
      {value ? (
        <SelectedCard
          value={value}
          canManage={canManage}
          checking={checking}
          onClear={handleClear}
          onEditPlace={(place) => void openEdit(place)}
          onMakePlace={(address) =>
            void openCreate(address.poiName ?? "", address)
          }
          testIdBase={testIdBase}
          note={selectedNote}
        />
      ) : (
        <>
          <div style={{ position: "relative", width: "100%" }}>
            <MapPin
              size={16}
              aria-hidden
              style={{
                position: "absolute",
                left: 13,
                top: 14,
                pointerEvents: "none",
                color: MUTED_TEXT,
              }}
            />
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (typedEnough) setOpen(true);
              }}
              placeholder={placeholder ?? tr("communityCreate.pfPlaceholder")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="search"
              data-form-type="other"
              data-lpignore="true"
              role="combobox"
              aria-expanded={hasOptions}
              aria-autocomplete="list"
              aria-controls={popupVisible ? listboxId : undefined}
              aria-activedescendant={
                hasOptions && activeIdx >= 0
                  ? `${testIdBase}-option-${activeIdx}`
                  : undefined
              }
              aria-required={required ? true : undefined}
              required={required}
              aria-invalid={invalid ? true : undefined}
              aria-labelledby={labelledBy}
              aria-describedby={describedBy}
              data-testid={`${testIdBase}-input`}
              style={{
                width: "100%",
                boxSizing: "border-box",
                minHeight: 44,
                borderRadius: 0,
                border: `2px solid ${invalid ? DANGER_TEXT : STRUCTURAL}`,
                background: SURFACE,
                padding: "10px 14px 10px 38px",
                fontSize: 14,
                fontFamily: "inherit",
                color: FOREGROUND,
              }}
            />

            {popupVisible ? (
              <div
                id={listboxId}
                role="listbox"
                aria-labelledby={labelledBy}
                aria-label={
                  labelledBy ? undefined : tr("communityCreate.fieldLocation")
                }
                data-testid={`${testIdBase}-listbox`}
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  zIndex: 200,
                  marginTop: 4,
                  background: SURFACE,
                  border: `2px solid ${STRUCTURAL}`,
                  borderRadius: 0,
                  maxHeight: 360,
                  overflowY: "auto",
                }}
              >
                {placeOptions.length > 0 || (placesError && resultCount > 0) ? (
                  <div role="group" aria-label={tr("communityCreate.pfGroupPlaces")} data-testid={`${testIdBase}-group-places`}>
                    <GroupHeader
                      label={tr("communityCreate.pfGroupPlaces")}
                      count={placeOptions.length}
                    />
                    {placeOptions.map(renderOption)}
                    {placesError ? (
                      <GroupNote text={tr("communityCreate.pfPlacesError")} />
                    ) : null}
                  </div>
                ) : null}
                {addressOptions.length > 0 ||
                (addressError && resultCount > 0) ? (
                  <div role="group" aria-label={tr("communityCreate.pfGroupAddresses")} data-testid={`${testIdBase}-group-addresses`}>
                    <GroupHeader
                      label={tr("communityCreate.pfGroupAddresses")}
                      count={addressOptions.length}
                    />
                    {addressOptions.map(renderOption)}
                    {addressError ? (
                      <GroupNote text={tr("admin.lacSearchError")} />
                    ) : null}
                  </div>
                ) : null}
                {emptyStatus ? (
                  // The board's empty row: said above the tail, inside the
                  // popup, because the popup would cover a line under the
                  // input. Presentational; the live region announces it.
                  <div
                    role="presentation"
                    data-testid={`${testIdBase}-hint`}
                    style={{
                      padding: "12px 14px",
                      fontSize: 12,
                      lineHeight: 1.4,
                      color: MUTED_TEXT,
                    }}
                  >
                    {emptyStatus}
                  </div>
                ) : null}
                {anyLoading && resultCount === 0 ? (
                  <div
                    role="presentation"
                    style={{ padding: "12px 14px", fontSize: 13, color: MUTED_TEXT }}
                  >
                    {tr("communityCreate.pfSearching")}
                  </div>
                ) : null}
                {addOption ? renderOption(addOption) : null}
              </div>
            ) : null}
          </div>

          <span role="status" aria-live="polite" aria-atomic="true" style={SR_ONLY}>
            {liveText}
          </span>
          {emptyStatus && !popupVisible ? (
            <div
              data-testid={`${testIdBase}-hint`}
              style={{ fontSize: 12, lineHeight: 1.4, color: MUTED_TEXT }}
            >
              {emptyStatus}
            </div>
          ) : !open || !typedEnough ? (
            <div>
              <Text variant="caption" tone="muted">
                {tr("communityCreate.pfHelp")}
              </Text>
            </div>
          ) : null}
          {hydrateFailed ? (
            <div>
              <Text variant="caption" tone="error" role="alert" data-testid={`${testIdBase}-hydrate-error`}>
                {tr("communityCreate.pfPlaceLoadFailed")}
              </Text>
            </div>
          ) : null}
        </>
      )}

      {shownNotice ? (
        <div style={{ paddingTop: 2 }}>
          <FieldNoticeView
            notice={shownNotice}
            pathname={pathname}
            onArchive={(mode) => setDialog(mode)}
            onDismiss={dismissNotice}
            testIdBase={testIdBase}
          />
        </div>
      ) : null}

      {canManage ? (
        <PlaceDialog
          mode={dialog}
          onClose={closeDialog}
          onSaved={selectFromDialog}
          onUseExisting={selectFromDialog}
          onArchived={handleArchived}
        />
      ) : null}
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────

const SR_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

function rowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    padding: "9px 14px",
    boxSizing: "border-box",
    cursor: "pointer",
    color: FOREGROUND,
    lineHeight: 1.35,
    background: active ? MUTED : "transparent",
    borderTop: `1px solid ${BORDER}`,
  };
}

/** Group header: the label idiom, ornament only (the group carries aria-label). */
function GroupHeader({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        padding: "10px 14px 6px",
      }}
    >
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      <Text variant="overline" tone="muted">
        {count > 0 ? String(count) : ""}
      </Text>
    </div>
  );
}

function GroupNote({ text }: { text: string }) {
  return (
    <div
      role="presentation"
      style={{
        padding: "4px 14px 12px",
        fontSize: 12,
        lineHeight: 1.4,
        color: DANGER_TEXT,
      }}
    >
      {text}
    </div>
  );
}

const linkButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  padding: 0,
  border: "none",
  background: "transparent",
  color: ACCENT_TEXT,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

function SelectedCard({
  value,
  canManage,
  checking,
  onClear,
  onEditPlace,
  onMakePlace,
  testIdBase,
  note,
}: {
  value: NonNullable<PlaceOrAddressValue>;
  canManage: boolean;
  checking: boolean;
  onClear: () => void;
  onEditPlace: (place: PlacePickerItem) => void;
  onMakePlace: (address: AddressValue) => void;
  testIdBase: string;
  note?: ReactNode;
}) {
  const t = useTranslations();
  const tr = (key: string) => String(t(key));
  const isPlace = value.kind === "place";
  const title = isPlace
    ? value.place.name
    : (value.address.poiName ?? value.address.line1 ?? value.address.formatted);
  const caption = isPlace
    ? value.place.formattedAddress
    : title === value.address.formatted
      ? null
      : value.address.formatted;

  return (
    <div
      data-testid={`${testIdBase}-selected`}
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div
        style={{
          border: `2px solid ${STRUCTURAL}`,
          background: SURFACE,
          borderRadius: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 4px 8px 14px" }}>
          {isPlace ? (
            <Store size={16} aria-hidden style={{ flexShrink: 0, marginTop: 3, color: FOREGROUND }} />
          ) : (
            <MapPin size={16} aria-hidden style={{ flexShrink: 0, marginTop: 3, color: MUTED_TEXT }} />
          )}
          <span style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
            <span
              data-testid={`${testIdBase}-selected-title`}
              style={{ display: "block", fontWeight: 600, fontSize: 14, color: FOREGROUND, overflowWrap: "anywhere" }}
            >
              {title}
            </span>
            {caption ? (
              <span style={{ display: "block", marginTop: 2, fontSize: 12, color: MUTED_TEXT, overflowWrap: "anywhere" }}>
                {caption}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            // The card's one control when there is no Edit / Make action.
            data-card-primary={canManage ? undefined : true}
            onClick={onClear}
            aria-label={tr("communityCreate.pfClear")}
            data-testid={`${testIdBase}-clear`}
            style={{
              width: 44,
              height: 44,
              flexShrink: 0,
              marginTop: -8,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: MUTED_TEXT,
              cursor: "pointer",
            }}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        {!isPlace || canManage ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              columnGap: 16,
              borderTop: `1px solid ${BORDER}`,
              padding: "0 14px",
              minHeight: 44,
            }}
          >
            {!isPlace ? (
              <Text variant="overline" tone="muted">
                {tr("communityCreate.pfAddressOnly")}
              </Text>
            ) : null}
            {canManage && isPlace ? (
              <button
                type="button"
                data-card-primary
                style={linkButtonStyle}
                // aria-disabled, not disabled: a disabled button drops focus
                // to <body> mid-check.
                onClick={() => {
                  if (!checking) onEditPlace(value.place);
                }}
                aria-disabled={checking || undefined}
                aria-busy={checking || undefined}
                data-testid={`${testIdBase}-edit-place`}
              >
                <Pencil size={13} aria-hidden />
                {checking
                  ? tr("communityCreate.pfChecking")
                  : tr("communityCreate.pfEditPlace")}
              </button>
            ) : null}
            {canManage && !isPlace ? (
              <button
                type="button"
                data-card-primary
                style={linkButtonStyle}
                onClick={() => onMakePlace(value.address)}
                data-testid={`${testIdBase}-make-place`}
              >
                <Plus size={13} aria-hidden />
                {tr("communityCreate.pfMakePlace")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {note ? <div>{note}</div> : null}
    </div>
  );
}

/**
 * The field's "<name> is archived. Pick another place." notice, for a place
 * picker that is not this field (the event builder's org-mode PlacePicker),
 * so both modes show the archived state the same way.
 */
export function ArchivedPlaceNotice({
  name,
  onDismiss,
  testIdBase,
}: {
  name: string;
  onDismiss: () => void;
  testIdBase: string;
}) {
  return (
    <FieldNoticeView
      notice={{ kind: "isArchived", name }}
      pathname={null}
      onArchive={() => {}}
      onDismiss={onDismiss}
      testIdBase={testIdBase}
    />
  );
}

function FieldNoticeView({
  notice,
  pathname,
  onArchive,
  onDismiss,
  testIdBase,
}: {
  notice: FieldNotice;
  pathname: string | null;
  onArchive: (mode: PlaceDialogMode) => void;
  onDismiss: () => void;
  testIdBase: string;
}) {
  const t = useTranslations();
  const tr = (key: string, values?: Record<string, string | number>) =>
    String(t(key, values));

  if (notice.kind === "secondFactor") {
    return <SecondFactorNotice pathname={pathname} />;
  }
  const title =
    notice.kind === "refused"
      ? tr(REFUSAL_COPY[notice.reason].title)
      : notice.kind === "archived" || notice.kind === "isArchived"
        ? tr("communityCreate.pfArchivedTitle", { name: notice.name })
        : null;
  const body =
    notice.kind === "refused"
      ? tr(REFUSAL_COPY[notice.reason].body)
      : notice.kind === "archived"
        ? tr("communityCreate.pfArchivedBody")
        : notice.kind === "isArchived"
          ? tr("communityCreate.pfIsArchivedBody")
          : notice.text;

  return (
    <div
      role="status"
      data-testid={`${testIdBase}-notice`}
      style={{
        background: MUTED,
        borderLeft: `3px solid ${notice.kind === "error" ? DANGER_TEXT : STRUCTURAL}`,
        padding: "10px 4px 10px 12px",
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {title ? (
          <Text variant="bodySmall" weight="bold">
            {title}
          </Text>
        ) : null}
        <Text variant="caption" style={{ color: MUTED_TEXT }}>
          {body}
        </Text>
        {notice.kind === "refused" && notice.archive ? (
          <button
            type="button"
            style={{ ...linkButtonStyle, color: DANGER_TEXT, alignSelf: "flex-start" }}
            onClick={() => notice.archive && onArchive(notice.archive)}
            data-testid={`${testIdBase}-notice-archive`}
          >
            {tr("communityCreate.pdArchive")}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={tr("communityCreate.pfDismiss")}
        style={{
          width: 44,
          height: 44,
          marginTop: -10,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          color: MUTED_TEXT,
          cursor: "pointer",
        }}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export default PlaceOrAddressField;
