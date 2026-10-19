"use client";

/**
 * Modal — a full-viewport centered overlay that portals to document.body.
 *
 * Renders a semi-transparent backdrop over the entire page with centered content.
 * Handles:
 *  - Click-outside-to-close (backdrop press)
 *  - Escape key to close (topmost dialog only)
 *  - Focus containment: Tab / Shift+Tab cycle inside the topmost dialog
 *  - Background inertness: everything outside the topmost dialog is `inert`
 *    + `aria-hidden`, so `aria-modal="true"` is a promise the DOM keeps
 *  - AnimatePresence enter/exit transitions
 *  - Portal to document.body so it's never clipped by parent overflow/stacking
 *
 * Usage:
 *   <Modal open={isOpen} onClose={() => setOpen(false)}>
 *     <Modal.Panel width={480}>
 *       <Modal.Header title="My Title" onClose={() => setOpen(false)} />
 *       <Modal.Body>…content…</Modal.Body>
 *       <Modal.Footer>…actions…</Modal.Footer>
 *     </Modal.Panel>
 *   </Modal>
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  AnimatePresence,
  XStack,
  YStack,
  styled,
  type StackProps,
} from "tamagui";

import { Text } from "../typography/Text";

// ─── Constants ───────────────────────────────────────────────────────────────

const MODAL_Z_INDEX = 10000;

// Web-only a11y DOM props (role, aria-*, tabIndex, id) that Tamagui's Stack /
// Text surfaces don't type. Cast to `object` so they pass straight through to
// the DOM element — mirrors the pattern used across the app (e.g. the claim
// wizard's radio rows).
const webA11y = (props: Record<string, unknown>): object => props;

// ─── Dialog layer stack (web only) ───────────────────────────────────────────
//
// `role="dialog" aria-modal="true"` is a CLAIM. Without matching DOM state the
// page behind the panel stays tabbable and stays in the accessibility tree, so
// a screen-reader user can browse straight past the dialog and a Tab walks out
// of it. These helpers make the claim true:
//
//  - a module-level STACK of open dialogs (nesting is real here — ConfirmDialog
//    routinely opens inside another Modal), so "topmost" is a fact, not an
//    assumption that there is only ever one dialog;
//  - `inert` + `aria-hidden="true"` on every direct child of <body> EXCEPT the
//    topmost dialog's own portal wrapper. A nested dialog therefore inerts its
//    PARENT panel too, which is exactly what we want;
//  - ownership encoded in the DOM via a marker attribute, so teardown can never
//    depend on in-memory bookkeeping surviving (a lost Set would brick the page
//    behind a permanently-inert body).
//
// Everything here touches the DOM, so every entry point is guarded for the
// React Native bundle the way the rest of this file already is
// (`typeof document === "undefined"`).

/** Marks an element whose `inert` was applied BY US, so release is exact. */
const INERT_MARK = "data-th-modal-inert";
/** Preserves an author-set `aria-hidden` so release restores it verbatim. */
const ARIA_PREV_MARK = "data-th-modal-aria-prev";

/**
 * Layers that must stay live even while a dialog is open. Toasts portal to
 * <body> and stack above the modal on purpose; inerting them would silently
 * kill their action buttons and their announcements. `data-th-overlay-exempt`
 * is the escape hatch for any future body-level layer.
 */
const EXEMPT_SELECTOR = "[data-sonner-toaster],[data-th-overlay-exempt]";
/** Shared with AlertsSidebar's focus trap, which applies the same rule. */
export const OVERLAY_EXEMPT_SELECTOR = EXEMPT_SELECTOR;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "summary",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(",");

type DialogLayer = { el: HTMLElement };

const dialogLayers: DialogLayer[] = [];

function isTopLayer(layer: DialogLayer | null): boolean {
  return layer !== null && dialogLayers[dialogLayers.length - 1] === layer;
}

