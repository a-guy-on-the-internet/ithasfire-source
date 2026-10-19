"use client";

import { forwardRef } from "react";

import type { DatePickerProps } from "./DatePicker.types";

// Minimal implementation kept to unblock workspace typechecking while we rebuild the full
// single-date picker (previous file contents were corrupted/duplicated).
export const DatePicker = forwardRef<HTMLInputElement | null, DatePickerProps>(
  (_props, _ref) => null,
);

DatePicker.displayName = "DatePicker";

export type { DatePickerProps };
