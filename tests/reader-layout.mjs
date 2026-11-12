import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['renderer/src/lib/reader-layout.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { readerLayout, READER_MIN_WIDTH } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
for (const viewport of [900, 1024, 1149, 1150, 1151, 1280, 1440, 1920]) {
  for (const requested of [340, 420, 640, 9999, NaN]) {
    const layout = readerLayout(viewport, requested, true, true);
    const rail = layout.sidebarVisible ? (viewport <= 1150 ? 228 : 260) : 0;
    assert(viewport - rail - layout.chatWidth >= READER_MIN_WIDTH, `reading column at ${viewport}px / ${requested}px`);
    assert(layout.chatWidth >= 340 && layout.chatWidth <= 640);
    assert.equal(readerLayout(viewport, requested, false, true).sidebarVisible, false, 'manual collapse is respected');
    assert.equal(readerLayout(viewport, requested, true, false).sidebarVisible, true, 'closing AI restores requested navigation');
  }
}
assert.equal(readerLayout(1280, 640, true, true).sidebarVisible, false, 'wide saved panel must not squeeze the article');
assert.equal(readerLayout(1920, 640, true, true).sidebarVisible, true, 'roomy windows keep all columns');
assert.equal(readerLayout(1280, NaN, true, true).chatWidth, 420, 'invalid saved width falls back safely');
console.log('PASS reading space, responsive boundaries, stored widths and navigation preference');
