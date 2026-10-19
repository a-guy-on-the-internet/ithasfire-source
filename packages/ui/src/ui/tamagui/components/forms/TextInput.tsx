"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ElementRef,
} from "react";
import { Platform } from "react-native";
import { AlertCircle, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Input as TamaguiInput, Stack, styled, type GetProps } from "tamagui";

// Focus accent — matches the checkout form's nice "border darkens to the
// brand accent on focus" treatment. We drop the doubled-up outline ring
// in favour of a clean 2px accent border (the border is already 2px in the
// rest state; only the colour changes).
const focusRing = {
  outlineWidth: 0,
  outlineStyle: "none" as const,
  outlineColor: "transparent",
};

const InputFrame = styled(Stack, {
  name: "IthasFireTextInputFrame",
  width: 240,
  minHeight: 36,
  position: "relative",
  justifyContent: "center",
});

const StatusIconWrapper = styled(Stack, {
  name: "IthasFireTextInputStatusIcon",
  position: "absolute",
  right: "$3",
  top: 0,
  bottom: 0,
  justifyContent: "center",
  pointerEvents: "none",
  display: "flex",
  variants: {
    tone: {
      success: {
        color: "$success",
      },
      warning: {
        color: "$warning",
      },
      error: {
        color: "$brandSecondary",
      },
    },
  },
});

const ClearButton = styled(Stack, {
  name: "IthasFireTextInputClearButton",
  position: "absolute",
  right: "$2",
  top: 0,
  bottom: 0,
  justifyContent: "center",
  alignItems: "center",
  width: 28,
  cursor: "pointer",
  opacity: 0.4,
  hoverStyle: {
    opacity: 1,
  },
  pressStyle: {
    opacity: 0.8,
  },
});

const buildStatusStyles = (token: `$${string}`) => ({
  borderColor: token,
  hoverStyle: {
    borderColor: token,
  },
  focusStyle: {
    ...focusRing,
    // Status colour wins over the accent ring when an input has an active
    // state (success/warning/error), so the user always sees the
    // semantically-correct colour first.
    borderColor: token,
  },
});

const StyledTextInput = styled(TamaguiInput, {
  name: "IthasFireTextInput",
  width: "100%",
  minHeight: 36,
  paddingHorizontal: "$3",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  color: "$color",
  fontFamily: "$body",
  fontSize: "$3",
  placeholderTextColor: "$colorMuted",
  shadowColor: "transparent",
  transition: "all 150ms ease-out",
  hoverStyle: {
    borderColor: "$borderColorStrong",
  },
  focusStyle: {
    ...focusRing,
    // The signature "nice accent" focus state — border switches to the
    // brand accent (steel blue). Keeps the existing 2px width so layout
    // doesn't shift; the colour change is the entire visual cue.
    borderColor: "$accent",
  },
  disabledStyle: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
  variants: {
    fullWidth: {
      true: {
        width: "100%",
      },
    },
    /**
     * Visual variant for the input field:
     * - "boxed" (default): Traditional input with border, background, and rounded corners
     * - "underline": Clean, minimal style with only a bottom border - great for auth forms
     */
    variant: {
      boxed: {
        // Default styles already applied above
      },
      underline: {
        backgroundColor: "transparent",
        borderWidth: 0,
        borderBottomWidth: 1,
        borderBottomColor: "$borderColor",
        borderRadius: 0,
        paddingHorizontal: "$1",
        paddingVertical: "$3",
        minHeight: 44,
        hoverStyle: {
          borderBottomColor: "$borderColorStrong",
        },
        focusStyle: {
          outlineWidth: 0,
          outlineStyle: "none" as const,
          outlineColor: "transparent",
          borderBottomColor: "$accent",
          borderBottomWidth: 2,
        },
      },
    },
    status: {
      success: buildStatusStyles("$success"),
      warning: buildStatusStyles("$warning"),
      error: buildStatusStyles("$brandSecondary"),
    },
    // NOTE: there is deliberately NO `required` variant. Required fields are UNMARKED
    // (design-system-v2.md §6a), and a variant of that name would make Tamagui swallow the
    // prop so native `required` never reached the <input> (verified in the browser 2026-08-26).
  },
  // @ts-expect-error -- Tamagui supports compoundVariants at runtime but Input typings omit it
  compoundVariants: [
    {
      variant: "underline",
      status: "error",
      style: {
        borderBottomColor: "$brandSecondary",
        borderBottomWidth: 2,
        focusStyle: {
          borderBottomColor: "$brandSecondary",
          borderBottomWidth: 2,
          outlineWidth: 0,
        },
      },
    },
    {
      variant: "underline",
      status: "success",
      style: {
        borderBottomColor: "$success",
        borderBottomWidth: 2,
        focusStyle: {
          borderBottomColor: "$success",
          borderBottomWidth: 2,
          outlineWidth: 0,
        },
      },
    },
    {
      variant: "underline",
      status: "warning",
      style: {
        borderBottomColor: "$warning",
        borderBottomWidth: 2,
        focusStyle: {
          borderBottomColor: "$warning",
          borderBottomWidth: 2,
          outlineWidth: 0,
        },
      },
    },
  ],
  defaultVariants: {
    variant: "boxed",
  },
});

