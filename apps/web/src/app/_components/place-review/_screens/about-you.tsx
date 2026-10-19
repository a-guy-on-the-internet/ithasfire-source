"use client";

import { YStack } from "tamagui";

import type { ScreenDef } from "../_shared/types";
import { FG } from "../_shared/tokens";
import { HumanJobsPicker } from "../_primitives/HumanJobsPicker";
import { TrustLine } from "../_primitives/TrustLine";

// ─────────────────────────────────────────────────────────────────────────────
// About You screen — step 0, before venue selection
//
// Multi-select chips for job roles. Conditionally reveals genre picker
// (when MUSICIAN is selected) and freeform description (when OTHER is selected).
//
// When the caller already knows the venue (the "Rate this place" block on a
// place page, or a ?placeId= deep link), the "Where did you play?" screen is
// dropped from the flow — so this screen becomes step 0 and takes over the two
// jobs that screen used to do: confirming WHICH venue is being reviewed, and
// carrying the anonymity promise.
// ─────────────────────────────────────────────────────────────────────────────

export function buildAboutYouScreen({
  knownPlace = false,
}: { knownPlace?: boolean } = {}): ScreenDef {
  return {
    id: "aboutYou",
    phase: "core",
    question: "What do you do?",
    helper: "Helps us ask the right questions. Pick all that apply.",
    required: true,
    validate: (d) =>
      d.humanJobs.length === 0 ? "Pick at least one" : undefined,
    render: (d, onChange, error) => (
      <YStack gap={16}>
        {knownPlace && (
          <YStack gap={8}>
            {d.placeName && (
              <div
                style={{
                  fontSize: 13,
                  color: FG,
                  letterSpacing: "0.02em",
                  fontFamily: "var(--font-body, Inter, sans-serif)",
                }}
              >
                You&rsquo;re reviewing{" "}
                <strong style={{ fontWeight: 800 }}>{d.placeName}</strong>.
              </div>
            )}
            <TrustLine>
              <strong style={{ color: FG, fontWeight: 800 }}>
                100% anonymous.
              </strong>{" "}
              Your identity is never attached to your review.
            </TrustLine>
          </YStack>
        )}
        <HumanJobsPicker
          jobs={d.humanJobs}
          otherJobDescription={d.humanOtherJobDescription}
          onJobsChange={(jobs) => onChange({ humanJobs: jobs })}
          onOtherDescriptionChange={(desc) =>
            onChange({ humanOtherJobDescription: desc })
          }
          error={error}
        />
      </YStack>
    ),
  };
}

export const ABOUT_YOU_SCREEN: ScreenDef = buildAboutYouScreen();
