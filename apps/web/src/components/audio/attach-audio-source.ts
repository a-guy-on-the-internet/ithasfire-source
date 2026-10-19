import * as Sentry from "@sentry/nextjs";
import type HlsType from "hls.js";
import { traceIgnoredError, isAutoplayBlocked } from "@/lib/trace-ignored-error";
import { loadHls } from "./load-hls";

/** `MediaError` codes; numeric so the module runs where `MediaError` is absent. */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * Give an `<audio>` element its source, playing HLS where the browser cannot.
 *
 * An audio block plays `sourceUrl` (the original file) when the server could
 * sign it, else `hlsPlaylistUrl` (an `.m3u8` of MPEG-TS/AAC segments). A
 * browser that reports native HLS (`canPlayType`) gets the playlist as a plain
 * `audio.src`; elsewhere it goes through hls.js over Media Source Extensions.
 * hls.js is imported lazily, so its bundle loads only for an HLS-only block on
 * a browser without native HLS. If a reported-native browser then refuses the
 * playlist (source not supported / decode error before any metadata), it is
 * moved onto hls.js once.
 *
 * hls.js honours the element's `preload="metadata"`: it fetches the playlist
 * but no segments until the first `play`. A play tapped before hls.js is
 * attached is re-issued once the media is attached, so one tap plays.
 *
 * Returns a cleanup that destroys the hls.js instance and removes every
 * listener this function added. It is safe to call before the import
 * resolves: the instance is then never created or attached. Callers that want
 * the element emptied (the hydrator) clear `audio.src` themselves, AFTER this
 * cleanup, so hls.js detaches its own blob: URL first.
 *
 * On a fatal hls.js error the instance is destroyed, the failure is reported
 * to Sentry once, and a synthetic `error` event is dispatched on the element
 * so the player shows the same state as a native load failure.
 */
export function attachAudioSource(
  audio: HTMLAudioElement,
  url: string,
): () => void {
  if (!isHlsPlaylistUrl(url)) {
    audio.src = url;
    return () => {};
  }
  if (canPlayHlsNatively(audio)) return attachNativeHls(audio, url);
  return attachHlsJs(audio, url, { fallBackToNative: true });
}

