/*\
title: $:/plugins/valpackett/tiddlypwa-offline/sw.js
type: application/javascript

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
const CACHE = 'tiddlypwa';

async function fromNetCaching(evt, cacheResp) {
	const response = await fetch(evt.request);
	if (response.ok) {
		const changed = cacheResp && (await response.clone().text() !== await cacheResp.text());
		const cache = await caches.open(CACHE);
		await cache.put(evt.request, response.clone());
		if (changed) {
			for (const client of await self.clients.matchAll()) {
				client.postMessage({ typ: 'REFRESH' });
			}
		}
	}
	return response;
}

async function fromCache(evt) {
	const cache = await caches.open(CACHE);
	const response = await cache.match(evt.request);
	if (response) {
		fromNetCaching(evt, response.clone());
		return response;
	} else {
		return fromNetCaching(evt);
	}
}

self.addEventListener('fetch', (evt) => {
	if (evt.request.destination === 'document' && evt.request.method === 'GET') {
		evt.respondWith(fromCache(evt));
	}
});
