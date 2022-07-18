/*\
title: $:/core/modules/savers/put.js
type: application/javascript
module-type: saver

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	// Because put.js performs OPTIONS and HEAD requests in the *constructor*,
	// before core can even check that it has priority >_< we have to neutralize it.
	class DummySaver {
		info = {
			name: 'nope',
			priority: 0,
			capabilities: [],
		};

		constructor(_wiki) {
		}

		save(_text, _method, _cb) {
			return true;
		}
	}

	exports.canSave = (_wiki) => false;
	exports.create = (wiki) => new DummySaver(wiki);
})();
