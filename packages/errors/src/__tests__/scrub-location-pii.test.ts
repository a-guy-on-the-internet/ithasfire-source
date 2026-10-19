import { describe, expect, it } from "vitest";

import {
  SCRUBBED,
  SCRUBBED_TRUNCATED,
  isLocationSensitiveKey,
  scrubLocationFromErrorEvent,
} from "../index";
import {
  MAX_DEPTH,
  MAX_NODES,
  MAX_AREA_TEXT,
  MAX_TEXT_LENGTH,
  scrubMessageText,
} from "../scrub-location-pii";

const STREET = "1417 Shelby Ave";
const LAT = 36.1782;
const LNG = -86.7453;
const PHONE = "+1 615 555 0101";

/** A Place row the way it sits in an upsert's locals. */
function placeRow() {
  return {
    id: "place-1",
    name: "Hidden House",
    address: STREET,
    addrLine1: STREET,
    addrLine2: "Unit B",
    city: "Nashville",
    region: "TN",
    postcode: "37206",
    lat: LAT,
    lng: LNG,
    phone: PHONE,
    locationMode: "OBSCURED",
    locationLabel: "East Nashville",
    geohash8: "dn6m9x3k",
  };
}

/** Everything the scrubbed output must never contain. */
function expectNoTruth(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(STREET);
  expect(text).not.toContain("Unit B");
  expect(text).not.toContain("37206");
  expect(text).not.toContain(String(LAT));
  expect(text).not.toContain(String(LNG));
  expect(text).not.toContain(PHONE);
  expect(text).not.toContain("dn6m9x3k");
}

type Frame = { function: string; vars?: Record<string, unknown> };

function errorEvent(vars: Record<string, unknown>) {
  const frames: Frame[] = [
    { function: "upsertPlace", vars },
    { function: "noVars" },
  ];
  return {
    exception: {
      values: [
        {
          type: "Error",
          value: "boom",
          stacktrace: {
            frames,
          },
        },
      ],
    },
  };
}

