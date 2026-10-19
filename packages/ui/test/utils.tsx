import { render } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import type { FC, ReactElement, ReactNode } from "react";

import {
  IthasFireProvider,
  type IthasFireProviderProps,
} from "../src/ui/tamagui";

type ProviderOverrides = Partial<Omit<IthasFireProviderProps, "children">>;

type ExtendedRenderOptions = Omit<RenderOptions, "wrapper"> & {
  providerProps?: ProviderOverrides;
};

export const renderWithProvider = (
  ui: ReactElement,
  options?: ExtendedRenderOptions,
): ReturnType<typeof render> => {
  const { providerProps, ...renderOptions } = options ?? {};

  const ProviderWrapper: FC<{ children: ReactNode }> = ({ children }) => (
    <IthasFireProvider {...providerProps}>{children}</IthasFireProvider>
  );

  return render(ui, {
    wrapper: ProviderWrapper,
    ...renderOptions,
  });
};
