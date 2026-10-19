"use client";

import {
  MouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import { YStack, styled } from "tamagui";
import {
  Button,
  CardSurface,
  NextLinkAnchor,
  OverlayMount,
  Text,
  useTranslations,
} from "@th/ui";

const FloatingCard = styled(YStack, {
  name: "AuthOverlayFloatingCard",
  width: "100%",
  maxWidth: 480,
  position: "relative",
});

const OverlayBackdrop = styled(YStack, {
  name: "AuthOverlayBackdrop",
  // Use fixed positioning so the backdrop covers the entire viewport
  // regardless of scroll position or parent container constraints.
  // @ts-expect-error -- Tamagui maps position to RN but "fixed" works on web
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  // A real scrim, restored 2026-09-07.
  //
  // This was transparent, argued from contrast: an ink panel separates from
  // the cream page at 14.89:1, so a dim looked redundant. That reasoning was
  // measuring the wrong thing. A scrim's job is not separation, it is
  // MODALITY — `role="dialog" aria-modal` tells assistive tech the page
  // behind is inert, and the scrim is how that same fact is told to everyone
  // else. Without one the card reads as floating debris over a fully live
  // page: seen on the homepage, the hero headline runs out from behind the
  // panel on both sides and the whole background stays at full contrast,
  // competing with the one thing the reader is meant to be doing.
  //
  // Ink at 55% rather than black: the page's own structural colour dimming
  // its own page, so the cream goes to a deep warm rather than to grey.
  backgroundColor: "color-mix(in srgb, var(--color, #211C16) 55%, transparent)",
  justifyContent: "center",
  alignItems: "center",
  paddingHorizontal: "$4",
  paddingVertical: "$6",
  zIndex: 9999,
  overflow: "scroll",
});

const CardContainer = styled(YStack, {
  name: "AuthOverlayCardContainer",
  width: "100%",
  maxWidth: 480,
  alignItems: "stretch",
  position: "relative",
});

/**
 * The dismiss affordance, printed ON the card rather than in it.
 *
 * It is absolutely positioned over the panel's top-right, which puts it
 * OUTSIDE `[data-auth-card]` in the DOM while sitting on top of it on screen —
 * so it would have kept painting a `ghost` button's ink label on the ink card
 * and vanished. `data-auth-ink` opts it into the same token rebind the panel
 * uses (globals.css), which gives it a paper glyph at rest, the 12%-paper
 * hover chip with an ink glyph, and the amber ring.
 *
 * `variant="ghost"` and not `ghostInverted`: `ghostInverted` inverts back to
 * `$color` on hover, which under the rebind is paper on a paper fill.
 */
const CloseButton = styled(Button, {
  name: "AuthOverlayCloseButton",
  position: "absolute",
  top: "$3",
  right: "$3",
  zIndex: 2,
  borderRadius: 0,
});

export type AuthOverlayShellProps = {
  id: string;
  backdropTestId: string;
  layerTestId?: string;
  closeLabel?: string;
  onRequestCloseAction?: () => void;
  /**
   * Callback that receives a function to trigger animated close.
   * Call this function to play the exit animation then close.
   */
  onAnimatedCloseRef?: (triggerClose: () => void) => void;
  /**
   * How the user can dismiss the overlay via backdrop click.
   * - "before-interaction": allowed until the user focuses/clicks inside the dialog.
   * - "always": allowed even after interacting.
   * - "never": disabled.
   */
  backdropDismissBehavior?: "before-interaction" | "always" | "never";
  /**
   * How the user can dismiss the overlay via the Escape key.
   * - "before-interaction": allowed until the user focuses/clicks inside the dialog.
   * - "always": allowed even after interacting.
   * - "never": disabled.
   */
  escapeDismissBehavior?: "before-interaction" | "always" | "never";
  /** Prevent closing via Escape/backdrop while true (e.g., submitting). */
  isDismissDisabled?: boolean;
  /** Milliseconds after mount during which backdrop/Escape dismissal is ignored. */
  dismissGuardMs?: number;
  /** Animation duration in ms (default 220ms). */
  animationDurationMs?: number;
  children: ReactNode;
};

export const AuthOverlayShell = ({
  id,
  backdropTestId,
  layerTestId,
  closeLabel,
  onRequestCloseAction,
  onAnimatedCloseRef,
  backdropDismissBehavior = "before-interaction",
  escapeDismissBehavior = "before-interaction",
  isDismissDisabled = false,
  dismissGuardMs = 250,
  animationDurationMs = 220,
  children,
}: AuthOverlayShellProps) => {
  const t = useTranslations();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedElement = useRef<Element | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const exitCallbackRef = useRef<(() => void) | null>(null);

  const [hasInteracted, setHasInteracted] = useState(false);
  const [guardElapsed, setGuardElapsed] = useState(dismissGuardMs <= 0);

  // Flip guardElapsed after the dismiss guard window expires.
  useEffect(() => {
    if (guardElapsed) return;
    const timer = window.setTimeout(() => {
      setGuardElapsed(true);
    }, dismissGuardMs);
    return () => window.clearTimeout(timer);
  }, [dismissGuardMs, guardElapsed]);

  const triggerClose = useCallback(() => {
    if (!onRequestCloseAction || isExiting) {
      return;
    }
    setIsExiting(true);
    exitCallbackRef.current = onRequestCloseAction;
    // Wait for exit animation to complete before calling close
    setTimeout(() => {
      exitCallbackRef.current?.();
    }, animationDurationMs);
  }, [onRequestCloseAction, isExiting, animationDurationMs]);

  // Expose triggerClose to parent via callback ref
  useEffect(() => {
    onAnimatedCloseRef?.(triggerClose);
  }, [onAnimatedCloseRef, triggerClose]);

  const canDismissBackdrop = useMemo(() => {
    if (!onRequestCloseAction) {
      return false;
    }

    if (isDismissDisabled) {
      return false;
    }

    if (backdropDismissBehavior === "never") {
      return false;
    }

    if (!guardElapsed) {
      return false;
    }

    if (backdropDismissBehavior === "before-interaction" && hasInteracted) {
      return false;
    }

    return true;
  }, [
    backdropDismissBehavior,
    guardElapsed,
    hasInteracted,
    isDismissDisabled,
    onRequestCloseAction,
  ]);

  const canDismissEscape = useMemo(() => {
    if (!onRequestCloseAction) {
      return false;
    }

    if (isDismissDisabled) {
      return false;
    }

    if (escapeDismissBehavior === "never") {
      return false;
    }

    if (!guardElapsed) {
      return false;
    }

    if (escapeDismissBehavior === "before-interaction" && hasInteracted) {
      return false;
    }

    return true;
  }, [
    escapeDismissBehavior,
    guardElapsed,
    hasInteracted,
    isDismissDisabled,
    onRequestCloseAction,
  ]);

  const handleBackdropClick = useCallback(
    (event: unknown) => {
      if (event && typeof event === "object" && "stopPropagation" in event) {
        (event as { stopPropagation: () => void }).stopPropagation();
      }
      if (!canDismissBackdrop) {
        return;
      }

      triggerClose();
    },
    [canDismissBackdrop, triggerClose],
  );

  const stopPropagation = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  }, []);

  const focusFirstFocusable = useCallback(() => {
    const dialogEl = dialogRef.current;
    if (!dialogEl) {
      return;
    }

    const focusable = dialogEl.querySelectorAll<HTMLElement>(
      [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "[tabindex]:not([tabindex='-1'])",
      ].join(","),
    );

    const first = focusable.item(0);
    if (first) {
      first.focus();
      return;
    }

    dialogEl.focus();
  }, []);

  useEffect(() => {
    // Capture and restore focus like a real modal.
    previouslyFocusedElement.current = document.activeElement;

    // Focus after paint.
    const handle = window.setTimeout(() => {
      focusFirstFocusable();
    }, 0);

    return () => {
      window.clearTimeout(handle);
      if (previouslyFocusedElement.current instanceof HTMLElement) {
        previouslyFocusedElement.current.focus();
      }
    };
  }, [focusFirstFocusable]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!canDismissEscape) {
          return;
        }
        event.preventDefault();
        triggerClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const dialogEl = dialogRef.current;
      if (!dialogEl) {
        return;
      }

      const focusable = Array.from(
        dialogEl.querySelectorAll<HTMLElement>(
          [
            "a[href]",
            "button:not([disabled])",
            "input:not([disabled])",
            "select:not([disabled])",
            "textarea:not([disabled])",
            "[tabindex]:not([tabindex='-1'])",
          ].join(","),
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

      if (focusable.length === 0) {
        event.preventDefault();
        dialogEl.focus();
        return;
      }

      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!first || !last) {
        event.preventDefault();
        dialogEl.focus();
        return;
      }

      if (event.shiftKey) {
        if (active === first || active === dialogEl) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [canDismissEscape, triggerClose]);

  // Animation styles for backdrop and card
  const backdropAnimationStyle = useMemo(
    () => ({
      animation: isExiting
        ? `th-auth-backdrop-fade-out ${animationDurationMs}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`
        : `th-auth-backdrop-fade-in ${animationDurationMs}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`,
    }),
    [isExiting, animationDurationMs],
  );

  const cardAnimationStyle = useMemo(
    () => ({
      animation: isExiting
        ? `th-auth-card-slide-out ${animationDurationMs}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`
        : `th-auth-card-slide-in ${animationDurationMs}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`,
    }),
    [isExiting, animationDurationMs],
  );

  return (
    <OverlayMount
      id={id}
      options={{
        placement: "top",
        align: "center",
        padding: "$0",
        maxWidth: "100%",
        interactive: true,
        testID: layerTestId,
      }}
    >
      <OverlayBackdrop
        onPress={handleBackdropClick}
        data-testid={backdropTestId}
        style={backdropAnimationStyle}
      >
        <CardContainer
          onPress={(event) => {
            if (
              event &&
              typeof event === "object" &&
              "stopPropagation" in (event as any)
            ) {
              (event as any).stopPropagation();
            }
            setHasInteracted(true);
          }}
          onFocus={() => {
            setHasInteracted(true);
          }}
          ref={dialogRef}
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          tabIndex={-1}
        >
          <FloatingCard style={cardAnimationStyle}>
            {onRequestCloseAction ? (
              <CloseButton
                size="$2"
                variant="ghost"
                data-auth-ink=""
                aria-label={closeLabel ?? (t("auth.closeOverlay") as string)}
                icon
                // Close button triggers animated close
                onPress={triggerClose}
              >
                <X size={18} aria-hidden="true" />
              </CloseButton>
            ) : null}
            {children}
          </FloatingCard>

          {/* Hidden accessible label/description for screen readers. */}
          <YStack
            id={titleId}
            position="absolute"
            width={1}
            height={1}
            overflow="hidden"
            opacity={0}
            pointerEvents="none"
          >
            <Text>{closeLabel ?? String(t("auth.authentication"))}</Text>
          </YStack>
          <YStack
            id={descriptionId}
            position="absolute"
            width={1}
            height={1}
            overflow="hidden"
            opacity={0}
            pointerEvents="none"
          >
            <Text>{String(t("auth.modalDialog"))}</Text>
          </YStack>
        </CardContainer>
      </OverlayBackdrop>
    </OverlayMount>
  );
};

AuthOverlayShell.displayName = "AuthOverlayShell";

export const DisabledAuthCard = ({
  onDismissAction,
}: {
  onDismissAction?: () => void;
}) => {
  const t = useTranslations();
  return (
    <CardSurface
      width="100%"
      maxWidth={480}
      borderColor="$borderColorStrong"
      borderWidth={2}
      backgroundColor="$background"
      padding="$6"
      gap="$4"
    >
      <YStack gap="$2">
        <Text variant="h4" weight="bold">
          {String(t("auth.authUnavailableTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("auth.authUnavailableDesc"))}
        </Text>
      </YStack>
      <Button size="$3" variant="outlined" asChild>
        <NextLinkAnchor href="/">{String(t("auth.returnHome"))}</NextLinkAnchor>
      </Button>
    </CardSurface>
  );
};

DisabledAuthCard.displayName = "DisabledAuthCard";
