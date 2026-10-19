"use client";

import { Pencil } from "lucide-react";
import { useTranslations } from "@th/ui";

import { useVenueEditorLink } from "./useVenueEditorLink";
import placeStyles from "./place-entity.module.css";

type Props = {
  placeId: string;
};

/**
 * Viewer-aware "Edit page" chip, mounted last among the venue's action chips,
 * just ahead of the `⋯` overflow. Renders ONLY when the signed-in viewer can
 * edit this venue (see `useVenueEditorLink`); for everyone else it returns
 * null and the row closes up around it.
 *
 * It wears `.directionsButton` — the action row's shared secondary chip
 * (transparent fill, 2px `--place-rule` border, inverts to `--place-accent` on
 * hover) — so it reads as a sibling of the other options rather than as
 * grafted-on owner tooling. `HumanHero` / `OrgHero` reuse that class the same
 * way.
 *
 * PHONES: this chip is `display: none` below 640px (`.editPageChip`), where
 * `PlaceHeroActions` carries "Edit page" as the FIRST item in the `⋯` menu
 * instead — six chips wrapped to five lines on a 320px screen. The swap is
 * pure CSS on both halves, deliberately: these pages are server-rendered and
 * edge-cached, so a JS viewport branch would render differently on the server
 * than on the client. Exactly one of the two is in the accessibility tree at
 * any width, because `display: none` (unlike `visibility`/`opacity`) removes
 * the node from it.
 */
export function EditPageButton({ placeId }: Props) {
  const t = useTranslations();
  const { href } = useVenueEditorLink(placeId);

  if (!href) return null;

  return (
    <a
      href={href}
      className={`${placeStyles.directionsButton} ${placeStyles.editPageChip}`}
    >
      <Pencil size={16} aria-hidden />
      {String(t("places.editPage"))}
    </a>
  );
}
