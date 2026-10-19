"use client";

import {
  use,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, useTheme } from "tamagui";
import {
  Text,
  Button,
  useNotify,
  Spinner,
  useTranslations,
} from "@th/ui";
import { ArrowLeft, Save, MapPin, AlertTriangle } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { forwardGeocode } from "@/lib/maps/geocoding";
import type { ResolvedAddress } from "@/components/maps/AddressAutocompleteInput";
import {
  placePrivacyToUpsertInput,
  placePrivacyValueFromRecord,
  type PlaceLocationPrivacyValue,
} from "@/components/places/PlaceLocationPrivacyFields";
import {
  PageSettingsSaveProvider,
  usePageSettingsSave,
} from "@/components/entity-pages/page-settings-save";

import { PlaceEditSection } from "./_components/PlaceEditSection";
import { IdentitySection } from "./_components/IdentitySection";
import { LocationSection } from "./_components/LocationSection";
import { VerificationSection } from "./_components/VerificationSection";
import { PublicPageSection } from "./_components/PublicPageSection";
import { ReviewsSection } from "./_components/ReviewsSection";
import { OwnershipStatusSection } from "./_components/OwnershipStatusSection";
import { SettingsSectionIndex } from "./_components/SettingsSectionIndex";
import { SettingsStatusChips } from "./_components/SettingsStatusChips";
import {
  ArrivalAreasEditor,
  useArrivalAreasEditorEnabled,
} from "@/components/maps/ArrivalAreasEditor";

// ─────────────────────────────────────────────────────────────────────────────
// Venue settings — ONE page for what used to be three surfaces (FR-401):
// the details form (`/edit`), the verification workflow (`/verify`) and the
// settings half of the public-page editor (`/page`'s collapsed drawer). Both
// old routes now redirect here; `/page` keeps only the block canvas.
//
// The approved design is "Option A — open stack": every section EXPANDED,
// nothing behind a disclosure, a sticky section index on the left and a status
// chip strip in the header. Option B (collapsed state rows) was rejected on
// evidence — this product already lost the venue booking switch to a collapsed
// settings drawer once: an owner looked for it, failed, and reported that it
// did not exist.
//
// Sections, in order: Identity · Location · Verification · Public page ·
// Reviews & feedback · Ownership & status.
//
// ── The rulings ─────────────────────────────────────────────────────────────
// * ONE Save for the page. It commits the place form below AND the Public
//   page section's Profile/Theme forms (see `handleSave`).
// * Verification keeps its OWN submit, deliberately outside that Save: it
//   judges SAVED data, not the draft, which is why it is handed `isDirty` and
//   refuses to start while the form has unsaved edits.
// * Reviews moved out of page settings: publishing ratings is a venue policy,
//   not page content.
//
// ── What was MOVED here, not rewritten ──────────────────────────────────────
// Everything from "Local form state" to the save latch came from
// `edit/page.tsx` with its comments. Four of those comments document
// data-loss fixes that each reached production — lat/lng held as form state,
// `formattedAddress` preservation, `||` not `??` in `hasAddress`, and
// `saveInFlightRef`. Do not "simplify" any of them without reading why.
//
// ── Layout ──────────────────────────────────────────────────────────────────
// `.th-place-settings` (globals.css) is a CONTAINER-query parent; the grid,
// the index's two presentations and the header-Save/save-bar hand-over all
// query it. See the block there for the re-derived 708px threshold.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heading ids — also the section index's jump targets and the fragments the
 * old routes redirect to (`/verify` → `#verification`).
 */
const SECTION_IDS = {
  identity: "identity",
  location: "location",
  gettingThere: "getting-there",
  verification: "verification",
  publicPage: "public-page",
  reviews: "reviews",
  ownership: "ownership",
} as const;

type PageProps = {
  params: Promise<{ slug: string; placeId: string }>;
};

/**
 * The provider sits ABOVE the view on purpose: the view's Save CONSUMES the
 * aggregate the Public page section's forms register, and a component cannot
 * read a context it provides in its own render.
 */
export default function AdminPlaceSettingsPage({ params }: PageProps) {
  return (
    <PageSettingsSaveProvider>
      <PlaceSettingsView params={params} />
    </PageSettingsSaveProvider>
  );
}

