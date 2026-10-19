"use client";

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import { Platform } from "react-native";

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  MessageCircle,
} from "lucide-react";
import { Stack, YStack, styled, type StackProps } from "tamagui";

import { Text } from "../typography/Text";
import { Alert, type AlertVariant } from "../feedback/Alert";
import { mergeDefinedLabels } from "./merge-labels";
import { useNotificationContext } from "./NotificationProvider";
import {
  ALERT_DATA_ATTRIBUTE,
  type AlertConfig,
  type ToastVariant,
} from "./types";

/** Maps alert tone to an appropriate icon */
const getIconForTone = (tone: ToastVariant) => {
  switch (tone) {
    case "success":
      return <CheckCircle2 size={18} />;
    case "warning":
      return <AlertTriangle size={18} />;
    case "danger":
      return <AlertCircle size={18} />;
    case "neutral":
      return <MessageCircle size={18} />;
    case "info":
    default:
      return <Info size={18} />;
  }
};

const AlertsContainer = styled(YStack, {
  name: "NotificationAlertContainer",
  gap: "$3",
  width: "100%",
});

const DropIndicator = styled(Stack, {
  name: "NotificationAlertDropIndicator",
  borderRadius: 0,
  borderWidth: 2,
  borderStyle: "dashed",
  borderColor: "transparent",
  paddingVertical: "$2",
  paddingHorizontal: "$3",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 36,
});

const CONTAINER_DROP_ID = "__alerts-container__";

const createDataAttributes = (attrs?: AlertConfig["dataAttrs"]) => {
  if (!attrs) {
    return {} as Record<string, string>;
  }
  return Object.entries(attrs).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (typeof value === "string" && value.length > 0) {
        const attrKey = key.startsWith("data-") ? key : `data-${key}`;
        acc[attrKey] = value;
      }
      return acc;
    },
    {},
  );
};

interface AlertItemProps extends Omit<StackProps, "role"> {
  alert: AlertConfig;
  onDismiss: (id: string) => void;
  isDragOver?: boolean;
  isDragging?: boolean;
  dragEnabled?: boolean;
  positionInSet: number;
  listSize: number;
  labels: NotificationAlertLabels;
}

/** Use "surface" variant: neutral card background, accent color only on icons */
const NOTIFICATION_ALERT_VARIANT: AlertVariant = "surface";

/**
 * The alert list's own words, for a host with a catalog. Any entry left out
 * (or passed `undefined`) keeps its English default. An alert's own
 * `dismissLabel` still wins over `dismiss`.
 */
export interface NotificationAlertLabels {
  /** Accessible name of each alert's dismiss control. */
  dismiss: string;
  /** `aria-roledescription` of an alert while the list can be reordered. */
  draggable: string;
  /** Text of the drop target that moves a dragged alert to the bottom. */
  dropToBottom: string;
}

export const DEFAULT_NOTIFICATION_ALERT_LABELS: NotificationAlertLabels = {
  dismiss: "Dismiss alert",
  draggable: "Draggable alert",
  dropToBottom: "Drop here to move to bottom",
};

