"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { ExternalLink, Globe, Plus, Trash2 } from "lucide-react";

import { trpc } from "@/trpc";
import { getSiteUrl } from "@/config/site";
import { formatErrorMessage } from "@/lib/format-error-message";
import { buildBookingSnippet, buildEmbedWidgetUrl } from "@/lib/embed-snippets";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { EmbedCodeBlock } from "@/components/embeds/EmbedCodeBlock";
import { EmbedModalPreview } from "@/components/embeds/EmbedModalPreview";

/**
 * "Booking button for your website" — place-scoped embed management
 * (booking-request-embed-button FR-009).
 *
 * A lean, place-subject variant of the org `EmbedsView`: add/revoke allowed
 * domains for `subjectType: "place"`, copy the SDK modal snippet, and preview
 * the widget.
 *
 * WHERE IT LIVES, AND WHY IT MOVED. The rule has always been "adjacent to
 * `BookingAcceptanceToggle`, so venues discover it right where they turn
 * booking requests on". That toggle moved off the public-page settings drawer
 * and onto the bookings page (see its docblock for the discoverability bug that
 * forced the move), so this followed it rather than being stranded next to a
 * switch that is no longer there — and the copy below that says "turn them on
 * above" stays literally true, because the toggle is the first thing on this
 * page.
 *
 * It sits BELOW the inbox, not above it. Everything here is setup a venue does
 * once (add a domain, copy a snippet); the requests are what they came for, and
 * a domain manager plus a live preview iframe between the header and the table
 * would push the actual work below the fold every single visit.
 *
 * Editing (add/revoke) is gated on the same `canEdit` affordance pattern as
 * `EmbedsView` — UX-only; the server re-checks place ownership edit roles and
 * 403s regardless.
 *
 * This is one of TWO doors onto the same place-subject embeds: the admin
 * `EmbedsView` reaches them via its "Booking button" tab (`?tab=booking`).
 * Both read the same `embeds.list`, and both build the MODAL snippet with the
 * shared `buildBookingSnippet` (`@/lib/embed-snippets`), so neither its markup
 * nor the `HF_STUB_LINE` queue-drain contract can drift between them.
 *
 * The doors are deliberately NOT equivalent: `EmbedsView` also offers the
 * inline form variant (`buildBookingIframeSnippet`, via its Display control).
 * This surface stays modal-only — a venue page-settings panel is a drop-in
 * affordance, not the full embed configurator.
 *
 * NOTE: copy is intentionally literal English (the precedent it was written
 * against — see `PlaceProfileEditor`); moving it into the i18n messages files
 * is deferred while those files carry unrelated in-flight work.
 */

export interface BookingEmbedSectionProps {
  placeId: string;
  /** Admin org slug from the route — identifies the current admin owner. */
  slug: string;
  /**
   * Whether the place currently accepts booking requests, or `null` when we do
   * not know. Passed down from the same `places.getPlaceForEdit` entry
   * `BookingAcceptanceToggle` writes, so the note below cannot contradict the
   * switch at the top of the page.
   *
   * THREE-STATE, NOT TWO, and the third is the one that matters. That read
   * sits at `canManagePlace` (OWNER/ADMIN/EDITOR) while the booking inbox
   * around it admits ANY member of an owning org — so a SCANNER renders this
   * section with the place read refused. Folding that into `false` told them
   * "booking requests are off" about a place whose requests are on, and
   * pointed at a switch that is not on their page (`BookingAcceptanceToggle`
   * returns null on the same error). `null` suppresses the note instead.
   *
   * Do not restore a `?? false` default at any call site. The inbox two files
   * over already wraps its empty-state copy in `{place ? … : null}` for this
   * exact reason — guessing is what caused the original bug.
   */
  acceptsBookingRequests: boolean | null;
}

