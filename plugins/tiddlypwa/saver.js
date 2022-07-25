/*\
title: $:/plugins/valpackett/tiddlypwa/saver.js
type: application/javascript
module-type: saver

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	if (!$tw.browser || document.documentElement.hasAttribute('tiddlypwa-install')) {
		return;
	}

	class PWASaver {
		info = {
			name: 'TiddlyPWA',
			priority: 6969,
			capabilities: ['save'],
		};

		constructor(wiki) {
			this.wiki = wiki;
		}

		save(_text, _method, _cb, _options) {
			$tw.modal.display('$:/plugins/valpackett/tiddlypwa/save-dialog', {});
			return true;
		}
	}

	exports.canSave = (_wiki) => (location.protocol === 'https:' || location.hostname === 'localhost');
	exports.create = (wiki) => new PWASaver(wiki);
})();
