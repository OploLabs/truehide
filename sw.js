const CACHE = "truehide-v1";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./script.js",
  "./manifest.json",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
  "./app/trueflatten/index.html",
  "./app/trueflatten/style.css",
  "./app/trueflatten/script.js",
  "./app/trueblur/index.html",
  "./app/trueblur/style.css",
  "./app/trueblur/script.js",
  "./app/truecrop/index.html",
  "./app/truecrop/style.css",
  "./app/truecrop/script.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(SHELL).catch((error) => {
        console.log("TrueHide precache failed:", error);
      }),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) =>
            cache.put(event.request, clone),
          );
        }
        return response;
      });
    }),
  );
});
