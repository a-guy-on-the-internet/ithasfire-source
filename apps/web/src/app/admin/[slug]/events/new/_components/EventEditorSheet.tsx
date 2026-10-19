"use client";

/**
 * EventEditorSheet — the responsive editor container for the event builder's
 * dense sub-editors (ticket types, lineup, splits, application form).
 *
 * One wrapper so every sub-editor gets a coherent presentation:
 *  - Desktop (>=600px): a center dialog via @th/ui `Modal` with a fixed width.
 *  - Mobile (<600px): a near-full-screen `BottomSheet` (maxHeightVh 92), full
 *    width, with a guaranteed 44px close target and safe-area-aware footer
 *    padding.
 *
 * Both branches share the same shape: header (title + close), a scrolling body,
 * and an optional pinned footer for actions. Escape and backdrop-click close
 * come from the underlying @th/ui primitives (Modal/BottomSheet), so the single
 * `onClose` callback drives every dismissal path.
 *
 * Focus management is owned HERE, not by the primitives — Modal/BottomSheet
 * neither trap nor restore focus. On open we record the previously-focused
 * element and move focus into the panel (the close control). A scoped Tab /
 * Shift+Tab handler cycles focus within the panel so it can't escape to the
 * page behind the backdrop. On close we restore focus to the opener. All of it
 * is SSR-safe (guarded document access, effects only).
 *
 * The mobile header is rendered here (instead of `BottomSheet.Header`) so the
 * close control meets the 44px touch minimum — the shared primitive's built-in
 * X sits around 32px, which is fine for desktop pointers but undersized for
 * touch.
 *
 * Usage:
 *   <EventEditorSheet
 *     open={open}
 *     onClose={() => setOpen(false)}
 *     title="Edit ticket type"
 *     desktopWidth={580}
 *     footer={<Button onPress={save}>Save</Button>}
 *   >
 *     {form body}
 *   </EventEditorSheet>
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { XStack, YStack } from "tamagui";

import { BottomSheet, Modal, Text, useTranslations } from "@th/ui";
import { useIsMobile } from "@/hooks/useIsMobile";

/** Selector for the natively/tab focusable elements inside the panel. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Focus management for the editor dialog. Modal/BottomSheet do not trap, set, or
 * restore focus, so we own it here:
 *  - On open: capture the previously-focused element, then move focus into the
 *    panel (first focusable, i.e. the close control).
 *  - While open: a scoped Tab / Shift+Tab handler wraps focus within the panel.
 *  - On close/unmount: restore focus to the opener.
 *
 * SSR-safe: all DOM access happens inside effects, which never run on the server.
 */
function useDialogFocus<T extends HTMLElement>(
  panelRef: React.RefObject<T | null>,
  open: boolean,
) {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;

    // Defer one frame so the portalled panel is mounted before we query it.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      );
      (focusables[0] ?? panel).focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    };
  }, [open, panelRef]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;

      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, panelRef]);
}

export type EventEditorSheetProps = {
  /** Whether the editor is visible. */
  open: boolean;
  /** Fires on every dismissal path (close button, Escape, backdrop click). */
  onClose: () => void;
  /** Header title. Required so the dialog is always labelled. */
  title: string;
  /** Optional secondary line under the title. */
  subtitle?: string;
  /** Desktop panel width in px (default 580). Ignored on mobile. */
  desktopWidth?: number;
  /** Optional sticky action row (e.g. a Save button). Hidden when absent. */
  footer?: ReactNode;
  /** Accessible label for the close control. Falls back to `common.close`. */
  closeLabel?: string;
  /** Editor body. Lives in the single scroll region. */
  children: ReactNode;
};

/**
 * Bottom padding for the mobile footer. The iOS home-indicator inset is already
 * applied once by `BottomSheet.Panel` (it pads the panel bottom by
 * `env(safe-area-inset-bottom)`), so the footer must NOT add a second inset or
 * notched devices get ~2× the dead space. We keep a flat 16px here and let the
 * panel own the single safe-area layer.
 */
const MOBILE_FOOTER_STYLE = {
  paddingBottom: 16,
} as const;

/**
 * Scoped class + style for the MOBILE sheet body only. The shared @th/ui boxed
 * TextInput renders a 36px-tall / 14px-font native element, which is below the
 * 44px touch minimum AND triggers iOS Safari's focus-zoom (font-size < 16px).
 * Inside the bottom sheet every sub-editor's form inputs hit this, so we bump
 * native form elements by TAG (robust against the editors' nesting depth) to a
 * 44px target and 16px font. font-size:16px on the actual <input> is what
 * suppresses the zoom; min-height:44px gives the touch target. Scoped to the
 * mobile body class so the desktop Modal branch (which never renders this
 * wrapper) is entirely unaffected. The @th/ui TextInput's own border/padding is
 * preserved — min-height only grows the box, font only bumps up.
 */
