"use client";

import { useCallback, useId, useState } from "react";
import { YStack } from "tamagui";
import {
  Button,
  Modal,
  Text,
  TextInput,
  Popover,
  useNotify,
  useTranslations,
} from "@th/ui";
import {
  MoreVertical,
  Ban,
  ShieldCheck,
  ShieldOff,
  Mail,
  Key,
  Trash2,
} from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { MUTED_TEXT } from "@/lib/design-tokens";
import { ManageAccountsDialog } from "./ManageAccountsDialog";
import { DeleteHumanDialog } from "./DeleteHumanDialog";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface HumanActionRow {
  id: string;
  name: string | null;
  status: string;
  identity: {
    email: string;
    emailVerified: boolean;
  } | null;
  /**
   * `platform.listHumans`' pre-flight: force-verify would be refused with
   * FORCE_VERIFY_HOLDS_EMAIL_ATTACHED. A hint only; `null`/absent leaves the
   * action live for the server to decide.
   */
  holdsEmailAttachedRows?: boolean | null;
}

export interface HumanActionsProps {
  row: HumanActionRow;
  /** Called after any mutation succeeds to refetch the table. */
  onMutationSuccess: () => void;
  /**
   * Menu trigger sizing. "sm" (default) keeps the compact ~34px ghost icon
   * button used in the desktop table column; "lg" renders the same trigger
   * with a 44x44 minimum hit area for touch surfaces (mobile card mode).
   */
  triggerSize?: "sm" | "lg";
  /**
   * Whether the current staff actor is a platform ADMIN. All four
   * human-management mutations (setHumanStatus / forceVerifyEmail /
   * unlinkAuthAccount / deleteHuman) are ADMIN-only server-side, so non-admin
   * staff (REVIEWER / SUPPORT) get no action menu — the row stays view-only.
   */
  isPlatformAdmin: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu item style (plain CSS-in-JS, no border-radius per Swiss style)
// ─────────────────────────────────────────────────────────────────────────────

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 16px",
  cursor: "pointer",
  border: "none",
  background: "transparent",
  width: "100%",
  fontSize: 12,
  fontFamily: "var(--font-body, Montserrat, sans-serif)",
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: "var(--color, #211C16)",
  textAlign: "left",
  transition: "background-color 150ms ease-out",
};

/** The reason under an unavailable item: sentence case, not the menu's caps. */
const forceVerifyReasonStyle: React.CSSProperties = {
  margin: 0,
  padding: "0 16px 10px 40px",
  maxWidth: 280,
  fontSize: 12,
  lineHeight: 1.45,
  fontFamily: "var(--font-body, Montserrat, sans-serif)",
  color: MUTED_TEXT,
};

const menuDividerStyle: React.CSSProperties = {
  height: 1,
  backgroundColor: "var(--borderColor, #211C16)",
  margin: "4px 0",
};

