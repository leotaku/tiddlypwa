/*\
title: $:/plugins/valpackett/web-app-manifest/macro.js
type: application/javascript
module-type: macro

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	if (!$tw.browser) return;

	exports.name = 'tiddlypwa-manifest-data-uri';

	exports.params = [];

	exports.run = function () {
		return '`' + encodeURIComponent($tw.__tiddlypwa_manifest__) + '`';
	};
})();