const statusConfig = {
  success: {
    Icon: CheckCircle2,
  },
  warning: {
    Icon: AlertTriangle,
  },
  error: {
    Icon: AlertCircle,
  },
} as const;

type Status = keyof typeof statusConfig;

type StyledTextInputProps = GetProps<typeof StyledTextInput>;

export type TextInputVariant = "boxed" | "underline";

export type TextInputProps = Omit<
  StyledTextInputProps,
  "status" | "type" | "variant" | "required" | "min" | "max" | "step"
> & {
  status?: Status;
  /**
   * Visual variant for the input field:
   * - "boxed" (default): Traditional input with border, background, and rounded corners
   * - "underline": Clean, minimal style with only a bottom border - great for auth forms
   */
  variant?: TextInputVariant;
  /** Marks the field as required — reaches the input as `aria-required` (react-native-web's TextInput drops native `required`; verified in the browser 2026-08-26). No visual marker (§6a). */
  required?: boolean;
  /** Width of the outer container frame. Defaults to 240. */
  containerWidth?: number | string;
  /** Native input type forwarded to the underlying <input>. */
  type?: string;
  /**
   * Native numeric/range constraints forwarded to the underlying <input>.
   * React Native Web's prop allow-list drops these, so — like `type`/`name`
   * — they are patched imperatively onto the DOM node (see `patchInputDOM`).
   */
  min?: string | number;
  max?: string | number;
  step?: string | number;

  /**
   * Back-compat: many existing call sites rely on `fullWidth` to make the input stretch.
   *
   * When true, we set the outer frame width to 100% and the input width to 100%.
   */
  fullWidth?: boolean;

  /**
   * Show a clear (×) button inside the input when it has a value.
   * Calls `onChangeText("")` or the dedicated `onClear` callback when pressed.
   */
  clearable?: boolean;

  /**
   * Called when the clear button is pressed. If not provided, falls back to
   * `onChangeText("")`.
   */
  onClear?: () => void;

  /**
   * Web-only DOM props. These help Safari/password managers and label association.
   */
  id?: string;
  name?: string;
  autoComplete?: string;
  /** Adds `data-testid` to the underlying input (and to the status icon when present). */
  testId?: string;
  /** Adds `data-qa` to the underlying input (and to the status icon when present). */
  qaId?: string;
};

type TextInputElement = ElementRef<typeof StyledTextInput>;

const isWeb = Platform.OS === "web";

/**
 * Resolve `node` (which may be the raw <input> or a Tamagui/RNW wrapper) to
 * the underlying HTMLInputElement on web.
 */
function resolveInputElement(node: unknown): HTMLInputElement | null {
  if (!isWeb || node == null) return null;
  if (node instanceof HTMLInputElement) return node;
  // Tamagui may hand us the <input> directly, but some styled() wrappers
  // pass a host node that *contains* the <input>.
  return (node as HTMLElement)?.querySelector?.("input") ?? null;
}

type PinnedAttr = "type" | "name";

/**
 * The caller's `type` / `name`, per element, while set. Read by the guards
 * {@link installAttrGuard} puts on the element.
 */
const pinnedAttrs = new WeakMap<HTMLInputElement, Partial<Record<PinnedAttr, string>>>();
const guardedInputs = new WeakSet<HTMLInputElement>();

const isPinnedAttr = (attr: string): attr is PinnedAttr => attr === "type" || attr === "name";

/**
 * Stop React from stripping a caller-supplied `type` or `name` off the element.
 *
 * React 19's `updateInput` runs on EVERY commit of a host `<input>` whose props
 * changed (value, style, focus state…). It blanks `element.name`, then calls
 * `removeAttribute("name")` and, when its `type` prop is null,
 * `removeAttribute("type")`. RNW never passes `name` and always overwrites the
 * `type` prop with its own derived value, which is undefined for a default
 * input. So every such commit reverted `type="datetime-local"` to a plain text
 * box and dropped `name` (which password managers read). Tamagui's focus/hover
 * state re-renders only the inner input, so the re-assert effect below never
 * ran: the booking-hold Challenge form (autofocused) and the promo schedule
 * fields showed the raw `YYYY-MM-DDTHH:mm` string and garbled edits (verified
 * in the browser 2026-09-28).
 *
 * Re-adding the attribute after React removes it is not enough. Measured in
 * Chromium: flipping a focused `datetime-local` to text and back mid-edit resets
 * the segment being typed, so "10012026" landed as 2026-01-29. So the element
 * refuses the removal itself while the attribute is pinned, and refuses
 * `el.name = ""` (React's blanking) while `name` is pinned. Any other
 * `el.name = "x"` write, every other attribute, and an unpinned one behave
 * natively.
 */
