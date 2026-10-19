# Design System v3 — Component Backlog

Source: `~/Downloads/Ithas Fire Design System/components/**/*.prompt.md` (137 specs, plain React + global CSS — a specification to port into `@th/ui`, never code to install). Scope decided 2026-08-26: port primitives + gap components into `@th/ui`; existing pages adopt them opportunistically; no template-driven page rewrites.

## Summary

| Status | Count |
| --- | --- |
| exists | 41 |
| partial | 16 |
| missing | 80 |
| **Total** | **137** |

`Combobox` and `Drawer` are marked **exists** here against an earlier "known missing" assumption — `AutocompleteField.tsx` and `SlidePanel.tsx` cover them; verify against the gap notes below before trusting the earlier list over this one.

### Ranked port order (missing list)

Ranked by evidence of existing demand — a grep count of app-local one-offs or duplicate implementations already carrying the load `@th/ui` should carry. Everything past #9 is `unestimated`: no consumer-count sweep was run for the remaining ~70 missing components (that would be another 70 greps; flagged rather than guessed).

1. **BulkBar** — `apps/web/src/components/AdminTableParts.tsx` exports its own `BulkActionBar`, used in 7 files; the parent file is imported by 34 files `[VERIFIED: rg -l "BulkActionBar" / rg -l "from '.*AdminTableParts'"]`. Porting retires a shadow implementation, not just fills a gap.
2. **StatusPill** — three independent app-local copies found (`TicketPackStatusPill.tsx`, `PackStatusPill.tsx`, `OccurrenceStatusPill.tsx`) `[VERIFIED: find -iname]`. Duplication this direct is the clearest signal in the backlog.
3. **CommandPalette** — `apps/web/src/components/search/SpotlightSearch.tsx` is already a full ⌘K overlay (admin + consumer search, keyboard nav, grouped results) `[VERIFIED: read file]`. The spec exists in the app; it just isn't in `@th/ui`.
4. **CheckoutTimer** — the hold countdown is already built ad hoc in `CheckoutInfoBar.tsx` / `useCheckoutState.ts` (`holdExpiresAt`) `[VERIFIED: grep]`. Money-critical, high-traffic surface.
5. **PromoCode** — two independent app-local copies (`PromoCodeInput.tsx` in checkout, `EmbedPromoCodeInput.tsx` in the embed widget) `[VERIFIED: find]`.
6. **Pagination** — app-local in `AdminTableParts.tsx`, same 34-file consumer base as BulkBar `[VERIFIED]`.
7. **EmptyState** — app-local in `apps/web/src/app/platform/featured/_components/styled.tsx` plus `AdminTableParts.tsx`'s `NoResults` / `SkeletonEmptyState` `[VERIFIED: find + grep]` — at least three non-shared variants.
8. **TableToolbar** — `AdminTableParts.tsx` already carries the pieces (`ActionBar`, `SearchBar`, `FilterChips`, `FilterRow`) unconsolidated `[VERIFIED: grep exports]`.
9. **OrderStatus** — one app-local copy, `OrderStatusBadge.tsx` in admin orders `[VERIFIED: find]`.
10. ConfirmDialog, ImageLightbox, viz family (BarChart/ChartFrame/CheckInGauge/LineChart — one consumer found, `FeeProjectionChart.tsx`), and the remaining ~68 missing components — `unestimated`.

## actions/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| Button | exists | `components/forms/Button.tsx` | `[VERIFIED]` |
| ButtonGroup | missing | — | no seam-collapsing wrapper `[VERIFIED: rg found nothing]` |
| Chip | exists | `components/display/Chip.tsx` | `[VERIFIED]` |
| IconButton | partial | `components/forms/Button.tsx` | icon-only is a mode of `Button` (square sizing + dev-only missing-aria-label warning), not a separate component `[VERIFIED: grep in Button.tsx]` |
| MenuButton | missing | — | closest neighbor is `navigation/NavbarMenuButton.tsx`, a narrow nav-hamburger trigger, not a generic peer-action menu `[VERIFIED: find]` |
| SplitButton | missing | — | `[VERIFIED: find]` |
| TextLink | missing | — | app-local only, `apps/web/src/components/layout/PagePrimitives/buttons.tsx` `[VERIFIED: rg]` |
| ToggleGroup | exists | `components/display/SegmentedControl.tsx` | `[REASONED: name + purpose match]` |

