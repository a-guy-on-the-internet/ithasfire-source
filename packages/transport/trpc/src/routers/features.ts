import {
  getFeatureGates,
  getFeatureGatesOutputSchema,
} from "@th/core/use-cases/features";

import { proc } from "../init";

export const featuresRouter = {
  getFeatureGates: proc
    .output(getFeatureGatesOutputSchema)
    .query(async ({ ctx }) => {
      return getFeatureGates({
        routing: ctx.routing ?? undefined,
        enableCreateEvents: ctx.enableCreateEvents,
        enableBuyTickets: ctx.enableBuyTickets,
        enableMaintenanceMode: ctx.enableMaintenanceMode,
        enableUnifiedScanResolver: ctx.enableUnifiedScanResolver,
        enableWaivers: ctx.enableWaivers,
        enableEntityPageEditor: ctx.enableEntityPageEditor,
        enableBroadcasts: ctx.enableBroadcasts,
        enableResale: ctx.enableResale,
        enableHumanProfilesPublic: ctx.enableHumanProfilesPublic,
        enableWaitlists: ctx.enableWaitlists,
        smsConfigured: ctx.smsConfigured,
        platformSettings: ctx.repos.platformSettings,
        reportError: ctx.reportError ?? undefined,
      });
    }),
};