describe("isLocationSensitiveKey", () => {
  it("matches case-insensitively and ignores _ / -", () => {
    for (const key of [
      "address",
      "ADDRESS",
      "addressText",
      "address_text",
      "formattedAddress",
      "addrLine1",
      "addr_line_2",
      "addressLine1",
      "postalCode",
      "postal_code",
      "postcode",
      "zip",
      "lat",
      "Lng",
      "latitude",
      "LONGITUDE",
      "geohash",
      "geohash8",
      "phone",
      "street",
      "userLat",
      "userLng",
    ]) {
      expect(isLocationSensitiveKey(key), key).toBe(true);
    }
  });

  it("leaves the public, triage-useful keys alone", () => {
    for (const key of [
      "id",
      "name",
      "city",
      "region",
      "countryCode",
      "locationLabel",
      "areaLabel",
      "locationMode",
      "placeId",
      "latency",
      "zipped",
      "emailAddress",
    ]) {
      expect(isLocationSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("scrubLocationFromErrorEvent", () => {
  it("scrubs a nested Place object in stack-frame locals, keeping triage fields", () => {
    const event = errorEvent({
      input: { place: placeRow(), actorHumanId: "human-1" },
      lat: LAT,
      street: STREET,
    });

    const out = scrubLocationFromErrorEvent(event);

    expect(out).toBe(event);
    const vars = out.exception.values[0]!.stacktrace.frames[0]!.vars as {
      input: { place: Record<string, unknown>; actorHumanId: string };
      lat: unknown;
      street: unknown;
    };
    expectNoTruth(vars);
    expect(vars.lat).toBe(SCRUBBED);
    expect(vars.street).toBe(SCRUBBED);
    expect(vars.input.actorHumanId).toBe("human-1");
    expect(vars.input.place).toMatchObject({
      id: "place-1",
      name: "Hidden House",
      city: "Nashville",
      region: "TN",
      locationMode: "OBSCURED",
      locationLabel: "East Nashville",
      address: SCRUBBED,
      addrLine1: SCRUBBED,
      addrLine2: SCRUBBED,
      postcode: SCRUBBED,
      lat: SCRUBBED,
      lng: SCRUBBED,
      phone: SCRUBBED,
      geohash8: SCRUBBED,
    });
    // A frame without vars is left without vars.
    expect(out.exception.values[0]!.stacktrace.frames[1]).toEqual({
      function: "noVars",
    });
  });

  it("does not mutate the application object the event points at", () => {
    const place = placeRow();
    scrubLocationFromErrorEvent({ extra: { place } });
    expect(place.address).toBe(STREET);
    expect(place.lat).toBe(LAT);
  });

  it("scrubs an array of events (and an object-valued address) everywhere it can hide", () => {
    const events = [
      { id: "e1", addressText: STREET, lat: LAT, lng: LNG, title: "Show" },
      {
        id: "e2",
        address: { line1: STREET, postal_code: "37206" },
        title: "Show 2",
      },
    ];
    const event = {
      ...errorEvent({ events }),
      extra: { events },
      contexts: {
        trace: { trace_id: "abc", span_id: "def", data: { events } },
        payload: { events },
      },
      breadcrumbs: [
        { category: "query", data: { events } },
        { category: "nav", message: "no data" },
      ],
      request: { url: "https://api.example/trpc/x", data: { events } },
    };

    const out = scrubLocationFromErrorEvent(event);

    expectNoTruth(out);
    const extra = out.extra as { events: Array<Record<string, unknown>> };
    expect(extra.events[0]).toEqual({
      id: "e1",
      addressText: SCRUBBED,
      lat: SCRUBBED,
      lng: SCRUBBED,
      title: "Show",
    });
    expect(extra.events[1]).toEqual({
      id: "e2",
      address: SCRUBBED,
      title: "Show 2",
    });
    // The trace context still links the event to its transaction.
    expect(out.contexts.trace).toMatchObject({ trace_id: "abc", span_id: "def" });
    expect(out.breadcrumbs[1]).toEqual({ category: "nav", message: "no data" });
    expect(out.request.url).toBe("https://api.example/trpc/x");
  });

  it("parses, scrubs and re-serialises a JSON-string request body", () => {
    const body = JSON.stringify({
      0: { json: { name: "Hidden House", address: STREET, lat: LAT, lng: LNG } },
    });
    const out = scrubLocationFromErrorEvent({ request: { data: body } });

    expect(typeof out.request.data).toBe("string");
    expectNoTruth(out.request.data);
    expect(JSON.parse(out.request.data as string)).toEqual({
      0: {
        json: {
          name: "Hidden House",
          address: SCRUBBED,
          lat: SCRUBBED,
          lng: SCRUBBED,
        },
      },
    });
  });

  it("scrubs a TRUNCATED (non-JSON) body textually", () => {
    // The SDK caps captured bodies; a cut-off body is not valid JSON.
    const truncated = `{"0":{"json":{"name":"Hidden House","address":"${STREET}","lat":${LAT},"phone":"+1 615 55`;
    const out = scrubLocationFromErrorEvent({ request: { data: truncated } });

    expectNoTruth(out.request.data);
    expect(out.request.data).toContain('"name":"Hidden House"');
    expect(out.request.data).toContain(`"address":"${SCRUBBED}"`);
    expect(out.request.data).toContain(`"lat":"${SCRUBBED}"`);
    // The unterminated value at the cut is scrubbed too.
    expect(out.request.data).not.toContain("+1 615 55");
    expect(out.request.data).toContain(`"phone":"${SCRUBBED}"`);
  });

  it("is safe on circular references", () => {
    const place: Record<string, unknown> = placeRow();
    place.self = place;
    const events: unknown[] = [];
    events.push({ id: "e1", place, siblings: events });

    const event = {
      ...errorEvent({ place, events }),
      extra: { place, events },
    };

    const out = scrubLocationFromErrorEvent(event);

    expectNoTruth(out.extra);
    expectNoTruth(out.exception.values[0]!.stacktrace.frames[0]!.vars);
    const extra = out.extra as {
      place: Record<string, unknown>;
      events: Array<{ siblings: unknown }>;
    };
    expect(extra.place.self).toBe("[Circular]");
    expect(extra.events[0]!.siblings).toBe("[Circular]");
  });

  it("scrubs a value shared by two branches in BOTH (a DAG is not a cycle)", () => {
    const place = placeRow();
    const out = scrubLocationFromErrorEvent({ extra: { a: place, b: place } });
    const extra = out.extra as {
      a: Record<string, unknown>;
      b: Record<string, unknown>;
    };
    expect(extra.a.address).toBe(SCRUBBED);
    expect(extra.b.address).toBe(SCRUBBED);
  });

  it("replaces, never passes through, anything past the depth cap", () => {
    // Build a chain deeper than MAX_DEPTH with an address at the bottom.
    let deep: Record<string, unknown> = { address: STREET, note: "bottom" };
    for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { next: deep };

    const out = scrubLocationFromErrorEvent({ extra: { deep } });

    expectNoTruth(out.extra);
    expect(JSON.stringify(out.extra)).toContain(SCRUBBED_TRUNCATED);
  });

  it("stops at the node budget", () => {
    const many = Array.from({ length: MAX_NODES + 50 }, (_, i) => ({
      i,
      address: STREET,
    }));
    const out = scrubLocationFromErrorEvent({ extra: { many } });

    expectNoTruth(out.extra);
    const scrubbed = (out.extra as { many: unknown[] }).many;
    expect(scrubbed.length).toBeLessThan(many.length);
    expect(scrubbed[scrubbed.length - 1]).toBe(SCRUBBED_TRUNCATED);
  });

  it("never throws: an area that cannot be walked is dropped, the rest still scrubbed", () => {
    const hostile = {
      get address(): string {
        throw new Error("getter explodes");
      },
    };
    const event = {
      ...errorEvent({ hostile }),
      extra: { hostile },
      breadcrumbs: [{ data: { hostile } }, { data: { lat: LAT } }],
      contexts: { trace: { trace_id: "abc", data: { hostile } }, other: { hostile } },
      request: { data: { hostile } },
    };

    let out: typeof event | undefined;
    expect(() => {
      out = scrubLocationFromErrorEvent(event);
    }).not.toThrow();

    expect(out!.exception.values[0]!.stacktrace.frames[0]).not.toHaveProperty("vars");
    expect(out!).not.toHaveProperty("extra");
    expect(out!.request).not.toHaveProperty("data");
    expect(out!.breadcrumbs[0]).not.toHaveProperty("data");
    // The OTHER breadcrumb was still scrubbed.
    expect(out!.breadcrumbs[1]!.data).toEqual({ lat: SCRUBBED });
    // `trace` survives minus its data; a failing non-trace context is removed.
    expect(out!.contexts.trace).toEqual({ trace_id: "abc" });
    expect(out!.contexts).not.toHaveProperty("other");
  });

  it("passes non-object events and empty events through untouched", () => {
    expect(scrubLocationFromErrorEvent(null)).toBeNull();
    expect(scrubLocationFromErrorEvent(undefined)).toBeUndefined();
    expect(scrubLocationFromErrorEvent("x")).toBe("x");
    expect(scrubLocationFromErrorEvent({})).toEqual({});
  });

  it("handles the legacy { values: [] } breadcrumbs form", () => {
    const out = scrubLocationFromErrorEvent({
      breadcrumbs: { values: [{ data: { place: placeRow() } }] },
    });
    expectNoTruth(out.breadcrumbs);
  });
});

describe("arrival-area shapes (arrival-areas NFR-002)", () => {
  it("cuts a TRUNCATED body at a sensitive container value (fail closed)", () => {
    const truncated =
      '{"0":{"json":{"label":"Back lot","geometry":{"type":"Polygon","coordinates":[[[-86.78,36.16],[-86.7';
    const out = scrubLocationFromErrorEvent({ request: { data: truncated } });
    const data = out.request.data as string;
    expect(data).toContain('"label":"Back lot"');
    expect(data).toContain(`"${SCRUBBED_TRUNCATED}"`);
    expect(data).not.toMatch(/86|36\.1/);
    expect(data).not.toContain("Polygon");
  });

  it("scrubs bare position arrays held in frame locals", () => {
    const event = errorEvent({
      positions: [[-86.78, 36.16]],
      ring: [[-86.78, 36.16]],
      line: [[-86.78, 36.16]],
    });
    const out = scrubLocationFromErrorEvent(event);
    expect(JSON.stringify(out)).not.toMatch(/86\.78|36\.16/);
  });

  it("treats geometry and coordinates as location", () => {
    for (const key of ["geometry", "Geometry", "coordinates", "COORDINATES"]) {
      expect(isLocationSensitiveKey(key), key).toBe(true);
    }
  });

  it("scrubs an area's shape from a conflict's meta in stack locals", () => {
    const ring = [
      [LNG, LAT],
      [LNG + 0.0004, LAT],
      [LNG + 0.0004, LAT + 0.0004],
      [LNG, LAT],
    ];
    const event = errorEvent({
      meta: {
        current: {
          id: "area-1",
          label: "Back lot",
          geometry: { type: "Polygon", coordinates: [ring] },
        },
      },
      coordinates: ring,
    });

    const out = scrubLocationFromErrorEvent(event);
    const vars = out.exception.values[0]!.stacktrace.frames[0]!.vars as {
      meta: { current: Record<string, unknown> };
      coordinates: unknown;
    };
    expect(vars.meta.current.geometry).toBe(SCRUBBED);
    expect(vars.meta.current.label).toBe("Back lot");
    expect(vars.coordinates).toBe(SCRUBBED);
    expect(JSON.stringify(out)).not.toContain(String(LAT));
  });
});

describe("message text (Prisma validation errors carry the arguments)", () => {
  // The shape Prisma prints for a failed `arrivalArea.create` (pretty error
  // format): the call's arguments, geometry included, spread over lines.
  const PRISMA_AREA_CREATE = [
    "",
    "Invalid `prisma.arrivalArea.create()` invocation in",
    "/app/packages/adapters/src/db/prisma/arrival-areas.ts:142:42",
    "",
    "  139 },",
    "  140 ",
    "  141 async create(input) {",
    "→ 142   const row = await p.arrivalArea.create({",
    "          data: {",
    '            placeId: "6f1c2a9e-1111-4111-8111-111111111111",',
    '            kind: "PARKING",',
    "            geometry: {",
    '              type: "Polygon",',
    "              coordinates: [",
    "                [",
    "                  [",
    "                    -86.7412,",
    "                    36.1775",
    "                  ],",
    "                  [",
    "                    -86.7402,",
    "                    36.1785",
    "                  ]",
    "                ]",
    "              ]",
    "            },",
    '            label: "Back lot",',
    '            sortOrder: "3"',
    "                       ~~~",
    "          }",
    "        })",
    "",
    "Argument `sortOrder`: Invalid value provided. Expected Int, provided String.",
  ].join("\n");

  const SNAPSHOT_CREATE = [
    "Invalid `prisma.entityReport.create()` invocation:",
    "{",
    "  data: {",
    '    subjectType: "ARRIVAL_AREA",',
    '    subjectSnapshot: { type: "ARRIVAL_AREA", kind: "LOAD_IN", geometry: { type: "LineString", coordinates: [[-86.742, 36.177], [-86.741, 36.177]] }, placeId: null },',
    "    lat: 36.1782,",
    "    lng: -86.7453,",
    '    "latitude": 36.1782,',
    '    address: "1417 Shelby Ave",',
    "    reason: SPAM",
    "  }",
    "}",
    "Unknown argument `lat`. Available options are marked with ?.",
  ].join("\n");

  const coordinateDigits = /86\.74|36\.17|1417 Shelby/;

  it("cuts the geometry from a Prisma arrival-area create, keeping the model and field names", () => {
    const out = scrubMessageText(PRISMA_AREA_CREATE);
    expect(out).not.toMatch(coordinateDigits);
    expect(out).toContain("Invalid `prisma.arrivalArea.create()` invocation in");
    expect(out).toContain("arrival-areas.ts:142:42");
    expect(out).toContain(`geometry: "${SCRUBBED}",`);
    expect(out).toContain('kind: "PARKING"');
    expect(out).toContain('label: "Back lot"');
    expect(out).toContain('sortOrder: "3"');
    expect(out).toContain(
      "Argument `sortOrder`: Invalid value provided. Expected Int, provided String.",
    );
  });

  it("cuts a report snapshot's geometry and every keyed position, quoted or bare", () => {
    const out = scrubMessageText(SNAPSHOT_CREATE);
    expect(out).not.toMatch(coordinateDigits);
    expect(out).toContain(`lat: "${SCRUBBED}",`);
    expect(out).toContain(`lng: "${SCRUBBED}",`);
    expect(out).toContain(`"latitude": "${SCRUBBED}",`);
    expect(out).toContain(`address: "${SCRUBBED}",`);
    expect(out).toContain('subjectType: "ARRIVAL_AREA"');
    expect(out).toContain('kind: "LOAD_IN"');
    expect(out).toContain("reason: SPAM");
    expect(out).toContain("Unknown argument `lat`.");
  });

  it("cuts a bare coordinate pair with no key", () => {
    const out = scrubMessageText("bad ring at [ -86.7412, 36.1775 ] (not closed)");
    expect(out).toBe(`bad ring at "${SCRUBBED}" (not closed)`);
  });

  it("leaves a message with nothing sensitive unchanged", () => {
    const text = [
      "Unique constraint failed on the fields: (`eventId`,`arrivalAreaId`)",
      "see https://pris.ly/d/client at 12:30, retry: 3, kind: PARKING",
      "Invalid `prisma.event.findMany()` invocation: { where: { id: { in: [1, 2] } } }",
    ].join("\n");
    expect(scrubMessageText(text)).toBe(text);
  });

  it("fails closed on a sensitive container that never closes (a cut-off message)", () => {
    const out = scrubMessageText(
      'Invalid `prisma.arrivalArea.update()`: { label: "Lot", geometry: { coordinates: [[-86.7412, 36.17',
    );
    expect(out).toBe(
      `Invalid \`prisma.arrivalArea.update()\`: { label: "Lot", geometry: "${SCRUBBED_TRUNCATED}"`,
    );
  });

  it("replaces text past the length cap instead of passing it through", () => {
    const head = "x".repeat(MAX_TEXT_LENGTH - 10);
    const out = scrubMessageText(`${head} tail lat: 36.1775 [ -86.7412, 36.1775 ]`);
    expect(out.length).toBeLessThanOrEqual(
      MAX_TEXT_LENGTH + SCRUBBED_TRUNCATED.length,
    );
    expect(out.endsWith(SCRUBBED_TRUNCATED)).toBe(true);
    expect(out).not.toMatch(/36\.1775|86\.7412/);
  });

  it("stays fast on adversarial text", () => {
    const inputs = [
      '"'.repeat(MAX_TEXT_LENGTH * 2),
      "a:".repeat(MAX_TEXT_LENGTH),
      "lat: [".repeat(MAX_TEXT_LENGTH / 4),
      `[${" ".repeat(MAX_TEXT_LENGTH)}`,
      `"${"\\".repeat(MAX_TEXT_LENGTH)}`,
      "[1.1,".repeat(MAX_TEXT_LENGTH / 4),
    ];
    const started = performance.now();
    for (const text of inputs) {
      const out = scrubMessageText(text);
      expect(out.length).toBeLessThanOrEqual(
        MAX_TEXT_LENGTH + SCRUBBED_TRUNCATED.length + 2,
      );
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("scrubs exception values, message and logentry on the event, and nothing else changes", () => {
    const event = {
      exception: {
        values: [
          { type: "PrismaClientValidationError", value: PRISMA_AREA_CREATE },
          { type: "Error", value: "plain failure" },
        ],
      },
      message: { message: "saving lat: 36.1782", formatted: "lng: -86.7453" },
      logentry: {
        message: "area %s failed",
        params: ["coordinates: [[-86.7412, 36.1775]]", 3],
      },
    };
    scrubLocationFromErrorEvent(event);
    const values = event.exception.values;
    expect(values[0]!.type).toBe("PrismaClientValidationError");
    expect(values[0]!.value).not.toMatch(coordinateDigits);
    expect(values[0]!.value).toContain("prisma.arrivalArea.create()");
    expect(values[1]!.value).toBe("plain failure");
    expect(event.message).toEqual({
      message: `saving lat: "${SCRUBBED}"`,
      formatted: `lng: "${SCRUBBED}"`,
    });
    expect(event.logentry).toEqual({
      message: "area %s failed",
      params: [`coordinates: "${SCRUBBED}"`, 3],
    });

    const plain = { message: `failed at ${STREET}, address: ${STREET}` };
    scrubLocationFromErrorEvent(plain);
    expect(plain.message).toBe(`failed at ${STREET}, address: "${SCRUBBED}"`);
  });
});

describe("message text, review round 1", () => {
  // Verbatim Prisma 7.1 output (security's probe, prisma-messages.txt).
  const PRISMA_71_CREATE = [
    "",
    "Invalid `prisma.arrivalArea.create()` invocation:",
    "",
    "{",
    "  data: {",
    "    geometry: {",
    '      type: "Polygon",',
    "      coordinates: [",
    "        [",
    "          [",
    "            -86.781234,",
    "            36.161234",
    "          ],",
    "          [",
    "            -86.79,",
    "            36.17",
    "          ]",
    "        ]",
    "      ]",
    "    },",
    '    label: "L",',
    '    kind: "PARKING",',
    "    bogusField: 1,",
    "    ~~~~~~~~~~",
    "?   id?: String,",
    "?   cost?: ArrivalAreaCost,",
    "?   place?: PlaceCreateNestedOneWithoutArrivalAreasInput,",
    "  }",
    "}",
    "",
    "Unknown argument `bogusField`. Available options are marked with ?.",
  ].join("\n");
  const PRISMA_71_PLACE_UPDATE = [
    "Invalid `prisma.place.update()` invocation:",
    "{",
    "  where: {",
    '    id: "x"',
    "  },",
    "  data: {",
    '    lat: "36.161234",',
    "         ~~~~~~~~~~~",
    "    lng: -86.781234,",
    '    addrLine1: "12 Elm St"',
    "  }",
    "}",
    "Argument `lat`: Invalid value provided. Expected Float, NullableFloatFieldUpdateOperationsInput or Null, provided String.",
  ].join("\n");
  const leak = /86\.7|36\.1|12 Elm|1417|37206|555/;

  it("Prisma 7.1 messages lose every position and address, keep the field names", () => {
    const create = scrubMessageText(PRISMA_71_CREATE);
    expect(create).not.toMatch(leak);
    expect(create).toContain(`geometry: "${SCRUBBED}",`);
    expect(create).toContain('label: "L",');
    expect(create).toContain("bogusField: 1,");
    expect(create).toContain("?   cost?: ArrivalAreaCost,");
    expect(create).toContain("Unknown argument `bogusField`.");

    const update = scrubMessageText(PRISMA_71_PLACE_UPDATE);
    expect(update).not.toMatch(leak);
    expect(update).toContain(`lat: "${SCRUBBED}",`);
    expect(update).toContain(`lng: "${SCRUBBED}",`);
    expect(update).toContain(`addrLine1: "${SCRUBBED}"`);
    expect(update).toContain("Argument `lat`: Invalid value provided. Expected Float");
  });

  it("single-quoted values are whole values; a bare value runs to the end of its line", () => {
    expect(
      scrubMessageText("{ formattedAddress: '1417 Shelby Ave, Nashville, TN 37206', city: 'Nashville' }"),
    ).toBe(`{ formattedAddress: "${SCRUBBED}", city: 'Nashville' }`);
    expect(scrubMessageText("phone: +1 (615) 555-1234")).toBe(`phone: "${SCRUBBED}"`);
    expect(scrubMessageText("address: 1417 Shelby Ave, Nashville, TN 37206\nnext: 1")).toBe(
      `address: "${SCRUBBED}"\nnext: 1`,
    );
    // A `,` before another key ends it.
    expect(scrubMessageText("lat: 36.16, label: Lot")).toBe(`lat: "${SCRUBBED}", label: Lot`);
    // A quote inside a single-quoted value does not end it early.
    expect(scrubMessageText("{ street: 'Apt ] \"B\"', zip: '37206' }")).toBe(
      `{ street: "${SCRUBBED}", zip: "${SCRUBBED}" }`,
    );
  });

  it("a quoted VALUE that contains a colon is not mistaken for a key", () => {
    expect(scrubMessageText('{ name: "a", lat: 36.16, lng: -86.78, note: ": x" }')).toBe(
      `{ name: "a", lat: "${SCRUBBED}", lng: "${SCRUBBED}", note: ": x" }`,
    );
    expect(scrubMessageText('{ "name": "a", "street": "12 Elm", "note": ":" }')).toBe(
      `{ "name": "a", "street": "${SCRUBBED}", "note": ":" }`,
    );
  });

  it("escaped JSON inside a string is looked into, and the whole string goes", () => {
    expect(scrubMessageText('{"body":"{\\"lat\\":36.1,\\"lng\\":-86.7}"}')).toBe(
      `{"body":"${SCRUBBED}"}`,
    );
    // An escaped string with nothing sensitive stays.
    const benign = '{"body":"{\\"kind\\":\\"PARKING\\"}"}';
    expect(scrubMessageText(benign)).toBe(benign);
  });

  it("a value on the following lines is scrubbed to the next key line, or to the end", () => {
    expect(
      scrubMessageText("coordinates:\n  - [ -86.78, 36.16 ]\n  - [ -86, 36 ]\nlabel: Lot"),
    ).toBe(`coordinates: "${SCRUBBED}"\nlabel: Lot`);
    expect(scrubMessageText("coordinates:\n  - [ -86, 36 ]\n  - [ -87, 37 ]")).toBe(
      `coordinates: "${SCRUBBED_TRUNCATED}"`,
    );
    expect(scrubMessageText("geometry:\n  {\n    x: [-86.78, 36.16]\n  }\nkind: P")).toBe(
      `geometry: "${SCRUBBED}"\nkind: P`,
    );
    // An empty value before the next key takes nothing.
    expect(scrubMessageText("lat:\nlabel: Lot")).toBe("lat:\nlabel: Lot");
  });

  it("the length cut never splits a coordinate pair", () => {
    const pair = "[ -86.781234, 36.161234 ]";
    const text = `${"x".repeat(MAX_TEXT_LENGTH - 12)}${pair} more`;
    const out = scrubMessageText(text);
    expect(out).not.toMatch(/86\.78|36\.16/);
    expect(out.endsWith(SCRUBBED_TRUNCATED)).toBe(true);
  });

  it("the last segment of a dotted path is a key; a dotted call is not", () => {
    expect(scrubMessageText("data.lat: 36.1612, data.lng: -86.7812")).toBe(
      `data.lat: "${SCRUBBED}", data.lng: "${SCRUBBED}"`,
    );
    expect(scrubMessageText('where.place.address: "1417 Shelby Ave"')).toBe(
      `where.place.address: "${SCRUBBED}"`,
    );
    const call = "Invalid `prisma.arrivalArea.create()` invocation: data.kind: PARKING";
    expect(scrubMessageText(call)).toBe(call);
    // A key still may not continue a word.
    expect(scrubMessageText("x36lat: 1")).toBe("x36lat: 1");
  });

  it("past the escaped-string nesting cap, a string that could hold key text goes whole", () => {
    // Four levels of quoting: the innermost is past MAX_STRING_DEPTH (3).
    const level = (inner: string) => JSON.stringify(inner);
    const deep = level(level(level(level("note: 36.1612"))));
    expect(scrubMessageText(`{"body":${deep}}`)).toBe(`{"body":"${SCRUBBED}"}`);
    // Within the cap a benign string stays.
    const shallow = `{"body":${level(level("kind: PARKING"))}}`;
    expect(scrubMessageText(shallow)).toBe(shallow);
  });

  it("integer pairs with no key are left (an ordinary small array)", () => {
    expect(scrubMessageText("ids [1, 2] page [-86, 36]")).toBe("ids [1, 2] page [-86, 36]");
  });

  it("names the new phone and address columns as sensitive", () => {
    for (const key of [
      "contactPhone",
      "phoneE164",
      "phoneNumber",
      "physicalAddress",
      "billingAddressLine1",
      "billingAddressLine2",
      "billingPostalCode",
      "taxSitusPostal",
      "geohash6",
      "geoPoint",
    ]) {
      expect(isLocationSensitiveKey(key), key).toBe(true);
    }
  });
});

describe("string leaves of every area are scrubbed as text (security A1)", () => {
  const PRISMA = [
    "Invalid `prisma.arrivalArea.create()` invocation:",
    "{",
    "  data: {",
    "    geometry: {",
    '      type: "Polygon",',
    "      coordinates: [",
    "        [",
    "          [",
    "            -86.781234,",
    "            36.161234",
    "          ]",
    "        ]",
    "      ]",
    "    },",
    '    label: "L"',
    "  }",
    "}",
  ].join("\n");

  it("a Prisma cause message copied into extra, contexts, tags and a breadcrumb loses its coordinates in each", () => {
    const event = {
      extra: {
        causeMessage: PRISMA,
        cause: { name: "PrismaClientValidationError", message: PRISMA },
        note: "timeout after 30s calling https://maps.example.com/v1",
      },
      contexts: { app: { lastError: PRISMA, route: "events.get" } },
      tags: { causeMessage: PRISMA.slice(0, 200), route: "arrivalAreas.create" },
      breadcrumbs: [{ category: "prisma", message: PRISMA, data: { ok: "yes: fine" } }],
      exception: {
        values: [
          {
            type: "AppError",
            value: "INTERNAL",
            stacktrace: { frames: [{ vars: { err: `<PrismaClientValidationError: ${PRISMA}>` } }] },
          },
        ],
      },
    };
    scrubLocationFromErrorEvent(event);
    const json = JSON.stringify(event);
    expect(json).not.toMatch(/86\.78|36\.16/);
    expect(event.extra.causeMessage).toContain("prisma.arrivalArea.create()");
    expect(event.extra.causeMessage).toContain(`geometry: "${SCRUBBED}"`);
    expect(event.extra.cause.message).toContain(`geometry: "${SCRUBBED}"`);
    expect(event.contexts.app.lastError).toContain(`geometry: "${SCRUBBED}"`);
    expect(event.tags.causeMessage).not.toMatch(/86\.78|36\.16/);
    expect(event.breadcrumbs[0]!.message).toContain(`geometry: "${SCRUBBED}"`);
    // Benign strings are unchanged.
    expect(event.extra.note).toBe("timeout after 30s calling https://maps.example.com/v1");
    expect(event.extra.cause.name).toBe("PrismaClientValidationError");
    expect(event.contexts.app.route).toBe("events.get");
    expect(event.tags.route).toBe("arrivalAreas.create");
    expect(event.breadcrumbs[0]!.data).toEqual({ ok: "yes: fine" });
  });

  it("a sensitive key's value is still replaced whole, before any text pass", () => {
    const event = { extra: { address: "label: fine", nested: { lat: "not: text" } } };
    scrubLocationFromErrorEvent(event);
    expect(event.extra).toEqual({ address: SCRUBBED, nested: { lat: SCRUBBED } });
  });

  it("stops text work at the area budget: later leaves are replaced, not passed through", () => {
    const chunk = `${"a: b ".repeat(10_000)} lat: 36.161234`; // ~50 KB, has ':'
    const leaves = Math.ceil(MAX_AREA_TEXT / chunk.length) + 2;
    const extra: Record<string, string> = {};
    for (let i = 0; i < leaves; i += 1) extra[`k${i}`] = chunk;
    const event = { extra };
    scrubLocationFromErrorEvent(event);
    const values = Object.values(event.extra);
    expect(values.some((v) => v === SCRUBBED_TRUNCATED)).toBe(true);
    for (const v of values) expect(v).not.toMatch(/36\.16/);
    // A leaf with no ':' or '[' costs nothing and is kept.
    const plain = { extra: { a: "x".repeat(MAX_AREA_TEXT * 2) } };
    scrubLocationFromErrorEvent(plain);
    expect(plain.extra.a.length).toBe(MAX_AREA_TEXT * 2);
  });
});

describe("request URL query and query_string (security R2-2)", () => {
  // What a tRPC GET of a near-me search sends: `?input=<url-encoded JSON>`.
  const input = encodeURIComponent(
    JSON.stringify({ json: { near: { lat: 36.161234, lng: -86.781234 }, q: "open mic" } }),
  );
  const TRPC_URL = `https://api.ithasfire.com/trpc/search.events?input=${input}`;

  it("replaces a query that carries a position, keeping the path", () => {
    const event = { request: { url: TRPC_URL, query_string: `input=${input}` } };
    scrubLocationFromErrorEvent(event);
    expect(event.request.url).toBe(`https://api.ithasfire.com/trpc/search.events?${SCRUBBED}`);
    expect(event.request.query_string).toBe(SCRUBBED);
    expect(JSON.stringify(event)).not.toMatch(/36\.16|86\.78/);
  });

  it("a sensitive parameter name, pairs and object forms, and a malformed component all count", () => {
    const named = { request: { query_string: "lat=36.16&lng=-86.78&q=x" } };
    scrubLocationFromErrorEvent(named);
    expect(named.request.query_string).toBe(SCRUBBED);

    const pairs = { request: { query_string: [["input", '{"near":{"lat":36.1}}']] } };
    scrubLocationFromErrorEvent(pairs);
    expect(pairs.request.query_string).toBe(SCRUBBED);

    const obj = { request: { query_string: { address: "1417 Shelby Ave" } } };
    scrubLocationFromErrorEvent(obj);
    expect(obj.request.query_string).toBe(SCRUBBED);

    const malformed = { request: { url: "https://x.test/p?input=%E0%A4%A" } };
    scrubLocationFromErrorEvent(malformed);
    expect(malformed.request.url).toBe(`https://x.test/p?${SCRUBBED}`);
  });

  it("leaves a query with no location, and a URL with no query, unchanged", () => {
    const benign = encodeURIComponent(JSON.stringify({ json: { slug: "open-mic", page: 2 } }));
    const url = `https://api.ithasfire.com/trpc/events.get?input=${benign}&batch=1`;
    const event = {
      request: { url, query_string: `input=${benign}&batch=1` },
    };
    scrubLocationFromErrorEvent(event);
    expect(event.request.url).toBe(url);
    expect(event.request.query_string).toBe(`input=${benign}&batch=1`);

    const bare = { request: { url: "https://api.ithasfire.com/health" } };
    scrubLocationFromErrorEvent(bare);
    expect(bare.request.url).toBe("https://api.ithasfire.com/health");
  });
});