## commerce/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| CheckoutTimer | missing | — | app-local countdown in `apps/web/.../checkout/[...slug]/_components/CheckoutInfoBar.tsx` + `useCheckoutState.ts` (`holdExpiresAt`) `[VERIFIED: grep]` |
| FeeDisclosure | missing | — | `[VERIFIED: find]` |
| OrderStatus | missing | — | app-local `apps/web/.../admin/[slug]/orders/_components/OrderStatusBadge.tsx` `[VERIFIED: find]` |
| OrderSummary | partial | `components/events/CheckoutPanel.tsx` | generic itemized-total card exists (flagged `// @ts-nocheck`); apps/web also carries its own separate page-local `OrderSummary.tsx` in checkout — two unconsolidated implementations `[VERIFIED: read both files]` |
| PaymentMethodDisplay | missing | — | `PaymentMethodChips.tsx` exists but is scoped to place-review, not orders/payouts `[VERIFIED: find]` |
| PayoutRow | missing | — | `[VERIFIED: find]` |
| PromoCode | missing | — | two app-local copies: `PromoCodeInput.tsx` (checkout), `EmbedPromoCodeInput.tsx` (embed) `[VERIFIED: find]` |
| TierRow | missing | — | `[VERIFIED: find; CheckoutPanel has no tier-selection UI]` |
| TierSelector | missing | — | `[VERIFIED: find]` |
| TrustStrip | missing | — | `[VERIFIED: find]` |

## data/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| Avatar | exists | `components/display/Avatar.tsx` | `[VERIFIED]` |
| Badge | exists | `components/feedback/Badge.tsx` | `[VERIFIED]` |
| BulkBar | missing | — | app-local `BulkActionBar` in `apps/web/src/components/AdminTableParts.tsx`, 7 consumers `[VERIFIED: rg]` |
| CopyField | missing | — | `[VERIFIED: find]` |
| DataTable | exists | `components/data/DataTable.tsx` (+ `DataTableCardList.tsx` for the mobile card strategy) | `[VERIFIED]` |
| DateBlock | exists | `components/events/DateBlock.tsx` | `[VERIFIED]` |
| DateTime | exists | `components/data/DateTime.tsx` | `[VERIFIED]` |
| DescriptionList | missing | — | `[VERIFIED: find]` |
| Kbd | missing | — | `[VERIFIED: find]` |
| ListRow | missing | — | `navigation/ListItem.tsx` is the nearest neighbor but is nav-scoped, not the lead/title-meta/trailing hairline row the spec describes `[REASONED]` |
| MetaList | exists | `components/events/MetaList.tsx` | `[VERIFIED]` |
| Money | exists | `components/data/Money.tsx` | `[VERIFIED]` |
| PriceBlock | exists | `components/events/PriceBlock.tsx` | `[VERIFIED]` |
| StatCard | missing | — | `[VERIFIED: find]` |
| StatusPill | missing | — | three app-local copies: `TicketPackStatusPill.tsx`, `PackStatusPill.tsx`, `OccurrenceStatusPill.tsx` `[VERIFIED: find]` |
| TableToolbar | missing | — | pieces exist unconsolidated in `AdminTableParts.tsx` (`ActionBar`, `SearchBar`, `FilterChips`, `FilterRow`) `[VERIFIED: grep exports]` |
| Tag | missing | — | `[VERIFIED: find]` |
| Timeline | missing | — | `apps/web/.../platform/audit-log/_components/AuditLogMobileCard.tsx` / `AuditLogDetail.tsx` are a loosely related app-local history view, not a shared primitive `[VERIFIED: find]` |

## events/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| EventCard | exists | `components/event-grid/EventCard.tsx` (barrel-aliased `EventGridCard`) | a legacy `events/EventCard.tsx` occupies the bare name in the barrel; the card every event surface actually renders is the aliased one `[VERIFIED: read `components/index.ts` comment]` |
| EventGrid | exists | `components/event-grid/EventGrid.tsx` | `[VERIFIED]` |
| EventHero | missing | — | `[VERIFIED: find]` |
| EventLineupRow | exists | `components/events/LineupRow.tsx` | `[REASONED: name + purpose match]` |
| EventMetaBlock | partial | `components/events/MetaList.tsx` | covers the when/where pair, not the full hairline-divided facts strip the spec describes `[REASONED]` |
| EventStub | missing | — | `event-list/EventListCard.tsx` is the nearest neighbor (medium-density list card); torn-date-column shape unconfirmed `[REASONED]` |
| OrganizerBlock | missing | — | `[VERIFIED: find]` |
| ScheduleList | missing | — | `[VERIFIED: find]` |
| VenueBlock | missing | — | `[VERIFIED: find]`; `RateVenueBlock.tsx` is an unrelated rating widget |

