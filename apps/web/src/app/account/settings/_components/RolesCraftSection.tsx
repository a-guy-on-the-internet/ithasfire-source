"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { YStack, XStack } from "tamagui";
import { Briefcase } from "lucide-react";
import { GENRE_JOBS, isHumanJob, type HumanJob } from "@th/core/lib/human-jobs";
import {
  Text,
  Spinner,
  TagMultiSelect,
  useTranslations,
} from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { trpc } from "@/trpc";
import { HumanJobsPicker } from "../../../_components/place-review/_primitives/HumanJobsPicker";
import { DEFAULT_GENRE_TAGS } from "../../../_components/place-review/_shared/labels";
import { isGenreTagAllowed } from "../../../_components/place-review/_shared/genre-filter";
import { SectionCard } from "./settings-primitives";

type JobsPayload = {
  jobs: HumanJob[];
  genreTags: string[];
  otherJobDescription: string | undefined;
};

const DEBOUNCE_MS = 800;
const SAVED_STATUS_MS = 1800;

/**
 * "Roles & craft" — what the user *does*, split out of ProfileSection so a
 * ticket buyer isn't asked to classify their craft next to their display name.
 *
 * Everything here auto-saves: a debounce fires `humans.updateJobs`, and
 * `workRequestVersionRef` discards any response that is no longer the newest
 * in-flight request so a slow save can't clobber newer local state.
 * `humans.getMyProfile` is shared with BillingSection — react-query dedupes it.
 *
 * Two things about the debounce that are load-bearing, both of which broke when
 * settings became one route per section:
 *
 *  1. Unmount FLUSHES, it does not cancel. The status line says "Saving
 *     changes…" the instant a chip is toggled, so cancelling on unmount told
 *     the user their edit was saved while silently dropping it. On the old
 *     single-scroll page the only unmount was leaving settings entirely; now
 *     every nav row is an unmount trigger sitting 200px from the chips.
 *  2. The debounce effect's dependency array contains only referentially
 *     STABLE values. `useMutation()`'s result and the tRPC `utils` proxy are
 *     both fresh objects on every render — putting them in the array re-armed
 *     the timer on every commit, so a save slower than the debounce re-fired
 *     itself for as long as latency exceeded it. They live in refs instead.
 */
