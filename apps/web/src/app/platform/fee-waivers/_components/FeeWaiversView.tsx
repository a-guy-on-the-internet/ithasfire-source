"use client";

import { useMemo, useState } from "react";
import { YStack, XStack, styled } from "tamagui";
import {
  Button,
  Text,
  Spinner,
  Separator,
  useNotify,
  useTranslations,
} from "@th/ui";
import { TicketPercent, Building2, User } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

// Copy here is intentionally untranslated English, matching the other
// staff-only platform surfaces (Roles, Audit Log). Adding half-translated keys
// to the shared catalogues would surface raw keys to real users.

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives (mirrors PlatformFeesView)
// ─────────────────────────────────────────────────────────────────────────────

const SectionCard = styled(YStack, {
  name: "WaiverSectionCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  padding: "$5",
  gap: "$4",
});

const FieldGroup = styled(YStack, { name: "WaiverFieldGroup", gap: "$2" });

const FieldRow = styled(XStack, {
  name: "WaiverFieldRow",
  gap: "$4",
  flexWrap: "wrap",
  alignItems: "flex-start",
});

const InputLabel = styled(Text, {
  name: "WaiverInputLabel",
  variant: "caption",
  weight: "semibold",
  color: "$color",
});

const HintText = styled(Text, {
  name: "WaiverHintText",
  variant: "caption",
  color: "$colorMuted",
  fontSize: 12,
});

const Row = styled(XStack, {
  name: "WaiverRow",
  paddingVertical: "$3",
  paddingHorizontal: "$4",
  gap: "$4",
  alignItems: "center",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  flexWrap: "wrap",
});

const INPUT_STYLE: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 0,
  border: "1px solid var(--borderColor)",
  backgroundColor: "var(--background)",
  color: "var(--color)",
  fontSize: 14,
  width: "100%",
};

const SUBJECT_TYPES = ["HUMAN", "ORG"] as const;
const SIDES = ["ORGANIZER", "BUYER"] as const;

type SubjectType = (typeof SUBJECT_TYPES)[number];
type Side = (typeof SIDES)[number];

const SIDE_HINT: Record<Side, string> = {
  ORGANIZER: "Waives the fee on tickets this subject SELLS.",
  BUYER: "Waives the fee on tickets this subject BUYS.",
};

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "$accent",
  EXHAUSTED: "$colorMuted",
  REVOKED: "$colorMuted",
};

function UsageBar({ used, granted }: { used: number; granted: number }) {
  const pct = granted > 0 ? Math.min(100, (used / granted) * 100) : 0;
  return (
    <YStack gap="$1" minWidth={140} flex={1}>
      <Text variant="caption" weight="semibold">
        {used} / {granted} used
      </Text>
      <YStack
        height={6}
        backgroundColor="$borderColor"
        borderRadius={0}
        overflow="hidden"
      >
        <YStack
          height={6}
          width={`${pct}%`}
          backgroundColor={pct >= 100 ? "$colorMuted" : "$accent"}
        />
      </YStack>
    </YStack>
  );
}

