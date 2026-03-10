/**
 * Auto-poll images inside Shadow DOM that fail to load (deferred generation).
 * Attaches onerror handlers to all <img> tags — retries with HEAD polling
 * until the image becomes available or max attempts reached.
 *
 * Panel authors don't need to do anything special — just use:
 *   <img src="{{__imageBase}}filename.png">
 */

const POLL_INTERVAL = 2000;
const MAX_POLLS = 60;
const ATTR = "data-poll-active";

export function installImagePolling(shadow: ShadowRoot): void {
  const imgs = shadow.querySelectorAll("img");

  for (const img of Array.from(imgs)) {
    // Skip images that already have polling or already loaded
    if (img.getAttribute(ATTR)) continue;

    // Use the resolved absolute URL (browser auto-encodes unicode chars)
    const src = img.src;
    if (!src) continue;

    // Only poll session/API images (not external URLs)
    if (!src.includes("/api/")) continue;

    img.setAttribute(ATTR, "1");

    let pollCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(src, {
          method: "HEAD",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        });

        if (res.ok) {
          // Image is ready — force reload by busting cache
          const sep = src.includes("?") ? "&" : "?";
          img.src = `${src}${sep}_t=${Date.now()}`;
          return;
        }
      } catch {
        // Network error, keep polling
      }

      pollCount++;
      if (pollCount < MAX_POLLS) {
        timer = setTimeout(poll, POLL_INTERVAL);
      }
    };

    // Use the native error event to start polling only when the image actually fails
    img.addEventListener(
      "error",
      () => {
        // Don't start polling if already active (e.g. re-triggered after src change)
        if (pollCount > 0) return;
        // Hide broken image icon while polling
        img.style.opacity = "0.3";
        poll();
      },
      { once: true }
    );

    // When image eventually loads (after polling or naturally), restore opacity
    img.addEventListener("load", () => {
      img.style.opacity = "";
      if (timer) clearTimeout(timer);
    });
  }
}