## feedback/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| Banner | exists | `components/feedback/Banner.tsx` | `[VERIFIED]` |
| ClaimedBar | exists | `components/events/ClaimedBar.tsx` | `[VERIFIED]` |
| EmptyState | missing | — | app-local in `apps/web/.../platform/featured/_components/styled.tsx` plus `AdminTableParts.tsx`'s `NoResults`/`SkeletonEmptyState` `[VERIFIED: find + grep]` |
| InlineAlert | exists | `components/feedback/Alert.tsx` | `[REASONED: purpose match — "a message bound to the thing it's about"]` |
| OfflineIndicator | missing | — | app-local `apps/scanner/src/ui/network-banner.tsx`, backed by `apps/scanner/src/features/network/use-network-state.ts` `[VERIFIED: find + grep]` |
| ProgressBar | exists | `components/feedback/ProgressBar.tsx` | `[VERIFIED]` |
| Skeleton | missing | — | only content-specific skeletons exist (`EventCardSkeleton.tsx`, `EventGridSkeleton.tsx`); no generic placeholder primitive; `AdminTableParts.tsx` has its own `SkeletonEmptyState` `[VERIFIED: find]` |
| Spinner | exists | `components/feedback/Spinner.tsx` | `[VERIFIED]` |
| Toast | partial | `components/notifications/Toast.tsx` + `SonnerBridge.tsx` | function-based API (`notifyWeb`/`dismissWeb`/`promiseWeb`) rather than a `<Toast>` component; `Toast.tsx` only exports `ToastViewport` `[VERIFIED: grep exports]` |
| Toaster | exists | `components/notifications/Toast.tsx` (`ToastViewport`) / `SonnerBridge.tsx` (`SonnerViewport`) | `[VERIFIED]` |

## forms/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| AddressFields | missing | — | `[VERIFIED: find]` |
| Checkbox | exists | `components/forms/Checkbox.tsx` | `[VERIFIED]` |
| CheckboxGroup | partial | `components/forms/MultiChipGroup.tsx` | multi-select exists but as chips, not checkboxes under a shared fieldset legend `[VERIFIED: read file header]` |
| Combobox | exists | `components/forms/AutocompleteField.tsx` | generic typed filterable single-select — corrects the "known missing" assumption; `UnifiedSearchAutocomplete.tsx`, `PlacesAutocompleteField`, `LocationAutocompleteField` are specialized instances built adjacent to it `[VERIFIED: read interface]` |
| DateField | exists | `components/DatePicker.tsx` (top-level, 544 lines) | **footgun**: `components/forms/DatePicker.tsx` is a 15-line stub that returns `null` ("previous file contents were corrupted/duplicated" per its own comment) — same name, wrong file, silently renders nothing `[VERIFIED: read both files]` |
| DateRangeField | exists | `components/forms/DateRangePicker.tsx` | `[VERIFIED]` |
| Field | partial | `components/forms/FieldLabel.tsx` | owns label/hint/error/optional exactly as spec'd, but nothing wraps label + control + hint + error into one `Field`; apps/web has its own app-local `Field` in `_form-bits.tsx` `[VERIFIED: read + grep]` |
| FieldSet | missing | — | `[VERIFIED: find]` |
| FileUpload | missing | — | `UploadModeToggle.tsx` is only a file/URL mode segmented toggle, not a dropzone/uploader `[VERIFIED: read file]` |
| FormRow | missing | — | `AdminTableParts.tsx`'s `FilterRow` is an admin-specific analog, not a generic row layout `[VERIFIED: grep exports]` |
| ImageUpload | missing | — | `[VERIFIED: find]` |
| Input | exists | `components/forms/TextInput.tsx` | `[VERIFIED]` |
| MoneyInput | exists | `components/forms/AmountInput.tsx` | `[VERIFIED]` |
| PhoneInput | exists | `components/forms/PhoneNumberInput.tsx` | `[VERIFIED]` |
| QuantityStepper | exists | `components/forms/QuantityStepper.tsx` | `[VERIFIED]` |
| Radio | exists | `components/forms/Radio.tsx` | `[VERIFIED]` |
| RadioGroup | exists | `components/forms/Radio.tsx` (`RadioGroupField`) | wraps Tamagui's own `RadioGroup` `[VERIFIED]` |
| SaveIndicator | missing | — | `[VERIFIED: find]` |
| SearchInput | missing | — | only purpose-built autocompletes exist (`EventSearchAutocomplete.tsx`, `UnifiedSearchAutocomplete.tsx`); no plain `SearchInput` for table toolbars `[VERIFIED: find + read]` |
| Select | exists | `components/forms/StyledSelect.tsx` | `[VERIFIED]` |
| Slider | partial | `components/forms/RangeSlider.tsx` | dual-thumb only; no single-value variant `[VERIFIED: read file]` |
| Switch | exists | `components/forms/Switch.tsx` (+ `.native.tsx`) | `[VERIFIED]` |
| Textarea | partial | `components/forms/CharCountTextarea.tsx` | bakes in a mandatory character-count footer; no plain Textarea without the counter `[VERIFIED: read file]` |
| TimeField | missing | — | no dedicated clock-time picker; `DateTime.tsx` only displays, doesn't input `[VERIFIED: find]` |
| ValidationSummary | missing | — | `components/feedback/FormErrorBanner.tsx` is the closest neighbor (single message + retry/dismiss), not a submit-time list of field errors `[VERIFIED: read file]` |