function PlaceSettingsView({ params }: PageProps) {
  const { slug, placeId } = use(params);
  const router = useRouter();
  const { toast } = useNotify();
  const t = useTranslations();
  const arrivalAreasEnabled = useArrivalAreasEditorEnabled();
  const utils = trpc.useUtils();
  const theme = useTheme();
  const pageSettingsSave = usePageSettingsSave();

  // Dedicated query — fetches this specific place by ID with ownership check.
  //
  // `includeOwners` is opt-in and this is the ONE surface that opts in: the
  // Ownership & status section is the only place the resolved owner names are
  // rendered, and the flag costs up to four extra batched round-trips that
  // the read's other callers (the page tab, the public "Edit" probe) would
  // otherwise pay for a field they never read. It also makes this a distinct
  // query key from theirs, which is fine — `invalidate({ placeId })`
  // partial-matches both.
  const {
    data: placeData,
    isLoading,
    error,
    dataUpdatedAt,
  } = trpc.places.getPlaceForEdit.useQuery(
    { placeId, includeOwners: true },
    { staleTime: 10_000, retry: 2 },
  );

  const place = placeData?.place ?? null;
  const isVerified = place?.verificationStatus === "VERIFIED";

  // The header's page-visibility chip. Same query + key the Public page
  // section (and `/page`'s editor) use, so React Query dedupes it. `/page`
  // only offers the page to a VERIFIED venue, so neither does this.
  const pageQuery = trpc.entityPages.getMyPage.useQuery(
    { ownerType: "PLACE", ownerId: placeId },
    { staleTime: 10_000, retry: 2, enabled: isVerified },
  );
  const pageVisibility = isVerified
    ? (pageQuery.data?.page?.visibility ?? null)
    : null;

  // Local form state
  const [name, setName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [capacity, setCapacity] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");

  /**
   * Coordinates are FORM STATE now, not a display-only echo of the server row.
   *
   * Two reasons. FR-017: picking an autocomplete suggestion has to populate
   * lat/lng immediately, before any save. And a data-loss bug this surface has
   * been quietly causing — the Prisma adapter's place upsert writes
   * `lat: input.geo?.lat ?? null` on UPDATE, so every save that omitted geo
   * (i.e. every save where the address happened to be clean) NULLED the stored
   * coordinates. Seeded Bowery Ballroom lost its 40.7204/-73.9938 exactly this
   * way. Carrying the current values in state and always sending them makes
   * the save idempotent instead of destructive.
   */
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);

  /**
   * True once the coordinates came from an autocomplete SELECTION for the
   * address currently in the fields. It is what lets the save-time
   * `forwardGeocode` be skipped: we already have the provider's exact answer,
   * so re-asking would spend a credit to learn the same thing. Any manual edit
   * to an address field clears it — hand-typed text has never been geocoded.
   */
  const [coordsFromSelection, setCoordsFromSelection] = useState(false);

  /**
   * ADDRESS PRIVACY (place-address-withholding). Form state, seeded from the
   * stored triple below.
   *
   * Initialised to the WITHHELD, no-map state rather than "exact": this value
   * is read by the render before the query resolves, and the one moment the
   * form must not guess is the moment it does not know yet.
   */
  const [privacy, setPrivacy] = useState<PlaceLocationPrivacyValue>(() =>
    placePrivacyValueFromRecord({}),
  );

  /** FR-016 manual-entry fallback: whether the structured fields are revealed. */
  const [manualOpen, setManualOpen] = useState(false);

  /** Set when the country field holds a half-typed 1-character code. */
  const [countryError, setCountryError] = useState(false);

  /**
   * NEVER RESEED OVER A DRAFT. On `/edit` this effect could only be re-run by
   * the page's own save (its invalidation). On the merged page it is not
   * alone: the review switches, the verification withdraw and the request
   * form ALL invalidate `getPlaceForEdit` too, and every one of those would
   * hand this effect a new `place` and silently overwrite whatever the owner
   * had typed into Identity or Location but not yet saved.
   *
   * So the effect reseeds only (a) on first load, (b) when the form had no
   * unsaved edits — reseeding is then a no-op for the fields — or (c) right
   * after THIS page's own place save, which is the one refetch the save latch
   * below is waiting for. `formDirtyRef` is written by an effect declared
   * AFTER this one, so here it still holds the PREVIOUS commit's answer:
   * "was the form dirty before the new data arrived", which is exactly the
   * question.
   */
  const seededRef = useRef(false);
  const formDirtyRef = useRef(false);
  const reseedAfterSaveRef = useRef(false);

  // Seed form when place loads
  useEffect(() => {
    if (place) {
      if (
        seededRef.current &&
        formDirtyRef.current &&
        !reseedAfterSaveRef.current
      ) {
        return;
      }
      seededRef.current = true;
      reseedAfterSaveRef.current = false;
      setName(place.name ?? "");
      setAddressLine1(place.addressLine1 ?? "");
      setAddressLine2(place.addressLine2 ?? "");
      setCity(place.city ?? "");
      setRegion(place.region ?? "");
      setPostalCode(place.postalCode ?? "");
      setCountryCode(place.countryCode ?? "US");
      setCapacity(place.capacity ? String(place.capacity) : "");
      setPhone(place.phone ?? "");
      setWebsite(place.website ?? "");
      setLat(place.lat ?? null);
      setLng(place.lng ?? null);
      setPrivacy(placePrivacyValueFromRecord(place));
      setCoordsFromSelection(false);
      setCountryError(false);
      // Monotonic: a place that already HAS an address shows its fields, but a
      // refetch (this effect re-runs after every save invalidation) must never
      // collapse a section the user opened themselves.
      //
      // `||`, NOT `??`. Several of these columns hold the EMPTY STRING rather
      // than null (the addressless convention this codebase already writes —
      // "Logan Square DIY" is `addrLine1: ""` in the seed data), and `??` only
      // skips null/undefined: `"" ?? place.city` short-circuits to `""` and
      // the whole check reads false. That collapsed the fields on a place with
      // a full city/region/postcode — caught by driving the real page, not by
      // any unit test.
      const hasAddress = Boolean(
        place.addressLine1 ||
        place.addressLine2 ||
        place.city ||
        place.region ||
        place.postalCode,
      );
      if (hasAddress) setManualOpen(true);
    }
    // `dataUpdatedAt`, not just `place`: React Query's structural sharing
    // hands back the SAME `place` object when a refetch returns identical
    // data (a save whose only change the server normalised away, e.g. a
    // trimmed trailing space). Keyed on `place` alone, this effect would not
    // run after such a save, `reseedAfterSaveRef` would stay armed, and the
    // NEXT unrelated refetch (a review switch) would reseed over a newer
    // draft. Every successful fetch moves `dataUpdatedAt`, so the flag is
    // always consumed by the refetch it was set for.
  }, [place, dataUpdatedAt]);

  /**
   * The privacy triple this save would WRITE, and whether it differs from the
   * stored one. Derived through `placePrivacyToUpsertInput` so the dirty test
   * and the payload can never disagree about what "changed" means.
   */
  const privacyInput = useMemo(
    () => placePrivacyToUpsertInput(privacy),
    [privacy],
  );
  const privacyChanged = useMemo(() => {
    if (!place) return false;
    const stored = placePrivacyToUpsertInput(
      placePrivacyValueFromRecord(place),
    );
    return (
      privacyInput.locationMode !== stored.locationMode ||
      privacyInput.locationRadiusMeters !== stored.locationRadiusMeters ||
      privacyInput.locationLabel !== stored.locationLabel
    );
  }, [place, privacyInput]);

  // Dirty tracking — compare current form state to last-loaded server values
  const isDirty = useMemo(() => {
    if (!place) return false;
    return (
      name !== (place.name ?? "") ||
      addressLine1 !== (place.addressLine1 ?? "") ||
      addressLine2 !== (place.addressLine2 ?? "") ||
      city !== (place.city ?? "") ||
      region !== (place.region ?? "") ||
      postalCode !== (place.postalCode ?? "") ||
      countryCode !== (place.countryCode ?? "US") ||
      capacity !== (place.capacity ? String(place.capacity) : "") ||
      phone !== (place.phone ?? "") ||
      website !== (place.website ?? "") ||
      // Selecting a suggestion can leave every text field identical (same
      // address, better coordinates) — without this the Save CTA would never
      // arm and the resolved lat/lng would be unsaveable.
      lat !== (place.lat ?? null) ||
      lng !== (place.lng ?? null) ||
      // Compared through the SAME projection the save sends, so "no change"
      // here means "this save would write the same three columns" — comparing
      // the form value instead would arm Save for a radius the owner nudged
      // while the withheld card was selected, which sends nothing.
      privacyChanged
    );
  }, [
    place,
    privacyChanged,
    name,
    addressLine1,
    addressLine2,
    city,
    region,
    postalCode,
    countryCode,
    capacity,
    phone,
    website,
    lat,
    lng,
  ]);

  /** True when any of the location-specific fields have been changed. */
  const isAddressDirty = useMemo(() => {
    if (!place) return false;
    return (
      addressLine1 !== (place.addressLine1 ?? "") ||
      addressLine2 !== (place.addressLine2 ?? "") ||
      city !== (place.city ?? "") ||
      region !== (place.region ?? "") ||
      postalCode !== (place.postalCode ?? "") ||
      countryCode !== (place.countryCode ?? "US")
    );
  }, [
    place,
    addressLine1,
    addressLine2,
    city,
    region,
    postalCode,
    countryCode,
  ]);

  // Read by the seeding effect above on the NEXT commit — see "NEVER RESEED
  // OVER A DRAFT". Declared after it on purpose so it runs after it.
  useEffect(() => {
    formDirtyRef.current = isDirty;
  }, [isDirty]);

  /**
   * Any hand-edit to an address field invalidates the "these coordinates were
   * resolved for this exact address" claim, so the save-time geocode re-arms.
   * Wrapping the setters (rather than clearing the flag in an effect) keeps the
   * invalidation on the user's action, where it can't race a re-render.
   */
  const editAddressField = useCallback(
    (setter: (value: string) => void) => (value: string) => {
      setCoordsFromSelection(false);
      setter(value);
    },
    [],
  );

  // FR-017: a selection fills the structured fields AND the coordinates right
  // now — nothing here waits for Save.
  const handleAddressSelect = useCallback((resolved: ResolvedAddress) => {
    setAddressLine1(resolved.line1);
    // `line2` is deliberately NOT cleared. Geoapify never returns a unit, so
    // wiping it would silently destroy a hand-typed "Suite 4" that is still
    // correct for the building the user just picked. The field is visible
    // directly below the search box if it does need changing.
    setCity(resolved.city);
    setRegion(resolved.region);
    setPostalCode(resolved.postalCode);
    if (resolved.countryCode) setCountryCode(resolved.countryCode);
    setLat(resolved.lat);
    setLng(resolved.lng);
    setCoordsFromSelection(true);
    setCountryError(false);
    // Reveal the fields so the user can SEE what was filled in and correct it.
    setManualOpen(true);
  }, []);

  const upsertMutation = trpc.places.upsertPlace.useMutation();

  /**
   * In-flight latch for {@link handleSave}.
   *
   * `upsertMutation.isPending` is NOT sufficient: it only flips once the
   * `await forwardGeocode(...)` round-trip below has resolved, so between the
   * first click and Geoapify answering, BOTH the action-bar CTA and the inline
   * "Save changes" button are still enabled (`placeSaving` isn't published
   * either, so the dock's loading suppression doesn't apply). A second press in
   * that window ran a second geocode AND a second `upsertPlace` — with a fresh
   * `clientKey` each time, so idempotency deduped neither: one duplicate
   * audit-log entry plus a wasted third-party call per double-press.
   *
   * A ref (not state) because the guard must be visible to the very next event
   * in the same tick, before React re-renders.
   */
  const saveInFlightRef = useRef(false);

  /**
   * The PLACE half of the page's one Save — the body `edit/page.tsx` ran
   * inside its latch, moved verbatim. The latch itself now lives in
   * {@link handleSave}, which runs this AND the page forms under it.
   */
  const commitPlace = useCallback(
    async (countryForSave: string) => {
      if (!place) return;

      // Determine owner from access
      const owner:
        | { kind: "org"; orgId: string }
        | { kind: "human"; humanId: string } =
        place.access.orgIds.length > 0
          ? { kind: "org", orgId: place.access.orgIds[0]! }
          : { kind: "human", humanId: place.access.humanIds[0]! };

      // Same shape as before the autocomplete landed — `addressHash` in the
      // adapter is `formatted.toLowerCase()`, so changing which parts go in (or
      // their order) would invalidate every existing place's hash on next save
      // and trigger a pointless tax-rate + timezone re-lookup for all of them.
      const rebuiltAddress = [
        addressLine1,
        city,
        region,
        postalCode,
        countryForSave,
      ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(", ");

      /**
       * Keep the STORED `formatted` string when nothing address-shaped changed.
       *
       * `Place.address` is a legacy free-text column that predates the structured
       * ones, and plenty of rows carry detail the structured columns never got:
       * seeded Paramount is `address: "713 Congress Ave"` with `addrLine1: null`.
       * Rebuilding `formatted` from the parts on EVERY save silently rewrote that
       * to "Austin, TX, 78701, US" — the street simply gone — the first time an
       * organiser edited an unrelated field. It also churns `addressHash`, which
       * re-fires the tax-rate and timezone lookups for nothing.
       */
      const formattedAddress =
        !isAddressDirty && place.formattedAddress?.trim()
          ? place.formattedAddress.trim()
          : rebuiltAddress;

      // ── Address verification via forward geocode ─────────────────────────
      // Still here, but now only for HAND-TYPED addresses. When the user
      // picked a suggestion we already hold Geoapify's own coordinates for
      // that exact address (FR-017), so re-geocoding would spend a credit to
      // be told what we know — and could even come back with a WORSE match
      // than the building the user chose. `coordsFromSelection` is cleared by
      // any manual field edit, so a "pick then tweak the unit number" flow
      // correctly falls back into this branch.
      let geoLat: number | undefined;
      let geoLng: number | undefined;

      if (isAddressDirty && !coordsFromSelection) {
        // The REBUILT string, never the preserved legacy one — this branch only
        // runs when the address changed, so the stored value is stale by
        // definition.
        const addressQuery = rebuiltAddress;

        if (addressQuery.replace(/,\s*/g, "").trim().length > 0) {
          try {
            const results = await forwardGeocode(addressQuery);
            if (results.length === 0) {
              toast.warning({
                id: "place-address-unverified",
                title: t("admin.placeEditAddressUnverifiedTitle") as string,
                message: t("admin.placeEditAddressUnverifiedMessage") as string,
              });
              // Save proceeds. The existing coordinates are RETAINED rather
              // than nulled — which is what the warning copy already promises
              // ("Coordinates won't be updated") and what stops an unrelated
              // typo fix from erasing a venue's map pin.
            } else {
              geoLat = results[0]!.lat;
              geoLng = results[0]!.lng;
            }
          } catch {
            // Geocoding failure is non-blocking — save without coordinates.
            toast.warning({
              id: "place-geocode-failed",
              title: t("admin.placeEditGeocodeFailed") as string,
              message: t("admin.placeEditGeocodeFailedMessage") as string,
            });
          }
        }
      }

      // Freshly geocoded coordinates win; otherwise carry whatever we already
      // hold (the selection's, or the row's). Sending nothing is what nulls
      // them out in the adapter — see the `lat`/`lng` state doc above.
      const saveLat = geoLat ?? lat ?? undefined;
      const saveLng = geoLng ?? lng ?? undefined;

      try {
        await upsertMutation.mutateAsync({
          placeId,
          name: name.trim() || "New Place",
          address: {
            formatted: formattedAddress,
            // NO "TBD" SENTINEL. `line1` is optional in `addressSchema` now
            // (upsert-place.ts), because a place genuinely may not have a
            // street address. The sentinel that used to sit here persisted the
            // literal string "TBD" into `Place.addrLine1`, which then rendered
            // on the public venue page and fed `formatted`/`addressHash`.
            line1: addressLine1.trim() || undefined,
            line2: addressLine2.trim() || undefined,
            city: city.trim() || undefined,
            region: region.trim() || undefined,
            postalCode: postalCode.trim() || undefined,
            countryCode: countryForSave,
            ...(saveLat !== undefined && saveLng !== undefined
              ? { lat: saveLat, lng: saveLng }
              : {}),
          },
          capacity: capacity ? parseInt(capacity, 10) : undefined,
          phone: phone.trim() || null,
          website: website.trim() || null,
          // ADDRESS PRIVACY — always sent, never conditionally. On this field
          // OMITTED means "preserve" and an explicit `null` radius means
          // "fully hidden", so sending it only when dirty would make the two
          // indistinguishable at the call site. Sending it every time makes
          // the save idempotent instead.
          ...privacyInput,
          owner,
          clientKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20),
        });
        toast.success({
          id: "place-saved",
          title: t("admin.placeEditSaved") as string,
          message: t("admin.placeEditSavedMessage") as string,
        });
        // AWAITED, and inside the latch. `isDirty` compares the form to the
        // QUERY data, so it stays true from the moment `mutateAsync` resolves
        // until the refetched place lands and the seeding effect overwrites
        // the form. `upsertMutation.isPending` is already false by then, so
        // releasing the latch here would re-open the exact double-fire window
        // one step later: both Save controls armed, a second click, a second
        // `upsertPlace` with a fresh clientKey that idempotency cannot dedupe.
        //
        // It is also the one refetch the seeding effect must accept even over a
        // "dirty" form — see NEVER RESEED OVER A DRAFT above.
        reseedAfterSaveRef.current = true;
        await utils.places.getPlaceForEdit.invalidate({ placeId });
        void utils.places.listHumanPlaces.invalidate();
        // A new address moves the pin Getting there measures from (FR-014):
        // refresh the editor's pin and its "more than 3 km" flags.
        if (arrivalAreasEnabled) {
          void utils.arrivalAreas.listForEditor.invalidate({ placeId });
        }
      } catch (err) {
        toast.danger({
          id: "place-save-failed",
          title: t("admin.placeEditSaveFailed") as string,
          // `t` is load-bearing: without it the dictionary inside
          // `formatErrorMessage` renders a coded refusal as "Something went
          // wrong."
          message: formatErrorMessage(err, t),
        });
      }
    },
    [
      place,
      placeId,
      name,
      addressLine1,
      addressLine2,
      city,
      region,
      postalCode,
      capacity,
      phone,
      website,
      lat,
      lng,
      privacyInput,
      isAddressDirty,
      coordsFromSelection,
      upsertMutation,
      toast,
      t,
      utils,
      arrivalAreasEnabled,
    ],
  );

  const handleSave = useCallback(async () => {
    if (!place) return;
    if (saveInFlightRef.current) return;

    // ── ONE Save for the whole page ────────────────────────────────────────
    // A Public page form that is failing its own validation (a slug already
    // taken) blocks the WHOLE press rather than letting the rest land around
    // it: "Nothing was saved" is a sentence an owner can act on. Checked
    // before the latch, like every other refusal below.
    if (pageSettingsSave.isBlocked) {
      toast.danger({
        id: "place-settings-blocked",
        title: t("admin.placeSettingsBlockedSaveTitle") as string,
        message: t("admin.placeSettingsBlockedSaveMessage") as string,
      });
      return;
    }
    const savePlace = isDirty;
    const savePage = pageSettingsSave.isDirty;
    if (!savePlace && !savePage) return;

    // Blocked BEFORE the latch is taken: a rejected save never started, so it
    // must not leave the latch armed.
    const trimmedCountry = countryCode.trim().toUpperCase();
    if (savePlace && trimmedCountry.length === 1) {
      setCountryError(true);
      toast.danger({
        id: "place-country-invalid",
        title: t("admin.placeEditCountryCodeInvalidTitle") as string,
        message: t("admin.placeEditCountryCodeInvalidMessage") as string,
      });
      return;
    }
    setCountryError(false);
    const countryForSave = trimmedCountry || "US";

    saveInFlightRef.current = true;
    try {
      // The place first, then the page forms — the order `page-settings-save`
      // was widened for (its `save` may return a promise). Settled, not
      // fail-fast: a failed place save still lets the page forms commit, and
      // each side reports its own outcome in its own toast.
      if (savePlace) await commitPlace(countryForSave);
      if (savePage) await pageSettingsSave.saveAll();
    } finally {
      saveInFlightRef.current = false;
    }
  }, [place, pageSettingsSave, isDirty, countryCode, toast, t, commitPlace]);

  const backToPlaces = useCallback(
    () => router.push(`/admin/${slug}/places`),
    [router, slug],
  );

  /**
   * Deep links (`/verify` redirects to `#verification`). The sections do not
   * exist until the place loads — the spinner renders first — so the
   * browser's own hash jump has nothing to land on. Once, when they appear.
   */
  const hashHandledRef = useRef(false);
  useEffect(() => {
    if (!place || hashHandledRef.current) return;
    hashHandledRef.current = true;
    // Compared RAW, never decoded: the section ids are plain ASCII, and
    // `decodeURIComponent` throws a URIError on a hand-typed `#%` — inside an
    // effect that would take the whole page down to the error boundary.
    const id = window.location.hash.slice(1);
    if (!id || !(Object.values(SECTION_IDS) as string[]).includes(id)) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [place]);

  const anyDirty = isDirty || pageSettingsSave.isDirty;
  const saving = upsertMutation.isPending || pageSettingsSave.isPending;

  // ── Loading state ──────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        gap="$3"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.placeEditLoading"))}
        </Text>
      </YStack>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────
  // The [placeId] layout gates on `getPlaceTitle`, which admits ANY member of
  // an owning org; this read sits at `canManagePlace` (OWNER/ADMIN/EDITOR), so
  // a SCANNER/VIEWER/FINANCE reaches this route and is refused HERE, exactly
  // as they were on `/edit` and `/verify`. Same card, same copy.
  if (error || !place) {
    const isForbidden = error?.data?.code === "FORBIDDEN";
    const isNotFound = error?.data?.code === "NOT_FOUND" || (!error && !place);

    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        gap="$4"
        maxWidth={480}
        marginHorizontal="auto"
      >
        <YStack
          width={64}
          height={64}
          borderRadius={0}
          backgroundColor={isForbidden ? "$dangerMuted" : "$warningMuted"}
          justifyContent="center"
          alignItems="center"
        >
          {isForbidden ? (
            <AlertTriangle size={28} color={theme.danger?.val} />
          ) : (
            <MapPin size={28} color={theme.warning?.val} />
          )}
        </YStack>

        <YStack gap="$2" alignItems="center">
          <Text variant="h3" textAlign="center">
            {isForbidden
              ? String(t("admin.placeEditAccessDenied"))
              : isNotFound
                ? String(t("admin.placeEditNotFound"))
                : String(t("admin.placeEditGenericError"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center">
            {isForbidden
              ? String(t("admin.placeEditAccessDeniedDescription"))
              : isNotFound
                ? String(t("admin.placeEditNotFoundDescription"))
                : // FORBIDDEN never reaches this arm, which is the point:
                  // `fail()` sets `message` to the CODE, so printing it for a
                  // refusal showed the literal string "NOT_RESOURCE_OWNER".
                  (error?.message ??
                  String(t("admin.placeEditGenericErrorDescription")))}
          </Text>
        </YStack>

        <Button variant="secondary" size="$3" onPress={backToPlaces}>
          <ArrowLeft size={16} />
          {String(t("admin.placeEditBackToPlaces"))}
        </Button>
      </YStack>
    );
  }

  /**
   * The page's ONE Save, rendered in two places — the header (two-column
   * widths) and the pinned bar (one column) — of which CSS displays exactly
   * one (`.th-place-settings-header-save` / `-savebar`). `display: none`
   * also drops the hidden one from the accessibility tree, so the page never
   * exposes two "Save changes" buttons at once. It is the viewport's one
   * PRIMARY; Verification's submit is deliberately secondary.
   */
  const renderSave = (testId: string, fullWidth: boolean): ReactNode => (
    <Button
      variant="primary"
      size="$3"
      data-testid={testId}
      // The approved board fills Save with STRUCTURE ink, not accent: on a
      // page this long the accent budget (DS v2 §4, ≤5%) is better spent on
      // the index's current-section rule. Every key the primary variant sets
      // is overridden in all three states — a partial hoverStyle prop MERGES
      // with the variant's rather than replacing it. Stub: #FDFAF3 on
      // #211C16 at rest, on #000 hover/press.
      backgroundColor="$structure"
      borderColor="$structure"
      color="$onStructure"
      // `color` is typed out of the frame's state styles, but the variant
      // ladder sets it there (button-variants.ts) and the label inherits it;
      // leaving it out would keep primary's `$onBrandSecondary` on hover,
      // which is ink on Ember. Cast, not dropped.
      hoverStyle={
        {
          backgroundColor: "$structurePress",
          borderColor: "$structurePress",
          color: "$onStructure",
        } as never
      }
      pressStyle={
        {
          backgroundColor: "$structurePress",
          borderColor: "$structurePress",
          color: "$onStructure",
        } as never
      }
      onPress={() => void handleSave()}
      disabled={saving || !anyDirty}
      {...(fullWidth ? { width: "100%" } : {})}
    >
      <Save size={16} />
      {saving
        ? String(t("admin.placeEditSaving"))
        : String(t("admin.placeEditSaveChanges"))}
    </Button>
  );

  const indexItems = [
    { targetId: SECTION_IDS.identity, label: t("admin.placeEditSectionIdentity") },
    { targetId: SECTION_IDS.location, label: t("admin.placeEditSectionLocation") },
    ...(arrivalAreasEnabled
      ? [{ targetId: SECTION_IDS.gettingThere, label: t("arrivalAreasEditor.heading") }]
      : []),
    {
      targetId: SECTION_IDS.verification,
      label: t("admin.placeSettingsSectionVerification"),
    },
    {
      targetId: SECTION_IDS.publicPage,
      label: t("admin.placeSettingsSectionPublicPage"),
    },
    {
      targetId: SECTION_IDS.reviews,
      label: t("admin.placeSettingsSectionReviews"),
    },
    {
      targetId: SECTION_IDS.ownership,
      label: t("admin.placeSettingsSectionOwnership"),
    },
  ].map((item) => ({ ...item, label: String(item.label) }));

  // Fails CLOSED: only a direct human owner or an org OWNER/ADMIN may flip
  // the place switches, and a payload that did not carry the flag leaves them
  // locked rather than live.
  const canManageSwitches = place.viewerCanManageSwitches ?? false;

  return (
    // The container-query PARENT. `container-type: inline-size` lives on
    // `.th-place-settings` and everything that queries it is a CHILD — an
    // element cannot match a container query it establishes itself, and that
    // failure is silent (permanently one column). A plain <div>: this node's
    // whole job is to carry the class.
    <div className="th-place-settings">
      <YStack gap="$4" width="100%">
        {/* ── Header: title + Save, then the status strip ─────────────── */}
        <YStack
          gap="$3"
          paddingBottom="$4"
          borderBottomWidth={2}
          borderBottomColor="$borderColor"
        >
          {/* `flexShrink`/`minWidth` are load-bearing, not decoration: RNW
              gives flex items `flexShrink: 0`, so without them the title
              keeps its max-content width and a 320px document overflows. */}
          <XStack
            justifyContent="space-between"
            alignItems="flex-end"
            gap="$3"
            flexWrap="wrap"
          >
            <Text
              variant="h2"
              flexShrink={1}
              minWidth={0}
              style={{
                textTransform: "uppercase",
                letterSpacing: -1,
                fontWeight: 900,
              }}
            >
              {String(t("admin.placeSettingsHeading"))}
            </Text>
            <div className="th-place-settings-header-save">
              {renderSave("place-settings-save", false)}
            </div>
          </XStack>
          <SettingsStatusChips
            verificationStatus={place.verificationStatus}
            listedInDirectory={place.listedInDirectory}
            pageVisibility={pageVisibility}
            attendeeReviewsPublic={place.attendeeReviewsPublic ?? false}
          />
        </YStack>

        {/* DS v2 §5: a multi-column page region is an explicit grid that
            collapses by RE-DECLARING grid-template-columns — never by hiding
            content. Below the threshold the index becomes a chip row. */}
        <div className="th-place-settings-cols">
          <SettingsSectionIndex
            items={indexItems}
            label={String(t("admin.placeSettingsSectionIndexLabel"))}
            kicker={String(t("admin.placeSettingsIndexKicker"))}
          />

          <YStack gap="$4" minWidth={0}>
            {/* ── 1. Identity (name + capacity & contact) ────────────── */}
            <IdentitySection
              name={name}
              onNameChange={setName}
              capacity={capacity}
              onCapacityChange={setCapacity}
              phone={phone}
              onPhoneChange={setPhone}
              website={website}
              onWebsiteChange={setWebsite}
              headingId={SECTION_IDS.identity}
              anchor
            />

            {/* ── 2. Location + address privacy (FR-016/FR-017) ─────────
                Every value below is THIS page's state. In particular the
                `lat`/`lng` pair is form state precisely so a save can never
                omit it (the adapter writes `lat: input.geo?.lat ?? null` on
                UPDATE), and `isAddressDirty` is what decides both the
                save-time geocode and the `formattedAddress` preservation. The
                section renders them; it does not own them. */}
            <LocationSection
              addressLine1={addressLine1}
              addressLine2={addressLine2}
              city={city}
              region={region}
              postalCode={postalCode}
              countryCode={countryCode}
              onAddressLine1Change={editAddressField(setAddressLine1)}
              onAddressLine2Change={editAddressField(setAddressLine2)}
              onCityChange={editAddressField(setCity)}
              onRegionChange={editAddressField(setRegion)}
              onPostalCodeChange={editAddressField(setPostalCode)}
              onCountryCodeChange={(value) => {
                setCountryError(false);
                editAddressField(setCountryCode)(value);
              }}
              manualOpen={manualOpen}
              onToggleManualFields={() => setManualOpen((open) => !open)}
              onRequestManualEntry={() => setManualOpen(true)}
              onAddressSelect={handleAddressSelect}
              countryError={countryError}
              lat={lat}
              lng={lng}
              coordsFromSelection={coordsFromSelection}
              isAddressDirty={isAddressDirty}
              privacy={privacy}
              onPrivacyChange={setPrivacy}
              privacyDisabled={upsertMutation.isPending}
              locationHeadingId={SECTION_IDS.location}
              anchor
            />

            {/* ── 2b. Getting there (arrival-areas FR-016) ────────────────
                Parking, drop-off and load-in areas, drawn around the pin the
                editor's own list carries (the SAVED one core measures from:
                an unsaved address edit does not move the map). Each area
                saves on its own; the page Save does not send them. */}
            {arrivalAreasEnabled ? (
              <PlaceEditSection
                title={String(t("arrivalAreasEditor.heading"))}
                headingId={SECTION_IDS.gettingThere}
                anchor
              >
                <ArrivalAreasEditor parent={{ placeId }} formHeadingLevel={4} />
              </PlaceEditSection>
            ) : null}

            {/* ── 3. Verification — the FULL workflow, inline ───────────
                Queue position, reviewer notes, withdraw and the document
                upload all render here now; this is no longer a summary
                pointing at a second route. Its submit is its own and stays
                out of the page Save: `formState` is the live form and
                `isDirty` makes it refuse (and say "save first") until the
                owner has saved, because verification judges what is SAVED. */}
            <PlaceEditSection
              title={String(t("admin.placeSettingsSectionVerification"))}
              headingId={SECTION_IDS.verification}
              anchor
            >
              <VerificationSection
                place={{
                  placeId: place.placeId ?? placeId,
                  name: place.name,
                  addressLine1: place.addressLine1,
                  city: place.city,
                  countryCode: place.countryCode,
                  verificationStatus: place.verificationStatus,
                  access: place.access,
                }}
                formState={{ name, addressLine1, city, countryCode }}
                isDirty={isDirty}
                placeId={placeId}
                embedded
              />
              {/* The board's one-line answer to "why doesn't Save send this?" */}
              <Text
                variant="caption"
                tone="muted"
                borderTopWidth={1}
                borderTopColor="$borderColorSoft"
                paddingTop="$3"
                data-testid="place-settings-verification-own-submit"
              >
                {String(t("admin.placeSettingsVerificationOwnSubmit"))}
              </Text>
            </PlaceEditSection>

            {/* ── 4. Public page (slug, bio, images, visibility, theme) ─── */}
            <PublicPageSection
              placeId={placeId}
              slug={slug}
              verificationStatus={place.verificationStatus}
              headingId={SECTION_IDS.publicPage}
            />

            {/* ── 5. Reviews & feedback ──────────────────────────────────
                Moved out of page settings: publishing ratings is a venue
                policy, not page content. The performer-review switch
                (CommunityReviewsToggle) mounts here via ReviewsSection. */}
            <PlaceEditSection
              title={String(t("admin.placeSettingsSectionReviews"))}
              headingId={SECTION_IDS.reviews}
              anchor
            >
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.placeSettingsReviewsIntro"))}
              </Text>
              <ReviewsSection
                placeId={placeId}
                attendeeReviewsPublic={place.attendeeReviewsPublic ?? false}
                communityReviewsEnabled={place.communityReviewsEnabled ?? false}
                canManage={canManageSwitches}
                embedded
              />
            </PlaceEditSection>

            {/* ── 6. Ownership & status (read-only) ─────────────────────
                No `as` casts on `status`: the section's union is written to
                match getPlaceForEditOutputSchema's enum exactly, so a drift
                on either side is a COMPILE error here. */}
            <PlaceEditSection
              title={String(t("admin.placeSettingsSectionOwnership"))}
              headingId={SECTION_IDS.ownership}
              anchor
            >
              <OwnershipStatusSection
                placeId={placeId}
                owners={place.owners}
                status={place.status}
                listedInDirectory={place.listedInDirectory}
                regionHeadingTag="h4"
                embedded
              />
            </PlaceEditSection>
          </YStack>
        </div>

        {/* Pinned save bar — one-column widths only (CSS). Sticky, not
            fixed: it rides the bottom of the viewport while the settings are
            on screen, above the shell's bottom nav bar. */}
        <div className="th-place-settings-savebar">
          {renderSave("place-settings-save-bar", true)}
        </div>
      </YStack>
    </div>
  );
}