/**
 * jsdom has no layout engine: every element reports zero client rects, so a
 * strict visibility filter would report "no focusable children" for every
 * dialog under test. Probe once and only trust a positive result.
 */
let documentHasLayout = false;
function hasLayout(): boolean {
  if (documentHasLayout) return true;
  if (typeof document === "undefined" || !document.body) return false;
  documentHasLayout = document.body.getClientRects().length > 0;
  return documentHasLayout;
}

function isTabbable(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return false;
  if ((el as HTMLInputElement).type === "hidden") return false;
  if (el.tabIndex < 0) return false;
  if (el.closest("[inert],[hidden]")) return false;
  if (hasLayout() && el.getClientRects().length === 0) return false;
  return true;
}

/**
 * Tabbable descendants of `root`, in DOM order. Recomputed on every Tab press
 * so content added, removed or disabled while the dialog is open is always
 * reflected. (Positive `tabindex` values would reorder the real tab sequence;
 * this codebase does not use them, and the boundary-only trap below leaves the
 * in-between steps to the browser anyway.)
 */
export function getTabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isTabbable);
}

function isExemptLayer(el: HTMLElement): boolean {
  if (el.matches(EXEMPT_SELECTOR)) return true;
  if (el.querySelector(EXEMPT_SELECTOR)) return true;
  // Anything deliberately stacked ABOVE the modal (Tooltip's portal at 99999,
  // sonner's toaster) is an overlay layer, not background — leave it live.
  if (typeof window === "undefined") return false;
  const z = Number.parseInt(window.getComputedStyle(el).zIndex, 10);
  return Number.isFinite(z) && z > MODAL_Z_INDEX;
}

function applyInert(el: HTMLElement): void {
  if (el.hasAttribute(INERT_MARK)) return;
  // Author-owned inertness: never touch it, and never release it later.
  if (el.hasAttribute("inert")) return;
  const prevAria = el.getAttribute("aria-hidden");
  if (prevAria !== null) el.setAttribute(ARIA_PREV_MARK, prevAria);
  el.setAttribute(INERT_MARK, "");
  el.setAttribute("inert", "");
  el.setAttribute("aria-hidden", "true");
}

function releaseInert(el: HTMLElement): void {
  el.removeAttribute("inert");
  if (el.hasAttribute(ARIA_PREV_MARK)) {
    el.setAttribute("aria-hidden", el.getAttribute(ARIA_PREV_MARK) ?? "");
    el.removeAttribute(ARIA_PREV_MARK);
  } else {
    el.removeAttribute("aria-hidden");
  }
  el.removeAttribute(INERT_MARK);
}

/**
 * Reconcile background inertness against the current stack.
 *
 * RELEASE RUNS FIRST and is driven purely by the DOM marker, so a teardown can
 * never be blocked by a failure in the apply pass. With an empty stack this is
 * a total release: closing the last dialog always fully restores the page.
 */
function syncInert(): void {
  if (typeof document === "undefined" || !document.body) return;

  // Only an ATTACHED body child can be the live layer. If the topmost entry has
  // been detached (an AnimatePresence remount, a torn-down portal) we must NOT
  // fall back to inerting everything — that would inert the one dialog the user
  // can see and brick the page. Release everything instead and let the next
  // push reconcile.
  const topLayer = dialogLayers[dialogLayers.length - 1] ?? null;
  const top =
    topLayer && topLayer.el.parentElement === document.body
      ? topLayer.el
      : null;

  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(`[${INERT_MARK}]`),
  )) {
    const stillBackground =
      top !== null &&
      el !== top &&
      el.parentElement === document.body &&
      !isExemptLayer(el);
    if (!stillBackground) releaseInert(el);
  }

  if (!top) return;

  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === top) continue;
    if (isExemptLayer(child)) continue;
    applyInert(child);
  }
}

function pushLayer(layer: DialogLayer): void {
  dialogLayers.push(layer);
  syncInert();
}

