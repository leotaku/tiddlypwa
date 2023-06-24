import * as base64 from 'https://deno.land/std@0.192.0/encoding/base64url.ts';
import * as base64nourl from 'https://deno.land/std@0.192.0/encoding/base64.ts';
import * as dotenv from 'https://deno.land/std@0.192.0/dotenv/mod.ts';
import { parse as argparse } from 'https://deno.land/std@0.192.0/flags/mod.ts';
import { serveListener } from 'https://deno.land/std@0.192.0/http/server.ts';
import { ArgonWorker } from 'https://deno.land/x/argon2ian@1.0.5/src/async.ts';
import * as brotli from 'https://deno.land/x/brotli@0.1.7/mod.ts';
import * as blob from 'https://deno.land/x/kv_toolbox@0.0.2/blob.ts';

type Tiddler = {
	title: Uint8Array;
	tiv: Uint8Array;
	data: Uint8Array;
	iv: Uint8Array;
	mtime: Date;
	deleted: boolean;
};
const tiddlerKeyPrefix = (token: string) => ['t', token];
const tiddlerKey = (token: string, id: Uint8Array) => ['t', token, id];

type BlobMeta = {
	refs: Set<string>;
	size: number;
};
export const blobKey = (etag: Uint8Array) => ['b', etag];
export const blobMetaKey = (etag: Uint8Array) => ['bm', etag];

type AppFile = {
	etag: Uint8Array;
	sig: Uint8Array;
	size: number; // brotli compressed size
	rawsize: number;
	ctype: string;
};

type Wiki = {
	authcode: string;
	salt: string;
	files?: Map<string, AppFile>;
};
const ALL_WIKI_PREFIX = ['w'];
export const wikiKey = (token: string) => ['w', token.slice(0, token.length / 2), token.slice(token.length / 2)];
const wikiKeyHalf = (halftoken: string) => ['w', halftoken];
const tokenFromKey = (key: Deno.KvKey) => `${key[1]}${key[2]}`;

