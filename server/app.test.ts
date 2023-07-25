// deno-lint-ignore-file no-explicit-any
import { assertEquals } from 'https://deno.land/std@0.192.0/testing/asserts.ts';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';

const app = new TiddlyPWASyncApp(
	new SQLiteDatastore(),
	'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
	'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
);

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
	iv?: string;
	ct?: string;
	sbiv?: string;
	sbct?: string;
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
			{ thash: 'T3dP', ct: '1111' },
			{ thash: 'VXdV', ct: '11111111', mtime: new Date(69) },
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
				iv: null,
				ct: '1111',
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
			{
				thash: 'VXdV',
				iv: null,
				ct: '11111111',
				sbiv: null,
				sbct: null,
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
				iv: null,
				ct: '1111',
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
		],
	});
	await deleteWiki(tok);
});

Deno.test('syncing a ton of tiddlers works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	assertEquals(
		await sync(
			tok,
			'test',
			s1date,
			new Date(0),
			[...Array(20).keys()].map((_, i) => ({ thash: btoa(i.toString()), ct: 'T3dp' })),
		),
		{ appEtag: null, serverChanges: [] },
	);
	assertEquals(await sync(tok, 'test', new Date(), new Date(420), []), {
		appEtag: null,
		serverChanges: [...Array(20).keys()].map((_, i) => (
			{
				thash: btoa(i.toString()),
				iv: null,
				ct: 'T3dp',
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			}
		)),
	});
	await deleteWiki(tok);
});

Deno.test('storing large data works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	const bigdata = Array(5592407).join('A') + '==';
	assertEquals(
		await sync(tok, 'test', s1date, new Date(0), [
			{ thash: 'T3dP', ct: bigdata },
		]),
		{ appEtag: null, serverChanges: [] },
	);
	assertEquals(await sync(tok, 'test', new Date(), new Date(420), []), {
		appEtag: null,
		serverChanges: [
			{
				thash: 'T3dP',
				iv: null,
				ct: bigdata,
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
		],
	});
	await deleteWiki(tok);
});
