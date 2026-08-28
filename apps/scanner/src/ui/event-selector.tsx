import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Calendar, ChevronDown, MapPin, Search } from "lucide-react-native";

import { Text, useColors, type NativePalette } from "@th/ui-native";

export type SelectableEvent = {
  eventId: string;
  eventName: string;
  startAt: string | null;
  endAt: string | null;
  status: string;
};

export const EventSelector = ({
  events,
  selectedEventId,
  onSelect,
  testID,
  variant = "default",
}: {
  events: SelectableEvent[];
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
  testID?: string;
  /**
   * `compact` renders a slim pill-style trigger suitable for the app
   * header strip — name + chevron only, no date/status meta line.
   * The modal sheet is identical in both variants.
   */
  variant?: "default" | "compact";
}) => {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<TextInput | null>(null);
  const selected = events.find((e) => e.eventId === selectedEventId);
  const label = selected?.eventName ?? "No event selected";
  const isCompact = variant === "compact";

  // Clear stale filter from a previous opening and focus the search
  // field whenever the sheet opens, so the operator can type-to-narrow
  // immediately. The 120ms delay lets the modal mount + animate in
  // before we steal focus.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const t = setTimeout(() => searchRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, [open]);

  // Hide events whose end-time (or start, if no end) is more than 12h
  // in the past. The web event listings hide past events for the same
  // reason — they're not bookable / actionable, and on the scanner
  // they're a distraction that makes the picker noisy as the org
  // accumulates history. The 12h grace handles cleanup scans for an
  // overnight festival that "ended" at 02:00.
  const visibleEvents = useMemo(() => {
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    return events.filter((ev) => {
      const endTime = ev.endAt ?? ev.startAt;
      if (!endTime) return true;
      const t = new Date(endTime).getTime();
      if (Number.isNaN(t)) return true;
      return t >= cutoff;
    });
  }, [events]);

  // Case-insensitive substring match over the event name. Operators
  // running multi-event shifts (festivals, tour stops) routinely scroll
  // past 10+ events; a search filter scales the picker past that point.
  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return visibleEvents;
    return visibleEvents.filter((ev) => ev.eventName.toLowerCase().includes(q));
  }, [visibleEvents, query]);

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const isMultiDay = (ev: SelectableEvent) => {
    if (!ev.startAt || !ev.endAt) return false;
    const s = new Date(ev.startAt);
    const e = new Date(ev.endAt);
    return s.toDateString() !== e.toDateString();
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Selected event: ${label}. Tap to change.`}
        accessibilityHint="Opens the event selector."
        onPress={() => setOpen(true)}
        style={
          isCompact
            ? [styles.triggerCompact, { borderColor: colors.onStructureSoft }]
            : [
                styles.trigger,
                {
                  borderColor: colors.borderColor,
                  backgroundColor: colors.surface,
                },
              ]
        }
        testID={testID ?? "event-selector-trigger"}
      >
        <View
          style={
            isCompact ? styles.triggerContentCompact : styles.triggerContent
          }
        >
          <Text
            variant="caption"
            weight="bold"
            style={[
              isCompact ? styles.triggerLabelCompact : styles.triggerLabel,
              // Compact sits on the header's `structure` fill (dark in BOTH
              // themes); default sits on the page surface.
              { color: isCompact ? colors.onStructure : colors.color },
            ]}
            {...({ numberOfLines: 1 } as Record<string, unknown>)}
          >
            {label.toUpperCase()}
          </Text>
          {!isCompact && selected ? (
            <Text
              variant="caption"
              style={[styles.triggerMeta, { color: colors.colorMuted }]}
            >
              {formatDate(selected.startAt)}
              {isMultiDay(selected) ? ` – ${formatDate(selected.endAt)}` : ""}
              {" · "}
              {selected.status}
            </Text>
          ) : null}
        </View>
        <ChevronDown
          size={isCompact ? 14 : 16}
          color={isCompact ? colors.onStructure : colors.colorMuted}
        />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={[styles.overlay, { backgroundColor: colors.modalScrim }]}
          onPress={() => setOpen(false)}
        >
          {/* Inner pressable that swallows taps so tapping inside the
              sheet doesn't bubble up to the overlay's onPress and close
              the modal mid-search. */}
          <Pressable
            style={[
              styles.sheet,
              {
                borderColor: colors.borderColor,
                backgroundColor: colors.background,
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View
              style={[
                styles.sheetHeader,
                { borderBottomColor: colors.borderColorSoft },
              ]}
            >
              <Text
                variant="caption"
                weight="bold"
                style={[styles.sheetTitle, { color: colors.colorMuted }]}
              >
                SELECT EVENT
              </Text>
            </View>
            <View
              style={[
                styles.searchRow,
                { borderBottomColor: colors.borderColorSoft },
              ]}
            >
              <Search size={14} color={colors.colorMuted} />
              <TextInput
                ref={searchRef}
                value={query}
                onChangeText={setQuery}
                placeholder="Filter by name"
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={[styles.searchInput, { color: colors.color }]}
                testID="event-selector-search"
              />
            </View>
            <ScrollView
              style={styles.sheetScroll}
              keyboardShouldPersistTaps="handled"
            >
              {filteredEvents.map((ev) => {
                const isActive = ev.eventId === selectedEventId;
                const multiDay = isMultiDay(ev);
                return (
                  <Pressable
                    key={ev.eventId}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isActive }}
                    onPress={() => {
                      onSelect(ev.eventId);
                      setOpen(false);
                    }}
                    style={[
                      styles.eventRow,
                      { borderBottomColor: colors.borderColorSoft },
                      isActive && {
                        backgroundColor: colors.activeRowTint,
                        borderLeftWidth: 3,
                        borderLeftColor: colors.accent,
                      },
                    ]}
                    testID={`event-selector-option-${ev.eventId}`}
                  >
                    <View style={styles.eventInfo}>
                      <Text
                        variant="body"
                        weight={isActive ? "bold" : undefined}
                        color={isActive ? colors.color : colors.colorMuted}
                      >
                        {ev.eventName}
                      </Text>
                      <View style={styles.eventMeta}>
                        <Calendar size={12} color={colors.colorMuted} />
                        <Text
                          variant="caption"
                          style={[
                            styles.metaText,
                            { color: colors.colorMuted },
                          ]}
                        >
                          {formatDate(ev.startAt) ?? "TBD"}
                          {multiDay ? ` – ${formatDate(ev.endAt)}` : ""}
                        </Text>
                        <View
                          style={[
                            styles.statusDot,
                            { backgroundColor: statusColor(ev.status, colors) },
                          ]}
                        />
                        <Text
                          variant="caption"
                          style={[
                            styles.metaText,
                            { color: colors.colorMuted },
                          ]}
                        >
                          {ev.status}
                        </Text>
                      </View>
                    </View>
                    {isActive ? (
                      <View
                        style={[
                          styles.activeIndicator,
                          { backgroundColor: colors.accent },
                        ]}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
              {filteredEvents.length === 0 ? (
                <View style={styles.empty}>
                  <MapPin size={20} color={colors.colorMuted} />
                  <Text variant="bodySmall" color={colors.colorMuted}>
                    {events.length === 0
                      ? "No accessible events"
                      : visibleEvents.length === 0
                        ? "No upcoming events"
                        : "No matches"}
                  </Text>
                </View>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

/**
 * Status dot tone. PUBLISHED now reads `success` rather than steel blue: the
 * old mapping used the pre-v2 `accent` (#35589A), which is `structure` in v2
 * terms and measured 2.46:1 on the navy canvas — a dot nobody could see.
 */
const statusColor = (status: string, c: NativePalette) => {
  switch (status) {
    case "PUBLISHED":
      return c.success;
    case "COMPLETED":
      return c.accent;
    case "DRAFT":
    default:
      return c.colorMuted;
  }
};

/**
 * Geometry only — colours are applied inline from `useColors()` at each site.
 *
 * The `compact` trigger is CHROME (it lives in the header strip), so it is a
 * pill with a hairline; the `default` trigger is CONTENT and stays strict Swiss
 * at `radius: 0` with a 2px border. DS v2 §4.
 */
const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 2,
    borderRadius: 0,
  },
  triggerContent: {
    flex: 1,
    gap: 2,
  },
  triggerLabel: {
    fontSize: 11,
    letterSpacing: 1.5,
  },
  triggerMeta: {
    fontSize: 10,
  },
  triggerCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
    backgroundColor: "transparent",
    minHeight: 44,
    minWidth: 44,
    maxWidth: 240,
  },
  triggerContentCompact: {
    flexShrink: 1,
  },
  triggerLabelCompact: {
    fontSize: 10,
    letterSpacing: 1.2,
  },
  overlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  sheet: {
    maxHeight: "70%",
    borderWidth: 2,
    borderRadius: 0,
  },
  sheetHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  sheetTitle: {
    fontSize: 10,
    letterSpacing: 2,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },
  sheetScroll: {
    maxHeight: 400,
  },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    minHeight: 56,
  },
  eventInfo: {
    flex: 1,
    gap: 4,
  },
  eventMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontSize: 10,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  activeIndicator: {
    width: 8,
    height: 8,
    borderRadius: 0,
  },
  empty: {
    alignItems: "center",
    gap: 8,
    padding: 24,
  },
});