export function FeeWaiversView() {
  const t = useTranslations();
  const { toast } = useNotify();

  const [includeInactive, setIncludeInactive] = useState(false);
  const [subjectType, setSubjectType] = useState<SubjectType>("ORG");
  const [side, setSide] = useState<Side>("ORGANIZER");
  const [subjectId, setSubjectId] = useState("");
  const [tickets, setTickets] = useState("100");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [notes, setNotes] = useState("");

  const listQuery = trpc.platform.listFeeWaivers.useQuery({
    includeInactive,
    limit: 100,
    offset: 0,
  });

  const resetForm = () => {
    setSubjectId("");
    setTickets("100");
    setEffectiveTo("");
    setNotes("");
  };

  const grantMutation = trpc.platform.grantFeeWaiver.useMutation({
    onSuccess: () => {
      toast.success({
        id: "waiver-granted",
        title: "Fee waiver granted",
      });
      resetForm();
      listQuery.refetch();
    },
    onError: (err) => {
      toast.danger({
        id: "waiver-grant-error",
        title: "Could not grant waiver",
        message: formatErrorMessage(err, t),
      });
    },
  });

  const revokeMutation = trpc.platform.revokeFeeWaiver.useMutation({
    onSuccess: () => {
      toast.success({ id: "waiver-revoked", title: "Fee waiver revoked" });
      listQuery.refetch();
    },
    onError: (err) => {
      toast.danger({
        id: "waiver-revoke-error",
        title: "Could not revoke waiver",
        message: formatErrorMessage(err, t),
      });
    },
  });

  const ticketsValue = parseInt(tickets, 10) || 0;
  const canSubmit =
    subjectId.trim().length > 0 && ticketsValue > 0 && !grantMutation.isPending;

  const waivers = listQuery.data?.waivers ?? [];

  const outstanding = useMemo(
    () =>
      waivers
        .filter((w) => w.status === "ACTIVE")
        .reduce((sum, w) => sum + w.ticketsRemaining, 0),
    [waivers],
  );

  return (
    <YStack gap="$5" padding="$4">
      <YStack gap="$2">
        <XStack alignItems="center" gap="$2">
          <TicketPercent size={20} color="var(--accent)" />
          <Text variant="h3" weight="bold">
            Fee waivers
          </Text>
        </XStack>
        <Text variant="caption" tone="muted">
          A waiver zeroes the Ithas Fire platform fee on a fixed number of
          tickets for one human or organisation. Stripe&apos;s processing fee is
          never waived — we cannot waive a cost the processor charges us.
        </Text>
        {waivers.length > 0 ? (
          <Text variant="caption" tone="muted">
            {outstanding} fee-free tickets outstanding across active waivers.
          </Text>
        ) : null}
      </YStack>

      {/* ── Grant ─────────────────────────────────────────────────────── */}
      <SectionCard>
        <Text variant="h4" weight="bold">
          Grant a waiver
        </Text>

        <FieldRow>
          <FieldGroup flex={1} minWidth={180}>
            <InputLabel>Subject type</InputLabel>
            <select
              value={subjectType}
              onChange={(e) => setSubjectType(e.target.value as SubjectType)}
              style={INPUT_STYLE}
            >
              <option value="ORG">Organisation</option>
              <option value="HUMAN">Human</option>
            </select>
          </FieldGroup>

          <FieldGroup flex={2} minWidth={280}>
            <InputLabel>
              {subjectType === "ORG" ? "Organisation ID" : "Human ID"}
            </InputLabel>
            <input
              type="text"
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              placeholder="UUID"
              style={INPUT_STYLE}
            />
            <HintText>
              Checked on save — a grant against an unknown id is rejected rather
              than silently never applying.
            </HintText>
          </FieldGroup>
        </FieldRow>

        <FieldRow>
          <FieldGroup flex={1} minWidth={180}>
            <InputLabel>Side</InputLabel>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as Side)}
              style={INPUT_STYLE}
            >
              <option value="ORGANIZER">Organiser (tickets sold)</option>
              <option value="BUYER">Buyer (tickets bought)</option>
            </select>
            <HintText>{SIDE_HINT[side]}</HintText>
          </FieldGroup>

          <FieldGroup flex={1} minWidth={160}>
            <InputLabel>Fee-free tickets</InputLabel>
            <input
              type="text"
              inputMode="numeric"
              value={tickets}
              onChange={(e) =>
                setTickets(e.target.value.replace(/[^0-9]/g, ""))
              }
              style={INPUT_STYLE}
            />
          </FieldGroup>

          <FieldGroup flex={1} minWidth={200}>
            <InputLabel>Expires (optional)</InputLabel>
            <input
              type="date"
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
              style={INPUT_STYLE}
            />
            <HintText>Blank = never expires.</HintText>
          </FieldGroup>
        </FieldRow>

        <FieldGroup>
          <InputLabel>Notes (optional)</InputLabel>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why this waiver exists"
            style={INPUT_STYLE}
          />
        </FieldGroup>

        <XStack>
          <Button
            disabled={!canSubmit}
            onPress={() =>
              grantMutation.mutate({
                subjectType,
                subjectId: subjectId.trim(),
                side,
                ticketsGranted: ticketsValue,
                effectiveFrom: null,
                effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
                notes: notes.trim() || null,
              })
            }
          >
            {grantMutation.isPending ? "Granting…" : "Grant waiver"}
          </Button>
        </XStack>
      </SectionCard>

      {/* ── List ──────────────────────────────────────────────────────── */}
      <SectionCard padding="$0">
        <XStack
          justifyContent="space-between"
          alignItems="center"
          padding="$4"
          flexWrap="wrap"
          gap="$3"
        >
          <Text variant="h4" weight="bold">
            Waivers
          </Text>
          <XStack alignItems="center" gap="$2" tag="label">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            <Text variant="caption">Show exhausted &amp; revoked</Text>
          </XStack>
        </XStack>

        <Separator />

        {listQuery.isLoading ? (
          <XStack padding="$5" justifyContent="center">
            <Spinner />
          </XStack>
        ) : listQuery.isError ? (
          <YStack padding="$5" gap="$2">
            <Text tone="error">Could not load fee waivers.</Text>
            <Text variant="caption" tone="muted">
              {formatErrorMessage(listQuery.error)}
            </Text>
          </YStack>
        ) : waivers.length === 0 ? (
          <YStack padding="$5">
            <Text variant="caption" tone="muted">
              {includeInactive
                ? "No fee waivers yet."
                : "No active fee waivers. Toggle above to see exhausted and revoked ones."}
            </Text>
          </YStack>
        ) : (
          waivers.map((waiver) => (
            <Row key={waiver.id}>
              <XStack alignItems="center" gap="$2" minWidth={220} flex={2}>
                {waiver.subjectType === "ORG" ? (
                  <Building2 size={16} color="var(--colorMuted)" />
                ) : (
                  <User size={16} color="var(--colorMuted)" />
                )}
                <YStack gap="$1" flex={1}>
                  <Text weight="semibold">
                    {waiver.subjectLabel ?? waiver.subjectId}
                  </Text>
                  <HintText>
                    {waiver.side === "ORGANIZER"
                      ? "Organiser — tickets sold"
                      : "Buyer — tickets bought"}
                  </HintText>
                </YStack>
              </XStack>

              <UsageBar
                used={waiver.ticketsUsed}
                granted={waiver.ticketsGranted}
              />

              <YStack gap="$1" minWidth={120}>
                <Text
                  variant="caption"
                  weight="semibold"
                  color={STATUS_COLOR[waiver.status] ?? "$color"}
                >
                  {waiver.status}
                </Text>
                {waiver.effectiveTo ? (
                  <HintText>
                    Expires {new Date(waiver.effectiveTo).toLocaleDateString()}
                  </HintText>
                ) : null}
                {waiver.notes ? <HintText>{waiver.notes}</HintText> : null}
              </YStack>

              <XStack minWidth={120} justifyContent="flex-end">
                {waiver.status === "REVOKED" ? null : (
                  <Button
                    size="$2"
                    variant="outlined"
                    disabled={revokeMutation.isPending}
                    onPress={() =>
                      revokeMutation.mutate({ waiverId: waiver.id })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </XStack>
            </Row>
          ))
        )}
      </SectionCard>

      <HintText>
        Revoking stops future checkouts from drawing on an allowance. Tickets
        already reserved or sold keep their discount — those buyers were quoted
        that price.
      </HintText>
    </YStack>
  );
}
