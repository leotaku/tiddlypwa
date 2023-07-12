/// <reference lib="deno.window" />
/// <reference lib="deno.unstable" />
import * as base64 from 'https://deno.land/std@0.192.0/encoding/base64url.ts';
import * as base64nourl from 'https://deno.land/std@0.192.0/encoding/base64.ts';
import * as dotenv from 'https://deno.land/std@0.192.0/dotenv/mod.ts';
import { parse as argparse } from 'https://deno.land/std@0.192.0/flags/mod.ts';
import { serveListener } from 'https://deno.land/std@0.192.0/http/server.ts';
import * as argon from 'https://deno.land/x/argon2ian@2.0.0/src/argon2.ts';
import * as brotli from 'https://deno.land/x/brotli@0.1.7/mod.ts';
import { SQLiteDatastore } from './sqlite.ts';
import { homePage } from './pages.ts';

const args = argparse(Deno.args);
const denv = args.dotenv ? await dotenv.load() : {};
const envvar = (name: string) => Deno.env.get(name) ?? denv[name];
const adminpwhash = base64.decode((args.adminpwhash ?? envvar('ADMIN_PASSWORD_HASH'))?.trim());
const adminpwsalt = base64.decode((args.adminpwsalt ?? envvar('ADMIN_PASSWORD_SALT'))?.trim());
export const db = new SQLiteDatastore(args.db ?? envvar('DB_PATH'));
const utfenc = new TextEncoder();

const homePat = new URLPattern({ pathname: '/' });
const apiPat = new URLPattern({ pathname: '/tid.dly' });
const appFilePat = new URLPattern({ pathname: '/:halftoken/:filename' });

const respHdrs = { 'access-control-allow-origin': '*' };

function adminPasswordCorrect(atoken: string) {
	return argon.verify(utfenc.encode(atoken), adminpwsalt, adminpwhash);
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
	const wiki = db.getWiki(token);
	if (!wiki) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	if (wiki.authcode && authcode !== wiki.authcode) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const modsince = new Date(lastSync);

	const serverChanges: Array<Record<string, string | Date | boolean | null>> = [];
	// console.log('---');
	db.transaction(() => {
		if (!wiki.authcode && authcode) db.updateWikiAuthcode(token, authcode);
		if (!wiki.salt && salt) db.updateWikiSalt(token, salt);
		for (const { thash, title, tiv, data, iv, mtime, deleted } of db.tiddlersChangedSince(token, modsince)) {
			// console.log('ServHas', base64nourl.encode(thash as Uint8Array), mtime, modsince, mtime < modsince);
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
		// console.log('ClntChg', clientChanges);
		for (const { thash, title, tiv, data, iv, mtime, deleted } of clientChanges) {
			db.upsertTiddler(token, {
				thash: base64nourl.decode(thash),
				title: title && base64nourl.decode(title),
				tiv: tiv && base64nourl.decode(tiv),
				data: data && base64nourl.decode(data),
				iv: iv && base64nourl.decode(iv),
				mtime: new Date(mtime || now),
				deleted: deleted || false,
			});
		}
	});

	if (clientChanges.length > 0 && typeof browserToken === 'string') notifyMonitors(token, browserToken);
	// assuming here that the browser would use the same Accept-Encoding as when requesting the page
	const apphtml = db.getWikiFile(token, 'app.html');
	const [_, appEtag] = apphtml ? processEtag(apphtml.etag, headers) : [null, null];
	return Response.json({ serverChanges, appEtag }, { headers: respHdrs });
}

async function handleList({ atoken }: any) {
	if (typeof atoken !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!adminPasswordCorrect(atoken)) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	return Response.json({ wikis: db.listWikis() }, { headers: respHdrs, status: 200 });
}

async function handleCreate({ atoken }: any) {
	if (typeof atoken !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!adminPasswordCorrect(atoken)) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const token = base64.encode(crypto.getRandomValues(new Uint8Array(32)));
	db.createWiki(token);
	return Response.json({ token }, { headers: respHdrs, status: 201 });
}

async function handleDelete({ atoken, token }: any) {
	if (typeof atoken !== 'string' || typeof token !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!adminPasswordCorrect(atoken)) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	if (!db.getWiki(token)) {
		return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
	}
	db.deleteWiki(token);
	return Response.json({}, { headers: respHdrs, status: 200 });
}

async function handleReauth({ atoken, token }: any) {
	if (typeof atoken !== 'string' || typeof token !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!adminPasswordCorrect(atoken)) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	if (!db.getWiki(token)) {
		return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
	}
	db.updateWikiAuthcode(token, undefined);
	return Response.json({}, { headers: respHdrs, status: 200 });
}

async function handleUploadApp({ token, authcode, browserToken, files }: any) {
	if (typeof token !== 'string' || typeof files !== 'object') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	const wiki = db.getWiki(token);
	if (!wiki) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	if (wiki.authcode && authcode !== wiki.authcode) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const uploads = await Promise.all(
		Object.entries(files).map(async ([filename, value]) => {
			const { body, ctype } = value as any;
			const utf = utfenc.encode(body);
			const etag = new Uint8Array(await crypto.subtle.digest('SHA-1', utf));
			return { filename, etag, utf, ctype };
		}),
	);
	db.transaction(() => {
		for (const { filename, etag, utf, ctype } of uploads) {
			if (!db.fileExists(etag)) {
				db.storeFile({
					etag,
					rawsize: utf.length,
					ctype,
					body: brotli.compress(utf, 4096, 8),
				});
			}
			db.associateFile(token, etag, filename);
		}
	});
	if (typeof browserToken === 'string') notifyMonitors(token, browserToken);
	return Response.json({ urlprefix: token.slice(0, token.length / 2) + '/' }, { headers: respHdrs, status: 200 });
}

async function handleMonitor(query: URLSearchParams) {
	const token = query.get('token');
	const browserToken = query.get('browserToken');
	if (!token || !browserToken) {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (!db.getWiki(token)) {
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
	const wiki = db.getWikiByPrefix(halftoken);
	if (!wiki) {
		return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
	}
	if (req.method === 'OPTIONS') {
		return preflightResp('GET, HEAD, OPTIONS');
	}
	if (filename === 'bootstrap.json') {
		return Response.json({
			endpoint: '/tid.dly',
			state: wiki.salt ? 'existing' : 'fresh',
			salt: wiki.salt,
		}, { headers: respHdrs });
	}
	const file = db.getWikiFile(halftoken, filename);
	if (!file) {
		return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
	}
	const [supportsBrotli, etagstr] = processEtag(file.etag, req.headers);
	// if we decompress and Deno recompresses to something else (gzip) it'll mark the ETag as a weak validator
	const headers = new Headers({
		'content-type': file.ctype,
		'vary': 'Accept-Encoding',
		'cache-control': 'no-cache',
		'etag': etagstr,
	});
	if (stripWeak(req.headers.get('if-none-match')) === etagstr) {
		return new Response(null, { status: 304, headers });
	}
	let body;
	if (supportsBrotli) {
		headers.set('content-encoding', 'br');
		headers.set('content-length', file.body.length.toString());
		if (req.method !== 'HEAD') {
			body = file.body;
		}
	} else {
		headers.set('content-length', file.rawsize.toString());
		if (req.method !== 'HEAD') {
			body = brotli.decompress(file.body);
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
		if (data.op === 'reauth') return await handleReauth(data);
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