function removeLayer(layer: DialogLayer): void {
  const i = dialogLayers.indexOf(layer);
  if (i >= 0) dialogLayers.splice(i, 1);
  syncInert();
}

// Module (re)load — Fast Refresh swaps this module out while dialogs may be
// open, orphaning the previous instance's stack. Any marker left behind would
// keep the page inert with nothing left alive to release it, so sweep on load.
if (typeof document !== "undefined" && document.body) {
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(`[${INERT_MARK}]`),
  )) {
    releaseInert(el);
  }
}

// ─── Dialog a11y context ─────────────────────────────────────────────────────

/**
 * Shares the generated title id + a title-presence flag between Modal.Panel
 * (which wires `aria-labelledby`) and Modal.Header (which owns the title
 * element). Internal-only: adds proper dialog semantics without changing any
 * consumer-facing API. When a Modal renders no Header, `hasTitle` stays false
 * and Panel omits `aria-labelledby` (never a dangling reference).
 */
type ModalA11y = {
  titleId: string;
  hasTitle: boolean;
  registerTitle: (present: boolean) => void;
};

const ModalA11yContext = createContext<ModalA11y | null>(null);

// ─── Styled primitives ──────────────────────────────────────────────────────

const Backdrop = styled(YStack, {
  name: "ModalBackdrop",
  position: "absolute" as unknown as undefined,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "$overlay",
  justifyContent: "center",
  alignItems: "center",
  animation: "quick",
  opacity: 1,
  enterStyle: { opacity: 0 },
  exitStyle: { opacity: 0 },
});

const PanelContainer = styled(YStack, {
  name: "ModalPanel",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  overflow: "hidden",
  maxWidth: "95vw",
  maxHeight: "90vh",
  // The panel carries tabIndex={-1} and is focused programmatically so the
  // dialog is seated for screen readers. Without this, Chrome paints its
  // default focus ring around EVERY dialog panel in the app. Scoped to the
  // panel element itself — focusable CHILDREN keep their focus rings.
  outlineWidth: 0,
  outlineStyle: "none",
  animation: "quick",
  y: 0,
  opacity: 1,
  scale: 1,
  enterStyle: { y: 40, opacity: 0, scale: 0.97 },
  exitStyle: { y: 40, opacity: 0, scale: 0.97 },
});

const HeaderContainer = styled(XStack, {
  name: "ModalHeader",
  padding: "$5",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  justifyContent: "space-between",
  alignItems: "center",
});

const CloseButton = styled(XStack, {
  name: "ModalCloseButton",
  cursor: "pointer",
  padding: "$1.5",
  borderRadius: 0,
  hoverStyle: { backgroundColor: "$surfaceOverlay" },
  pressStyle: { backgroundColor: "$surfaceOverlay", opacity: 0.8 },
  // This is a real control, so it takes a real tab stop (see ModalHeader) and
  // needs a visible ring when reached by keyboard.
  focusVisibleStyle: {
    outlineColor: "$outlineColor",
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
});

const BodyContainer = styled(YStack, {
  name: "ModalBody",
  flex: 1,
  padding: "$5",
  gap: "$4",
  overflow: "auto" as unknown as undefined,
});

const FooterContainer = styled(XStack, {
  name: "ModalFooter",
  padding: "$4",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  justifyContent: "flex-end",
  gap: "$3",
  // Long localized action labels must wrap instead of overflowing the
  // panel on narrow (320px) viewports.
  flexWrap: "wrap",
});

// ─── Sub-components ──────────────────────────────────────────────────────────

type ModalPanelProps = StackProps & {
  children: ReactNode;
  width?: number | string;
};

function ModalPanel({ children, width = 480, ...rest }: ModalPanelProps) {
  const a11y = useContext(ModalA11yContext);
  const panelRef = useRef<HTMLDivElement>(null);

  // Move initial focus into the dialog on open — UNLESS a consumer already
  // placed focus inside it (e.g. an autofocused input or a step heading, like
  // ClaimVenueWizard). This "don't steal existing focus" guard keeps the
  // behaviour additive so it never regresses other Modal usages.
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || !node.contains(active)) node.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <PanelContainer
      ref={panelRef}
      width={width}
      onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
      {...webA11y({
        role: "dialog",
        "aria-modal": "true",
        tabIndex: -1,
        ...(a11y?.hasTitle ? { "aria-labelledby": a11y.titleId } : {}),
      })}
      {...rest}
    >
      {children}
    </PanelContainer>
  );
}

