"use client";

import { AlertCircle } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import { styled, XStack, YStack, type TamaguiElement } from "tamagui";

import { useTranslations } from "../../../../locale";
import { getFeedbackTokens } from "../shared";
import { Text } from "../typography/Text";

// ---------------------------------------------------------------------------
// ValidationSummary — the list of what's wrong, at the top of a form.
//
// THE VALIDATION TIMING RULE (design system v2, forms):
//   1. Validate a field on BLUR.
//   2. CLEAR that field's error on INPUT — never block or nag while typing.
//   3. Re-validate EVERYTHING on SUBMIT.
//   4. On a failed submit, move focus to this summary (`ref.current.focus()`
//      or `useValidationSummaryFocus`). Because focus ALWAYS moves here, the
//      box is a labelled `role="group"`, not a live region — a live region
//      plus a focus move would read the whole list twice.
//   5. Inline field errors STAY. The summary orients; the inline error fixes.
//      Both, always — this component never replaces the per-field message.
//
// Renders nothing when `errors` is empty, so it is safe to leave mounted at
// the top of the form for the whole session. Required on any form over
// roughly six fields and on every step of the event builder.
// ---------------------------------------------------------------------------

export interface ValidationSummaryError {
  /** Stable key for the entry (usually the field id or a validation code). */
  id: string;
  /** What is wrong, ideally prefixed with the field's label. */
  message: string;
  /**
   * DOM id of the offending control. When present the entry is a button that
   * moves focus to that control (`document.getElementById(fieldId).focus()`
   * on web; `onFocusField` elsewhere).
   */
  fieldId?: string;
}

export interface ValidationSummaryProps {
  errors: ValidationSummaryError[];
  /**
   * Heading for the box. Defaults to `forms.validationSummaryTitle` from the
   * active catalog (ICU plural on `count`: "N things need fixing").
   */
  title?: ReactNode;
  /**
   * Called when an entry is activated. On web the summary focuses the field
   * itself when this is omitted; on native it is the only way to move focus,
   * so pass it whenever the form runs on a phone.
   */
  onFocusField?: (fieldId: string) => void;
  /** Test automation base id. */
  testIdBase?: string;
}

export interface ValidationSummaryHandle {
  /** Move keyboard focus to the summary box (no-op when nothing renders). */
  focus: () => void;
}

const isWeb = Platform.OS === "web";

const SummaryBox = styled(YStack, {
  name: "ValidationSummary",
  borderWidth: 2,
  borderRadius: 0,
  padding: "$4",
  gap: "$3",
  // A programmatically focused region still needs a visible ring — the
  // reader was just moved here without asking.
  focusStyle: {
    outlineWidth: 2,
    outlineColor: "$focus",
    outlineStyle: "solid",
    outlineOffset: 2,
  },
});

const ErrorList = styled(YStack, {
  name: "ValidationSummaryList",
  gap: "$2",
});

// The `<ol>` tag carries list semantics on web; strip the UA indent so the
// entries sit flush with the heading.
const listResetStyle = isWeb
  ? { margin: 0, padding: 0, listStyle: "none" as const }
  : undefined;

// Each linked entry is a real `<button>` on web so it is keyboard reachable
// and announced as an action ("focus the field"), not as decorative text.
// Reset the UA button chrome; the underline is the affordance.
const linkResetStyle = isWeb
  ? {
      background: "transparent",
      border: 0,
      padding: 0,
      margin: 0,
      cursor: "pointer" as const,
      textAlign: "left" as const,
      textDecoration: "underline",
      font: "inherit",
    }
  : { textDecorationLine: "underline" as const };

const ErrorItem = styled(XStack, {
  name: "ValidationSummaryItem",
  gap: "$2",
  alignItems: "flex-start",
});

export const ValidationSummary = forwardRef<
  ValidationSummaryHandle,
  ValidationSummaryProps
