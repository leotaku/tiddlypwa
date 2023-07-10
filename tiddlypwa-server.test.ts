// deno-lint-ignore-file no-explicit-any
// deno test --unstable --allow-env --allow-read=.
import 'https://deno.land/std@0.192.0/dotenv/load.ts';
import { assertEquals } from 'https://deno.land/std@0.192.0/testing/asserts.ts';
import * as app from './tiddlypwa-server.ts';

const api = (data: any) =>
	app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, ...data }),
		}),
	).then((x) => x.json());

const page = (path: string) => app.handle(new Request('http://example.com/' + path));

const createWiki = () => api({ op: 'create', atoken: 'test' }).then((x) => x.token as string);
const deleteWiki = (token: string) => api({ op: 'delete', atoken: 'test', token });
const uploadAppFile = (token: string, body: string, extra?: Record<string, unknown>, file = 'app.html') =>
	api({
		op: 'uploadapp',
		token,
		files: {
			[file]: {
				body,
				ctype: 'text/html',
				...extra,
			},
		},
	});

type tidjson = {
	thash: string;
	title?: string;
	tiv?: string;
	data?: string;
	iv?: string;
	mtime?: Date;
	deleted?: boolean;
};
const sync = (token: string, authcode: string, now: Date, lastSync: Date, clientChanges: Array<tidjson>) =>
	api({ op: 'sync', token, authcode, now, lastSync, clientChanges });

Deno.test('basic syncing works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	// Basic write, with and without an mtime
	assertEquals(
		await sync(tok, 'test', s1date, new Date(0), [
			{ thash: 'T3dP', data: '1111' },
			{ thash: 'VXdV', data: '11111111', mtime: new Date(69) },
		]),
		{ appEtag: null, serverChanges: [] },
	);
	// Wrong authtok
	assertEquals(await sync(tok, 'wrong', new Date(), new Date(), []), { error: 'EAUTH' });
	// Basic reads
	assertEquals(await sync(tok, 'test', new Date(), new Date(0), []), {
		appEtag: null,
		serverChanges: [
			{
				thash: 'T3dP',
				title: null,
				tiv: null,
				data: '1111',
				iv: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
			{
				thash: 'VXdV',
				title: null,
				tiv: null,
				data: '11111111',
				iv: null,
				mtime: new Date(69).toISOString(),
				deleted: false,
			},
		],
	});
	assertEquals(await sync(tok, 'test', new Date(), new Date(420), []), {
		appEtag: null,
		serverChanges: [
			{
				thash: 'T3dP',
				title: null,
				tiv: null,
				data: '1111',
				iv: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
		],
	});
	await deleteWiki(tok);
});

// as we have a complex refcounting system for blobs, ensure they don't ever get left over
Deno.test('app file blob garbage collected when changing content or deleting wiki', async () => {
	const tok1 = await createWiki();
	const tok2 = await createWiki();
	const { urlprefix: urlp1 } = await uploadAppFile(tok1, 'hello world');
	{
		const resp = await page(urlp1 + 'app.html');
		assertEquals(resp.headers.get('content-type'), 'text/html');
		assertEquals(await resp.text(), 'hello world');
	}
	const etag = ((await app.kv.get(app.wikiKey(tok1))).value as any).files.get('app.html').etag;
	assertEquals((await app.kv.list({ prefix: app.blobKey(etag) }).next()).done, false);
	const { urlprefix: urlp2 } = await uploadAppFile(
		tok2,
		'hello world',
		{ ctype: 'something/else', sig: 'aaaa' },
		'what.ev',
	);
	{
		const resp = await page(urlp2 + 'what.ev');
		assertEquals(resp.headers.get('content-type'), 'something/else');
		assertEquals(await resp.text(), 'hello world');
	}
	assertEquals(((await app.kv.get(app.blobMetaKey(etag))).value as any).refs, new Set([tok1, tok2]));
	await uploadAppFile(tok1, 'new content');
	{
		const resp = await page(urlp2 + 'what.ev');
		assertEquals(resp.headers.get('content-type'), 'something/else');
		assertEquals(await resp.text(), 'hello world');
	}
	assertEquals(((await app.kv.get(app.blobMetaKey(etag))).value as any).refs, new Set([tok2]));
	await uploadAppFile(tok2, 'mew content', {}, 'what.ev');
	assertEquals((await app.kv.get(app.blobMetaKey(etag))).value as any, null);
	assertEquals(await app.kv.list({ prefix: app.blobKey(etag) }).next(), { done: true, value: undefined });
	const etagmew = ((await app.kv.get(app.wikiKey(tok2))).value as any).files.get('what.ev').etag;
	await deleteWiki(tok2);
	assertEquals(await app.kv.list({ prefix: app.blobKey(etagmew) }).next(), { done: true, value: undefined });
	await deleteWiki(tok1);
});