const html = String.raw; // just for tools/editors
const homePage = html`
	<!doctype html>
	<html lang=en>
		<head>
			<meta charset=utf-8>
			<title>TiddlyPWA Sync Server Control Panel</title>
			<style>
				* { box-sizing: border-box; }
				html { background: #252525; color: #fbfbfb; -webkit-text-size-adjust: none; text-size-adjust: none; accent-color: limegreen; }
				body { margin: 2rem auto; min-width: 300px; max-width: 99ch; line-height: 1.5; word-wrap: break-word; font-family: system-ui, sans-serif; }
				a { color: limegreen; }
				a:hover { color: lime; }
				h1 { font: 1.25rem monospace; text-align: center; color: limegreen; margin-bottom: 2rem; }
				h2 { font-size: 1.15rem; margin: 1rem 0; }
				fieldset { border: none; text-align: center; }
				thead { font-weight: bolder; background: rgba(0,240,0,.1); }
				footer { text-align: center; margin-top: 2rem; }
				table { border-collapse: collapse; margin: 1rem 0; }
				td { padding: 0.25rem 0.6rem; }
				tr:nth-child(even) { background: rgba(255,255,255,.08); }
				#wikirows td:first-of-type, #wikirows td:nth-of-type(2) { font-family: monospace; }
			</style>
		</head>
		<body>
			<h1>TiddlyPWA Sync Server Control Panel</h1>
			<noscript>Enable JavaScript!</noscript>
			<form id=login>
				<fieldset>
					<input type=password id=atoken>
					<button>Log in</button>
				</fieldset>
			</form>
			<div id=loggedin hidden>
				<h2>Wikis on the server:</h2>
				<table>
					<thead>
						<tr>
							<td>Token</td>
							<td>Salt</td>
							<td>App Files Size</td>
							<td></td>
						</tr>
					</thead>
					<tbody id=wikirows>
					</tbody>
				</table>
				<button id=refresh>Refresh</button>
				<button id=create>Create new wiki</button>
			</div>
			<footer>
				<a href=https://tiddly.packett.cool/>TiddlyPWA</a> sync server ✦ software by <a href=https://val.packett.cool/>Val Packett</a>
			</footer>
			<script>
				const knownErrors = {
					EAUTH: 'Wrong token',
				};
				function formatBytes(bytes) {
					const sizes = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
					const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
					if (i >= sizes.length) return 'too much';
					return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
				}
				async function serverReq(data) {
					const resp = await fetch('tid.dly', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tiddlypwa: 1,
							atoken: document.getElementById('atoken').value,
							...data,
						}),
					});
					if (!resp.ok) {
						alert(await resp.json().then(({ error }) => knownErrors[error] || error).catch((_e) =>
							'Server returned error ' + resp.status
						));
						return false;
					}
					return resp;
				}
				async function refreshTokens() {
					const resp = await serverReq({ op: 'list' });
					if (!resp) return false;
					const { wikis } = await resp.json();
					const wikirows = document.getElementById('wikirows')
					wikirows.replaceChildren();
					for (const { token, salt, appsize } of wikis) {
						const tr = document.createElement('tr');
						const tokenTd = document.createElement('td');
						tokenTd.innerText = token;
						tr.appendChild(tokenTd);
						const saltTd = document.createElement('td');
						saltTd.innerText = salt;
						tr.appendChild(saltTd);
						const appsizeTd = document.createElement('td');
						if (appsize > 0) {
							const appsizeA = document.createElement('a');
							appsizeA.href = '/' + token.slice(0, token.length / 2) + '/app.html';
							appsizeA.innerText = formatBytes(appsize);
							appsizeTd.appendChild(appsizeA);
						} else {
							appsizeTd.innerText = '-';
						}
						tr.appendChild(appsizeTd);
						const btnsTd = document.createElement('td');
						const btnDel = document.createElement('button');
						btnDel.innerText = 'Delete';
						btnDel.onclick = (e) => {
							if (!confirm('Do you really want to delete the wiki with token ' + token + '?')) return;
							serverReq({ op: 'delete', token }).then(() => document.getElementById('refresh').click());
						};
						btnsTd.appendChild(btnDel);
						tr.appendChild(btnsTd);
						wikirows.appendChild(tr);
					}
					return true;
				}
				window.addEventListener('DOMContentLoaded', (_) => {
					const loginForm = document.getElementById('login');
					loginForm.onsubmit = (e) => {
						e.preventDefault();
						loginForm.querySelector('fieldset').disabled = true;
						refreshTokens().then((suc) => {
							document.getElementById('loggedin').hidden = !suc;
							loginForm.hidden = suc;
							loginForm.querySelector('fieldset').disabled = suc;
						}).catch((e) => {
							console.error(e);
							alert('Unexpected error!');
							loginForm.querySelector('fieldset').disabled = false;
						});
					};
					const refreshBtn = document.getElementById('refresh');
					const createBtn = document.getElementById('create');
					refreshBtn.onclick = () => {
						refreshBtn.disabled = createBtn.disabled = true;
						refreshTokens().then(() => {
							refreshBtn.disabled = createBtn.disabled = false;
						}).catch((e) => {
							console.error(e);
							alert('Unexpected error!');
							refreshBtn.disabled = createBtn.disabled = false;
						});
					};
					createBtn.onclick = () => {
						serverReq({ op: 'create' }).then(() => refreshBtn.click());
					}
				});
			</script>
		</body>
	</html>
`;

const args = argparse(Deno.args);
const denv = args.dotenv ? await dotenv.load() : {};
const envvar = (name: string) => Deno.env.get(name) ?? denv[name];
const adminpwhash = base64.decode((args.adminpwhash ?? envvar('ADMIN_PASSWORD_HASH'))?.trim());
const adminpwsalt = base64.decode((args.adminpwsalt ?? envvar('ADMIN_PASSWORD_SALT'))?.trim());
export const kv = await Deno.openKv(args.db ?? envvar('DB_PATH'));
const utfenc = new TextEncoder();
const argon = new ArgonWorker();

const homePat = new URLPattern({ pathname: '/' });
const apiPat = new URLPattern({ pathname: '/tid.dly' });
const appFilePat = new URLPattern({ pathname: '/:halftoken/:filename' });

const respHdrs = { 'access-control-allow-origin': '*' };

function adminPasswordCorrect(atoken: string) {
	return argon.verify(utfenc.encode(atoken), adminpwsalt, adminpwhash);
}

function parseTime(x: number) {
	const time = new Date();
	time.setTime(x);
	return time;
}

function stripWeak(x: string | null) {
	return x && (x.startsWith('W/') ? x.slice(2) : x);
}

