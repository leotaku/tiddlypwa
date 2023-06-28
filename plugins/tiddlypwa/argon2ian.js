/*\
title: $:/plugins/valpackett/tiddlypwa/argon2ian.js
type: application/javascript
module-type: library

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	class n {
		#e = 0;
		#s = new Map();
		#n = new Worker(
			URL.createObjectURL(
				new Blob([
					'const e=2,n=19,s=await WebAssembly.compileStreaming(new Response((await fetch("data:w/e;base64,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")).body?.pipeThrough(new DecompressionStream("gzip")),{headers:{"content-type":"application/wasm"}}));function t(e){return{malloc:n=>[e.malloc(n),n],buf:([n,s])=>new Uint8Array(e.memory.buffer,n,s)}}function l(l,c,a){const r=new WebAssembly.Instance(s,{}),{malloc:o,buf:m}=t(r.exports),y=o(l.length);m(y).set(l);const f=o(c.length);m(f).set(c);const u=a?.secret?o(a.secret.length):[0,0];a?.secret&&m(u).set(a.secret);const w=a?.ad?o(a.ad.length):[0,0];a?.ad&&m(w).set(a.ad);const Z=o(a?.length??32),W=r.exports.argon2_hash_wasm(a?.t??3,a?.m??65536,1,y[0],y[1],f[0],f[1],u[0],u[1],w[0],w[1],Z[0],Z[1],a?.variant??e,a?.version??n);if(0!=W)throw Error(W);const k=new ArrayBuffer(Z[1]),p=new Uint8Array(k);return p.set(m(Z)),p}function c(l,c,a,r){const o=new WebAssembly.Instance(s,{}),{malloc:m,buf:y}=t(o.exports),f=m(l.length);y(f).set(l);const u=m(c.length);y(u).set(c);const w=m(a.length);y(w).set(a);const Z=r?.secret?m(r.secret.length):[0,0];r?.secret&&y(Z).set(r.secret);const W=r?.ad?m(r.ad.length):[0,0];r?.ad&&y(W).set(r.ad);const k=o.exports.argon2_verify_wasm(r?.t??3,r?.m??65536,1,w[0],w[1],f[0],f[1],u[0],u[1],Z[0],Z[1],W[0],W[1],r?.variant??e,r?.version??n);if(0!==k&&-35!==k)throw Error(k);return 0===k}self.onmessage=function(e){const[n,s,...t]=e.data;try{self.postMessage([n,!0,(s?c:l).apply(null,t)])}catch(e){self.postMessage([n,!1,e])}};',
				], { type: 'application/javascript' }),
			),
			{ type: 'module' },
		);
		constructor() {
			this.#n.onmessage = (e) => {
				const [s, n, t] = e.data, [r, a] = this.#s.get(s);
				this.#s.delete(s), (n ? r : a)(t);
			};
		}
		hash(e, s, n) {
			return new Promise((t, r) => {
				this.#s.set(this.#e, [t, r]), this.#n.postMessage([this.#e, !1, e, s, n]), this.#e++;
			});
		}
		verify(e, s, n, t) {
			return new Promise((r, a) => {
				this.#s.set(this.#e, [r, a]), this.#n.postMessage([this.#e, !0, e, s, n, t]), this.#e++;
			});
		}
		terminate() {
			this.#n.terminate();
		}
	}

	module.exports.ArgonWorker = n;
})();
