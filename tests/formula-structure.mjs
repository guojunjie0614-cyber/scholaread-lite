/** Native geometry regressions; optional final argument exercises a real paper read-only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import katex from 'katex';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-structure-'));
const compact = text => text.replace(/\s+/g, '');
const glyph = (str, x, y = 100, h = 10, font = 'CMMI10', w = 5) => ({ str, x, y, h, font, w });
let count = 0;
try {
  const parserFile = path.join(temporary, 'structure.mjs');
  await build({entryPoints:['renderer/src/reflow/formula-structure.ts'],bundle:true,platform:'node',format:'esm',outfile:parserFile});
  const {restoreFormula} = await import(pathToFileURL(parserFile));
  const check = (items, expected, rules = []) => {
    const result = restoreFormula(items, rules, 10);
    assert.deepEqual(result.warnings, []);
    assert.equal(compact(result.latex), compact(expected));
    katex.renderToString(result.latex,{throwOnError:true,trust:false,displayMode:true});
    count++;
  };

  check([glyph('F',10),glyph('(0)',20,100,10,'CMR10',15),glyph('=',40,100,10,'CMR10'),glyph('(1)',50,100,10,'CMR10',15)], 'F (0) = (1)');
  check([glyph('ε',10),glyph('+',20),glyph('ϵ',30),glyph('+',40),glyph('φ',50),glyph('+',60),glyph('ϕ',70)], String.raw`\varepsilon + \epsilon + \varphi + \phi`);
  check([glyph('f',10),glyph('˙',13,97.4,10,'CMR10',2),glyph('̂',10.2,95,10,'CMEX10',0)], String.raw`\hat{\dot{f}}`);
  check([glyph('A',10,100,10,'ABCDEE+CMSY10'),glyph('+',20),glyph('Q',30,100,10,'CMSY10'),glyph('+',40),glyph('H',50)], String.raw`\mathcal{A}+\mathcal{Q}+H`);
  const first = [glyph('a',10),glyph('=',20),glyph('∑',35,90.5,10,'CMEX10',14),glyph('M',33,87.4,7),glyph('−',39,87.4,7),glyph('2',45,87.4,7),glyph('i',35,111.6,7),glyph('=1',40,111.6,7,'CMR7',9),glyph('x',55),glyph('i',60,101.5,7)];
  const second = [glyph('b',10,134),glyph('=',20,134),glyph('∑',35,124.5,10,'CMEX10',14),glyph('L',33,121.4,7),glyph('+',39,121.4,7),glyph('3',45,121.4,7),glyph('j',35,145.6,7),glyph('=0',40,145.6,7,'CMR7',9),glyph('y',55,134),glyph('j',60,135.5,7)];
  check([...first,...second],String.raw`\begin{aligned}a &= \sum_{i=1}^{M-2}x_i \\ b &= \sum_{j=0}^{L+3}y_j\end{aligned}`.replace(/x_i/,'x_{i}').replace(/y_j/,'y_{j}'));
  const continuation = [glyph('x',10),glyph('=',20),glyph('a',30),glyph('+',20,116),glyph('b',30,116)];
  check(continuation,String.raw`\begin{aligned}x &= a \\ &\quad + b\end{aligned}`);
  check([glyph('F',10),glyph('(x)',20,100,10,'CMR10',15),glyph('=',20,116),glyph('a',30,116),glyph('+',20,132),glyph('b',30,132)],String.raw`\begin{aligned}&F(x)\\&=a\\&+b\end{aligned}`);
  const fractions = [glyph('X',10),glyph('=',20),glyph('A',40,93.3),glyph('B',40,107),glyph('Y',10,127),glyph('=',20,127),glyph('C',40,120.3),glyph('D',40,134)];
  check(fractions,String.raw`\begin{aligned}X &= \frac{A}{B} \\ Y &= \frac{C}{D}\end{aligned}`,[{x0:35,y0:97.3,x1:50,y1:97.7},{x0:35,y0:124.3,x1:50,y1:124.7}]);
  const unknown = restoreFormula([glyph('x',10),glyph('\uE000',20)],[],10);
  assert.equal(unknown.latex,undefined);assert.ok(unknown.warnings.length);count++;

  if(process.argv[2]){
    const analyzerFile=path.join(temporary,'analyze.mjs');
    await build({entryPoints:['renderer/src/reflow/analyze.ts'],bundle:true,platform:'node',format:'esm',outfile:analyzerFile,plugins:[{name:'pdfjs-node',setup(b){b.onResolve({filter:/^pdfjs-dist$/},()=>({path:path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'),external:true}));}}]});
    const {analyzeDocument}=await import(pathToFileURL(analyzerFile));
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf=await getDocument({data:new Uint8Array(await fs.readFile(process.argv[2])),useSystemFonts:true}).promise;
    const blocks=await analyzeDocument(pdf,'native-test',{keepFigures:true});
    const equations=new Map(blocks.filter(b=>b.kind==='math').map(b=>[b.eqNo,b]));
    // Independent transcriptions of the inspected original images. These are test
    // expectations only; no equation number or expected formula enters the parser.
    const expected={
      '(1)':String.raw`\begin{aligned}r[n]&=Ab[n]c[n-\tau]\\&\quad\cdot\operatorname{exp}\left(j\phi_{0}+j2\pi f_{c}nT_{s}+j\pi\dot{f}(nT_{s})^{2}\right)+w[n]\end{aligned}`,
      '(2)':String.raw`\Delta\phi(t)=2\pi\Delta f_{c}t+\pi\Delta\dot{f}t^{2}`,
      '(7)':String.raw`B_{e}(h)=\begin{cases}\displaystyle1,&h=0\text{ or }e<h\\\displaystyle-1,&h\not=0\text{ and }e\geq h\end{cases}`,
      '(9)':String.raw`\mathcal{H}_{\mathrm{trk}}=\left(\mathrm{PRN},\hat{\tau},\hat{f}_{c},\hat{\dot{f}},\hat{h},S_{\operatorname{max}},v_{\operatorname{det}}\right)`,
      '(10)':String.raw`\begin{aligned}N_{\mathrm{pass},\mathrm{pre}}&=\left\lceil\frac{K_{0}}{\left\lfloor M/N_{\tau,g}\right\rfloor}\right\rceil\\N_{\mathrm{pass},\mathrm{final}}&=\left\lceil\frac{KN_{\tau,g}}{M}\right\rceil\end{aligned}`,
      '(11)':String.raw`\begin{aligned}b_{\mathrm{bank}}&=\ell\operatorname{mod}3,o=i\operatorname{mod}3\\a&=Q\left\lfloor\frac{\ell}{3}\right\rfloor+\left\lfloor\frac{i}{3}\right\rfloor\end{aligned}`,
      '(12)':String.raw`\begin{aligned}u_{e}&=\sum_{s=0}^{N_{s}-1}P_{e,s}(\tau_{\kappa}+\delta\tau)R_{e,s}(\hat{f}_{c},\hat{\dot{f}})\\U&=\sum_{e=0}^{N_{e}-1}u_{e}\end{aligned}`,
      '(13)':String.raw`Z_{h}=\begin{cases}\displaystyle U,&h=0\\\displaystyle2\sum_{e=0}^{h-1}u_{e}-U,&h=1,\ldots,N_{e}-1\end{cases}`,
      '(16)':String.raw`\begin{aligned}N_{\mathrm{pre},\mathrm{INT8}}&=4N_{e}K_{0}N_{\tau,g}N_{f,\mathrm{pre}}\\N_{\mathrm{final},\mathrm{INT8}}&=4N_{e}KN_{\tau,g}N_{f,\mathrm{final}}N_{\dot{f}}\end{aligned}`,
    };
    for(const [number,latex] of Object.entries(expected)){
      const block=equations.get(number);assert.ok(block?.nativeLatex,`${number}: ${block?.structureWarnings}`);
      assert.equal(compact(block.nativeLatex),compact(latex),number);
      katex.renderToString(block.nativeLatex,{throwOnError:true,trust:false,displayMode:true});count++;
    }
    for(const number of ['(4)','(8)']){
      const latex=equations.get(number).nativeLatex;assert.equal((latex.match(/\\vert/g)??[]).length,2,number);
      assert.match(latex,/\\right\\vert\^\{2\}/);katex.renderToString(latex,{throwOnError:true,trust:false,displayMode:true});count++;
      if(number==='(8)'){
        assert.match(latex,/^\\begin\{aligned\}&\s*S/);
        assert.match(latex,/\\\\\s*&\s*=/);
      }
    }
    await fs.writeFile('/tmp/scholarlite-native-validated.json',JSON.stringify(blocks,null,2));
    await pdf.destroy();
  }
  console.log(`${count} formula structure checks passed`);
}finally{await fs.rm(temporary,{recursive:true,force:true});}