function processEtag(etag: Uint8Array, headers: Headers): [boolean, string] {
	const supportsBrotli = !!headers.get('accept-encoding')?.split(',').find((x) => x.trim().split(';')[0] === 'br');
	return [supportsBrotli, '"' + base64.encode(etag) + (supportsBrotli ? '-b' : '-x') + '"'];
}

function notifyMonitors(token: string, browserToken: string) {
	const chan = new BroadcastChannel(token);
	chan.postMessage({ exclude: browserToken });
	// chan.close(); // -> Uncaught (in promise) BadResource: Bad resource ID ?!
}

async function handleSync(
	{ token, browserToken, authcode, salt, now, clientChanges, lastSync }: any,
	headers: Headers,
) {
	if (
		typeof token !== 'string' || typeof authcode !== 'string' || typeof now !== 'string' ||
		typeof lastSync !== 'string' || (salt && typeof salt !== 'string') ||
		!Array.isArray(clientChanges)
	) {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (Math.abs(new Date(now).getTime() - new Date().getTime()) > 60000) {
		return Response.json({ error: 'ETIMESYNC' }, { headers: respHdrs, status: 400 });
	}
	const wiki = await kv.get<Wiki>(wikiKey(token));
	if (!wiki.value) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	if (wiki.value.authcode && authcode !== wiki.value.authcode) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const modsince = new Date(lastSync);

	const serverChanges: Array<Record<string, string | Date | boolean | null>> = [];
	// console.log('---');
	for await (const { key, value } of kv.list<Tiddler>({ prefix: tiddlerKeyPrefix(token) })) {
		const thash = key[2];
		const { title, tiv, data, iv, mtime, deleted } = value;
		// console.log('ServHas', base64nourl.encode(thash as Uint8Array), mtime, modsince, mtime < modsince);
		if (mtime <= modsince) continue;
		serverChanges.push({
			thash: thash ? base64nourl.encode(thash as Uint8Array) : null,
			title: title ? base64nourl.encode(title as Uint8Array) : null,
			tiv: tiv ? base64nourl.encode(tiv as Uint8Array) : null,
			data: data ? base64nourl.encode(data as Uint8Array) : null,
			iv: iv ? base64nourl.encode(iv as Uint8Array) : null,
			mtime,
			deleted,
		});
	}
	let txn = kv.atomic();
	// console.log('ClntChg', clientChanges);
	for (const { thash, title, tiv, data, iv, mtime, deleted } of clientChanges) {
		txn = txn.set(tiddlerKey(token, base64nourl.decode(thash)), {
			title: title ? base64nourl.decode(title) : null,
			tiv: tiv ? base64nourl.decode(tiv) : null,
			data: data ? base64nourl.decode(data) : null,
			iv: iv ? base64nourl.decode(iv) : null,
			mtime: new Date(mtime || now),
			deleted: deleted || false,
		});
	}
	let updateWiki = false;
	if (!wiki.value.authcode && authcode) updateWiki = true, wiki.value.authcode = authcode;
	if (!wiki.value.salt && salt) updateWiki = true, wiki.value.salt = salt;
	if (updateWiki) txn = txn.set(wikiKey(token), wiki.value);
	await txn.commit();

	if (clientChanges.length > 0 && typeof browserToken === 'string') notifyMonitors(token, browserToken);
	// assuming here that the browser would use the same Accept-Encoding as when requesting the page
	const apphtml = wiki.value.files?.get('app.html');
	const [_, appEtag] = apphtml ? processEtag(apphtml.etag, headers) : [null, null];
	return Response.json({ serverChanges, appEtag }, { headers: respHdrs });
}

async function handleList({ atoken }: any) {
	if (typeof atoken !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!await adminPasswordCorrect(atoken)) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const wikis = [];
	for await (const { key, value } of kv.list<Wiki>({ prefix: ALL_WIKI_PREFIX })) {
		wikis.push({
			token: tokenFromKey(key),
			salt: value.salt,
			appsize: value.files ? [...value.files.values()].reduce((sum, v) => sum + v.size, 0) : 0,
		});
	}
	return Response.json({ wikis }, { headers: respHdrs, status: 200 });
}

async function handleCreate({ atoken }: any) {
	if (typeof atoken !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!await adminPasswordCorrect(atoken)) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const token = base64.encode(crypto.getRandomValues(new Uint8Array(32)));
	await kv.set(wikiKey(token), {});
	return Response.json({ token }, { headers: respHdrs, status: 201 });
}

async function garbageCollectBlobs(
	token: string,
	oldfiles: Map<string, AppFile> | undefined,
	usedetags: Set<Uint8Array>,
) {
	if (!oldfiles) return;
	for (const [filename, meta] of oldfiles) {
		if (usedetags.has(meta.etag)) continue;
		const key = blobMetaKey(meta.etag);
		const prevblobmeta = await kv.get<BlobMeta>(key);
		const blobmeta = prevblobmeta.value;
		if (!blobmeta) continue;
		blobmeta.refs.delete(token);
		const txn = kv.atomic().check({ key, versionstamp: prevblobmeta.versionstamp });
		if (blobmeta.refs.size === 0) {
			await blob.remove(kv, blobKey(meta.etag));
			await txn.delete(key).commit();
		} else {
			await txn.set(key, blobmeta).commit();
		}
	}
}

async function handleDelete({ atoken, token }: any) {
	if (typeof atoken !== 'string' || typeof token !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!await adminPasswordCorrect(atoken)) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const wiki = await kv.get<Wiki>(wikiKey(token));
	if (!wiki.value) {
		return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
	}
	await kv.delete(wikiKey(token));
	for await (const { key } of kv.list<Tiddler>({ prefix: tiddlerKeyPrefix(token) })) {
		await kv.delete(key);
	}
	await garbageCollectBlobs(token, wiki.value.files, new Set());
	return Response.json({}, { headers: respHdrs, status: 200 });
}

async function handleUploadApp({ token, authcode, browserToken, files }: any) {
	if (typeof token !== 'string' || typeof files !== 'object') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	const wiki = await kv.get<Wiki>(wikiKey(token));
	if (!wiki.value) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	if (wiki.value.authcode && authcode !== wiki.value.authcode) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const filemap = new Map();
	const usedetags = new Set<Uint8Array>();
	let txn = kv.atomic().check({ key: wikiKey(token), versionstamp: wiki.versionstamp });
	for (const [filename, value] of Object.entries(files)) {
		const { body, ctype, sig } = value as any;
		const utf = utfenc.encode(body);
		const etag = new Uint8Array(await crypto.subtle.digest('SHA-1', utf));
		const prevblobmeta = await kv.get<BlobMeta>(blobMetaKey(etag));
		let blobmeta;
		if (prevblobmeta.value) {
			blobmeta = prevblobmeta.value;
			txn = txn.check({ key: blobMetaKey(etag), versionstamp: prevblobmeta.versionstamp });
		} else {
			const brot = brotli.compress(utf, 4096, 8);
			await blob.set(kv, blobKey(etag), brot);
			blobmeta = { refs: new Set(), size: brot.length };
		}
		if (!blobmeta.refs.has(token)) {
			blobmeta.refs.add(token);
			txn = txn.set(blobMetaKey(etag), blobmeta);
		}
		filemap.set(filename, {
			etag,
			size: blobmeta.size,
			rawsize: utf.length,
			sig: sig ? base64.decode(sig) : null,
			ctype,
		});
		usedetags.add(etag);
	}
	await txn.set(wikiKey(token), {
		...wiki.value,
		files: filemap,
	}).commit();
	if (typeof browserToken === 'string') notifyMonitors(token, browserToken);
	await garbageCollectBlobs(token, wiki.value.files, usedetags);
	return Response.json({ urlprefix: token.slice(0, token.length / 2) + '/' }, { headers: respHdrs, status: 200 });
}

async function handleMonitor(query: URLSearchParams) {
	const token = query.get('token');
	const browserToken = query.get('browserToken');
	if (!token || !browserToken) {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	const wiki = await kv.get<Wiki>(wikiKey(token));
	if (!wiki.value) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	let pushChan: BroadcastChannel;
	return new Response(
		new ReadableStream({
			async start(ctrl) {
				ctrl.enqueue('event: hi\ndata: 1\n\n'); // seems to ensure the 'open' event is fired?
				pushChan = new BroadcastChannel(token);
				pushChan.onmessage = (evt) => {
					if (evt.data.exclude !== browserToken) ctrl.enqueue('event: sync\ndata: 1\n\n');
				};
			},
			cancel() {
				pushChan.close();
			},
		}).pipeThrough(new TextEncoderStream()),
		{
			headers: {
				...respHdrs,
				'content-type': 'text/event-stream',
				'cache-control': 'no-store',
			},
		},
	);
}

function preflightResp(methods: string) {
	return new Response(null, {
		headers: {
			...respHdrs,
			'access-control-allow-methods': methods,
			'access-control-allow-headers': '*',
			'access-control-max-age': '86400',
		},
		status: 204,
	});
}

async function handleAppFile(req: Request) {
	const match = appFilePat.exec(req.url);
	if (!match) return null;
	if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
		return new Response(null, { status: 405, headers: { 'allow': 'GET, HEAD, OPTIONS' } });
	}
	const { halftoken, filename } = match.pathname.groups;
	if (!halftoken || !filename) return null;
	const wiki = await (await kv.list<Wiki>({ prefix: wikiKeyHalf(halftoken) })).next();
	if (!wiki.value || !wiki.value.value) {
		return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
	}
	if (req.method === 'OPTIONS') {
		return preflightResp('GET, HEAD, OPTIONS');
	}
	if (filename === 'bootstrap.json') {
		return Response.json({
			endpoint: '/tid.dly',
			state: wiki.value.value.salt ? 'existing' : 'fresh',
			salt: wiki.value.value.salt,
		}, { headers: respHdrs });
	}
	const meta = wiki.value.value.files?.get(filename);
	if (!meta) {
		return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
	}
	const [supportsBrotli, etagstr] = processEtag(meta.etag, req.headers);
	// if we decompress and Deno recompresses to something else (gzip) it'll mark the ETag as a weak validator
	const headers = new Headers({
		'content-type': meta.ctype,
		'vary': 'Accept-Encoding',
		'cache-control': 'no-cache',
		'etag': etagstr,
	});
	if (meta.sig) {
		headers.set('x-tid-sig', base64.encode(meta.sig));
	}
	if (stripWeak(req.headers.get('if-none-match')) === etagstr) {
		return new Response(null, { status: 304, headers });
	}
	let body;
	if (supportsBrotli) {
		headers.set('content-encoding', 'br');
		headers.set('content-length', meta.size.toString());
		if (req.method !== 'HEAD') {
			body = await blob.get(kv, blobKey(meta.etag), { stream: true });
		}
	} else {
		headers.set('content-length', meta.rawsize.toString());
		if (req.method !== 'HEAD') {
			const compressed = await blob.get(kv, blobKey(meta.etag), { stream: false });
			if (!compressed) return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
			body = brotli.decompress(compressed);
		}
	}
	return new Response(body, { headers });
}

async function handleApiEndpoint(req: Request) {
	if (!apiPat.exec(req.url)) return null;
	if (req.method === 'OPTIONS') {
		return preflightResp('POST, GET, OPTIONS');
	}
	if (req.method === 'POST') {
		const data = await req.json();
		if (data.tiddlypwa !== 1 || !data.op) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if (data.op === 'sync') return await handleSync(data, req.headers);
		if (data.op === 'list') return await handleList(data);
		if (data.op === 'create') return await handleCreate(data);
		if (data.op === 'delete') return await handleDelete(data);
		if (data.op === 'uploadapp') return await handleUploadApp(data);
	}
	if (req.method === 'GET') {
		const query = new URL(req.url).searchParams;
		if (query.get('op') === 'monitor') return handleMonitor(query);
	}
	return Response.json({ error: 'EPROTO' }, { status: 405, headers: { ...respHdrs, 'allow': 'OPTIONS, POST, GET' } });
}

function handleHomePage(req: Request) {
	if (!homePat.exec(req.url)) return null;
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return new Response(null, { status: 405, headers: { 'allow': 'GET, HEAD' } });
	}
	const headers = new Headers({
		'content-type': 'text/html;charset=utf-8',
		'content-length': homePage.length.toString(),
		'cache-control': 'no-cache',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'SAMEORIGIN',
		'content-security-policy':
			'default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\';',
	});
	return new Response(req.method === 'HEAD' ? null : homePage, { headers });
}

export async function handle(req: Request): Promise<Response> {
	return await handleAppFile(req) ||
		await handleApiEndpoint(req) ||
		handleHomePage(req) ||
		Response.json({}, { headers: respHdrs, status: 404 });
}

if (import.meta.main) {
	const listen: any = { port: 8000 };
	if ('port' in args) {
		listen.port = args.port;
	}
	if ('host' in args) {
		listen.hostname = args.host;
	}
	if ('socket' in args) {
		listen.transport = 'unix';
		listen.path = args.socket;
	}
	console.log('Listening:', listen);
	await serveListener(Deno.listen(listen), handle);
}