>(function ValidationSummary({ errors, title, onFocusField, testIdBase }, ref) {
  const boxRef = useRef<TamaguiElement>(null);
  const titleId = useId();
  const t = useTranslations();

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const node = boxRef.current as unknown as { focus?: () => void } | null;
        if (node && typeof node.focus === "function") {
          node.focus();
        }
      },
    }),
    [],
  );

  const focusField = useCallback(
    (fieldId: string) => {
      if (onFocusField) {
        onFocusField(fieldId);
        return;
      }
      if (isWeb && typeof document !== "undefined") {
        const target = document.getElementById(fieldId);
        if (target && typeof target.focus === "function") {
          target.focus();
          if (typeof target.scrollIntoView === "function") {
            target.scrollIntoView({ block: "center" });
          }
        }
      }
    },
    [onFocusField],
  );

  if (errors.length === 0) return null;

  const tokens = getFeedbackTokens("danger", "soft");
  const heading =
    title ??
    String(t("forms.validationSummaryTitle", { count: errors.length }));

  return (
    <SummaryBox
      ref={boxRef}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      backgroundColor={tokens.backgroundColor}
      borderColor="$danger"
      {...(testIdBase ? { "data-testid": testIdBase } : {})}
    >
      <XStack gap="$2" alignItems="center">
        <AlertCircle
          size={16}
          strokeWidth={2}
          aria-hidden
          color="var(--danger, #B91C1C)"
        />
        <Text
          id={titleId}
          variant="overline"
          tone="error"
          {...(testIdBase ? { testId: `${testIdBase}-title` } : {})}
        >
          {heading}
        </Text>
      </XStack>
      <ErrorList tag="ol" style={listResetStyle}>
        {errors.map((entry, index) => (
          <ErrorItem key={entry.id} tag="li">
            {/* The <ol> already numbers entries for AT; this is the visual. */}
            <Text
              variant="bodySmall"
              tone="error"
              weight="semibold"
              tag="span"
              aria-hidden
            >
              {index + 1}.
            </Text>
            {entry.fieldId ? (
              <Text
                variant="bodySmall"
                tag="button"
                // Without an explicit type a <button> inside <form onSubmit>
                // is a SUBMIT button — clicking an entry would submit the form.
                {...(isWeb
                  ? ({ type: "button" } as Record<string, string>)
                  : {})}
                style={linkResetStyle}
                focusStyle={{
                  outlineWidth: 2,
                  outlineColor: "$focus",
                  outlineStyle: "solid",
                  outlineOffset: 2,
                }}
                onPress={() => focusField(entry.fieldId as string)}
                {...(testIdBase
                  ? { testId: `${testIdBase}-item-${entry.id}` }
                  : {})}
              >
                {entry.message}
              </Text>
            ) : (
              <Text
                variant="bodySmall"
                tag="span"
                {...(testIdBase
                  ? { testId: `${testIdBase}-item-${entry.id}` }
                  : {})}
              >
                {entry.message}
              </Text>
            )}
          </ErrorItem>
        ))}
      </ErrorList>
    </SummaryBox>
  );
});

ValidationSummary.displayName = "ValidationSummary";

/**
 * Keeps the failed-submit half of the timing rule to one line at the call
 * site:
 *
 * ```tsx
 * const summary = useValidationSummaryFocus();
 * const onSubmit = () => {
 *   const errors = validateAll();
 *   setErrors(errors);
 *   if (errors.length) summary.focusSummary();
 * };
 * <ValidationSummary ref={summary.ref} errors={errors} />
 * ```
 *
 * `focusSummary` defers one frame so the summary has rendered by the time
 * focus is requested (the errors state and the focus call usually land in
 * the same handler).
 */
export const useValidationSummaryFocus = () => {
  const ref = useRef<ValidationSummaryHandle>(null);
  const focusSummary = useCallback(() => {
    const run = () => ref.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(run);
    } else {
      run();
    }
  }, []);
  return { ref, focusSummary };
};
