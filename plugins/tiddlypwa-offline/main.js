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

	exports.startup = async function () {
		$tw.rootWidget.addEventListener('tiddlypwaoffline-browser-refresh', (_evt) => {
			location.reload(); // tm-browser-refresh passes 'true' which skips the serviceworker. silly!
		});
		try {
			const reg = await navigator.serviceWorker.register('sw.js');
			await reg.update();
		} catch (e) {
			if (!navigator.onLine) return;
			$tw.wiki.addTiddler({ title: '$:/status/TiddlyPWAWorkerError', text: e.message });
			$tw.notifier.display('$:/plugins/valpackett/tiddlypwa-offline/notif-error');
		}
		navigator.serviceWorker.onmessage = (evt) => {
			if (evt.data.op == 'refresh') {
				$tw.notifier.display('$:/plugins/valpackett/tiddlypwa-offline/notif-refresh');
			}
		};
	};
})();
