const CACHE_NAME = 'pokedex-shell-v1';
const SHELL_PATHS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_PATHS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const isCardArt = url.pathname.startsWith('/api/art/') || url.pathname.startsWith('/card-art/');
  const isShellRequest = request.mode === 'navigate' || SHELL_PATHS.includes(url.pathname);
  if (!isCardArt && !isShellRequest) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok)
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      });
      return cached ?? network;
    }),
  );
});