export function RolesCraftSection() {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const sessionQuery = authClient.useSession();
  const isAuthenticated = Boolean(sessionQuery.data?.user);

  const [jobs, setJobs] = useState<HumanJob[]>([]);
  const [genreTags, setGenreTags] = useState<string[]>([]);
  const [otherJobDescription, setOtherJobDescription] = useState("");
  const [workInitialized, setWorkInitialized] = useState(false);
  const [workSaveState, setWorkSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const workSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkKeyRef = useRef("");
  const lastSavedWorkKeyRef = useRef("");
  const workRequestVersionRef = useRef(0);
  /** The edit waiting out the debounce. Survives the effect's own cleanup. */
  const pendingSaveRef = useRef<{ payload: JobsPayload; key: string } | null>(
    null,
  );
  const mountedRef = useRef(true);

  const humanProfileQuery = trpc.humans.getMyProfile.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
    enabled: isAuthenticated,
  });

  useEffect(() => {
    if (workInitialized || !humanProfileQuery.data) return;
    const nextJobs = humanProfileQuery.data.jobs.filter(isHumanJob);
    const nextGenreTags = humanProfileQuery.data.genreTags ?? [];
    const nextOtherJobDescription =
      humanProfileQuery.data.otherJobDescription ?? "";
    setJobs(nextJobs);
    setGenreTags(nextGenreTags);
    setOtherJobDescription(nextOtherJobDescription);
    lastSavedWorkKeyRef.current = JSON.stringify({
      jobs: nextJobs,
      genreTags: nextGenreTags,
      other: nextOtherJobDescription,
    });
    setWorkInitialized(true);
  }, [workInitialized, humanProfileQuery.data]);

  const updateJobsMutation = trpc.humans.updateJobs.useMutation();

  // ── "Latest value" refs ────────────────────────────────────────────────
  // Neither of these is referentially stable: react-query's `useMutation`
  // returns a fresh object literal per render, and `utils.humans.getMyProfile`
  // is a tRPC recursive-proxy property access that yields a new reference on
  // every read. Keeping them OUT of the debounce effect's dependency array is
  // the whole point — see the component docstring. Assigned in a
  // dependency-less effect (runs after every commit) rather than during
  // render, so the refs are never mutated mid-render.
  const mutationRef = useRef(updateJobsMutation);
  const utilsRef = useRef(utils);
  useEffect(() => {
    mutationRef.current = updateJobsMutation;
    utilsRef.current = utils;
  });

  /**
   * Send whatever edit is pending, if any. Stable across renders: everything it
   * touches is a ref, so it can sit in a dependency array and can be safely
   * called from an unmount cleanup.
   */
  const flushPendingSave = useCallback((isUnmounting: boolean) => {
    const pending = pendingSaveRef.current;
    if (!pending || pending.key === lastSavedWorkKeyRef.current) return;

    pendingSaveRef.current = null;
    if (workSaveTimerRef.current) {
      clearTimeout(workSaveTimerRef.current);
      workSaveTimerRef.current = null;
    }

    const { payload, key } = pending;
    const requestVersion = ++workRequestVersionRef.current;
    pendingWorkKeyRef.current = key;

    mutationRef.current.mutate(payload, {
      onSuccess: () => {
        if (requestVersion !== workRequestVersionRef.current) return;
        lastSavedWorkKeyRef.current = key;
        utilsRef.current.humans.getMyProfile.setData(undefined, (prev) =>
          prev
            ? {
                ...prev,
                jobs: payload.jobs,
                genreTags: payload.genreTags,
                otherJobDescription: payload.otherJobDescription ?? "",
              }
            : prev,
        );
        if (!mountedRef.current) return;
        setWorkSaveState("saved");
        if (workStatusTimerRef.current) clearTimeout(workStatusTimerRef.current);
        workStatusTimerRef.current = setTimeout(() => {
          setWorkSaveState("idle");
        }, SAVED_STATUS_MS);
      },
      onError: () => {
        if (requestVersion !== workRequestVersionRef.current) return;
        if (!mountedRef.current) return;
        setWorkSaveState("error");
      },
    });

    if (isUnmounting) {
      // The request is away, but this component is gone and react-query may
      // never deliver `onSuccess` to a torn-down observer — so the optimistic
      // cache write above can't be relied on. Mark the profile stale WITHOUT
      // refetching (nothing is observing it, and a refetch now would race the
      // in-flight mutation) so the next mount reads truth from the server
      // instead of showing pre-edit chips for the 60s staleTime.
      void utilsRef.current.humans.getMyProfile.invalidate(undefined, {
        refetchType: "none",
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (workStatusTimerRef.current) clearTimeout(workStatusTimerRef.current);
      // FLUSH, don't cancel. `flushPendingSave` clears the debounce timer
      // itself, so this is independent of the order React runs the two
      // cleanups in.
      flushPendingSave(true);
    };
  }, [flushPendingSave]);

  useEffect(() => {
    if (!workInitialized || !humanProfileQuery.data) return;

    const payload: JobsPayload = {
      jobs,
      genreTags,
      otherJobDescription: otherJobDescription.trim() || undefined,
    };
    const key = JSON.stringify({
      jobs: payload.jobs,
      genreTags: payload.genreTags,
      other: payload.otherJobDescription ?? "",
    });
    if (key === lastSavedWorkKeyRef.current) {
      // Edited back to the saved value — there is nothing left to flush.
      pendingSaveRef.current = null;
      return;
    }

    pendingSaveRef.current = { payload, key };
    if (workSaveTimerRef.current) clearTimeout(workSaveTimerRef.current);
    setWorkSaveState("saving");
    workSaveTimerRef.current = setTimeout(() => {
      flushPendingSave(false);
    }, DEBOUNCE_MS);

    return () => {
      // Cancels only the TIMER. `pendingSaveRef` deliberately survives, so an
      // unmount inside the debounce window still has an edit to flush.
      if (workSaveTimerRef.current) {
        clearTimeout(workSaveTimerRef.current);
        workSaveTimerRef.current = null;
      }
    };
  }, [
    // Every entry here is referentially stable: react-query gives
    // `humanProfileQuery.data` structural sharing, the three state values are
    // plain state, and `flushPendingSave` is an empty-dependency callback.
    humanProfileQuery.data,
    jobs,
    genreTags,
    otherJobDescription,
    workInitialized,
    flushPendingSave,
  ]);

  const handleJobsChange = useCallback((nextJobs: HumanJob[]) => {
    setWorkInitialized(true);
    setJobs(nextJobs);
    if (!nextJobs.some((job) => GENRE_JOBS.has(job as any))) {
      setGenreTags([]);
    }
  }, []);

  const handleGenreTagsChange = useCallback((tags: string[]) => {
    setWorkInitialized(true);
    const safe = tags.filter(
      (tag) =>
        DEFAULT_GENRE_TAGS.some(
          (defaultTag) => defaultTag.toLowerCase() === tag.toLowerCase(),
        ) || isGenreTagAllowed(tag),
    );
    setGenreTags(safe);
  }, []);

  const handleOtherDescriptionChange = useCallback(
    (nextDescription: string) => {
      setWorkInitialized(true);
      setOtherJobDescription(nextDescription);
    },
    [],
  );

  const workStatusText =
    workSaveState === "saving"
      ? String(t("account.sWorkSaving"))
      : workSaveState === "saved"
        ? String(t("account.sWorkSaved"))
        : workSaveState === "error"
          ? String(t("account.sWorkSaveFailed"))
          : null;
  const showGenreSettings = jobs.some((job) => GENRE_JOBS.has(job as any));

  return (
    <SectionCard>
      <XStack
        alignItems="center"
        justifyContent="space-between"
        gap="$2"
        flexWrap="wrap"
      >
        <XStack gap="$2" alignItems="center">
          <Briefcase size={18} color="$colorMuted" />
          <Text variant="h4" weight="bold">
            {String(t("account.sRolesCraftTitle"))}
          </Text>
        </XStack>

        {/* Live region, ALWAYS mounted.
            This card auto-saves, so the status changes with no user-initiated
            navigation or submit — an assistive-tech user gets no confirmation
            at all unless it is announced. It was previously plain text with no
            live region anywhere in its ancestry (measured in the browser: the
            nearest `role="status"`/`aria-live` ancestor was `null`), so the
            only thing announced during a save was the spinner's own
            `aria-label="spinner"`.
            Mounted unconditionally rather than swapped in with the text: a
            live region has to exist BEFORE its content changes, or the change
            that inserted it is not announced. `aria-hidden` on the spinner
            stops it competing inside the region. */}
        <XStack
          gap="$2"
          alignItems="center"
          role="status"
          aria-live="polite"
          data-testid="work-save-status"
        >
          {workSaveState === "saving" ? (
            <XStack aria-hidden>
              <Spinner size="sm" />
            </XStack>
          ) : null}
          {workStatusText ? (
            /* `dangerSoft`, not the accent hue: a failed save is an error,
               not a brand moment, and `brandSecondary` at caption size is
               3.57:1 on Stub — under the AA floor. `dangerSoft` is the danger
               hue at small-text legibility in every theme (plain `danger` is
               only ~4.0:1 as text on Ember). */
            <Text
              variant="caption"
              weight="medium"
              color={workSaveState === "error" ? "$dangerSoft" : "$color"}
            >
              {workStatusText}
            </Text>
          ) : null}
        </XStack>
      </XStack>

      {/* Reuses the old in-Profile copy verbatim — it already describes exactly
          this card ("pick the roles that fit you best; we save automatically"),
          so no near-duplicate key was minted. */}
      <Text variant="bodySmall" tone="muted">
        {String(t("account.sWorkDescription"))}
      </Text>

      <HumanJobsPicker
        jobs={jobs}
        otherJobDescription={otherJobDescription}
        onJobsChange={handleJobsChange}
        onOtherDescriptionChange={handleOtherDescriptionChange}
        otherInputAriaLabel={String(t("account.sWorkOtherLabel"))}
        otherInputPlaceholder={String(t("account.sWorkOtherPlaceholder"))}
      />

      {showGenreSettings ? (
        <YStack gap="$2">
          <Text variant="caption" color="$colorMuted">
            {String(t("account.sGenresDescription"))}
          </Text>
          <TagMultiSelect
            availableTags={DEFAULT_GENRE_TAGS}
            value={genreTags}
            onChange={handleGenreTagsChange}
            // DevTools flags a form field with neither id nor name.
            inputName="genre-search"
            placeholder={String(t("account.sGenresPlaceholder"))}
          />
        </YStack>
      ) : null}
    </SectionCard>
  );
}
