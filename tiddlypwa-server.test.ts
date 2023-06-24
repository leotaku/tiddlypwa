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
const uploadAppFile = (token: string, body: string, extra?: object, file: string = 'app.html') =>
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
	assertEquals((await (await app.kv.list({ prefix: app.blobKey(etag) })).next()).done, false);
	const { urlprefix: urlp2 } = await uploadAppFile(
		tok2,
		'hello world',
		{ ctype: 'something/else', sig: 'aaaa' },
		'what.ev',
	);
	{
		const resp = await page(urlp2 + 'what.ev');
		assertEquals(resp.headers.get('content-type'), 'something/else');
		assertEquals(resp.headers.get('x-tid-sig'), 'aaaa');
		assertEquals(await resp.text(), 'hello world');
	}
	assertEquals(((await app.kv.get(app.blobMetaKey(etag))).value as any).refs, new Set([tok1, tok2]));
	await uploadAppFile(tok1, 'new content');
	{
		const resp = await page(urlp2 + 'what.ev');
		assertEquals(resp.headers.get('content-type'), 'something/else');
		assertEquals(resp.headers.get('x-tid-sig'), 'aaaa');
		assertEquals(await resp.text(), 'hello world');
	}
	assertEquals(((await app.kv.get(app.blobMetaKey(etag))).value as any).refs, new Set([tok2]));
	await uploadAppFile(tok2, 'mew content', {}, 'what.ev');
	assertEquals((await app.kv.get(app.blobMetaKey(etag))).value as any, null);
	assertEquals(await (await app.kv.list({ prefix: app.blobKey(etag) })).next(), { done: true, value: undefined });
	const etagmew = ((await app.kv.get(app.wikiKey(tok2))).value as any).files.get('what.ev').etag;
	await deleteWiki(tok2);
	assertEquals(await (await app.kv.list({ prefix: app.blobKey(etagmew) })).next(), { done: true, value: undefined });
	await deleteWiki(tok1);
});
