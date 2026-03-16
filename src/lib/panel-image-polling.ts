/**
 * Auto-poll images inside Shadow DOM that fail to load (deferred generation).
 * Attaches onerror handlers to all <img> tags — retries with HEAD polling
 * until the image becomes available or max attempts reached.
 *
 * Also provides `bustImageCache(filename)` to force-refresh images across
 * all tracked Shadow DOMs when a file is overwritten (e.g. regenerated).
 *
 * Panel authors don't need to do anything special — just use:
 *   <img src="{{__imageBase}}filename.png">
 */

const POLL_INTERVAL = 2000;
const MAX_POLLS = 120;
const ATTR = "data-poll-active";

/** Global set of all active Shadow DOMs (auto-cleaned via WeakRef) */
const trackedShadows = new Set<WeakRef<ShadowRoot>>();

function cleanupRefs(): void {
  for (const ref of trackedShadows) {
    if (!ref.deref()) trackedShadows.delete(ref);
  }
}

export function installImagePolling(shadow: ShadowRoot): void {
  // Track this shadow root for later cache busting
  // Check if already tracked (avoid duplicates)
  let found = false;
  for (const ref of trackedShadows) {
    if (ref.deref() === shadow) { found = true; break; }
  }
  if (!found) {
    trackedShadows.add(new WeakRef(shadow));
    // Periodically clean up dead refs
    if (trackedShadows.size % 20 === 0) cleanupRefs();
  }

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

/**
 * Force-refresh all <img> tags across tracked Shadow DOMs whose src
 * matches the given filename. Appends/updates a cache-buster query param.
 */
export function bustImageCache(filename: string): void {
  const buster = `_t=${Date.now()}`;

  for (const ref of trackedShadows) {
    const shadow = ref.deref();
    if (!shadow) continue;

    const imgs = shadow.querySelectorAll("img");
    for (const img of Array.from(imgs)) {
      const src = img.src;
      if (!src || !src.includes("/api/")) continue;

      // Check if this image's URL contains the filename
      // Decode URI to handle encoded characters (e.g. Korean filenames)
      const decoded = decodeURIComponent(src);
      if (!decoded.includes(`/${filename}`) && !decoded.includes(`=${filename}`)) continue;

      // Strip existing cache buster and add new one
      const base = src.replace(/[?&]_t=\d+/, "");
      const sep = base.includes("?") ? "&" : "?";
      img.src = `${base}${sep}${buster}`;
    }
  }

  // Also update images in the main document (inline images in chat)
  const docImgs = document.querySelectorAll("img");
  for (const img of Array.from(docImgs)) {
    const src = img.src;
    if (!src || !src.includes("/api/")) continue;
    const decoded = decodeURIComponent(src);
    if (!decoded.includes(`/${filename}`) && !decoded.includes(`=${filename}`)) continue;
    const base = src.replace(/[?&]_t=\d+/, "");
    const sep = base.includes("?") ? "&" : "?";
    img.src = `${base}${sep}${buster}`;
  }
}
