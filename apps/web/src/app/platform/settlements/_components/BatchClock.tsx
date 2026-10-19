"use client";

import { XStack } from "tamagui";
import { Badge, DateTime, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import { usePlatformTimeZone } from "./PayoutOwner";

// ─────────────────────────────────────────────────────────────────────────────
// "Next batch" — the clock on the owed half of the page.
//
// The owed table's blocker column is headed "Tonight's batch" and has always
// assumed the reader knows when tonight is. This says so.
//
// IT READS THE SCHEDULER, NOT A CONSTANT. The cron lives in
// `apps/jobs/jobs.manifest.json`, and hardcoding "midnight CT" here would keep
// rendering a time after somebody changed it, disabled it, or the jobs service
// stopped answering. `platformJobs.listStatus` proxies the jobs service's own
// `/jobs/status`, so a paused or OFF batch reads as such and an unreachable
// service reads as unknown — both of which a payout reader needs more than a
// confident wrong time.
//
// TWO DIFFERENT "OFF"s, and this reads both, in this order:
//   1. The payload's TOP-LEVEL `enabled` is the RUNTIME pause staff set from
//      /platform/jobs (`platformJobs.toggleEnabled` → run tracker), which the
//      runner honours as `job_skipped_disabled`. Until 2026-09-15 this clock
//      never read it: pause the batch on the jobs page and this kept saying
//      "Next batch · <date>".
//   2. `schedule.enabled` is the MANIFEST default (`"enabled": false` in
//      jobs.manifest.json, via `getSchedule`) — the "scheduled but switched
//      off at the source" state. It is `true` for every job today.
// Both are rendered BEFORE any date, because a date beside a batch that will
// not run is the confident wrong time this component exists to avoid.
//
// (The value it reports was wrong until 2026-09-14: `nextCronRun` took a
// timezone and ignored it, computing in the SERVER's zone. On Cloud Run that
// put this batch's next run at 7:00 PM CT instead of midnight CT. Fixed in
// `apps/jobs/src/lib/cron-schedule.ts`; do not reintroduce a local cron
// calculation here.)
//
// ONE MORE THING IT CANNOT SEE: `/jobs/status` reports the MANIFEST cron,
// while Terraform can override a cron per environment
// (`jobs_scheduler_overrides` in `infra/terraform/envs/*/`). Such overrides
// exist today, each declared on its manifest entry as `schedulerOverriddenIn`;
// `settlements.run-batch` is not among them, so this clock is right. What
// keeps it right is the drift gate in
// `apps/jobs/src/scripts/validate-manifest.ts` (section 5), which fails the
// pre-commit hook and the deploy workflows' `manifest_drift_guard` job if an
// override is added without its declaration. The truth stays in one place;
// this component does not invent a second one.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_JOB_NAME = "settlements.run-batch";

export function BatchClock() {
  const t = useTranslations();
  const { timeZone, resolved } = usePlatformTimeZone();

  // Shared query key with /platform/jobs, so this is usually a cache hit
  // rather than a second cross-service hop.
  const query = trpc.platformJobs.listStatus.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  // Unknown NEVER renders as a time. A failed read, a job the registry does
  // not know, and a job with no schedule are three different facts and each
  // says which one it is — none of them degrades to a confident date.
  if (query.isLoading) return null;

  if (query.isError) {
    return (
      <Badge tone="warning" size="sm">
        {String(t("admin.pstClockUnknown"))}
      </Badge>
    );
  }

  const job = query.data?.jobs.find((j) => j.name === BATCH_JOB_NAME);
  if (!job) {
    return (
      <Badge tone="warning" size="sm">
        {String(t("admin.pstClockUnknown"))}
      </Badge>
    );
  }

  // The runtime pause is the loudest state on this component: money is
  // accruing against a batch that will not run, every "Payable now" figure
  // beside it is an input to a run that is not coming, and somebody set this
  // by hand on the jobs page — so it names where to undo it. Checked before
  // the schedule shape because it applies whatever the schedule says.
  if (job.enabled === false) {
    return (
      <Badge tone="danger" size="sm">
        {String(t("admin.pstClockPaused"))}
      </Badge>
    );
  }

  const schedule = job.schedule;
  if (!schedule) {
    return (
      <Badge tone="danger" size="sm">
        {String(t("admin.pstClockUnscheduled"))}
      </Badge>
    );
  }

  // The manifest-level OFF: scheduled, but switched off at the source.
  if (schedule.enabled === false) {
    return (
      <Badge tone="danger" size="sm">
        {String(t("admin.pstClockDisabled"))}
      </Badge>
    );
  }

  // `nextRun` is null for cron shapes the jobs service cannot project, and
  // for those `cronDescription` is the RAW CRON STRING (`describeCron` and
  // `nextCronRun` share one parser and refuse the same shapes). Rendering
  // that under the "NEXT BATCH" label read as "NEXT BATCH 0 0 * 1 *" — a
  // time-shaped answer for a batch whose next run is unknown. Say that it is
  // unknown, with the badge, and show the cron as evidence beside it.
  if (!schedule.nextRun) {
    return (
      <XStack
        gap="$2"
        alignItems="baseline"
        flexWrap="wrap"
        // Tamagui stacks default to flexShrink 0. Inside the page's flex-end
        // wrapper this row kept its max-content width and overflowed LEFT at
        // 320px (measured: left = -187px, the label fully off-screen) — an
        // overflow scrollWidth cannot see. Shrink, then wrap.
        flexShrink={1}
        minWidth={0}
        maxWidth="100%"
      >
        <Badge tone="warning" size="sm">
          {String(t("admin.pstClockUnprojectable"))}
        </Badge>
        <Text variant="caption" tone="muted" fontFamily="$mono">
          {schedule.cronDescription}
        </Text>
      </XStack>
    );
  }

  return (
    <XStack
      gap="$2"
      alignItems="baseline"
      flexWrap="wrap"
      // See the shrink note on the unprojected branch above: without
      // flexShrink the row overflows LEFT of a 320px viewport.
      flexShrink={1}
      minWidth={0}
      maxWidth="100%"
    >
      <Text variant="caption" tone="muted" textTransform="uppercase">
        {String(t("admin.pstClockNext"))}
      </Text>
      {/* Zone-dependent text is withheld until the reader's zone resolves
          AFTER mount — see `usePlatformTimeZone`. Rendering it during SSR
          formats in the SERVER's zone and hydrates in the BROWSER's, which
          mismatches for every reader outside the server's zone and is
          invisible in local dev, where they are the same machine. */}
      {resolved ? (
        <DateTime
          value={new Date(schedule.nextRun)}
          timeZone={timeZone}
          format="meta"
          variant="bodySmall"
          weight="bold"
          style={{ whiteSpace: "nowrap" }}
          fontFamily="$mono"
        />
      ) : null}
      <Text variant="caption" tone="muted">
        {schedule.cronDescription}
      </Text>
    </XStack>
  );
}