type ModalHeaderProps = {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children?: ReactNode;
};

function ModalHeader({ title, subtitle, onClose, children }: ModalHeaderProps) {
  const a11y = useContext(ModalA11yContext);

  // Register the title so Panel can point `aria-labelledby` at it, and clear
  // the flag if this header unmounts.
  useEffect(() => {
    a11y?.registerTitle(true);
    return () => a11y?.registerTitle(false);
  }, [a11y]);

  return (
    <HeaderContainer>
      <YStack gap="$1" flex={1}>
        <Text
          variant="subtitle"
          weight="bold"
          {...(a11y ? webA11y({ id: a11y.titleId }) : {})}
        >
          {title}
        </Text>
        {subtitle && (
          <Text variant="bodySmall" tone="muted">
            {subtitle}
          </Text>
        )}
        {children}
      </YStack>
      {onClose && (
        // CloseButton is a styled XStack, i.e. a plain <div> on web — it had no
        // role and no tab stop, so the dialog's only dismiss affordance was
        // unreachable by keyboard. Give it button semantics, a tab stop, and
        // Enter/Space activation.
        <CloseButton
          onPress={onClose}
          aria-label="Close"
          {...webA11y({
            role: "button",
            tabIndex: 0,
            onKeyDown: (e: {
              key: string;
              preventDefault: () => void;
            }): void => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClose();
              }
            },
          })}
        >
          <X size={20} color="var(--color)" />
        </CloseButton>
      )}
    </HeaderContainer>
  );
}

function ModalBody({
  children,
  ...rest
}: StackProps & { children: ReactNode }) {
  return <BodyContainer {...rest}>{children}</BodyContainer>;
}

function ModalFooter({
  children,
  ...rest
}: StackProps & { children: ReactNode }) {
  return <FooterContainer {...rest}>{children}</FooterContainer>;
}

// ─── Main component ─────────────────────────────────────────────────────────

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

