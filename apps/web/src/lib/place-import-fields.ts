/**
 * Shared place import field definitions.
 *
 * Used by both the admin PlacesTable and the platform places page
 * to configure the CsvImportDialog column mapping.
 */

import type { CsvImportFieldDef } from "./csv-import";

export const PLACE_IMPORT_FIELDS: CsvImportFieldDef[] = [
  {
    key: "name",
    label: "Name",
    required: true,
    autoDetect: [
      "name",
      "venue",
      "venue name",
      "place",
      "place name",
      "location",
    ],
  },
  {
    key: "addressFormatted",
    label: "Full Address",
    required: true,
    autoDetect: [
      "address",
      "full address",
      "formatted address",
      "street address",
      "formatted_address",
      "full_address",
    ],
  },
  {
    key: "addressLine1",
    label: "Address Line 1",
    autoDetect: [
      "line1",
      "address_line1",
      "address1",
      "street",
      "address line 1",
      "addrline1",
    ],
  },
  {
    key: "addressLine2",
    label: "Address Line 2",
    autoDetect: [
      "line2",
      "address_line2",
      "address2",
      "suite",
      "unit",
      "address line 2",
      "addrline2",
    ],
  },
  {
    key: "city",
    label: "City",
    autoDetect: ["city", "town", "locality"],
  },
  {
    key: "region",
    label: "State / Region",
    autoDetect: ["state", "region", "province", "state_province"],
  },
  {
    key: "postalCode",
    label: "Postal Code",
    autoDetect: [
      "zip",
      "zip code",
      "postal",
      "postal code",
      "postal_code",
      "zipcode",
      "postcode",
    ],
  },
  {
    key: "countryCode",
    label: "Country Code",
    autoDetect: ["country", "country code", "country_code", "cc"],
    transform: (v) => v.toUpperCase().slice(0, 2),
  },
  {
    key: "capacity",
    label: "Capacity",
    autoDetect: ["capacity", "cap", "max capacity", "seats"],
    transform: (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? String(n) : "";
    },
  },
  {
    key: "lat",
    label: "Latitude",
    autoDetect: ["lat", "latitude", "y", "geo_lat"],
    transform: (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= -90 && n <= 90 ? String(n) : "";
    },
  },
  {
    key: "lng",
    label: "Longitude",
    autoDetect: ["lng", "longitude", "lon", "long", "x", "geo_lng"],
    transform: (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= -180 && n <= 180 ? String(n) : "";
    },
  },
  {
    key: "phone",
    label: "Phone",
    autoDetect: [
      "phone",
      "telephone",
      "tel",
      "phone number",
      "contact_phone",
      "phone_number",
    ],
  },
  {
    key: "website",
    label: "Website",
    autoDetect: [
      "website",
      "url",
      "web",
      "homepage",
      "site",
      "web_url",
      "website_url",
    ],
  },
  {
    key: "bio",
    label: "Description / Bio",
    autoDetect: [
      "bio",
      "description",
      "about",
      "summary",
      "desc",
      "overview",
      "blurb",
    ],
  },
];