const AlertItem = memo(
  ({
    alert,
    onDismiss,
    isDragOver = false,
    isDragging = false,
    dragEnabled = false,
    positionInSet,
    listSize,
    labels,
    ...stackProps
  }: AlertItemProps) => {
    const tone = (alert.variant ?? "info") as ToastVariant;
    const icon = useMemo(() => getIconForTone(tone), [tone]);
    const dataAttributes = useMemo(
      () => createDataAttributes(alert.dataAttrs),
      [alert.dataAttrs],
    );
    const handleDismiss = useCallback(() => {
      onDismiss(alert.id);
    }, [alert.id, onDismiss]);
    const borderColor = isDragOver ? "$colorFocus" : undefined;
    const borderStyle = isDragOver ? "dashed" : undefined;
    const opacity = isDragging ? 0.65 : 1;
    const cursor = dragEnabled ? (isDragging ? "grabbing" : "grab") : undefined;
    const resolvedRole: "alert" | "status" | undefined =
      alert.role === "alert"
        ? "alert"
        : alert.role === "status"
          ? "status"
          : undefined;
    const isDismissible = alert.dismissible !== false;
    const dismissLabel = alert.dismissLabel ?? labels.dismiss;

    return (
      <Alert
        tone={tone}
        variant={NOTIFICATION_ALERT_VARIANT}
        icon={icon}
        compact
        fullWidth
        data-th={ALERT_DATA_ATTRIBUTE}
        aria-grabbed={dragEnabled ? isDragging : undefined}
        aria-setsize={listSize}
        aria-posinset={positionInSet}
        aria-roledescription={dragEnabled ? labels.draggable : undefined}
        opacity={opacity}
        borderColor={borderColor}
        borderStyle={borderStyle}
        cursor={cursor}
        title={alert.title}
        description={alert.message}
        role={resolvedRole}
        onDismiss={isDismissible ? handleDismiss : undefined}
        dismissLabel={dismissLabel}
        {...dataAttributes}
        {...stackProps}
      />
    );
  },
);

AlertItem.displayName = "NotificationAlertItem";

export interface NotificationAlertProps extends StackProps {
  renderContainer?: (children: ReactNode) => ReactNode;
  /** Translated labels; see `NotificationAlertLabels`. Pass a stable
   * (memoised) object. */
  labels?: Partial<NotificationAlertLabels>;
}

type AlertDragEvent = DragEvent<HTMLDivElement>;

