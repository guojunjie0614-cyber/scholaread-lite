/** Read-only sample inspection: node tests/reflow-sample.mjs /absolute/paper.pdf [/tmp/output.json] */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'scholarlite-reflow-'));
try{
  const entry=path.resolve('renderer/src/reflow/analyze.ts');
  await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',outfile:path.join(tmp,'analyze.mjs'),plugins:[{name:'pdfjs-node',setup(build){build.onResolve({filter:/^pdfjs-dist$/},()=>({path:path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'),external:true}));}}]});
  const {analyzeDocument}=await import(pathToFileURL(path.join(tmp,'analyze.mjs')));
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf=await getDocument({data:new Uint8Array(await fs.readFile(process.argv[2])),useSystemFonts:true,fontExtraProperties:true}).promise;
  const blocks=await analyzeDocument(pdf,'sample',{keepFigures:true});
  if(process.argv[3])await fs.writeFile(process.argv[3],JSON.stringify(blocks,null,2));
  for(let page=1;page<=pdf.numPages;page++){
    const own=blocks.filter(b=>b.page===page);
    console.log(`PAGE ${page}: ${own.length} blocks`);
    for(const b of own)console.log(b.kind,JSON.stringify(b.crop??b.bbox),b.eqNo??'',b.text.slice(0,120));
  }
  await pdf.destroy();
}finally{await fs.rm(tmp,{recursive:true,force:true});}
