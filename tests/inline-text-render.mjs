import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const bundle = await build({ entryPoints: ['renderer/src/components/InlineText.tsx'], bundle: true, write: false,
  platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external' });
// Resolve React from this project rather than an unresolvable data-URL package import.
const source = bundle.outputFiles[0].text.replaceAll('from "react/jsx-runtime"', `from ${JSON.stringify(new URL('../node_modules/react/jsx-runtime.js', import.meta.url).href)}`);
const { InlineText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const runs = [{ text: 'The vector ' },
  { text: 'r', italic: true, mathPosition: { group: 'g', x: 0, y: 0, width: .5, size: 1 } },
  { text: 'i', script: 'sub', mathPosition: { group: 'g', x: .5, y: .25, width: .3, size: .7 } },
  { text: 't', script: 'sup', mathPosition: { group: 'g', x: .5, y: -.4, width: .3, size: .7 } },
  { text: ' is measured.' }];
const offsets = [];
const markup = renderToStaticMarkup(createElement(InlineText, { runs,
  renderText(text, offset) { offsets.push([text, offset]); return text; } }));
assert.equal(markup.replace(/<[^>]*>/g, ''), runs.map(run => run.text).join(''));
assert.deepEqual(offsets, [['The vector ', 0], ['r', 11], ['i', 12], ['t', 13], [' is measured.', 14]]);
assert.equal((markup.match(/class="inline-math"/g) ?? []).length, 1);
assert.match(markup, /min-width:0.8em/);
assert.match(markup, /<sub[^>]*padding-left:0.714/);
assert.match(markup, /<sup[^>]*padding-left:0.714/);
assert.match(markup, /translateY\(0.357/);
assert.match(markup, /<em>r<\/em>/);
const circled = renderToStaticMarkup(createElement(InlineText, { runs: [
  { text: '\u20dd', mathPosition: { group: 'circle', x: -.3, y: 0, width: 1, size: 1 } },
  { text: '1', mathPosition: { group: 'circle', x: 0, y: 0, width: .35, size: .7 } },
] }));
assert.equal(circled.replace(/<[^>]*>/g, ''), '\u20dd1');
assert.match(circled, /class="inline-circle"/);
console.log('PASS inline geometry renderer preserves canonical DOM text and highlight offsets');
