import { serveListener } from 'https://deno.land/std@0.150.0/http/server.ts';
import { parse as argparse } from 'https://deno.land/std@0.150.0/flags/mod.ts';
import * as base64 from 'https://deno.land/std@0.150.0/encoding/base64.ts';
import * as brotli from 'https://deno.land/x/brotli@v0.1.4/mod.ts';
import { DB } from 'https://deno.land/x/sqlite@v3.4.0/mod.ts';

const args = argparse(Deno.args);
const admintoken = (args.admintoken || Deno.env.get('ADMIN_TOKEN'))?.trim();
const db = new DB(args.db || Deno.env.get('SQLITE_DB') || '.data/tiddly.db');
const utfenc = new TextEncoder();

const dbver = db.query('PRAGMA user_version')[0][0] as number;
if (dbver < 1) {
	db.execute(`
		BEGIN;
		CREATE TABLE wikis (
			id INTEGER PRIMARY KEY,
			token TEXT NOT NULL,
			authcode BLOB,
			apphtml BLOB,
			apphtmletag BLOB,
			swjs BLOB,
			swjsetag BLOB
		) STRICT;
		CREATE TABLE tiddlers (
			thash BLOB PRIMARY KEY NOT NULL,
			title BLOB,
			tiv BLOB,
			dhash BLOB,
			data BLOB,
			iv BLOB,
			mtime INTEGER NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0,
			wiki INTEGER NOT NULL,
			FOREIGN KEY(wiki) REFERENCES wikis(id) ON DELETE CASCADE
		) STRICT;
		PRAGMA user_version = 1;
		COMMIT;
	`);
}

const wikiAuthQuery = db.prepareQuery(`
	SELECT id, authcode FROM wikis WHERE token = :token
`);

const apphtmlQuery = db.prepareQuery(`
	SELECT apphtml, apphtmletag FROM wikis WHERE token LIKE :halftoken || '%'
`);

const swjsQuery = db.prepareQuery(`
	SELECT swjs, swjsetag FROM wikis WHERE token LIKE :halftoken || '%'
`);

const changedQuery = db.prepareQuery<
	[Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, number, boolean]
>(`
	SELECT thash, title, tiv, dhash, data, iv, mtime, deleted
	FROM tiddlers WHERE mtime > :modsince AND wiki = :wiki
`);

const upsertQuery = db.prepareQuery(`
	INSERT INTO tiddlers (thash, title, tiv, dhash, data, iv, mtime, deleted, wiki)
	VALUES (:thash, :title, :tiv, :dhash, :data, :iv, :mtime, :deleted, :wiki)
	ON CONFLICT (thash) DO UPDATE SET
	title = excluded.title,
	tiv = excluded.tiv,
	dhash = excluded.dhash,
	data = excluded.data,
	iv = excluded.iv,
	mtime = excluded.mtime,
	deleted = excluded.deleted
`);

const apiPat = new URLPattern({ pathname: '/tid.dly' });
const apphtmlPat = new URLPattern({ pathname: '/:halftoken/app.html' });
const swjsPat = new URLPattern({ pathname: '/:halftoken/sw.js' });

const respHdrs = { 'access-control-allow-origin': '*' };

function parseTime(x: number) {
	const time = new Date();
	time.setTime(x);
	return time;
}

