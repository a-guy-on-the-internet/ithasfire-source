"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { YStack, XStack, styled } from "tamagui";
import {
  Alert,
  Badge,
  Button,
  LabeledTextInput,
  Modal,
  Spinner,
  Switch,
  Text,
  useLocale,
  useTranslations,
} from "@th/ui";
import {
  BadgeCheck,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Trash2,
  Upload,
} from "lucide-react";

import { trpc } from "@/trpc";
import { normalizeError } from "@/lib/errors/normalize-error";
import {
  formatRetryIn,
  isRateLimited,
  readRetryAt,
} from "@/components/places/place-or-address.helpers";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";
import { formatBytes } from "@/lib/format";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";

// ─── Constants ───────────────────────────────────────────────────────────────

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const);
type AllowedType = "application/pdf" | "image/jpeg" | "image/png";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;
/** Org roles that may claim on behalf of an org (mirrors core ORG_ADMIN_ROLES). */
const ORG_ADMIN_ROLES = new Set(["OWNER", "ADMIN"]);

// Web-only a11y props (role, tabIndex, aria, onKeyDown) that Tamagui's Stack
// surface doesn't type. Cast to `object` so they pass through to the DOM —
// mirrors the pattern used in PlatformVerificationQueue's QueueRow.
const webA11y = (props: Record<string, unknown>): object => props;

type ProofMethod = "domain" | "challenge" | "document";
type Step = "owner" | "proof";

type OwnerOption =
  | { key: string; label: string; owner: { kind: "human"; humanId: string } }
  | { key: string; label: string; owner: { kind: "org"; orgId: string } };

type StagedFile = { id: string; file: File };

type Props = {
  placeId: string;
  placeName: string;
  open: boolean;
  domainProofAvailable: boolean;
  fastTrackEligible: boolean;
  onClose: () => void;
  onClaimed: () => void;
};

// ─── Styled ──────────────────────────────────────────────────────────────────

const DropZone = styled(YStack, {
  name: "ClaimDropZone",
  borderWidth: 2,
  borderStyle: "dashed",
  borderColor: "$borderColor",
  padding: "$4",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  cursor: "pointer",
  minHeight: 108,
  hoverStyle: {
    borderColor: "$borderColorStrong",
    backgroundColor: "$surfaceMuted",
  },
});

const FileRow = styled(XStack, {
  name: "ClaimFileRow",
  padding: "$2",
  paddingHorizontal: "$3",
  borderWidth: 1,
  borderColor: "$borderColor",
  alignItems: "center",
  gap: "$2",
  backgroundColor: "$surface",
});

