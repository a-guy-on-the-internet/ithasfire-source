import type { DateInputValue } from "./DatePicker.types";
import type { DateDisplayFormat } from "./date-format";

export type DateRangeValue = {
  start?: DateInputValue;
  end?: DateInputValue;
};

export interface DateRangePickerProps {
  value?: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  alignment?: "vertical" | "horizontal";
  startLabel?: string;
  endLabel?: string;
  startPlaceholder?: string;
  endPlaceholder?: string;
  displayFormat?: DateDisplayFormat;
  /**
   * Styling hooks for merged-input layouts (e.g. Home hero search bar).
   * These should not affect the popover content.
   */
  triggerMinHeight?: number;
  triggerBorderRadius?: number;
  /** Overlap adjacent inputs by 1px to create a single seam. */
  marginLeft?: number;
  borderWidth?: number;
  borderColor?: string;
  testIdBase?: string;
  qaId?: string;
  forceOpen?: boolean;
}
