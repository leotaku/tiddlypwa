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

	const utfenc = new TextEncoder('utf-8');
	const utfdec = new TextDecoder('utf-8');

	function titlehash(x) {
		return crypto.subtle.digest('SHA-256', utfenc.encode(x));
	}

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

	class PWAStorage {
		constructor(options) {
			this.wiki = options.wiki;

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
				this.db.transaction('session', 'readwrite').objectStore('session').put({ key: this.key }).onsuccess = (
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
			if (!this.key) {
				const ses = await adb(this.db.transaction('session').objectStore('session').getAll());
				if (ses.length > 0) {
					this.key = ses[ses.length - 1].key;
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
						.then((titles) => cb(null, titles.filter((x) => !!x).map((t) => ({ title: utfdec.decode(t) }))))
						.catch((e) => cb(e));
				}
				const { title, tiv, deleted } = cursor.value;
				tiddlers.push({ title, tiv, deleted });
				cursor.continue();
			};
		}

		async _saveTiddler(tiddler) {
			const thash = await titlehash(tiddler.fields.title);
			const rawdata = utfenc.encode(this.wiki.getTiddlerAsJson(tiddler.fields.title));
			const dhash = await crypto.subtle.digest('SHA-256', rawdata);
			const iv = await crypto.getRandomValues(new Uint8Array(16));
			const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, rawdata);
			const tiv = await crypto.getRandomValues(new Uint8Array(16));
			const title = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: tiv },
				this.key,
				utfenc.encode(tiddler.fields.title),
			);
			await adb(
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').put({
					thash, // The title hash is the primary key
					title, // Just-the-title encrypted: used to avoid decrypting other stuff in getSkinnyTiddlers
					tiv,
					dhash, // The data hash will be used for sync conflict resolution
					data,
					iv,
					mtime: tiddler.fields.modified, // Has to be unencrypted for sync conflict resolution
				}),
			);
		}

		saveTiddler(tiddler, cb) {
			this._saveTiddler(tiddler).then((_) => cb(null, '', 1)).catch((e) => cb(e));
		}

		async _loadTiddler(title) {
			const thash = await titlehash(title);
			const obj = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').get(thash));
			const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: obj.iv }, this.key, obj.data);
			return JSON.parse(utfdec.decode(data));
		}

		loadTiddler(title, cb) {
			this._loadTiddler(title).then((x) => cb(null, x)).catch((e) => cb(e));
		}

		async _deleteTiddler(title) {
			const thash = await titlehash(title);
			await adb(
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').put({
					thash,
					deleted: true,
					mtime: new Date(),
				}),
			);
		}

		deleteTiddler(title, cb, _options) {
			this._deleteTiddler(title).then((_) => cb(null)).catch((e) => cb(e));
		}
	}

	exports.adaptorClass = PWAStorage;
})();