export function BookingEmbedSection({
  placeId,
  slug,
  acceptsBookingRequests,
}: BookingEmbedSectionProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const { currentOwner } = useCurrentAdminOwner(slug);
  const { canEdit } = useAdminOwnerCapabilities(currentOwner);

  const subjectInput = useMemo(
    () => ({ subjectType: "place" as const, subjectId: placeId }),
    [placeId],
  );

  const embedsQuery = trpc.embeds.list.useQuery(subjectInput, {
    enabled: Boolean(placeId),
    staleTime: 15_000,
    retry: 1,
  });

  const [newDomain, setNewDomain] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const upsertMutation = trpc.embeds.upsert.useMutation({
    onSuccess: () => {
      setNewDomain("");
      void utils.embeds.list.invalidate(subjectInput);
      toast.success({
        id: "place-embed-added",
        title: "Domain added",
        message: "Your booking button will work on this domain.",
      });
    },
    onError: (err) => {
      toast.danger({
        id: "place-embed-add-failed",
        title: "Couldn't add domain",
        message: formatErrorMessage(err, t),
      });
    },
  });

  const revokeMutation = trpc.embeds.revoke.useMutation({
    onSuccess: () => {
      void utils.embeds.list.invalidate(subjectInput);
      toast.success({
        id: "place-embed-revoked",
        title: "Domain removed",
        message: "The booking button stops working on that domain.",
      });
    },
    onError: (err) => {
      toast.danger({
        id: "place-embed-revoke-failed",
        title: "Couldn't remove domain",
        message: formatErrorMessage(err, t),
      });
    },
  });

  const handleAddDomain = useCallback(() => {
    const domain = newDomain.trim();
    if (!domain || upsertMutation.isPending) return;
    upsertMutation.mutate({ ...subjectInput, domain });
  }, [newDomain, subjectInput, upsertMutation]);

  const copyToClipboard = useCallback((text: string, id: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  const siteUrl = getSiteUrl();

  const activeEmbeds = useMemo(
    () => (embedsQuery.data?.embeds ?? []).filter((e) => e.status === "ACTIVE"),
    [embedsQuery.data],
  );

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <Text
          variant="caption"
          weight="bold"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.6}
        >
          Booking button for your website
        </Text>
        <Text variant="bodySmall" tone="muted">
          Put a &ldquo;Request to book&rdquo; button on your own site. Add your
          website&rsquo;s domain, paste the snippet, and requests land in your
          booking inbox.
        </Text>
      </YStack>

      {/* `=== false`, never falsy: `null` means the place read was refused or
          has not landed, and a note that names a state AND a control ("turn
          them on above") must not render when we know neither. */}
      {acceptsBookingRequests === false && (
        <Text variant="caption" tone="muted">
          Booking requests are off — the button will show &ldquo;not accepting
          requests&rdquo; until you turn them on above.
        </Text>
      )}

      {embedsQuery.isLoading ? (
        <XStack gap="$2" alignItems="center" paddingVertical="$2">
          <Spinner size="sm" />
          <Text variant="caption" tone="muted">
            Loading your domains…
          </Text>
        </XStack>
      ) : embedsQuery.error ? (
        <YStack gap="$2">
          <Text variant="bodySmall" tone="error">
            {formatErrorMessage(embedsQuery.error)}
          </Text>
          <XStack>
            <Button
              variant="secondary"
              size="$2"
              onPress={() => void embedsQuery.refetch()}
            >
              Retry
            </Button>
          </XStack>
        </YStack>
      ) : (
        <>
          {canEdit && (
            // MEASURED at 320px inside the admin shell (~206px of content): the
            // field + button used to push the DOCUMENT to 414px and hang the
            // "Add" button 94px off the right edge. Two causes, both needed
            // fixing. `TextInput` frames default to `containerWidth: 240`, and
            // Tamagui defaults `flexShrink: 0` (RN semantics), so a bare
            // `flex={1}` on the field kept all 240px and shoved the button out.
            // The wrapper carries the flex (an explicit `flexBasis`, not
            // `auto`) and `fullWidth` lets the field fill it; `flexWrap` then
            // drops the button onto its own line once the pair no longer fits.
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <XStack flexGrow={1} flexShrink={1} flexBasis={180} minWidth={0}>
                <TextInput
                  placeholder="example.com"
                  value={newDomain}
                  onChangeText={setNewDomain}
                  fullWidth
                  size="$3"
                  aria-label="Website domain"
                  onSubmitEditing={handleAddDomain}
                  testId="booking-embed-domain-input"
                />
              </XStack>
              <Button
                variant="primary"
                size="$3"
                flexShrink={0}
                onPress={handleAddDomain}
                disabled={!newDomain.trim() || upsertMutation.isPending}
                testID="booking-embed-add-domain"
              >
                <Plus size={14} />
                Add
              </Button>
            </XStack>
          )}

          {activeEmbeds.length === 0 ? (
            <Text variant="caption" tone="muted">
              {canEdit
                ? "No domains yet — add your website's domain to get your snippet."
                : "No domains yet."}
            </Text>
          ) : (
            <YStack gap="$3">
              {activeEmbeds.map((embed) => {
                const snippet = buildBookingSnippet(siteUrl, embed.id);
                const previewUrl = buildEmbedWidgetUrl(siteUrl, embed.id, {
                  book: true,
                });
                return (
                  <YStack
                    key={embed.id}
                    gap="$2"
                    padding="$3"
                    borderWidth={2}
                    borderColor="$borderColor"
                    backgroundColor="$surface"
                  >
                    <XStack
                      gap="$2"
                      alignItems="center"
                      justifyContent="space-between"
                      flexWrap="wrap"
                    >
                      <XStack gap="$2" alignItems="center" minWidth={0}>
                        <Globe size={14} style={{ flexShrink: 0 }} />
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          minWidth={0}
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {embed.domain}
                        </Text>
                      </XStack>
                      <XStack gap="$2">
                        <Button
                          variant="secondary"
                          size="$2"
                          onPress={() => window.open(previewUrl, "_blank")}
                          aria-label={`Open booking form for ${embed.domain} in a new tab`}
                        >
                          <ExternalLink size={14} />
                          Open form
                        </Button>
                        {canEdit && (
                          <Button
                            variant="secondary"
                            size="$2"
                            onPress={() =>
                              revokeMutation.mutate({ embedId: embed.id })
                            }
                            disabled={revokeMutation.isPending}
                            testID={`booking-embed-revoke-${embed.id}`}
                          >
                            <Trash2 size={14} />
                            Revoke
                          </Button>
                        )}
                      </XStack>
                    </XStack>

                    <EmbedCodeBlock
                      code={snippet}
                      isCopied={copiedId === embed.id}
                      onCopy={() => copyToClipboard(snippet, embed.id)}
                      copyLabel="Copy embed code"
                    />

                    <YStack
                      gap="$2"
                      padding="$3"
                      borderWidth={2}
                      borderColor="$borderColor"
                      borderStyle="dashed"
                      backgroundColor="$surfaceMuted"
                    >
                      <Text
                        variant="caption"
                        tone="muted"
                        textTransform="uppercase"
                        letterSpacing={0.6}
                      >
                        Live preview
                      </Text>
                      <Text variant="caption" tone="muted">
                        This is the button your visitors see. Click it to open
                        the booking form.
                      </Text>
                      <XStack>
                        <EmbedModalPreview
                          siteUrl={siteUrl}
                          embedId={embed.id}
                          widget="booking"
                        />
                      </XStack>
                    </YStack>
                  </YStack>
                );
              })}
            </YStack>
          )}
        </>
      )}
    </YStack>
  );
}
