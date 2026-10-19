"use client";

import { Text } from "@th/ui";

/**
 * A field label that is actually ASSOCIATED with its control.
 *
 * The details form these sections came from labelled its inputs with a bare
 * `<Text>` above each one, so every field's accessible name was its
 * placeholder ("e.g. 555-1234") or nothing. This is the same appearance every
 * other form in the product renders — `LabeledTextInput`'s default: caption,
 * bold, muted, 11px, 1.2px tracking — on a real `<label htmlFor>`.
 *
 * `display: contents` keeps the `<label>` out of layout, the same idiom
 * `PageFieldsEditor` uses for its slug and visibility labels, so the Public
 * page section and the sections above it read as one form.
 */
export function SettingsFieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: string;
}) {
  return (
    <label htmlFor={htmlFor} style={{ display: "contents" }}>
      <Text
        variant="caption"
        weight="bold"
        color="$colorMuted"
        letterSpacing={1.2}
        style={{ fontSize: 11 }}
      >
        {children}
      </Text>
    </label>
  );
}