export const NotificationAlert = memo(
  ({
    renderContainer,
    labels: labelsProp,
    ...stackProps
  }: NotificationAlertProps) => {
    const labels = useMemo(
      () => mergeDefinedLabels(DEFAULT_NOTIFICATION_ALERT_LABELS, labelsProp),
      [labelsProp],
    );
    const { state, removeAlert, reorderAlerts } = useNotificationContext();
    const isWeb = Platform.OS === "web";
    const totalAlerts = state.alerts.length;
    const dragEnabled = isWeb && totalAlerts > 1;
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    const { role: providedRole, ...alertItemStackProps } = stackProps;

    const handleReorder = useCallback(
      (sourceId: string, targetId: string | null) => {
        if (sourceId === targetId) {
          return;
        }
        const ids = state.alerts.map((alert) => alert.id);
        const fromIndex = ids.indexOf(sourceId);
        if (fromIndex === -1) {
          return;
        }
        ids.splice(fromIndex, 1);
        if (targetId) {
          const toIndex = ids.indexOf(targetId);
          if (toIndex === -1) {
            ids.push(sourceId);
          } else {
            ids.splice(toIndex, 0, sourceId);
          }
        } else {
          ids.push(sourceId);
        }
        reorderAlerts(ids);
      },
      [state.alerts, reorderAlerts],
    );

    const handleDragStart = useCallback(
      (id: string, event: AlertDragEvent) => {
        if (!dragEnabled) {
          return;
        }
        event.stopPropagation();
        setDraggingId(id);
        setDragOverId(null);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", id);
        }
      },
      [dragEnabled],
    );

    const handleDragEnter = useCallback(
      (id: string, event: AlertDragEvent) => {
        if (!dragEnabled || !draggingId || id === draggingId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setDragOverId(id);
      },
      [dragEnabled, draggingId],
    );

    const handleDragOver = useCallback(
      (id: string, event: AlertDragEvent) => {
        if (!dragEnabled || !draggingId || id === draggingId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        if (dragOverId !== id) {
          setDragOverId(id);
        }
      },
      [dragEnabled, draggingId, dragOverId],
    );

    const handleDragLeave = useCallback(
      (id: string, event: AlertDragEvent) => {
        if (!dragEnabled) {
          return;
        }
        event.stopPropagation();
        setDragOverId((current) => (current === id ? null : current));
      },
      [dragEnabled],
    );

    const handleDrop = useCallback(
      (id: string, event: AlertDragEvent) => {
        if (!dragEnabled || !draggingId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const sourceId = draggingId;
        setDraggingId(null);
        setDragOverId(null);
        handleReorder(sourceId, id);
      },
      [dragEnabled, draggingId, handleReorder],
    );

    const handleDragEnd = useCallback((event: AlertDragEvent) => {
      event.preventDefault();
      setDraggingId(null);
      setDragOverId(null);
    }, []);

    const handleContainerDragOver = useCallback(
      (event: AlertDragEvent) => {
        if (!dragEnabled || !draggingId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        if (dragOverId !== CONTAINER_DROP_ID) {
          setDragOverId(CONTAINER_DROP_ID);
        }
      },
      [dragEnabled, draggingId, dragOverId],
    );

    const handleContainerDrop = useCallback(
      (event: AlertDragEvent) => {
        if (!dragEnabled || !draggingId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const sourceId = draggingId;
        setDraggingId(null);
        setDragOverId(null);
        handleReorder(sourceId, null);
      },
      [dragEnabled, draggingId, handleReorder],
    );

    const handleContainerDragLeave = useCallback(() => {
      if (!dragEnabled) {
        return;
      }
      setDragOverId((current) =>
        current === CONTAINER_DROP_ID ? null : current,
      );
    }, [dragEnabled]);

    if (!totalAlerts) {
      return null;
    }

    const indicatorProps = dragEnabled
      ? {
          onDragOver: handleContainerDragOver,
          onDragEnter: handleContainerDragOver,
          onDragLeave: handleContainerDragLeave,
          onDrop: handleContainerDrop,
        }
      : {};

    const content = (
      <AlertsContainer role={providedRole ?? "list"} {...alertItemStackProps}>
        {state.alerts.map((alert, index) => {
          const position = index + 1;
          const isDragging = draggingId === alert.id;
          const isDragOver =
            dragEnabled && dragOverId === alert.id && !isDragging;
          const dragProps = dragEnabled
            ? {
                draggable: true,
                onDragStart: (event: AlertDragEvent) =>
                  handleDragStart(alert.id, event),
                onDragEnter: (event: AlertDragEvent) =>
                  handleDragEnter(alert.id, event),
                onDragOver: (event: AlertDragEvent) =>
                  handleDragOver(alert.id, event),
                onDragLeave: (event: AlertDragEvent) =>
                  handleDragLeave(alert.id, event),
                onDrop: (event: AlertDragEvent) => handleDrop(alert.id, event),
                onDragEnd: handleDragEnd,
              }
            : {};

          return (
            <AlertItem
              key={alert.id}
              alert={alert}
              onDismiss={removeAlert}
              isDragging={isDragging}
              isDragOver={!!isDragOver}
              dragEnabled={dragEnabled}
              positionInSet={position}
              listSize={totalAlerts}
              labels={labels}
              {...dragProps}
              {...alertItemStackProps}
            />
          );
        })}
        {dragEnabled && draggingId ? (
          <DropIndicator
            borderColor={
              dragOverId === CONTAINER_DROP_ID ? "$colorFocus" : "transparent"
            }
            opacity={dragOverId === CONTAINER_DROP_ID ? 1 : 0.4}
            backgroundColor={
              dragOverId === CONTAINER_DROP_ID ? "$surfaceMuted" : "transparent"
            }
            {...indicatorProps}
          >
            <Text variant="bodySmall" tone="muted">
              {labels.dropToBottom}
            </Text>
          </DropIndicator>
        ) : null}
      </AlertsContainer>
    );

    return renderContainer ? <>{renderContainer(content)}</> : content;
  },
);

NotificationAlert.displayName = "NotificationAlert";
