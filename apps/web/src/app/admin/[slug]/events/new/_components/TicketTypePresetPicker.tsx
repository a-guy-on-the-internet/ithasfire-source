"use client";

/**
 * "Start from" preset picker — the first field of the ticket-type ADD form.
 *
 * Why a local listbox instead of a shared primitive:
 *  - `@th/ui` `StyledSelect` overlays a native `<select>` and takes a single
 *    string label per option, so it cannot render the two-line
 *    (name + muted mono meta) rows this picker is built around.
 *  - `@th/ui` `Popover` portals through `FloatingPortal` at `zIndex: 1000`,
 *    which sits UNDER the mobile `BottomSheet` (10000) that hosts this form on
 *    phones, and its `cloneElement(anchor, { ref })` captures the anchor ref we
 *    need for outside-click containment.
 *  So this mirrors the sibling `HumanSearchCombobox` dropdown already used in
 *  this directory (and inside the same sheet): an absolutely-positioned
 *  listbox in a `position: relative` root.
 *
 * Accessibility: the ARIA 1.2 select-only combobox pattern. Focus never leaves
 * the trigger — the active row is tracked with `aria-activedescendant`, so the
 * mobile sheet's Tab trap and this picker never fight over focus.
 *
 * Focus treatment — DELIBERATE divergence: the repo has two picker conventions.
 * `PlacePicker`/`EventPicker` use `PICKER_FOCUS_VISIBLE_STYLE` (a 2px `$focus`
 * outline) because they're standalone search affordances. This one uses
 * `forms/TextInput.tsx`'s border→`$accent` treatment with NO outline ring,
 * because it sits as the first field in a vertical stack of TextInputs and
 * must focus like its neighbours — an outline ring here would read as a
 * different KIND of control. Don't "unify" it onto the picker convention.
 * (`lib/dropdown-keyboard.ts`'s `dropdownTriggerKeyProps` doesn't fit either:
 * it models a DISCLOSURE dropdown — no roving active row, so no Home/End,
 * wrapping arrows, or Enter-selects-the-active-option.)
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { styled, XStack, YStack, useTheme } from "tamagui";

import { Text, useFormatters, useTranslations } from "@th/ui";

import { useIsMobile } from "@/hooks/useIsMobile";
import { fmtCurrency } from "@/lib/format";
import {
  TICKET_TYPE_PRESETS,
  TICKET_TYPE_PRESET_CUSTOM_ID,
  buildPresetMetaLine,
  type TicketTypePreset,
  type TicketTypePresetId,
} from "./ticket-type-presets";

/**
 * Mirrors `forms/TextInput.tsx`: radius 0, 2px border, minHeight 36,
 * paddingHorizontal $3, `$surface` fill — and the system's signature focus
 * state, where the border switches to `$accent` with NO outline ring (that
 * file deliberately drops the doubled-up ring).
 */
const PickerTrigger = styled(XStack, {
  tag: "button",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minHeight: 36,
  paddingVertical: 6,
  paddingHorizontal: "$3",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  cursor: "pointer",
  transition: "border-color 150ms ease-out",
  hoverStyle: { borderColor: "$borderColorStrong" },
  focusVisibleStyle: {
    outlineWidth: 0,
    outlineStyle: "none",
    outlineColor: "transparent",
    borderColor: "$accent",
  },
  variants: {
    expanded: {
      true: { borderColor: "$accent" },
    },
  } as const,
});

const ListboxFrame = styled(YStack, {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  marginTop: 4,
  zIndex: 50,
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
});

/**
 * The accent selection marker is a left border that is ALWAYS 3px (transparent
 * when unselected), so selecting a row never nudges its text sideways.
 */
const OptionRow = styled(YStack, {
  gap: 2,
  paddingVertical: 9,
  paddingRight: 10,
  paddingLeft: 9,
  cursor: "pointer",
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColorSoft",
  variants: {
    active: {
      true: { backgroundColor: "$surfaceMuted" },
    },
    selected: {
      true: { borderLeftColor: "$accent", backgroundColor: "$surfaceMuted" },
    },
    last: {
      true: { borderBottomWidth: 0 },
    },
  } as const,
});

export type TicketTypePresetPickerProps = {
  /** Currently selected preset id. `"custom"` is the blank default. */
  value: TicketTypePresetId;
  /**
   * Fires with the whole preset so the caller can fill every field at once.
   * NOT fired when the already-selected row is re-picked (see `commit`).
   */
  onSelect: (preset: TicketTypePreset) => void;
};