function handleSync(
	{ token, authcode, now, clientChanges, lastSync }: {
		token: any;
		authcode: any;
		now: any;
		clientChanges: any;
		lastSync: any;
	},
) {
	if (
		typeof token !== 'string' || typeof authcode !== 'string' || typeof now !== 'string' ||
		typeof lastSync !== 'string' ||
		!Array.isArray(clientChanges)
	) {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (Math.abs(new Date(now).getTime() - new Date().getTime()) > 60000) {
		return Response.json({ error: 'ETIMESYNC' }, { headers: respHdrs, status: 400 });
	}
	const wikiRows = wikiAuthQuery.all({ token });
	if (wikiRows.length < 1) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const [wiki, dbauthcode] = wikiRows[0];
	if (dbauthcode && authcode !== dbauthcode) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const serverChanges: Array<Record<string, string | Date | boolean | null>> = [];
	db.transaction(() => {
		if (!dbauthcode) {
			db.query(
				`UPDATE wikis SET authcode = :authcode WHERE token = :token`,
				{ token, authcode },
			);
		}
		for (
			const { thash, title, tiv, dhash, data, iv, mtime, deleted } of changedQuery.iterEntries({
				modsince: new Date(lastSync).getTime(),
				wiki,
			})
		) {
			serverChanges.push({
				thash: thash ? base64.encode(thash as Uint8Array) : null,
				title: title ? base64.encode(title as Uint8Array) : null,
				tiv: tiv ? base64.encode(tiv as Uint8Array) : null,
				dhash: dhash ? base64.encode(dhash as Uint8Array) : null,
				data: data ? base64.encode(data as Uint8Array) : null,
				iv: iv ? base64.encode(iv as Uint8Array) : null,
				mtime: parseTime(mtime as number),
				deleted: !!(deleted as number),
			});
		}
		for (const { thash, title, tiv, dhash, data, iv, mtime, deleted } of clientChanges) {
			upsertQuery.execute({
				thash: base64.decode(thash),
				title: base64.decode(title),
				tiv: base64.decode(tiv),
				dhash: base64.decode(dhash),
				data: base64.decode(data),
				iv: base64.decode(iv),
				mtime: new Date(mtime || now).getTime(),
				deleted: deleted || false,
				wiki,
			});
		}
	});
	return Response.json({ serverChanges }, { headers: respHdrs });
}

function handleCreate({ atoken }: { atoken: any }) {
	if (typeof atoken !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (atoken !== admintoken) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const token = base64.encode(crypto.getRandomValues(new Uint8Array(32)));
	db.query(`INSERT INTO wikis (token) VALUES (:token)`, { token });
	return Response.json({ token }, { headers: respHdrs, status: 201 });
}

function handleDelete({ atoken, token }: { atoken: any; token: any }) {
	if (typeof atoken !== 'string' || typeof token !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (atoken !== admintoken) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	db.query(`DELETE FROM wikis WHERE token = :token`, { token });
	return Response.json({}, { headers: respHdrs, status: 200 });
}

async function handleUploadApp({ token, apphtml, swjs }: { token: any; apphtml: any; swjs: any }) {
	if (typeof token !== 'string' || typeof apphtml !== 'string' || typeof swjs !== 'string') {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	const apphtmlutf = utfenc.encode(apphtml);
	const swjsutf = utfenc.encode(swjs);
	db.query(
		`UPDATE wikis SET
		apphtml = :apphtml,
		apphtmletag = :apphtmletag,
		swjs = :swjs,
		swjsetag = :swjsetag
		WHERE token = :token`,
		{
			token,
			apphtml: brotli.compress(apphtmlutf, 4096, 8),
			apphtmletag: new Uint8Array(await crypto.subtle.digest('SHA-1', apphtmlutf)),
			swjs: brotli.compress(swjsutf, 4096, 8),
			swjsetag: new Uint8Array(await crypto.subtle.digest('SHA-1', swjsutf)),
		},
	);
	return Response.json({ url: token.slice(0, token.length / 2) + '/app.html' }, { headers: respHdrs, status: 200 });
}

function handleDbFile(pattern: URLPattern, req: Request, query: any, ctype: string): Response | null {
	const match = pattern.exec(req.url);
	if (!match) return null;
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return new Response(null, { status: 405, headers: { 'allow': 'GET, HEAD' } });
	}
	const res = query.all(match.pathname.groups);
	if (res.length === 0) {
		return Response.json({}, { status: 404 });
	}
	const supportsBrotli = req.headers.get('accept-encoding')?.split(',').find((x) => x.trim().split(';')[0] === 'br');
	let [body, etag] = res[0];
	const etagstr = '"' + base64.encode(etag) + (supportsBrotli ? '-b' : '-x') + '"';
	// if we decomress and Deno recompresses to something else (gzip) it'll mark the ETag as a weak validator
	const headers = new Headers({
		'content-type': ctype,
		'vary': 'Accept-Encoding',
		'cache-control': 'no-cache',
		'etag': etagstr,
	});
	if (req.headers.get('if-none-match') === etagstr) {
		return new Response(null, {
			status: 304,
			headers,
		});
	}
	if (supportsBrotli) {
		headers.set('content-encoding', 'br');
	} else {
		body = brotli.decompress(body);
	}
	headers.set('content-length', body.length);
	return new Response(req.method === 'HEAD' ? null : body, { headers });
}

async function handleApiEndpoint(req: Request) {
	if (!apiPat.exec(req.url)) return null;
	if (req.method === 'OPTIONS') {
		return new Response(null, {
			headers: {
				...respHdrs,
				'access-control-allow-methods': 'POST, GET, OPTIONS',
				'access-control-allow-headers': '*',
			},
			status: 204,
		});
	}
	if (req.method === 'POST') {
		const data = await req.json();
		if (data.tiddlypwa !== 1 || !data.op) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if (data.op === 'sync') return handleSync(data);
		if (data.op === 'create') return handleCreate(data);
		if (data.op === 'delete') return handleDelete(data);
		if (data.op === 'uploadapp') return handleUploadApp(data);
	}
	if (req.method === 'GET') {
		// TODO: SSE
	}
	return Response.json({ error: 'EPROTO' }, { status: 405, headers: { ...respHdrs, 'allow': 'OPTIONS, POST, GET' } });
}

async function handle(req: Request) {
	return await handleDbFile(apphtmlPat, req, apphtmlQuery, 'text/html;charset=utf-8') ||
		await handleDbFile(swjsPat, req, swjsQuery, 'text/javascript;charset=utf-8') ||
		await handleApiEndpoint(req) ||
		Response.json({}, { headers: respHdrs, status: 404 });
}

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
