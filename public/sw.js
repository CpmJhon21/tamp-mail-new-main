const CACHE_NAME = 'tempmail-v3';
const API_CACHE_NAME = 'tempmail-api-v3';
const STATIC_CACHE_NAME = 'tempmail-static-v3';

// Assets to cache
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap',
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css',
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://cdn-icons-png.flaticon.com/512/732/732200.png'
];

// Install event
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE_NAME).then((cache) => {
            console.log('Caching static assets');
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== STATIC_CACHE_NAME && 
                        cacheName !== API_CACHE_NAME && 
                        cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch event with cache strategy
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // API requests - Network first, then cache (stale-while-revalidate)
    if (url.pathname.includes('/api')) {
        event.respondWith(
            caches.open(API_CACHE_NAME).then((cache) => {
                return fetch(event.request)
                    .then((networkResponse) => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    })
                    .catch(() => {
                        return cache.match(event.request);
                    });
            })
        );
        return;
    }
    
    // Static assets - Cache first, then network
    if (STATIC_ASSETS.includes(url.pathname) || 
        url.href.includes('bootstrap-icons') || 
        url.href.includes('fonts.googleapis')) {
        
        event.respondWith(
            caches.match(event.request)
                .then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    return fetch(event.request).then((networkResponse) => {
                        if (networkResponse && networkResponse.status === 200) {
                            const responseClone = networkResponse.clone();
                            caches.open(STATIC_CACHE_NAME).then((cache) => {
                                cache.put(event.request, responseClone);
                            });
                        }
                        return networkResponse;
                    });
                })
        );
        return;
    }
    
    // Default - Network only
    event.respondWith(fetch(event.request));
});

// Background sync for offline actions
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-messages') {
        event.waitUntil(syncMessages());
    }
});

async function syncMessages() {
    try {
        const cache = await caches.open(API_CACHE_NAME);
        const requests = await cache.keys();
        
        for (const request of requests) {
            if (request.url.includes('/api')) {
                const cachedResponse = await cache.match(request);
                if (cachedResponse) {
                    try {
                        await fetch(request, {
                            method: 'POST',
                            body: await cachedResponse.clone().text(),
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        });
                        await cache.delete(request);
                    } catch (e) {
                        console.log('Sync failed for:', request.url);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Sync error:', e);
    }
}