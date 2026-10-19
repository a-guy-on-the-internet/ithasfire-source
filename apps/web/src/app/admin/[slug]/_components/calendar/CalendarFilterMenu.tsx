"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Popover, Text } from "@th/ui";

import { Mono } from "./Mono";
import { CAL_BORDER, CAL_BORDER_SOFT, CAL_SURFACE } from "./status-colors";

// ─────────────────────────────────────────────────────────────────────────────
// The filter row's collapsing controls (event-calendar-redesign, phase 2).
//
// `MenuButton` is the wrong primitive here on two counts: it closes on every
// selection (a six-owner narrowing would cost six open/close cycles) and its
// items are one-shot commands, not toggles. This is the same trigger grammar
// — a 2px bordered button opening an anchored panel — with a panel that STAYS
// OPEN while the reader toggles, and toggles that are real `aria-pressed`
// buttons, exactly like the chips they replace. The panel body is arbitrary
// (the collapsed "Filters" panel carries the series <select> too), so it is a
// labelled group rather than a `role="menu"`, which may only contain menu
// items.
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarFilterMenuProps = {
  /** Trigger label — already resolved ("Filters · 2", "3 owners"). */
  label: string;
  /** Accessible name of the panel. */
  panelLabel: string;
  /** Trigger height: 38px in the desktop filter row, 44px at touch width. */
  height?: number;
  /** The control is narrowing something — same accent frame as a pressed chip. */
  active?: boolean;
  testId: string;
  children: ReactNode;
};

/** Caret drawn in CSS — the engine's raw-DOM paths carry no icon imports. */
function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 0,
        height: 0,
        flexShrink: 0,
        marginLeft: 2,
        borderLeft: "4px solid transparent",
        borderRight: "4px solid transparent",
        borderTop: `5px solid currentColor`,
        transform: open ? "rotate(180deg)" : undefined,
        transition: "transform 150ms ease-out",
      }}
    />
  );
}

export function CalendarFilterMenu({
  label,
  panelLabel,
  height = 38,
  active = false,
  testId,
  children,
}: CalendarFilterMenuProps) {
  const [open, setOpen] = useState(false);
  // The ref wraps the whole Popover, not the trigger: Floating UI's `Popover`
  // CLONES its anchor with its own `ref`, so a ref placed on the trigger is
  // silently replaced and the outside-click containment check never matches
  // it. `MenuButton` keeps a root ref for exactly this reason.
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) rootRef.current?.querySelector("button")?.focus();
  }, []);

  // Outside click and Escape, on the document: the panel is PORTALED out of
  // the trigger's subtree by Floating UI, so a containment check has to name
  // both boxes or every click inside the panel reads as an outside click.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target)) return;
      if (panelRef.current?.contains(event.target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const trigger = (
    <button
      type="button"
      className="th-cal-btn th-cal-filter"
      data-testid={testId}
      data-active={active ? "true" : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={() => setOpen((v) => !v)}
      style={{ minHeight: height }}
    >
      <Text
        variant="span"
        fontSize={11}
        lineHeight={14}
        letterSpacing={1}
        textTransform="uppercase"
        weight="bold"
        tone="inherit"
      >
        {label}
      </Text>
      <Caret open={open} />
    </button>
  );

  return (
    <span ref={rootRef} style={{ display: "inline-flex", minWidth: 0 }}>
      <Popover
        open={open}
        anchor={trigger}
        placement="bottom-start"
        matchAnchorWidth={false}
        contentProps={{ padding: 0, minWidth: 240, maxWidth: 320, borderWidth: 2 }}
      >
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label={panelLabel}
          data-testid={`${testId}-panel`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: 12,
            background: CAL_SURFACE,
            maxWidth: "100%",
          }}
        >
          {children}
        </div>
      </Popover>
    </span>
  );
}

/** A labelled block inside a filter panel — mono kicker over its controls. */
export function CalendarFilterGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <Mono size="2xs" upper tone="muted">
        {label}
      </Mono>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Hairline between panel groups — the panel is one object, not a stack. */
export function CalendarFilterDivider() {
  return (
    <span
      aria-hidden
      style={{ height: 1, alignSelf: "stretch", background: CAL_BORDER_SOFT }}
    />
  );
}

/**
 * A checkbox row inside a panel. Same `aria-pressed` grammar (and the same
 * test ids) as the chips it stands in for, so nothing about the contract
 * changes when the row collapses — only where the control lives.
 */
export function CalendarFilterCheck({
  label,
  checked,
  onToggle,
  swatch,
  testId,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  swatch?: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="th-cal-btn th-cal-filter"
      aria-pressed={checked}
      data-testid={testId}
      onClick={onToggle}
      style={{ minHeight: 44, width: "100%", gap: 8 }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          flexShrink: 0,
          border: `2px solid ${CAL_BORDER}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && (
          <span style={{ width: 6, height: 6, background: CAL_BORDER }} />
        )}
      </span>
      {swatch}
      <Text
        variant="span"
        fontSize={11}
        lineHeight={14}
        letterSpacing={1}
        textTransform="uppercase"
        weight="bold"
        tone="inherit"
        truncate
      >
        {label}
      </Text>
    </button>
  );
}