## layout/

All ten primitives came back with zero named exports anywhere in `packages/ui/src` `[VERIFIED: rg -l "export (const|function|type|class) <Name>\b" packages/ui/src — 0 hits for every name in this family]`. The app builds layout directly on raw Tamagui primitives (`YStack`/`XStack`/`View` with inline props) rather than named wrapper components, except the two noted below.

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| AspectBox | missing | — | |
| Bleed | missing | — | |
| Container | missing | — | app-local, page-scoped `Container` styled-components exist in at least two `_components` folders (`platform/featured`, `admin/.../events/new`) `[VERIFIED: rg]` |
| Divider | partial | `components/display/Separator.tsx` | `[REASONED: name match]` |
| Grid | missing | — | |
| Page | missing | — | |
| Panel | partial | `components/display/Card.tsx` (`CardSurface`) | `[VERIFIED: read file — styled(TamaguiCard)]`, full "2px ink border, zero radius" recipe fidelity unconfirmed |
| Row | missing | — | |
| ScrollArea | missing | — | |
| Stack | missing | — | |
| Sticky | missing | — | |

## marketing/

All eight came back with no shared or app-local match beyond the notes below `[VERIFIED: find across packages/ui/src and apps/web/src]`.

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| CtaBand | missing | — | `BecomeModeratorCta.tsx`, `ClaimVenueCta.tsx` are narrow single-purpose CTAs, not the 7fr/5fr band |
| FaqAccordion | missing | — | `apps/web/.../p/[slug]/_components/blocks/FaqBlock.tsx` is an app-local neighbor on entity pages |
| Marquee | missing | — | three app-local one-offs in `apps/web/src/app/_components/home/`: `MarqueeBand.tsx`, `CityMarquee.tsx`, `EventMarquee.tsx` — consolidation candidates when ported |
| PriceCallout | missing | — | |
| SectionHeader | missing | — | app-local only, `apps/web/.../platform/featured/_components/styled.tsx` |
| StatsBand | missing | — | |
| StepList | missing | — | |
| Testimonial | missing | — | |

