/**
 * Ithas Fire Embed Auto-Resize Listener
 * Include this script on pages that host a Ithas Fire embed iframe.
 * It listens for hf:resize messages and adjusts iframe height automatically.
 *
 * Origin validation:
 *   - Reads data-origin from its own <script> tag if set.
 *   - Otherwise derives origin from the first iframe[src*="/embed/"] on the page.
 *   - Rejects all messages when origin cannot be determined (secure default).
 */
(function () {
  "use strict";

  // Ceiling on the height a widget may ask for. Kept as a guard against a
  // resize feedback loop; set above the widget's tallest list (50 poster
  // cards in one column are ~36,200px) so no real list is clipped.
  var MAX_HEIGHT = 50000;

  var currentScript = document.currentScript;
  var allowedOrigin = currentScript && currentScript.getAttribute("data-origin");

  if (!allowedOrigin) {
    var firstIframe = document.querySelector('iframe[src*="/embed/"]');
    if (firstIframe) {
      try {
        var url = new URL(firstIframe.getAttribute("src"), window.location.href);
        allowedOrigin = url.origin;
      } catch (_e) { /* ignore parse errors */ }
    }
  }

  window.addEventListener("message", function (event) {
    // Lazily derive origin for late-loading iframes
    if (!allowedOrigin) {
      var firstIframe = document.querySelector('iframe[src*="/embed/"]');
      if (firstIframe) {
        try {
          var url = new URL(firstIframe.getAttribute("src"), window.location.href);
          allowedOrigin = url.origin;
        } catch (_e) { /* ignore */ }
      }
    }
    if (!allowedOrigin || event.origin !== allowedOrigin) return;

    var data = event.data;
    if (!data || typeof data.type !== "string" || data.type.indexOf("hf:") !== 0) return;

    if (data.type === "hf:resize" && typeof data.height === "number" && data.height > 0 && isFinite(data.height)) {
      var iframes = document.querySelectorAll('iframe[src*="/embed/"]');
      for (var i = 0; i < iframes.length; i++) {
        if (iframes[i].contentWindow === event.source) {
          iframes[i].style.height = Math.min(data.height, MAX_HEIGHT) + "px";
          break;
        }
      }
    }
  });
})();
