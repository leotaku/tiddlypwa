/*\
title: $:/plugins/valpackett/tiddlypwa/main.js
type: application/javascript
module-type: syncadaptor

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
// deno-lint-ignore-file no-window-prefix
(function () {
	'use strict';

	if (!$tw.browser) return;

	// Do this early to make it work on login screen too
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.onmessage = (evt) => {
			if (evt.data.op == 'refresh') {
				$tw.wiki.addTiddler({ title: '$:/status/TiddlyPWAUpdateAvailable', text: 'yes' });
			}
		};
	}

	// Patch this to make upgrading core by drag&drop reflect the version number in generated html
	$tw.utils.extractVersionInfo = () => $tw.wiki.getTiddler('$:/core').fields.version;
	Object.defineProperty($tw, 'version', { get: $tw.utils.extractVersionInfo });

	// Patch this to direct all plugins into the app wiki saving process
	// (It gets called on a lot of junk that's not plugin info, so just detect actual plugins)
	$tw.wiki.doesPluginInfoRequireReload = (x) => typeof x === 'object' && 'tiddlers' in x;

	// As of mid 2023 only Firefox has this natively
	if (typeof ReadableStream === 'function' && !ReadableStream.prototype[Symbol.asyncIterator]) {
		ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
			const reader = this.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) return;
					yield value;
				}
			} finally {
				reader.releaseLock();
			}
		};
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
		return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	}

	async function encodeTiddler(tiddler, isBin) {
		const padTo = 256;
		let flags = 0, gzchunks, gzlen = 0, binstr;
		const jsonstr = JSON.stringify(
			Object.keys(tiddler.fields).reduce((o, k) => {
				if (k === 'text' && isBin) return o;
				o[k] = tiddler.getFieldString(k);
				return o;
			}, Object.create(null)),
		);
		if (isBin) {
			flags |= 1;
			binstr = atob(tiddler.fields.text);
		}
		if (jsonstr.length > 240) {
			flags |= 1 << 1;
			gzchunks = [];
			const rdr = new Blob([jsonstr]).stream().pipeThrough(new CompressionStream('gzip'));
			for await (const chunk of rdr) {
				gzchunks.push(chunk);
				gzlen += chunk.length;
			}
		}

		const resbuflen = 5 + (gzchunks ? gzlen : 3 * jsonstr.length) + (binstr ? 4 + binstr.length : 0);
		const result = new Uint8Array(resbuflen + (padTo - (resbuflen % padTo)));
		let bodylen;
		if (gzchunks) {
			let ptr = 5;
			for (const chunk of gzchunks) {
				result.set(chunk, ptr);
				ptr += chunk.length;
			}
			bodylen = gzlen;
		} else {
			bodylen = utfenc.encodeInto(jsonstr, result.subarray(5, 5 + 3 * jsonstr.length)).written;
		}
		const dw = new DataView(result.buffer);
		dw.setUint8(0, flags);
		dw.setUint32(1, bodylen);
		if (binstr) {
			dw.setUint32(5 + bodylen, binstr.length);
			for (let i = 0; i < binstr.length; i++) result[5 + bodylen + 4 + i] = binstr.charCodeAt(i);
		}
		const reslen = 5 + bodylen + (binstr ? 4 + binstr.length : 0);
		return result.subarray(0, reslen + (padTo - (reslen % padTo)));
	}

	async function decodeTiddler(bin) {
		const dw = new DataView(bin);
		const flags = dw.getUint8(0);
		const isBin = flags & 1;
		const isGzipped = flags & (1 << 1);
		const bodylen = dw.getUint32(1);
		const body = new Uint8Array(bin, 5, bodylen);
		let tiddler;
		if (isGzipped) {
			let json = '';
			const rdr = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
			for await (const chunk of rdr) json += utfdec.decode(chunk);
			tiddler = JSON.parse(json);
		} else {
			tiddler = JSON.parse(utfdec.decode(body));
		}
		if (isBin) {
			tiddler.text = await b64enc(new Uint8Array(bin, 5 + bodylen + 4, dw.getUint32(5 + bodylen)));
		}
		return tiddler;
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
				this.logger.log('Change from another tab');
				if (evt.data.del) {
					this.deletedQueue.add(evt.data.title);
				} else {
					this.modifiedQueue.add(evt.data.title);
				}
				$tw.syncer.syncFromServer(); // "server" being our local DB
				clearTimeout(this.tabChangesReflTimer);
				this.tabChangesReflTimer = setTimeout(() => {
					this.reflectSyncServers();
					this.reflectStorageInfo();
				}, 2000);
			};
			this.serversChannel = new BroadcastChannel(`tiddlypwa-servers:${location.pathname}`);
			this.serversChannel.onmessage = (_evt) => {
				this.reflectSyncServers();
			};
			this.sessionChannel = new BroadcastChannel(`tiddlypwa-session:${location.pathname}`);
			this.sessionChannel.onmessage = (evt) => {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: evt.data ? 'yes' : 'no' });
			};

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOrigin', text: location.origin });

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: navigator.onLine ? 'yes' : 'no' });
			window.addEventListener(
				'offline',
				(_evt) => this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'no' }),
			);
			window.addEventListener(
				'online',
				(_evt) => {
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'yes' });
					if (this.db) {
						this.backgroundSync();
						this.startRealtimeMonitor();
					}
				},
			);

			document.addEventListener('visibilitychange', (_evt) => {
				if (document.visibilityState === 'visible') this.backgroundSync();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-remember', (_evt) => {
				if (!confirm('Are you sure you want to remember the password?')) {
					return;
				}
				this.db.transaction('session', 'readwrite').objectStore('session').put({
					enckeys: this.enckeys,
					mackey: this.mackey,
				})
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
				const url = evt?.paramObject?.url;
				const token = evt?.paramObject?.token;
				if (!url || !token) {
					alert('A sync server must have a URL and a token!');
					return;
				}
				try {
					new URL(url, document.location);
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
				const key = evt?.paramObject?.key;
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
				location.reload(); // tm-browser-refresh passes 'true' which skips the serviceworker. silly!
			});

			$tw.rootWidget.addEventListener('tiddlypwa-browser-refresh-force', (_evt) => {
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

		missingFeaturesWarning() {
			const crit = [
				!isSecureContext &&
				'The app is not loaded from a secure context (HTTPS)! Cannot continue due to unavailable features. Please use a secure server.',
				typeof WebAssembly !== 'object' && 'WebAssembly is unavailable, we cannot unlock the wiki without it.',
				typeof indexedDB !== 'object' &&
				'IndexedDB is unavailable, we cannot even store anything here.',
				typeof DecompressionStream !== 'function' &&
				'Compression Streams are unavailable, we cannot unlock the wiki without that. Please upgrade your browser.',
				!this.db && 'Could not create a database. Are you in private browsing mode? TiddlyPWA does not work there.',
			].filter((x) => !!x);
			// Don't really have tests for non-critical features right now as Compression Streams are already a huge support bound
			return [crit.length > 0, crit.map((x) => `<p class=tiddlypwa-form-error>${x}</p>`).join('\n')];
		}

		async initServiceWorker() {
			try {
				const reg = await navigator.serviceWorker.register('sw.js');
				await reg.update();
			} catch (e) {
				if (!navigator.onLine) return;
				$tw.wiki.addTiddler({ title: '$:/status/TiddlyPWAWorkerError', text: e.message });
				$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-sw-error');
			}
		}

		async _startRealtimeMonitor() {
			const servers = await adb(
				this.db.transaction('syncservers').objectStore('syncservers').getAll(),
			);
			if (servers.length === 0) {
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARealtime',
					text: `no sync servers`,
				});
				return;
			}
			const server = servers[~~(Math.random() * servers.length)];
			const url = new URL(server.url, document.location);
			const bareUrl = url;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWARealtime',
				text: `connecting to ${bareUrl}`,
			});
			url.searchParams.set('op', 'monitor');
			url.searchParams.set('token', server.token);
			url.searchParams.set('browserToken', this.browserToken);
			this.monitorStream = new EventSource(url.href);
			this.monitorStream.onopen = (_e) => {
				this.monitorTimeout = 2000;
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARealtime',
					text: `connected to ${bareUrl}`,
				});
			};
			this.monitorStream.addEventListener('sync', (_evt) => this.backgroundSync());
			await new Promise((resolve) => {
				this.monitorStream.onerror = resolve;
			});
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWARealtime',
				text: `disconnected from ${url}`,
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
			this.monitorTimer = setTimeout(() => {
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARealtime',
					text: `possibly another tab is currently responsible for the connection`,
				});
				navigator.locks.request(
					`tiddlypwa-realtime:${location.pathname}`,
					(_lck) => this._startRealtimeMonitor(),
				);
			}, this.monitorTimeout);
		}

		async reflectSyncServers() {
			this.startRealtimeMonitor();
			for (const tidname of this.wiki.getTiddlersWithTag('$:/temp/TiddlyPWAServer')) {
				this.wiki.deleteTiddler(tidname);
			}
			let cnt = 0;
			await new Promise((resolve) =>
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
					cnt++;
					cursor.continue();
				}
			);
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAServerCount', text: cnt.toString() });
		}

		async reflectStorageInfo() {
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAStoragePersisted',
				text: (navigator.storage?.persist) ? (await navigator.storage.persisted() ? 'yes' : 'no') : 'unavail',
			});
			const formatEstimate = ({ usage, quota }) =>
				`${formatBytes(usage)} of ${formatBytes(quota)} (${(usage / quota * 100).toFixed(2)}%)`;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAStorageQuota',
				text: (navigator.storage?.estimate) ? formatEstimate(await navigator.storage.estimate()) : 'unavail',
			});
		}

		isReady() {
			return !!(this.db && this.enckeys);
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
				this.loadedStoryList = true; // not truly "loaded" but as in "enable saving it to the DB"
				return true;
			}
			let hasStoryList = false, hasDefaultTiddlers = false;
			for (const { thash, title, tiv, deleted } of titlesToRead) {
				try {
					if (arrayEq(thash, this.storyListHash)) hasStoryList = true;
					if (deleted) continue;
					const dectitle = utfdec.decode(
						await crypto.subtle.decrypt(
							{ name: 'AES-GCM', iv: tiv },
							this.enckey(thash),
							title,
						),
					).trimStart();
					if (dectitle === '$:/DefaultTiddlers') hasDefaultTiddlers = true;
					this.modifiedQueue.add(dectitle);
				} catch (e) {
					this.logger.log('Title decrypt failed:', e);
					return false;
				}
			}
			// consider these "loaded" if they did not exist in order to enable saving / let startup-opening proceed
			if (!hasStoryList) this.loadedStoryList = true;
			if (!hasDefaultTiddlers) this.loadedDefaultTiddlers = true;
			this.backgroundSync();
			setTimeout(() => {
				try {
					$tw.__update_tiddlypwa_manifest__();
				} catch (e) {
					console.error(e);
				}
			}, 300);
			return true;
		}

		initDb(db) {
			db.createObjectStore('metadata', { autoIncrement: true });
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
					this.initDb(evt.target.result);
				};
				try {
					this.db = await adb(req);
				} catch (e) {
					console.error(e);
				}
			}
			const freshDb = !this.db ||
				await new Promise((resolve) =>
					this.db.transaction('tiddlers').objectStore('tiddlers').openCursor().onsuccess = (evt) =>
						resolve(!evt.target.result)
				);
			if (this.db && !this.salt) {
				const meta = await adb(this.db.transaction('metadata').objectStore('metadata').getAll());
				if (meta.length > 0) {
					this.salt = meta[meta.length - 1].salt;
				}
			}
			if (this.db && !this.enckeys) {
				const ses = await adb(this.db.transaction('session').objectStore('session').getAll());
				if (ses.length > 0) {
					this.enckeys = ses[ses.length - 1].enckeys;
					this.mackey = ses[ses.length - 1].mackey;
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: ses.length > 0 ? 'yes' : 'no' });
			}
			if (!this.enckeys) {
				let bootstrapEndpoint;
				$tw.utils.addClass($tw.pageContainer, 'tc-modal-displayed');
				$tw.utils.addClass(document.body, 'tc-modal-prevent-scroll');
				const [weAreScrewed, missingWarning] = this.missingFeaturesWarning();
				const dm = $tw.utils.domMaker;
				// below alerts, above hide-sidebar-btn
				const wrapper = dm('div', { class: 'tc-modal-wrapper', style: { 'z-index': 1500 } });
				wrapper.appendChild(dm('div', { class: 'tc-modal-backdrop', style: { opacity: '0.9' } }));
				const modal = dm('div', { class: 'tc-modal' });
				modal.appendChild(dm('div', { class: 'tc-modal-header', innerHTML: '<h3>Welcome to TiddlyPWA</h3>' }));
				const body = dm('div', { class: 'tc-modal-body' });
				const form = dm('form', { class: 'tiddlypwa-form' });
				const passLbl = dm('label', { innerHTML: 'Password' });
				const passInput = dm('input', { attributes: { type: 'password' } });
				passLbl.appendChild(passInput);
				const submit = dm('button', { attributes: { type: 'submit' }, text: 'Log in' });
				const feedback = dm('div', { innerHTML: missingWarning });
				modal.appendChild(body);
				document.body.appendChild(wrapper);
				let opened = false;
				let timeoutModal;
				const showForm = () => {
					if (!weAreScrewed) {
						form.appendChild(passLbl);
						form.appendChild(submit);
					}
					form.appendChild(feedback);
					body.appendChild(form);
				};
				const openModal = () => {
					if (opened) return;
					opened = true;
					wrapper.appendChild(modal);
					clearTimeout(timeoutModal);
					modal.querySelector('input')?.focus();
				};
				const closeModal = () => {
					document.body.removeChild(wrapper);
					$tw.utils.removeClass($tw.pageContainer, 'tc-modal-displayed');
					$tw.utils.removeClass(document.body, 'tc-modal-prevent-scroll');
					clearTimeout(timeoutModal);
				};
				if (freshDb) {
					body.innerHTML =
						'<p>No wiki data found in the browser storage for this URL. Wait a second, looking around the server..</p>';
					const giveUp = new AbortController();
					const timeoutGiveUpBtn = setTimeout(() =>
						body.appendChild(dm('button', {
							text: 'Give up waiting',
							attributes: {
								type: 'button',
							},
							eventListeners: [{
								name: 'click',
								handlerFunction: () => giveUp.abort(),
							}],
						})), 6900);
					timeoutModal = setTimeout(openModal, 1000);
					try {
						const resp = await fetch('bootstrap.json', {
							signal: giveUp.signal,
							cache: 'no-store',
						});
						const { state, endpoint, salt } = await resp.json();
						if (
							(endpoint && typeof endpoint !== 'string') || (state && typeof state !== 'string') ||
							(salt && typeof salt !== 'string')
						) {
							alert('Something is weird with the server! Unexpected types in bootstrap.json');
						}
						bootstrapEndpoint = endpoint && { url: endpoint };
						clearTimeout(timeoutGiveUpBtn);
						let askToken = true, askSalt = true;
						if (state === 'docs') {
							closeModal();
							if (this.db) {
								this.db.close();
								await adb(indexedDB.deleteDatabase(`tiddlypwa:${location.pathname}`));
							}
							this.db = undefined;
							$tw.syncer.isDirty = () => false; // skip the onbeforeunload
							this.wiki.addTiddler({ title: '$:/status/TiddlyPWADocsMode', text: 'yes' });
							return;
						}
						if (weAreScrewed) {
							body.innerHTML = '<p>Oops…</p>';
							showForm();
							return;
						}
						if (state === 'localonly') {
							body.innerHTML = '<p>Welcome to your new local-only wiki!</p>';
							body.innerHTML +=
								'<p>This wiki is not hosted on a sync server and will not automatically start to synchronize your data. However, you can always add sync servers later in the settings!</p>';
							body.innerHTML += '<p><strong>Make up a strong password</strong> to protect the content of the wiki.</p>';
							askToken = false;
						} else if (state === 'fresh') {
							body.innerHTML = '<p>Welcome to your new synchronized wiki!</p>';
							body.innerHTML +=
								`<p>Paste the token given to you by the administrator of the sync server <code>${endpoint}</code> and <strong>make up a strong password</strong>.</p>`;
							body.innerHTML +=
								'<p>The password will be used to encrypt your data, hiding the content from the server and, if you choose not to use the "remember password" option, against unauthorized users of this device.</p>';
							body.innerHTML +=
								'<p>You will have to use that password to open this wiki on all synchronized devices/browsers.</p>';
						} else if (state === 'existing') {
							body.innerHTML = '<p>Welcome back to your synchronized wiki!</p>';
							body.innerHTML +=
								`<p>Log in using your credentials below. You are using the sync server <code>${endpoint}</code>.</p>`;
							askSalt = false;
							this.salt = b64dec(salt);
						} else {
							body.innerHTML = '<p>We are not quite sure what happened on the sync server...</p>';
							body.innerHTML += `<p>Try to log in using your credentials below anyway?</p>`;
						}
						if (askToken) {
							if (!bootstrapEndpoint) {
								alert(`This sync server is misconfigured: no endpoint found while state is '${state}'.`);
							}
							const tokLbl = dm('label', { text: 'Sync token' });
							tokLbl.appendChild(dm('input', {
								attributes: { type: 'password' },
								eventListeners: [{
									name: 'change',
									handlerFunction: (e) => bootstrapEndpoint.token = e.target.value.trim(),
								}],
							}));
							form.appendChild(tokLbl);
						}
						if (askSalt) {
							const saltDtl = dm('details', {
								innerHTML: `
								<summary>If you are going to sync a pre-existing wiki into this one, click here</summary>
								<p>In order for such a sync to succeed, the wiki needs to be initialized with the same "salt" as well as the same password.</p>
								<p>Copy the salt from the <strong>Settings</strong> → <strong>Storage and Sync</strong> page on the existing wiki, or from the sync admin interface.</p>
							`,
							});
							const saltLbl = dm('label', { text: 'Salt' });
							saltLbl.appendChild(dm('input', {
								attributes: { type: 'text' },
								eventListeners: [{
									name: 'change',
									handlerFunction: (e) => {
										try {
											this.salt = b64dec(e.target.value.trim());
											feedback.innerHTML = '';
										} catch (_e) {
											feedback.innerHTML = '<p class=tiddlypwa-form-error>Could not decode the salt</p>';
										}
									},
								}],
							}));
							saltDtl.appendChild(saltLbl);
							form.appendChild(saltDtl);
						}
						showForm();
						openModal();
					} catch (e) {
						console.error(e);
						clearTimeout(timeoutGiveUpBtn);
						body.innerHTML = '<p>Oops, looks like there is no information about the current server to be found!</p>';
						body.innerHTML += '<p>Oh well, synchronization can be set up later in the settings.</p>';
						showForm();
						openModal();
					}
				} else {
					body.innerHTML = '<p>Welcome back! Please enter your password.</p>';
					showForm();
					openModal();
				}
				const AW = require('$:/plugins/valpackett/tiddlypwa/argon2ian.js').ArgonWorker;
				const argon = new AW();
				let checked = false;
				while (!checked) {
					submit.disabled = false;
					await new Promise((resolve, _reject) => {
						form.onsubmit = (e) => {
							e.preventDefault();
							submit.disabled = true;
							feedback.innerHTML = '<p>Please wait…</p>';
							resolve();
						};
					});
					if (!this.salt) this.salt = crypto.getRandomValues(new Uint8Array(32));
					console.time('hash');
					const basebits = await argon.hash(utfenc.encode(passInput.value), this.salt, { m: 1 << 17, t: 2 });
					console.timeLog('hash');
					const basekey = await crypto.subtle.importKey('raw', basebits, 'HKDF', false, ['deriveKey']);
					// fun: https://soatok.blog/2021/11/17/understanding-hkdf/ (but we don't have any randomness to shove into info)
					// not fun: https://soatok.blog/2020/12/24/cryptographic-wear-out-for-symmetric-encryption/
					// realistically 4 billion encryptions is already actually *a lot* for a notes app even with really heavy use lol
					// but by having just 8 keys we get to 34 billion which is Better
					this.enckeys = await Promise.all(
						[...Array(8).keys()].map((i) =>
							crypto.subtle.deriveKey(
								{
									name: 'HKDF',
									hash: 'SHA-256',
									salt: utfenc.encode('tiddly.pwa.tiddlers.' + i),
									info: new Uint8Array(),
								},
								basekey,
								{ name: 'AES-GCM', length: 256 },
								false,
								['encrypt', 'decrypt'],
							)
						),
					);
					this.mackey = await crypto.subtle.deriveKey(
						{ name: 'HKDF', hash: 'SHA-256', salt: utfenc.encode('tiddly.pwa.titles'), info: new Uint8Array() },
						basekey,
						{ name: 'HMAC', hash: 'SHA-256' },
						false,
						['sign'],
					);
					checked = await this.initialRead();
					if (!checked) {
						feedback.innerHTML += '<p class=tiddlypwa-form-error>Wrong password!</p>';
					}
				}
				argon.terminate();
				if (freshDb) {
					this.db.transaction('metadata', 'readwrite').objectStore('metadata').put({ salt: this.salt });
				}
				if (bootstrapEndpoint) {
					const { url, token } = bootstrapEndpoint;
					await adb(
						this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put({
							url,
							token,
							lastSync: new Date(0),
						}),
					);
					this.backgroundSync();
				}
				closeModal();
			} else {
				await this.initialRead();
			}
			await this.reflectSyncServers();
			await this.reflectStorageInfo();
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWASalt',
				text: await b64enc(this.salt),
			});
			this.initServiceWorker(); // don't await
			if (freshDb) navigator.storage.persist().then(() => this.reflectStorageInfo());
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
			this.logger.log('Reflecting updates to wiki runtime');
			this.modifiedQueue.clear();
			this.deletedQueue.clear();
			cb(null, chg);
		}

		titlehash(x) {
			// keyed (hmac) because sync servers don't need to be able to compare contents between different users
			return crypto.subtle.sign('HMAC', this.mackey, utfenc.encode(x));
		}

		enckey(thash) {
			return this.enckeys[new DataView(thash).getUint8(0) % this.enckeys.length];
		}

		async _saveTiddler(tiddler) {
			const thash = await this.titlehash(tiddler.fields.title);
			const key = this.enckey(thash);
			const encoded = await encodeTiddler(tiddler, this.wiki.isBinaryTiddler(tiddler.fields.title));
			// "if you use nonces longer than 12 bytes, they get hashed into 12 bytes anyway" - soatok.blog
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
			const tiv = crypto.getRandomValues(new Uint8Array(12));
			const title = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: tiv },
				key,
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
				this.logger.log(
					'Not saving $:/StoryList the first time (the one from before opening), it was:',
					tiddler.fields.list,
				);
				return cb(null, '', 1);
			}
			if (tiddler.fields.title === '$:/Import') {
				// For some reason this is not in the default $:/config/SyncFilter but no one would want this actually stored.
				return cb(null, '', 1);
			}
			if (tiddler.fields.type === 'application/json' && tiddler.fields['plugin-type']) {
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
			if (obj.deleted) return null;
			const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: obj.iv }, this.enckey(thash), obj.data);
			return await decodeTiddler(data);
		}

		loadTiddler(title, cb) {
			this._loadTiddler(title).then((tiddler) => {
				cb(null, tiddler);
				if (title === $tw.syncer.titleSyncFilter) {
					// XXX: syncer should itself monitor for changes and recompile
					$tw.syncer.filterFn = this.wiki.compileFilter(tiddler.text);
				}
				if (title === '$:/StoryList') this.loadedStoryList = true;
				if (title === '$:/DefaultTiddlers') this.loadedDefaultTiddlers = true;
				if (!this.openedDefaultTiddlers && this.loadedDefaultTiddlers && this.loadedStoryList) {
					this.openedDefaultTiddlers = true;
					// Old $:/DefaultTiddlers has been used, rerun (XXX: openStartupTiddlers should be exported)
					const aEL = $tw.rootWidget.addEventListener;
					$tw.rootWidget.addEventListener = () => {};
					require('$:/core/modules/startup/story.js').startup();
					$tw.rootWidget.addEventListener = aEL;
				}
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
			const swjs = $tw.wiki.renderTiddler('text/plain', '$:/plugins/valpackett/tiddlypwa/sw.js', {});
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
							authcode: this.mackey && await b64enc(await this.titlehash(token)),
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
					const href = new URL((await resp.json()).urlprefix + 'app.html', new URL(url, document.location)).href;
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
					salt: await b64enc(this.salt),
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
					titlesToRead.push({ title: tid.title, thash: tid.thash, iv: tid.tiv });
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
			for (const { title, thash, iv } of titlesToRead) {
				const dectitle = utfdec.decode(
					await crypto.subtle.decrypt(
						{ name: 'AES-GCM', iv },
						this.enckey(thash),
						title,
					),
				).trimStart();
				if (dectitle !== '$:/StoryList') {
					this.modifiedQueue.add(dectitle);
					this.changesChannel.postMessage({ title: dectitle });
				}
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
			return navigator.locks.request(`tiddlypwa:${location.pathname}`, (_lck) => this._syncManyUnlocked(all));
		}

		backgroundSync() {
			if (!navigator.onLine || !this.isReady()) return;
			// debounced to handle multiple saves in quick succession
			clearTimeout(this.syncTimer);
			this.syncTimer = setTimeout(() => this.sync(false), 1000);
		}
	}

	exports.adaptorClass = PWAStorage;
})();
