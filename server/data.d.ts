/// <reference lib="deno.window" />

export type Wiki = {
	token: string;
	authcode?: string;
	salt?: string;
	note?: string;
};

export type File = {
	etag: Uint8Array;
	rawsize: number;
	ctype: string;
	body: Uint8Array;
};

export type Tiddler = {
	thash: Uint8Array;
	title?: Uint8Array;
	tiv?: Uint8Array;
	data?: Uint8Array;
	iv?: Uint8Array;
	mtime: Date;
	deleted: boolean;
};
