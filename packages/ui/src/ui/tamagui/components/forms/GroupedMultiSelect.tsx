"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import { XStack, YStack, styled } from "tamagui";

import { Text } from "../typography/Text";

// ─────────────────────────────────────────────────────────────────────────────
// GroupedMultiSelect — the shared two-level filter control for data tables.
//
// One control where a table would otherwise carry two dependent selects. The
// groups are the parent dimension (venues), the options are the values the
// rows actually carry (calendars); picking a group picks everything under it.
//
// It exists because the parent dimension is usually NOT a second axis — it is
// shorthand for "every value under this heading". A booking request routes to
// exactly one calendar and every calendar belongs to exactly one venue, so
// "filter by venue" only ever meant "all of that venue's calendars". Two
// selects made the reader hold that relationship in their head; this shows it.
//
// The value is therefore a FLAT set of option ids. A group is a rendering and
// interaction affordance, never a value of its own — callers filter rows with
// a single `selected.has(row.optionId)` and nothing else.
//
// BEHAVIOUR, and where each rule comes from:
//   - the popover stays OPEN while selecting (PatternFly): multi-select means
//     several clicks, and a menu that shuts after each turns three choices
//     into three round trips. It closes on click-away, Escape, or the trigger;
//     nothing else;
//   - selection applies LIVE (Pencil & Paper): no Apply button — the option
//     set is small, the stakes are low, and the reader is watching the table's
//     counts move as they choose;
//   - selection is legible THREE ways (Pencil & Paper): the trigger label, the
//     checkboxes inside, and the removable chips beneath — so an active filter
//     is never something you have to reopen a menu to discover;
//   - the selected count is announced (`role="status"`, per Helios), because
//     the number changing is the only feedback a screen-reader user gets;
//   - EMPTY SELECTION MEANS EVERYTHING, never "nothing matches". A group that
//     appears while a filter is active therefore arrives unselected rather
//     than silently joining a pick the reader made earlier.
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupedMultiSelectOption {
  id: string;
  label: string;
  /** Optional row count shown right-aligned. Omit when unknown, never fake 0. */
  count?: number;
}

export interface GroupedMultiSelectGroup {
  id: string;
  label: string;
  options: GroupedMultiSelectOption[];
}

export interface GroupedMultiSelectProps {
  groups: GroupedMultiSelectGroup[];
  /** Selected OPTION ids. Empty = no filter = every row. */
  value: string[];
  onChange: (next: string[]) => void;
  /**
   * Trigger text when nothing is selected — "All calendars", not "0 selected".
   * An unfiltered list is not an empty selection.
   */
  allLabel: string;
  /** Visible field label; also the popover's accessible name. */
  label: string;
  /** Shown when a single whole group is selected: `${group} (${allInGroupLabel})`. */
  allInGroupLabel?: string;
  /** Plural noun for the count fallback — "calendars". */
  unitLabel: string;
  clearLabel?: string;
  /**
   * The announced selection summary (`role="status"`). Takes the count and the
   * total because "3" alone tells a screen-reader user nothing about scale,
   * and a bare fraction ("1 / 7") reads as a progress bar rather than a
   * selection. Supply a localized formatter; the default is English.
   */
  formatSelectedCount?: (selected: number, total: number) => string;
  searchPlaceholder?: string;
  /**
   * Show the search box once the control holds more than this many options.
   * Owned-place enumeration caps at 100, so the top end is a long list and
   * typing is the only sane way in.
   */
  searchThreshold?: number;
  /** Render the removable chips under the trigger. */
  showChips?: boolean;
  disabled?: boolean;
  testIdBase?: string;
}

const isWeb = Platform.OS === "web";

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives — house Swiss chrome: square corners, 2px rules.
// ─────────────────────────────────────────────────────────────────────────────

const Trigger = styled(XStack, {
  name: "GroupedMultiSelectTrigger",
  tag: "button",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$2",
  backgroundColor: "$background",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderStyle: "solid",
  borderRadius: 0,
  paddingHorizontal: "$3",
  minHeight: 40,
  cursor: "pointer",
  width: "100%",
  variants: {
    open: { true: { borderColor: "$accent" } },
    disabled: { true: { opacity: 0.55, cursor: "default" } },
  } as const,
});

