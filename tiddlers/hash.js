/*\
title: $:/hash.js
type: application/javascript
module-type: widget

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	const safe = { '+': '-', '/': '_' };
	const b64uenc = (bytes) =>
		btoa(Array.from(bytes, (x) => String.fromCodePoint(x)).join(''))
			.replace(/[+/]/g, (m) => safe[m]).replace(/[.=]{1,2}$/, '');
	const Widget = require('$:/core/modules/widgets/widget.js').widget;

	let worker;

	exports['admin-password-hash'] = class HW extends Widget {
		#parent;
		render(parent, nextSibling) {
			this.computeAttributes();
			if (parent) this.#parent = parent;
			const txt = this.document.createTextNode('…');
			this.#parent.insertBefore(txt, nextSibling);
			this.domNodes.push(txt);
			if (!worker) {
				const AW = require('$:/plugins/valpackett/tiddlypwa/argon2ian.js').ArgonWorker;
				worker = new AW();
			}
			const password = this.getAttribute('password', '');
			if (password.length > 0) {
				const salt = crypto.getRandomValues(new Uint8Array(32));
				worker.ready.then(() => worker.hash(new TextEncoder().encode(password), salt)).then((hash) => {
					txt.textContent = 'ADMIN_PASSWORD_HASH=' + b64uenc(hash) + '\n' +
						'ADMIN_PASSWORD_SALT=' + b64uenc(salt);
				});
			}
		}
		refresh(_chg) {
			if (this.computeAttributes().password) {
				this.refreshSelf();
				return true;
			}
			return false;
		}
	};
})();
