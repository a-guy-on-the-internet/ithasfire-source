"use client";

/**
 * BottomSheet — a bottom-anchored slide-up overlay that portals to document.body.
 *
 * Designed for detail views and secondary content that emerges from the
 * bottom of the viewport (e.g., volunteer info, filters). Slides up from
 * the bottom edge with a dimmed backdrop.
 *
 * Handles:
 *  - Click-outside-to-close (backdrop press)
 *  - Escape key to close
 *  - AnimatePresence enter/exit transitions
 *  - Portal to document.body so it's never clipped by parent overflow/stacking
 *
 * Usage:
 *   <BottomSheet open={isOpen} onClose={() => setOpen(false)}>
 *     <BottomSheet.Panel>
 *       <BottomSheet.Header title="Volunteer" onClose={() => setOpen(false)} />
 *       <BottomSheet.Body>…content…</BottomSheet.Body>
 *     </BottomSheet.Panel>
 *   </BottomSheet>
 */

import { useCallback, useEffect } from "react";
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

const BOTTOM_SHEET_Z_INDEX = 10000;

// ─── Styled primitives ──────────────────────────────────────────────────────

const Backdrop = styled(YStack, {
  name: "BottomSheetBackdrop",
  position: "absolute" as unknown as undefined,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "$overlay",
  animation: "quick",
  opacity: 1,
  enterStyle: { opacity: 0 },
  exitStyle: { opacity: 0 },
});

const PanelContainer = styled(YStack, {
  name: "BottomSheetPanel",
  position: "absolute" as unknown as undefined,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "$surface",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  overflow: "hidden",
  animation: "quick",
  y: 0,
  opacity: 1,
  enterStyle: { y: "100%", opacity: 0 },
  exitStyle: { y: "100%", opacity: 0 },
});

const HeaderContainer = styled(XStack, {
  name: "BottomSheetHeader",
  paddingHorizontal: "$5",
  paddingVertical: "$4",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "$3",
});

const CloseButton = styled(XStack, {
  name: "BottomSheetCloseButton",
  cursor: "pointer",
  padding: "$1.5",
  borderRadius: 0,
  hoverStyle: { backgroundColor: "$surfaceOverlay" },
  pressStyle: { backgroundColor: "$surfaceOverlay", opacity: 0.8 },
});

const BodyContainer = styled(YStack, {
  name: "BottomSheetBody",
  flex: 1,
  padding: "$5",
  gap: "$4",
  overflow: "auto" as unknown as undefined,
});

const FooterContainer = styled(XStack, {
  name: "BottomSheetFooter",
  padding: "$4",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  justifyContent: "flex-end",
  gap: "$3",
});

// ─── Sub-components ──────────────────────────────────────────────────────────

type BottomSheetPanelProps = StackProps & {
  children: ReactNode;
  /** Max height as vh percentage. Defaults to 70. */
  maxHeightVh?: number;
};

function BottomSheetPanel({
  children,
  maxHeightVh = 70,
  style,
  ...rest
}: BottomSheetPanelProps) {
  return (
    <PanelContainer
      maxHeight={`${maxHeightVh}vh`}
      onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
      {...rest}
      // iOS home-indicator safe area: pad the panel bottom so the footer
      // (or the body's last content when there is no footer) clears the
      // indicator. env() resolves to 0px on devices without an inset, so
      // this is a no-op everywhere else. Plain `style` because Tamagui
      // tokens can't express env() — mirrors MobileBottomNav/MobileCTABar.
      // Merged with any consumer-provided `style` so passing one doesn't
      // silently drop the safe-area padding (consumer paddingBottom wins
      // only if explicitly set).
      style={{
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        ...(style as object),
      }}
    >
      {children}
    </PanelContainer>
  );
}

type BottomSheetHeaderProps = {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children?: ReactNode;
};

function BottomSheetHeader({
  title,
  subtitle,
  onClose,
  children,
}: BottomSheetHeaderProps) {
  return (
    <HeaderContainer>
      <YStack gap="$1" flex={1}>
        <Text variant="subtitle" weight="bold">
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
        <CloseButton onPress={onClose} aria-label="Close sheet">
          <X size={20} color="var(--color)" />
        </CloseButton>
      )}
    </HeaderContainer>
  );
}

function BottomSheetBody({
  children,
  ...rest
}: StackProps & { children: ReactNode }) {
  return <BodyContainer {...rest}>{children}</BodyContainer>;
}

function BottomSheetFooter({
  children,
  ...rest
}: StackProps & { children: ReactNode }) {
  return <FooterContainer {...rest}>{children}</FooterContainer>;
}

// ─── Main component ─────────────────────────────────────────────────────────

export type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

function BottomSheetRoot({ open, onClose, children }: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

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
    <AnimatePresence>
      {open && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: BOTTOM_SHEET_Z_INDEX,
          }}
        >
          <Backdrop key="bottom-sheet-backdrop" onPress={handleBackdropPress} />
          {children}
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ─── Compose ─────────────────────────────────────────────────────────────────

export const BottomSheet = Object.assign(BottomSheetRoot, {
  Panel: BottomSheetPanel,
  Header: BottomSheetHeader,
  Body: BottomSheetBody,
  Footer: BottomSheetFooter,
  displayName: "BottomSheet" as const,
});