const Popover = styled(YStack, {
  name: "GroupedMultiSelectPopover",
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  marginTop: 6,
  zIndex: 1000,
  backgroundColor: "$background",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderStyle: "solid",
  borderRadius: 0,
  maxHeight: 340,
  overflow: "hidden",
});

const OptionRow = styled(XStack, {
  name: "GroupedMultiSelectOption",
  tag: "button",
  alignItems: "center",
  gap: "$2",
  backgroundColor: "transparent",
  borderWidth: 0,
  paddingVertical: "$2",
  paddingHorizontal: "$3",
  cursor: "pointer",
  width: "100%",
  minHeight: 36,
  hoverStyle: { backgroundColor: "$backgroundHover" },
  variants: {
    child: { true: { paddingLeft: 34 } },
  } as const,
});

const Box = styled(YStack, {
  name: "GroupedMultiSelectBox",
  width: 15,
  height: 15,
  borderWidth: 2,
  borderColor: "$borderColor",
  borderStyle: "solid",
  alignItems: "center",
  justifyContent: "center",
  variants: {
    state: {
      checked: { backgroundColor: "$accent", borderColor: "$accent" },
      mixed: { backgroundColor: "$accent", borderColor: "$accent" },
      unchecked: { backgroundColor: "transparent" },
    },
  } as const,
});

const PlainButton = styled(XStack, {
  name: "GroupedMultiSelectPlainButton",
  tag: "button",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  paddingHorizontal: 0,
  cursor: "pointer",
  variants: {
    muted: { true: { cursor: "default" } },
  } as const,
});

const Chip = styled(XStack, {
  name: "GroupedMultiSelectChip",
  alignItems: "center",
  gap: "$1",
  borderWidth: 1,
  borderColor: "$accent",
  borderStyle: "solid",
  borderRadius: 0,
  paddingLeft: "$2",
  paddingRight: "$1",
  paddingVertical: 3,
});

type GroupState = "checked" | "mixed" | "unchecked";

/** Pure: a group is checked only when EVERY option under it is. */
export function groupSelectionState(
  group: GroupedMultiSelectGroup,
  selected: ReadonlySet<string>,
): GroupState {
  if (group.options.length === 0) return "unchecked";
  const n = group.options.filter((o) => selected.has(o.id)).length;
  if (n === 0) return "unchecked";
  return n === group.options.length ? "checked" : "mixed";
}

/**
 * The trigger's label, degrading by specificity so the common cases read as
 * words and only the messy ones fall back to a number.
 */
export function triggerLabelFor(
  groups: readonly GroupedMultiSelectGroup[],
  selected: ReadonlySet<string>,
  copy: { all: string; unit: string; allInGroup: string },
): string {
  if (selected.size === 0) return copy.all;

  if (selected.size === 1) {
    for (const g of groups) {
      const hit = g.options.find((o) => selected.has(o.id));
      if (hit) return `${g.label} — ${hit.label}`;
    }
  }

  const whole = groups.filter((g) => groupSelectionState(g, selected) === "checked");
  const wholeCount = whole.reduce((n, g) => n + g.options.length, 0);
  if (whole.length === 1 && wholeCount === selected.size) {
    return `${whole[0]!.label} (${copy.allInGroup})`;
  }

  return `${selected.size} ${copy.unit}`;
}

