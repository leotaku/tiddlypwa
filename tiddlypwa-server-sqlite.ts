import { serveListener } from 'https://deno.land/std@0.150.0/http/server.ts';
import { serveDir } from 'https://deno.land/std@0.150.0/http/file_server.ts';
import { parse as argparse } from 'https://deno.land/std@0.150.0/flags/mod.ts';
import * as base64 from 'https://deno.land/std@0.150.0/encoding/base64.ts';
import { DB } from 'https://deno.land/x/sqlite@v3.4.0/mod.ts';

const args = argparse(Deno.args);
const admintoken = args.admintoken || Deno.env.get('ADMIN_TOKEN');
const db = new DB(args.db || Deno.env.get('SQLITE_DB') || '.data/tiddly.db');

const dbver = db.query('PRAGMA user_version')[0][0] as number;
if (dbver < 1) {
	db.execute(`
		BEGIN;
		CREATE TABLE wikis (
			id INTEGER PRIMARY KEY,
			token TEXT
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

const wikiIdQuery = db.prepareQuery<number>(`
	SELECT id FROM wikis WHERE token = :token
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

const respHdrs = { 'Access-Control-Allow-Origin': '*' };

function parseTime(x: number) {
	const time = new Date();
	time.setTime(x);
	return time;
}

function handleSync(
	{ token, now, clientChanges, lastSync }: { token: any; now: any; clientChanges: any; lastSync: any },
) {
	if (
		typeof token !== 'string' || typeof now !== 'string' || typeof lastSync !== 'string' ||
		!Array.isArray(clientChanges)
	) {
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	if (Math.abs(new Date(now).getTime() - new Date().getTime()) > 60000) {
		return Response.json({ error: 'ETIMESYNC' }, { headers: respHdrs, status: 400 });
	}
	const wikiRows = wikiIdQuery.all({ token });
	if (wikiRows.length < 1) {
		return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
	}
	const wiki = wikiRows[0][0] as number;
	const serverChanges: Array<Record<string, string | Date | boolean | null>> = [];
	db.transaction(() => {
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

async function handle(req: Request) {
	if (req.method === 'GET') {
		return serveDir(req, {
			fsRoot: args.static || 'static',
		});
	}
	if (req.method === 'POST') {
		const data = await req.json();
		if (data.tiddlypwa !== 1 || !data.op) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if (data.op === 'sync') {
			return handleSync(data);
		}
		if (data.op === 'create') {
			return handleCreate(data);
		}
		if (data.op === 'delete') {
			return handleDelete(data);
		}
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}
	return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 404 });
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