## navigation/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| AppShell | partial | `packages/ui/src/ui/shell/NavigationShell.tsx` | separate, unconsolidated app-local `apps/web/src/components/layout/AppShell.tsx` also exists `[VERIFIED: find both]` |
| BackLink | missing | — | `[VERIFIED: find]` |
| Breadcrumbs | missing | — | app-local only, `apps/web/.../help/_components/Breadcrumbs.tsx` `[VERIFIED: find]` |
| ContextStrip | missing | — | `[VERIFIED: find]` |
| EventSwitcher | partial | `components/navigation/WorkspaceSwitcher.tsx` | `[REASONED: name + purpose match — account-scoped/event-scoped switcher]` |
| FooterNav | missing | — | `[VERIFIED: find]` |
| MobileNavSheet | partial | `components/overlay/BottomSheet.tsx` / `shell/components/NavigationDrawer.tsx` | neither confirmed as the specific below-900px public-nav sheet `[REASONED]` |
| Pagination | missing | — | app-local `Pagination` in `AdminTableParts.tsx`, 34-file consumer base `[VERIFIED: grep + rg]` |
| PublicNav | partial | `components/navigation/Navbar.tsx` / `NavbarShell.tsx` | `[REASONED]` |
| SectionTabs | missing | — | app-local analogs `AdminTabBar.tsx`, `EntityPageTabs.tsx` `[VERIFIED: find]` |
| SidebarNav | partial | `packages/ui/src/ui/shell/components/NavigationRail.tsx` | `[REASONED: name + purpose match — "sanctioned exception... admin keeps a sidebar"]` |
| SkipLink | exists | `packages/ui/src/ui/shell/NavigationShell.styles.ts` | `[VERIFIED]` |
| Stepper | exists | `components/navigation/Stepper.tsx` | `[VERIFIED]` |
| TabBar | exists | `components/navigation/NavigationBottomBar.tsx` | `[REASONED: file + purpose match, exact prop coverage unverified]` |
| Tabs | missing | — | generic filtered-view tabs ("All / Checked in / Not arrived"); app-local `EntityPageTabs.tsx` is the closest analog `[VERIFIED: find]` |
| Topbar | exists | `components/navigation/Navbar.tsx` (shell `NavigationTopBar` = `NavigationNavbar`) | `[VERIFIED]` |

## overlays/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| CommandPalette | missing | — | app-local `apps/web/src/components/search/SpotlightSearch.tsx` is already a full ⌘K overlay with keyboard nav `[VERIFIED: read file]` |
| ConfirmDialog | missing | — | app-local `apps/web/src/components/data-table/ConfirmDialog.tsx` `[VERIFIED: find]` |
| Drawer | exists | `components/overlay/SlidePanel.tsx` | docstring: "detail views, creation forms, and inspection panels in admin data-tables... slides in from the right edge" — matches the spec's purpose closely `[VERIFIED: read file]` |
| ImageLightbox | missing | — | app-local `apps/web/src/components/media/ImageLightbox.tsx` `[VERIFIED: find]` |
| Modal | exists | `components/overlay/Modal.tsx` | `[VERIFIED]` |
| Popover | exists | `components/overlay/Popover.tsx` | `[VERIFIED]` |
| Tooltip | exists | `components/feedback/Tooltip.tsx` | `[VERIFIED]` |

## tickets/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| ManualLookup | missing | — | app-local `apps/scanner/src/screens/lookup-screen.tsx` `[VERIFIED: find]` |
| ScanResult | missing | — | app-local `apps/web/.../admin/[slug]/scan/_components/ScanResultState.tsx` — note it lives under the web admin app, not `apps/scanner` `[VERIFIED: find]` |
| ScanShell | missing | — | app-local `apps/scanner/src/scanner-app.tsx` / `apps/scanner/src/ui/app-shell.tsx` `[VERIFIED: find]` |
| Ticket | partial | `components/events/TicketStub.tsx` | single stub component exists; the spec's "one object, three renderings" (screen/email/print) fidelity is unverified |
| TicketQR | missing | — | `apps/scanner/src/lib/qr.ts` is QR generation/decode logic, not a display component with a quiet zone `[VERIFIED: file is a lib, not a component]` |
| TicketWalletCard | missing | — | `[VERIFIED: find]` |
| TransferPanel | missing | — | `[VERIFIED: find]` |

## utility/

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| Icon | exists | `components/utility/Icon.tsx` | `[VERIFIED]` |
| PrintOnly | missing | — | `[VERIFIED: find]` |
| VisuallyHidden | missing | — | `[VERIFIED: find]` |
| Wordmark | missing | — | `[VERIFIED: find]` |

## viz/

Confirmed missing entirely — only the design-token substrate exists (`packages/ui/src/ui/tamagui/tokens/dataviz.ts`), no chart components `[VERIFIED: find across packages/ui/src]`.

| DS component | Status | @th/ui path | Gap / note |
| --- | --- | --- | --- |
| BarChart | missing | — | |
| ChartFrame | missing | — | |
| CheckInGauge | missing | — | |
| LineChart | missing | — | one app-local consumer-shaped one-off exists, `apps/web/.../platform/fees/_components/FeeProjectionChart.tsx` |
