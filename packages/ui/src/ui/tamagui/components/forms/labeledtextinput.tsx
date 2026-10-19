import { Platform } from "react-native";
import type { ComponentProps } from "react";
import { XStack, YStack } from "tamagui";

import { Text, type TextVariant } from "../typography/Text";
import { TextInput, type TextInputProps } from "./TextInput";

export type LabeledTextInputProps = Omit<TextInputProps, "id"> & {
  label: string;
  /**
   * Optional input name used for autofill heuristics and (if `id` is omitted)
   * for web `label -> input` association.
   */
  name?: string;
  /**
   * Layout rule for the label + control.
   * - "above": label stacked above the input.
   * - "beside": label to the left, input to the right.
   */
  labelPlacement?: "above" | "beside";
  /** Optional helper text beneath the input. */
  helperText?: string;

  /**
   * Type variant for the label.
   *
   * Defaults to `undefined`, which keeps the historical hand-rolled
   * appearance (`caption` + bold + 1.2px tracking + an 11px override) that
   * every form in the product renders today. Passing a variant — the auth
   * flow passes `"overline"`, the brand's mono label idiom — swaps in that
   * variant WHOLE and drops the hand-rolled overrides, because the two do not
   * compose: `overline` already carries its own size, tracking and weight, and
   * layering the old overrides on top would half-apply the idiom.
   *
   * Strictly additive on purpose. Repainting every label in the product is a
   * separate decision from restyling one flow.
   */
  labelVariant?: TextVariant;

  /**
   * Input id used for web label association. If omitted, we'll use `name`.
   * Safari/password managers tend to behave better with stable `id` + `name`.
   */
  id?: string;

  /**
   * Web-only test id.
   *
   * By default this attaches to the *input* so migrating from <TextInput data-testid="..." />
   * to <LabeledTextInput testId="..." /> keeps selectors stable.
   *
   * If you want ids on other parts too, set `testIdParts`.
   */
  testId?: string;
  testIdParts?: boolean;

  /** Props for layout container (YStack/XStack). */
  containerProps?: ComponentProps<typeof YStack>;
};

const isWeb = Platform.OS === "web";

const buildDataTestIdProps = (id?: string) =>
  isWeb && id
    ? {
        "data-testid": id,
      }
    : {};

export const LabeledTextInput = ({
  label,
  labelPlacement = "above",
  labelVariant,
  helperText,
  containerProps,
  testId,
  testIdParts,
  id,
  name,
  ...inputProps
}: LabeledTextInputProps) => {
  const resolvedId = id ?? name;

  if (process.env.NODE_ENV !== "production") {
    if (!resolvedId) {
      // eslint-disable-next-line no-console
      console.warn(
        "LabeledTextInput: provide `id` and/or `name` so the label can associate with the input on web.",
      );
    }
  }

  const rootTestId = testIdParts && testId ? `${testId}-root` : undefined;
  const labelTestId = testIdParts && testId ? `${testId}-label` : undefined;
  const inputTestId = testId;
  const helperTestId = testIdParts && testId ? `${testId}-helper` : undefined;

  // Helper text has to be REACHABLE from the input, not just visible next to
  // it. Without this the field announced "invalid" (from `aria-invalid`) with
  // no reason attached: the message rendered as a bare <span> with no id, no
  // role, and nothing pointing at it.
  //
  // Derived from `resolvedId` rather than `useId`, deliberately. A hook here
  // would make this file hook-using, which the `@th/ui` client-directive gate
  // (`components/__tests__/use-client-directive.test.ts`) requires be marked
  // `"use client"` — turning a pass-through wrapper into an RSC boundary for
  // an accessibility attribute. The only case it would have covered is a
  // caller passing neither `id` nor `name`, which already has no
  // `label htmlFor` association and already trips the dev warning above.
  // Any caller-supplied `aria-describedby` is preserved ahead of ours.
  const helperId = resolvedId ? `${resolvedId}-helper-text` : undefined;
  const callerDescribedBy = (
    inputProps as { "aria-describedby"?: string }
  )["aria-describedby"];
  const describedBy =
    [callerDescribedBy, helperText ? helperId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  const Wrapper = labelPlacement === "beside" ? XStack : YStack;

  // On web, wrap in a native <label> so password managers can associate
  // labels with inputs. RNW's <Text> renders a <div>/<span> and ignores
  // htmlFor, so we need a real <label> element.
  const labelContent = labelVariant ? (
    <Text
      variant={labelVariant}
      color="$colorMuted"
      {...buildDataTestIdProps(labelTestId)}
    >
      {label}
    </Text>
  ) : (
    <Text
      variant="caption"
      weight="bold"
      color="$colorMuted"
      letterSpacing={1.2}
      style={{ fontSize: 11 }}
      {...buildDataTestIdProps(labelTestId)}
    >
      {label}
    </Text>
  );

  const renderedLabel =
    isWeb && resolvedId ? (
      <label htmlFor={resolvedId} style={{ display: "contents" }}>
        {labelContent}
      </label>
    ) : (
      labelContent
    );

  return (
    <Wrapper
      gap="$2"
      alignItems={labelPlacement === "beside" ? "center" : undefined}
      {...containerProps}
      {...buildDataTestIdProps(rootTestId)}
    >
      {renderedLabel}

      <TextInput
        {...inputProps}
        aria-describedby={describedBy}
        id={resolvedId}
        name={name}
        fullWidth
        width={(inputProps as any).width ?? "100%"}
        testId={inputTestId}
      />

      {helperText ? (
        <Text
          id={helperId}
          variant="bodySmall"
          tone={inputProps.status === "error" ? "error" : "muted"}
          // `role="alert"` only in the error state: it carries an implicit
          // assertive live region, which is right for "this field just
          // failed" and wrong for a standing hint that happens to re-render.
          role={inputProps.status === "error" ? "alert" : undefined}
          {...buildDataTestIdProps(helperTestId)}
        >
          {helperText}
        </Text>
      ) : null}
    </Wrapper>
  );
};

LabeledTextInput.displayName = "LabeledTextInput";