const MethodButton = ({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) => (
  <Button
    variant={active ? "primary" : "outlined"}
    size="$2"
    onPress={onPress}
    aria-pressed={active}
    flexGrow={1}
  >
    {label}
  </Button>
);

// ─── Component ───────────────────────────────────────────────────────────────

export function ClaimVenueWizard({
  placeId,
  placeName,
  open,
  domainProofAvailable,
  fastTrackEligible,
  onClose,
  onClaimed,
}: Props) {
  const t = useTranslations();
  const tk = t as unknown as (key: string) => string;
  const locale = useLocale();

  const ownersQuery = useEventOwnerEntities({ enabled: open });

  const ownerOptions = useMemo<OwnerOption[]>(() => {
    const owners = ownersQuery.ownersWithSlugs ?? [];
    const options: OwnerOption[] = [];
    const human = owners.find((o) => o.kind === "human");
    // The canonical human id must come from the owner-entities query — the
    // Better Auth user id is NOT guaranteed to equal the human id in prod.
    if (human?.kind === "human") {
      options.push({
        key: `human:${human.humanId}`,
        label: String(t("places.claimOwnerSelf")),
        owner: { kind: "human", humanId: human.humanId },
      });
    }
    for (const o of owners) {
      if (o.kind === "org" && ORG_ADMIN_ROLES.has(o.role)) {
        options.push({
          key: `org:${o.orgId}`,
          label: o.orgName,
          owner: { kind: "org", orgId: o.orgId },
        });
      }
    }
    return options;
  }, [ownersQuery.ownersWithSlugs, t]);

  // ── Local wizard state ──────────────────────────────────────────────────
  const [step, setStep] = useState<Step>("owner");
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [method, setMethod] = useState<ProofMethod>(
    domainProofAvailable ? "domain" : "document",
  );
  const [challengeEmail, setChallengeEmail] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    autoVerified: boolean;
    communityListingCount: number;
  } | null>(null);
  /**
   * FR-005, fast-track arm only. Local, NOT read back from a query: the place
   * was verified milliseconds ago and `getPlaceForEdit` is a separate cache
   * entry this modal never subscribes to, so there is nothing to stay in sync
   * with. The switch on the bookings page owns the durable state; this is the
   * one-time ask, and it writes through the same mutation.
   */
  const [claimAcceptsCommunity, setClaimAcceptsCommunity] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Default the owner selection once options resolve.
  useEffect(() => {
    if (ownerKey === null && ownerOptions.length > 0) {
      setOwnerKey(ownerOptions[0]!.key);
    }
  }, [ownerKey, ownerOptions]);

  // Reset everything each time the wizard is (re)opened.
  useEffect(() => {
    if (!open) return;
    setStep("owner");
    setOwnerKey(null);
    setMethod(domainProofAvailable ? "domain" : "document");
    setChallengeEmail("");
    setChallengeId(null);
    setCode("");
    setStagedFiles([]);
    setFormError(null);
    setResult(null);
    setClaimAcceptsCommunity(false);
    setIsUploading(false);
  }, [open, domainProofAvailable]);

  // Focus management: move focus to the step heading on open / step change.
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open, step, result]);

  const selectedOwner = useMemo(
    () => ownerOptions.find((o) => o.key === ownerKey) ?? null,
    [ownerOptions, ownerKey],
  );

  // ── Mutations ────────────────────────────────────────────────────────────
  const submitClaim = trpc.places.submitPlaceClaim.useMutation({
    retry: false,
    meta: { silent: true },
  });
  /**
   * FR-005's claim-time ask. Fires ONLY on the fast-track arm, where the place
   * is already VERIFIED — the backend refuses to enable on anything else with
   * `PLACE_NOT_VERIFIED`, so offering it on the pending arm would be offering a
   * control that cannot work. The pending arm names the decision instead and
   * hands it to the bookings page, which is also where the count is accurate:
   * a number shown at claim time is a guess about how long review takes.
   */
  const setCommunityAcceptance =
    trpc.places.setCommunityListingAcceptance.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const requestChallenge = trpc.places.requestClaimEmailChallenge.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const confirmChallenge = trpc.places.confirmClaimEmailChallenge.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const presign = trpc.places.requestClaimDocUpload.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const busy =
    submitClaim.isPending ||
    requestChallenge.isPending ||
    confirmChallenge.isPending ||
    isUploading;

  const showError = useCallback(
    (err: unknown) => {
      setFormError(
        normalizeError(err, tk).formError ?? String(t("errors.generic")),
      );
    },
    [t, tk],
  );

  /**
   * The claim writes are rate-limited: a per-person hourly bucket on
   * `submitPlaceClaim` and another on `requestClaimEmailChallenge`, plus a
   * per-person-per-place bucket (20 a minute) on the `requestClaimDocUpload`
   * presign. The
   * refusal carries only server English with the wait in seconds, so each gets
   * its own line here, with the wait in minutes or hours. Every other error
   * goes through `showError` unchanged.
   */
  const showLimitedError = useCallback(
    (kind: "claim" | "code" | "upload") => (err: unknown) => {
      if (!isRateLimited(err)) {
        showError(err);
        return;
      }
      const now = new Date();
      const retryAt = readRetryAt(err, now);
      if (!retryAt) {
        setFormError(
          kind === "claim"
            ? String(t("places.claimRateLimitedNoTime"))
            : kind === "code"
              ? String(t("places.claimCodeRateLimitedNoTime"))
              : String(t("places.claimUploadRateLimitedNoTime")),
        );
        return;
      }
      const when = formatRetryIn(retryAt, now, locale);
      setFormError(
        kind === "claim"
          ? String(t("places.claimRateLimited", { when }))
          : kind === "code"
            ? String(t("places.claimCodeRateLimited", { when }))
            : String(t("places.claimUploadRateLimited", { when })),
      );
    },
    [showError, t, locale],
  );
  const showClaimError = useMemo(
    () => showLimitedError("claim"),
    [showLimitedError],
  );
  const showCodeError = useMemo(
    () => showLimitedError("code"),
    [showLimitedError],
  );
  const showUploadError = useMemo(
    () => showLimitedError("upload"),
    [showLimitedError],
  );

  // ── File handling ──────────────────────────────────────────────────────
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const next: StagedFile[] = [];
      for (let file of Array.from(files)) {
        if (stagedFiles.length + next.length >= MAX_FILES) break;
        try {
          file = await prepareImageForUpload(file);
        } catch {
          setFormError(
            String(t("places.claimFileUnsupported", { fileName: file.name })),
          );
          continue;
        }
        if (!ALLOWED_TYPES.has(file.type as AllowedType)) {
          setFormError(
            String(t("places.claimFileUnsupported", { fileName: file.name })),
          );
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          setFormError(
            String(t("places.claimFileTooLarge", { fileName: file.name })),
          );
          continue;
        }
        next.push({ id: crypto.randomUUID(), file });
      }
      if (next.length > 0) setStagedFiles((prev) => [...prev, ...next]);
    },
    [stagedFiles, t],
  );

  const removeFile = useCallback((id: string) => {
    setStagedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  // ── Submit paths ───────────────────────────────────────────────────────
  const finalize = useCallback(
    (res: { autoVerified: boolean; communityListingCount: number }) => {
      setResult({
        autoVerified: res.autoVerified,
        communityListingCount: res.communityListingCount,
      });
      onClaimed();
    },
    [onClaimed],
  );

  const submitDomainMatch = useCallback(() => {
    if (!selectedOwner) return;
    setFormError(null);
    submitClaim.mutate(
      {
        placeId,
        owner: selectedOwner.owner,
        proof: { kind: "email_domain_match" },
      },
      { onSuccess: (r) => finalize(r), onError: showClaimError },
    );
  }, [selectedOwner, placeId, submitClaim, finalize, showClaimError]);

  const sendChallenge = useCallback(() => {
    setFormError(null);
    requestChallenge.mutate(
      { placeId, email: challengeEmail.trim() },
      {
        onSuccess: (r) => setChallengeId(r.challengeId),
        onError: showCodeError,
      },
    );
  }, [placeId, challengeEmail, requestChallenge, showCodeError]);

  const confirmAndSubmitChallenge = useCallback(() => {
    if (!selectedOwner || !challengeId) return;
    setFormError(null);
    confirmChallenge.mutate(
      { challengeId, code: code.trim() },
      {
        onSuccess: (r) => {
          if (!r.verified) {
            setFormError(String(t("errors.claimChallengeNotVerified")));
            return;
          }
          submitClaim.mutate(
            {
              placeId,
              owner: selectedOwner.owner,
              proof: { kind: "email_challenge", challengeId },
            },
            { onSuccess: (res) => finalize(res), onError: showClaimError },
          );
        },
        onError: showError,
      },
    );
  }, [
    selectedOwner,
    challengeId,
    code,
    confirmChallenge,
    submitClaim,
    placeId,
    finalize,
    showError,
    showClaimError,
    t,
  ]);

  const submitDocuments = useCallback(async () => {
    if (!selectedOwner || stagedFiles.length === 0) return;
    setFormError(null);
    setIsUploading(true);
    try {
      const documents: {
        storageKey: string;
        fileName: string;
        contentType: AllowedType;
        sizeBytes: number;
      }[] = [];
      for (const staged of stagedFiles) {
        const contentType = staged.file.type as AllowedType;
        const { key, uploadUrl } = await presign.mutateAsync({
          placeId,
          contentType,
          sizeBytes: staged.file.size,
          fileName: staged.file.name,
          context: "claim",
          orgId:
            selectedOwner.owner.kind === "org"
              ? selectedOwner.owner.orgId
              : null,
        });
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: staged.file,
        });
        if (!res.ok) {
          throw new Error(`Upload failed (${res.status})`);
        }
        documents.push({
          storageKey: key,
          fileName: staged.file.name,
          contentType,
          sizeBytes: staged.file.size,
        });
      }
      submitClaim.mutate(
        {
          placeId,
          owner: selectedOwner.owner,
          proof: { kind: "document", documents },
        },
        { onSuccess: (r) => finalize(r), onError: showClaimError },
      );
    } catch (err) {
      showUploadError(err);
    } finally {
      setIsUploading(false);
    }
  }, [
    selectedOwner,
    stagedFiles,
    presign,
    submitClaim,
    placeId,
    finalize,
    showClaimError,
    showUploadError,
  ]);

  // ── Render helpers ───────────────────────────────────────────────────────
  const heading = result
    ? result.autoVerified
      ? String(t("places.claimSuccessVerifiedTitle"))
      : String(t("places.claimSuccessPendingTitle"))
    : step === "owner"
      ? String(t("places.claimStepOwnerTitle"))
      : String(t("places.claimStepProofTitle"));

  const stepHeading = (
    <h2
      ref={headingRef}
      tabIndex={-1}
      style={{
        margin: 0,
        outline: "none",
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: 0,
      }}
    >
      {heading}
    </h2>
  );

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(t("places.claimWizardTitle"))}
          subtitle={placeName}
          onClose={onClose}
        />
        <Modal.Body gap="$4" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {/* ── Success ──────────────────────────────────────────────── */}
          {result ? (
            <YStack gap="$3" alignItems="center" paddingVertical="$4">
              <CheckCircle2
                size={40}
                color="var(--success)"
                aria-hidden="true"
              />
              {stepHeading}
              <Text variant="body" tone="muted" textAlign="center">
                {result.autoVerified
                  ? String(t("places.claimSuccessVerifiedBody"))
                  : String(t("places.claimSuccessPendingBody"))}
              </Text>

              {/* ── FR-005: the one decision, at claim time ─────────────────
                  Split by arm because the backend gate is real, not cosmetic:
                  `setCommunityListingAcceptance` refuses to ENABLE on a place
                  that is not VERIFIED. On the fast-track the place is verified
                  already, so the switch works and writes immediately. On the
                  pending arm there is nothing to flip yet, so we name the
                  decision and let the bookings page carry it — where the count
                  will also be current rather than a guess about a review queue.

                  Both arms render only when there is something to decide
                  ABOUT. At zero the question is abstract, and zero is the true
                  answer for almost every venue until the placeId backfill runs
                  — so the wizard stays exactly as it was today. */}
              {result.communityListingCount > 0 &&
                (result.autoVerified ? (
                  <YStack
                    gap="$3"
                    padding="$3"
                    borderWidth={2}
                    borderColor="$borderColor"
                    backgroundColor="$surface"
                    alignSelf="stretch"
                  >
                    <XStack
                      gap="$3"
                      alignItems="center"
                      justifyContent="space-between"
                      flexWrap="wrap"
                    >
                      <YStack
                        gap="$1"
                        flexGrow={1}
                        flexShrink={1}
                        flexBasis={220}
                        minWidth={0}
                      >
                        <Text variant="body" weight="bold">
                          {String(t("places.claimCommunityAskTitle"))}
                        </Text>
                        <Text variant="bodySmall" tone="muted">
                          {String(
                            t("places.claimCommunityAskBody", {
                              count: result.communityListingCount,
                            }),
                          )}
                        </Text>
                      </YStack>
                      <XStack flexShrink={0}>
                        <Switch
                          checked={claimAcceptsCommunity}
                          onCheckedChange={(next: boolean) => {
                            // Optimistic in the plainest sense: flip the local
                            // switch, fire the write, and roll back if it is
                            // refused. There is no shared cache entry to
                            // reconcile with here (see the state note above).
                            setClaimAcceptsCommunity(next);
                            setCommunityAcceptance.mutate(
                              { placeId, accepts: next },
                              {
                                onError: (err) => {
                                  setClaimAcceptsCommunity(!next);
                                  showError(err);
                                },
                              },
                            );
                          }}
                          saving={setCommunityAcceptance.isPending}
                          aria-label={String(
                            t("places.claimCommunityAskTitle"),
                          )}
                          testId="claim-community-acceptance-switch"
                        />
                      </XStack>
                    </XStack>
                    {/* The consequence, before the decision — same sentence the
                        admin toggle uses, and the reason it is not a toast. */}
                    <Alert
                      tone="info"
                      compact
                      description={String(
                        t("admin.clAcceptanceConsequenceBody"),
                      )}
                      testID="claim-community-consequence"
                    />
                  </YStack>
                ) : (
                  <Alert
                    tone="info"
                    compact
                    description={String(
                      t("places.claimCommunityPending", {
                        count: result.communityListingCount,
                      }),
                    )}
                    testID="claim-community-pending-note"
                    alignSelf="stretch"
                  />
                ))}

              <Button variant="primary" size="$3" onPress={onClose}>
                {String(t("places.claimDone"))}
              </Button>
            </YStack>
          ) : (
            <>
              {stepHeading}

              {/* ── Step: owner identity ─────────────────────────────── */}
              {step === "owner" ? (
                <YStack gap="$3">
                  <Text variant="bodySmall" tone="muted">
                    {String(t("places.claimStepOwnerHint"))}
                  </Text>
                  {ownersQuery.isLoading ? (
                    <XStack gap="$2" alignItems="center">
                      <Spinner size="sm" />
                      <Text variant="bodySmall" tone="muted">
                        {String(t("places.claimLoading"))}
                      </Text>
                    </XStack>
                  ) : (
                    <YStack gap="$2" role="radiogroup">
                      {ownerOptions.map((opt) => {
                        const selected = opt.key === ownerKey;
                        return (
                          <XStack
                            key={opt.key}
                            gap="$3"
                            padding="$3"
                            borderWidth={2}
                            borderColor={selected ? "$accent" : "$borderColor"}
                            backgroundColor="$surface"
                            cursor="pointer"
                            alignItems="center"
                            hoverStyle={{ borderColor: "$accent" }}
                            onPress={() => setOwnerKey(opt.key)}
                            {...webA11y({
                              role: "radio",
                              "aria-checked": selected,
                              tabIndex: 0,
                              onKeyDown: (e: React.KeyboardEvent) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setOwnerKey(opt.key);
                                }
                              },
                            })}
                          >
                            <YStack
                              width={16}
                              height={16}
                              borderRadius={999}
                              borderWidth={2}
                              borderColor={selected ? "$accent" : "$borderColor"}
                              backgroundColor={
                                selected ? "$accent" : "transparent"
                              }
                              flexShrink={0}
                            />
                            <Text variant="body" weight="bold">
                              {opt.label}
                            </Text>
                          </XStack>
                        );
                      })}
                      <Text variant="caption" tone="muted">
                        {String(t("places.claimOwnerOrgHint"))}
                      </Text>
                    </YStack>
                  )}
                </YStack>
              ) : null}

              {/* ── Step: proof ───────────────────────────────────────── */}
              {step === "proof" ? (
                <YStack gap="$3">
                  <Text variant="bodySmall" tone="muted">
                    {String(t("places.claimStepProofHint"))}
                  </Text>

                  {/* Method selector */}
                  <YStack gap="$2">
                    <Text
                      variant="caption"
                      weight="bold"
                      color="$colorMuted"
                      style={{ letterSpacing: 1.2, fontSize: 11 }}
                    >
                      {String(t("places.claimProofMethodLabel"))}
                    </Text>
                    <XStack gap="$2" flexWrap="wrap">
                      {domainProofAvailable ? (
                        <>
                          <MethodButton
                            active={method === "domain"}
                            label={String(t("places.claimMethodDomain"))}
                            onPress={() => {
                              setMethod("domain");
                              setFormError(null);
                            }}
                          />
                          <MethodButton
                            active={method === "challenge"}
                            label={String(t("places.claimMethodChallenge"))}
                            onPress={() => {
                              setMethod("challenge");
                              setFormError(null);
                            }}
                          />
                        </>
                      ) : null}
                      <MethodButton
                        active={method === "document"}
                        label={String(t("places.claimMethodDocument"))}
                        onPress={() => {
                          setMethod("document");
                          setFormError(null);
                        }}
                      />
                    </XStack>
                  </YStack>

                  {/* Method body */}
                  {method === "domain" ? (
                    <YStack
                      gap="$2"
                      padding="$3"
                      borderWidth={2}
                      borderColor="$borderColor"
                      backgroundColor="$surfaceMuted"
                    >
                      <Text variant="bodySmall" weight="bold">
                        {String(t("places.claimProofDomainTitle"))}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {String(t("places.claimProofDomainBody"))}
                      </Text>
                      {fastTrackEligible ? (
                        <Badge tone="success" variant="soft" size="sm">
                          {String(t("places.claimProofDomainFastTrack"))}
                        </Badge>
                      ) : null}
                      <Button
                        variant="primary"
                        size="$3"
                        alignSelf="flex-start"
                        onPress={submitDomainMatch}
                        disabled={busy || !selectedOwner}
                      >
                        {busy ? <Spinner size="sm" /> : <BadgeCheck size={16} />}
                        {String(t("places.claimProofDomainButton"))}
                      </Button>
                    </YStack>
                  ) : null}

                  {method === "challenge" ? (
                    <YStack
                      gap="$3"
                      padding="$3"
                      borderWidth={2}
                      borderColor="$borderColor"
                      backgroundColor="$surfaceMuted"
                    >
                      <Text variant="bodySmall" weight="bold">
                        {String(t("places.claimProofChallengeTitle"))}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {String(t("places.claimProofChallengeBody"))}
                      </Text>
                      {challengeId === null ? (
                        <>
                          <LabeledTextInput
                            id="claim-challenge-email"
                            name="claim-challenge-email"
                            label={String(
                              t("places.claimProofChallengeEmailLabel"),
                            )}
                            value={challengeEmail}
                            onChangeText={setChallengeEmail}
                            inputMode="email"
                            autoCapitalize="none"
                            placeholder="you@yourplace.com"
                          />
                          <Button
                            variant="primary"
                            size="$2"
                            alignSelf="flex-start"
                            onPress={sendChallenge}
                            disabled={busy || challengeEmail.trim().length < 3}
                          >
                            {requestChallenge.isPending ? (
                              <Spinner size="sm" />
                            ) : null}
                            {String(t("places.claimProofChallengeSend"))}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Text variant="caption" tone="muted">
                            {String(
                              t("places.claimProofChallengeSent", {
                                email: challengeEmail.trim(),
                              }),
                            )}
                          </Text>
                          <LabeledTextInput
                            id="claim-challenge-code"
                            name="claim-challenge-code"
                            label={String(
                              t("places.claimProofChallengeCodeLabel"),
                            )}
                            value={code}
                            onChangeText={(v: string) =>
                              setCode(v.replace(/\D/g, "").slice(0, 6))
                            }
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="000000"
                          />
                          <XStack gap="$2" flexWrap="wrap">
                            <Button
                              variant="primary"
                              size="$2"
                              onPress={confirmAndSubmitChallenge}
                              disabled={busy || code.trim().length !== 6}
                            >
                              {busy ? <Spinner size="sm" /> : null}
                              {String(t("places.claimProofChallengeConfirm"))}
                            </Button>
                            <Button
                              variant="ghost"
                              size="$2"
                              onPress={() => {
                                setChallengeId(null);
                                setCode("");
                                setFormError(null);
                              }}
                              disabled={busy}
                            >
                              {String(t("places.claimProofChallengeResend"))}
                            </Button>
                          </XStack>
                        </>
                      )}
                    </YStack>
                  ) : null}

                  {method === "document" ? (
                    <YStack gap="$3">
                      <Text variant="bodySmall" weight="bold">
                        {String(t("places.claimProofDocTitle"))}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {String(t("places.claimProofDocBody"))}
                      </Text>
                      <div
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (e.dataTransfer.files)
                            void addFiles(e.dataTransfer.files);
                        }}
                      >
                        <DropZone
                          onPress={() => fileInputRef.current?.click()}
                          {...webA11y({
                            role: "button",
                            tabIndex: 0,
                            "aria-label": String(t("places.claimProofDocDrop")),
                            onKeyDown: (e: React.KeyboardEvent) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                fileInputRef.current?.click();
                              }
                            },
                          })}
                        >
                          <Upload
                            size={22}
                            style={{ opacity: 0.6 }}
                            aria-hidden="true"
                          />
                          <Text
                            variant="bodySmall"
                            tone="muted"
                            textAlign="center"
                          >
                            {stagedFiles.length >= MAX_FILES
                              ? String(t("places.claimProofDocMax"))
                              : String(t("places.claimProofDocDrop"))}
                          </Text>
                          <Text variant="caption" tone="muted">
                            {String(t("places.claimProofDocFormats"))}
                          </Text>
                        </DropZone>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif"
                        multiple
                        onChange={(e) => {
                          if (e.target.files) void addFiles(e.target.files);
                          e.target.value = "";
                        }}
                        style={{ display: "none" }}
                      />
                      {stagedFiles.length > 0 ? (
                        <YStack gap="$2">
                          <Text variant="caption" tone="muted">
                            {String(
                              t("places.claimFilesCount", {
                                count: stagedFiles.length,
                                max: MAX_FILES,
                              }),
                            )}
                          </Text>
                          {stagedFiles.map((s) => {
                            const Icon = s.file.type.startsWith("image/")
                              ? ImageIcon
                              : FileText;
                            return (
                              <FileRow key={s.id}>
                                <Icon
                                  size={16}
                                  style={{ flexShrink: 0, opacity: 0.7 }}
                                  aria-hidden="true"
                                />
                                <YStack flex={1} minWidth={0}>
                                  <Text
                                    variant="bodySmall"
                                    style={{
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {s.file.name}
                                  </Text>
                                  <Text variant="caption" tone="muted">
                                    {formatBytes(s.file.size)}
                                  </Text>
                                </YStack>
                                <Button
                                  variant="ghost"
                                  size="$1"
                                  icon
                                  onPress={() => removeFile(s.id)}
                                  disabled={busy}
                                  aria-label={String(
                                    t("places.claimFileRemove", {
                                      fileName: s.file.name,
                                    }),
                                  )}
                                >
                                  <Trash2 size={14} color="var(--danger)" />
                                </Button>
                              </FileRow>
                            );
                          })}
                        </YStack>
                      ) : null}
                      <Button
                        variant="primary"
                        size="$3"
                        alignSelf="flex-start"
                        onPress={() => void submitDocuments()}
                        disabled={busy || stagedFiles.length === 0}
                      >
                        {busy ? <Spinner size="sm" /> : null}
                        {busy
                          ? String(t("places.claimSubmitting"))
                          : String(t("places.claimSubmit"))}
                      </Button>
                    </YStack>
                  ) : null}
                </YStack>
              ) : null}

              {formError ? (
                <Text variant="bodySmall" tone="error" role="alert">
                  {formError}
                </Text>
              ) : null}
            </>
          )}
        </Modal.Body>

        {!result ? (
          <Modal.Footer>
            {step === "proof" ? (
              <Button
                variant="ghost"
                size="$2"
                onPress={() => {
                  setStep("owner");
                  setFormError(null);
                }}
                disabled={busy}
              >
                {String(t("places.claimBack"))}
              </Button>
            ) : (
              <Button variant="ghost" size="$2" onPress={onClose}>
                {String(t("places.claimCancel"))}
              </Button>
            )}
            {step === "owner" ? (
              <Button
                variant="primary"
                size="$2"
                onPress={() => setStep("proof")}
                disabled={!selectedOwner}
              >
                {String(t("places.claimContinue"))}
              </Button>
            ) : null}
          </Modal.Footer>
        ) : null}
      </Modal.Panel>
    </Modal>
  );
}
