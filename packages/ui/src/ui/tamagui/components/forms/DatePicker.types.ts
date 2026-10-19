import type { DateDisplayFormat } from "./date-format";

export type DateInputValue = string | undefined;

export interface DatePickerProps {
  value?: DateInputValue;
  onChange: (value: DateInputValue) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  id?: string;
  testId?: string;
  qaId?: string;
  displayFormat?: DateDisplayFormat;
  variant?: "picker" | "input";
  label?: string;
  alignment?: "horizontal" | "vertical";
  forceOpen?: boolean;
  triggerTestId?: string;
  triggerQaId?: string;
}