/**
 * No `disabled` prop by design: the only read-only path is a sold-out event,
 * and `TicketTypeEditor` handles that by blanket-applying `pointerEvents:
 * "none"` to the whole editor (and never rendering the add form at all). A
 * half-wired disabled affordance here would be dead code.
 */
export function TicketTypePresetPicker({
  value,
  onSelect,
}: TicketTypePresetPickerProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const theme = useTheme();
  // On phones this form lives inside EventEditorSheet, whose scoped CSS grows
  // native `input`/`select`/`textarea` to a 44px touch target. The trigger is a
  // <button>, so that rule misses it — match the neighbours here instead of
  // shipping a 36px control in a 44px form.
  const isMobile = useIsMobile();

  // `useId()` emits colons, which are illegal in CSS selectors and awkward in
  // querySelector-based tests; strip them (same treatment as CountryCombobox).
  const baseId = useId().replace(/:/g, "");
  const labelId = `${baseId}-label`;
  const triggerId = `${baseId}-trigger`;
  const listboxId = `${baseId}-listbox`;
  const helpId = `${baseId}-help`;
  const optionDomId = useCallback(
    (id: TicketTypePresetId) => `${baseId}-option-${id}`,
    [baseId],
  );

  const options = TICKET_TYPE_PRESETS;
  const selectedIndex = Math.max(
    0,
    options.findIndex((preset) => preset.id === value),
  );
  const selected = options[selectedIndex]!;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const triggerRef = useRef<HTMLElement | null>(null);
  const listboxRef = useRef<HTMLElement | null>(null);

  const translate = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      String(t(key, values)),
    [t],
  );
  const formatAmount = useCallback(
    (cents: number) => fmtCurrency(fmt, cents, "usd"),
    [fmt],
  );
  const formatPrice = useCallback(
    (cents: number) =>
      cents === 0 ? String(t("admin.ttFree")) : fmtCurrency(fmt, cents, "usd"),
    [fmt, t],
  );

  const presetLabel = useCallback(
    (preset: TicketTypePreset) => String(t(preset.nameKey)),
    [t],
  );

  const openListbox = useCallback(() => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }, [selectedIndex]);

  const closeListbox = useCallback(() => setOpen(false), []);

  const commit = useCallback(
    (index: number) => {
      const preset = options[index];
      if (!preset) return;
      // Re-picking the CURRENT row is a no-op, exactly as a native <select>
      // fires no change event when you re-choose the selected option. Without
      // this, opening the picker just to check where you started would blow
      // away every edit made since — name, price, capacity, the lot — with no
      // undo. Close and hand focus back instead.
      if (index === selectedIndex) {
        setOpen(false);
        triggerRef.current?.focus?.();
        return;
      }
      onSelect(preset);
      setOpen(false);
      triggerRef.current?.focus?.();
    },
    [onSelect, options, selectedIndex],
  );

  // Outside press closes. Capture phase so it still fires when a child stops
  // propagation; containment is checked against the trigger AND the listbox so
  // clicking either is never treated as "outside".
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (listboxRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  // Keep the roving active row in view inside the scrolling listbox.
  useEffect(() => {
    if (!open) return;
    const active = options[activeIndex];
    if (!active) return;
    // Optional-call: jsdom (and some embedded webviews) don't implement
    // scrollIntoView, and keeping the row visible is a nicety, not a contract.
    document
      .getElementById(optionDomId(active.id))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open, optionDomId, options]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      /**
       * Fully consume a key we act on. `stopPropagation` matters as much as
       * `preventDefault` here: on phones this form lives inside a BottomSheet
       * whose Escape-to-close listener sits on `window`, so an un-stopped
       * Escape would close the ENTIRE add form instead of just the listbox.
       */
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp": {
          consume();
          if (!open) {
            openListbox();
            return;
          }
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setActiveIndex(
            (prev) => (prev + delta + options.length) % options.length,
          );
          return;
        }
        case "Home":
          if (!open) return;
          consume();
          setActiveIndex(0);
          return;
        case "End":
          if (!open) return;
          consume();
          setActiveIndex(options.length - 1);
          return;
        case "Enter":
        case " ":
          // The trigger is a real <button>, so the browser would synthesise a
          // click from Enter/Space and re-toggle what we just handled.
          consume();
          if (open) commit(activeIndex);
          else openListbox();
          return;
        case "Escape":
          // Only swallowed while the listbox is open — a closed picker must
          // let Escape through to dismiss the surrounding sheet/dialog.
          if (!open) return;
          consume();
          closeListbox();
          return;
        case "Tab":
          // Never consumed: Tab has to move focus out of the field.
          if (open) closeListbox();
          return;
        default:
      }
    },
    [activeIndex, closeListbox, commit, open, openListbox, options.length],
  );

  const activeDescendant = open
    ? optionDomId(options[activeIndex]?.id ?? selected.id)
    : undefined;

  return (
    <YStack gap={4} width="100%" maxWidth={340}>
      <Text
        id={labelId}
        tag="span"
        style={{ fontSize: 11, textTransform: "uppercase" }}
        tone="muted"
      >
        {String(t("admin.ttPresetLabel"))}
      </Text>

      <div style={{ position: "relative" }}>
        <PickerTrigger
          id={triggerId}
          ref={(node: unknown) => {
            triggerRef.current = (node as HTMLElement | null) ?? null;
          }}
          expanded={open}
          minHeight={isMobile ? 44 : 36}
          onPress={() => {
            if (open) closeListbox();
            else openListbox();
          }}
          data-testid="ticket-type-preset-trigger"
          // Web-only DOM/ARIA props: Tamagui's RN-derived prop types omit
          // `type`, `onKeyDown` and the wider ARIA set, so they ride the same
          // loose-spread escape hatch the sibling editor primitives use.
          {...({
            type: "button",
            role: "combobox",
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            "aria-controls": listboxId,
            "aria-labelledby": `${labelId} ${triggerId}`,
            // The one line that answers "did I just create a ticket?" — a
            // screen-reader user would otherwise never reach it, since it
            // renders after the control.
            "aria-describedby": helpId,
            "aria-activedescendant": activeDescendant,
            tabIndex: 0,
            onKeyDown: handleKeyDown,
          } as Record<string, unknown>)}
        >
          <Text
            variant="bodySmall"
            tone={
              selected.id === TICKET_TYPE_PRESET_CUSTOM_ID ? "muted" : "default"
            }
            truncate
            textAlign="left"
            style={{ flex: 1, fontSize: isMobile ? 16 : 14 }}
          >
            {presetLabel(selected)}
          </Text>
          <ChevronDown
            size={14}
            color={theme.colorMuted?.val}
            aria-hidden="true"
          />
        </PickerTrigger>

        {open && (
          <ListboxFrame
            id={listboxId}
            ref={(node: unknown) => {
              listboxRef.current = (node as HTMLElement | null) ?? null;
            }}
            style={{ maxHeight: 340, overflowY: "auto" }}
            data-testid="ticket-type-preset-listbox"
            {...({
              role: "listbox",
              "aria-labelledby": labelId,
            } as Record<string, unknown>)}
          >
            {options.map((preset, index) => {
              const isCustom = preset.id === TICKET_TYPE_PRESET_CUSTOM_ID;
              return (
                <OptionRow
                  key={preset.id}
                  id={optionDomId(preset.id)}
                  role="option"
                  aria-selected={index === selectedIndex}
                  active={index === activeIndex}
                  selected={index === selectedIndex}
                  last={index === options.length - 1}
                  onPress={() => commit(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  data-testid={`ticket-type-preset-option-${preset.id}`}
                >
                  <Text
                    variant="bodySmall"
                    weight={isCustom ? "regular" : "semibold"}
                    tone={isCustom ? "muted" : "default"}
                    style={isCustom ? { fontStyle: "italic" } : undefined}
                  >
                    {presetLabel(preset)}
                  </Text>
                  <Text
                    variant="caption"
                    tone="muted"
                    fontFamily="$mono"
                    style={{ fontSize: 12 }}
                  >
                    {buildPresetMetaLine(preset, {
                      translate,
                      formatAmount,
                      formatPrice,
                    })}
                  </Text>
                </OptionRow>
              );
            })}
          </ListboxFrame>
        )}
      </div>

      <Text id={helpId} variant="caption" tone="muted" style={{ fontSize: 11 }}>
        {String(t("admin.ttPresetHelp"))}
      </Text>
    </YStack>
  );
}

TicketTypePresetPicker.displayName = "TicketTypePresetPicker";
