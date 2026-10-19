"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  Modal,
  Separator,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Nfc, Plus, RefreshCw, Trash2 } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { AdminPageHeader } from "../_components/AdminPageHeader";

/**
 * Resolves the org whose workspace the admin is currently in. Mirrors the
 * resolution used by the Default agreement settings page — readers are org-scoped
 * hardware, so a personal workspace has nothing to show.
 */
function useCurrentOrgId(): string | null {
  const { slug } = useParams<{ slug: string }>();
  const ownerEntities = useEventOwnerEntities();

  return useMemo(() => {
    const owners = ownerEntities.ownersWithSlugs ?? [];
    const decoded = (() => {
      try {
        return decodeURIComponent(slug);
      } catch {
        return slug;
      }
    })();
    for (const owner of owners) {
      if (owner.kind !== "org") continue;
      if (
        owner.orgSlug === decoded ||
        owner.orgId === decoded ||
        owner.adminSlug === decoded
      ) {
        return owner.orgId;
      }
    }
    const isHumanSlug =
      decoded.startsWith("@") ||
      owners.some((o) => o.kind === "human" && o.adminSlug === decoded);
    if (isHumanSlug) {
      const firstOrg = owners.find((o) => o.kind === "org");
      if (firstOrg) return firstOrg.orgId;
    }
    return null;
  }, [slug, ownerEntities.ownersWithSlugs]);
}

const DEVICE_LABELS: Record<string, string> = {
  bbpos_wisepos_e: "BBPOS WisePOS E",
  stripe_s700: "Stripe Reader S700",
  verifone_P400: "Verifone P400",
  simulated_wisepos_e: "Simulated reader",
};

function deviceLabel(deviceType: string | null): string {
  if (!deviceType) return "Card reader";
  return DEVICE_LABELS[deviceType] ?? deviceType;
}

// ── Pair dialog ──────────────────────────────────────────────────────────────

function PairReaderDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const [registrationCode, setRegistrationCode] = useState("");
  const [label, setLabel] = useState("");

  const reset = () => {
    setRegistrationCode("");
    setLabel("");
  };

  const pairMutation = trpc.pos.pairReader.useMutation({
    onSuccess: (reader) => {
      toast.success({
        id: "reader-paired",
        title: "Reader paired",
        message: `${reader.label} is ready to take payments.`,
      });
      void utils.pos.listReaders.invalidate({ orgId });
      reset();
      onClose();
    },
    onError: (err) => {
      toast.danger({
        id: "reader-pair-failed",
        title: "Could not pair reader",
        message: formatErrorMessage(err, t),
      });
    },
  });

  const codeValid = registrationCode.trim().length >= 3;
  const labelValid = label.trim().length >= 1;

  const handleClose = () => {
    if (pairMutation.isPending) return;
    reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <Modal.Panel width={520}>
        <Modal.Header
          title="Pair a card reader"
          subtitle="Connect a countertop reader to this group"
          onClose={handleClose}
        />
        <Modal.Body gap="$4">
          <YStack
            gap="$2"
            padding="$3"
            borderWidth={1}
            borderColor="$borderColor"
            backgroundColor="$surfaceMuted"
          >
            <Text variant="bodySmall" weight="bold">
              On the reader
            </Text>
            <Text variant="caption" tone="muted">
              Power it on and join it to wifi, then open Settings and choose
              &ldquo;Generate pairing code&rdquo;. It shows three words. The
              code expires after a few minutes — generate a fresh one if this
              fails.
            </Text>
          </YStack>

          <YStack gap="$2">
            <Text variant="bodySmall" weight="bold">
              Pairing code
            </Text>
            <TextInput
              value={registrationCode}
              onChangeText={setRegistrationCode}
              placeholder="puppies-plug-could"
              // Without this the accessible name falls back to the
              // placeholder, so a screen reader announces the field as
              // "puppies-plug-could". Caught by driving the page, not by the
              // unit tests — they render the input without the DS label.
              aria-label="Pairing code"
              autoCapitalize="none"
              autoCorrect={false}
              fullWidth
              clearable
            />
          </YStack>

          <YStack gap="$2">
            <Text variant="bodySmall" weight="bold">
              Name
            </Text>
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Front door"
              aria-label="Reader name"
              fullWidth
              clearable
            />
            <Text variant="caption" tone="muted">
              What staff will see when picking a reader at the door.
            </Text>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="$3" onPress={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="$3"
            disabled={!codeValid || !labelValid || pairMutation.isPending}
            onPress={() =>
              pairMutation.mutate({
                orgId,
                registrationCode: registrationCode.trim(),
                label: label.trim(),
              })
            }
          >
            {pairMutation.isPending ? <Spinner size="small" /> : <Plus size={14} />}
            Pair reader
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

// ── Unpair confirm ───────────────────────────────────────────────────────────

function UnpairDialog({
  orgId,
  reader,
  onClose,
}: {
  orgId: string;
  reader: { id: string; label: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const unpairMutation = trpc.pos.unpairReader.useMutation({
    onSuccess: () => {
      toast.success({ id: "reader-unpaired", title: "Reader unpaired" });
      void utils.pos.listReaders.invalidate({ orgId });
      onClose();
    },
    onError: (err) => {
      toast.danger({
        id: "reader-unpair-failed",
        title: "Could not unpair reader",
        message: formatErrorMessage(err, t),
      });
    },
  });

  return (
    <Modal open={!!reader} onClose={onClose}>
      <Modal.Panel width={460}>
        <Modal.Header
          title="Unpair this reader?"
          subtitle={reader?.label}
          onClose={onClose}
        />
        <Modal.Body gap="$3">
          <Text variant="body">
            It will stop accepting payments for this group immediately. The
            hardware isn&rsquo;t wiped — you can pair it again with a fresh
            code, here or with another group.
          </Text>
          <Text variant="caption" tone="muted">
            Sales already taken are unaffected.
          </Text>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="$3" onPress={onClose}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            size="$3"
            disabled={unpairMutation.isPending}
            onPress={() =>
              reader &&
              unpairMutation.mutate({ orgId, posReaderId: reader.id })
            }
          >
            {unpairMutation.isPending ? (
              <Spinner size="small" />
            ) : (
              <Trash2 size={14} />
            )}
            Unpair
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

// ── Reader row ───────────────────────────────────────────────────────────────

function ReaderRow({
  orgId,
  reader,
  onUnpair,
}: {
  orgId: string;
  reader: {
    id: string;
    label: string;
    deviceType: string | null;
    status: "online" | "offline" | null;
    busy: boolean | null;
  };
  onUnpair: () => void;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(reader.label);

  const updateMutation = trpc.pos.updateReader.useMutation({
    onSuccess: () => {
      void utils.pos.listReaders.invalidate({ orgId });
      setEditing(false);
    },
    onError: (err) => {
      toast.danger({
        id: "reader-rename-failed",
        title: "Could not rename reader",
        message: formatErrorMessage(err, t),
      });
    },
  });

  const statusTone =
    reader.status === "online"
      ? "success"
      : reader.status === "offline"
        ? "danger"
        : "neutral";
  const statusLabel =
    reader.status === "online"
      ? reader.busy
        ? "In use"
        : "Online"
      : reader.status === "offline"
        ? "Offline"
        : "Unknown";

  return (
    <YStack
      gap="$3"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$background"
    >
      <XStack gap="$3" alignItems="center" flexWrap="wrap">
        <Nfc size={20} color="var(--colorMuted, #5C544A)" aria-hidden="true" />
        <YStack flex={1} minWidth={180} gap="$1">
          {editing ? (
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <TextInput
                value={draftLabel}
                onChangeText={setDraftLabel}
                placeholder="Front door"
                aria-label="Reader name"
              />
              <Button
                variant="primary"
                size="$2"
                minHeight={44}
                disabled={
                  draftLabel.trim().length === 0 || updateMutation.isPending
                }
                onPress={() =>
                  updateMutation.mutate({
                    orgId,
                    posReaderId: reader.id,
                    label: draftLabel.trim(),
                  })
                }
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="$2"
                minHeight={44}
                onPress={() => {
                  setDraftLabel(reader.label);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </XStack>
          ) : (
            <>
              <Text variant="body" weight="bold">
                {reader.label}
              </Text>
              <Text variant="caption" tone="muted">
                {deviceLabel(reader.deviceType)}
              </Text>
            </>
          )}
        </YStack>

        <Badge tone={statusTone}>{statusLabel}</Badge>

        {!editing && (
          <XStack gap="$2">
            <Button
              variant="secondary"
              size="$2"
              minHeight={44}
              onPress={() => setEditing(true)}
            >
              Rename
            </Button>
            <Button
              variant="ghost"
              size="$2"
              minHeight={44}
              onPress={onUnpair}
            >
              <Trash2 size={14} />
              Unpair
            </Button>
          </XStack>
        )}
      </XStack>
    </YStack>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function CardReadersView({ orgId }: { orgId: string }) {
  const [pairOpen, setPairOpen] = useState(false);
  const [unpairTarget, setUnpairTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const readersQuery = trpc.pos.listReaders.useQuery(
    { orgId, includeStatus: true },
    { staleTime: 15_000 },
  );

  if (readersQuery.isLoading) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$6">
        <Spinner size="large" />
      </YStack>
    );
  }

  if (readersQuery.error) {
    return (
      <YStack padding="$4" gap="$3">
        <Text variant="body" tone="error">
          {formatErrorMessage(readersQuery.error)}
        </Text>
        <Button
          variant="secondary"
          size="$2"
          onPress={() => void readersQuery.refetch()}
        >
          Retry
        </Button>
      </YStack>
    );
  }

  const readers = readersQuery.data?.readers ?? [];

  return (
    <YStack gap="$4" maxWidth={860}>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Button variant="primary" size="$3" onPress={() => setPairOpen(true)}>
          <Plus size={14} />
          Pair a reader
        </Button>
        <Button
          variant="secondary"
          size="$3"
          disabled={readersQuery.isFetching}
          onPress={() => void readersQuery.refetch()}
        >
          <RefreshCw size={14} />
          Refresh status
        </Button>
      </XStack>

      <Separator />

      {readers.length === 0 ? (
        <YStack
          gap="$2"
          padding="$4"
          borderWidth={1}
          borderColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          <Text variant="body" weight="bold">
            No readers paired yet
          </Text>
          <Text variant="caption" tone="muted">
            Pair a countertop reader to take card payments at the door. You can
            still sell for cash without one.
          </Text>
        </YStack>
      ) : (
        <YStack gap="$2">
          {readers.map((reader) => (
            <ReaderRow
              key={reader.id}
              orgId={orgId}
              reader={reader}
              onUnpair={() =>
                setUnpairTarget({ id: reader.id, label: reader.label })
              }
            />
          ))}
        </YStack>
      )}

      <YStack gap="$1">
        <Text variant="caption" tone="muted">
          Readers talk directly to Stripe over the place&rsquo;s internet
          connection — this browser never connects to them, so the box office
          can run from any device. If the place&rsquo;s wifi drops, card sales
          stop and cash is the fallback.
        </Text>
      </YStack>

      <PairReaderDialog
        orgId={orgId}
        open={pairOpen}
        onClose={() => setPairOpen(false)}
      />
      <UnpairDialog
        orgId={orgId}
        reader={unpairTarget}
        onClose={() => setUnpairTarget(null)}
      />
    </YStack>
  );
}

export default function AdminCardReadersPage() {
  const orgId = useCurrentOrgId();

  return (
    <AdminEmailVerificationGate mode="block">
      <YStack
        gap="$4"
        flex={1}
        padding="$4"
        maxWidth={1024}
        marginHorizontal="auto"
        width="100%"
      >
        <AdminPageHeader
          title="Card readers"
          subtitle="Countertop readers this group can take door payments on."
        />
        {!orgId ? (
          <YStack padding="$4" gap="$2">
            <Text variant="body" tone="muted">
              Card readers belong to a group. Switch to a group workspace to
              pair one.
            </Text>
          </YStack>
        ) : (
          <CardReadersView orgId={orgId} />
        )}
      </YStack>
    </AdminEmailVerificationGate>
  );
}