function installAttrGuard(el: HTMLInputElement) {
  if (guardedInputs.has(el)) return;
  guardedInputs.add(el);
  const nativeRemoveAttribute = Element.prototype.removeAttribute;
  el.removeAttribute = function removeAttribute(this: HTMLInputElement, qualifiedName: string) {
    const attr = qualifiedName.toLowerCase();
    if (isPinnedAttr(attr) && pinnedAttrs.get(this)?.[attr] !== undefined) return;
    nativeRemoveAttribute.call(this, qualifiedName);
  };
  const nameDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "name");
  const { get: nativeGetName, set: nativeSetName } = nameDescriptor ?? {};
  if (nativeGetName && nativeSetName) {
    Object.defineProperty(el, "name", {
      configurable: true,
      enumerable: nameDescriptor?.enumerable ?? true,
      get(this: HTMLInputElement) {
        return nativeGetName.call(this);
      },
      set(this: HTMLInputElement, next: string) {
        // Refuse only React's blanking; any other write goes through.
        if (next === "" && pinnedAttrs.get(this)?.name !== undefined) return;
        nativeSetName.call(this, next);
      },
    });
  }
}

/**
 * Pin (or release) one attribute. Releasing FINISHES the removal React already
 * tried: its mutation-phase `removeAttribute` ran while the pin was still set
 * and was refused, and this runs later (ref callback / effect), so nothing else
 * would clear the stale value. Skipped if something wrote a different value in
 * the meantime (e.g. RNW's own derived `type`).
 */
function pinInputAttr(el: HTMLInputElement, attr: PinnedAttr, value: string | undefined) {
  const pins = pinnedAttrs.get(el);
  if (value) {
    installAttrGuard(el);
    pinnedAttrs.set(el, { ...pins, [attr]: value });
    return;
  }
  const was = pins?.[attr];
  if (was === undefined) return;
  const rest = { ...pins };
  delete rest[attr];
  pinnedAttrs.set(el, rest);
  if (el.getAttribute(attr) === was) Element.prototype.removeAttribute.call(el, attr);
}

/**
 * Apply `name`, `type`, `autocomplete`, `data-testid`, `data-qa` attributes
 * directly on a DOM <input> element.
 *
 * React Native Web's TextInput `pickProps` allow-list does not include `name`
 * or arbitrary `data-*` attributes, and its internal logic overwrites whatever
 * `type` the caller passes with a value derived from
 * `secureTextEntry`/`inputMode`/`keyboardType`.
 *
 * Imperatively setting these attributes is the only reliable way to guarantee
 * they land on the DOM element.  We run this both in the ref callback (so
 * attributes are present before first paint, which Safari's password autofill
 * AND Playwright's `getByTestId` rely on) and in a `useEffect` (to pick up
 * prop changes on subsequent renders).
 */
function patchInputDOM(
  el: HTMLInputElement | null,
  name: string | undefined,
  type: string | undefined,
  autoComplete: string | undefined,
  testId: string | undefined,
  qaId: string | undefined,
  min: string | number | undefined,
  max: string | number | undefined,
  step: string | number | undefined,
) {
  if (!el) return;
  // Same idempotent guard as the attributes below: only write when the value
  // actually differs and remove when undefined. `min`/`max`/`step` are patched
  // here (not passed as props) because RNW's allow-list silently drops them.
  const applyAttr = (attr: string, value: string | number | undefined) => {
    if (value != null && value !== "") {
      const next = String(value);
      if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
    } else if (el.hasAttribute(attr)) {
      el.removeAttribute(attr);
    }
  };
  // Only write when the value actually differs. Re-setting an <input>'s
  // `type` attribute (even to the same value) resets the caret to position 0
  // in most browsers — and because the re-assert useEffect below runs after
  // EVERY render, an unconditional setAttribute on each keystroke made text
  // appear typed backwards (each new char inserted at the front). Guarding
  // every attribute keeps patchInputDOM genuinely idempotent.
  pinInputAttr(el, "name", name);
  pinInputAttr(el, "type", type);
  if (name) {
    if (el.getAttribute("name") !== name) el.setAttribute("name", name);
  } else if (el.hasAttribute("name")) {
    el.removeAttribute("name");
  }
  if (type && el.getAttribute("type") !== type) {
    el.setAttribute("type", type);
  }
  if (autoComplete && el.getAttribute("autocomplete") !== autoComplete) {
    el.setAttribute("autocomplete", autoComplete);
  }
  if (testId) {
    if (el.getAttribute("data-testid") !== testId)
      el.setAttribute("data-testid", testId);
  } else if (el.hasAttribute("data-testid")) {
    el.removeAttribute("data-testid");
  }
  if (qaId) {
    if (el.getAttribute("data-qa") !== qaId) el.setAttribute("data-qa", qaId);
  } else if (el.hasAttribute("data-qa")) {
    el.removeAttribute("data-qa");
  }
  applyAttr("min", min);
  applyAttr("max", max);
  applyAttr("step", step);
}