function MenuButton({
  children,
  danger,
  onClick,
  unavailable,
  describedBy,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  /**
   * Shown but not actionable. `aria-disabled` rather than `disabled` keeps the
   * item focusable, so its `describedBy` reason is read when it is reached.
   */
  unavailable?: boolean;
  describedBy?: string;
}) {
  const dangerColor = "var(--danger, #B91C1C)";
  const hoverBg = danger
    ? "rgba(239, 68, 68, 0.08)"
    : "var(--surfaceMuted, #EFE7D6)";
  return (
    <button
      type="button"
      style={{
        ...menuItemStyle,
        ...(danger ? { color: dangerColor } : undefined),
        ...(unavailable
          ? { color: MUTED_TEXT, cursor: "not-allowed" }
          : undefined),
      }}
      aria-disabled={unavailable || undefined}
      aria-describedby={describedBy}
      onClick={unavailable ? undefined : onClick}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
      onMouseLeave={(e) =>
        (e.currentTarget.style.backgroundColor = "transparent")
      }
      onFocus={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
      onBlur={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function HumanActions({
  row,
  onMutationSuccess,
  triggerSize = "sm",
  isPlatformAdmin,
}: HumanActionsProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const forceVerifyReasonId = useId();

  // Menu open state
  const [menuOpen, setMenuOpen] = useState(false);

  // Confirmation prompt (for status changes)
  const [confirmAction, setConfirmAction] = useState<{
    label: string;
    status: "ACTIVE" | "SUSPENDED" | "BANNED";
  } | null>(null);

  // Sub-dialogs
  const [showManageAccounts, setShowManageAccounts] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  // ── Mutations ──────────────────────────────────────────────────────

  const setStatusMut = trpc.platform.setHumanStatus.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      utils.platform.listHumans.invalidate();
      onMutationSuccess();
    },
  });

  const forceVerifyMut = trpc.platform.forceVerifyEmail.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      utils.platform.listHumans.invalidate();
      onMutationSuccess();
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────

  const handleStatusChange = useCallback(
    async (status: "ACTIVE" | "SUSPENDED" | "BANNED", reason?: string) => {
      try {
        await setStatusMut.mutateAsync({
          humanId: row.id,
          status,
          reason: reason || undefined,
        });
        toast.success({
          title: String(t("admin.phStatusChanged")),
        });
      } catch (err) {
        toast.danger({
          title: String(t("admin.phStatusChangeFailed")),
          message: formatErrorMessage(err, t),
        });
      }
      setConfirmAction(null);
    },
    [row.id, setStatusMut, toast, t],
  );

  const handleForceVerify = useCallback(async () => {
    setMenuOpen(false);
    try {
      await forceVerifyMut.mutateAsync({ humanId: row.id });
      toast.success({
        title: String(t("admin.phForceVerified")),
      });
    } catch (err) {
      toast.danger({
        title: String(t("admin.phForceVerifyFailed")),
        message: formatErrorMessage(err, t),
      });
    }
  }, [row.id, forceVerifyMut, toast, t]);

  const openConfirm = useCallback(
    (label: string, status: "ACTIVE" | "SUSPENDED" | "BANNED") => {
      setMenuOpen(false);
      setConfirmAction({ label, status });
    },
    [],
  );

  // ── Derive available actions ──────────────────────────────────────

  const canSuspend = row.status === "ACTIVE" || row.status === "INVITED";
  const canBan = row.status !== "BANNED";
  const canReactivate = row.status === "SUSPENDED" || row.status === "BANNED";
  const canForceVerify = row.identity && !row.identity.emailVerified;
  const forceVerifyBlocked = row.holdsEmailAttachedRows === true;

  // ── Action gate ───────────────────────────────────────────────────
  // Every action this menu exposes (suspend / ban / reactivate / force-verify
  // / manage accounts / delete) maps to an ADMIN-only server mutation. Non-
  // admin staff (REVIEWER / SUPPORT) can view the roster but get no menu — the
  // row is view-only rather than an empty popover of 403s.
  if (!isPlatformAdmin) {
    return null;
  }

  // ── Anchor button ─────────────────────────────────────────────────

  const anchorButton = (
    <Button
      variant="ghost"
      size="$2"
      // "lg" grows the interactive element itself to the 44px touch
      // minimum (icon stays 16px, centered); "sm" leaves the compact
      // desktop-table rendering untouched.
      {...(triggerSize === "lg"
        ? { minWidth: 44, minHeight: 44, paddingHorizontal: 0 }
        : {})}
      onPress={() => setMenuOpen((o) => !o)}
      aria-label={String(t("admin.phActions"))}
    >
      <MoreVertical size={16} />
    </Button>
  );

  return (
    <>
      <Popover
        anchor={anchorButton}
        open={menuOpen}
        placement="bottom-end"
        matchAnchorWidth={false}
        contentProps={{ minWidth: 220 }}
      >
        <YStack>
          {/* Status actions */}
          {canSuspend && (
            <MenuButton
              onClick={() =>
                openConfirm(String(t("admin.phSuspend")), "SUSPENDED")
              }
            >
              <ShieldOff size={14} />
              {String(t("admin.phSuspend"))}
            </MenuButton>
          )}
          {canBan && (
            <MenuButton
              onClick={() => openConfirm(String(t("admin.phBan")), "BANNED")}
            >
              <Ban size={14} />
              {String(t("admin.phBan"))}
            </MenuButton>
          )}
          {canReactivate && (
            <MenuButton
              onClick={() =>
                openConfirm(String(t("admin.phReactivate")), "ACTIVE")
              }
            >
              <ShieldCheck size={14} />
              {String(t("admin.phReactivate"))}
            </MenuButton>
          )}

          {/* Force verify */}
          {canForceVerify && (
            <MenuButton
              onClick={handleForceVerify}
              unavailable={forceVerifyBlocked}
              describedBy={forceVerifyBlocked ? forceVerifyReasonId : undefined}
            >
              <Mail size={14} />
              {String(t("admin.phForceVerify"))}
            </MenuButton>
          )}
          {canForceVerify && forceVerifyBlocked && (
            <p
              id={forceVerifyReasonId}
              data-testid="force-verify-blocked-reason"
              style={forceVerifyReasonStyle}
            >
              {String(t("admin.phForceVerifyBlocked"))}
            </p>
          )}

          <div style={menuDividerStyle} />

          {/* Manage accounts */}
          <MenuButton
            onClick={() => {
              setMenuOpen(false);
              setShowManageAccounts(true);
            }}
          >
            <Key size={14} />
            {String(t("admin.phManageAccounts"))}
          </MenuButton>

          <div style={menuDividerStyle} />

          {/* Delete */}
          <MenuButton
            danger
            onClick={() => {
              setMenuOpen(false);
              setShowDelete(true);
            }}
          >
            <Trash2 size={14} />
            {String(t("admin.phDeleteHuman"))}
          </MenuButton>
        </YStack>
      </Popover>

      {/* Close menu on outside click */}
      {menuOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 999,
          }}
          onClick={() => setMenuOpen(false)}
        />
      )}

      {/* ── Inline confirm modal ───────────────────────────────────── */}
      <StatusConfirmModal
        open={confirmAction !== null}
        label={confirmAction?.label ?? ""}
        showReason={
          confirmAction?.status === "SUSPENDED" ||
          confirmAction?.status === "BANNED"
        }
        humanName={row.name ?? row.identity?.email ?? row.id}
        isPending={setStatusMut.isPending}
        onConfirm={(reason) => {
          if (confirmAction) handleStatusChange(confirmAction.status, reason);
        }}
        onClose={() => setConfirmAction(null)}
      />

      {/* ── Manage accounts dialog ─────────────────────────────────── */}
      <ManageAccountsDialog
        open={showManageAccounts}
        onClose={() => setShowManageAccounts(false)}
        humanId={row.id}
        humanName={row.name ?? row.identity?.email ?? row.id}
        onMutationSuccess={onMutationSuccess}
      />

      {/* ── Delete dialog ──────────────────────────────────────────── */}
      <DeleteHumanDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        humanId={row.id}
        humanEmail={row.identity?.email ?? ""}
        humanName={row.name ?? row.identity?.email ?? row.id}
        onDeleted={onMutationSuccess}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status confirm modal (inline, lightweight)
// ─────────────────────────────────────────────────────────────────────────────

function StatusConfirmModal({
  open,
  label,
  showReason,
  humanName,
  isPending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  label: string;
  showReason?: boolean;
  humanName: string;
  isPending: boolean;
  onConfirm: (reason?: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState("");

  const handleClose = () => {
    setReason("");
    onClose();
  };

  const handleConfirm = () => {
    onConfirm(reason.trim() || undefined);
    setReason("");
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <Modal.Panel width={400}>
        <Modal.Header title={label} onClose={handleClose} />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body">
              {String(
                t("admin.phStatusConfirmBody", {
                  name: humanName,
                  action: label,
                }),
              )}
            </Text>
            {showReason && (
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder={String(t("admin.phReasonPlaceholder"))}
                fullWidth
                testId="status-reason-input"
              />
            )}
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={handleClose} disabled={isPending}>
            {String(t("admin.cancel"))}
          </Button>
          <Button
            variant="primary"
            onPress={handleConfirm}
            disabled={isPending}
          >
            {isPending ? String(t("admin.saving")) : label}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
