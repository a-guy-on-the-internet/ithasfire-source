export * from "./AmountInput";
export * from "./AutocompleteField";
export * from "./Button";
export * from "./ButtonGroup";
export * from "./MenuButton";
export * from "./Checkbox";
export * from "./DateRangePicker";
export * from "./labeledtextinput";
export * from "./LabeledPasswordInput";
export * from "./PasswordInput";
export * from "./PhoneNumberInput";
export * from "./QuantityStepper";
export * from "./Radio";
export * from "./RangeSlider";
export * from "./StyledSelect";
export * from "./Switch";
export * from "./TextInput";
export * from "./UploadModeToggle";

// DatePicker (single date) lives in parent folder with platform-specific entrypoints.
// Use import-then-export (direct binding) instead of `export { X } from` (indirect
// binding) so that `export *` in parent barrels can always resolve the name
// synchronously — avoids "Indirectly exported binding name 'DatePicker' is not found"
// in Vite's ESM dev server.
import { DatePicker } from "../DatePicker";
export { DatePicker };
export type { DatePickerProps } from "./DatePicker.types";

// v3 form primitives
export * from "./FieldLabel";
export * from "./CharCountTextarea";
export * from "./ChipGroup";
export * from "./MultiChipGroup";
export * from "./TagMultiSelect";
export * from "./GroupedMultiSelect";
export * from "./StarRating";
export * from "./ValidationSummary";

// DayOfWeekSelect — direct binding to avoid Vite ESM "binding not found" error
// (same pattern as DatePicker above)
import { DayOfWeekSelect } from "./DayOfWeekSelect";
export { DayOfWeekSelect };
export type { DayOfWeekSelectProps } from "./DayOfWeekSelect";

// Re-export tamagui's Input component for convenience
import { Input } from "tamagui";
export { Input };
export type { InputProps } from "tamagui";
