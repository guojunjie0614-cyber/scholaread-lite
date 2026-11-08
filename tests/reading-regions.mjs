/** Source-preserving author regions and publication furniture; optional fresh parsed SWCS/ReFFT JSON paths. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-regions-'));
try {
  const file = path.join(temporary, 'entry.mjs');
  await build({ stdin: { contents: `export * from './renderer/src/reflow/reading-roles.ts'; export * from './renderer/src/reflow/front-matter.ts'; export * from './renderer/src/reflow/portraits.ts'; export * from './shared/reading-content.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: file });
  const { classifyReadingRoles, identifyBiographySubject, identifyPublicationHeaders, identifyRepeatedPublicationHeaders, identifyAuthorPortraits, isReadingContent } = await import(pathToFileURL(file));
  let id = 0;
  const block = (text, extra = {}) => ({ id: `b${id++}`, paperId: 'p', page: 15, ord: id, kind: 'p', text, ...extra });
  const authors = [
    block('Jianan Wen received the B.Sc. degree from Example University.'),
    block('Since 2021, he has been a researcher at the Institute of Electronics.'),
    block('Mr. Wen received the Best Paper Award in 2024.'),
    block('Mr. Smith received the Best Paper Award in 2024.'),
    block('Eduardo Perez received the M.Sc. and Ph.D. degrees from Example University.'),
    block('Dr. Perez obtained the German Habilitation and position of Privatdozent.'),
    block('Milos Krstic received the Dr.-Ing. degree in electronics from Example University.'),
    block('Since 2016, he has been a Professor of design and test methodology.'),
    block('Appendix: Technical validation', { kind: 'h2' }),
    block('This research evaluates the compiler throughput.'),
    block('He proposes a new algorithm.'),
    block('The sensor received the degree of freedom signal.'),
    block('[32] A. Author received the Ph.D. degree.', { kind: 'ref' }),
    block('Fig. 9. The received signal.', { kind: 'caption' }),
    block('', { kind: 'figure', crop: [40, 100, 112, 190] }),
  ];
  classifyReadingRoles(authors, 15);
  assert(authors.slice(0, 3).every(b => b.readingRole === 'biography'));
  assert(!authors[3].readingRole, 'a titled different person is not a continuation of this author');
  assert(authors.slice(4, 8).every(b => b.readingRole === 'biography'));
  assert(authors.slice(8).every(isReadingContent), 'technical appendix, reference, caption and image remain readable');
  assert.equal(identifyBiographySubject(authors[6].text).surname, 'Krstic');
  const opening = [block('A technical title', { page: 1, kind: 'h1', readingRole: 'title', bbox: [60, 60, 550, 110] }),
    block('Jianan Wen, Andrea Baroni, Eduardo Perez,', { page: 1, bbox: [100, 120, 500, 130] }),
    block('Christian Wenger', { page: 1, bbox: [210, 134, 303, 144] }),
    block('Abstract— A scientific abstract.', { page: 1, bbox: [50, 180, 300, 210] }),
    block('An ordinary body paragraph.', { page: 1, bbox: [50, 300, 300, 340] }),
    block(', and Milos Krstic', { page: 1, bbox: [303, 134, 390, 144] }),
    block('This work was supported by Grant 123. (Corresponding author: Jianan Wen.) Jianan Wen and Andrea Baroni are with IHP—Leibniz-Institut für Innovative Mikroelektronik, Germany.', { page: 1 }),
    block('Eduardo Perez and Christian Wenger are with IHP—Leibniz-Institut für Innovative Mikroelektronik, Germany.', { page: 1 })];
  classifyReadingRoles(opening, 15);
  assert(opening.filter(b => /^(?:Jianan Wen,|Christian Wenger|, and Milos Krstic)/.test(b.text)).every(b => b.readingRole === 'authors'));
  assert(opening.filter(b => /are with IHP/.test(b.text)).every(b => b.readingRole === 'affiliations'));
  assert(opening.some(b => b.text === 'This work was supported by Grant 123.' && isReadingContent(b)));
  assert(opening.filter(b => /abstract|body paragraph/.test(b.text)).every(isReadingContent));
  const line = (text, y, extra = {}) => ({ text, y, size: 6, bold: false, x0: 100, x1: 530, ...extra });
  const banner = [line('This article has been accepted for publication in IEEE Transactions.', 6),
    line("This is the author's version which has not been fully edited", 12),
    line('and content may change prior to final publication.', 18, { x0: 186, x1: 449 }),
    line('Citation information: DOI 10.1109/EXAMPLE', 24),
    line('ZHANG et al.: SUM-WEIGHTED-COMB-SEARCH BASED DOPPLER-SHIFT ACQUISITION 3', 36),
    line('We use this article to compare the measured results.', 61, { size: 10 }),
    line('This article has been accepted for publication in our experiment.', 200),
    line('ZHANG et al.: SUM-WEIGHTED-COMB-SEARCH BASED DOPPLER-SHIFT ACQUISITION', 500),
    line('Citation information: DOI 10.1109/EXAMPLE', 400),
    line('but republication/redistribution requires IEEE permission.', 780),
    line('See https://www.ieee.org/publications/rights/index.html for more information.', 786, { x0: 166, x1: 520 })];
  identifyPublicationHeaders(banner, 800, 3);
  assert(banner.slice(0, 5).every(b => b.readingRole === 'publication'));
  assert(banner.slice(5, 9).every(b => !b.readingRole), 'the same wording and DOI citation in the body are not furniture');
  assert(banner.slice(9).every(b => b.readingRole === 'publication'), 'the complete copyright/footer region is hidden');
  const repeated = [1, 2, 3].flatMap(page => [
    block(`AN EXAMPLE JOURNAL ${page}`, { page, bbox: [40, 30, 550, 38] }),
    block('Repeated body sentence.', { page, bbox: [40, 30, 550, 38] }),
    block('FOOTNOTE FOR TECHNICAL EXPERIMENTS', { page, bbox: [40, 710, 550, 720] }),
    block('REPEATED TECHNICAL BODY', { page, bbox: [40, 80, 550, 90] })]);
  identifyRepeatedPublicationHeaders(repeated, new Map([[1, 800], [2, 800], [3, 800]]));
  assert(repeated.filter(b => /^AN EXAMPLE/.test(b.text)).every(b => !isReadingContent(b)));
  assert(repeated.filter(b => !/^AN EXAMPLE/.test(b.text)).every(isReadingContent));
  assert.equal(repeated.length, 12, 'margin recognition preserves source blocks');
  const splitBanner = [block("This article has been accepted for publication. This is the author's version", { page: 1, readingRole: 'publication', bbox: [116, 0.7, 532, 11.2], sourceFontSize: 6 }),
    block('content may change prior to final publication. Citation information: DOI 10.1109/EXAMPLE', { page: 1, bbox: [186, 10.7, 449, 16.2] }),
    block('We compare the DOI 10.1109/EXAMPLE results in this paragraph.', { page: 1, bbox: [50, 65, 300, 76] }),
    block('but republication/redistribution requires IEEE permission.', { page: 1, bbox: [166, 782, 520, 789] })];
  identifyRepeatedPublicationHeaders(splitBanner, new Map([[1, 800]]));
  assert(splitBanner[1].readingRole === 'publication' && !isReadingContent(splitBanner[1]));
  assert(isReadingContent(splitBanner[2]), 'a body DOI citation remains readable');
  assert(splitBanner[3].readingRole === 'publication' && !isReadingContent(splitBanner[3]));
  // Thesis furniture sits inside the 6.5%/95% band: CJK running heads and "- N -" page numbers.
  const thesis = [20, 21, 22, 23, 24, 25].flatMap(page => [
    block(page % 2 ? '黑龙江大学硕士学位论文' : '第 2 章 储备池计算以及忆阻器的理论基础', { page, bbox: [200, 87, 395, 97], sourceFontSize: 9 }),
    block('储备池内的神经元通过连接结构相互作用。', { page, bbox: [85, 87, 510, 97], sourceFontSize: 12 }),
    block(`- ${page - 9} -`, { page, kind: 'li', bbox: [286, 753, 309, 764], sourceFontSize: 9 }),
    block('注：本章实验均在相同条件下完成', { page: page === 20 ? 20 : 99, bbox: [85, 740, 400, 750] })]);
  identifyRepeatedPublicationHeaders(thesis, new Map([20, 21, 22, 23, 24, 25, 99].map(page => [page, 842])));
  assert(thesis.filter(b => /学位论文|^第 2 章|^- \d+ -$/.test(b.text)).every(b => b.readingRole === 'publication'));
  assert(thesis.filter(b => /神经元|注：/.test(b.text)).every(isReadingContent), 'CJK sentences and one-off notes stay readable');

  const portrait = { kind: 'image', x0: 40, y0: 100, x1: 112, y1: 190 };
  const bioLines = [{ text: authors[6].text, x0: 130, y0: 102, x1: 295, y1: 112 }];
  assert.equal(identifyAuthorPortraits([], [portrait], 600, 800, 10, 15, 15, () => bioLines).length, 1);
  assert.equal(identifyAuthorPortraits([], [portrait], 600, 800, 10, 2, 15, () => bioLines).length, 0);
  assert.equal(identifyAuthorPortraits([], [portrait], 600, 800, 10, 15, undefined, () => bioLines).length, 0);
  assert.equal(identifyAuthorPortraits([], [portrait], 600, 800, 10, 15, 15, () => [...bioLines,
    { text: 'Fig. 8. A face recognition experiment.', x0: 40, y0: 200, x1: 295, y1: 210 }]).length, 0);
  assert.equal(identifyAuthorPortraits([], [portrait], 600, 800, 10, 15, 15, () => [{ ...bioLines[0], text: 'The sensor received the electrical signal.' }]).length, 0);
  console.log('PASS subject-linked author regions, split opening names/affiliations, retained funding/appendix/references/images, bounded wrapped banners/repeated headers, shared portrait identity and scientific-image negatives');

  if (process.argv[2] && process.argv[3]) {
    const swcs = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    const refft = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
    const banners = swcs.filter(b => /^This article has been accepted for publication/.test(b.text));
    const titles = swcs.filter(b => /^ZHANG et al\.:/.test(b.text));
    assert.equal(banners.length, 6, 'every page retains a source banner block');
    assert.equal(titles.length, 2, 'both source running titles are retained');
    assert([...banners, ...titles].every(b => !isReadingContent(b)));
    const wrappedNotices = swcs.filter(b => /content may change prior to final publication|republication\/redistribution requires IEEE permission/.test(b.text));
    assert.equal(wrappedNotices.filter(b => /content may change/.test(b.text)).length, 6, 'all centered DOI banner suffixes retain source text');
    assert.equal(wrappedNotices.filter(b => /republication\/redistribution/.test(b.text)).length, 6, 'all footer suffixes retain source text');
    assert(wrappedNotices.every(b => !isReadingContent(b)), 'no wrapped banner/DOI/copyright suffix leaks into reading');
    const continuations = refft.filter(b => /^(Mr\. Wen received|Dr\. Perez obtained)/.test(b.text));
    assert.equal(continuations.length, 2);
    assert(continuations.every(b => b.readingRole === 'biography' && !isReadingContent(b)));
    const sourceAuthors = refft.filter(b => b.page === 1 && /Jianan Wen|Andrea Baroni|Max Uhlmann|Christian Wenger|Milos Krstic|Eduardo Perez/.test(b.text));
    assert(sourceAuthors.every(b => !isReadingContent(b)), 'all author names and addresses are hidden, including column-split fragments');
    assert(refft.some(b => b.page === 1 && /^Received/.test(b.text) && /supported/.test(b.text) && isReadingContent(b)), 'publication history and funding remain');
    assert(refft.some(b => b.kind === 'ref' && isReadingContent(b)));
    assert(refft.some(b => b.page === 14 && b.kind === 'figure' && isReadingContent(b)), 'ordinary end-page technical figures remain');
    const portraits = refft.filter(b => b.page === 15 && b.kind === 'figure');
    assert.equal(portraits.length, 6, 'all six author photos retain source figure blocks');
    assert(portraits.every(b => b.readingRole === 'biography' && !isReadingContent(b)));
    const krsticPortrait = portraits.find(b => b.crop && b.crop[0] >= 300 && b.crop[1] > 500 && b.crop[1] < 520);
    assert(krsticPortrait && !isReadingContent(krsticPortrait), 'the visually confirmed Krstic portrait is hidden');
    console.log(`PASS fresh PDF parses: ${banners.length} banners + ${titles.length} running titles hidden, ${continuations.length} award/qualification continuations hidden, ${sourceAuthors.length} first-page author blocks hidden, technical figures/funding/references retained`);
  }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
