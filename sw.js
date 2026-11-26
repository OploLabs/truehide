console.log("[TrueHide SW] Loaded from:", self.location.href);
console.log("[TrueHide SW] Base directory:", new URL("./", self.location.href));
const CACHE = "truehide-v5";

const BASE = new URL("./", self.location.href);

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./script.js",
  "./manifest.json",
  "./shared/base.css",
  "./shared/base.js",
  "./shared/footer.html",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",

  "./app/trueflatten/index.html",
  "./app/trueflatten/style.css",
  "./app/trueflatten/script.js",
  "./app/trueflatten/lib/pdf.min.js",
  "./app/trueflatten/lib/pdf.worker.min.js",
  "./app/trueflatten/lib/jspdf.umd.min.js",

  "./app/trueblur/index.html",
  "./app/trueblur/style.css",
  "./app/trueblur/script.js",

  "./app/truecrop/index.html",
  "./app/truecrop/style.css",
  "./app/truecrop/script.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const file of SHELL) {
        try {
          const url = new URL(file, BASE);
          const response = await fetch(url);

          if (response.ok) {
            await cache.put(url, response);
          }
        } catch (error) {
          console.warn("Could not cache:", file, error);
        }
      }
    }),
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter((key) => key.startsWith("truehide-") && key !== CACHE)
          .map((key) => caches.delete(key)),
      );

      await self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(async (cached) => {
      if (cached) return cached;

      try {
        const response = await fetch(event.request);

        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(event.request, response.clone());
        }

        return response;
      } catch (error) {
        if (event.request.mode === "navigate") {
          return (
            (await caches.match(new URL("./index.html", BASE))) ||
            Response.error()
          );
        }

        return Response.error();
      }
    }),
  );
});
