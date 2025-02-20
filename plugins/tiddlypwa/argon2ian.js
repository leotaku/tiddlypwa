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
		#t = new Map();
		#s = new Worker(
			URL.createObjectURL(
				new Blob([
					'const e={Argon2d:0,Argon2i:1,Argon2id:2},t=await WebAssembly.compileStreaming(new Response((await fetch("data:w/e;base64,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")).body?.pipeThrough(new DecompressionStream("gzip")),{headers:{"content-type":"application/wasm"}}));function s(t,s,n,o){const{malloc:r,buf:a}=(p=t.exports,{malloc:e=>[p.m(e),e],buf:([e,t])=>new Uint8Array(p.memory.buffer,e,t)});var p;const u=r(s.length);a(u).set(s);const l=r(n.length);a(l).set(n);const m=o?.secret?r(o.secret.length):[0,0];o?.secret&&a(m).set(o.secret);const g=o?.ad?r(o.ad.length):[0,0];o?.ad&&a(g).set(o.ad);const f=r(o?.length??32),w=o?.m??65536,c=o?.p??1,y=o?.t??3;if(c<1)throw Error("p");if(y<1)throw Error("t");if(w<8*c*1024||w%1024!=0)throw Error("m");const h=r(1024*w);return t.exports.a(f[0],f[1],h[0],o?.variant??e.Argon2id,w,y,c,u[0],l[0],u[1],l[1],m[0],g[0],m[1],g[1]),t.exports.w(u[0],u[1]),{malloc:r,buf:a,result:f}}function n(e,n,o){const r=new WebAssembly.Instance(t,{}),{buf:a,result:p}=s(r,e,n,o);return function(e,t){const s=new ArrayBuffer(t[1]),n=new Uint8Array(s);return n.set(e(t)),n}(a,p)}function o(e,n,o,r){const a=new WebAssembly.Instance(t,{}),{malloc:p,buf:u,result:l}=s(a,e,n,r);if(l[1]!==o.length)throw Error("lenm");const m=p(o.length);if(u(m).set(o),32===o.length)return 0===a.exports.t(l[0],m[0]);if(64===o.length)return 0===a.exports.s(l[0],m[0]);throw Error("lenu")}self.onmessage=function(e){const[t,s,...r]=e.data;try{self.postMessage([t,!0,(s?o:n).apply(null,r)])}catch(e){self.postMessage([t,!1,e])}},self.postMessage("r");',
				], { type: 'application/javascript' }),
			),
			{ type: 'module' },
		);
		ready = new Promise((e) => {
			this.#s.addEventListener('message', (t) => 'r' === t.data && e(!0), {
				once: !0,
			});
		});
		constructor() {
			this.ready.then(() =>
				this.#s.onmessage = (e) => {
					const [t, s, r] = e.data, [o, n] = this.#t.get(t);
					this.#t.delete(t), (s ? o : n)(r);
				}
			);
		}
		hash(e, t, s) {
			return new Promise((o, r) => {
				this.#t.set(this.#e, [o, r]), this.#s.postMessage([this.#e, !1, e, t, s]), this.#e++;
			});
		}
		terminate() {
			this.#s.terminate();
		}
	}

	module.exports.ArgonWorker = n;
})();