/** True when the URL's PATH ends in `.m3u8` (query and fragment ignored). */
export function isHlsPlaylistUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url, "http://relative.invalid").pathname;
  } catch {
    path = url.split(/[?#]/, 1)[0] ?? "";
  }
  return /\.m3u8$/i.test(path);
}

/**
 * Native HLS, with a one-shot move to hls.js when the browser said "maybe"
 * and then could not play the playlist. Only a REAL media error counts
 * (`audio.error.code`): the synthetic `error` this module dispatches after an
 * hls.js failure carries `audio.error === null` and cannot trigger it.
 */
function attachNativeHls(audio: HTMLAudioElement, url: string): () => void {
  let detachHlsJs: (() => void) | null = null;
  const removeListeners = () => {
    audio.removeEventListener("loadedmetadata", removeListeners);
    audio.removeEventListener("error", onError);
  };
  const onError = () => {
    const code = audio.error?.code;
    if (code !== MEDIA_ERR_SRC_NOT_SUPPORTED && code !== MEDIA_ERR_DECODE) return;
    removeListeners();
    // No native retry if MSE is missing too: the element already failed.
    detachHlsJs = attachHlsJs(audio, url, { fallBackToNative: false });
  };
  // Metadata arrived: native playback works, the fallback is off for good.
  audio.addEventListener("loadedmetadata", removeListeners);
  audio.addEventListener("error", onError);
  audio.src = url;

  return () => {
    removeListeners();
    detachHlsJs?.();
    detachHlsJs = null;
  };
}

function attachHlsJs(
  audio: HTMLAudioElement,
  url: string,
  opts: { fallBackToNative: boolean },
): () => void {
  let disposed = false;
  let hls: HlsType | null = null;
  // A player whose element already holds a file (AudioPlayer moving from a
  // direct src to a playlist) stops loading it while hls.js downloads.
  if (audio.hasAttribute("src")) {
    audio.removeAttribute("src");
    audio.load();
  }

  // A play requested before hls.js owns the element (tap during the import, or
  // a native attempt that failed) is aborted by the media load hls.js starts;
  // remember it (a later pause cancels it) and play again once attached.
  let playRequested = !audio.paused;
  const onEarlyPlay = () => {
    playRequested = true;
  };
  const onEarlyPause = () => {
    playRequested = false;
  };
  audio.addEventListener("play", onEarlyPlay);
  audio.addEventListener("pause", onEarlyPause);
  const removeEarlyListeners = () => {
    audio.removeEventListener("play", onEarlyPlay);
    audio.removeEventListener("pause", onEarlyPause);
  };

  let onPlayStartLoad: (() => void) | null = null;
  const removeListeners = () => {
    removeEarlyListeners();
    if (onPlayStartLoad) audio.removeEventListener("play", onPlayStartLoad);
    onPlayStartLoad = null;
  };

  const playNatively = () => {
    removeListeners();
    const wantsPlay = playRequested;
    audio.src = url;
    if (wantsPlay) {
      audio.play().catch(traceIgnoredError("audio.hls.replay", isAutoplayBlocked));
    }
  };

  loadHls()
    .then((Hls) => {
      if (disposed) return;
      if (!Hls.isSupported()) {
        // No MSE: hand the playlist to the element. It plays where HLS is
        // native under a name canPlayType does not report, and otherwise
        // fails the way it did before hls.js was wired in.
        if (opts.fallBackToNative) playNatively();
        else removeListeners();
        return;
      }
      const instance = new Hls({ autoStartLoad: false });
      hls = instance;

      let loadStarted = false;
      const startLoad = () => {
        if (loadStarted || hls !== instance) return;
        loadStarted = true;
        // -1: start where the element is, so a seek made before play holds.
        instance.startLoad(-1);
      };
      onPlayStartLoad = startLoad;
      audio.addEventListener("play", startLoad);

      // From attachMedia on, the element has hls.js's src: a play from here
      // is not aborted, and `startLoad` above serves it. Only the request
      // made before that is replayed.
      let wantsPlay = false;
      instance.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (hls !== instance || !wantsPlay) return;
        wantsPlay = false;
        startLoad();
        audio.play().catch(traceIgnoredError("audio.hls.replay", isAutoplayBlocked));
      });
      instance.on(Hls.Events.ERROR, (_event, data) => {
        // Only the first fatal error of a live instance acts: it is
        // destroyed here, so it reports once and cleanup skips it.
        if (!data.fatal || hls !== instance) return;
        hls = null;
        removeListeners();
        report(
          new Error(`hls.js fatal error: ${data.type} / ${data.details}`),
          { hlsErrorType: String(data.type), hlsErrorDetails: String(data.details) },
        );
        instance.destroy();
        audio.dispatchEvent(new Event("error"));
      });
      instance.loadSource(url);
      removeEarlyListeners();
      wantsPlay = playRequested;
      instance.attachMedia(audio);
    })
    .catch((err: unknown) => {
      if (disposed) return;
      // The chunk failed to load (offline, deploy skew). Report it and fall
      // back to the native element, which surfaces its own error state.
      report(err, { hlsErrorType: "import" });
      if (opts.fallBackToNative) playNatively();
      else removeListeners();
    });

  return () => {
    disposed = true;
    removeListeners();
    const instance = hls;
    hls = null;
    instance?.destroy();
  };
}

function canPlayHlsNatively(audio: HTMLAudioElement): boolean {
  try {
    return Boolean(audio.canPlayType("application/vnd.apple.mpegurl"));
  } catch {
    return false;
  }
}

function report(err: unknown, tags: Record<string, string>): void {
  // A throwing reporter must never change playback behaviour. The HLS output
  // is public and unsigned, but URLs stay out of the event anyway: they carry
  // ids, and the tags are what triage filters on.
  try {
    Sentry.captureException(err, {
      tags: { source: "audio-hls", ...tags },
    });
  } catch {
    /* reporting is best-effort */
  }
}