export const TextInput = forwardRef<TextInputElement, TextInputProps>(
  (
    {
      status,
      containerWidth,
      type,
      min,
      max,
      step,
      fullWidth,
      variant,
      required,
      id,
      name,
      autoComplete,
      testId,
      qaId,
      clearable,
      onClear,
      ...rest
    },
    ref,
  ) => {
    const statusMeta = status ? statusConfig[status] : null;
    const resolvedFrameWidth = containerWidth ?? (fullWidth ? "100%" : 240);
    const resolvedInputWidth = fullWidth ? "100%" : rest.width;

    // Determine if the clear button should appear.
    const inputValue = typeof rest.value === "string" ? rest.value : "";
    const showClear =
      clearable &&
      inputValue.length > 0 &&
      !rest.disabled &&
      rest.editable !== false;

    // Right padding: status icon takes priority, then clear button, then default.
    const trailingPadding = statusMeta ? "$6" : showClear ? "$7" : undefined;

    // Generic automation attributes: opt-in, consistent across components.
    const automationAttrs = {
      ...(testId ? ({ "data-testid": testId } as const) : null),
      ...(qaId ? ({ "data-qa": qaId } as const) : null),
    };

    const handleClear = useCallback(() => {
      if (onClear) {
        onClear();
      } else if (rest.onChangeText) {
        rest.onChangeText("");
      }
    }, [onClear, rest.onChangeText]);

    // ── Imperative DOM attribute patching ──────────────────────────────
    const domRef = useRef<HTMLInputElement | null>(null);

    // Ref callback fires synchronously during the commit phase (before paint).
    // We patch `name`/`type`/`autocomplete` immediately so password managers
    // see them on the very first frame.
    const refCallback = useCallback(
      (node: any) => {
        const el = resolveInputElement(node);
        domRef.current = el;
        patchInputDOM(el, name, type, autoComplete, testId, qaId, min, max, step);

        // Forward to the consumer ref.
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<any>).current = node;
        }
      },
      [autoComplete, max, min, name, qaId, ref, step, testId, type],
    );

    // Re-assert attributes after EVERY render, not just when these props
    // change: React Native Web writes its own derived `type` (and friends)
    // back onto the element during each commit, so any unrelated re-render
    // (e.g. a keystroke in a sibling field) silently reverts
    // `type="datetime-local"` to `type="text"` if we only patch on prop
    // changes. patchInputDOM is idempotent setAttribute calls — cheap.
    useEffect(() => {
      patchInputDOM(
        domRef.current,
        name,
        type,
        autoComplete,
        testId,
        qaId,
        min,
        max,
        step,
      );
    });

    return (
      <InputFrame width={resolvedFrameWidth}>
        <StyledTextInput
          ref={refCallback}
          {...rest}
          {...automationAttrs}
          id={id}
          {...(autoComplete ? ({ autoComplete } as any) : {})}
          status={status}
          variant={variant}
          required={required}
          aria-required={required ? true : undefined}
          {...(trailingPadding !== undefined
            ? { paddingRight: trailingPadding }
            : {})}
          width={resolvedInputWidth}
        />
        {showClear && !statusMeta ? (
          <ClearButton
            onPress={handleClear}
            aria-label="Clear"
            role="button"
            data-testid={testId ? `${testId}-clear` : "text-input-clear"}
          >
            <X color="currentColor" size={14} strokeWidth={2.5} />
          </ClearButton>
        ) : null}
        {statusMeta ? (
          <StatusIconWrapper
            tone={status}
            data-testid={
              testId
                ? `${testId}-status-${status}`
                : `text-input-status-${status}`
            }
            data-qa={qaId ? `${qaId}-status-${status}` : undefined}
          >
            <statusMeta.Icon
              color="currentColor"
              size={16}
              strokeWidth={2}
              aria-hidden="true"
            />
          </StatusIconWrapper>
        ) : null}
      </InputFrame>
    );
  },
);

TextInput.displayName = "TextInput";
