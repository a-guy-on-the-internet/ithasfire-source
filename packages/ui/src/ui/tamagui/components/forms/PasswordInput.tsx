"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ElementRef,
} from "react";
import { Platform } from "react-native";
import { Eye, EyeOff } from "lucide-react";
import { Stack, styled, useTheme, XStack } from "tamagui";

import { stubTheme } from "../../tokens/colors";
import { TextInput, type TextInputProps } from "./TextInput";

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
// ─────────────────────────────────────────────────────────────────────────────

const Wrapper = styled(XStack, {
  name: "PasswordInputWrapper",
  position: "relative",
  width: "100%",
  alignItems: "center",
});

const ToggleHitArea = styled(Stack, {
  name: "PasswordInputToggle",
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: 44,
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2,
  cursor: "pointer",
  borderRadius: 0,
  // Explicit zero-style baseline so browser <button> defaults
  // (gray bg, outset border) don't leak through.
  backgroundColor: "transparent",
  borderWidth: 0,
  padding: 0,
  hoverStyle: {
    // Theme-tracking wash (ink @4% on Stub, steel-blue tint on Ember). The
    // previous raw white @6% was authored for the retired dark theme and is
    // invisible on Stub's paper surfaces.
    backgroundColor: "$surfaceOverlay",
  },
  pressStyle: { opacity: 0.7 },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export type PasswordInputProps = Omit<
  TextInputProps,
  "type" | "secureTextEntry"
> & {
  /**
   * Controls the visibility of the password text.
   * When omitted the component manages its own state internally.
   */
  show?: boolean;
  /** Called when the eye toggle is pressed. Required when `show` is controlled. */
  onToggle?: () => void;
  /** Accessible label for the toggle button. Defaults to "Toggle password visibility". */
  toggleLabel?: string;
  /** Screen reader description when the password is currently visible. */
  visibleStateLabel?: string;
  /** Screen reader description when the password is currently hidden. */
  hiddenStateLabel?: string;
  /** data-testid applied to the toggle hit area. */
  toggleTestId?: string;
};

type InputElement = ElementRef<typeof TextInput>;

const isWeb = Platform.OS === "web";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `TextInput` with an integrated eye/eye-off toggle for password reveal.
 *
 * The toggle sits **inside** the input's right padding — no absolute overlay
 * that floats on top of the text. The input's `paddingRight` is automatically
 * set to 44 px so text never runs beneath the toggle.
 *
 * Works both controlled (`show` + `onToggle`) and uncontrolled.
 */
export const PasswordInput = forwardRef<InputElement, PasswordInputProps>(
  (
    {
      show: showProp,
      onToggle,
      toggleLabel = "Toggle password visibility",
      visibleStateLabel = "Password visible",
      hiddenStateLabel = "Password hidden",
      toggleTestId,
      ...inputProps
    },
    ref,
  ) => {
    // ── Visibility state (controlled or uncontrolled) ─────────────────
    const [internalShow, setInternalShow] = useState(false);
    const visibilityStatusId = useId();
    const theme = useTheme();
    // Resolve $colorMuted to a real value so lucide-react-native (which can't
    // read CSS variables) renders the icon correctly. On web, falling back to
    // the CSS var keeps the existing var-based styling.
    const iconColor =
      (theme.colorMuted?.get?.() as string | undefined) ??
      (isWeb ? "var(--colorMuted)" : stubTheme.colorMuted);
    const isControlled = showProp !== undefined;
    const visible = isControlled ? showProp : internalShow;
    const secureTextEntry = isWeb ? true : !visible;
    const visibilityDescription = visible
      ? visibleStateLabel
      : hiddenStateLabel;
    const toggleAccessibilityProps = isWeb
      ? {
          tag: "button",
          type: "button",
          role: "button",
          "aria-label": toggleLabel,
          "aria-describedby": visibilityStatusId,
          // Keep aria-description as additive context; live region + describedby are primary.
          "aria-description": visibilityDescription,
          "aria-pressed": visible,
        }
      : {
          accessibilityRole: "button",
          accessibilityLabel: toggleLabel,
        };

    // ── Imperative DOM type-flip ──────────────────────────────────────
    // Safari requires secureTextEntry to stay true for password autofill.
    // We flip the DOM `type` attribute imperatively so RNW keeps its
    // internal state consistent while the user can still reveal the text.
    //
    // We store `visible` in a ref so that our callbacks stay stable —
    // recreating the ref callback on every toggle causes React to
    // detach/reattach the ref, which drops focus and cursor position.
    const domRef = useRef<HTMLInputElement | null>(null);
    const visibleRef = useRef(visible);
    visibleRef.current = visible;

    const syncVisibleType = useCallback(() => {
      if (domRef.current) {
        domRef.current.setAttribute(
          "type",
          visibleRef.current ? "text" : "password",
        );
      }
    }, []);

    const handleToggle = () => {
      if (isControlled) {
        onToggle?.();
      } else {
        setInternalShow((v) => !v);
      }
    };

    // Stable ref callback — does NOT depend on `visible` so it is never
    // recreated during a toggle, preventing focus loss.
    const refCallback = useCallback(
      (node: any) => {
        if (isWeb && node) {
          const el =
            node instanceof HTMLInputElement
              ? node
              : ((node as HTMLElement)?.querySelector?.("input") ?? null);
          domRef.current = el;
          syncVisibleType();
        } else if (!node) {
          domRef.current = null;
        }

        // Forward to consumer ref
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<any>).current = node;
        }
      },
      [ref, syncVisibleType],
    );

    // Re-sync the type attribute whenever `visible` changes.
    useEffect(() => {
      syncVisibleType();
    }, [visible, syncVisibleType]);

    // Guard against RNW / TextInput resetting type="password" during
    // React re-renders triggered by typing.  A MutationObserver catches
    // any external attribute write and immediately corrects it.
    useEffect(() => {
      if (!isWeb || !domRef.current) return;

      const input = domRef.current;

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (
            m.type === "attributes" &&
            m.attributeName === "type" &&
            input.getAttribute("type") !==
              (visibleRef.current ? "text" : "password")
          ) {
            syncVisibleType();
          }
        }
      });

      observer.observe(input, { attributes: true, attributeFilter: ["type"] });

      return () => {
        observer.disconnect();
      };
    }, [syncVisibleType]);

    return (
      <Wrapper>
        {isWeb ? (
          <span
            id={visibilityStatusId}
            role="status"
            aria-live="polite"
            style={{
              position: "absolute",
              width: "1px",
              height: "1px",
              padding: 0,
              margin: "-1px",
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {visibilityDescription}
          </span>
        ) : null}
        {isWeb ? (
          <style>{`input.th-pw-input { padding-right: 48px !important; }`}</style>
        ) : null}
        <TextInput
          ref={refCallback}
          {...inputProps}
          type={isWeb ? "password" : undefined}
          secureTextEntry={secureTextEntry}
          minHeight={inputProps.minHeight ?? 44}
          fullWidth={inputProps.fullWidth ?? true}
          {...({ className: "th-pw-input" } as Record<string, unknown>)}
        />
        <ToggleHitArea
          onPress={handleToggle}
          {...({
            ...toggleAccessibilityProps,
            ...(toggleTestId ? { "data-testid": toggleTestId } : {}),
          } as Record<string, unknown>)}
        >
          {visible ? (
            <EyeOff size={20} color={iconColor} strokeWidth={2} />
          ) : (
            <Eye size={20} color={iconColor} strokeWidth={2} />
          )}
        </ToggleHitArea>
      </Wrapper>
    );
  },
);

PasswordInput.displayName = "PasswordInput";
