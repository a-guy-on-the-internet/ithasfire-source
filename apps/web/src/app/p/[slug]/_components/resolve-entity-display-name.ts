import type { EntitySummary } from "@th/types/repos/entity-pages";

type NamedPage = {
  displayName?: string | null;
  slug?: string | null;
};

type NamedEntity = Pick<EntitySummary, "type"> & { name?: string | null };

/**
 * The name a public entity page shows for its subject.
 *
 * A VENUE HAS ONE NAME, and it is `Place.name`. `EntityPage.displayName`
 * stopped being a venue's name: a PLACE page no longer offers the field in the
 * editor (`PageFieldsEditor` renders no display-name input for a PLACE owner
 * and omits the key entirely from a PLACE save), so a divergent value left in
 * the column is a name nobody can still edit. Reading `Place.name` first is
 * what makes that true everywhere the page is rendered.
 *
 * The column is NOT dropped and its value is NOT destroyed — this is one
 * read-order change, reversible by flipping the PLACE branch back.
 *
 * HUMAN and ORGANIZATION keep `displayName` FIRST. It is still their editable
 * field, and the two expressions are otherwise identical — which is exactly
 * why the rule lives here once instead of being copied per header.
 */
export function resolveEntityDisplayName(
  page: NamedPage,
  entity: NamedEntity,
): string {
  if (entity.type === "PLACE") {
    return entity.name ?? page.displayName ?? page.slug ?? "";
  }
  return page.displayName ?? entity.name ?? page.slug ?? "";
}