export function GroupedMultiSelect({
  groups,
  value,
  onChange,
  allLabel,
  label,
  allInGroupLabel = "all",
  unitLabel,
  clearLabel = "Clear",
  formatSelectedCount = (n, total) => `${n} of ${total} selected`,
  searchPlaceholder,
  searchThreshold = 10,
  showChips = true,
  disabled = false,
  testIdBase = "grouped-multi-select",
}: GroupedMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();

  const selected = useMemo(() => new Set(value), [value]);
  const totalOptions = useMemo(
    () => groups.reduce((n, g) => n + g.options.length, 0),
    [groups],
  );

  // Close on click-away and Escape — the ONLY two ways out besides the
  // trigger. Selecting deliberately does not close (see the header).
  useEffect(() => {
    if (!isWeb || !open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleOption = useCallback(
    (id: string) => {
      const next = new Set(selected);
      next.has(id) ? next.delete(id) : next.add(id);
      onChange([...next]);
    },
    [selected, onChange],
  );

  const toggleGroup = useCallback(
    (group: GroupedMultiSelectGroup) => {
      const next = new Set(selected);
      // A mixed or empty group FILLS; only a full one empties. Filling from
      // mixed is the useful move — the reader is reaching for "all of these".
      if (groupSelectionState(group, selected) === "checked") {
        group.options.forEach((o) => next.delete(o.id));
      } else {
        group.options.forEach((o) => next.add(o.id));
      }
      onChange([...next]);
    },
    [selected, onChange],
  );

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => {
        // A group whose NAME matches keeps all of its options — the reader
        // typed the venue to get at its calendars.
        if (g.label.toLowerCase().includes(needle)) return g;
        const options = g.options.filter((o) =>
          o.label.toLowerCase().includes(needle),
        );
        return options.length > 0 ? { ...g, options } : null;
      })
      .filter((g): g is GroupedMultiSelectGroup => g !== null);
  }, [groups, query]);

  const chips = useMemo(() => {
    if (selected.size === 0) return [];
    const whole = new Set(
      groups
        .filter((g) => groupSelectionState(g, selected) === "checked")
        .map((g) => g.id),
    );
    const out: { key: string; label: string; remove: () => void }[] = [];
    for (const g of groups) {
      if (whole.has(g.id)) {
        out.push({
          key: `g:${g.id}`,
          label: `${g.label} · ${allInGroupLabel}`,
          remove: () => {
            const next = new Set(selected);
            g.options.forEach((o) => next.delete(o.id));
            onChange([...next]);
          },
        });
        continue;
      }
      for (const o of g.options) {
        if (!selected.has(o.id)) continue;
        out.push({
          key: `o:${o.id}`,
          label: `${g.label} · ${o.label}`,
          remove: () => onChange(value.filter((id) => id !== o.id)),
        });
      }
    }
    return out;
  }, [groups, selected, value, onChange, allInGroupLabel]);

  const triggerText = triggerLabelFor(groups, selected, {
    all: allLabel,
    unit: unitLabel,
    allInGroup: allInGroupLabel,
  });

  // "Earn your place": fewer than two real choices is a label, not a control.
  if (totalOptions < 2) return null;

  const webProps = (extra: Record<string, unknown>) =>
    isWeb ? { type: "button", ...extra } : {};

  return (
    <YStack gap="$2" width="100%" testID={testIdBase}>
      <YStack
        gap="$1"
        width="100%"
        {...(isWeb ? { ref: containerRef as never, position: "relative" as const } : {})}
      >
        <Text variant="label" tone="muted">
          {label}
        </Text>

        <Trigger
          open={open}
          disabled={disabled}
          onPress={() => !disabled && setOpen((v) => !v)}
          testID={`${testIdBase}-trigger`}
          {...webProps({
            "aria-expanded": open,
            "aria-haspopup": "dialog",
            "aria-controls": popoverId,
            "aria-label": `${label}: ${triggerText}`,
            disabled,
          })}
        >
          <Text variant="bodySmall" truncate flex={1}>
            {triggerText}
          </Text>
          <Text variant="caption" tone="muted">
            ▾
          </Text>
        </Trigger>

        {open ? (
          <Popover
            testID={`${testIdBase}-popover`}
            {...webProps({ id: popoverId, role: "dialog", "aria-label": label })}
          >
            {totalOptions > searchThreshold ? (
              <YStack
                padding="$2"
                borderBottomWidth={1}
                borderBottomColor="$borderColor"
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder ?? label}
                  data-testid={`${testIdBase}-search`}
                  style={{
                    width: "100%",
                    padding: "7px 10px",
                    borderRadius: 0,
                    border: "1px solid currentColor",
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                  }}
                />
              </YStack>
            ) : null}

            <YStack flex={1} overflow="scroll" paddingVertical="$1">
              {visibleGroups.length === 0 ? (
                <YStack padding="$3">
                  <Text variant="bodySmall" tone="muted">
                    No matches.
                  </Text>
                </YStack>
              ) : (
                visibleGroups.map((group) => {
                  const state = groupSelectionState(group, selected);
                  const groupCount = group.options.reduce(
                    (n, o) => n + (o.count ?? 0),
                    0,
                  );
                  return (
                    <YStack key={group.id}>
                      <OptionRow
                        onPress={() => toggleGroup(group)}
                        testID={`${testIdBase}-group-${group.id}`}
                        {...webProps({
                          role: "checkbox",
                          "aria-checked":
                            state === "mixed" ? "mixed" : state === "checked",
                        })}
                      >
                        <Box
                          state={state === "checked" ? "checked" : state === "mixed" ? "mixed" : "unchecked"}
                        >
                          <Text variant="caption" color="$background">
                            {state === "checked" ? "✓" : state === "mixed" ? "–" : ""}
                          </Text>
                        </Box>
                        <Text variant="bodySmall" weight="bold" truncate flex={1}>
                          {group.label}
                        </Text>
                        {group.options.some((o) => o.count !== undefined) ? (
                          <Text variant="caption" tone="muted">
                            {groupCount}
                          </Text>
                        ) : null}
                      </OptionRow>

                      {group.options.map((option) => {
                        const on = selected.has(option.id);
                        return (
                          <OptionRow
                            key={option.id}
                            child
                            onPress={() => toggleOption(option.id)}
                            testID={`${testIdBase}-option-${option.id}`}
                            {...webProps({
                              role: "checkbox",
                              "aria-checked": on,
                            })}
                          >
                            <Box state={on ? "checked" : "unchecked"}>
                              <Text variant="caption" color="$background">
                                {on ? "✓" : ""}
                              </Text>
                            </Box>
                            <Text variant="bodySmall" truncate flex={1}>
                              {option.label}
                            </Text>
                            {option.count !== undefined ? (
                              <Text variant="caption" tone="muted">
                                {option.count}
                              </Text>
                            ) : null}
                          </OptionRow>
                        );
                      })}
                    </YStack>
                  );
                })
              )}
            </YStack>

            <XStack
              alignItems="center"
              justifyContent="space-between"
              gap="$2"
              padding="$2"
              borderTopWidth={1}
              borderTopColor="$borderColor"
            >
              <PlainButton
                muted={selected.size === 0}
                minHeight={24}
                onPress={() => onChange([])}
                testID={`${testIdBase}-clear`}
                {...webProps({ disabled: selected.size === 0 })}
              >
                <Text
                  variant="caption"
                  color={selected.size === 0 ? "$colorMuted" : "$accent"}
                >
                  {clearLabel}
                </Text>
              </PlainButton>
              {/* Announced: the count changing is the only feedback a
                  screen-reader user gets from a live-applying filter. */}
              <Text
                variant="caption"
                tone="muted"
                {...(isWeb ? ({ role: "status" } as never) : {})}
              >
                {selected.size === 0
                  ? allLabel
                  : formatSelectedCount(selected.size, totalOptions)}
              </Text>
            </XStack>
          </Popover>
        ) : null}
      </YStack>

      {showChips && chips.length > 0 ? (
        <XStack flexWrap="wrap" gap="$2" testID={`${testIdBase}-chips`}>
          {chips.map((chip) => (
            <Chip key={chip.key}>
              <Text variant="caption" color="$accent">
                {chip.label}
              </Text>
              <PlainButton
                minHeight={20}
                paddingHorizontal={4}
                onPress={chip.remove}
                testID={`${testIdBase}-chip-remove-${chip.key}`}
                {...webProps({ "aria-label": `Remove ${chip.label}` })}
              >
                <Text variant="caption" color="$accent">
                  ×
                </Text>
              </PlainButton>
            </Chip>
          ))}
        </XStack>
      ) : null}
    </YStack>
  );
}
