/*\
title: $:/plugins/valpackett/tiddlypwa/main.js
type: application/javascript
module-type: syncadaptor

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	if (!$tw.browser) return;

	if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
		alert('Warning! TiddlyPWA must be served over HTTPS.');
	}

	const knownErrors = {
		EAUTH: 'Wrong password and/or sync token',
		EPROTO: 'Protocol incompatibility',
		ETIMESYNC: 'The current time is too different between the server and the device',
	};

	const utfenc = new TextEncoder('utf-8');
	const utfdec = new TextDecoder('utf-8');

	function adb(req) {
		return new Promise((resolve, reject) => {
			req.onerror = (evt) => {
				if (typeof evt.preventDefault === 'function') {
					evt.preventDefault();
				}
				reject(evt.target.error);
			};
			req.onsuccess = (evt) => resolve(evt.target.result);
		});
	}

	async function b64enc(data) {
		if (!data) {
			return null;
		}

		return (await new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.readAsDataURL(new Blob([data]));
		})).split(',', 2)[1];
	}

	function b64dec(base64) {
		// welp touching binary strings here but seems to be a decent compact way
		return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
	}

	function formatBytes(bytes) {
		const sizes = ['bytes', '~KiB', '~MiB', '~GiB', '~TiB'];
		const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
		if (i >= sizes.length) return 'too much';
		return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
	}

	function arrayEq(a, b) {
		const av = new Uint8Array(a);
		const bv = new Uint8Array(b);
		if (av.byteLength !== bv.byteLength) return false;
		return av.every((val, i) => val === bv[i]);
	}

	function isCurrentUrl(url) {
		return url === `${location.origin}${location.pathname}${location.search}`;
	}

	class PWAStorage {
		constructor(options) {
			this.wiki = options.wiki;
			this.logger = new $tw.utils.Logger('tiddlypwa-storage');
			this.monitorTimeout = 2000;
			this.modifiedQueue = new Set();
			this.deletedQueue = new Set();
			this.changesChannel = new BroadcastChannel(`tiddlypwa-changes:${location.pathname}`);
			this.changesChannel.onmessage = (evt) => {
				if (evt.data.title === '$:/StoryList') return; // don't mess with viewing different things in multiple tabs
				this.logger.log('Change from another tab', evt.data);
				if (evt.data.del) {
					this.deletedQueue.add(evt.data.title);
				} else {
					this.modifiedQueue.add(evt.data.title);
				}
				$tw.syncer.syncFromServer(); // "server" being our local DB
				this.reflectStorageInfo();
			};
			this.serversChannel = new BroadcastChannel(`tiddlypwa-servers:${location.pathname}`);
			this.serversChannel.onmessage = (_evt) => {
				this.reflectSyncServers();
			};
			this.sessionChannel = new BroadcastChannel(`tiddlypwa-session:${location.pathname}`);
			this.sessionChannel.onmessage = (evt) => {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: evt.data ? 'yes' : 'no' });
			};

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: navigator.onLine ? 'yes' : 'no' });
			window.addEventListener(
				'offline',
				(_evt) => this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'no' }),
			);
			window.addEventListener(
				'online',
				(_evt) => {
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'yes' });
					this.startRealtimeMonitor();
				},
			);

			$tw.rootWidget.addEventListener('tiddlypwa-init', (_evt) => {
				const req = indexedDB.open(`tiddlypwa:${location.pathname}`, 1);
				req.onupgradeneeded = (evt) => this.initDb(evt.target.result);
				adb(req).then((_) => {
					$tw.syncer.isDirty = () => false; // skip the onbeforeunload
					location.reload();
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-remember', (_evt) => {
				this.db.transaction('session', 'readwrite').objectStore('session').put({ key: this.key, mackey: this.mackey })
					.onsuccess = (
						_evt,
					) => {
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: 'yes' });
						$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-remembered');
						this.sessionChannel.postMessage(true);
					};
			});

			$tw.rootWidget.addEventListener('tiddlypwa-forget', (_evt) => {
				this.db.transaction('session', 'readwrite').objectStore('session').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (cursor) {
						cursor.delete();
						cursor.continue();
					}
				};
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: 'no' });
				this.sessionChannel.postMessage(false);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-enable-persistence', (_evt) => {
				navigator.storage.persist().then(() => this.reflectStorageInfo());
			});

			$tw.rootWidget.addEventListener('tiddlypwa-drop-db', (_evt) => {
				this.dropDb();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-add-sync-server', (evt) => {
				const url = evt && evt.paramObject && evt.paramObject.url;
				const token = evt && evt.paramObject && evt.paramObject.token;
				if (!url || !token) {
					alert('A sync server must have a URL and a token!');
					return;
				}
				try {
					new URL(url);
				} catch (_e) {
					alert('The URL must be valid!');
					return;
				}
				adb(
					this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put({
						url,
						token,
						lastSync: new Date(0),
					}),
				).then((_x) => {
					this.reflectSyncServers();
					this.serversChannel.postMessage(true);
					this.backgroundSync();
				}).catch((e) => {
					this.logger.alert('Failed to save the sync server!', e);
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-delete-sync-server', (evt) => {
				const key = evt && evt.paramObject && evt.paramObject.key;
				adb(
					this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').delete(parseInt(key)),
				).then((_x) => {
					this.reflectSyncServers();
					this.serversChannel.postMessage(true);
				}).catch((e) => {
					this.logger.alert('Failed to delete the sync server!', e);
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-upload-app-wiki', (evt) => {
				this.uploadAppWiki(evt.paramObject);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-browser-refresh', (_evt) => {
				$tw.syncer.isDirty = () => false; // skip the onbeforeunload
				location.reload(); // tm-browser-refresh passes 'true' which skips the serviceworker. silly!
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync-cancel', (_evt) => {
				this.syncAbort.abort();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync-all', (_evt) => {
				this.sync(true);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync', (_evt) => {
				this.sync(false);
			});
		}

		async _startRealtimeMonitor() {
			const servers = await adb(
				this.db.transaction('syncservers').objectStore('syncservers').getAll(),
			);
			if (servers.length === 0) return;
			const server = servers[~~(Math.random() * servers.length)];
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWARealtime',
				text: `connecting to ${server.url}`,
			});
			const url = new URL(server.url);
			url.searchParams.set('op', 'monitor');
			url.searchParams.set('token', server.token);
			url.searchParams.set('browserToken', this.browserToken);
			this.monitorStream = new EventSource(url.href);
			this.monitorStream.onopen = (_e) => {
				this.monitorTimeout = 2000;
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARealtime',
					text: `connected to ${server.url}`,
				});
			};
			this.monitorStream.addEventListener('sync', (_evt) => this.backgroundSync());
			await new Promise((resolve) => {
				this.monitorStream.onerror = resolve;
			});
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWARealtime',
				text: `disconnected from ${server.url}`,
			});
			this.monitorStream.close();
			this.startedMonitor = false;
			if (navigator.onLine) this.startRealtimeMonitor();
		}

		startRealtimeMonitor() {
			if (this.startedMonitor) return;
			this.startedMonitor = true;
			if (this.monitorTimeout < 60000) this.monitorTimeout *= 2;
			clearTimeout(this.monitorTimer);
			this.monitorTimer = setTimeout(async () => {
				if (!navigator.locks) {
					this._startRealtimeMonitor();
				}
				navigator.locks.request(
					`tiddlypwa-realtime:${location.pathname}`,
					(_lck) => this._startRealtimeMonitor(),
				);
			}, this.monitorTimeout);
		}

		reflectSyncServers() {
			this.startRealtimeMonitor();
			for (const tidname of this.wiki.getTiddlersWithTag('$:/temp/TiddlyPWAServer')) {
				this.wiki.deleteTiddler(tidname);
			}
			return new Promise((resolve) =>
				this.db.transaction('syncservers').objectStore('syncservers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve();
					}
					const { url, token, lastSync } = cursor.value;
					this.wiki.addTiddler({
						title: '$:/temp/TiddlyPWAServers/' + cursor.key,
						tags: ['$:/temp/TiddlyPWAServer'],
						key: cursor.key,
						url,
						token,
						lastSync: lastSync?.getTime() === 0 ? 'never' : lastSync?.toLocaleString(),
					});
					cursor.continue();
				}
			);
		}

		async reflectStorageInfo() {
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAStoragePersisted',
				text: (navigator.storage && navigator.storage.persist)
					? (await navigator.storage.persisted() ? 'yes' : 'no')
					: 'unavail',
			});
			const formatEstimate = ({ usage, quota }) =>
				`${formatBytes(usage)} of ${formatBytes(quota)} (${(usage / quota * 100).toFixed(2)}%)`;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAStorageQuota',
				text: (navigator.storage && navigator.storage.estimate)
					? formatEstimate(await navigator.storage.estimate())
					: 'unavail',
			});
		}

		isReady() {
			return !!(this.db && this.key);
		}

		async initialRead() {
			this.storyListHash = await this.titlehash('$:/StoryList');
			const titlesToRead = [];
			await new Promise((resolve) => {
				this.db.transaction('tiddlers').objectStore('tiddlers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve(true);
					}
					const { thash, title, tiv, deleted } = cursor.value;
					titlesToRead.push({ thash, title, tiv, deleted });
					cursor.continue();
				};
			});
			if (titlesToRead.length === 0) {
				$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-newwiki');
				$tw.wiki.addToStory('$:/ControlPanel');
				this.loadedStoryList = true; // not truly "loaded" but as in "enable saving it to the DB"
				return true;
			}
			let hasStoryList = false;
			for (const { thash, title, tiv, deleted } of titlesToRead) {
				try {
					if (arrayEq(thash, this.storyListHash)) hasStoryList = true;
					if (deleted) {
						continue;
					}
					const dectitle = await crypto.subtle.decrypt(
						{ name: 'AES-GCM', iv: tiv },
						this.key,
						title,
					);
					this.modifiedQueue.add(utfdec.decode(dectitle).trimStart());
				} catch (e) {
					this.logger.log('Title decrypt failed:', e);
					$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-badpass');
					return false;
				}
			}
			if (!hasStoryList) {
				this.loadedStoryList = true; // not truly "loaded" but as in "enable saving it to the DB"
			}
			this.backgroundSync();
			setTimeout(() => {
				try {
					$tw.__update_tiddlypwa_manifest__();
				} catch (_e) {}
			}, 300);
			return true;
		}

		initDb(db) {
			db.createObjectStore('session', { autoIncrement: true });
			db.createObjectStore('syncservers', { autoIncrement: true });
			db.createObjectStore('tiddlers', { keyPath: 'thash' });
		}

		dropDb() {
			const instdesc = `(origin: ${location.origin}; path: ${location.pathname})`;
			if (!confirm(`Are you sure you want to DELETE the local data for this instance ${instdesc} of TiddlyPWA?`)) {
				return;
			}
			if (this.db) {
				this.db.close();
				this.db = undefined;
			}
			$tw.syncer.isDirty = () => false; // skip the onbeforeunload
			adb(indexedDB.deleteDatabase(`tiddlypwa:${location.pathname}`)).then((_) => location.reload())
				.catch((e) => this.logger.alert('Failed to delete database!', e));
		}

		async _getStatus() {
			if (!this.browserToken) {
				this.browserToken = await b64enc(crypto.getRandomValues(new Uint8Array(12)));
			}
			if (!this.db) {
				const req = indexedDB.open(`tiddlypwa:${location.pathname}`, 1);
				req.onupgradeneeded = (evt) => {
					const db = evt.target.result;
					const introtid = this.wiki.getTiddler('TiddlyPWA');
					if (introtid && introtid.fields.tiddlypwa === 'noautodb') {
						evt.target.transaction.abort();
						return;
					}
					this.initDb(db);
				};
				try {
					this.db = await adb(req);
				} catch (e) {
					if (e.name === 'AbortError') {
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWADocsMode', text: 'yes' });
						return;
					}
					throw e;
				}
			}
			await this.reflectSyncServers();
			await this.reflectStorageInfo();
			if (!this.key) {
				const ses = await adb(this.db.transaction('session').objectStore('session').getAll());
				if (ses.length > 0) {
					this.key = ses[ses.length - 1].key;
					this.mackey = ses[ses.length - 1].mackey;
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: ses.length > 0 ? 'yes' : 'no' });
			}
			if (!this.key) {
				const backdrop = document.createElement('div');
				$tw.utils.addClass(backdrop, 'tc-modal-backdrop');
				$tw.utils.setStyle(backdrop, [
					{ opacity: '0.9' },
				]);
				document.body.appendChild(backdrop);
				let checked = false;
				while (!checked) {
					const { password } = await new Promise((resolve, _reject) =>
						$tw.passwordPrompt.createPrompt({
							serviceName: 'Enter the wiki password',
							submitText: 'Open',
							noUserName: true,
							callback: (data) => {
								resolve(data);
								return true;
							},
						})
					);
					const pwdk = await crypto.subtle.importKey(
						'raw',
						utfenc.encode(password),
						{ name: 'PBKDF2' },
						false,
						['deriveKey'],
					);
					this.key = await crypto.subtle.deriveKey(
						{ name: 'PBKDF2', hash: 'SHA-512', iterations: 1000000, salt: utfenc.encode('tiddlytiddlers') },
						pwdk,
						{ name: 'AES-GCM', length: 256 },
						false,
						['encrypt', 'decrypt'],
					);
					this.mackey = await crypto.subtle.deriveKey(
						{ name: 'PBKDF2', hash: 'SHA-512', iterations: 1000000, salt: utfenc.encode('tiddlyhmac') },
						pwdk,
						{ name: 'HMAC', hash: 'SHA-256' },
						false,
						['sign'],
					);
					checked = await this.initialRead();
					if (checked) {
						$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-opened');
					}
				}
				document.body.removeChild(backdrop);
			} else {
				await this.initialRead();
			}
			this.wiki.deleteTiddler('TiddlyPWA');
		}

		getStatus(cb) {
			this._getStatus().then((_) =>
				cb(
					null, // err
					false, // isLoggedIn
					null, // username
					false, // isReadOnly
					false, // isAnonymous
				)
			).catch((e) => cb(e));
		}

		getTiddlerInfo(_tiddler) {
			return {};
		}

		getTiddlerRevision(_title) {
			return null;
		}

		getUpdatedTiddlers(_syncer, cb) {
			const chg = {
				modifications: [...this.modifiedQueue],
				deletions: [...this.deletedQueue],
			};
			this.logger.log('Reflecting updates to wiki runtime', chg);
			this.modifiedQueue.clear();
			this.deletedQueue.clear();
			cb(null, chg);
		}

		titlehash(x) {
			// keyed (hmac) because sync servers don't need to be able to compare contents between different users
			return crypto.subtle.sign('HMAC', this.mackey, utfenc.encode(x));
		}

		async _saveTiddler(tiddler) {
			const thash = await this.titlehash(tiddler.fields.title);
			const jsondata = this.wiki.getTiddlerAsJson(tiddler.fields.title);
			// padding because sync servers don't need to know the precise lengths of everything
			const rawdata = utfenc.encode('\n'.repeat(256 - (jsondata.length % 256)) + jsondata);
			// "if you use nonces longer than 12 bytes, they get hashed into 12 bytes anyway" - soatok.blog
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, rawdata);
			const tiv = crypto.getRandomValues(new Uint8Array(12));
			const title = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: tiv },
				this.key,
				utfenc.encode('\n'.repeat(64 - (tiddler.fields.title.length % 64)) + tiddler.fields.title),
			);
			await adb(
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').put({
					thash, // The title hash is the primary key
					title, // Just-the-title encrypted: used to avoid decrypting other stuff in getSkinnyTiddlers
					tiv,
					data,
					iv,
					mtime: new Date(), // Has to be unencrypted for sync conflict resolution
					// also, *not* using the tiddler's modified field allows for importing tiddlers last modified in the past
				}),
			);
			await this.reflectStorageInfo();
		}

		saveTiddler(tiddler, cb) {
			if (tiddler.fields.title === '$:/StoryList' && !this.loadedStoryList) {
				// Avoid saving the pre-DB-open StoryList!
				return cb(null, '', 1);
			}
			if (tiddler.fields.title === '$:/Import') {
				// For some reason this is not in the default $:/config/SyncFilter but no one would want this actually stored.
				return cb(null, '', 1);
			}
			if (
				tiddler.fields.title.startsWith('$:/themes/') ||
				tiddler.fields.title.startsWith('$:/plugins/') ||
				tiddler.fields.title.startsWith('$:/languages/')
			) {
				// Those should go into the saved wiki file.
				// Attempting to only direct the `doesPluginRequireReload` ones into the file does not seem worth it.
				// By ignoring the callback we make TW think there's something unsaved now, which there is!
				return;
			}
			this._saveTiddler(tiddler).then((_) => {
				cb(null, '', 1);
				if (tiddler.fields.title !== '$:/StoryList') {
					this.changesChannel.postMessage({ title: tiddler.fields.title });
					this.backgroundSync();
				}
			}).catch((e) => cb(e));
		}

		async _loadTiddler(title) {
			const thash = await this.titlehash(title);
			const obj = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').get(thash));
			if (obj.deleted) return null; // XXX: investigate 'TiddlyPWA' default name tiddler getting synced as deleted on start
			const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: obj.iv }, this.key, obj.data);
			return JSON.parse(utfdec.decode(data).trimStart());
		}

		loadTiddler(title, cb) {
			this._loadTiddler(title).then((tiddler) => {
				cb(null, tiddler);
				if (title === $tw.syncer.titleSyncFilter) {
					// XXX: syncer should itself monitor for changes and recompile
					$tw.syncer.filterFn = this.wiki.compileFilter(tiddler.text);
				}
				if (title === '$:/StoryList') this.loadedStoryList = true;
			}).catch((e) => cb(e));
		}

		async _deleteTiddler(title) {
			const thash = await this.titlehash(title);
			await adb(
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').put({
					thash,
					title: null,
					tiv: null,
					data: null,
					iv: null,
					mtime: new Date(),
					deleted: true,
				}),
			);
			await this.reflectStorageInfo();
		}

		deleteTiddler(title, cb, _options) {
			this._deleteTiddler(title).then((_) => {
				cb(null);
				this.changesChannel.postMessage({ title, del: true });
				this.backgroundSync();
			}).catch((e) => cb(e));
		}

		async uploadAppWiki(variables) {
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Upload in progress.' });
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploading', text: 'yes' });
			const apphtml = $tw.wiki.renderTiddler(
				'text/plain',
				$tw.wiki.getTiddlerText('$:/config/SaveWikiButton/Template', '$:/core/save/all'),
				{ variables },
			);
			const swjs = $tw.wiki.renderTiddler('text/plain', '$:/plugins/valpackett/tiddlypwa-offline/sw.js', {});
			try {
				const servers = (variables.uploadUrl && variables.uploadToken)
					? [{ url: variables.uploadUrl, token: variables.uploadToken }]
					: await adb(
						this.db.transaction('syncservers').objectStore('syncservers').getAll(),
					);
				const resps = await Promise.all(servers.map(async ({ url, token }) => {
					const resp = await fetch(url, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'uploadapp',
							token,
							authcode: await b64enc(await this.titlehash(token)),
							browserToken: this.browserToken,
							files: {
								'app.html': {
									body: apphtml,
									ctype: 'text/html;charset=utf-8',
								},
								'sw.js': {
									body: swjs,
									ctype: 'application/javascript',
								},
							},
						}),
					});
					return [url, resp];
				}));
				const urls = [];
				for (const [url, resp] of resps) {
					if (!resp.ok) {
						try {
							const { error } = await resp.json();
							urls.push(`${url}: ${knownErrors[error] || error}`);
						} catch (_e) {
							urls.push(`${url}: Server returned error ${resp.status}`);
						}
						continue;
					}
					const href = new URL((await resp.json()).urlprefix + 'app.html', url).href;
					const isCurrent = isCurrentUrl(href);
					urls.push(
						href + (isCurrent ? ' {{$:/plugins/valpackett/tiddlypwa/cur-page-reload}}' : ''),
					);
					if (isCurrent) {
						// This makes sure we instantly reload into the new version!
						// The ServiceWorker will refetch from the server in the background again,
						// so this should not cause any trouble. E.g. a concurrent update that
						// happened in between upload and refresh would arrive as a new refresh prompt.
						// The ETag is generated in a way that matches the reference server (assuming Brotli is working).
						// If the ETag is different, sync will notice the mismatch and request the worker to reload.
						try {
							const cache = await caches.open('tiddlypwa');
							for (const req of await cache.keys()) {
								if (req.url === href) {
									cache.put(
										req,
										new Response(apphtml, {
											headers: {
												'content-type': 'text/html;charset=utf-8',
												'etag': `"${await b64enc(await crypto.subtle.digest('SHA-1', utfenc.encode(apphtml)))}-b"`,
											},
										}),
									);
								}
							}
						} catch (e) {
							this.logger.alert('Failed to update local cache!', e);
						}
					}
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Uploaded:\n\n* ' + urls.join('\n* ') });
			} catch (e) {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Upload error: ' + e });
			} finally {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploading', text: 'no' });
			}
		}

		async _syncOneUnlocked({ url, token, lastSync = new Date(0) }, all = false) {
			this.logger.log('sync started', url, lastSync, all);
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncingWith', text: url });
			const changes = [];
			await new Promise((resolve) =>
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve();
					}
					if (all || cursor.value.mtime > lastSync) {
						changes.push(cursor.value);
					}
					cursor.continue();
				}
			);
			const clientChanges = [];
			const changedKeys = new Set();
			let newestChg = new Date(0);
			for (const { thash, title, tiv, data, iv, mtime, deleted } of changes) {
				if (arrayEq(thash, this.storyListHash)) continue;
				if (mtime > newestChg) {
					newestChg = mtime;
				}
				const tidjson = {
					thash: await b64enc(thash),
					title: await b64enc(title),
					tiv: await b64enc(tiv),
					data: await b64enc(data),
					iv: await b64enc(iv),
					mtime,
					deleted,
				};
				clientChanges.push(tidjson);
				changedKeys.add(tidjson.thash);
				this.logger.log('local change', tidjson.thash);
			}
			this.syncAbort = new AbortController();
			const resp = await fetch(url, {
				signal: this.syncAbort.signal,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					tiddlypwa: 1,
					op: 'sync',
					token,
					browserToken: this.browserToken,
					authcode: await b64enc(await this.titlehash(token)),
					now: new Date(), // only for a desync check
					lastSync,
					clientChanges,
				}),
			});
			if (!resp.ok) {
				throw new Error(
					await resp.json().then(({ error }) => knownErrors[error] || error).catch((_e) =>
						'Server returned error ' + resp.status
					),
				);
			}
			const { serverChanges, appEtag } = await resp.json();
			const titlesToRead = [];
			const titleHashesToDelete = new Set();
			const txn = this.db.transaction('tiddlers', 'readwrite');
			for (const { thash, title, tiv, data, iv, mtime, deleted } of serverChanges) {
				if (arrayEq(b64dec(thash), this.storyListHash)) continue;
				const tid = {
					thash: b64dec(thash),
					title: b64dec(title),
					tiv: b64dec(tiv),
					data: b64dec(data),
					iv: b64dec(iv),
					mtime: new Date(mtime),
					deleted,
				};
				this.logger.log('remote change', thash);
				if (changedKeys.has(thash)) {
					const ourtid = await adb(txn.objectStore('tiddlers').get(tid.thash));
					this.logger.log('conflict:', thash, 'server:', tid.mtime, 'local:', ourtid.mtime);
					if (ourtid.mtime > tid.mtime) {
						continue;
					}
					// TODO: save the older tiddler under a special name and present conflict results
				}
				txn.objectStore('tiddlers').put(tid);
				if (deleted) {
					titleHashesToDelete.add(thash);
				} else {
					titlesToRead.push({ title: tid.title, iv: tid.tiv });
				}
				if (tid.mtime > newestChg) {
					newestChg = tid.mtime;
				}
			}
			for (const title of $tw.wiki.allTitles()) {
				if (titleHashesToDelete.has(await b64enc(await this.titlehash(title)))) {
					this.deletedQueue.add(title);
					this.changesChannel.postMessage({ title, del: true });
				}
			}
			for (const { title, iv } of titlesToRead) {
				const dectitle = utfdec.decode(
					await crypto.subtle.decrypt(
						{ name: 'AES-GCM', iv },
						this.key,
						title,
					),
				).trimStart();
				this.modifiedQueue.add(dectitle);
				this.changesChannel.postMessage({ title: dectitle });
			}
			if (appEtag && navigator.serviceWorker.controller) {
				const cache = await caches.open('tiddlypwa');
				for (const req of await cache.keys()) {
					if (!isCurrentUrl(req.url)) continue;
					const resp = await cache.match(req);
					const cachedEtag = resp.headers.get('etag');
					if (!cachedEtag || cachedEtag === appEtag) continue;
					navigator.serviceWorker.controller.postMessage({ op: 'update', url: req.url });
				}
			}
			this.logger.log('sync done', url);
			if (lastSync > newestChg) {
				newestChg = lastSync;
			}
			return newestChg;
		}

		async _syncManyUnlocked(all) {
			const servers = [];
			await new Promise((resolve) =>
				this.db.transaction('syncservers').objectStore('syncservers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve();
					}
					servers.push([cursor.key, cursor.value]);
					cursor.continue();
				}
			);
			for (const [key, server] of servers) {
				try {
					server.lastSync = await this._syncOneUnlocked(server, all);
					await adb(this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put(server, key));
				} catch (e) {
					if (e.name !== 'AbortError') {
						this.logger.alert(`Could not sync with server "${server.url}"!`, e);
					}
				}
			}
			$tw.syncer.syncFromServer(); // "server" being our local DB that we just updated, actually
			await this.reflectSyncServers();
			await this.reflectStorageInfo();
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncing', text: 'no' });
			this.isSyncing = false;
		}

		sync(all) {
			if (this.isSyncing) {
				return;
			}
			this.isSyncing = true;
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncing', text: 'yes' });
			if (!navigator.locks) {
				// welp, using multiple tabs without Web Locks is dangerous, but we can only YOLO it in this case
				return this._syncManyUnlocked(all);
			}
			return navigator.locks.request(`tiddlypwa:${location.pathname}`, (_lck) => this._syncManyUnlocked(all));
		}

		backgroundSync() {
			if (!navigator.onLine) return;
			// debounced to handle multiple saves in quick succession
			clearTimeout(this.syncTimer);
			this.syncTimer = setTimeout(() => this.sync(false), 1000);
		}
	}

	exports.adaptorClass = PWAStorage;
})();
