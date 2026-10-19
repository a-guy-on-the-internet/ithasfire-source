"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { useOverlayHost } from "./OverlayHost";
import type { OverlayController, OverlayMountOptions } from "./OverlayHost";

export type OverlayMountProps = {
  id: string;
  children: ReactNode;
  options?: OverlayMountOptions;
  priority?: number;
};

export const OverlayMount = ({
  id,
  children,
  options,
  priority,
}: OverlayMountProps) => {
  const { mount } = useOverlayHost();
  const controllerRef = useRef<OverlayController | null>(null);

  useEffect(() => {
    const controller = mount({ id, node: children, options, priority });
    controllerRef.current = controller;
    return () => {
      controller.remove();
      controllerRef.current = null;
    };
  }, [id, mount]);

  useEffect(() => {
    controllerRef.current?.update({ node: children, options, priority });
  }, [children, options, priority]);

  return null;
};

OverlayMount.displayName = "OverlayMount";
