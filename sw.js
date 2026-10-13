// Сервис-воркер: сначала берём файлы из сети, а без интернета показываем
// сохранённую копию интерфейса (доска тогда открывается только для просмотра).
// Запросы к Supabase (другой домен) не трогаем.

const CACHE = 'trello-lite-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js',
  'vendor/supabase.js', 'vendor/quill.js', 'vendor/quill.snow.css', 'manifest.webmanifest', 'icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('index.html'))),
  );
});
