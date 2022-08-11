/*\
title: $:/plugins/valpackett/tiddlypwa/main.js
type: application/javascript
module-type: syncadaptor

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	if (!$tw.browser || location.protocol === 'file:' || document.documentElement.hasAttribute('tiddlypwa-install')) {
		return;
	}
	if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
		alert('Warning! TiddlyPWA must be served over HTTPS.');
	}

	const knownErrors = {
		EPROTO: 'Protocol incompatibility',
		ETIME: 'The time is too different between the server and the device',
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

	class PWAStorage {
		constructor(options) {
			this.wiki = options.wiki;
			this.logger = new $tw.utils.Logger('tiddlypwa-storage');
			this.modifiedQueue = new Set();
			this.deletedQueue = new Set();
			this.changesChannel = new BroadcastChannel('changed-tiddlers');
			this.changesChannel.onmessage = (evt) => {
				if (evt.data.del) {
					this.deletedQueue.add(evt.data.title);
				} else {
					this.modifiedQueue.add(evt.data.title);
				}
				$tw.syncer.syncFromServer(); // "server" being our local DB
			};

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: navigator.onLine ? 'yes' : 'no' });
			window.addEventListener(
				'offline',
				(_evt) => this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'no' }),
			);
			window.addEventListener(
				'online',
				(_evt) => this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'yes' }),
			);

			$tw.rootWidget.addEventListener('tiddlypwa-init', (_evt) => {
				const req = indexedDB.open(`tiddlypwa:${location.pathname}`, 1);
				req.onupgradeneeded = (evt) => this.initDb(evt.target.result);
				adb(req).then((_) => location.href = location.href);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-remember', (_evt) => {
				this.db.transaction('session', 'readwrite').objectStore('session').put({ key: this.key, mackey: this.mackey })
					.onsuccess = (
						_evt,
					) => {
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: 'yes' });
						$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-remembered');
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
			});

			$tw.rootWidget.addEventListener('tiddlypwa-enable-persistence', (_evt) => {
				navigator.storage.persist().then(() => this.reflectStorageInfo());
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
				).then((_e) => this.reflectSyncServers()).catch((e) => {
					this.logger.alert('Failed to save the sync server!', e);
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-delete-sync-server', (evt) => {
				const key = evt && evt.paramObject && evt.paramObject.key;
				adb(
					this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').delete(parseInt(key)),
				).then((_e) => this.reflectSyncServers()).catch((e) => {
					this.logger.alert('Failed to delete the sync server!', e);
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync-all', (_evt) => {
				this.sync(true);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync', (_evt) => {
				this.sync(false);
			});
		}

		reflectSyncServers() {
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
						lastSync: lastSync.getTime() === 0 ? 'never' : lastSync.toLocaleString(),
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
			const titlesToRead = [];
			await new Promise((resolve) => {
				this.db.transaction('tiddlers').objectStore('tiddlers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve(true);
					}
					const { title, tiv, deleted } = cursor.value;
					titlesToRead.push({ title, tiv, deleted });
					cursor.continue();
				};
			});
			if (titlesToRead.length === 0) {
				$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-newwiki');
				$tw.wiki.addToStory('$:/ControlPanel');
				return true;
			}
			for (const { title, tiv, deleted } of titlesToRead) {
				try {
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
			return true;
		}

		initDb(db) {
			db.createObjectStore('session', { autoIncrement: true });
			db.createObjectStore('syncservers', { autoIncrement: true });
			db.createObjectStore('tiddlers', { keyPath: 'thash' });
		}

		async _getStatus() {
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
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWADemoMode', text: 'yes' });
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
						{ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: utfenc.encode('tiddlytiddlers') },
						pwdk,
						{ name: 'AES-GCM', length: 256 },
						false,
						['encrypt', 'decrypt'],
					);
					this.mackey = await crypto.subtle.deriveKey(
						{ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: utfenc.encode('tiddlyhmac') },
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
			this.storyListHash = await this.titlehash('$:/StoryList');
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
			const rawdata = utfenc.encode('\n'.repeat(512 - (jsondata.length % 512)) + jsondata);
			const dhash = await crypto.subtle.sign('HMAC', this.mackey, rawdata);
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
					dhash, // The data hash will be used for sync conflict resolution
					data,
					iv,
					mtime: tiddler.fields.modified || new Date(), // Has to be unencrypted for sync conflict resolution
				}),
			);
			await this.reflectStorageInfo();
		}

		saveTiddler(tiddler, cb) {
			if (tiddler.fields.title === '$:/StoryList' && !this.loadedStoryList) {
				// Avoid saving the pre-DB-open StoryList!
				return cb(null, '', 1);
			}
			this._saveTiddler(tiddler).then((_) => {
				const now = new Date();
				cb(null, '', 1);
				this.changesChannel.postMessage({ title: tiddler.fields.title });
				this.backgroundSync(now);
			}).catch((e) => cb(e));
		}

		async _loadTiddler(title) {
			if (title === '$:/StoryList') this.loadedStoryList = true;
			const thash = await this.titlehash(title);
			const obj = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').get(thash));
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
			}).catch((e) => cb(e));
		}

		async _deleteTiddler(title) {
			const thash = await this.titlehash(title);
			await adb(
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').put({
					thash,
					deleted: true,
					mtime: new Date(),
				}),
			);
			await this.reflectStorageInfo();
		}

		deleteTiddler(title, cb, _options) {
			this._deleteTiddler(title).then((_) => {
				const now = new Date();
				cb(null);
				this.changesChannel.postMessage({ title, del: true });
				this.backgroundSync(now);
			}).catch((e) => cb(e));
		}

		async _sync({ url, token, lastSync }, all = false, now = new Date()) {
			this.logger.log('sync started', url, lastSync, all, now);
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
			for (const { thash, title, tiv, dhash, data, iv, mtime, deleted } of changes) {
				if (arrayEq(thash, this.storyListHash)) continue;
				const tidjson = {
					thash: await b64enc(thash),
					title: await b64enc(title),
					tiv: await b64enc(tiv),
					dhash: await b64enc(dhash),
					data: await b64enc(data),
					iv: await b64enc(iv),
					mtime,
					deleted,
				};
				clientChanges.push(tidjson);
				changedKeys.add(tidjson.thash);
				this.logger.log('local change', tidjson.thash);
			}
			const resp = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ tiddlypwa: 1, op: 'sync', token, now, lastSync, clientChanges }),
			});
			if (!resp.ok) {
				try {
					const { error } = await resp.json();
					throw new Error(knownErrors[error] || error);
				} catch (_e) {
					throw new Error('Server returned error ' + resp.status);
				}
			}
			const { serverChanges } = await resp.json();
			const titlesToRead = [];
			const titleHashesToDelete = new Set();
			const txn = this.db.transaction('tiddlers', 'readwrite');
			for (const { thash, title, tiv, dhash, data, iv, mtime, deleted } of serverChanges) {
				if (arrayEq(b64dec(thash), this.storyListHash)) continue;
				const tid = {
					thash: b64dec(thash),
					title: b64dec(title),
					tiv: b64dec(tiv),
					dhash: b64dec(dhash),
					data: b64dec(data),
					iv: b64dec(iv),
					mtime: new Date(mtime),
					deleted,
				};
				this.logger.log('remote change', thash);
				if (changedKeys.has(thash)) {
					const ourtid = txn.objectStore('tiddlers').get(tid.thash);
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
			}
			for (const title of $tw.wiki.allTitles()) {
				if (titleHashesToDelete.has(await b64enc(await this.titlehash(title)))) {
					this.deletedQueue.add(title);
				}
			}
			for (const { title, iv } of titlesToRead) {
				const dectitle = await crypto.subtle.decrypt(
					{ name: 'AES-GCM', iv },
					this.key,
					title,
				);
				this.modifiedQueue.add(utfdec.decode(dectitle).trimStart());
			}
			this.logger.log('sync done', now);
			return now;
		}

		async sync(all, now) {
			if (this.isSyncing) {
				return;
			}
			this.isSyncing = true;
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncing', text: 'yes' });
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
					server.lastSync = await this._sync(server, all, now);
					await adb(this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put(server, key));
				} catch (e) {
					this.logger.alert(`Could not sync with server "${server.url}"!`, e);
				}
			}
			$tw.syncer.syncFromServer(); // "server" being our local DB that we just updated, actually
			await this.reflectSyncServers();
			await this.reflectStorageInfo();
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncing', text: 'no' });
			this.isSyncing = false;
		}

		backgroundSync(now) {
			if (!navigator.onLine) return;
			// debounced to handle multiple saves in quick succession
			clearTimeout(this.syncTimer);
			this.syncTimer = setTimeout(() => this.sync(false, now), 1000);
		}
	}

	exports.adaptorClass = PWAStorage;
})();
