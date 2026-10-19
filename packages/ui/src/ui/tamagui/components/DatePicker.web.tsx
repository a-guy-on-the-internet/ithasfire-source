// Web entrypoint for bundlers that prefer platform suffix resolution.
//
// IMPORTANT: Keep this as a thin re-export so we only maintain a single canonical
// DatePicker implementation (in `./DatePicker.tsx`).
//
// Use the explicit `.tsx` extension so Vite's `.web.tsx`-first resolution
// doesn't cycle back to this file.
// @ts-expect-error explicit .tsx extension needed for Vite's .web.tsx-first resolution
export { DatePicker } from "./DatePicker.tsx";
export type { DatePickerProps } from "./forms/DatePicker.types";
