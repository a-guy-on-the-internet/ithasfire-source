type ViewConfig = Record<string, unknown>;

const registry = new Map<string, ViewConfig>();

export const customBubblingEventTypes: Record<string, unknown> = {};
export const customDirectEventTypes: Record<string, unknown> = {};

export const register = (name: string, config: ViewConfig) => {
  registry.set(name, config);
};

export const get = (name: string): ViewConfig | undefined => registry.get(name);

export default {
  customBubblingEventTypes,
  customDirectEventTypes,
  register,
  get,
};
