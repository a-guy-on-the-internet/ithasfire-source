import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Platform-level footer defaults injected at render time so every template's
 * footer carries a real mailing address + contact line (CAN-SPAM) without each
 * use case threading them through. Structurally mirrors `EmailFooterDefaults`
 * in `@th/ports/comms/footer-defaults`.
 *
 * Implemented with AsyncLocalStorage rather than React Context: the render
 * chokepoint is imported by a Next.js server route, and any module that
 * imports `createContext` is rejected under the `react-server` condition.
 * ALS carries the defaults across the synchronous `renderToStaticMarkup` pass
 * without that constraint.
 */
export type EmailFooterDefaults = {
  physicalAddress?: string;
  contactEmail?: string;
  brandName?: string;
};

const storage = new AsyncLocalStorage<EmailFooterDefaults>();

export const runWithFooterDefaults = <T>(
  defaults: EmailFooterDefaults,
  fn: () => T,
): T => storage.run(defaults, fn);

export const getFooterDefaults = (): EmailFooterDefaults | null =>
  storage.getStore() ?? null;
