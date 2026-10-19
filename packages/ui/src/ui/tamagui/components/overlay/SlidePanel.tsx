"use client";

/**
 * SlidePanel — a right-anchored slide-in overlay that portals to document.body.
 *
 * Designed for detail views, creation forms, and inspection panels in admin
 * data-tables. Slides in from the right edge with a dimmed backdrop.
 *
 * Handles:
 *  - Click-outside-to-close (backdrop press)
 *  - Escape key to close
 *  - AnimatePresence enter/exit transitions
 *  - Portal to document.body so it's never clipped by parent overflow/stacking
 *
 * Usage:
 *   <SlidePanel open={isOpen} onClose={() => setOpen(false)}>
 *     <SlidePanel.Panel width={480}>
 *       <SlidePanel.Header title="Order Detail" onClose={() => setOpen(false)} />
 *       <SlidePanel.Body>…content…</SlidePanel.Body>
 *       <SlidePanel.Footer>…actions…</SlidePanel.Footer>
 *     </SlidePanel.Panel>
 *   </SlidePanel>
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

const SLIDE_PANEL_Z_INDEX = 10000;

// ─── Styled primitives ──────────────────────────────────────────────────────

const Backdrop = styled(YStack, {
  name: "SlidePanelBackdrop",
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
  name: "SlidePanelContainer",
  position: "absolute" as unknown as undefined,
  top: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "$surface",
  borderLeftWidth: 2,
  borderLeftColor: "$borderColor",
  overflow: "hidden",
  animation: "quick",
  x: 0,
  opacity: 1,
  enterStyle: { x: "100%", opacity: 0 },
  exitStyle: { x: "100%", opacity: 0 },
});

const HeaderContainer = styled(XStack, {
  name: "SlidePanelHeader",
  paddingHorizontal: "$5",
  paddingVertical: "$4",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "$3",
});

const CloseButton = styled(XStack, {
  name: "SlidePanelCloseButton",
  cursor: "pointer",
  padding: "$1.5",
  borderRadius: 0,
  hoverStyle: { backgroundColor: "$surfaceOverlay" },
  pressStyle: { backgroundColor: "$surfaceOverlay", opacity: 0.8 },
});

const BodyContainer = styled(YStack, {
  name: "SlidePanelBody",
  flex: 1,
  padding: "$5",
  gap: "$4",
  overflow: "auto" as unknown as undefined,
});

const FooterContainer = styled(XStack, {
  name: "SlidePanelFooter",
  padding: "$4",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  justifyContent: "flex-end",
  gap: "$3",
});

// ─── Sub-components ──────────────────────────────────────────────────────────

type SlidePanelPanelProps = StackProps & {
  children: ReactNode;
  /** Panel width. Defaults to 480. */
  width?: number | string;
};

function SlidePanelPanel({
  children,
  width = 480,
  ...rest
}: SlidePanelPanelProps) {
  return (
    <PanelContainer
      width={width}
      maxWidth="95vw"
      onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
      {...rest}
    >
      {children}
    </PanelContainer>
  );
}

type SlidePanelHeaderProps = {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children?: ReactNode;
};

function SlidePanelHeader({
  title,
  subtitle,
  onClose,
  children,
}: SlidePanelHeaderProps) {
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
        <CloseButton onPress={onClose} aria-label="Close panel">
          <X size={20} color="var(--color)" />
        </CloseButton>
      )}
    </HeaderContainer>
  );
}

function SlidePanelBody({
  children,
  ...rest
}: StackProps & { children: ReactNode }) {
  return <BodyContainer {...rest}>{children}</BodyContainer>;
}

function SlidePanelFooter({
  children,
  ...rest
}: StackProps & { children: ReactNode }) {
  return <FooterContainer {...rest}>{children}</FooterContainer>;
}

// ─── Main component ─────────────────────────────────────────────────────────

export type SlidePanelProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

function SlidePanelRoot({ open, onClose, children }: SlidePanelProps) {
  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
    <AnimatePresence>
      {open && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: SLIDE_PANEL_Z_INDEX,
          }}
        >
          <Backdrop key="slide-panel-backdrop" onPress={handleBackdropPress} />
          {children}
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ─── Compose ─────────────────────────────────────────────────────────────────

export const SlidePanel = Object.assign(SlidePanelRoot, {
  Panel: SlidePanelPanel,
  Header: SlidePanelHeader,
  Body: SlidePanelBody,
  Footer: SlidePanelFooter,
  displayName: "SlidePanel" as const,
});
