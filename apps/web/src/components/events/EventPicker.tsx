"use client";

import { useState, useMemo, useCallback, useId, useRef, useEffect } from "react";
import { useRouter } from "@bprogress/next/app";
import { styled, useTheme, XStack, YStack } from "tamagui";
import { CalendarDays, ChevronDown, MapPin, Search, X } from "lucide-react";

import { Text, Button } from "@th/ui";

import { trpc } from "@/trpc";
import {
  PICKER_FOCUS_VISIBLE_STYLE,
  activateKeyProps,
  dismissKeyProps,
  dropdownTriggerKeyProps,
} from "@/lib/dropdown-keyboard";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type EventPickerItem = {
  eventId: string;
  /** `title` is nullable on the model — never render it raw. */
  title: string | null;
  startsAt: Date | null;
  placeName: string | null;
  slug: string | null;
};

export type EventPickerProps = {
  /** Currently selected event (controlled). */
  value: EventPickerItem | null;
  /** Fires when the user picks or clears an event. */
  onChange: (event: EventPickerItem | null) => void;
  /** Owner whose events to list — mirrors `events.listMine`. */
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  /** Admin slug used to build the "Manage events" link. */
  adminSlug?: string;
  placeholder?: string;
};

/** Fallback label for `title: null` — never render the string "null". */
const UNTITLED_EVENT = "Untitled event";

/* ------------------------------------------------------------------ */
/*  Styles — mirrors PlacePicker so the two read as one system         */
/* ------------------------------------------------------------------ */

const Trigger = styled(XStack, {
  padding: 12,
  paddingHorizontal: 16,
  borderWidth: 1,
  borderColor: "$borderColorStrong",
  backgroundColor: "$surface",
  alignItems: "center",
  gap: 10,
  cursor: "pointer",
  hoverStyle: { borderColor: "$borderColorHover" },
  focusVisibleStyle: PICKER_FOCUS_VISIBLE_STYLE,
});

const DropdownContainer = styled(YStack, {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 200,
  backgroundColor: "$surface",
  borderWidth: 1,
  borderColor: "$borderColorStrong",
  borderTopWidth: 0,
  maxHeight: 320,
  overflow: "hidden",
});

const SearchRow = styled(XStack, {
  padding: 10,
  gap: 8,
  alignItems: "center",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
});

const ResultsList = styled(YStack, {
  overflow: "auto" as never,
  maxHeight: 260,
});

const EventRow = styled(XStack, {
  padding: 12,
  paddingHorizontal: 16,
  gap: 10,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    ...PICKER_FOCUS_VISIBLE_STYLE,
    outlineOffset: -2,
    backgroundColor: "$surfaceMuted",
  },
});