const MOBILE_BODY_CLASS = "event-editor-sheet-body";
const MOBILE_BODY_INPUT_CSS = `
.${MOBILE_BODY_CLASS} input,
.${MOBILE_BODY_CLASS} textarea,
.${MOBILE_BODY_CLASS} select {
  min-height: 44px;
  font-size: 16px;
}
`;

/** 44px square close control for the mobile header (touch minimum). */
function MobileCloseButton({
  onClose,
  label,
}: {
  onClose: () => void;
  label: string;
}) {
  return (
    <XStack
      onPress={onClose}
      width={44}
      height={44}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      cursor="pointer"
      borderRadius={0}
      hoverStyle={{ backgroundColor: "$surfaceOverlay" }}
      pressStyle={{ backgroundColor: "$surfaceOverlay", opacity: 0.8 }}
      focusStyle={{ backgroundColor: "$surfaceOverlay" }}
      // Web-only ARIA/keyboard props are absent from Tamagui's RN-derived
      // prop types; spread them as a loose object (same escape hatch the
      // EditorCard primitive uses) so the production build typechecks.
      {...({
        role: "button",
        tabIndex: 0,
        "aria-label": label,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClose();
          }
        },
      } as Record<string, unknown>)}
    >
      <X size={22} color="var(--color)" aria-hidden="true" />
    </XStack>
  );
}

/** Mobile header: title/subtitle column + 44px close target. */
function MobileHeader({
  title,
  subtitle,
  onClose,
  closeLabel,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <XStack
      paddingLeft="$5"
      paddingRight="$3"
      paddingVertical="$3"
      borderBottomWidth={2}
      borderBottomColor="$borderColor"
      justifyContent="space-between"
      alignItems="center"
      gap="$3"
    >
      <YStack gap="$1" flex={1} minWidth={0}>
        <Text variant="subtitle" weight="bold">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodySmall" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </YStack>
      <MobileCloseButton onClose={onClose} label={closeLabel} />
    </XStack>
  );
}

/**
 * `display: contents` wrapper that exposes a real DOM node for focus scoping
 * without introducing a layout box (the Panel sub-components aren't forwardRef,
 * so they can't be ref'd directly). Carries the dialog semantics so screen
 * readers announce the labelled, modal region.
 */
function FocusScope({
  panelRef,
  label,
  children,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal
      aria-label={label}
      tabIndex={-1}
      style={{ display: "contents" }}
    >
      {children}
    </div>
  );
}

export function EventEditorSheet({
  open,
  onClose,
  title,
  subtitle,
  desktopWidth = 580,
  footer,
  closeLabel,
  children,
}: EventEditorSheetProps) {
  const isMobile = useIsMobile();
  const t = useTranslations();
  const resolvedCloseLabel = closeLabel ?? (t("common.close") as string);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useDialogFocus(panelRef, open);

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose}>
        <BottomSheet.Panel maxHeightVh={92}>
          {/* `display: contents` host: gives us a real DOM node to scope focus
              to without adding a layout box. The Panel itself isn't a
              forwardRef component, so we can't ref it directly. */}
          <FocusScope panelRef={panelRef} label={title}>
            <MobileHeader
              title={title}
              subtitle={subtitle}
              onClose={onClose}
              closeLabel={resolvedCloseLabel}
            />
            <BottomSheet.Body>
              {/* Scoped style: enlarge native form inputs to 44px / 16px so the
                  dense sub-editors meet touch + no-zoom targets without
                  modifying the shared @th/ui TextInput. Mobile branch only. */}
              <style>{MOBILE_BODY_INPUT_CSS}</style>
              <div className={MOBILE_BODY_CLASS}>{children}</div>
            </BottomSheet.Body>
            {footer ? (
              <BottomSheet.Footer style={MOBILE_FOOTER_STYLE}>
                {footer}
              </BottomSheet.Footer>
            ) : null}
          </FocusScope>
        </BottomSheet.Panel>
      </BottomSheet>
    );
  }

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={desktopWidth}>
        <FocusScope panelRef={panelRef} label={title}>
          <Modal.Header title={title} subtitle={subtitle} onClose={onClose} />
          <Modal.Body>{children}</Modal.Body>
          {footer ? <Modal.Footer>{footer}</Modal.Footer> : null}
        </FocusScope>
      </Modal.Panel>
    </Modal>
  );
}

EventEditorSheet.displayName = "EventEditorSheet";
