/**
 * E2E route barrel.
 *
 * Registers every sub-plugin so `app.ts` only needs a single import.
 * Each module is a plain `FastifyPluginAsync` — we wrap the whole group
 * with `fastify-plugin` so route prefixes propagate correctly.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import resetAndAuth from "./reset-and-auth.js";
import seedPaidCheckout from "./seed-paid-checkout.js";
import seedUnifiedSearch from "./seed-unified-search.js";
import orderActions from "./order-actions.js";
import settlements from "./settlements.js";
import seedCartRecovery from "./seed-cart-recovery.js";
import seedGatedEvent from "./seed-gated-event.js";
import stripe from "./stripe.js";
import seedAdminTables from "./seed-admin-tables.js";
import seedPlatformTables from "./seed-platform-tables.js";
import seedEventBuilder from "./seed-event-builder.js";
import seedVenueCalendar from "./seed-venue-calendar.js";
import seedEventSeries from "./seed-event-series.js";
import seedPublicSeries from "./seed-public-series.js";
import seedPlaceLayoutDesigner from "./seed-place-layout-designer.js";
import seedAdjustableCheckout from "./seed-adjustable-checkout.js";
import seedBookingLoop from "./seed-booking-loop.js";
import seedVenueCellCreate from "./seed-venue-cell-create.js";
const e2ePlugin: FastifyPluginAsync = async (app) => {
  await app.register(resetAndAuth);
  await app.register(seedPaidCheckout);
  await app.register(seedUnifiedSearch);
  await app.register(orderActions);
  await app.register(settlements);
  await app.register(seedCartRecovery);
  await app.register(seedGatedEvent);
  await app.register(stripe);
  await app.register(seedAdminTables);
  await app.register(seedPlatformTables);
  await app.register(seedEventBuilder);
  await app.register(seedVenueCalendar);
  await app.register(seedEventSeries);
  await app.register(seedPublicSeries);
  await app.register(seedPlaceLayoutDesigner);
  await app.register(seedAdjustableCheckout);
  await app.register(seedBookingLoop);
  await app.register(seedVenueCellCreate);
};

export default fp(e2ePlugin as unknown as never) as unknown as never;
