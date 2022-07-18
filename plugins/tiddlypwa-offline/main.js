/*\
title: $:/plugins/valpackett/tiddlypwa-offline/main.js
type: application/javascript
module-type: startup

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	if (!$tw.browser) return;

	exports.startup = function () {
		navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch((_e) =>
			$tw.notifier.display('$:/plugins/valpackett/tiddlypwa-offline/notif-error')
		);
		navigator.serviceWorker.onmessage = (evt) => {
			if (evt.data.typ == 'REFRESH') {
				$tw.notifier.display('$:/plugins/valpackett/tiddlypwa-offline/notif-refresh');
			}
		};
	};
})();