/** Footer / empty-state actions that navigate away. */
const RowAction = styled(XStack, {
  gap: 4,
  alignItems: "center",
  cursor: "pointer",
  focusVisibleStyle: PICKER_FOCUS_VISIBLE_STYLE,
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** `startsAt` is nullable (an unscheduled draft that later published). */
function formatStartsAt(startsAt: Date | null): string | null {
  if (!startsAt) return null;
  const time = startsAt.getTime();
  return Number.isNaN(time) ? null : dateFormatter.format(startsAt);
}

/** Date · Venue, skipping whichever half is missing. */
function buildSubtext(event: EventPickerItem): string | null {
  const parts = [formatStartsAt(event.startsAt), event.placeName].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Event dropdown for admin surfaces — the event-subject counterpart to
 * `PlacePicker`, deliberately built to the same structure, interaction model
 * and styling so the two read as one system.
 *
 * PUBLISHED-ONLY on purpose: `upsertEmbed` rejects a non-published event with
 * `EVENT_NOT_PUBLISHED`, so offering a draft here would only ever produce a
 * server error. The empty state says so out loud.
 *
 * `events.listMine` has NO query param, so search filters the fetched page
 * client-side (capped at 100 by `limit`). Copy is literal English, following
 * the precedent on the embeds surface.
 */
export function EventPicker({
  value,
  onChange,
  ownerType,
  ownerId,
  adminSlug,
  placeholder,
}: EventPickerProps) {
  const theme = useTheme();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const listboxId = useId();

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      // Small delay so the dropdown renders first
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  // Lazy: costs nothing until the organiser actually opens the dropdown.
  const { data, isLoading, error, refetch } = trpc.events.listMine.useQuery(
    { ownerType, ownerId, status: ["PUBLISHED"], limit: 100 },
    { staleTime: 30_000, enabled: open && Boolean(ownerId) },
  );

  const allEvents = useMemo<EventPickerItem[]>(
    () =>
      (data?.items ?? []).map((e) => ({
        eventId: e.id,
        title: e.title,
        startsAt: e.startsAt,
        placeName: e.placeName,
        slug: e.slug,
      })),
    [data?.items],
  );

  // Client-side filter — `listMine` takes no query param.
  const events = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return allEvents;
    return allEvents.filter((e) =>
      (e.title ?? UNTITLED_EVENT).toLowerCase().includes(needle),
    );
  }, [allEvents, query]);

  const handleSelect = useCallback(
    (event: EventPickerItem) => {
      onChange(event);
      setOpen(false);
      setQuery("");
    },
    [onChange],
  );

  const handleClear = useCallback(
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onChange(null);
    },
    [onChange],
  );

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
    if (open) setQuery("");
  }, [open]);

  /** Escape / re-toggle: close AND hand focus back, or the user is stranded. */
  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }, []);

  const goToEvents = useCallback(() => {
    setOpen(false);
    router.push(`/admin/${adminSlug}/events`);
  }, [router, adminSlug]);

  const displayText = value
    ? (value.title ?? UNTITLED_EVENT)
    : (placeholder ?? "Select an event");

  const displaySubtext = value ? buildSubtext(value) : null;

  return (
    <YStack position="relative" ref={containerRef as never}>
      <Trigger
        ref={triggerRef as never}
        onPress={handleToggle}
        // Keyboard-operable disclosure. NOT `tag="button"`: the clear control
        // below is a real <button>, and nesting buttons is invalid HTML.
        role="combobox"
        tabIndex={0}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={placeholder ?? "Select an event"}
        {...(dropdownTriggerKeyProps({
          open,
          onOpen: () => setOpen(true),
          onClose: closeAndRefocus,
        }) as object)}
      >
        <CalendarDays
          size={16}
          color={value ? theme.color?.val : theme.colorMuted?.val}
        />
        <YStack flex={1} gap={2} minWidth={0}>
          <Text variant="body" color={value ? "$color" : "$colorMuted"}>
            {displayText}
          </Text>
          {displaySubtext && (
            <Text variant="caption" color="$colorMuted">
              {displaySubtext}
            </Text>
          )}
        </YStack>
        {value ? (
          <Button
            variant="ghost"
            size="$1"
            onPress={handleClear}
            aria-label="Clear selected event"
          >
            <X size={14} color={theme.colorMuted?.val} />
          </Button>
        ) : (
          <ChevronDown size={16} color={theme.colorMuted?.val} />
        )}
      </Trigger>

      {open && (
        <DropdownContainer {...(dismissKeyProps(closeAndRefocus) as object)}>
          <SearchRow>
            <Search size={14} color={theme.colorMuted?.val} />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your events…"
              aria-label="Search your events"
              style={{
                flex: 1,
                border: "none",
                fontSize: 14,
                backgroundColor: "transparent",
                color: "var(--color, #211C16)",
              }}
            />
          </SearchRow>

          {/* `role="listbox"` is spread via a cast: Tamagui's Role type is
              RN-derived and omits "listbox" (it has combobox/option but not
              the container role). Same cast pattern as onKeyDown. */}
          <ResultsList
            id={listboxId}
            aria-label="Your published events"
            {...({ role: "listbox" } as object)}
          >
            {isLoading && (
              <XStack padding={16} justifyContent="center">
                <Text variant="caption" color="$colorMuted">
                  Loading your events…
                </Text>
              </XStack>
            )}

            {!isLoading && error && (
              <YStack padding={16} alignItems="center" gap={8}>
                <Text variant="caption" tone="error" textAlign="center">
                  Couldn&rsquo;t load your events.
                </Text>
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={() => void refetch()}
                >
                  <Text tone="inherit" variant="caption" weight="bold">
                    Retry
                  </Text>
                </Button>
              </YStack>
            )}

            {!isLoading && !error && events.length === 0 && (
              <YStack padding={16} alignItems="center" gap={4}>
                <Text variant="caption" color="$colorMuted" textAlign="center">
                  {query.trim().length >= 2
                    ? "No published events match that search."
                    : "No published events yet — only published events can be embedded."}
                </Text>
                {adminSlug && (
                  <RowAction
                    paddingVertical={6}
                    role="button"
                    tabIndex={0}
                    onPress={goToEvents}
                    {...(activateKeyProps(goToEvents) as object)}
                  >
                    <CalendarDays size={12} color={theme.accent?.val} />
                    <Text variant="caption" color="$accent">
                      Go to your events
                    </Text>
                  </RowAction>
                )}
              </YStack>
            )}

            {!isLoading &&
              !error &&
              events.map((event) => {
                const subtext = buildSubtext(event);
                return (
                  <EventRow
                    key={event.eventId}
                    onPress={() => handleSelect(event)}
                    role="option"
                    aria-selected={value?.eventId === event.eventId}
                    tabIndex={0}
                    {...(activateKeyProps(() => handleSelect(event)) as object)}
                  >
                    <CalendarDays size={14} color={theme.color?.val} />
                    <YStack flex={1} gap={1} minWidth={0}>
                      <Text variant="body" color="$color">
                        {event.title ?? UNTITLED_EVENT}
                      </Text>
                      {subtext && (
                        <XStack gap={4} alignItems="center">
                          {event.placeName && (
                            <MapPin size={11} color={theme.colorMuted?.val} />
                          )}
                          <Text variant="caption" color="$colorMuted">
                            {subtext}
                          </Text>
                        </XStack>
                      )}
                    </YStack>
                  </EventRow>
                );
              })}
          </ResultsList>

          {adminSlug && !isLoading && !error && events.length > 0 && (
            <RowAction
              padding={10}
              gap={6}
              justifyContent="center"
              borderTopWidth={1}
              borderTopColor="$borderColor"
              hoverStyle={{ backgroundColor: "$surfaceMuted" }}
              role="button"
              tabIndex={0}
              onPress={goToEvents}
              {...(activateKeyProps(goToEvents) as object)}
            >
              <CalendarDays size={12} color={theme.accent?.val} />
              <Text variant="caption" color="$accent">
                Manage events
              </Text>
            </RowAction>
          )}
        </DropdownContainer>
      )}
    </YStack>
  );
}

export default EventPicker;
