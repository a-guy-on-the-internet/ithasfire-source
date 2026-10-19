import type maplibregl from "maplibre-gl";

const LOCAL_TILESERVER_HOSTS = ["localhost:8081", "127.0.0.1:8081"];
const MISSING_LOCAL_FONT_STACKS = [
  "/fonts/Open Sans Bold,Arial Unicode MS Bold/",
  "/fonts/Open%20Sans%20Bold,Arial%20Unicode%20MS%20Bold/",
];
const LOCAL_GLYPH_FALLBACK_STACK = "/fonts/Open%20Sans%20Regular/";

const TRANSPARENT_PIXEL = {
  width: 1,
  height: 1,
  data: new Uint8Array([0, 0, 0, 0]),
};

const isLocalTileserverUrl = (url: string): boolean =>
  LOCAL_TILESERVER_HOSTS.some((host) => url.includes(host));

export function installMissingImageFallback(
  map: maplibregl.Map,
  styleUrl: string,
): void {
  if (
    process.env.NODE_ENV === "production" ||
    !isLocalTileserverUrl(styleUrl)
  ) {
    return;
  }

  map.on("styleimagemissing", ({ id }) => {
    if (map.hasImage(id)) {
      return;
    }

    try {
      map.addImage(id, TRANSPARENT_PIXEL);
    } catch {
      // The map may have been removed between the missing-image event and addImage.
    }
  });
}

export function transformLocalMapLibreRequest(url: string): { url: string } {
  if (!isLocalTileserverUrl(url)) {
    return { url };
  }

  const missingStack = MISSING_LOCAL_FONT_STACKS.find((stack) =>
    url.includes(stack),
  );
  if (!missingStack) {
    return { url };
  }

  return { url: url.replace(missingStack, LOCAL_GLYPH_FALLBACK_STACK) };
}
