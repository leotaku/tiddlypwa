/*\
title: $:/plugins/valpackett/web-app-manifest/main.js
type: application/javascript
module-type: startup

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	if (!$tw.browser) return;

	exports.startup = function () {
		let link = document.querySelector('head > link[rel=manifest]');
		if (!link) {
			link = document.createElement('link');
			link.rel = 'manifest';
			document.head.appendChild(link);
		}

		function isTiddlerRelevant(x) {
			return x !== '$:/StoryList' && x.startsWith('$:/') && !x.startsWith('$:/state') && !x.startsWith('$:/temp') &&
				!x.startsWith('$:/status');
		}

		function parseIconTiddler(x) {
			const fields = $tw.wiki.getTiddler(x).fields;

			return {
				src: $tw.wiki.isBinaryTiddler(x)
					? `data:${fields.type};base64,${fields.text}`
					: `data:${fields.type},${encodeURIComponent(fields.text)}`,
				type: fields.type,
				sizes: fields.sizes || 'any',
				purpose: fields.purpose || 'any',
			};
		}

		function render() {
			try {
				URL.revokeObjectURL(link.href);
			} catch (_e) { /* probably was initial/empty */ }
			const manifest = {
				name: $tw.wiki.renderTiddler('text/plain', '$:/plugins/valpackett/web-app-manifest/name'),
				display: 'standalone',
				theme_color: $tw.wiki.renderTiddler(
					'text/plain',
					'$:/plugins/valpackett/web-app-manifest/theme-color',
				),
				background_color: $tw.wiki.renderTiddler(
					'text/plain',
					'$:/plugins/valpackett/web-app-manifest/background-color',
				),
				icons: [],
			};
			const icons = $tw.wiki.getTiddlersWithTag('$:/tags/ManifestIcon');
			if (icons.length == 0 && $tw.wiki.getTiddler('$:/favicon.ico')) {
				icons.push('$:/favicon.ico');
			}
			for (const x of icons) {
				if (!$tw.wiki.getTiddler(x).isDraft()) {
					manifest.icons.push(parseIconTiddler(x));
				}
			}
			const json = JSON.stringify(manifest);
			link.href = URL.createObjectURL(new Blob([json], { type: 'application/manifest+json' }));
			$tw.__tiddlypwa_manifest__ = json;
		}

		render();
		$tw.wiki.addEventListener('change', (chg) => {
			if (Object.keys(chg).some(isTiddlerRelevant)) {
				render();
			}
		});
		$tw.rootWidget.addEventListener('tiddlypwa-get-manifest', (_evt) => {
			const a = document.createElement('a');
			a.href = link.href;
			a.download = 'manifest.json';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		});
	};
})();
