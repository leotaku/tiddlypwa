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

	class PWAStorage {
		constructor(options) {
			this.wiki = options.wiki;
			this.logger = new $tw.utils.Logger('tiddlypwa-storage');

			// XXX: awful workaround for TW not refreshing the 'home' after the syncadaptor first loads $:/DefaultTiddlers
			// (why is the timeout necessary?! without timeout we get a brief flash of the correct 'home' and then back to the file one o_0)
			if (location.hash.length < 2) {
				let didHome = false;
				this.wiki.addEventListener('change', (chg) => {
					if (
						!didHome && this.isReady() && '$:/DefaultTiddlers' in chg && this.wiki.getTiddlerText('$:/DefaultTiddlers')
					) {
						setTimeout(() => $tw.rootWidget.dispatchEvent({ type: 'tm-home' }), 100);
						didHome = true;
					}
				});
			}

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
					this.logger.log(e);
					alert('Failed to save the sync server!');
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-delete-sync-server', (evt) => {
				const key = evt && evt.paramObject && evt.paramObject.key;
				adb(
					this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').delete(parseInt(key)),
				).then((_e) => this.reflectSyncServers()).catch((e) => {
					this.logger.log(e);
					alert('Failed to delete the sync server!');
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync', (_evt) => {
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

		isReady() {
			return !!(this.db && this.key);
		}

		async _getStatus() {
			if (!this.db) {
				const req = indexedDB.open(`tiddlypwa:${location.pathname}`, 1);
				req.onupgradeneeded = (evt) => {
					const db = evt.target.result;
					db.createObjectStore('session', { autoIncrement: true });
					db.createObjectStore('syncservers', { autoIncrement: true });
					db.createObjectStore('tiddlers', { keyPath: 'thash' });
				};
				this.db = await adb(req);
			}
			await this.reflectSyncServers();
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
					const cursor = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').openCursor());
					if (cursor) {
						try {
							await crypto.subtle.decrypt({ name: 'AES-GCM', iv: cursor.value.tiv }, this.key, cursor.value.title);
						} catch (_e) {
							checked = false;
							$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-badpass');
							continue;
						}
						$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-opened');
					} else {
						$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-newwiki');
						$tw.wiki.addToStory('$:/ControlPanel');
					}
					checked = true;
				}
				document.body.removeChild(backdrop);
			}
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

		getSkinnyTiddlers(cb) {
			const tiddlers = [];
			this.db.transaction('tiddlers').objectStore('tiddlers').openCursor().onsuccess = (evt) => {
				const cursor = evt.target.result;
				if (!cursor) {
					return Promise.all(
						tiddlers.map(({ title, tiv, deleted }) =>
							!deleted && title && crypto.subtle.decrypt({ name: 'AES-GCM', iv: tiv }, this.key, title)
						),
					)
						.then((titles) => cb(null, titles.filter((x) => !!x).map((t) => ({ title: utfdec.decode(t).trimStart() }))))
						.catch((e) => cb(e));
				}
				const { title, tiv, deleted } = cursor.value;
				tiddlers.push({ title, tiv, deleted });
				cursor.continue();
			};
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
			const iv = await crypto.getRandomValues(new Uint8Array(12));
			const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, rawdata);
			const tiv = await crypto.getRandomValues(new Uint8Array(12));
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
		}

		saveTiddler(tiddler, cb) {
			this._saveTiddler(tiddler).then((_) => {
				cb(null, '', 1);
				this.backgroundSync();
			}).catch((e) => cb(e));
		}

		async _loadTiddler(title) {
			const thash = await this.titlehash(title);
			const obj = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').get(thash));
			const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: obj.iv }, this.key, obj.data);
			return JSON.parse(utfdec.decode(data).trimStart());
		}

		loadTiddler(title, cb) {
			this._loadTiddler(title).then((x) => cb(null, x)).catch((e) => cb(e));
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
		}

		deleteTiddler(title, cb, _options) {
			this._deleteTiddler(title).then((_) => {
				cb(null);
				this.backgroundSync();
			}).catch((e) => cb(e));
		}

		async _sync({ url, token, lastSync }) {
			const now = new Date();
			this.logger.log('sync started', url, lastSync, now);
			const changes = [];
			await new Promise((resolve) =>
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve();
					}
					if (cursor.value.mtime > lastSync) {
						changes.push(cursor.value);
					}
					cursor.continue();
				}
			);
			const clientChanges = [];
			const changedKeys = new Set();
			for (const { thash, title, tiv, dhash, data, iv, mtime, deleted } of changes) {
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
				body: JSON.stringify({ tiddlypwa: 1, token, now, lastSync, clientChanges }),
			});
			if (!resp.ok) {
				try {
					const { error } = await resp.json();
					throw new Exception(knownErrors[error] || error);
				} catch (_e) {
					throw new Exception('Server returned error ' + resp.status);
				}
			}
			const { serverChanges } = await resp.json();
			const txn = this.db.transaction('tiddlers', 'readwrite');
			for (const { thash, title, tiv, dhash, data, iv, mtime, deleted } of serverChanges) {
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
					this.logger.log('conflict', thash);
					// TODO: pick newer between the two, save older under special name, present results
				}
				txn.objectStore('tiddlers').put(tid);
			}
			this.logger.log('sync done', now);
			return now;
		}

		async sync() {
			if (this.isSyncing) {
				return;
			}
			this.isSyncing = true;
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
					server.lastSync = await this._sync(server);
					await adb(this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put(server, key));
				} catch (e) {
					this.logger.log('sync error', server.url, e);
				}
			}
			$tw.syncer.syncFromServer(); // "server" being our local DB that we just updated, actually
			await this.reflectSyncServers();
			this.isSyncing = false;
		}

		backgroundSync() {
			// debounced to handle multiple saves in quick succession
			clearTimeout(this.syncTimer);
			this.syncTimer = setTimeout(() => this.sync(), 1000);
		}
	}

	exports.adaptorClass = PWAStorage;
})();
