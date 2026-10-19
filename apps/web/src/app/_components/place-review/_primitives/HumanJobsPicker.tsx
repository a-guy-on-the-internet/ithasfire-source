"use client";

import { useMemo } from "react";
import { Reveal, MultiChipGroup, useTranslations } from "@th/ui";
import { YStack } from "tamagui";
import {
  HUMAN_JOB_LABELS,
  isHumanJob,
  type HumanJob,
} from "@th/core/lib/human-jobs";
import { JOB_LABEL_KEYS } from "@/lib/human-job-i18n";
import { INPUT_STYLE } from "../_shared/tokens";

interface HumanJobsPickerProps {
  jobs: HumanJob[];
  otherJobDescription: string;
  onJobsChange: (jobs: HumanJob[]) => void;
  onOtherDescriptionChange: (desc: string) => void;
  error?: string;
  otherInputAriaLabel?: string;
  otherInputPlaceholder?: string;
  jobOptions?: Record<string, string>;
}

export function HumanJobsPicker({
  jobs,
  otherJobDescription,
  onJobsChange,
  onOtherDescriptionChange,
  error,
  otherInputAriaLabel,
  otherInputPlaceholder,
  jobOptions,
}: HumanJobsPickerProps) {
  const t = useTranslations();
  const showOther = jobs.includes("OTHER");
  const localizedJobOptions = useMemo(() => {
    if (jobOptions) return jobOptions;
    const entries = (Object.keys(HUMAN_JOB_LABELS) as HumanJob[]).map((job) => [
      job,
      String(t(JOB_LABEL_KEYS[job])) || HUMAN_JOB_LABELS[job],
    ]);
    return Object.fromEntries(entries) as Record<string, string>;
  }, [jobOptions, t]);

  return (
    <YStack gap={12}>
      <MultiChipGroup
        options={localizedJobOptions}
        value={jobs}
        onChange={(keys) => {
          const humanJobs = keys.filter(isHumanJob);
          onJobsChange(humanJobs);
          if (!humanJobs.includes("OTHER") && otherJobDescription) {
            onOtherDescriptionChange("");
          }
        }}
        fillContainer
        error={!!error}
      />
      <Reveal show={showOther}>
        <div style={{ paddingTop: 4 }}>
          <input
            type="text"
            enterKeyHint="done"
            aria-label={otherInputAriaLabel ?? "Describe your role"}
            value={otherJobDescription}
            onChange={(e) => onOtherDescriptionChange(e.target.value)}
            placeholder={
              otherInputPlaceholder ??
              "e.g. Tour manager, session player, merch runner…"
            }
            maxLength={120}
            style={INPUT_STYLE}
          />
        </div>
      </Reveal>
    </YStack>
  );
}