function ModalRoot({ open, onClose, children }: ModalProps) {
  // Stable id used to tie Panel's aria-labelledby to Header's title, plus a
  // counter so any number of headers can register/unregister safely.
  const titleId = useId();
  const [titleCount, setTitleCount] = useState(0);
  const registerTitle = useCallback((present: boolean) => {
    setTitleCount((c) => c + (present ? 1 : -1));
  }, []);

  // The portal wrapper — the one <body> child that stays live while this
  // dialog is topmost, and the containment boundary for the focus trap.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<DialogLayer | null>(null);

  // Return focus to whatever opened the dialog (the trigger) when it closes.
  // Captured on open — before Panel's rAF moves focus inward — so activeElement
  // is still the trigger at capture time.
  //
  // ORDER MATTERS: this effect is declared BEFORE the layer effect below.
  // Marking the background inert blurs whatever was focused there, so capturing
  // afterwards would read <body> instead of the trigger and silently break
  // focus restore (which RowActionMenu depends on).
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    } else if (openerRef.current) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (typeof opener.focus === "function") opener.focus();
    }
  }, [open]);

  // Register this dialog on the stack and reconcile background inertness.
  // Cleanup runs on close AND on unmount-while-open, so an unmounting route can
  // never leave the page inert.
  useEffect(() => {
    if (!open) return;
    const el = wrapperRef.current;
    if (!el) return;
    const layer: DialogLayer = { el };
    layerRef.current = layer;
    pushLayer(layer);
    return () => {
      layerRef.current = null;
      removeLayer(layer);
    };
  }, [open]);

  // Focus containment for the topmost dialog.
  //
  // Boundary-only trapping: we only preventDefault when the next Tab would
  // LEAVE the dialog. Intermediate steps stay native, which preserves the
  // browser's real tab order (radio groups, contenteditable) and keeps Tab
  // able to walk INTO an <iframe> (embed previews, Stripe elements).
  useEffect(() => {
    if (!open) return;

    const focusFallback = (wrapper: HTMLElement) => {
      const panel = wrapper.querySelector<HTMLElement>('[role="dialog"]');
      (panel ?? wrapper).focus();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const layer = layerRef.current;
      if (!layer || !isTopLayer(layer)) return;

      const wrapper = layer.el;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && wrapper.contains(active);
      const inBackground = !!active?.closest?.(`[${INERT_MARK}]`);
      // Focus sits in some other LIVE layer (a toast, a portalled tooltip) —
      // not ours to reclaim, and fighting it would be worse than leaving it.
      if (!inside && !inBackground) return;

      const items = getTabbables(wrapper);
      if (items.length === 0) {
        // Nothing to cycle through: pin focus on the panel so Tab can never
        // walk out of an empty dialog.
        e.preventDefault();
        focusFallback(wrapper);
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];

      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      // Focus is inside an iframe: activeElement is the frame element itself
      // and the real cursor is in its document. Let the browser walk it.
      if (active?.tagName === "IFRAME") return;

      const index = active ? items.indexOf(active) : -1;
      if (index === -1) {
        // On the panel container itself (tabIndex -1) or another non-tabbable
        // node — jump to the appropriate edge deterministically.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Belt-and-braces for engines without native `inert`: if focus lands in the
    // subtree WE inerted, pull it back. Deliberately scoped to our own marker so
    // it never fights a legitimately live overlay outside the dialog.
    const handleFocusIn = (e: FocusEvent) => {
      const layer = layerRef.current;
      if (!layer || !isTopLayer(layer)) return;
      const target = e.target as HTMLElement | null;
      if (!target || layer.el.contains(target)) return;
      if (!target.closest?.(`[${INERT_MARK}]`)) return;
      const items = getTabbables(layer.el);
      if (items.length > 0) items[0].focus();
      else focusFallback(layer.el);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
    };
  }, [open]);

  // Escape key handler. Kept on `window` in the BUBBLE phase (not document
  // capture) so inner controls that consume Escape for their own dismissal —
  // an autocomplete closing its suggestion list — still get first refusal.
  //
  // Gated on "am I topmost?": previously EVERY open modal ran this, and because
  // the outer modal registered its listener first it won the race and
  // stopImmediatePropagation killed the inner one. Escape on a nested
  // ConfirmDialog closed the PARENT.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopLayer(layerRef.current)) return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const handleBackdropPress = useCallback(() => {
    onClose();
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <ModalA11yContext.Provider
      value={{ titleId, hasTitle: titleCount > 0, registerTitle }}
    >
      <AnimatePresence>
        {open && (
          <div
            ref={wrapperRef}
            // Last-resort focus target when a dialog renders no focusable
            // content at all. tabIndex -1 keeps it out of the tab sequence.
            tabIndex={-1}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: MODAL_Z_INDEX,
              outline: "none",
            }}
          >
            <Backdrop key="modal-backdrop" onPress={handleBackdropPress}>
              {children}
            </Backdrop>
          </div>
        )}
      </AnimatePresence>
    </ModalA11yContext.Provider>,
    document.body,
  );
}

// ─── Compose ─────────────────────────────────────────────────────────────────

export const Modal = Object.assign(ModalRoot, {
  Panel: ModalPanel,
  Header: ModalHeader,
  Body: ModalBody,
  Footer: ModalFooter,
  displayName: "Modal" as const,
});
